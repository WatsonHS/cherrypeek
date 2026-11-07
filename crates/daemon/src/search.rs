use crate::{
    metadata_index::{self, IndexError, SearchSnapshot},
    session,
    session_store::SessionStore,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use caseless::default_case_fold_str;
use commitscope_core::{
    CommitIdentity, CommitSummary, ErrorCode, MetadataIndexCoverage, SearchCommitsParams,
    SearchIdentities, SearchIdentitiesParams, SearchIdentity, SearchPage, SearchQuery,
    SearchTimeField,
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::{Ordering, Reverse},
    collections::{BTreeSet, BinaryHeap},
    sync::atomic::{AtomicBool, Ordering as AtomicOrdering},
    time::Instant,
};

const MAX_CURSOR_BYTES: usize = 1024;
const MAX_CURSOR_PAYLOAD_BYTES: usize = 512;
const MAX_IDENTITIES: usize = 100;
const JS_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone)]
struct CompiledQuery {
    key: String,
    query: SearchQuery,
    message_needle: String,
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
    summary: CommitSummary,
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
    let compiled = compile_query(&params.query, session, &snapshot_key)?;
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
                        connection,
                        &page_snapshot,
                        &compiled,
                        &cursor.oid,
                        cancelled,
                        deadline,
                    )?
                    .filter(|key| key.timestamp == cursor.timestamp),
                ),
                (None, Some(anchor_oid)) => Some(find_matching_key(
                    connection,
                    &page_snapshot,
                    &compiled,
                    anchor_oid,
                    cancelled,
                    deadline,
                )?),
                (None, None) => None,
            };
            if cursor.is_some() && boundary.as_ref().is_none_or(Option::is_none) {
                return Err(invalid_cursor());
            }
            collect_page(
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

#[allow(clippy::too_many_arguments)]
fn collect_page(
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
    if let Some(boundary) = &boundary
        && cursor.is_none()
    {
        anchor_found = Some(true);
        let _ = boundary;
    }
    if let Some(connection) = connection {
        let mut statement = connection.prepare(SEARCH_SCAN_SQL).map_err(map_sql_error)?;
        let mut rows = statement
            .query(params![snapshot.snapshot_key, to_i64(snapshot.watermark)?])
            .map_err(map_sql_error)?;
        while let Some(row) = rows.next().map_err(map_sql_error)? {
            check_active(cancelled, deadline)?;
            let Some(key) = matching_row_key(row, compiled, cancelled, deadline)? else {
                continue;
            };
            let relation = boundary
                .as_ref()
                .map(|boundary| key.compare_order(boundary))
                .unwrap_or(Ordering::Greater);
            if relation == Ordering::Equal {
                boundary_seen = true;
                if cursor.is_none() {
                    anchor_found = Some(true);
                }
            }
            if relation == Ordering::Less {
                before_boundary = before_boundary.saturating_add(1);
            }
            matched_count = matched_count
                .checked_add(1)
                .ok_or_else(|| invalid_request("Search match count overflow"))?;
            let selected = match cursor.map(|cursor| cursor.direction) {
                Some(CursorDirection::Next) => relation == Ordering::Greater,
                Some(CursorDirection::Previous) => relation == Ordering::Less,
                None if boundary.is_some() => relation != Ordering::Less,
                None => true,
            };
            if !selected {
                continue;
            }
            let candidate_key = CandidateKey {
                timestamp: key.timestamp,
                oid: key.oid.clone(),
            };
            let previous =
                cursor.is_some_and(|cursor| cursor.direction == CursorDirection::Previous);
            let should_keep = if previous {
                can_keep_latest(&backward, &candidate_key, capacity)
            } else {
                can_keep_earliest(&forward, &candidate_key, capacity)
            };
            if should_keep {
                let candidate = Candidate {
                    timestamp: key.timestamp,
                    oid: key.oid,
                    summary: summary_from_row(row)?,
                };
                if previous {
                    keep_latest(&mut backward, candidate, capacity);
                } else {
                    keep_earliest(&mut forward, candidate, capacity);
                }
            }
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
    let result_version = result_version(compiled, snapshot);
    Ok(SearchPage {
        query_key: compiled.key.clone(),
        snapshot_key: snapshot.snapshot_key.clone(),
        result_version,
        commits: candidates
            .drain(..)
            .map(|candidate| candidate.summary)
            .collect(),
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
    let oid: String = row.get(1).map_err(map_sql_error)?;
    let author_timestamp: String = row.get(2).map_err(map_sql_error)?;
    let committer_timestamp: String = row.get(3).map_err(map_sql_error)?;
    let author_name: String = row.get(4).map_err(map_sql_error)?;
    let author_email: String = row.get(5).map_err(map_sql_error)?;
    let committer_name: String = row.get(6).map_err(map_sql_error)?;
    let committer_email: String = row.get(7).map_err(map_sql_error)?;
    if !identity_field_matches(&compiled.query.authors, &author_name, &author_email)
        || !identity_field_matches(
            &compiled.query.committers,
            &committer_name,
            &committer_email,
        )
        || !oid.starts_with(&compiled.query.oid_prefix)
    {
        return Ok(None);
    }
    let timestamp_text = match compiled.query.time_field {
        SearchTimeField::Author => &author_timestamp,
        SearchTimeField::Committer => &committer_timestamp,
    };
    let timestamp = timestamp_text
        .parse::<i64>()
        .map_err(|_| corrupt_index("Indexed commit timestamp is invalid"))?;
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
    Ok(Some(CandidateKey { timestamp, oid }))
}

fn message_matches(row: &rusqlite::Row<'_>, compiled: &CompiledQuery) -> Result<bool, IndexError> {
    if compiled.message_needle.is_empty() {
        return Ok(true);
    }
    let message: String = row.get(8).map_err(map_sql_error)?;
    Ok(if compiled.query.case_sensitive {
        message.contains(&compiled.message_needle)
    } else {
        default_case_fold_str(&message).contains(&compiled.message_needle)
    })
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
    connection: Option<&Connection>,
    snapshot: &SearchSnapshot,
    compiled: &CompiledQuery,
    oid: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<CandidateKey>, IndexError> {
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
    matching_row_key(row, compiled, cancelled, deadline)
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
    })
}

fn validate_query(query: &SearchQuery, oid_length: usize) -> Result<(), IndexError> {
    if query.message.len() > 4096
        || query.authors.len() > 50
        || query.committers.len() > 50
        || query.time_zone.len() > 128
        || query
            .authors
            .iter()
            .chain(&query.committers)
            .any(|identity| identity.name.len() > 4096 || identity.email.len() > 4096)
    {
        return Err(invalid_request("Search query exceeds a field limit"));
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
const SEARCH_ONE_SQL: &str = "SELECT s.ordinal,c.oid,c.author_timestamp,c.committer_timestamp,c.author_name,c.author_email,c.committer_name,c.committer_email,c.message,c.parents_json,c.summary,c.summary_truncated,c.author_offset,c.committer_offset,c.text_lossy FROM snapshot_commits s JOIN commits c ON c.oid=s.oid WHERE s.snapshot_key=?1 AND s.ordinal<?2 AND c.oid=?3 LIMIT 1";

#[cfg(test)]
mod tests {
    use super::*;
    use commitscope_core::{MetadataIndexCoverage, MetadataIndexStatus};

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
            },
            message_needle: String::new(),
        }
    }

    fn search_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE snapshots(snapshot_key TEXT PRIMARY KEY);
                 CREATE TABLE snapshot_commits(snapshot_key TEXT, ordinal INTEGER, oid TEXT);
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
}
