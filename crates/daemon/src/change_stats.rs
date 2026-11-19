//! File statistics and per-repository exclusion preferences. No operation-mode Git runner.
use crate::{
    metadata_index::{IndexError, SearchSnapshot},
    session::RepositorySession,
    session_store::SessionStore,
    stats::{active, bucket_grid, bucket_start, error},
};
use chrono_tz::Tz;
use commitscope_core::*;
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Instant,
};
const DEFAULTS: &[&str] = &[
    "pnpm-lock.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "Cargo.lock",
    "Gemfile.lock",
    "poetry.lock",
    "Pipfile.lock",
    "uv.lock",
    "composer.lock",
    "go.sum",
    "bun.lock",
    "bun.lockb",
    "Package.resolved",
];
fn sql(e: rusqlite::Error) -> IndexError {
    error(
        ErrorCode::IndexCorrupt,
        &format!("文件统计索引读取失败：{e}"),
    )
}
fn exclusion_path(session: &RepositorySession) -> Result<PathBuf, IndexError> {
    let root = SessionStore::from_env()
        .metadata_cache_root(&session.discovered.info)
        .map_err(|_| error(ErrorCode::IndexUnavailable, "应用数据目录不可用"))?;
    let key = session
        .info
        .repository_key
        .strip_prefix("sha256:")
        .ok_or_else(|| error(ErrorCode::IndexUnavailable, "仓库标识无效"))?;
    if !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(error(ErrorCode::IndexUnavailable, "仓库标识无效"));
    }
    Ok(root.join(format!("stats-exclusions-{key}.json")))
}
pub fn exclusions(session: &RepositorySession) -> Result<StatsExclusions, IndexError> {
    let path = exclusion_path(session)?;
    let patterns = match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            DEFAULTS.iter().map(|s| s.to_string()).collect()
        }
        Ok(m) if m.is_file() && !m.file_type().is_symlink() && m.len() <= 65536 => {
            serde_json::from_slice::<Vec<String>>(
                &fs::read(&path)
                    .map_err(|_| error(ErrorCode::IndexUnavailable, "排除列表不可读"))?,
            )
            .map_err(|_| error(ErrorCode::IndexCorrupt, "排除列表格式错误"))?
        }
        _ => return Err(error(ErrorCode::IndexUnavailable, "排除列表路径不安全")),
    };
    validate_patterns(&patterns)?;
    Ok(StatsExclusions {
        patterns,
        defaults: DEFAULTS.iter().map(|s| s.to_string()).collect(),
    })
}
fn validate_patterns(patterns: &[String]) -> Result<(), IndexError> {
    if patterns.len() > 100
        || patterns.iter().any(|p| {
            p.is_empty()
                || p.len() > 1024
                || p.contains('\0')
                || p.starts_with('/')
                || p.split('/').any(|s| s == "..")
        })
    {
        return Err(error(
            ErrorCode::InvalidRequest,
            "排除列表最多 100 项，每项 1024 字节，不接受绝对路径或 ..",
        ));
    }
    for p in patterns {
        if let Some(hex) = p.strip_prefix("hex:") {
            crate::change_index::decode_hex(hex)?;
        }
    }
    Ok(())
}
pub fn set_exclusions(
    session: &RepositorySession,
    params: &SetStatsExclusionsParams,
) -> Result<StatsExclusions, IndexError> {
    validate_patterns(&params.patterns)?;
    let path = exclusion_path(session)?;
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink() || !m.is_file()) {
        return Err(error(ErrorCode::IndexUnavailable, "排除列表路径不安全"));
    }
    let tmp = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        crate::details::now_unix_ms()
    ));
    let data = serde_json::to_vec(&params.patterns)
        .map_err(|_| error(ErrorCode::InvalidRequest, "排除列表编码失败"))?;
    if data.len() > 65536 {
        return Err(error(
            ErrorCode::InvalidRequest,
            "排除列表编码后超过 64 KiB",
        ));
    }
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(&data)?;
        file.sync_all()?;
        fs::rename(&tmp, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        return Err(error(ErrorCode::IndexUnavailable, "保存排除列表失败"));
    }
    exclusions(session)
}
pub(crate) fn excluded(path: &[u8], patterns: &[String]) -> bool {
    patterns.iter().any(|p| {
        if let Some(hex) = p.strip_prefix("hex:") {
            return crate::change_index::decode_hex(hex).is_ok_and(|v| v == path);
        }
        let bytes = p.as_bytes();
        if p.ends_with('/') {
            path.starts_with(bytes)
        } else if p.contains('/') {
            path == bytes
        } else {
            path.rsplit(|b| *b == b'/').next() == Some(bytes)
        }
    })
}
pub(crate) fn kind(path: &[u8]) -> u8 {
    let components: Vec<_> = path.split(|b| *b == b'/').collect();
    let file = components.last().copied().unwrap_or_default();
    if components[..components.len().saturating_sub(1)]
        .iter()
        .any(|p| [b"test".as_slice(), b"tests", b"__tests__", b"spec"].contains(p))
        || [b".test.".as_slice(), b".spec.", b"_test."]
            .iter()
            .any(|s| file.windows(s.len()).any(|w| w == *s))
    {
        1
    } else if file.ends_with(b".md") || components.first() == Some(&b"docs".as_slice()) {
        2
    } else {
        0
    }
}
fn top_directory(path: &[u8]) -> Vec<u8> {
    path.iter()
        .position(|b| *b == b'/')
        .map(|p| path[..p].to_vec())
        .unwrap_or_default()
}
fn under(path: &[u8], prefix: &[u8]) -> bool {
    prefix.is_empty()
        || path == prefix
        || (path.starts_with(prefix) && path.get(prefix.len()) == Some(&b'/'))
}
#[derive(Clone)]
pub(crate) struct Change {
    pub path: Vec<u8>,
    pub old_path: Option<Vec<u8>>,
    pub status: u8,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
}
pub(crate) struct Record {
    pub commit: CommitSummary,
    pub time: i64,
    pub changes: Vec<Change>,
}
const CHANGES_BATCH_SIZE: usize = 64;
const CHANGES_BATCH_SQL: &str = "SELECT oid,path,old_path,status,additions,deletions,binary FROM commit_changes WHERE oid IN (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38,?39,?40,?41,?42,?43,?44,?45,?46,?47,?48,?49,?50,?51,?52,?53,?54,?55,?56,?57,?58,?59,?60,?61,?62,?63,?64) ORDER BY oid,ordinal";

