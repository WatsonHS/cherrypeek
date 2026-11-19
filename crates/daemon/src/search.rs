use crate::{
    git_command::{GitFailure, ReadOnlyGit, string_arg},
    metadata_index::{self, IndexError, SearchSnapshot},
    repository, session,
    session_store::SessionStore,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use caseless::default_case_fold_str;
use commitscope_core::{
    ActivityAuthor, ActivityDay, ActivityStats, CommitIdentity, CommitSummary, ErrorCode,
    GetActivityStatsParams, ListSearchPathsParams, MetadataIndexCoverage, SearchCommitsParams,
    SearchIdentities, SearchIdentitiesParams, SearchIdentity, SearchPage, SearchPathEntry,
    SearchPathFilter, SearchPathKind, SearchPathMatch, SearchPaths, SearchQuery, SearchTimeField,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::{Ordering, Reverse},
    collections::{BTreeMap, BTreeSet, BinaryHeap, HashSet},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering as AtomicOrdering},
    },
    time::Instant,
};

const MAX_CURSOR_BYTES: usize = 1024;
const MAX_CURSOR_PAYLOAD_BYTES: usize = 512;
const MAX_IDENTITIES: usize = 100;
const MAX_EXCLUDE_TIPS: usize = 2000;
const MAX_EXCLUDE_OID_SCAN: usize = 250_000;
const MAX_CACHED_EXCLUDED_TIPS: usize = 4;
const MAX_CACHED_EXCLUDED_OIDS: usize = 100_000;
const OID_LINE_LIMIT: usize = 128;
const JS_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const PATH_DIFF_BATCH_SIZE: usize = 512;
const PATH_DIFF_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const PATH_COMPLETION_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const ACTIVITY_AUTHOR_LIMIT: usize = 500;
const ACTIVITY_DAY_LIMIT: usize = 3660;

#[derive(Clone)]
struct CompiledQuery {
    key: String,
    query: SearchQuery,
    message_needle: String,
    path_bytes: Option<Vec<u8>>,
    included_oids: Option<Arc<HashSet<String>>>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum CursorDirection {
    Next,
    Previous,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchCursor {
    #[serde(rename = "q")]
    query_key: String,
    #[serde(rename = "s")]
    snapshot_key: String,
    #[serde(rename = "f")]
    file_identity: String,
    #[serde(rename = "w")]
    watermark: u64,
    #[serde(rename = "c")]
    complete: bool,
    #[serde(rename = "p")]
    page_size: u16,
    #[serde(rename = "d")]
    direction: CursorDirection,
    #[serde(rename = "t")]
    timestamp: i64,
    #[serde(rename = "o")]
    oid: String,
}

struct Candidate {
    timestamp: i64,
    oid: String,
    parent_indices: Vec<Option<u16>>,
}

impl PartialEq for Candidate {
    fn eq(&self, other: &Self) -> bool {
        self.timestamp == other.timestamp && self.oid == other.oid
    }
}

impl Eq for Candidate {}

impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .timestamp
            .cmp(&self.timestamp)
            .then_with(|| self.oid.cmp(&other.oid))
    }
}

struct CandidateKey {
    timestamp: i64,
    oid: String,
}

impl CandidateKey {
    fn compare_order(&self, other: &Self) -> Ordering {
        other
            .timestamp
            .cmp(&self.timestamp)
            .then_with(|| self.oid.cmp(&other.oid))
    }
}

