//! Explicit per-file evolution analysis, sharing the normal blame cache and cancellation.
use crate::{
    details::{
        DetailError, detail_error, from_git, git_output_error, git_path, validate_oid,
        validate_path_hex,
    },
    files::{self, LsTreeEntry},
    git_command::{ReadOnlyGit, string_arg},
    metadata_index::IndexError,
    session::RepositorySession,
    session_store::SessionStore,
    stats::active,
};
use commitscope_core::*;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::Path,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};
const FILE_LIMIT: usize = 200;
const TREE_LIMIT: usize = 10_000;
pub const TIMEOUT: Duration = Duration::from_secs(600);
fn from_index(e: IndexError) -> DetailError {
    detail_error(e.code, &e.message, false)
}
fn check(c: &AtomicBool, d: Instant) -> Result<(), DetailError> {
    active(c, d).map_err(from_index)
}

struct AnalysisControl<'a> {
    cancelled: &'a AtomicBool,
    deadline: Instant,
    interactive_active: &'a dyn Fn() -> bool,
}

impl AnalysisControl<'_> {
    fn file_boundary(&mut self) -> Result<(), DetailError> {
        // Work that already exceeded its budget must not be rescued by a pause.
        check(self.cancelled, self.deadline)?;
        if !(self.interactive_active)() {
            return Ok(());
        }
        let paused_at = Instant::now();
        let work_deadline = self.deadline;
        while (self.interactive_active)() {
            // Only the cooperative wait is excluded from the 600-second work
            // budget. Git, cache/SQLite reads, aggregation and output still count.
            self.deadline = work_deadline + paused_at.elapsed();
            check(self.cancelled, self.deadline)?;
            std::thread::sleep(Duration::from_millis(10));
        }
        self.deadline = work_deadline + paused_at.elapsed();
        check(self.cancelled, self.deadline)
    }
}