fn decode_change_row(r: &rusqlite::Row<'_>) -> Result<Change, IndexError> {
    Ok(Change {
        path: r.get(1).map_err(sql)?,
        old_path: r.get(2).map_err(sql)?,
        status: r
            .get_ref(3)
            .map_err(sql)?
            .as_bytes()
            .map_err(|_| error(ErrorCode::IndexCorrupt, "改动状态编码无效"))?
            .first()
            .copied()
            .unwrap_or(b'M'),
        additions: r
            .get::<_, Option<i64>>(4)
            .map_err(sql)?
            .unwrap_or(0)
            .try_into()
            .map_err(|_| error(ErrorCode::IndexCorrupt, "负行数"))?,
        deletions: r
            .get::<_, Option<i64>>(5)
            .map_err(sql)?
            .unwrap_or(0)
            .try_into()
            .map_err(|_| error(ErrorCode::IndexCorrupt, "负行数"))?,
        binary: r.get(6).map_err(sql)?,
    })
}

fn visit_records(
    connection: Option<&Connection>,
    snapshot: &SearchSnapshot,
    rows: Vec<(CommitSummary, i64, bool)>,
    range: &StatsRange,
    cancelled: &AtomicBool,
    deadline: Instant,
    mut visitor: impl FnMut(usize, CommitSummary, i64, &[Change]) -> Result<(), IndexError>,
) -> Result<MetadataIndexCoverage, IndexError> {
    let Some(db) = connection else {
        return Ok(MetadataIndexCoverage {
            processed: 0,
            complete: false,
        });
    };
    let version: i32 = db
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(sql)?;
    if version < 2 {
        return Ok(MetadataIndexCoverage {
            processed: 0,
            complete: false,
        });
    }
    let processed_i64: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM snapshot_commits s JOIN commits c ON s.oid=c.oid WHERE s.snapshot_key=?1 AND s.ordinal<?2 AND c.changes_complete=1",
            params![snapshot.snapshot_key, snapshot.watermark as i64],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let processed = u64::try_from(processed_i64).unwrap_or(0);
    let coverage = MetadataIndexCoverage {
        processed,
        complete: snapshot.complete && processed == snapshot.watermark,
    };
    let mut eligible = Vec::new();
    for (orig_idx, (commit, time, matched)) in rows.into_iter().enumerate() {
        active(cancelled, deadline)?;
        if matched && time >= range.start_unix && time < range.end_unix {
            eligible.push((orig_idx, commit, time));
        }
    }
    if eligible.is_empty() {
        return Ok(coverage);
    }
    eligible.sort_by(|a, b| a.1.oid.cmp(&b.1.oid));

    let all_complete = processed == snapshot.watermark;
    let mut check_stmt = if all_complete {
        None
    } else {
        Some(
            db.prepare_cached("SELECT changes_complete FROM commits WHERE oid=?1")
                .map_err(sql)?,
        )
    };
    let mut batch_changes_stmt = db.prepare_cached(CHANGES_BATCH_SQL).map_err(sql)?;
    let mut count = 0usize;
    let mut iter = eligible.into_iter();
    let mut chunk_commits = Vec::with_capacity(CHANGES_BATCH_SIZE);
    let mut ready = Vec::with_capacity(CHANGES_BATCH_SIZE);
    let mut changes_buf = Vec::new();
    loop {
        active(cancelled, deadline)?;
        chunk_commits.clear();
        chunk_commits.extend(iter.by_ref().take(CHANGES_BATCH_SIZE));
        if chunk_commits.is_empty() {
            break;
        }
        ready.clear();
        if let Some(stmt) = check_stmt.as_mut() {
            for (orig_idx, commit, time) in chunk_commits.drain(..) {
                let complete_flag: Option<i64> = stmt
                    .query_row([&commit.oid], |r| r.get(0))
                    .optional()
                    .map_err(sql)?;
                if complete_flag == Some(1) {
                    ready.push((orig_idx, commit, time));
                }
            }
        } else {
            ready.append(&mut chunk_commits);
        }
        if ready.is_empty() {
            continue;
        }
        let mut bind_oids = [""; CHANGES_BATCH_SIZE];
        for (slot, (_, commit, _)) in ready.iter().enumerate() {
            bind_oids[slot] = commit.oid.as_str();
        }
        let mut q = batch_changes_stmt
            .query(rusqlite::params_from_iter(bind_oids.iter().copied()))
            .map_err(sql)?;
        let mut pending_row: Option<(String, Change)> = None;
        for (orig_idx, commit, time) in ready.drain(..) {
            changes_buf.clear();
            loop {
                if let Some((row_oid, _)) = &pending_row {
                    match row_oid.as_str().cmp(commit.oid.as_str()) {
                        std::cmp::Ordering::Less => {
                            pending_row = None;
                        }
                        std::cmp::Ordering::Equal => {
                            let (_, change) = pending_row.take().expect("checked pending row");
                            changes_buf.push(change);
                        }
                        std::cmp::Ordering::Greater => break,
                    }
                    continue;
                }
                let Some(r) = q.next().map_err(sql)? else {
                    break;
                };
                active(cancelled, deadline)?;
                count += 1;
                if count > 2_000_000 {
                    return Err(error(
                        ErrorCode::ResourceLimit,
                        "文件记录超过 2000000，未返回不完整排名",
                    ));
                }
                let row_oid: String = r.get(0).map_err(sql)?;
                let change = decode_change_row(r)?;
                pending_row = Some((row_oid, change));
            }
            visitor(orig_idx, commit, time, &changes_buf)?;
        }
        if changes_buf.capacity() > 4096 {
            changes_buf = Vec::new();
        }
    }
    Ok(coverage)
}

