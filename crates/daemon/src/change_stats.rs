//! File statistics and per-repository exclusion preferences. No operation-mode Git runner.
use crate::{
    metadata_index::{IndexError, SearchSnapshot},
    session::RepositorySession,
    session_store::SessionStore,
    stats::{active, bucket_grid, bucket_start, error},
};
use chrono_tz::Tz;
use commitscope_core::*;
use rusqlite::{Connection, params};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    io::Write,
    path::PathBuf,
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
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
}
pub(crate) struct Record {
    pub commit: CommitSummary,
    pub time: i64,
    pub changes: Vec<Change>,
}
pub(crate) fn collect(
    connection: Option<&Connection>,
    snapshot: &SearchSnapshot,
    rows: Vec<(CommitSummary, i64, bool)>,
    range: &StatsRange,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(MetadataIndexCoverage, Vec<Record>), IndexError> {
    let Some(db) = connection else {
        return Ok((
            MetadataIndexCoverage {
                processed: 0,
                complete: false,
            },
            Vec::new(),
        ));
    };
    let version: i32 = db
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(sql)?;
    if version < 2 {
        return Ok((
            MetadataIndexCoverage {
                processed: 0,
                complete: false,
            },
            Vec::new(),
        ));
    }
    let mut records = Vec::new();
    let mut indices = HashMap::new();
    for (c, t, matched) in rows {
        if matched && t >= range.start_unix && t < range.end_unix {
            indices.insert(c.oid.clone(), records.len());
            records.push(Record {
                commit: c,
                time: t,
                changes: Vec::new(),
            });
        }
    }
    let mut processed = 0;
    let mut complete_oids = BTreeSet::new();
    let mut stmt=db.prepare("SELECT c.oid,c.changes_complete FROM snapshot_commits s JOIN commits c ON s.oid=c.oid WHERE s.snapshot_key=?1 AND s.ordinal<?2").map_err(sql)?;
    let mut q = stmt
        .query(params![snapshot.snapshot_key, snapshot.watermark as i64])
        .map_err(sql)?;
    while let Some(row) = q.next().map_err(sql)? {
        active(cancelled, deadline)?;
        if row.get::<_, i64>(1).map_err(sql)? == 1 {
            processed += 1;
            complete_oids.insert(row.get::<_, String>(0).map_err(sql)?);
        }
    }
    let mut stmt=db.prepare("SELECT f.oid,f.path,f.old_path,f.status,f.additions,f.deletions,f.binary FROM snapshot_commits s JOIN commits c ON c.oid=s.oid JOIN commit_changes f ON f.oid=c.oid WHERE s.snapshot_key=?1 AND s.ordinal<?2 AND c.changes_complete=1 ORDER BY s.ordinal,f.ordinal").map_err(sql)?;
    let mut q = stmt
        .query(params![snapshot.snapshot_key, snapshot.watermark as i64])
        .map_err(sql)?;
    let mut count = 0;
    while let Some(r) = q.next().map_err(sql)? {
        active(cancelled, deadline)?;
        count += 1;
        if count > 2_000_000 {
            return Err(error(
                ErrorCode::ResourceLimit,
                "文件记录超过 2000000，未返回不完整排名",
            ));
        }
        let oid: String = r.get(0).map_err(sql)?;
        if let Some(index) = indices.get(&oid) {
            records[*index].changes.push(Change {
                path: r.get(1).map_err(sql)?,
                old_path: r.get(2).map_err(sql)?,
                status: r.get(3).map_err(sql)?,
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
            });
        }
    }
    records.retain(|r| complete_oids.contains(&r.commit.oid));
    Ok((
        MetadataIndexCoverage {
            processed,
            complete: snapshot.complete && processed == snapshot.watermark,
        },
        records,
    ))
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
    match c.status.as_str() {
        "A" => t.files_added += 1,
        "D" => t.files_deleted += 1,
        "R" => t.files_renamed += 1,
        _ => (),
    }
}
fn large(r: &Record, a: u64, d: u64) -> LargeCommit {
    LargeCommit {
        oid: r.commit.oid.clone(),
        summary: r.commit.summary.clone(),
        author: identity(&r.commit),
        additions: a,
        deletions: d,
    }
}

pub fn change_stats(
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
    let full = StatsRange {
        start_unix: p
            .range
            .start_unix
            .checked_sub(span)
            .ok_or_else(|| error(ErrorCode::InvalidRequest, "范围溢出"))?,
        end_unix: p.range.end_unix,
    };
    crate::search::with_stats_rows(
        &SessionStore::from_env(),
        session,
        &p.query,
        cancelled,
        deadline,
        |db, snapshot, rows| {
            let (coverage, records) = collect(db, snapshot, rows, &full, cancelled, deadline)?;
            let (mut totals, mut previous_totals) =
                (ChangeTotals::default(), ChangeTotals::default());
            let mut excluded_counts = ExcludedChanges::default();
            let mut buckets: BTreeMap<_, _> = grid.into_iter().map(|t| (t, (0u64, 0u64))).collect();
            let mut size_histogram = vec![0; 5];
            let mut largest = Vec::new();
            let mut files = BTreeMap::<Vec<u8>, (u64, u64, BTreeSet<String>)>::new();
            let mut directories = BTreeMap::<Vec<u8>, (u64, BTreeSet<String>)>::new();
            let mut author_dirs = BTreeMap::<(String, String), BTreeMap<Vec<u8>, u64>>::new();
            let mut top_lines = BTreeMap::<Vec<u8>, u64>::new();
            let mut kinds = ChangeKinds::default();
            let mut extensions = BTreeMap::<String, (u64, u64, u64)>::new();
            let mut events = Vec::new();
            for r in &records {
                active(cancelled, deadline)?;
                let current = r.time >= p.range.start_unix;
                if r.commit.parents.len() > 1 {
                    if current {
                        excluded_counts.merge_commits += 1;
                        events.push((
                            r.time,
                            0,
                            0,
                            BTreeSet::new(),
                            format!("{} <{}>", r.commit.author.name, r.commit.author.email),
                        ));
                    }
                    continue;
                }
                let (mut ca, mut cd) = (0, 0);
                let mut event_dirs = BTreeSet::new();
                for c in &r.changes {
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
                    f.2.insert(r.commit.oid.clone());
                    let top = top_directory(&c.path);
                    event_dirs.insert(top.clone());
                    *top_lines.entry(top.clone()).or_default() += a + d;
                    *author_dirs
                        .entry(author_key(&r.commit))
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
                            item.1.insert(r.commit.oid.clone());
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
                    if let Some(b) = buckets.get_mut(&bucket_start(r.time, tz, p.bucket)?) {
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
                    largest.push(large(r, ca, cd));
                    events.push((
                        r.time,
                        ca,
                        cd,
                        event_dirs,
                        format!("{} <{}>", r.commit.author.name, r.commit.author.email),
                    ));
                }
            }
            largest.sort_by(|a, b| {
                (b.additions + b.deletions)
                    .cmp(&(a.additions + a.deletions))
                    .then(a.oid.cmp(&b.oid))
            });
            largest.truncate(5);
            let mut files: Vec<_> = files
                .into_iter()
                .map(|(p, (a, d, c))| FileChanges {
                    path: crate::details::git_path(p),
                    additions: a,
                    deletions: d,
                    commits: c.len() as u64,
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
                .map(|(p, (lines, c))| DirectoryChanges {
                    path: crate::details::git_path(p),
                    lines,
                    commits: c.len() as u64,
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
            events.sort_by_key(|e| e.0);
            let mut sessions: Vec<ChangeSession> = Vec::new();
            if span <= 86400 {
                for (t, a, d, dirs, author) in events {
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
    )
}

pub fn notable_stats(
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
    crate::search::with_stats_rows(
        &SessionStore::from_env(),
        session,
        &p.query,
        cancelled,
        deadline,
        |db, snapshot, rows| {
            let (coverage, records) = collect(db, snapshot, rows, &p.range, cancelled, deadline)?;
            let mut churn =
                BTreeMap::<Vec<u8>, (u64, BTreeSet<(String, String)>, BTreeSet<usize>)>::new();
            let mut pairs = BTreeMap::<(Vec<u8>, Vec<u8>), u64>::new();
            let mut directories =
                BTreeMap::<Vec<u8>, (BTreeSet<(String, String)>, u64, BTreeSet<String>)>::new();
            let mut untested = Vec::new();
            let mut code_total = 0;
            let mut pair_work = 0;
            let mut pair_commits_skipped = 0;
            for r in &records {
                active(cancelled, deadline)?;
                if r.commit.parents.len() > 1 {
                    continue;
                }
                let mut paths = BTreeSet::new();
                let (mut a, mut d) = (0, 0);
                let (mut has_code, mut has_test) = (false, false);
                for c in &r.changes {
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
                    paths.insert(c.path.clone());
                    let dir = directories.entry(top_directory(&c.path)).or_default();
                    dir.0.insert(author_key(&r.commit));
                    dir.1 += ca + cd;
                    dir.2.insert(r.commit.oid.clone());
                }
                if has_code {
                    code_total += 1;
                    if !has_test {
                        untested.push(large(r, a, d));
                    }
                }
                for path in &paths {
                    let c = churn.entry(path.clone()).or_default();
                    c.0 += 1;
                    c.1.insert(author_key(&r.commit));
                    if let Some(i) = positions.get(&bucket_start(r.time, tz, p.bucket)?) {
                        c.2.insert(*i);
                    }
                }
                if r.changes.len() <= 50 {
                    let paths: Vec<_> = paths.into_iter().collect();
                    for i in 0..paths.len() {
                        for j in i + 1..paths.len() {
                            pair_work += 1;
                            if pair_work > 500_000 {
                                return Err(error(
                                    ErrorCode::ResourceLimit,
                                    "共同改动计算超过 500000 对；未返回不完整排名",
                                ));
                            }
                            *pairs
                                .entry((paths[i].clone(), paths[j].clone()))
                                .or_default() += 1;
                        }
                    }
                } else {
                    pair_commits_skipped += 1;
                }
            }
            let mut pair_results: Vec<_> = pairs
                .into_iter()
                .map(|((a, b), together)| {
                    let n = churn.get(&a).map(|v| v.0).unwrap_or(1);
                    FilePair {
                        a: crate::details::git_path(a),
                        b: crate::details::git_path(b),
                        together,
                        share_of_a_per_mille: (together * 1000 / n) as u32,
                    }
                })
                .collect();
            pair_results.sort_by(|a, b| {
                b.together
                    .cmp(&a.together)
                    .then(a.a.raw_hex.cmp(&b.a.raw_hex))
                    .then(a.b.raw_hex.cmp(&b.b.raw_hex))
            });
            let pairs_truncated = pair_results.len() > 50;
            pair_results.truncate(50);
            let mut churn_files: Vec<_> = churn
                .into_iter()
                .filter(|(_, v)| v.0 > 1)
                .map(|(path, (commits, authors, days))| ChurnFile {
                    path: crate::details::git_path(path),
                    commits,
                    authors: authors.len() as u64,
                    days: (0..grid.len())
                        .map(|i| u8::from(days.contains(&i)))
                        .collect(),
                })
                .collect();
            churn_files.sort_by(|a, b| {
                b.commits
                    .cmp(&a.commits)
                    .then(a.path.raw_hex.cmp(&b.path.raw_hex))
            });
            let churn_files_truncated = churn_files.len() > 50;
            churn_files.truncate(50);
            let mut solo_directories: Vec<_> = directories
                .into_iter()
                .filter(|(_, v)| v.0.len() == 1 && v.1 > 0)
                .map(|(path, (authors, lines, commits))| {
                    let (name, email) = authors.into_iter().next().unwrap();
                    SoloDirectory {
                        path: crate::details::git_path(path),
                        author: SearchIdentity { name, email },
                        lines,
                        commits: commits.len() as u64,
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
    )
}

pub fn stats_commits(
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
    crate::search::with_stats_rows(
        &SessionStore::from_env(),
        session,
        &p.query,
        cancelled,
        deadline,
        |db, snapshot, rows| {
            let (coverage, records) = collect(db, snapshot, rows, &p.range, cancelled, deadline)?;
            let mut found = Vec::new();
            for r in records {
                active(cancelled, deadline)?;
                if r.commit.parents.len() > 1 {
                    continue;
                }
                let paths: Vec<_> = r
                    .changes
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
                        r.changes.len() <= 50
                            && paths.contains(&first.as_slice())
                            && paths.contains(&second.as_slice())
                    }
                    StatsSelection::Untested => {
                        paths.iter().any(|p| kind(p) == 0) && !paths.iter().any(|p| kind(p) == 1)
                    }
                };
                if hit {
                    found.push((
                        r.time,
                        OperationCommit {
                            oid: r.commit.oid,
                            summary: r.commit.summary,
                        },
                    ));
                }
            }
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
    )
}