pub(crate) fn search_commits(
    executable: Option<&Path>,
    store: &SessionStore,
    session: &session::RepositorySession,
    params: &SearchCommitsParams,
    cache_epoch: u64,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<SearchPage, IndexError> {
    validate_page_size(params.page_size)?;
    if params.cursor.is_some() && params.anchor_oid.is_some() {
        return Err(invalid_request("cursor and anchorOid cannot be combined"));
    }
    let (snapshot_key, _) = metadata_index::snapshot_identity(session)?;
    let mut compiled = compile_query(&params.query, session, &snapshot_key)?;
    if compiled.path_bytes.is_some() && executable.is_none() {
        return Err(IndexError {
            code: ErrorCode::GitUnavailable,
            message: "Git executable is required for path history search".into(),
        });
    }
    resolve_excluded_tips(executable, session, &mut compiled, cancelled, deadline)?;
    let cursor = params.cursor.as_deref().map(decode_cursor).transpose()?;
    let anchor_oid = params.anchor_oid.as_deref().map(str::to_ascii_lowercase);
    if anchor_oid.as_ref().is_some_and(|oid| {
        oid.len() != session.discovered.oid_length
            || !oid.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(invalid_request(
            "anchorOid must be a full hexadecimal object ID",
        ));
    }
    let response = metadata_index::with_readonly_search_snapshot(
        store,
        session,
        metadata_index::configured_quota()?,
        cache_epoch,
        cancelled,
        deadline,
        |connection, snapshot| {
            let mut page_snapshot = snapshot.clone();
            if let Some(cursor) = &cursor {
                validate_cursor(cursor, &compiled, snapshot, params.page_size)?;
                page_snapshot.watermark = cursor.watermark;
                page_snapshot.complete = cursor.complete;
            }
            let boundary = match (&cursor, &anchor_oid) {
                (Some(cursor), _) => Some(
                    find_matching_key(
                        executable,
                        session,
                        connection,
                        &page_snapshot,
                        &compiled,
                        &cursor.oid,
                        (cancelled, deadline),
                    )?
                    .filter(|key| key.timestamp == cursor.timestamp),
                ),
                (None, Some(anchor_oid)) => Some(find_matching_key(
                    executable,
                    session,
                    connection,
                    &page_snapshot,
                    &compiled,
                    anchor_oid,
                    (cancelled, deadline),
                )?),
                (None, None) => None,
            };
            if cursor.is_some() && boundary.as_ref().is_none_or(Option::is_none) {
                return Err(invalid_cursor());
            }
            collect_page(
                executable,
                Some(session),
                connection,
                &page_snapshot,
                &compiled,
                params.page_size,
                cursor.as_ref(),
                boundary.flatten(),
                params.anchor_oid.is_some(),
                cancelled,
                deadline,
            )
        },
    )?;
    Ok(response)
}

pub(crate) fn list_search_identities(
    store: &SessionStore,
    session: &session::RepositorySession,
    params: &SearchIdentitiesParams,
    cache_epoch: u64,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<SearchIdentities, IndexError> {
    validate_identity_params(params)?;
    metadata_index::with_readonly_search_snapshot(
        store,
        session,
        metadata_index::configured_quota()?,
        cache_epoch,
        cancelled,
        deadline,
        |connection, snapshot| {
            let mut identities = BTreeSet::<(String, String)>::new();
            let mut truncated = false;
            let needle = default_case_fold_str(&params.text);
            if let Some(connection) = connection {
                let mut statement = connection
                    .prepare(identity_scan_sql(params.field))
                    .map_err(map_sql_error)?;
                let mut rows = statement
                    .query(params![snapshot.snapshot_key, to_i64(snapshot.watermark)?])
                    .map_err(map_sql_error)?;
                while let Some(row) = rows.next().map_err(map_sql_error)? {
                    check_active(cancelled, deadline)?;
                    let name: String = row.get(0).map_err(map_sql_error)?;
                    let email: String = row.get(1).map_err(map_sql_error)?;
                    if identity_matches(&needle, &name, &email) {
                        identities.insert((name, email));
                        if identities.len() > params.limit as usize {
                            identities.pop_last();
                            truncated = true;
                        }
                    }
                }
            }
            if identities
                .iter()
                .any(|(name, email)| name.chars().count() > 4096 || email.chars().count() > 4096)
            {
                return Err(IndexError {
                    code: ErrorCode::ResourceLimit,
                    message: "A matching identity exceeds the response size limit".into(),
                });
            }
            Ok(SearchIdentities {
                field: params.field,
                identities: identities
                    .into_iter()
                    .map(|(name, email)| SearchIdentity { name, email })
                    .collect(),
                truncated,
                coverage: MetadataIndexCoverage {
                    processed: snapshot.watermark,
                    complete: snapshot.complete,
                },
                index: snapshot.index_status.clone(),
            })
        },
    )
}

pub(crate) fn activity_stats(
    executable: Option<&Path>,
    store: &SessionStore,
    session: &session::RepositorySession,
    params: &GetActivityStatsParams,
    cache_epoch: u64,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<ActivityStats, IndexError> {
    let (snapshot_key, _) = metadata_index::snapshot_identity(session)?;
    let mut compiled = compile_query(&params.query, session, &snapshot_key)?;
    if compiled.path_bytes.is_some() && executable.is_none() {
        return Err(IndexError {
            code: ErrorCode::GitUnavailable,
            message: "Git executable is required for path activity statistics".into(),
        });
    }
    resolve_excluded_tips(executable, session, &mut compiled, cancelled, deadline)?;
    let time_zone = params
        .query
        .time_zone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| invalid_request("timeZone must be an IANA time zone"))?;
    metadata_index::with_readonly_search_snapshot(
        store,
        session,
        metadata_index::configured_quota()?,
        cache_epoch,
        cancelled,
        deadline,
        |connection, snapshot| {
            let mut matched_count = 0_u64;
            let mut days = BTreeMap::<String, u64>::new();
            let mut authors = BTreeMap::<(String, String), u64>::new();
            let mut days_truncated = false;
            let mut authors_truncated = false;
            let mut path_batch = Vec::<ActivityCandidate>::with_capacity(PATH_DIFF_BATCH_SIZE);
            if let Some(connection) = connection {
                let indexed_path = if let (Some(filter), Some(raw_path)) =
                    (&compiled.query.path, compiled.path_bytes.as_deref())
                    && has_change_index(connection)?
                {
                    Some(query_indexed_path_oids(
                        connection, filter, raw_path, cancelled, deadline,
                    )?)
                } else {
                    None
                };
                let fts_query = if has_message_fts(connection)? {
                    fts_trigram_query(&compiled)
                } else {
                    None
                };
                let sql = select_scan_sql(
                    indexed_path.is_some(),
                    fts_query.is_some(),
                    &compiled.query.oid_prefix,
                );
                let mut statement = connection.prepare_cached(sql).map_err(map_sql_error)?;
                let watermark = to_i64(snapshot.watermark)?;
                let upper = (!compiled.query.oid_prefix.is_empty())
                    .then(|| oid_prefix_upper_bound(&compiled.query.oid_prefix));
                let mut rows = match (&fts_query, upper.as_deref()) {
                    (Some(fts_expr), Some(upper)) => statement.query(params![
                        snapshot.snapshot_key,
                        watermark,
                        fts_expr,
                        &compiled.query.oid_prefix,
                        upper
                    ]),
                    (Some(fts_expr), None) => {
                        statement.query(params![snapshot.snapshot_key, watermark, fts_expr])
                    }
                    (None, Some(upper)) => statement.query(params![
                        snapshot.snapshot_key,
                        watermark,
                        &compiled.query.oid_prefix,
                        upper
                    ]),
                    (None, None) => statement.query(params![snapshot.snapshot_key, watermark]),
                }
                .map_err(map_sql_error)?;
                while let Some(row) = rows.next().map_err(map_sql_error)? {
                    check_active(cancelled, deadline)?;
                    let Some(key) = matching_row_key(row, &compiled, cancelled, deadline)? else {
                        continue;
                    };
                    let author_name: String = row.get(4).map_err(map_sql_error)?;
                    let author_email: String = row.get(5).map_err(map_sql_error)?;
                    if let Some(indexed_oids) = &indexed_path {
                        let changes_complete: i64 = row.get(9).map_err(map_sql_error)?;
                        if changes_complete == 1 {
                            if indexed_oids.contains(&key.oid) {
                                record_activity(
                                    key.timestamp,
                                    author_name,
                                    author_email,
                                    &time_zone,
                                    &mut matched_count,
                                    &mut days,
                                    &mut authors,
                                    &mut days_truncated,
                                    &mut authors_truncated,
                                )?;
                            }
                            continue;
                        }
                    }
                    if compiled.path_bytes.is_some() {
                        let summary = load_summary_by_oid(connection, &key.oid)?;
                        path_batch.push(ActivityCandidate {
                            key,
                            summary,
                            author_name,
                            author_email,
                        });
                        if path_batch.len() == PATH_DIFF_BATCH_SIZE {
                            add_path_activity_batch(
                                executable.expect("path activity requires Git"),
                                session,
                                &compiled,
                                &time_zone,
                                &mut path_batch,
                                cancelled,
                                deadline,
                                &mut matched_count,
                                &mut days,
                                &mut authors,
                                &mut days_truncated,
                                &mut authors_truncated,
                            )?;
                        }
                    } else {
                        record_activity(
                            key.timestamp,
                            author_name,
                            author_email,
                            &time_zone,
                            &mut matched_count,
                            &mut days,
                            &mut authors,
                            &mut days_truncated,
                            &mut authors_truncated,
                        )?;
                    }
                }
            }
            if !path_batch.is_empty() {
                add_path_activity_batch(
                    executable.expect("path activity requires Git"),
                    session,
                    &compiled,
                    &time_zone,
                    &mut path_batch,
                    cancelled,
                    deadline,
                    &mut matched_count,
                    &mut days,
                    &mut authors,
                    &mut days_truncated,
                    &mut authors_truncated,
                )?;
            }
            Ok(ActivityStats {
                query_key: compiled.key.clone(),
                coverage: MetadataIndexCoverage {
                    processed: snapshot.watermark,
                    complete: snapshot.complete,
                },
                index: snapshot.index_status.clone(),
                matched_count,
                time_field: compiled.query.time_field,
                time_zone: compiled.query.time_zone.clone(),
                days: days
                    .into_iter()
                    .map(|(day, count)| ActivityDay { day, count })
                    .collect(),
                days_truncated,
                authors: authors
                    .into_iter()
                    .map(|((name, email), count)| ActivityAuthor { name, email, count })
                    .collect(),
                authors_truncated,
            })
        },
    )
}

struct ActivityCandidate {
    key: CandidateKey,
    summary: CommitSummary,
    author_name: String,
    author_email: String,
}

#[allow(clippy::too_many_arguments)]
fn add_path_activity_batch(
    executable: &Path,
    session: &session::RepositorySession,
    compiled: &CompiledQuery,
    time_zone: &chrono_tz::Tz,
    batch: &mut Vec<ActivityCandidate>,
    cancelled: &AtomicBool,
    deadline: Instant,
    matched_count: &mut u64,
    days: &mut BTreeMap<String, u64>,
    authors: &mut BTreeMap<(String, String), u64>,
    days_truncated: &mut bool,
    authors_truncated: &mut bool,
) -> Result<(), IndexError> {
    let filter = compiled.query.path.as_ref().expect("path activity filter");
    let path = compiled.path_bytes.as_deref().expect("path activity bytes");
    let summaries = batch
        .iter()
        .map(|candidate| candidate.summary.clone())
        .collect::<Vec<_>>();
    let matches = path_indices_for_commits(
        executable,
        Path::new(&session.discovered.info.path),
        filter,
        path,
        &summaries,
        repository::history_boundary_limited(&session.discovered),
        cancelled,
        deadline,
    )?;
    for (candidate, parent_indices) in batch.drain(..).zip(matches) {
        if !parent_indices.is_empty() {
            record_activity(
                candidate.key.timestamp,
                candidate.author_name,
                candidate.author_email,
                time_zone,
                matched_count,
                days,
                authors,
                days_truncated,
                authors_truncated,
            )?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn record_activity(
    timestamp: i64,
    author_name: String,
    author_email: String,
    time_zone: &chrono_tz::Tz,
    matched_count: &mut u64,
    days: &mut BTreeMap<String, u64>,
    authors: &mut BTreeMap<(String, String), u64>,
    days_truncated: &mut bool,
    authors_truncated: &mut bool,
) -> Result<(), IndexError> {
    let date = chrono::DateTime::from_timestamp(timestamp, 0)
        .ok_or_else(|| corrupt_index("Indexed commit timestamp is outside supported range"))?
        .with_timezone(time_zone)
        .date_naive()
        .to_string();
    *matched_count = matched_count
        .checked_add(1)
        .ok_or_else(|| invalid_request("Activity match count overflow"))?;
    // Past the limit the newest days stay: the date rail and "recent activity" both start there.
    increment_bounded(
        days,
        date,
        ACTIVITY_DAY_LIMIT,
        Keep::Highest,
        days_truncated,
    )?;
    increment_bounded(
        authors,
        (author_name, author_email),
        ACTIVITY_AUTHOR_LIMIT,
        Keep::Lowest,
        authors_truncated,
    )?;
    Ok(())
}

/// Which end of the key order a full bucket map keeps.
#[derive(Clone, Copy)]
enum Keep {
    Lowest,
    Highest,
}

/// Counts `key`, keeping at most `limit` keys from the `keep` end. The cut-off only moves inward,
/// so a key that is kept has every one of its commits counted.
fn increment_bounded<K: Ord>(
    values: &mut BTreeMap<K, u64>,
    key: K,
    limit: usize,
    keep: Keep,
    truncated: &mut bool,
) -> Result<(), IndexError> {
    if let Some(count) = values.get_mut(&key) {
        *count = count
            .checked_add(1)
            .ok_or_else(|| invalid_request("Activity bucket count overflow"))?;
        return Ok(());
    }
    if values.len() < limit {
        values.insert(key, 1);
        return Ok(());
    }
    *truncated = true;
    let replaces = match keep {
        Keep::Lowest => values.last_key_value().is_some_and(|(last, _)| &key < last),
        Keep::Highest => values
            .first_key_value()
            .is_some_and(|(first, _)| &key > first),
    };
    if replaces {
        match keep {
            Keep::Lowest => values.pop_last(),
            Keep::Highest => values.pop_first(),
        };
        values.insert(key, 1);
    }
    Ok(())
}

pub(crate) fn list_search_paths(
    executable: &Path,
    session: &session::RepositorySession,
    params: &ListSearchPathsParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<SearchPaths, IndexError> {
    if params.text.len() > 32_768 || !(1..=100).contains(&params.limit) {
        return Err(invalid_request("Path completion parameters are invalid"));
    }
    repository::verify_graph_fingerprint(&session.discovered, cancelled, deadline)
        .map_err(map_repository_error)?;
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_path_git_failure)?;
    let mut tips = session.discovered.scope_tips.clone();
    tips.sort();
    tips.dedup();
    let prefix = params.text.as_bytes();
    let mut entries = BTreeSet::<(Vec<u8>, u8)>::new();
    let mut truncated = false;
    for tip in tips {
        check_active(cancelled, deadline)?;
        let output = git
            .run(
                Path::new(&session.discovered.info.path),
                &[
                    string_arg("ls-tree"),
                    string_arg("-r"),
                    string_arg("-t"),
                    string_arg("-z"),
                    string_arg("--full-tree"),
                    string_arg(&tip),
                ],
                None,
                PATH_COMPLETION_OUTPUT_LIMIT,
                cancelled,
                deadline,
            )
            .map_err(map_path_git_failure)?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(IndexError {
                code: if stderr.contains("missing") || stderr.contains("bad object") {
                    ErrorCode::MissingObject
                } else {
                    ErrorCode::GitError
                },
                message: "Git could not list paths in the frozen scope".into(),
            });
        }
        for record in output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
        {
            check_active(cancelled, deadline)?;
            let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
                return Err(corrupt_index("Git returned a malformed tree path record"));
            };
            let metadata = &record[..tab];
            let is_directory = metadata.split(|byte| *byte == b' ').nth(1) == Some(b"tree");
            let raw_path = &record[tab + 1..];
            if !raw_path.starts_with(prefix) {
                continue;
            }
            insert_path_suggestion(
                &mut entries,
                raw_path.to_vec(),
                if is_directory { 1 } else { 0 },
                params.limit as usize,
                &mut truncated,
            );
        }
    }
    repository::verify_graph_fingerprint(&session.discovered, cancelled, deadline)
        .map_err(map_repository_error)?;
    Ok(SearchPaths {
        entries: entries
            .into_iter()
            .map(|(raw_path, kind)| SearchPathEntry {
                path: commitscope_core::GitPath {
                    display: String::from_utf8_lossy(&raw_path).into_owned(),
                    raw_hex: hex(&raw_path),
                    text_lossy: std::str::from_utf8(&raw_path).is_err(),
                },
                kind: if kind == 1 {
                    SearchPathKind::Directory
                } else {
                    SearchPathKind::File
                },
            })
            .collect(),
        truncated,
    })
}

fn insert_path_suggestion(
    entries: &mut BTreeSet<(Vec<u8>, u8)>,
    raw_path: Vec<u8>,
    kind: u8,
    limit: usize,
    truncated: &mut bool,
) {
    entries.insert((raw_path, kind));
    if entries.len() > limit {
        entries.pop_last();
        *truncated = true;
    }
}

struct BufferedCandidate {
    key: CandidateKey,
    summary: CommitSummary,
}

#[allow(clippy::too_many_arguments)]
fn collect_page(
    executable: Option<&Path>,
    session: Option<&session::RepositorySession>,
    connection: Option<&Connection>,
    snapshot: &SearchSnapshot,
    compiled: &CompiledQuery,
    page_size: u16,
    cursor: Option<&SearchCursor>,
    boundary: Option<CandidateKey>,
    anchor_requested: bool,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<SearchPage, IndexError> {
    let capacity = page_size as usize;
    let mut forward = BinaryHeap::<Candidate>::with_capacity(capacity.saturating_add(1));
    let mut backward = BinaryHeap::<Reverse<Candidate>>::with_capacity(capacity.saturating_add(1));
    let mut matched_count = 0_u64;
    let mut before_boundary = 0_u64;
    let mut boundary_seen = boundary.is_none();
    let mut anchor_found = anchor_requested.then_some(false);
    if boundary.is_some() && cursor.is_none() {
        anchor_found = Some(true);
    }
    if let Some(connection) = connection {
        let indexed_path = if let (Some(filter), Some(raw_path)) =
            (&compiled.query.path, compiled.path_bytes.as_deref())
            && has_change_index(connection)?
        {
            Some(query_indexed_path_oids(
                connection, filter, raw_path, cancelled, deadline,
            )?)
        } else {
            None
        };
        let fts_query = if has_message_fts(connection)? {
            fts_trigram_query(compiled)
        } else {
            None
        };
        let sql = select_scan_sql(
            indexed_path.is_some(),
            fts_query.is_some(),
            &compiled.query.oid_prefix,
        );
        let mut statement = connection.prepare_cached(sql).map_err(map_sql_error)?;
        let watermark = to_i64(snapshot.watermark)?;
        let upper = (!compiled.query.oid_prefix.is_empty())
            .then(|| oid_prefix_upper_bound(&compiled.query.oid_prefix));
        let mut rows = match (&fts_query, upper.as_deref()) {
            (Some(fts_expr), Some(upper)) => statement.query(params![
                snapshot.snapshot_key,
                watermark,
                fts_expr,
                &compiled.query.oid_prefix,
                upper
            ]),
            (Some(fts_expr), None) => {
                statement.query(params![snapshot.snapshot_key, watermark, fts_expr])
            }
            (None, Some(upper)) => statement.query(params![
                snapshot.snapshot_key,
                watermark,
                &compiled.query.oid_prefix,
                upper
            ]),
            (None, None) => statement.query(params![snapshot.snapshot_key, watermark]),
        }
        .map_err(map_sql_error)?;
        let mut batch = Vec::with_capacity(PATH_DIFF_BATCH_SIZE);
        while let Some(row) = rows.next().map_err(map_sql_error)? {
            check_active(cancelled, deadline)?;
            let Some(key) = matching_row_key(row, compiled, cancelled, deadline)? else {
                continue;
            };
            if let Some(indexed_oids) = &indexed_path {
                let changes_complete: i64 = row.get(9).map_err(map_sql_error)?;
                if changes_complete == 1 {
                    if !indexed_oids.contains(&key.oid) {
                        continue;
                    }
                    let parents = load_parents_by_oid(connection, &key.oid)?;
                    if parents.len() <= 1 {
                        let parent_indices = if parents.is_empty() {
                            vec![None]
                        } else {
                            vec![Some(0)]
                        };
                        consider_candidate(
                            key,
                            parent_indices,
                            &mut forward,
                            &mut backward,
                            &mut matched_count,
                            &mut before_boundary,
                            &mut boundary_seen,
                            &mut anchor_found,
                            boundary.as_ref(),
                            cursor,
                            anchor_requested,
                            capacity,
                        )?;
                        continue;
                    }
                    batch.push(BufferedCandidate {
                        summary: load_summary_by_oid(connection, &key.oid)?,
                        key,
                    });
                    if batch.len() == PATH_DIFF_BATCH_SIZE {
                        process_path_batch(
                            executable.expect("path query requires Git"),
                            session.expect("path query requires session"),
                            compiled,
                            &mut batch,
                            cancelled,
                            deadline,
                            &mut forward,
                            &mut backward,
                            &mut matched_count,
                            &mut before_boundary,
                            &mut boundary_seen,
                            &mut anchor_found,
                            boundary.as_ref(),
                            cursor,
                            anchor_requested,
                            capacity,
                        )?;
                    }
                    continue;
                }
            }
            if compiled.path_bytes.is_some() {
                batch.push(BufferedCandidate {
                    summary: load_summary_by_oid(connection, &key.oid)?,
                    key,
                });
                if batch.len() == PATH_DIFF_BATCH_SIZE {
                    process_path_batch(
                        executable.expect("path query requires Git"),
                        session.expect("path query requires session"),
                        compiled,
                        &mut batch,
                        cancelled,
                        deadline,
                        &mut forward,
                        &mut backward,
                        &mut matched_count,
                        &mut before_boundary,
                        &mut boundary_seen,
                        &mut anchor_found,
                        boundary.as_ref(),
                        cursor,
                        anchor_requested,
                        capacity,
                    )?;
                }
                continue;
            }
            consider_candidate(
                key,
                Vec::new(),
                &mut forward,
                &mut backward,
                &mut matched_count,
                &mut before_boundary,
                &mut boundary_seen,
                &mut anchor_found,
                boundary.as_ref(),
                cursor,
                anchor_requested,
                capacity,
            )?;
        }
        if !batch.is_empty() {
            process_path_batch(
                executable.expect("path query requires Git"),
                session.expect("path query requires session"),
                compiled,
                &mut batch,
                cancelled,
                deadline,
                &mut forward,
                &mut backward,
                &mut matched_count,
                &mut before_boundary,
                &mut boundary_seen,
                &mut anchor_found,
                boundary.as_ref(),
                cursor,
                anchor_requested,
                capacity,
            )?;
        }
    }
    if !boundary_seen {
        return Err(invalid_cursor());
    }
    let mut candidates: Vec<Candidate> =
        if cursor.is_some_and(|cursor| cursor.direction == CursorDirection::Previous) {
            backward.into_iter().map(|candidate| candidate.0).collect()
        } else {
            forward.into_vec()
        };
    candidates.sort();
    let commits = if let Some(connection) = connection {
        candidates
            .iter()
            .map(|candidate| load_summary_by_oid(connection, &candidate.oid))
            .collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    let page_offset = match cursor.map(|cursor| cursor.direction) {
        Some(CursorDirection::Next) => before_boundary.saturating_add(1),
        Some(CursorDirection::Previous) => before_boundary.saturating_sub(candidates.len() as u64),
        None if boundary.is_some() && anchor_found == Some(true) => before_boundary,
        _ => 0,
    };
    let has_previous = page_offset > 0;
    let has_next = page_offset.saturating_add(candidates.len() as u64) < matched_count;
    let previous_cursor = if has_previous {
        candidates.first().map(|candidate| {
            encode_cursor(make_cursor(
                compiled,
                snapshot,
                page_size,
                CursorDirection::Previous,
                candidate,
            ))
        })
    } else {
        None
    };
    let next_cursor = if has_next {
        candidates.last().map(|candidate| {
            encode_cursor(make_cursor(
                compiled,
                snapshot,
                page_size,
                CursorDirection::Next,
                candidate,
            ))
        })
    } else {
        None
    };
    let path_matches = candidates
        .iter()
        .filter(|candidate| !candidate.parent_indices.is_empty())
        .map(|candidate| SearchPathMatch {
            oid: candidate.oid.clone(),
            parent_indices: candidate.parent_indices.clone(),
        })
        .collect();
    let result_version = result_version(compiled, snapshot);
    Ok(SearchPage {
        query_key: compiled.key.clone(),
        snapshot_key: snapshot.snapshot_key.clone(),
        result_version,
        commits,
        page_offset,
        previous_cursor,
        next_cursor,
        matched_count,
        coverage: MetadataIndexCoverage {
            processed: snapshot.watermark,
            complete: snapshot.complete,
        },
        anchor_found,
        index: snapshot.index_status.clone(),
        path_matches,
    })
}

#[allow(clippy::too_many_arguments)]
fn process_path_batch(
    executable: &Path,
    session: &session::RepositorySession,
    compiled: &CompiledQuery,
    batch: &mut Vec<BufferedCandidate>,
    cancelled: &AtomicBool,
    deadline: Instant,
    forward: &mut BinaryHeap<Candidate>,
    backward: &mut BinaryHeap<Reverse<Candidate>>,
    matched_count: &mut u64,
    before_boundary: &mut u64,
    boundary_seen: &mut bool,
    anchor_found: &mut Option<bool>,
    boundary: Option<&CandidateKey>,
    cursor: Option<&SearchCursor>,
    anchor_requested: bool,
    capacity: usize,
) -> Result<(), IndexError> {
    let path_filter = compiled.query.path.as_ref().expect("compiled path filter");
    let path_bytes = compiled.path_bytes.as_deref().expect("compiled path bytes");
    let summaries = batch
        .iter()
        .map(|candidate| candidate.summary.clone())
        .collect::<Vec<_>>();
    let matches = path_indices_for_commits(
        executable,
        Path::new(&session.discovered.info.path),
        path_filter,
        path_bytes,
        &summaries,
        repository::history_boundary_limited(&session.discovered),
        cancelled,
        deadline,
    )?;
    for (candidate, parent_indices) in batch.drain(..).zip(matches) {
        if parent_indices.is_empty() {
            continue;
        }
        consider_candidate(
            candidate.key,
            parent_indices,
            forward,
            backward,
            matched_count,
            before_boundary,
            boundary_seen,
            anchor_found,
            boundary,
            cursor,
            anchor_requested,
            capacity,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn consider_candidate(
    key: CandidateKey,
    parent_indices: Vec<Option<u16>>,
    forward: &mut BinaryHeap<Candidate>,
    backward: &mut BinaryHeap<Reverse<Candidate>>,
    matched_count: &mut u64,
    before_boundary: &mut u64,
    boundary_seen: &mut bool,
    anchor_found: &mut Option<bool>,
    boundary: Option<&CandidateKey>,
    cursor: Option<&SearchCursor>,
    anchor_requested: bool,
    capacity: usize,
) -> Result<(), IndexError> {
    let relation = boundary
        .map(|boundary| key.compare_order(boundary))
        .unwrap_or(Ordering::Greater);
    if relation == Ordering::Equal {
        *boundary_seen = true;
        if cursor.is_none() && anchor_requested {
            *anchor_found = Some(true);
        }
    }
    if relation == Ordering::Less {
        *before_boundary = before_boundary.saturating_add(1);
    }
    *matched_count = matched_count
        .checked_add(1)
        .ok_or_else(|| invalid_request("Search match count overflow"))?;
    let selected = match cursor.map(|cursor| cursor.direction) {
        Some(CursorDirection::Next) => relation == Ordering::Greater,
        Some(CursorDirection::Previous) => relation == Ordering::Less,
        None if boundary.is_some() => relation != Ordering::Less,
        None => true,
    };
    if !selected {
        return Ok(());
    }
    let candidate_key = CandidateKey {
        timestamp: key.timestamp,
        oid: key.oid.clone(),
    };
    let previous = cursor.is_some_and(|cursor| cursor.direction == CursorDirection::Previous);
    let should_keep = if previous {
        can_keep_latest(backward, &candidate_key, capacity)
    } else {
        can_keep_earliest(forward, &candidate_key, capacity)
    };
    if should_keep {
        let candidate = Candidate {
            timestamp: key.timestamp,
            oid: key.oid,
            parent_indices,
        };
        if previous {
            keep_latest(backward, candidate, capacity);
        } else {
            keep_earliest(forward, candidate, capacity);
        }
    }
    Ok(())
}

fn row_str<'a>(row: &'a rusqlite::Row<'_>, index: usize) -> Result<&'a str, IndexError> {
    row.get_ref(index)
        .map_err(map_sql_error)?
        .as_str()
        .map_err(|_| corrupt_index("Indexed commit text is not UTF-8"))
}

fn minimal_graph_summary(row: &rusqlite::Row<'_>) -> Result<CommitSummary, IndexError> {
    let oid = row_str(row, 1)?.to_owned();
    let parents_json = row_str(row, 9)?;
    let empty_identity = CommitIdentity {
        name: String::new(),
        email: String::new(),
        timestamp: String::new(),
        offset: String::new(),
    };
    Ok(CommitSummary {
        oid,
        parents: serde_json::from_str(parents_json)
            .map_err(|_| corrupt_index("Indexed commit parents are invalid"))?,
        summary: String::new(),
        summary_truncated: false,
        author: empty_identity.clone(),
        committer: empty_identity,
        text_lossy: false,
    })
}

fn parse_i64_fast(bytes: &[u8]) -> Option<i64> {
    if bytes.is_empty() {
        return None;
    }
    let (neg, digits) = if bytes[0] == b'-' {
        (true, &bytes[1..])
    } else if bytes[0] == b'+' {
        (false, &bytes[1..])
    } else {
        (false, bytes)
    };
    if digits.is_empty() {
        return None;
    }
    let mut acc = 0_i64;
    if !neg {
        for &b in digits {
            if !b.is_ascii_digit() {
                return None;
            }
            acc = acc.checked_mul(10)?.checked_add((b - b'0') as i64)?;
        }
    } else {
        for &b in digits {
            if !b.is_ascii_digit() {
                return None;
            }
            acc = acc.checked_mul(10)?.checked_sub((b - b'0') as i64)?;
        }
    }
    Some(acc)
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.len() > haystack.len() {
        return false;
    }
    let last_idx = needle.len() - 1;
    let first_lo = needle[0].to_ascii_lowercase();
    let first_up = needle[0].to_ascii_uppercase();
    if last_idx == 0 {
        return haystack.iter().any(|&b| b == first_lo || b == first_up);
    }
    let last_lo = needle[last_idx].to_ascii_lowercase();
    let last_up = needle[last_idx].to_ascii_uppercase();
    let limit = haystack.len() - last_idx;
    for i in 0..limit {
        let hb = haystack[i];
        if (hb == first_lo || hb == first_up)
            && {
                let eb = haystack[i + last_idx];
                eb == last_lo || eb == last_up
            }
            && haystack[i + 1..i + last_idx].eq_ignore_ascii_case(&needle[1..last_idx])
        {
            return true;
        }
    }
    false
}

fn is_ascii_or_cjk(text: &str) -> bool {
    text.is_ascii()
        || text.chars().all(|ch| {
            ch.is_ascii()
                || ('\u{3000}'..='\u{303F}').contains(&ch)
                || ('\u{3400}'..='\u{9FFF}').contains(&ch)
        })
}

fn matching_row_key(
    row: &rusqlite::Row<'_>,
    compiled: &CompiledQuery,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<CandidateKey>, IndexError> {
    let _ordinal = u64::try_from(row.get::<_, i64>(0).map_err(map_sql_error)?)
        .map_err(|_| corrupt_index("Metadata member ordinal is invalid"))?;
    let oid = row_str(row, 1)?;
    if let Some(included) = &compiled.included_oids
        && !included.contains(oid)
    {
        return Ok(None);
    }
    if !compiled.query.oid_prefix.is_empty() && !oid.starts_with(&compiled.query.oid_prefix) {
        return Ok(None);
    }
    if !compiled.query.authors.is_empty() {
        let name = row_str(row, 4)?;
        let email = row_str(row, 5)?;
        if !identity_field_matches(&compiled.query.authors, name, email) {
            return Ok(None);
        }
    }
    if !compiled.query.committers.is_empty() {
        let name = row_str(row, 6)?;
        let email = row_str(row, 7)?;
        if !identity_field_matches(&compiled.query.committers, name, email) {
            return Ok(None);
        }
    }
    let timestamp_bytes = match compiled.query.time_field {
        SearchTimeField::Author => row.get_ref(2),
        SearchTimeField::Committer => row.get_ref(3),
    }
    .map_err(map_sql_error)?
    .as_bytes()
    .map_err(|_| corrupt_index("Indexed commit timestamp is not UTF-8"))?;
    let timestamp = parse_i64_fast(timestamp_bytes)
        .ok_or_else(|| corrupt_index("Indexed commit timestamp is invalid"))?;
    if compiled
        .query
        .from_timestamp
        .is_some_and(|from| timestamp < from)
        || compiled
            .query
            .to_timestamp
            .is_some_and(|to| timestamp >= to)
    {
        return Ok(None);
    }
    check_active(cancelled, deadline)?;
    if !message_matches(row, compiled)? {
        return Ok(None);
    }
    Ok(Some(CandidateKey {
        timestamp,
        oid: oid.to_owned(),
    }))
}

fn message_matches(row: &rusqlite::Row<'_>, compiled: &CompiledQuery) -> Result<bool, IndexError> {
    if compiled.message_needle.is_empty() {
        return Ok(true);
    }
    let message = row_str(row, 8)?;
    if compiled.query.case_sensitive {
        return Ok(message.contains(&compiled.message_needle));
    }
    if compiled.message_needle.is_ascii() {
        if contains_ascii_case_insensitive(message.as_bytes(), compiled.message_needle.as_bytes()) {
            return Ok(true);
        }
        if is_ascii_or_cjk(message) {
            return Ok(false);
        }
    }
    Ok(default_case_fold_str(message).contains(&compiled.message_needle))
}

fn summary_from_row(row: &rusqlite::Row<'_>) -> Result<CommitSummary, IndexError> {
    let oid: String = row.get(1).map_err(map_sql_error)?;
    let author_timestamp: String = row.get(2).map_err(map_sql_error)?;
    let committer_timestamp: String = row.get(3).map_err(map_sql_error)?;
    let author_name: String = row.get(4).map_err(map_sql_error)?;
    let author_email: String = row.get(5).map_err(map_sql_error)?;
    let committer_name: String = row.get(6).map_err(map_sql_error)?;
    let committer_email: String = row.get(7).map_err(map_sql_error)?;
    let parents_json: String = row.get(9).map_err(map_sql_error)?;
    let summary: String = row.get(10).map_err(map_sql_error)?;
    let summary_truncated: bool = row.get(11).map_err(map_sql_error)?;
    let author_offset: String = row.get(12).map_err(map_sql_error)?;
    let committer_offset: String = row.get(13).map_err(map_sql_error)?;
    let text_lossy: bool = row.get(14).map_err(map_sql_error)?;
    Ok(CommitSummary {
        oid,
        parents: serde_json::from_str(&parents_json)
            .map_err(|_| corrupt_index("Indexed commit parents are invalid"))?,
        summary,
        summary_truncated,
        author: CommitIdentity {
            name: author_name,
            email: author_email,
            timestamp: author_timestamp,
            offset: author_offset,
        },
        committer: CommitIdentity {
            name: committer_name,
            email: committer_email,
            timestamp: committer_timestamp,
            offset: committer_offset,
        },
        text_lossy,
    })
}

fn find_matching_key(
    executable: Option<&Path>,
    session: &session::RepositorySession,
    connection: Option<&Connection>,
    snapshot: &SearchSnapshot,
    compiled: &CompiledQuery,
    oid: &str,
    budget: (&AtomicBool, Instant),
) -> Result<Option<CandidateKey>, IndexError> {
    let (cancelled, deadline) = budget;
    let Some(connection) = connection else {
        return Ok(None);
    };
    let mut statement = connection.prepare(SEARCH_ONE_SQL).map_err(map_sql_error)?;
    let mut rows = statement
        .query(params![
            snapshot.snapshot_key,
            to_i64(snapshot.watermark)?,
            oid
        ])
        .map_err(map_sql_error)?;
    let Some(row) = rows.next().map_err(map_sql_error)? else {
        return Ok(None);
    };
    let Some(key) = matching_row_key(row, compiled, cancelled, deadline)? else {
        return Ok(None);
    };
    if let Some(path) = &compiled.path_bytes {
        let summary = load_summary_by_oid(connection, oid)?;
        let matched = path_indices_for_commits(
            executable.expect("path query requires Git"),
            Path::new(&session.discovered.info.path),
            compiled
                .query
                .path
                .as_ref()
                .expect("compiled path has filter"),
            path,
            std::slice::from_ref(&summary),
            repository::history_boundary_limited(&session.discovered),
            cancelled,
            deadline,
        )?;
        if matched.first().is_none_or(Vec::is_empty) {
            return Ok(None);
        }
    }
    Ok(Some(key))
}

fn resolve_excluded_tips(
    executable: Option<&Path>,
    session: &session::RepositorySession,
    compiled: &mut CompiledQuery,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), IndexError> {
    if compiled.query.exclude_tips.is_empty() {
        return Ok(());
    }
    let Some(executable) = executable else {
        return Err(IndexError {
            code: ErrorCode::GitUnavailable,
            message: "Git executable is required for excludeTips filtering".into(),
        });
    };
    repository::verify_graph_fingerprint(&session.discovered, cancelled, deadline)
        .map_err(map_repository_error)?;
    if session.discovered.scope_tips.is_empty() {
        compiled.included_oids = Some(Arc::new(HashSet::new()));
        return Ok(());
    }
    let boundary_limited = repository::history_boundary_limited(&session.discovered);
    if !boundary_limited
        && let Some(cached) = session
            .excluded_tips_cache
            .lock()
            .expect("excluded tips cache mutex poisoned")
            .iter()
            .find(|(tips, _)| *tips == compiled.query.exclude_tips)
            .map(|(_, oids)| Arc::clone(oids))
    {
        compiled.included_oids = Some(cached);
        return Ok(());
    }
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_path_git_failure)?;
    let cwd = Path::new(&session.discovered.info.path);
    repository::verify_commit_oids(
        executable,
        &session.discovered,
        &compiled.query.exclude_tips,
        cancelled,
        deadline,
    )
    .map_err(map_repository_error)?;
    let mut args = Vec::new();
    if boundary_limited {
        args.push(string_arg("-c"));
        args.push(string_arg("core.commitGraph=false"));
    }
    args.push(string_arg("rev-list"));
    args.extend(session.discovered.scope_tips.iter().map(string_arg));
    args.push(string_arg("--not"));
    args.extend(compiled.query.exclude_tips.iter().map(string_arg));
    args.push(string_arg("--"));
    let mut stream = git
        .stream_lines(cwd, &args, OID_LINE_LIMIT)
        .map_err(map_path_git_failure)?;
    let mut included = HashSet::new();
    while let Some(line) = stream
        .next_line(cancelled, deadline)
        .map_err(map_path_git_failure)?
    {
        let line = line.strip_suffix(b"\r").unwrap_or(&line);
        let oid = std::str::from_utf8(line)
            .map_err(|_| IndexError {
                code: ErrorCode::GitError,
                message: "Git returned non-UTF-8 commit ID".into(),
            })?
            .to_ascii_lowercase();
        if oid.len() != session.discovered.oid_length
            || !oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(IndexError {
                code: ErrorCode::GitError,
                message: "Git returned an unexpected commit ID while filtering range".into(),
            });
        }
        if included.len() >= MAX_EXCLUDE_OID_SCAN {
            return Err(IndexError {
                code: ErrorCode::ResourceLimit,
                message: "批次过滤范围超过 250000 个提交，请改用时间窗口筛选".into(),
            });
        }
        included.insert(oid);
    }
    let included = Arc::new(included);
    if !boundary_limited && included.len() <= MAX_CACHED_EXCLUDED_OIDS {
        let mut cache = session
            .excluded_tips_cache
            .lock()
            .expect("excluded tips cache mutex poisoned");
        cache.retain(|(tips, _)| *tips != compiled.query.exclude_tips);
        if cache.len() >= MAX_CACHED_EXCLUDED_TIPS {
            cache.remove(0);
        }
        cache.push((compiled.query.exclude_tips.clone(), Arc::clone(&included)));
    }
    compiled.included_oids = Some(included);
    Ok(())
}

fn compile_query(
    query: &SearchQuery,
    session: &session::RepositorySession,
    snapshot_key: &str,
) -> Result<CompiledQuery, IndexError> {
    validate_query(query, session.discovered.oid_length)?;
    let mut query = query.clone();
    query.oid_prefix.make_ascii_lowercase();
    query.authors.sort_by(identity_order);
    query.authors.dedup();
    query.committers.sort_by(identity_order);
    query.committers.dedup();
    let message_needle = if query.case_sensitive {
        query.message.clone()
    } else {
        default_case_fold_str(&query.message)
    };
    query.message = message_needle.clone();
    let path_bytes = query
        .path
        .as_ref()
        .map(validate_and_decode_path)
        .transpose()?;
    if let Some(filter) = query.path.as_mut() {
        filter.raw_hex.make_ascii_lowercase();
    }
    for oid in &mut query.exclude_tips {
        oid.make_ascii_lowercase();
    }
    query.exclude_tips.sort();
    query.exclude_tips.dedup();
    let bytes = serde_json::to_vec(&(
        session.info.repo_id.as_str(),
        session.info.generation.as_str(),
        snapshot_key,
        &query,
    ))
    .map_err(|_| invalid_request("Could not normalize search query"))?;
    Ok(CompiledQuery {
        key: hex(&Sha256::digest(bytes)),
        query,
        message_needle,
        path_bytes,
        included_oids: None,
    })
}

fn validate_query(query: &SearchQuery, oid_length: usize) -> Result<(), IndexError> {
    if query.message.len() > 4096
        || query.authors.len() > 50
        || query.committers.len() > 50
        || query.exclude_tips.len() > MAX_EXCLUDE_TIPS
        || query.time_zone.len() > 128
        || query
            .authors
            .iter()
            .chain(&query.committers)
            .any(|identity| identity.name.len() > 4096 || identity.email.len() > 4096)
    {
        return Err(invalid_request("Search query exceeds a field limit"));
    }
    if query
        .exclude_tips
        .iter()
        .any(|oid| oid.len() != oid_length || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(invalid_request(
            "excludeTips entries must be full hexadecimal object IDs",
        ));
    }
    if let Some(path) = &query.path {
        validate_and_decode_path(path)?;
    }
    if !query.oid_prefix.is_empty()
        && (query.oid_prefix.len() < 4
            || query.oid_prefix.len() > oid_length
            || !query
                .oid_prefix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(invalid_request(
            "oidPrefix must be a 4+ digit hexadecimal prefix",
        ));
    }
    for timestamp in [query.from_timestamp, query.to_timestamp]
        .into_iter()
        .flatten()
    {
        if timestamp.unsigned_abs() > JS_SAFE_INTEGER as u64 {
            return Err(invalid_request(
                "Timestamp exceeds JavaScript safe integer range",
            ));
        }
    }
    if query
        .from_timestamp
        .zip(query.to_timestamp)
        .is_some_and(|(from, to)| from >= to)
    {
        return Err(invalid_request("fromTimestamp must be before toTimestamp"));
    }
    Ok(())
}

fn validate_and_decode_path(filter: &SearchPathFilter) -> Result<Vec<u8>, IndexError> {
    if filter.raw_hex.len() > 32_768
        || !filter.raw_hex.len().is_multiple_of(2)
        || !filter.raw_hex.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(invalid_request("Path rawHex must be bounded hexadecimal"));
    }
    let bytes = (0..filter.raw_hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&filter.raw_hex[index..index + 2], 16))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid_request("Path rawHex is invalid"))?;
    if (filter.kind == SearchPathKind::File && bytes.is_empty())
        || bytes.contains(&0)
        || bytes.first() == Some(&b'/')
        || (filter.kind == SearchPathKind::Directory && bytes.last() == Some(&b'/'))
        || (!bytes.is_empty()
            && bytes
                .split(|byte| *byte == b'/')
                .any(|part| part.is_empty() || part == b"." || part == b".."))
    {
        return Err(invalid_request(
            "Path must be a normalized repository-relative path",
        ));
    }
    Ok(bytes)
}

#[allow(clippy::too_many_arguments)]
fn path_indices_for_commits(
    executable: &Path,
    repository_path: &Path,
    filter: &SearchPathFilter,
    path: &[u8],
    commits: &[CommitSummary],
    boundary_limited: bool,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<Vec<Option<u16>>>, IndexError> {
    let mut input = Vec::new();
    let mut pairs = Vec::new();
    for (candidate_index, commit) in commits.iter().enumerate() {
        if commit.parents.is_empty() {
            input.extend_from_slice(commit.oid.as_bytes());
            input.push(b'\n');
            pairs.push((candidate_index, None, commit.oid.as_str()));
        } else {
            for (parent_index, parent_oid) in commit.parents.iter().enumerate() {
                let parent_index = u16::try_from(parent_index).map_err(|_| {
                    map_repository_error(repository::resource_limit(
                        "Commit has too many raw parents",
                    ))
                })?;
                input.extend_from_slice(commit.oid.as_bytes());
                input.push(b' ');
                input.extend_from_slice(parent_oid.as_bytes());
                input.push(b'\n');
                pairs.push((candidate_index, Some(parent_index), commit.oid.as_str()));
            }
        }
    }
    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut args = Vec::new();
    if boundary_limited {
        args.push(string_arg("-c"));
        args.push(string_arg("core.commitGraph=false"));
    }
    args.extend([
        string_arg("-c"),
        string_arg(format!("core.attributesFile={null_device}")),
        string_arg("-c"),
        string_arg("diff.external="),
        string_arg("--literal-pathspecs"),
        string_arg("diff-tree"),
        string_arg("--stdin"),
        string_arg("--root"),
        string_arg("--always"),
        string_arg("-r"),
        string_arg("--raw"),
        string_arg("-z"),
        string_arg("--no-abbrev"),
        string_arg("--no-renames"),
        string_arg("--no-ext-diff"),
        string_arg("--no-textconv"),
        string_arg("--ignore-submodules=none"),
        string_arg("--no-relative"),
        string_arg("--submodule=short"),
        string_arg("--diff-algorithm=myers"),
        string_arg("--indent-heuristic"),
        string_arg(format!("-O{null_device}")),
        string_arg("--"),
    ]);
    if !path.is_empty() {
        let mut pathspec = path.to_vec();
        if filter.kind == SearchPathKind::Directory {
            pathspec.push(b'/');
        }
        args.push(raw_path_argument(&pathspec)?);
    }
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_path_git_failure)?;
    let output = git
        .run(
            repository_path,
            &args,
            Some(&input),
            PATH_DIFF_OUTPUT_LIMIT,
            cancelled,
            deadline,
        )
        .map_err(map_path_git_failure)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(IndexError {
            code: if stderr.contains("missing") || stderr.contains("bad object") {
                ErrorCode::MissingObject
            } else {
                ErrorCode::GitError
            },
            message: "Git could not compare the frozen commit paths".into(),
        });
    }
    let mut matches = vec![Vec::new(); commits.len()];
    let fields = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut field_index = 0;
    for (candidate_index, parent_index, expected_oid) in pairs {
        while field_index < fields.len() && fields[field_index].is_empty() {
            field_index += 1;
        }
        let header = fields
            .get(field_index)
            .ok_or_else(|| corrupt_index("Git returned fewer raw path groups than requested"))?;
        let header_oid = header
            .split(|byte| byte.is_ascii_whitespace())
            .next()
            .unwrap_or_default();
        if header_oid != expected_oid.as_bytes() {
            return Err(corrupt_index("Git raw path groups are out of order"));
        }
        field_index += 1;
        while field_index < fields.len() && fields[field_index].first() == Some(&b':') {
            let raw_header = fields[field_index];
            let status = raw_header
                .rsplit(|byte| byte.is_ascii_whitespace())
                .next()
                .unwrap_or_default();
            field_index += 1;
            let changed_path = fields
                .get(field_index)
                .ok_or_else(|| corrupt_index("Git raw path record has no path field"))?;
            if status
                .first()
                .is_some_and(|status| matches!(status, b'R' | b'C'))
            {
                return Err(corrupt_index("Rename detection was unexpectedly enabled"));
            }
            if path_matches(filter, path, changed_path) {
                let parent_indices = &mut matches[candidate_index];
                if !parent_indices.contains(&parent_index) {
                    parent_indices.push(parent_index);
                }
            }
            field_index += 1;
        }
    }
    if fields[field_index..]
        .iter()
        .any(|field| !field.is_empty() && field.first() == Some(&b':'))
    {
        return Err(corrupt_index("Git returned unexpected raw path records"));
    }
    Ok(matches)
}

fn path_matches(filter: &SearchPathFilter, raw_path: &[u8], changed_path: &[u8]) -> bool {
    match filter.kind {
        SearchPathKind::File => changed_path == raw_path,
        SearchPathKind::Directory if raw_path.is_empty() => {
            filter.include_descendants || !changed_path.contains(&b'/')
        }
        SearchPathKind::Directory => {
            let Some(remainder) = changed_path
                .strip_prefix(raw_path)
                .and_then(|remainder| remainder.strip_prefix(b"/"))
            else {
                return false;
            };
            filter.include_descendants || !remainder.contains(&b'/')
        }
    }
}

fn raw_path_argument(bytes: &[u8]) -> Result<std::ffi::OsString, IndexError> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Ok(std::ffi::OsString::from_vec(bytes.to_vec()))
    }
    #[cfg(windows)]
    {
        String::from_utf8(bytes.to_vec())
            .map(std::ffi::OsString::from)
            .map_err(|_| invalid_request("This platform cannot represent the raw path"))
    }
}

fn map_path_git_failure(error: GitFailure) -> IndexError {
    let (code, message) = match error {
        GitFailure::Cancelled => (ErrorCode::Cancelled, "Search was cancelled"),
        GitFailure::Timeout => (ErrorCode::Timeout, "Path search timed out"),
        GitFailure::ResourceLimit => (
            ErrorCode::ResourceLimit,
            "Path search output exceeded its limit",
        ),
        GitFailure::Unavailable(_) => (
            ErrorCode::GitUnavailable,
            "Git is unavailable for path search",
        ),
        GitFailure::CommandFailed(_) => (ErrorCode::GitError, "Git failed while searching paths"),
    };
    IndexError {
        code,
        message: message.into(),
    }
}

fn map_repository_error(error: repository::PreviewError) -> IndexError {
    IndexError {
        code: error.code,
        message: error.message,
    }
}

fn validate_identity_params(params: &SearchIdentitiesParams) -> Result<(), IndexError> {
    if params.text.len() > 1024 || !(1..=MAX_IDENTITIES as u16).contains(&params.limit) {
        return Err(invalid_request(
            "Identity suggestion parameters are invalid",
        ));
    }
    Ok(())
}

fn validate_page_size(page_size: u16) -> Result<(), IndexError> {
    if !(1..=500).contains(&page_size) {
        return Err(invalid_request("pageSize must be between 1 and 500"));
    }
    Ok(())
}

fn validate_cursor(
    cursor: &SearchCursor,
    compiled: &CompiledQuery,
    snapshot: &SearchSnapshot,
    page_size: u16,
) -> Result<(), IndexError> {
    if cursor.query_key != compiled.key
        || cursor.snapshot_key != snapshot.snapshot_key
        || cursor.page_size != page_size
        || cursor.oid.len() < 4
        || !cursor.oid.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(invalid_cursor());
    }
    if cursor.file_identity != snapshot.file_identity
        || cursor.watermark > snapshot.watermark
        || (cursor.complete && (!snapshot.complete || cursor.watermark != snapshot.watermark))
    {
        return Err(snapshot_changed());
    }
    Ok(())
}

fn decode_cursor(cursor: &str) -> Result<SearchCursor, IndexError> {
    if cursor.len() > MAX_CURSOR_BYTES {
        return Err(invalid_cursor());
    }
    let Some(encoded) = cursor.strip_prefix("s1.") else {
        return Err(invalid_cursor());
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| invalid_cursor())?;
    if bytes.len() > MAX_CURSOR_PAYLOAD_BYTES {
        return Err(invalid_cursor());
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid_cursor())
}

fn encode_cursor(cursor: SearchCursor) -> String {
    let bytes = serde_json::to_vec(&cursor).expect("search cursor serializes");
    format!("s1.{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn make_cursor(
    compiled: &CompiledQuery,
    snapshot: &SearchSnapshot,
    page_size: u16,
    direction: CursorDirection,
    candidate: &Candidate,
) -> SearchCursor {
    SearchCursor {
        query_key: compiled.key.clone(),
        snapshot_key: snapshot.snapshot_key.clone(),
        file_identity: snapshot.file_identity.clone(),
        watermark: snapshot.watermark,
        complete: snapshot.complete,
        page_size,
        direction,
        timestamp: candidate.timestamp,
        oid: candidate.oid.clone(),
    }
}

fn keep_earliest(heap: &mut BinaryHeap<Candidate>, candidate: Candidate, capacity: usize) {
    if heap.len() < capacity {
        heap.push(candidate);
    } else if heap
        .peek()
        .is_some_and(|worst| candidate.cmp(worst).is_lt())
    {
        heap.pop();
        heap.push(candidate);
    }
}

fn can_keep_earliest(
    heap: &BinaryHeap<Candidate>,
    candidate: &CandidateKey,
    capacity: usize,
) -> bool {
    heap.len() < capacity
        || heap.peek().is_some_and(|worst| {
            CandidateKey {
                timestamp: worst.timestamp,
                oid: worst.oid.clone(),
            }
            .compare_order(candidate)
            .is_gt()
        })
}

fn keep_latest(heap: &mut BinaryHeap<Reverse<Candidate>>, candidate: Candidate, capacity: usize) {
    if heap.len() < capacity {
        heap.push(Reverse(candidate));
    } else if heap
        .peek()
        .is_some_and(|earliest| candidate.cmp(&earliest.0).is_gt())
    {
        heap.pop();
        heap.push(Reverse(candidate));
    }
}

fn can_keep_latest(
    heap: &BinaryHeap<Reverse<Candidate>>,
    candidate: &CandidateKey,
    capacity: usize,
) -> bool {
    heap.len() < capacity
        || heap.peek().is_some_and(|earliest| {
            candidate
                .compare_order(&CandidateKey {
                    timestamp: earliest.0.timestamp,
                    oid: earliest.0.oid.clone(),
                })
                .is_gt()
        })
}

fn identity_field_matches(selected: &[SearchIdentity], name: &str, email: &str) -> bool {
    selected.is_empty()
        || selected
            .iter()
            .any(|identity| identity.name == name && identity.email == email)
}

fn identity_matches(needle: &str, name: &str, email: &str) -> bool {
    needle.is_empty()
        || default_case_fold_str(name).contains(needle)
        || default_case_fold_str(email).contains(needle)
}

fn identity_order(left: &SearchIdentity, right: &SearchIdentity) -> Ordering {
    left.name
        .cmp(&right.name)
        .then_with(|| left.email.cmp(&right.email))
}

fn identity_scan_sql(field: SearchTimeField) -> &'static str {
    match field {
        SearchTimeField::Author => {
            "SELECT c.author_name,c.author_email FROM snapshot_commits s JOIN commits c ON c.oid=s.oid WHERE s.snapshot_key=?1 AND s.ordinal<?2 ORDER BY s.ordinal"
        }
        SearchTimeField::Committer => {
            "SELECT c.committer_name,c.committer_email FROM snapshot_commits s JOIN commits c ON c.oid=s.oid WHERE s.snapshot_key=?1 AND s.ordinal<?2 ORDER BY s.ordinal"
        }
    }
}

fn result_version(compiled: &CompiledQuery, snapshot: &SearchSnapshot) -> String {
    let bytes = serde_json::to_vec(&(
        compiled.key.as_str(),
        snapshot.snapshot_key.as_str(),
        snapshot.file_identity.as_str(),
        snapshot.watermark,
        snapshot.complete,
    ))
    .expect("search result version serializes");
    hex(&Sha256::digest(bytes))
}

fn check_active(cancelled: &AtomicBool, deadline: Instant) -> Result<(), IndexError> {
    if cancelled.load(AtomicOrdering::Acquire) {
        return Err(IndexError {
            code: ErrorCode::Cancelled,
            message: "Metadata search was cancelled".into(),
        });
    }
    if Instant::now() >= deadline {
        return Err(IndexError {
            code: ErrorCode::Timeout,
            message: "Metadata search timed out".into(),
        });
    }
    Ok(())
}

fn to_i64(value: u64) -> Result<i64, IndexError> {
    i64::try_from(value).map_err(|_| invalid_request("Search watermark is out of range"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn map_sql_error(error: rusqlite::Error) -> IndexError {
    if matches!(&error, rusqlite::Error::SqliteFailure(code, _) if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
    {
        IndexError {
            code: ErrorCode::Busy,
            message: "Metadata index is busy; retry the search shortly".into(),
        }
    } else if matches!(error, rusqlite::Error::SqliteFailure(_, _)) {
        IndexError {
            code: ErrorCode::IndexCorrupt,
            message: "Metadata index is damaged".into(),
        }
    } else {
        IndexError {
            code: ErrorCode::IndexUnavailable,
            message: format!("Metadata index unavailable: {error}"),
        }
    }
}

fn invalid_request(message: &str) -> IndexError {
    IndexError {
        code: ErrorCode::InvalidRequest,
        message: message.into(),
    }
}

fn corrupt_index(message: &str) -> IndexError {
    IndexError {
        code: ErrorCode::IndexCorrupt,
        message: message.into(),
    }
}

fn invalid_cursor() -> IndexError {
    IndexError {
        code: ErrorCode::InvalidCursor,
        message: "Search cursor is invalid or expired".into(),
    }
}

fn snapshot_changed() -> IndexError {
    IndexError {
        code: ErrorCode::SnapshotChanged,
        message: "Search result version changed; request the latest window".into(),
    }
}

const SEARCH_SCAN_SQL: &str = "SELECT s.ordinal,c.oid,c.author_timestamp,c.committer_timestamp,c.author_name,c.author_email,c.committer_name,c.committer_email,c.message,c.parents_json,c.summary,c.summary_truncated,c.author_offset,c.committer_offset,c.text_lossy FROM snapshot_commits s JOIN commits c ON c.oid=s.oid WHERE s.snapshot_key=?1 AND s.ordinal<?2 ORDER BY s.ordinal";
const SEARCH_FILTER_SQL: &str = "SELECT s.ordinal,c.oid,c.author_timestamp,c.committer_timestamp,c.author_name,c.author_email,c.committer_name,c.committer_email,c.message FROM snapshot_commits s JOIN commits c ON c.oid=s.oid WHERE s.snapshot_key=?1 AND s.ordinal<?2 ORDER BY s.ordinal";
const SEARCH_FILTER_OID_SQL: &str = "SELECT s.ordinal,c.oid,c.author_timestamp,c.committer_timestamp,c.author_name,c.author_email,c.committer_name,c.committer_email,c.message FROM snapshot_commits s INDEXED BY snapshot_commits_oid JOIN commits c ON c.oid=s.oid WHERE s.snapshot_key=?1 AND s.ordinal<?2 AND s.oid>=?3 AND s.oid<?4 ORDER BY s.ordinal";
const SEARCH_FILTER_PATH_SQL: &str = "SELECT s.ordinal,c.oid,c.author_timestamp,c.committer_timestamp,c.author_name,c.author_email,c.committer_name,c.committer_email,c.message,c.changes_complete FROM snapshot_commits s JOIN commits c ON c.oid=s.oid WHERE s.snapshot_key=?1 AND s.ordinal<?2 ORDER BY s.ordinal";
const SEARCH_FILTER_PATH_OID_SQL: &str = "SELECT s.ordinal,c.oid,c.author_timestamp,c.committer_timestamp,c.author_name,c.author_email,c.committer_name,c.committer_email,c.message,c.changes_complete FROM snapshot_commits s INDEXED BY snapshot_commits_oid JOIN commits c ON c.oid=s.oid WHERE s.snapshot_key=?1 AND s.ordinal<?2 AND s.oid>=?3 AND s.oid<?4 ORDER BY s.ordinal";
const SEARCH_FTS_FILTER_SQL: &str = "SELECT s.ordinal,c.oid,c.author_timestamp,c.committer_timestamp,c.author_name,c.author_email,c.committer_name,c.committer_email,c.message FROM commit_message_fts(?3) f JOIN commits c ON c.rowid=f.rowid JOIN snapshot_commits s INDEXED BY snapshot_commits_oid ON s.snapshot_key=?1 AND s.oid=c.oid WHERE s.ordinal<?2";
const SEARCH_FTS_FILTER_OID_SQL: &str = "SELECT s.ordinal,c.oid,c.author_timestamp,c.committer_timestamp,c.author_name,c.author_email,c.committer_name,c.committer_email,c.message FROM commit_message_fts(?3) f JOIN commits c ON c.rowid=f.rowid JOIN snapshot_commits s INDEXED BY snapshot_commits_oid ON s.snapshot_key=?1 AND s.oid=c.oid WHERE s.ordinal<?2 AND s.oid>=?4 AND s.oid<?5";
const SEARCH_FTS_FILTER_PATH_SQL: &str = "SELECT s.ordinal,c.oid,c.author_timestamp,c.committer_timestamp,c.author_name,c.author_email,c.committer_name,c.committer_email,c.message,c.changes_complete FROM commit_message_fts(?3) f JOIN commits c ON c.rowid=f.rowid JOIN snapshot_commits s INDEXED BY snapshot_commits_oid ON s.snapshot_key=?1 AND s.oid=c.oid WHERE s.ordinal<?2";
const SEARCH_FTS_FILTER_PATH_OID_SQL: &str = "SELECT s.ordinal,c.oid,c.author_timestamp,c.committer_timestamp,c.author_name,c.author_email,c.committer_name,c.committer_email,c.message,c.changes_complete FROM commit_message_fts(?3) f JOIN commits c ON c.rowid=f.rowid JOIN snapshot_commits s INDEXED BY snapshot_commits_oid ON s.snapshot_key=?1 AND s.oid=c.oid WHERE s.ordinal<?2 AND s.oid>=?4 AND s.oid<?5";
const SEARCH_ONE_SQL: &str = "SELECT s.ordinal,c.oid,c.author_timestamp,c.committer_timestamp,c.author_name,c.author_email,c.committer_name,c.committer_email,c.message FROM snapshot_commits s JOIN commits c ON c.oid=s.oid WHERE s.snapshot_key=?1 AND s.ordinal<?2 AND c.oid=?3 LIMIT 1";
const SUMMARY_BY_OID_SQL: &str = "SELECT 0,oid,author_timestamp,committer_timestamp,author_name,author_email,committer_name,committer_email,message,parents_json,summary,summary_truncated,author_offset,committer_offset,text_lossy FROM commits WHERE oid=?1 LIMIT 1";
const PARENTS_BY_OID_SQL: &str = "SELECT parents_json FROM commits WHERE oid=?1 LIMIT 1";

fn select_scan_sql(indexed_path: bool, has_fts: bool, oid_prefix: &str) -> &'static str {
    match (indexed_path, has_fts, oid_prefix.is_empty()) {
        (true, true, true) => SEARCH_FTS_FILTER_PATH_SQL,
        (true, true, false) => SEARCH_FTS_FILTER_PATH_OID_SQL,
        (true, false, true) => SEARCH_FILTER_PATH_SQL,
        (true, false, false) => SEARCH_FILTER_PATH_OID_SQL,
        (false, true, true) => SEARCH_FTS_FILTER_SQL,
        (false, true, false) => SEARCH_FTS_FILTER_OID_SQL,
        (false, false, true) => SEARCH_FILTER_SQL,
        (false, false, false) => SEARCH_FILTER_OID_SQL,
    }
}

fn has_change_index(connection: &Connection) -> Result<bool, IndexError> {
    let version: i32 = connection
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(map_sql_error)?;
    Ok(version >= 2)
}

fn has_message_fts(connection: &Connection) -> Result<bool, IndexError> {
    if !has_change_index(connection)? {
        return Ok(false);
    }
    let has_fts: i64 = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='commit_message_fts')",
            [],
            |r| r.get(0),
        )
        .map_err(map_sql_error)?;
    if has_fts == 0 {
        return Ok(false);
    }
    let has_meta: i64 = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='index_meta')",
            [],
            |r| r.get(0),
        )
        .map_err(map_sql_error)?;
    if has_meta == 0 {
        return Ok(false);
    }
    let max_rowid: i64 = connection
        .query_row("SELECT COALESCE(MAX(rowid), 0) FROM commits", [], |r| {
            r.get(0)
        })
        .map_err(map_sql_error)?;
    if max_rowid == 0 {
        return Ok(true);
    }
    let fts_rowid: Option<i64> = connection
        .query_row(
            "SELECT value FROM index_meta WHERE key='message_fts_rowid'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(map_sql_error)?;
    Ok(fts_rowid.is_some_and(|v| v >= max_rowid))
}

fn fts_trigram_query(compiled: &CompiledQuery) -> Option<String> {
    if compiled.message_needle.is_empty() {
        return None;
    }
    let folded = if compiled.query.case_sensitive {
        default_case_fold_str(&compiled.query.message)
    } else {
        compiled.message_needle.clone()
    };
    if folded.chars().count() < 3 || folded.contains('\0') {
        return None;
    }
    Some(format!("\"{}\"", folded.replace('"', "\"\"")))
}

fn load_summary_by_oid(connection: &Connection, oid: &str) -> Result<CommitSummary, IndexError> {
    let mut statement = connection
        .prepare_cached(SUMMARY_BY_OID_SQL)
        .map_err(map_sql_error)?;
    let mut rows = statement.query([oid]).map_err(map_sql_error)?;
    let row = rows
        .next()
        .map_err(map_sql_error)?
        .ok_or_else(|| corrupt_index("Indexed commit metadata row is missing"))?;
    summary_from_row(row)
}

fn load_parents_by_oid(connection: &Connection, oid: &str) -> Result<Vec<String>, IndexError> {
    let mut statement = connection
        .prepare_cached(PARENTS_BY_OID_SQL)
        .map_err(map_sql_error)?;
    let mut rows = statement.query([oid]).map_err(map_sql_error)?;
    let row = rows
        .next()
        .map_err(map_sql_error)?
        .ok_or_else(|| corrupt_index("Indexed commit metadata row is missing"))?;
    let parents_json = row_str(row, 0)?;
    serde_json::from_str(parents_json)
        .map_err(|_| corrupt_index("Indexed commit parents are invalid"))
}

fn query_indexed_path_oids(
    connection: &Connection,
    filter: &SearchPathFilter,
    raw_path: &[u8],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<HashSet<String>, IndexError> {
    let mut oids = HashSet::new();
    let mut seen_rows = 0_u64;
    match filter.kind {
        SearchPathKind::File => {
            let mut statement = connection
                .prepare_cached("SELECT oid FROM commit_path_changes WHERE path=?1")
                .map_err(map_sql_error)?;
            let mut rows = statement.query([raw_path]).map_err(map_sql_error)?;
            while let Some(row) = rows.next().map_err(map_sql_error)? {
                if seen_rows & 1023 == 0 {
                    check_active(cancelled, deadline)?;
                }
                seen_rows += 1;
                oids.insert(row.get::<_, String>(0).map_err(map_sql_error)?);
            }
        }
        SearchPathKind::Directory if raw_path.is_empty() && filter.include_descendants => {
            let mut statement = connection
                .prepare_cached("SELECT DISTINCT oid FROM commit_path_changes")
                .map_err(map_sql_error)?;
            let mut rows = statement.query([]).map_err(map_sql_error)?;
            while let Some(row) = rows.next().map_err(map_sql_error)? {
                if seen_rows & 1023 == 0 {
                    check_active(cancelled, deadline)?;
                }
                seen_rows += 1;
                oids.insert(row.get::<_, String>(0).map_err(map_sql_error)?);
            }
        }
        SearchPathKind::Directory if raw_path.is_empty() => {
            let mut statement = connection
                .prepare_cached("SELECT oid, path FROM commit_path_changes")
                .map_err(map_sql_error)?;
            let mut rows = statement.query([]).map_err(map_sql_error)?;
            while let Some(row) = rows.next().map_err(map_sql_error)? {
                if seen_rows & 1023 == 0 {
                    check_active(cancelled, deadline)?;
                }
                seen_rows += 1;
                let path = row
                    .get_ref(1)
                    .map_err(map_sql_error)?
                    .as_bytes()
                    .map_err(|_| corrupt_index("Indexed path is not valid bytes"))?;
                if !path.contains(&b'/') {
                    oids.insert(row.get::<_, String>(0).map_err(map_sql_error)?);
                }
            }
        }
        SearchPathKind::Directory => {
            let mut prefix = Vec::with_capacity(raw_path.len() + 1);
            prefix.extend_from_slice(raw_path);
            prefix.push(b'/');
            let mut upper = Vec::with_capacity(raw_path.len() + 1);
            upper.extend_from_slice(raw_path);
            upper.push(b'0');
            if filter.include_descendants {
                let mut statement = connection
                    .prepare_cached(
                        "SELECT DISTINCT oid FROM commit_path_changes WHERE path>=?1 AND path<?2",
                    )
                    .map_err(map_sql_error)?;
                let mut rows = statement
                    .query(params![prefix.as_slice(), upper.as_slice()])
                    .map_err(map_sql_error)?;
                while let Some(row) = rows.next().map_err(map_sql_error)? {
                    if seen_rows & 1023 == 0 {
                        check_active(cancelled, deadline)?;
                    }
                    seen_rows += 1;
                    oids.insert(row.get::<_, String>(0).map_err(map_sql_error)?);
                }
            } else {
                let mut statement = connection
                    .prepare_cached(
                        "SELECT oid, path FROM commit_path_changes WHERE path>=?1 AND path<?2",
                    )
                    .map_err(map_sql_error)?;
                let mut rows = statement
                    .query(params![prefix.as_slice(), upper.as_slice()])
                    .map_err(map_sql_error)?;
                while let Some(row) = rows.next().map_err(map_sql_error)? {
                    if seen_rows & 1023 == 0 {
                        check_active(cancelled, deadline)?;
                    }
                    seen_rows += 1;
                    let path = row
                        .get_ref(1)
                        .map_err(map_sql_error)?
                        .as_bytes()
                        .map_err(|_| corrupt_index("Indexed path is not valid bytes"))?;
                    if !path[prefix.len()..].contains(&b'/') {
                        oids.insert(row.get::<_, String>(0).map_err(map_sql_error)?);
                    }
                }
            }
        }
    }
    Ok(oids)
}

fn oid_prefix_upper_bound(prefix: &str) -> String {
    format!("{prefix}g")
}

/// Statistics reuse metadata search semantics and a single SQLite read transaction.
/// No Git subprocess is launched here unless `query.exclude_tips` is non-empty. The callback runs
/// under the same watermark.
#[allow(clippy::too_many_arguments)]
pub(crate) fn with_stats_rows<T>(
    executable: Option<&Path>,
    store: &SessionStore,
    session: &session::RepositorySession,
    query: &SearchQuery,
    include_unmatched_graph: bool,
    cancelled: &AtomicBool,
    deadline: Instant,
    callback: impl FnOnce(
        Option<&Connection>,
        &SearchSnapshot,
        Vec<(CommitSummary, i64, bool)>,
    ) -> Result<T, IndexError>,
) -> Result<T, IndexError> {
    let (key, _) = metadata_index::snapshot_identity(session)?;
    let mut compiled = compile_query(query, session, &key)?;
    resolve_excluded_tips(executable, session, &mut compiled, cancelled, deadline)?;
    metadata_index::with_readonly_search_snapshot(
        store,
        session,
        metadata_index::configured_quota()?,
        0,
        cancelled,
        deadline,
        |connection, snapshot| {
            let mut commits = Vec::new();
            if let Some(connection) = connection {
                let indexed_oids = if let (Some(raw), Some(filter)) =
                    (compiled.path_bytes.as_deref(), compiled.query.path.as_ref())
                {
                    if !has_change_index(connection)? {
                        return Err(IndexError {
                            code: ErrorCode::IndexUnavailable,
                            message: "路径统计需要文件改动索引".into(),
                        });
                    }
                    let missing: i64 = connection
                        .query_row(
                            "SELECT count(*) FROM snapshot_commits s JOIN commits c ON c.oid=s.oid WHERE s.snapshot_key=?1 AND s.ordinal<?2 AND c.changes_complete<>1",
                            params![snapshot.snapshot_key, snapshot.watermark as i64],
                            |r| r.get(0),
                        )
                        .map_err(map_sql_error)?;
                    if missing > 0 {
                        return Err(IndexError {
                            code: ErrorCode::IndexUnavailable,
                            message: "当前覆盖的提交尚有文件记录未补完，请稍后重试路径统计".into(),
                        });
                    }
                    Some(query_indexed_path_oids(
                        connection, filter, raw, cancelled, deadline,
                    )?)
                } else {
                    None
                };
                let fts_query = if has_message_fts(connection)? {
                    fts_trigram_query(&compiled)
                } else {
                    None
                };
                let fts_oids = if include_unmatched_graph && let Some(fts_expr) = &fts_query {
                    let mut stmt = connection
                        .prepare_cached(
                            "SELECT c.oid FROM commit_message_fts(?1) f JOIN commits c ON c.rowid=f.rowid",
                        )
                        .map_err(map_sql_error)?;
                    let mut rows = stmt.query([fts_expr]).map_err(map_sql_error)?;
                    let mut set = HashSet::new();
                    let mut seen_rows = 0_u64;
                    while let Some(row) = rows.next().map_err(map_sql_error)? {
                        if seen_rows & 1023 == 0 {
                            check_active(cancelled, deadline)?;
                        }
                        seen_rows += 1;
                        set.insert(row.get::<_, String>(0).map_err(map_sql_error)?);
                    }
                    Some(set)
                } else {
                    None
                };
                let watermark = to_i64(snapshot.watermark)?;
                let (sql, bind_fts) = if include_unmatched_graph {
                    (SEARCH_SCAN_SQL, None)
                } else if let Some(fts_expr) = fts_query.as_deref() {
                    (SEARCH_FTS_FILTER_SQL, Some(fts_expr))
                } else {
                    (SEARCH_FILTER_SQL, None)
                };
                let mut statement = connection.prepare_cached(sql).map_err(map_sql_error)?;
                let mut rows = if let Some(fts_expr) = bind_fts {
                    statement.query(params![snapshot.snapshot_key, watermark, fts_expr])
                } else {
                    statement.query(params![snapshot.snapshot_key, watermark])
                }
                .map_err(map_sql_error)?;
                while let Some(row) = rows.next().map_err(map_sql_error)? {
                    check_active(cancelled, deadline)?;
                    if commits.len() >= 250_000 {
                        return Err(IndexError {
                            code: ErrorCode::ResourceLimit,
                            message: "统计上限为 250000 个已索引提交；请缩小浏览范围".into(),
                        });
                    }
                    let oid = row_str(row, 1)?;
                    if let Some(allowed) = &fts_oids
                        && !allowed.contains(oid)
                    {
                        commits.push((minimal_graph_summary(row)?, 0, false));
                        continue;
                    }
                    let key = matching_row_key(row, &compiled, cancelled, deadline)?;
                    let mut matched = key.is_some();
                    if matched && let Some(indexed_oids) = &indexed_oids {
                        matched = indexed_oids.contains(oid);
                    }
                    if matched {
                        let summary = if include_unmatched_graph {
                            summary_from_row(row)?
                        } else {
                            load_summary_by_oid(connection, oid)?
                        };
                        let timestamp = key.expect("matched key present").timestamp;
                        commits.push((summary, timestamp, true));
                    } else if include_unmatched_graph {
                        commits.push((minimal_graph_summary(row)?, 0, false));
                    }
                }
            }
            callback(connection, snapshot, commits)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use commitscope_core::{CommitIdentity, MetadataIndexCoverage, MetadataIndexStatus};
    use std::{
        fs,
        path::PathBuf,
        process::{Command, Output},
        sync::atomic::{AtomicU64, Ordering as AtomicOrdering},
    };

    static NEXT_REPO: AtomicU64 = AtomicU64::new(1);

    struct TestRepo(PathBuf);

    impl TestRepo {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "commitscope-path-search-{}-{}",
                std::process::id(),
                NEXT_REPO.fetch_add(1, AtomicOrdering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            git(&path, &["init", "-q"]);
            git(&path, &["config", "user.name", "Path Test"]);
            git(&path, &["config", "user.email", "path@example.test"]);
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git(path: &Path, args: &[&str]) -> Output {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    fn git_text(path: &Path, args: &[&str]) -> String {
        String::from_utf8(git(path, args).stdout)
            .unwrap()
            .trim_end()
            .to_owned()
    }

    fn commit_summary(oid: String, parents: Vec<String>) -> CommitSummary {
        CommitSummary {
            oid,
            parents,
            summary: "test".into(),
            summary_truncated: false,
            author: CommitIdentity {
                name: "Path Test".into(),
                email: "path@example.test".into(),
                timestamp: "1".into(),
                offset: "+0000".into(),
            },
            committer: CommitIdentity {
                name: "Path Test".into(),
                email: "path@example.test".into(),
                timestamp: "1".into(),
                offset: "+0000".into(),
            },
            text_lossy: false,
        }
    }

    fn query() -> CompiledQuery {
        CompiledQuery {
            key: "q".into(),
            query: SearchQuery {
                message: String::new(),
                case_sensitive: false,
                authors: Vec::new(),
                committers: Vec::new(),
                oid_prefix: String::new(),
                time_field: SearchTimeField::Committer,
                from_timestamp: None,
                to_timestamp: None,
                time_zone: "UTC".into(),
                path: None,
                exclude_tips: Vec::new(),
            },
            message_needle: String::new(),
            path_bytes: None,
            included_oids: None,
        }
    }

    fn search_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE snapshots(snapshot_key TEXT PRIMARY KEY);
                 CREATE TABLE snapshot_commits(snapshot_key TEXT, ordinal INTEGER, oid TEXT);
                 CREATE INDEX snapshot_commits_oid ON snapshot_commits(snapshot_key, oid);
                 CREATE TABLE commits(
                    oid TEXT PRIMARY KEY, author_timestamp TEXT, committer_timestamp TEXT,
                    author_name TEXT, author_email TEXT, committer_name TEXT, committer_email TEXT,
                    message TEXT, parents_json TEXT, summary TEXT, summary_truncated INTEGER,
                    author_offset TEXT, committer_offset TEXT, text_lossy INTEGER
                 );",
            )
            .unwrap();
        for (ordinal, oid, timestamp) in [
            (0, "a".repeat(40), "100"),
            (1, "b".repeat(40), "300"),
            (2, "c".repeat(40), "50"),
        ] {
            connection
                .execute(
                    "INSERT INTO commits VALUES(?1,?2,?2,'Author','a@example.test','Committer','c@example.test','message','[]','summary',0,'+0000','+0000',0)",
                    params![oid, timestamp],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO snapshot_commits VALUES('snapshot',?1,?2)",
                    params![ordinal, oid],
                )
                .unwrap();
        }
        connection
    }

    fn snapshot() -> SearchSnapshot {
        SearchSnapshot {
            snapshot_key: "snapshot".into(),
            file_identity: "file.epoch".into(),
            watermark: 3,
            complete: false,
            index_status: MetadataIndexStatus {
                snapshot_key: Some("snapshot".into()),
                state: commitscope_core::MetadataIndexState::Running,
                coverage: MetadataIndexCoverage {
                    processed: 3,
                    complete: false,
                },
                disk_bytes: 100,
                quota_bytes: 1000,
                error: None,
            },
        }
    }

    #[test]
    fn anchor_offset_uses_sort_order_when_scan_order_is_different() {
        let connection = search_connection();
        let snapshot = snapshot();
        let query = query();
        let cancelled = AtomicBool::new(false);
        let anchor = CandidateKey {
            timestamp: 50,
            oid: "c".repeat(40),
        };
        let page = collect_page(
            None,
            None,
            Some(&connection),
            &snapshot,
            &query,
            2,
            None,
            Some(anchor),
            true,
            &cancelled,
            Instant::now() + std::time::Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(page.page_offset, 2);
        assert_eq!(page.matched_count, 3);
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].oid, "c".repeat(40));
        assert_eq!(page.anchor_found, Some(true));
    }

    #[test]
    fn oid_prefix_range_keeps_snapshot_watermark_and_combined_filters() {
        let connection = search_connection();
        let candidates = [
            (
                3,
                "abcd000000000000000000000000000000000000",
                "Needle",
                "400",
                "Keep this",
            ),
            (
                4,
                "abcd100000000000000000000000000000000000",
                "Other",
                "400",
                "Keep this",
            ),
            (
                5,
                "abcd200000000000000000000000000000000000",
                "Needle",
                "400",
                "Keep this",
            ),
        ];
        for (ordinal, oid, author, timestamp, message) in candidates {
            connection
                .execute(
                    "INSERT INTO commits VALUES(?1,?2,?2,?3,'a@example.test','Committer','c@example.test',?4,'[]','summary',0,'+0000','+0000',0)",
                    params![oid, timestamp, author, message],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO snapshot_commits VALUES('snapshot',?1,?2)",
                    params![ordinal, oid],
                )
                .unwrap();
        }

        let mut compiled = query();
        compiled.query.oid_prefix = "abcd".into();
        compiled.query.authors = vec![commitscope_core::SearchIdentity {
            name: "Needle".into(),
            email: "a@example.test".into(),
        }];
        compiled.query.from_timestamp = Some(350);
        compiled.query.to_timestamp = Some(450);
        compiled.message_needle = "keep".into();
        let mut snapshot = snapshot();
        snapshot.watermark = 5;

        let page = collect_page(
            None,
            None,
            Some(&connection),
            &snapshot,
            &compiled,
            10,
            None,
            None,
            false,
            &AtomicBool::new(false),
            Instant::now() + std::time::Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(page.matched_count, 1);
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].oid, candidates[0].1);
    }

    #[test]
    fn message_matching_keeps_ascii_fast_path_and_unicode_casefold() {
        fn matches(message: &str, needle: &str) -> bool {
            let connection = Connection::open_in_memory().unwrap();
            let compiled = CompiledQuery {
                message_needle: default_case_fold_str(needle),
                ..query()
            };
            let mut statement = connection
                .prepare(
                    "SELECT 0,'oid','1','1','a','a','c','c',?1,'[]','summary',0,'+0000','+0000',0",
                )
                .unwrap();
            let mut rows = statement.query([message]).unwrap();
            message_matches(rows.next().unwrap().unwrap(), &compiled).unwrap()
        }

        assert!(matches("A FAST ASCII Message", "fast ascii"));
        assert!(matches("fix: 修复中文 Bug 描述", "fix"));
        assert!(matches("fix: 修复中文 Bug 描述", "BUG"));
        assert!(!matches("修复内存问题（测试）", "fix"));
        assert!(matches("Straße ος", "STRASSE"));
        assert!(matches("ﬁx the bug", "FIX"));
        assert!(matches("Straße ος", "ΟΣ"));
        assert!(!matches("A FAST ASCII Message", "slow"));

        for ch in ('\u{3000}'..='\u{303F}').chain('\u{3400}'..='\u{9FFF}') {
            let mut buf = [0u8; 4];
            let s: &str = ch.encode_utf8(&mut buf);
            assert_eq!(default_case_fold_str(s), s);
        }
    }

    #[test]
    fn git_path_filter_matches_root_deletion_and_only_second_merge_parent() {
        let repo = TestRepo::new();
        git(repo.path(), &["checkout", "-q", "-b", "main"]);
        fs::write(repo.path().join("wild[*].txt"), "root\n").unwrap();
        fs::create_dir_all(repo.path().join("dir")).unwrap();
        fs::write(repo.path().join("dir/deleted.txt"), "delete me\n").unwrap();
        fs::write(repo.path().join("merge.txt"), "base\n").unwrap();
        git(repo.path(), &["add", "-A"]);
        git(repo.path(), &["commit", "-q", "-m", "root"]);
        let root = git_text(repo.path(), &["rev-parse", "HEAD"]);

        fs::remove_file(repo.path().join("dir/deleted.txt")).unwrap();
        git(repo.path(), &["add", "-A"]);
        git(repo.path(), &["commit", "-q", "-m", "delete"]);
        let deleted = git_text(repo.path(), &["rev-parse", "HEAD"]);

        git(repo.path(), &["checkout", "-q", "-b", "side", &root]);
        fs::write(repo.path().join("merge.txt"), "side version\n").unwrap();
        git(repo.path(), &["add", "merge.txt"]);
        git(repo.path(), &["commit", "-q", "-m", "side"]);
        let side = git_text(repo.path(), &["rev-parse", "HEAD"]);

        git(repo.path(), &["checkout", "-q", "main"]);
        let tree = git_text(repo.path(), &["rev-parse", "main^{tree}"]);
        let mut child = Command::new("git")
            .arg("-C")
            .arg(repo.path())
            .args(["commit-tree", &tree, "-p", &deleted, "-p", &side])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child.stdin.take().unwrap().write_all(b"merge\n").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let merge = String::from_utf8(output.stdout).unwrap().trim().to_owned();

        let executable = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|directory| directory.join("git"))
            .find(|candidate| candidate.is_file())
            .unwrap();
        let run = |filter: SearchPathFilter, raw_path: &[u8], commits: Vec<CommitSummary>| {
            path_indices_for_commits(
                &executable,
                repo.path(),
                &filter,
                raw_path,
                &commits,
                false,
                &AtomicBool::new(false),
                Instant::now() + std::time::Duration::from_secs(5),
            )
            .unwrap()
        };
        let special = b"wild[*].txt";
        assert_eq!(
            run(
                SearchPathFilter {
                    raw_hex: hex(special),
                    kind: SearchPathKind::File,
                    include_descendants: false,
                },
                special,
                vec![commit_summary(root.clone(), Vec::new())]
            ),
            vec![vec![None]]
        );
        assert_eq!(
            run(
                SearchPathFilter {
                    raw_hex: hex(b"dir/deleted.txt"),
                    kind: SearchPathKind::File,
                    include_descendants: false,
                },
                b"dir/deleted.txt",
                vec![commit_summary(deleted.clone(), vec![root])]
            ),
            vec![vec![Some(0)]]
        );
        assert_eq!(
            run(
                SearchPathFilter {
                    raw_hex: hex(b"merge.txt"),
                    kind: SearchPathKind::File,
                    include_descendants: false,
                },
                b"merge.txt",
                vec![commit_summary(merge, vec![deleted, side])]
            ),
            vec![vec![Some(1)]]
        );
    }

    #[test]
    fn directory_matching_and_completion_keep_raw_path_boundaries() {
        let directory = SearchPathFilter {
            raw_hex: hex(b"src"),
            kind: SearchPathKind::Directory,
            include_descendants: false,
        };
        assert!(path_matches(&directory, b"src", b"src/main.rs"));
        assert!(!path_matches(&directory, b"src", b"src/nested/lib.rs"));
        assert!(!path_matches(&directory, b"src", b"src-old/main.rs"));
        let recursive = SearchPathFilter {
            include_descendants: true,
            ..directory
        };
        assert!(path_matches(&recursive, b"src", b"src/nested/lib.rs"));

        let mut entries = BTreeSet::new();
        let mut truncated = false;
        insert_path_suggestion(&mut entries, b"src/main.rs".to_vec(), 0, 1, &mut truncated);
        insert_path_suggestion(&mut entries, b"src/lib.rs".to_vec(), 0, 1, &mut truncated);
        assert!(truncated);
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn activity_days_past_the_limit_keep_the_newest() {
        let mut days = BTreeMap::new();
        let mut truncated = false;
        for day in [
            "2024-01-03",
            "2024-01-01",
            "2024-01-02",
            "2024-01-04",
            "2024-01-03",
            "2023-12-31",
        ] {
            increment_bounded(&mut days, day.to_owned(), 3, Keep::Highest, &mut truncated).unwrap();
        }
        assert!(truncated);
        assert_eq!(
            days.into_iter().collect::<Vec<_>>(),
            vec![
                ("2024-01-02".to_owned(), 1),
                ("2024-01-03".to_owned(), 2),
                ("2024-01-04".to_owned(), 1)
            ]
        );
    }

    #[test]
    fn activity_buckets_use_iana_dst_and_raw_author_identity() {
        let timezone = "America/Los_Angeles".parse::<chrono_tz::Tz>().unwrap();
        let mut matched = 0;
        let mut days = BTreeMap::new();
        let mut authors = BTreeMap::new();
        let mut days_truncated = false;
        let mut authors_truncated = false;
        for (time, name, email) in [
            ("2026-03-08T07:30:00Z", "A", "a@example.test"),
            ("2026-03-08T08:30:00Z", "A", "a@example.test"),
            ("2026-03-08T08:30:00Z", "a", "a@example.test"),
        ] {
            let timestamp = chrono::DateTime::parse_from_rfc3339(time)
                .unwrap()
                .timestamp();
            record_activity(
                timestamp,
                name.into(),
                email.into(),
                &timezone,
                &mut matched,
                &mut days,
                &mut authors,
                &mut days_truncated,
                &mut authors_truncated,
            )
            .unwrap();
        }
        assert_eq!(matched, 3);
        assert_eq!(days.get("2026-03-07"), Some(&1));
        assert_eq!(days.get("2026-03-08"), Some(&2));
        assert_eq!(
            authors.get(&("A".into(), "a@example.test".into())),
            Some(&2)
        );
        assert_eq!(
            authors.get(&("a".into(), "a@example.test".into())),
            Some(&1)
        );
    }

    #[test]
    fn cursor_worst_case_fits_the_protocol_limits_and_roundtrips() {
        let cursor = SearchCursor {
            query_key: "f".repeat(64),
            snapshot_key: "a".repeat(64),
            file_identity: "0123456789abcdef.0123456789abcdef.18446744073709551615".into(),
            watermark: u64::MAX,
            complete: true,
            page_size: 500,
            direction: CursorDirection::Previous,
            timestamp: i64::MIN,
            oid: "f".repeat(64),
        };
        let encoded = encode_cursor(cursor);
        assert!(encoded.len() <= MAX_CURSOR_BYTES);
        let decoded = decode_cursor(&encoded).unwrap();
        assert_eq!(decoded.query_key.len(), 64);
        assert_eq!(decoded.snapshot_key.len(), 64);
        assert_eq!(decoded.watermark, u64::MAX);
        assert_eq!(decoded.timestamp, i64::MIN);
        assert_eq!(decoded.oid, "f".repeat(64));
        assert!(URL_SAFE_NO_PAD.decode(&encoded[3..]).unwrap().len() <= MAX_CURSOR_PAYLOAD_BYTES);
    }

    #[test]
    fn identity_search_uses_default_unicode_case_folding() {
        assert!(identity_matches("strasse", "Straße", "x@example.test"));
        assert!(identity_matches("οσ", "ΟΣ", "x@example.test"));
        assert!(!identity_matches("é", "e\u{301}", "x@example.test"));
    }

    #[test]
    fn exclude_tips_validation_normalization_and_row_filtering() {
        let oid_a = "A".repeat(40);
        let oid_b = "b".repeat(40);
        let mut compiled = query();
        compiled.query.exclude_tips = vec![oid_b.clone(), oid_a.clone(), oid_b.to_uppercase()];
        validate_query(&compiled.query, 40).expect("valid hex OIDs pass");

        let mut bad = compiled.query.clone();
        bad.exclude_tips.push("short".into());
        assert_eq!(
            validate_query(&bad, 40).unwrap_err().code,
            ErrorCode::InvalidRequest
        );

        compiled.included_oids = Some(Arc::new(HashSet::from(["c".repeat(40)])));
        let connection = Connection::open_in_memory().unwrap();
        let mut matched_stmt = connection
            .prepare("SELECT 0,?1,'1','1','a','a','c','c','msg','[]','summary',0,'+0000','+0000',0")
            .unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(1);
        let cancelled = AtomicBool::new(false);

        let mut excluded_rows = matched_stmt.query([oid_b.as_str()]).unwrap();
        assert!(
            matching_row_key(
                excluded_rows.next().unwrap().unwrap(),
                &compiled,
                &cancelled,
                deadline
            )
            .unwrap()
            .is_none()
        );
        drop(excluded_rows);

        let c_oid = "c".repeat(40);
        let mut included_rows = matched_stmt.query([c_oid.as_str()]).unwrap();
        assert!(
            matching_row_key(
                included_rows.next().unwrap().unwrap(),
                &compiled,
                &cancelled,
                deadline
            )
            .unwrap()
            .is_some()
        );
    }

    #[test]
    fn fast_ascii_case_insensitive_search_and_i64_parser_handle_boundaries() {
        assert!(contains_ascii_case_insensitive(b"anything", b""));
        assert!(contains_ascii_case_insensitive(b"", b""));
        assert!(!contains_ascii_case_insensitive(b"a", b"ab"));
        assert!(contains_ascii_case_insensitive(b"Fix", b"f"));
        assert!(contains_ascii_case_insensitive(b"xFz", b"f"));
        assert!(!contains_ascii_case_insensitive(b"xyz", b"f"));
        assert!(contains_ascii_case_insensitive(b"FiX", b"fix"));
        assert!(contains_ascii_case_insensitive(b"prefix FIX", b"fix"));
        assert!(contains_ascii_case_insensitive(b"Fix: trailing", b"fix"));
        assert!(!contains_ascii_case_insensitive(b"f_x", b"fix"));
        assert!(contains_ascii_case_insensitive(b"fxFix", b"fix"));

        assert_eq!(parse_i64_fast(b"0"), Some(0));
        assert_eq!(parse_i64_fast(b"1700000000"), Some(1_700_000_000));
        assert_eq!(parse_i64_fast(b"-42"), Some(-42));
        assert_eq!(parse_i64_fast(b"+7"), Some(7));
        assert_eq!(parse_i64_fast(b""), None);
        assert_eq!(parse_i64_fast(b"-"), None);
        assert_eq!(parse_i64_fast(b"12a"), None);
        assert_eq!(parse_i64_fast(b"99999999999999999999"), None);
    }

    #[test]
    fn fts_trigram_candidate_index_preserves_unicode_casefold_quotes_and_case_sensitivity() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "trusted_schema", "OFF")
            .unwrap();
        connection
            .execute_batch(
                "CREATE TABLE commits(oid TEXT PRIMARY KEY, author_timestamp TEXT NOT NULL, committer_timestamp TEXT NOT NULL, author_name TEXT NOT NULL, author_email TEXT NOT NULL, committer_name TEXT NOT NULL, committer_email TEXT NOT NULL, message TEXT NOT NULL);
                 CREATE TABLE snapshot_commits(snapshot_key TEXT NOT NULL, ordinal INTEGER NOT NULL, oid TEXT NOT NULL, PRIMARY KEY(snapshot_key, ordinal)) WITHOUT ROWID;
                 CREATE UNIQUE INDEX snapshot_commits_oid ON snapshot_commits(snapshot_key, oid);
                 CREATE VIRTUAL TABLE commit_message_fts USING fts5(folded_message, content='', columnsize=0, tokenize='trigram case_sensitive 1');
                 CREATE TABLE index_meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID;
                 INSERT INTO index_meta(key, value) VALUES('message_fts_rowid', 3);",
            )
            .unwrap();
        connection
            .pragma_update(None, "user_version", 2_i32)
            .unwrap();
        let samples = [
            ("1".repeat(40), "Die Straße ist lang"),
            ("2".repeat(40), "TURKISH İ TEST"),
            ("3".repeat(40), "quote \"in\" msg"),
            ("4".repeat(40), "Uppercase Match Only"),
        ];
        for (idx, (oid, msg)) in samples.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO commits VALUES(?1,'10','10','a','a','c','c',?2)",
                    params![oid, msg],
                )
                .unwrap();
            let rowid = connection.last_insert_rowid();
            connection
                .execute(
                    "INSERT INTO commit_message_fts(rowid, folded_message) VALUES(?1,?2)",
                    params![rowid, default_case_fold_str(msg)],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO snapshot_commits VALUES('snap', ?1, ?2)",
                    params![idx as i64, oid],
                )
                .unwrap();
        }
        assert!(!has_message_fts(&connection).unwrap());
        connection
            .execute(
                "INSERT OR REPLACE INTO index_meta(key, value) VALUES('message_fts_rowid', 4)",
                [],
            )
            .unwrap();
        assert!(has_message_fts(&connection).unwrap());

        let deadline = Instant::now() + std::time::Duration::from_secs(1);
        let cancelled = AtomicBool::new(false);
        let run_msg = |msg: &str, case_sensitive: bool| -> Vec<String> {
            let mut compiled = query();
            compiled.query.message = msg.into();
            compiled.query.case_sensitive = case_sensitive;
            compiled.message_needle = if case_sensitive {
                msg.into()
            } else {
                default_case_fold_str(msg)
            };
            let fts_expr = fts_trigram_query(&compiled);
            if msg.chars().count() >= 3 {
                assert!(fts_expr.is_some());
            } else {
                assert!(fts_expr.is_none());
            }
            let sql = select_scan_sql(false, fts_expr.is_some(), "");
            let mut stmt = connection.prepare_cached(sql).unwrap();
            let mut rows = if let Some(expr) = &fts_expr {
                stmt.query(params!["snap", 10_i64, expr]).unwrap()
            } else {
                stmt.query(params!["snap", 10_i64]).unwrap()
            };
            let mut matched = Vec::new();
            while let Some(row) = rows.next().unwrap() {
                if let Some(key) = matching_row_key(row, &compiled, &cancelled, deadline).unwrap() {
                    matched.push(key.oid);
                }
            }
            matched
        };

        assert_eq!(run_msg("STRASSE", false), vec!["1".repeat(40)]);
        assert!(run_msg("STRASSE", true).is_empty());
        assert_eq!(run_msg("turkish i", false), vec!["2".repeat(40)]);
        assert_eq!(run_msg("quote \"in\" msg", false), vec!["3".repeat(40)]);
        assert!(run_msg("match", true).is_empty());
        assert_eq!(run_msg("Match", true), vec!["4".repeat(40)]);
        assert_eq!(run_msg("la", false), vec!["1".repeat(40)]);
        assert!(run_msg("never_present_token", false).is_empty());
    }
}