pub(crate) fn collect(
    connection: Option<&Connection>,
    snapshot: &SearchSnapshot,
    rows: Vec<(CommitSummary, i64, bool)>,
    range: &StatsRange,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(MetadataIndexCoverage, Vec<Record>), IndexError> {
    let mut kept = Vec::new();
    let coverage = visit_records(
        connection,
        snapshot,
        rows,
        range,
        cancelled,
        deadline,
        |_, commit, time, changes| {
            kept.push(Record {
                commit,
                time,
                changes: changes.to_vec(),
            });
            Ok(())
        },
    )?;
    Ok((coverage, kept))
}
fn identity(c: &CommitSummary) -> SearchIdentity {
    SearchIdentity {
        name: c.author.name.clone(),
        email: c.author.email.clone(),
    }
}
fn author_key(c: &CommitSummary) -> (String, String) {
    (c.author.name.clone(), c.author.email.clone())
}
fn lines(c: &Change, patterns: &[String]) -> (u64, u64) {
    if c.binary
        || excluded(&c.path, patterns)
        || c.old_path.as_ref().is_some_and(|p| excluded(p, patterns))
    {
        (0, 0)
    } else {
        (c.additions, c.deletions)
    }
}
fn total(t: &mut ChangeTotals, c: &Change, a: u64, d: u64) {
    t.additions += a;
    t.deletions += d;
    t.files_changed += 1;
    match c.status {
        b'A' => t.files_added += 1,
        b'D' => t.files_deleted += 1,
        b'R' => t.files_renamed += 1,
        _ => (),
    }
}
fn large_commit(commit: &CommitSummary, a: u64, d: u64) -> LargeCommit {
    LargeCommit {
        oid: commit.oid.clone(),
        summary: commit.summary.clone(),
        author: identity(commit),
        additions: a,
        deletions: d,
    }
}

pub fn change_stats(
    executable: Option<&Path>,
    session: &RepositorySession,
    p: &GetChangeStatsParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<ChangeStats, IndexError> {
    let tz = p
        .query
        .time_zone
        .parse::<Tz>()
        .map_err(|_| error(ErrorCode::InvalidRequest, "时区无效"))?;
    let grid = bucket_grid(&p.range, tz, p.bucket)?;
    let prefix = crate::change_index::decode_hex(&p.directory_prefix)?;
    let patterns = exclusions(session)?.patterns;
    let span = p.range.end_unix - p.range.start_unix;
    let include_events = span <= 86400;
    let full = StatsRange {
        start_unix: p
            .range
            .start_unix
            .checked_sub(span)
            .ok_or_else(|| error(ErrorCode::InvalidRequest, "范围溢出"))?,
        end_unix: p.range.end_unix,
    };
    let result = crate::search::with_stats_rows(
        executable,
        &SessionStore::from_env(),
        session,
        &p.query,
        false,
        cancelled,
        deadline,
        |db, snapshot, rows| {
            let (mut totals, mut previous_totals) =
                (ChangeTotals::default(), ChangeTotals::default());
            let mut excluded_counts = ExcludedChanges::default();
            let mut buckets: BTreeMap<_, _> = grid.into_iter().map(|t| (t, (0u64, 0u64))).collect();
            let mut size_histogram = vec![0; 5];
            let mut largest = Vec::new();
            let mut files = BTreeMap::<Vec<u8>, (u64, u64, Option<usize>, u64)>::new();
            let mut directories = BTreeMap::<Vec<u8>, (u64, Option<usize>, u64)>::new();
            let mut author_dirs = BTreeMap::<(String, String), BTreeMap<Vec<u8>, u64>>::new();
            let mut top_lines = BTreeMap::<Vec<u8>, u64>::new();
            let mut kinds = ChangeKinds::default();
            let mut extensions = BTreeMap::<String, (u64, u64, u64)>::new();
            let mut events = Vec::new();
            let coverage = visit_records(
                db,
                snapshot,
                rows,
                &full,
                cancelled,
                deadline,
                |rec_idx, commit, r_time, changes| {
                    active(cancelled, deadline)?;
                    let current = r_time >= p.range.start_unix;
                    if commit.parents.len() > 1 {
                        if current {
                            excluded_counts.merge_commits += 1;
                            if include_events {
                                events.push((
                                    r_time,
                                    rec_idx,
                                    0,
                                    0,
                                    BTreeSet::new(),
                                    format!("{} <{}>", commit.author.name, commit.author.email),
                                ));
                            }
                        }
                        return Ok(());
                    }
                    let (mut ca, mut cd) = (0, 0);
                    let mut event_dirs = BTreeSet::new();
                    for c in changes {
                        let (a, d) = lines(c, &patterns);
                        if !current {
                            total(&mut previous_totals, c, a, d);
                            continue;
                        }
                        total(&mut totals, c, a, d);
                        ca += a;
                        cd += d;
                        if excluded(&c.path, &patterns)
                            || c.old_path.as_ref().is_some_and(|p| excluded(p, &patterns))
                        {
                            excluded_counts.lines += c.additions + c.deletions;
                            excluded_counts.lock_files += 1;
                        }
                        let f = files.entry(c.path.clone()).or_default();
                        f.0 += a;
                        f.1 += d;
                        if f.2 != Some(rec_idx) {
                            f.2 = Some(rec_idx);
                            f.3 += 1;
                        }
                        let top = top_directory(&c.path);
                        if include_events {
                            event_dirs.insert(top.clone());
                        }
                        *top_lines.entry(top.clone()).or_default() += a + d;
                        *author_dirs
                            .entry(author_key(&commit))
                            .or_default()
                            .entry(top)
                            .or_default() += a + d;
                        if under(&c.path, &prefix) {
                            let rest = if prefix.is_empty() {
                                c.path.as_slice()
                            } else {
                                c.path.get(prefix.len() + 1..).unwrap_or_default()
                            };
                            if let Some(i) = rest.iter().position(|b| *b == b'/') {
                                let directory = if prefix.is_empty() {
                                    rest[..i].to_vec()
                                } else {
                                    [prefix.as_slice(), b"/", &rest[..i]].concat()
                                };
                                let item = directories.entry(directory).or_default();
                                item.0 += a + d;
                                if item.1 != Some(rec_idx) {
                                    item.1 = Some(rec_idx);
                                    item.2 += 1;
                                }
                            }
                        }
                        match kind(&c.path) {
                            1 => kinds.test += a + d,
                            2 => kinds.docs += a + d,
                            _ => kinds.code += a + d,
                        }
                        let name = c.path.rsplit(|b| *b == b'/').next().unwrap_or_default();
                        let extension = name
                            .iter()
                            .rposition(|b| *b == b'.')
                            .map(|n| String::from_utf8_lossy(&name[n..]).to_lowercase())
                            .unwrap_or_else(|| "(none)".into());
                        let e = extensions.entry(extension).or_default();
                        e.0 += a;
                        e.1 += d;
                        e.2 += 1;
                    }
                    if current {
                        if let Some(b) = buckets.get_mut(&bucket_start(r_time, tz, p.bucket)?) {
                            b.0 += ca;
                            b.1 += cd;
                        }
                        let n = ca + cd;
                        if n > 0 {
                            size_histogram[if n <= 10 {
                                0
                            } else if n <= 50 {
                                1
                            } else if n <= 200 {
                                2
                            } else if n <= 1000 {
                                3
                            } else {
                                4
                            }] += 1;
                        }
                        largest.push(large_commit(&commit, ca, cd));
                        if include_events {
                            events.push((
                                r_time,
                                rec_idx,
                                ca,
                                cd,
                                event_dirs,
                                format!("{} <{}>", commit.author.name, commit.author.email),
                            ));
                        }
                    }
                    Ok(())
                },
            )?;
            largest.sort_by(|a, b| {
                (b.additions + b.deletions)
                    .cmp(&(a.additions + a.deletions))
                    .then(a.oid.cmp(&b.oid))
            });
            largest.truncate(5);
            let mut files: Vec<_> = files
                .into_iter()
                .map(|(p, (a, d, _, c))| FileChanges {
                    path: crate::details::git_path(p),
                    additions: a,
                    deletions: d,
                    commits: c,
                })
                .collect();
            files.sort_by(|a, b| {
                (b.additions + b.deletions)
                    .cmp(&(a.additions + a.deletions))
                    .then(a.path.raw_hex.cmp(&b.path.raw_hex))
            });
            let files_truncated = files.len() > 20;
            files.truncate(20);
            let mut directories: Vec<_> = directories
                .into_iter()
                .map(|(p, (lines, _, c))| DirectoryChanges {
                    path: crate::details::git_path(p),
                    lines,
                    commits: c,
                })
                .collect();
            directories.sort_by(|a, b| {
                b.lines
                    .cmp(&a.lines)
                    .then(a.path.raw_hex.cmp(&b.path.raw_hex))
            });
            let directories_truncated = directories.len() > 50;
            directories.truncate(50);
            let mut tops: Vec<_> = top_lines.into_iter().collect();
            tops.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            tops.truncate(5);
            let mut author_directories: Vec<_> = author_dirs
                .into_iter()
                .map(|((name, email), cells)| AuthorDirectories {
                    author: SearchIdentity { name, email },
                    cells: tops
                        .iter()
                        .map(|(p, _)| AuthorDirectoryCell {
                            directory: crate::details::git_path(p.clone()),
                            lines: *cells.get(p).unwrap_or(&0),
                        })
                        .collect(),
                })
                .collect();
            author_directories
                .sort_by_key(|a| std::cmp::Reverse(a.cells.iter().map(|c| c.lines).sum::<u64>()));
            let author_directories_truncated = author_directories.len() > 100;
            author_directories.truncate(100);
            let mut extensions: Vec<_> = extensions
                .into_iter()
                .map(
                    |(extension, (additions, deletions, files_changed))| ExtensionChanges {
                        extension,
                        additions,
                        deletions,
                        files_changed,
                    },
                )
                .collect();
            extensions.sort_by_key(|e| std::cmp::Reverse(e.additions + e.deletions));
            let extensions_truncated = extensions.len() > 100;
            extensions.truncate(100);
            events.sort_by_key(|e| (e.0, e.1));
            let mut sessions: Vec<ChangeSession> = Vec::new();
            if span <= 86400 {
                for (t, _, a, d, dirs, author) in events {
                    let dirs: Vec<_> = dirs.into_iter().map(crate::details::git_path).collect();
                    if let Some(s) = sessions.last_mut().filter(|s| t - (s.end_unix - 1) <= 600) {
                        s.end_unix = t + 1;
                        if !s.authors.contains(&author) {
                            s.authors.push(author);
                        }
                        s.count += 1;
                        s.additions += a;
                        s.deletions += d;
                        for dir in dirs {
                            if !s.directories.contains(&dir) {
                                s.directories.push(dir);
                            }
                        }
                    } else {
                        sessions.push(ChangeSession {
                            start_unix: t,
                            end_unix: t + 1,
                            authors: vec![author],
                            count: 1,
                            additions: a,
                            deletions: d,
                            directories: dirs,
                        });
                    }
                }
            }
            let sessions_truncated = sessions.len() > 50;
            sessions.truncate(50);
            let mut net = 0i64;
            let buckets = buckets
                .into_iter()
                .map(|(start_unix, (additions, deletions))| {
                    net += additions as i64 - deletions as i64;
                    ChangeBucket {
                        start_unix,
                        additions,
                        deletions,
                        net_growth: net,
                    }
                })
                .collect();
            Ok(ChangeStats {
                coverage,
                totals,
                previous_totals,
                excluded: excluded_counts,
                buckets,
                size_histogram,
                largest,
                directories,
                directories_truncated,
                files,
                files_truncated,
                author_directories,
                author_directories_truncated,
                kinds,
                extensions,
                extensions_truncated,
                sessions,
                sessions_truncated,
            })
        },
    );
    crate::stats::release_unused_heap_memory();
    result
}

pub fn notable_stats(
    executable: Option<&Path>,
    session: &RepositorySession,
    p: &GetActivityOverviewParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<NotableStats, IndexError> {
    let tz = p
        .query
        .time_zone
        .parse::<Tz>()
        .map_err(|_| error(ErrorCode::InvalidRequest, "时区无效"))?;
    let grid = bucket_grid(&p.range, tz, p.bucket)?;
    let positions: HashMap<_, _> = grid.iter().enumerate().map(|(i, t)| (*t, i)).collect();
    let patterns = exclusions(session)?.patterns;
    let result = crate::search::with_stats_rows(
        executable,
        &SessionStore::from_env(),
        session,
        &p.query,
        false,
        cancelled,
        deadline,
        |db, snapshot, rows| {
            let mut path_pool: Vec<Vec<u8>> = Vec::new();
            let mut path_ids: HashMap<Vec<u8>, u32> = HashMap::new();
            let mut author_pool: Vec<(String, String)> = Vec::new();
            let mut author_ids: HashMap<(String, String), u32> = HashMap::new();
            let mut churn: Vec<(u64, HashSet<u32>, BTreeSet<usize>)> = Vec::new();
            let mut pairs = HashMap::<u64, u64>::new();
            let mut directories =
                BTreeMap::<Vec<u8>, (HashSet<u32>, u64, Option<usize>, u64)>::new();
            let mut untested = Vec::new();
            let mut code_total = 0;
            let mut pair_work = 0;
            let mut pair_commits_skipped = 0;
            let mut commit_paths = Vec::<u32>::new();
            let coverage = visit_records(
                db,
                snapshot,
                rows,
                &p.range,
                cancelled,
                deadline,
                |rec_idx, commit, r_time, changes| {
                    active(cancelled, deadline)?;
                    if commit.parents.len() > 1 {
                        return Ok(());
                    }
                    let ak = author_key(&commit);
                    let author_id = if let Some(&id) = author_ids.get(&ak) {
                        id
                    } else {
                        let id = u32::try_from(author_pool.len())
                            .map_err(|_| error(ErrorCode::ResourceLimit, "作者数超限"))?;
                        author_pool.push(ak.clone());
                        author_ids.insert(ak, id);
                        id
                    };
                    commit_paths.clear();
                    let (mut a, mut d) = (0, 0);
                    let (mut has_code, mut has_test) = (false, false);
                    for c in changes {
                        if excluded(&c.path, &patterns)
                            || c.old_path.as_ref().is_some_and(|p| excluded(p, &patterns))
                        {
                            continue;
                        }
                        let (ca, cd) = lines(c, &patterns);
                        a += ca;
                        d += cd;
                        has_code |= kind(&c.path) == 0;
                        has_test |= kind(&c.path) == 1;
                        let pid = if let Some(&id) = path_ids.get(&c.path) {
                            id
                        } else {
                            let id = u32::try_from(path_pool.len())
                                .map_err(|_| error(ErrorCode::ResourceLimit, "路径数超限"))?;
                            path_pool.push(c.path.clone());
                            path_ids.insert(c.path.clone(), id);
                            churn.push((0, HashSet::new(), BTreeSet::new()));
                            id
                        };
                        commit_paths.push(pid);
                        let dir = directories.entry(top_directory(&c.path)).or_default();
                        dir.0.insert(author_id);
                        dir.1 += ca + cd;
                        if dir.2 != Some(rec_idx) {
                            dir.2 = Some(rec_idx);
                            dir.3 += 1;
                        }
                    }
                    if has_code {
                        code_total += 1;
                        if !has_test {
                            untested.push(large_commit(&commit, a, d));
                        }
                    }
                    commit_paths
                        .sort_by(|&x, &y| path_pool[x as usize].cmp(&path_pool[y as usize]));
                    commit_paths.dedup();
                    if !commit_paths.is_empty() {
                        let bucket_idx =
                            positions.get(&bucket_start(r_time, tz, p.bucket)?).copied();
                        for &pid in &commit_paths {
                            let entry = &mut churn[pid as usize];
                            entry.0 += 1;
                            entry.1.insert(author_id);
                            if let Some(i) = bucket_idx {
                                entry.2.insert(i);
                            }
                        }
                    }
                    if changes.len() <= 50 {
                        for i in 0..commit_paths.len() {
                            for j in i + 1..commit_paths.len() {
                                pair_work += 1;
                                if pair_work > 500_000 {
                                    return Err(error(
                                        ErrorCode::ResourceLimit,
                                        "共同改动计算超过 500000 对；未返回不完整排名",
                                    ));
                                }
                                let packed =
                                    ((commit_paths[i] as u64) << 32) | (commit_paths[j] as u64);
                                *pairs.entry(packed).or_default() += 1;
                            }
                        }
                    } else {
                        pair_commits_skipped += 1;
                    }
                    Ok(())
                },
            )?;
            let mut raw_pairs: Vec<(usize, usize, u64)> = pairs
                .into_iter()
                .map(|(packed, together)| {
                    (
                        (packed >> 32) as usize,
                        (packed & 0xffff_ffff) as usize,
                        together,
                    )
                })
                .collect();
            raw_pairs.sort_by(|a, b| {
                b.2.cmp(&a.2)
                    .then_with(|| path_pool[a.0].cmp(&path_pool[b.0]))
                    .then_with(|| path_pool[a.1].cmp(&path_pool[b.1]))
            });
            let pairs_truncated = raw_pairs.len() > 50;
            raw_pairs.truncate(50);
            let pair_results: Vec<_> = raw_pairs
                .into_iter()
                .map(|(a_id, b_id, together)| {
                    let n = churn[a_id].0.max(1);
                    FilePair {
                        a: crate::details::git_path(path_pool[a_id].clone()),
                        b: crate::details::git_path(path_pool[b_id].clone()),
                        together,
                        share_of_a_per_mille: (together * 1000 / n) as u32,
                    }
                })
                .collect();
            let mut raw_churn: Vec<(usize, u64, u64, BTreeSet<usize>)> = churn
                .into_iter()
                .enumerate()
                .filter(|(_, v)| v.0 > 1)
                .map(|(idx, (commits, authors, days))| (idx, commits, authors.len() as u64, days))
                .collect();
            raw_churn.sort_by(|a, b| {
                b.1.cmp(&a.1)
                    .then_with(|| path_pool[a.0].cmp(&path_pool[b.0]))
            });
            let churn_files_truncated = raw_churn.len() > 50;
            raw_churn.truncate(50);
            let churn_files: Vec<_> = raw_churn
                .into_iter()
                .map(|(idx, commits, authors, days)| ChurnFile {
                    path: crate::details::git_path(std::mem::take(&mut path_pool[idx])),
                    commits,
                    authors,
                    days: (0..grid.len())
                        .map(|i| u8::from(days.contains(&i)))
                        .collect(),
                })
                .collect();
            let mut solo_directories: Vec<_> = directories
                .into_iter()
                .filter(|(_, v)| v.0.len() == 1 && v.1 > 0)
                .map(|(path, (authors, lines, _, commits))| {
                    let aid = authors.into_iter().next().unwrap() as usize;
                    let (name, email) = &author_pool[aid];
                    SoloDirectory {
                        path: crate::details::git_path(path),
                        author: SearchIdentity {
                            name: name.clone(),
                            email: email.clone(),
                        },
                        lines,
                        commits,
                    }
                })
                .collect();
            solo_directories.sort_by(|a, b| {
                b.lines
                    .cmp(&a.lines)
                    .then(a.path.raw_hex.cmp(&b.path.raw_hex))
            });
            let solo_directories_truncated = solo_directories.len() > 50;
            solo_directories.truncate(50);
            let count = untested.len() as u64;
            let commits_truncated = untested.len() > 50;
            untested.sort_by(|a, b| a.oid.cmp(&b.oid));
            untested.truncate(50);
            Ok(NotableStats {
                coverage,
                churn_files,
                churn_files_truncated,
                pairs: pair_results,
                pairs_truncated,
                pair_commits_skipped,
                solo_directories,
                solo_directories_truncated,
                untested: UntestedChanges {
                    count,
                    total: code_total,
                    commits: untested,
                    commits_truncated,
                },
            })
        },
    );
    crate::stats::release_unused_heap_memory();
    result
}

pub fn stats_commits(
    executable: Option<&Path>,
    session: &RepositorySession,
    p: &GetStatsCommitsParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<StatsCommitPage, IndexError> {
    if p.limit == 0 || p.limit > 200 {
        return Err(error(ErrorCode::InvalidRequest, "limit 须为 1–200"));
    }
    let patterns = exclusions(session)?.patterns;
    let decode = |s: &str| crate::change_index::decode_hex(s);
    let (first, second) = match &p.selection {
        StatsSelection::File { path_hex } | StatsSelection::Directory { path_hex } => {
            (decode(path_hex)?, Vec::new())
        }
        StatsSelection::Pair { a_hex, b_hex } => (decode(a_hex)?, decode(b_hex)?),
        StatsSelection::Untested => (Vec::new(), Vec::new()),
    };
    bucket_grid(
        &p.range,
        p.query
            .time_zone
            .parse()
            .map_err(|_| error(ErrorCode::InvalidRequest, "时区无效"))?,
        StatsBucket::Month,
    )?;
    let result = crate::search::with_stats_rows(
        executable,
        &SessionStore::from_env(),
        session,
        &p.query,
        false,
        cancelled,
        deadline,
        |db, snapshot, rows| {
            let mut found = Vec::new();
            let coverage = visit_records(
                db,
                snapshot,
                rows,
                &p.range,
                cancelled,
                deadline,
                |_, commit, r_time, changes| {
                    active(cancelled, deadline)?;
                    if commit.parents.len() > 1 {
                        return Ok(());
                    }
                    let paths: Vec<_> = changes
                        .iter()
                        .filter(|c| {
                            matches!(
                                p.selection,
                                StatsSelection::File { .. } | StatsSelection::Directory { .. }
                            ) || (!excluded(&c.path, &patterns)
                                && !c.old_path.as_ref().is_some_and(|p| excluded(p, &patterns)))
                        })
                        .map(|c| c.path.as_slice())
                        .collect();
                    let hit = match p.selection {
                        StatsSelection::File { .. } => paths.contains(&first.as_slice()),
                        StatsSelection::Directory { .. } => paths.iter().any(|p| {
                            if first.is_empty() {
                                !p.contains(&b'/')
                            } else {
                                under(p, &first)
                            }
                        }),
                        StatsSelection::Pair { .. } => {
                            changes.len() <= 50
                                && paths.contains(&first.as_slice())
                                && paths.contains(&second.as_slice())
                        }
                        StatsSelection::Untested => {
                            paths.iter().any(|p| kind(p) == 0)
                                && !paths.iter().any(|p| kind(p) == 1)
                        }
                    };
                    if hit {
                        found.push((
                            r_time,
                            OperationCommit {
                                oid: commit.oid,
                                summary: commit.summary,
                            },
                        ));
                    }
                    Ok(())
                },
            )?;
            found.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.oid.cmp(&b.1.oid)));
            let total = found.len() as u64;
            let commits = found
                .into_iter()
                .skip(p.offset as usize)
                .take(p.limit as usize)
                .map(|(_, c)| c)
                .collect::<Vec<_>>();
            let next = p.offset as usize + commits.len();
            Ok(StatsCommitPage {
                coverage,
                total,
                commits,
                next_offset: ((next as u64) < total).then_some(next as u32),
            })
        },
    );
    crate::stats::release_unused_heap_memory();
    result
}