fn path_under(path: &[u8], prefix: &[u8]) -> bool {
    prefix.is_empty()
        || path == prefix
        || (path.starts_with(prefix) && path.get(prefix.len()) == Some(&b'/'))
}
fn validate(p: &EvolutionParams, session: &RepositorySession) -> Result<(), DetailError> {
    validate_oid(&p.commit, session.discovered.oid_length)?;
    if !p.path_hex.is_empty() {
        validate_path_hex(Some(&p.path_hex))?;
    }
    if let Some(r) = &p.range
        && r.start_unix >= r.end_unix
    {
        return Err(detail_error(
            ErrorCode::InvalidRequest,
            "演化时间范围必须为非空半开区间",
            false,
        ));
    }
    Ok(())
}
struct Selection {
    estimate: EvolutionEstimate,
    files: Vec<LsTreeEntry>,
    prefix: Vec<u8>,
}
fn select(
    executable: &Path,
    session: &RepositorySession,
    p: &EvolutionParams,
    control: &mut AnalysisControl<'_>,
) -> Result<Selection, DetailError> {
    control.file_boundary()?;
    let cancelled = control.cancelled;
    validate(p, session)?;
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    let repo = Path::new(&session.discovered.info.path);
    let patterns = crate::change_stats::exclusions(session)
        .map_err(from_index)?
        .patterns;
    let prefix = crate::change_index::decode_hex(&p.path_hex).map_err(from_index)?;
    let mut args = files::commit_args(&p.commit);
    args.extend(
        ["ls-tree", "-r", "-l", "-z", "--full-tree", &p.commit, "--"]
            .iter()
            .map(string_arg),
    );
    if !p.path_hex.is_empty() {
        args.push(crate::details::raw_path_arg(&p.path_hex)?);
    }
    let out = git
        .run(
            repo,
            &args,
            None,
            16 * 1024 * 1024,
            cancelled,
            control.deadline,
        )
        .map_err(from_git)?;
    if !out.status.success() {
        return Err(git_output_error(&out.stderr));
    }
    let entries = files::parse_ls_tree(&out.stdout, session.discovered.oid_length)?;
    if entries.len() > TREE_LIMIT {
        return Err(detail_error(
            ErrorCode::ResourceLimit,
            "树条目超过 10000；请选择更小目录",
            false,
        ));
    }
    let mut estimate = EvolutionEstimate {
        files: 0,
        total_files: 0,
        lines: 0,
        bytes: 0,
        file_limit: FILE_LIMIT as u32,
        skipped: Vec::new(),
    };
    let mut selected = Vec::new();
    for entry in entries {
        control.file_boundary()?;
        let deadline = control.deadline;
        if !path_under(&entry.path, &prefix) {
            continue;
        }
        estimate.total_files += 1;
        let mut reason = if crate::change_stats::excluded(&entry.path, &patterns) {
            Some("excluded")
        } else if entry.kind != TreeEntryKind::File {
            Some("notRegularFile")
        } else if entry.size.unwrap_or(u64::MAX) > 1024 * 1024 {
            Some("byteLimit")
        } else if selected.len() >= FILE_LIMIT {
            Some("fileLimit")
        } else {
            None
        };
        if reason.is_none() {
            let content =
                files::read_blob(&git, repo, &entry.oid, 1024 * 1024 + 1, cancelled, deadline)?;
            let lines = files::count_lines(&content);
            if content[..content.len().min(files::BINARY_SNIFF)].contains(&0) {
                reason = Some("binary");
            } else if lines > 20_000 {
                reason = Some("lineLimit");
            } else {
                estimate.lines += lines;
                estimate.bytes += content.len() as u64;
            }
        }
        if let Some(reason) = reason {
            estimate.skipped.push(EvolutionSkipped {
                path: git_path(entry.path),
                reason: reason.into(),
            });
        } else {
            selected.push(entry);
        }
    }
    estimate.files = selected.len() as u32;
    if estimate.total_files == 0 && !prefix.is_empty() {
        return Err(detail_error(
            ErrorCode::MissingObject,
            "所选路径在该提交不存在",
            false,
        ));
    }
    Ok(Selection {
        estimate,
        files: selected,
        prefix,
    })
}
pub fn estimate(
    executable: &Path,
    session: &RepositorySession,
    p: &EvolutionParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<EvolutionEstimate, DetailError> {
    let mut control = AnalysisControl {
        cancelled,
        deadline,
        interactive_active: &|| false,
    };
    Ok(select(executable, session, p, &mut control)?.estimate)
}
fn in_range(time: i64, range: &Option<StatsRange>) -> bool {
    range
        .as_ref()
        .is_none_or(|r| time >= r.start_unix && time < r.end_unix)
}
fn week(time: i64) -> Result<i64, IndexError> {
    let start = (i128::from(time) + 3 * 86400).div_euclid(7 * 86400) * 7 * 86400 - 3 * 86400;
    i64::try_from(start)
        .map_err(|_| crate::stats::error(ErrorCode::InvalidRequest, "提交时间超出统计范围"))
}
type Counts = BTreeMap<(String, String), (u64, u64)>;
type SurvivalCounts = (MetadataIndexCoverage, BTreeMap<i64, (u64, u64)>, Counts);
fn survival_added(
    session: &RepositorySession,
    p: &EvolutionParams,
    selection: &Selection,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<SurvivalCounts, DetailError> {
    let patterns = crate::change_stats::exclusions(session)
        .map_err(from_index)?
        .patterns;
    let query = SearchQuery {
        message: String::new(),
        case_sensitive: false,
        authors: Vec::new(),
        committers: Vec::new(),
        oid_prefix: String::new(),
        time_field: SearchTimeField::Author,
        from_timestamp: None,
        to_timestamp: None,
        time_zone: "UTC".into(),
        path: None,
        exclude_tips: Vec::new(),
    };
    crate::search::with_stats_rows(
        None,
        &SessionStore::from_env(),
        session,
        &query,
        true,
        cancelled,
        deadline,
        |db, snapshot, rows| {
            let parents: HashMap<_, _> = rows
                .iter()
                .map(|(c, _, _)| (c.oid.clone(), c.parents.clone()))
                .collect();
            let mut pending = vec![p.commit.clone()];
            let mut reachable = HashSet::new();
            let mut graph_complete = true;
            while let Some(oid) = pending.pop() {
                active(cancelled, deadline)?;
                if !reachable.insert(oid.clone()) {
                    continue;
                }
                if let Some(ps) = parents.get(&oid) {
                    pending.extend(ps.iter().cloned());
                } else {
                    graph_complete = false;
                }
            }
            let filtered = rows
                .into_iter()
                .filter(|(c, _, _)| reachable.contains(&c.oid))
                .collect();
            let (mut coverage, records) = crate::change_stats::collect(
                db,
                snapshot,
                filtered,
                &StatsRange {
                    start_unix: i64::MIN,
                    end_unix: i64::MAX,
                },
                cancelled,
                deadline,
            )?;
            coverage.complete &=
                graph_complete && !crate::repository::history_boundary_limited(&session.discovered);
            let mut aliases: HashSet<Vec<u8>> =
                selection.files.iter().map(|f| f.path.clone()).collect();
            let skipped: HashSet<_> = selection
                .estimate
                .skipped
                .iter()
                .map(|s| crate::change_index::decode_hex(&s.path.raw_hex))
                .collect::<Result<_, _>>()?;
            // Build the transitive set of old names, independent of author-date ordering.
            let mut renames = HashMap::<Vec<u8>, Vec<Vec<u8>>>::new();
            for r in &records {
                for c in &r.changes {
                    if let Some(old) = &c.old_path {
                        renames.entry(c.path.clone()).or_default().push(old.clone());
                    }
                }
            }
            let mut queue: Vec<_> = aliases.iter().cloned().collect();
            while let Some(path) = queue.pop() {
                active(cancelled, deadline)?;
                if let Some(olds) = renames.get(&path) {
                    for old in olds {
                        if aliases.insert(old.clone()) {
                            queue.push(old.clone());
                        }
                    }
                }
            }
            let mut weeks = BTreeMap::<i64, (u64, u64)>::new();
            let mut authors = Counts::new();
            for r in records {
                active(cancelled, deadline)?;
                if r.commit.parents.len() > 1 || !in_range(r.time, &p.range) {
                    continue;
                }
                for c in r.changes {
                    if c.binary
                        || skipped.contains(&c.path)
                        || crate::change_stats::excluded(&c.path, &patterns)
                        || c.old_path
                            .as_ref()
                            .is_some_and(|old| crate::change_stats::excluded(old, &patterns))
                    {
                        continue;
                    }
                    if aliases.contains(&c.path) || path_under(&c.path, &selection.prefix) {
                        weeks.entry(week(r.time)?).or_default().0 += c.additions;
                        authors
                            .entry((r.commit.author.name.clone(), r.commit.author.email.clone()))
                            .or_default()
                            .0 += c.additions;
                    }
                }
            }
            Ok((coverage, weeks, authors))
        },
    )
    .map_err(from_index)
}
#[allow(clippy::too_many_arguments)]
pub fn analyze(
    executable: &Path,
    session: &RepositorySession,
    p: &EvolutionParams,
    cancelled: &AtomicBool,
    deadline: Instant,
    interactive_active: &dyn Fn() -> bool,
    emit: &mut impl FnMut(EvolutionChunk, bool) -> bool,
) -> Result<(), DetailError> {
    let mut control = AnalysisControl {
        cancelled,
        deadline,
        interactive_active,
    };
    let selection = select(executable, session, p, &mut control)?;
    control.file_boundary()?;
    let (coverage, mut weeks, mut authors) =
        survival_added(session, p, &selection, cancelled, control.deadline)?;
    let now = (crate::details::now_unix_ms() / 1000) as i64;
    let mut result = EvolutionResult {
        as_of_unix: now,
        age: EvolutionAge::default(),
        ownership: Vec::new(),
        survival: EvolutionSurvival {
            coverage,
            weeks: Vec::new(),
            by_author: Vec::new(),
        },
        covered: EvolutionCovered::default(),
        skipped: selection.estimate.skipped,
        complete: false,
    };
    let mut ownership = BTreeMap::<(String, String), (u64, BTreeSet<String>)>::new();
    let update = |result: &mut EvolutionResult,
                  ownership: &BTreeMap<(String, String), (u64, BTreeSet<String>)>,
                  weeks: &BTreeMap<i64, (u64, u64)>,
                  authors: &Counts| {
        result.ownership = ownership
            .iter()
            .map(|((name, email), (lines, commits))| EvolutionOwner {
                author: SearchIdentity {
                    name: name.clone(),
                    email: email.clone(),
                },
                lines: *lines,
                commits: commits.len() as u64,
            })
            .collect();
        result.ownership.sort_by_key(|v| std::cmp::Reverse(v.lines));
        result.survival.weeks = weeks
            .iter()
            .map(|(start, (added, kept))| SurvivalWeek {
                start_unix: *start,
                added: *added,
                kept: *kept,
            })
            .collect();
        result.survival.by_author = authors
            .iter()
            .map(|((name, email), (added, kept))| SurvivalAuthor {
                author: SearchIdentity {
                    name: name.clone(),
                    email: email.clone(),
                },
                added: *added,
                kept: *kept,
            })
            .collect();
    };
    update(&mut result, &ownership, &weeks, &authors);
    for entry in selection.files {
        control.file_boundary()?;
        let path = git_path(entry.path.clone());
        if !emit(
            EvolutionChunk {
                progress: EvolutionProgress {
                    files_done: result.covered.files,
                    files_total: selection.estimate.files,
                    current_path: Some(path.clone()),
                },
                result: result.clone(),
            },
            false,
        ) {
            return Err(detail_error(ErrorCode::Cancelled, "演化分析已取消", false));
        }
        let mut commits = HashMap::<String, BlameCommit>::new();
        let mut blocks = Vec::new();
        crate::blame::read_blame(
            executable,
            session,
            &ReadBlameParams {
                commit: p.commit.clone(),
                path_hex: path.raw_hex.clone(),
            },
            cancelled,
            control.deadline,
            &mut |chunk, _| {
                for c in chunk.commits {
                    commits.insert(c.oid.clone(), c);
                }
                blocks.extend(chunk.blocks);
                !cancelled.load(std::sync::atomic::Ordering::Acquire)
            },
        )?;
        // Only merge a file into the visible cumulative result after the whole file succeeded.
        for block in blocks {
            let c = commits
                .get(&block.oid)
                .ok_or_else(|| detail_error(ErrorCode::GitError, "追溯缺少提交身份", false))?;
            let lines = u64::from(block.line_count);
            let age = now.saturating_sub(c.author_time);
            if age < 7 * 86400 {
                result.age.within7d += lines;
            } else if age < 30 * 86400 {
                result.age.within30d += lines;
            } else if age < 90 * 86400 {
                result.age.within90d += lines;
            } else if age < 365 * 86400 {
                result.age.within1y += lines;
            } else {
                result.age.older += lines;
            }
            let key = (c.author_name.clone(), c.author_email.clone());
            let owner = ownership.entry(key.clone()).or_default();
            owner.0 += lines;
            owner.1.insert(c.oid.clone());
            result.covered.lines += lines;
            if in_range(c.author_time, &p.range) {
                weeks
                    .entry(week(c.author_time).map_err(from_index)?)
                    .or_default()
                    .1 += lines;
                authors.entry(key).or_default().1 += lines;
            }
        }
        if ownership.len() > 500 || authors.len() > 500 || weeks.len() > 3660 {
            return Err(detail_error(
                ErrorCode::ResourceLimit,
                "演化结果分组过多，请缩小范围",
                false,
            ));
        }
        result.covered.files += 1;
        update(&mut result, &ownership, &weeks, &authors);
        if !emit(
            EvolutionChunk {
                progress: EvolutionProgress {
                    files_done: result.covered.files,
                    files_total: selection.estimate.files,
                    current_path: None,
                },
                result: result.clone(),
            },
            false,
        ) {
            return Err(detail_error(ErrorCode::Cancelled, "演化分析已取消", false));
        }
        control.file_boundary()?;
    }
    result.complete = true;
    let chunk = EvolutionChunk {
        progress: EvolutionProgress {
            files_done: result.covered.files,
            files_total: selection.estimate.files,
            current_path: None,
        },
        result,
    };
    if !emit(chunk, true) {
        return Err(detail_error(ErrorCode::Cancelled, "演化分析已取消", false));
    }
    Ok(())
}

#[cfg(test)]
mod scheduling_tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn pauses_preserve_work_budget_but_do_not_revive_expired_work() {
        let cancelled = AtomicBool::new(false);
        let start = Instant::now();
        let busy = || start.elapsed() < Duration::from_millis(100);
        let deadline = start + Duration::from_millis(40);
        let mut control = AnalysisControl {
            cancelled: &cancelled,
            deadline,
            interactive_active: &busy,
        };
        control.file_boundary().unwrap();
        assert!(start.elapsed() >= Duration::from_millis(100));
        assert!(control.deadline >= deadline + Duration::from_millis(90));
        check(&cancelled, control.deadline).unwrap();
        control.deadline = Instant::now() - Duration::from_millis(1);
        control.interactive_active = &|| true;
        assert_eq!(
            control.file_boundary().unwrap_err().code,
            ErrorCode::Timeout
        );
    }

    #[test]
    fn cancellation_ends_an_indefinite_pause() {
        let cancelled = AtomicBool::new(false);
        let (tx, rx) = std::sync::mpsc::channel();
        let busy = || {
            let _ = tx.send(());
            true
        };
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                AnalysisControl {
                    cancelled: &cancelled,
                    deadline: Instant::now() + TIMEOUT,
                    interactive_active: &busy,
                }
                .file_boundary()
            });
            rx.recv_timeout(Duration::from_secs(1)).unwrap();
            let start = Instant::now();
            cancelled.store(true, Ordering::Release);
            assert_eq!(
                worker.join().unwrap().unwrap_err().code,
                ErrorCode::Cancelled
            );
            assert!(start.elapsed() < Duration::from_secs(1));
        });
    }
}
