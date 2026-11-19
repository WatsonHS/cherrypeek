use crate::{
    git_command::{GitFailure, ReadOnlyGit, string_arg},
    repository::{self, DiscoveredRepository},
    session,
};
use commitscope_core::{
    ErrorCode, MergeStatus, RefInfo, RefKind, RefSnapshotChange, RefSnapshotChangeKind,
    RefSnapshotDiff, RepositoryObservation,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::atomic::AtomicBool,
    time::Instant,
};

const REF_DIFF_LIMIT: usize = 2_000;
const REF_DIFF_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const ADDED_COMMIT_LIMIT: usize = 20;

#[derive(Debug)]
pub struct UpdateError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

pub fn observe_repository(
    executable: &Path,
    session: &session::RepositorySession,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<RepositoryObservation, UpdateError> {
    let sequence = session.begin_observation();
    let discovered = repository::discover_repository(
        executable,
        &session.discovered.info.path,
        cancelled,
        deadline,
    )
    .map_err(from_preview)?;
    if discovered.info.common_dir != session.discovered.info.common_dir
        || discovered.info.worktree_path != session.discovered.info.worktree_path
    {
        return Err(update_error(
            ErrorCode::RepositoryUnavailable,
            "The observed path no longer identifies the open repository worktree",
            false,
        ));
    }
    let navigation = discovered.navigation.as_ref().map_err(|error| {
        update_error(error.code, &error.message, error.code == ErrorCode::Timeout)
    })?;
    let observed_at_unix_ms = navigation.observed_at_unix_ms;
    let refs_truncated = discovered.refs_truncated;
    let worktrees_truncated = navigation.worktrees_truncated;
    let snapshot = session
        .publish_observation(
            sequence,
            std::sync::Arc::new(discovered),
            observed_at_unix_ms,
        )
        .map_err(|error| update_error(error.code, &error.message, false))?
        .ok_or_else(|| {
            update_error(
                ErrorCode::Cancelled,
                "A newer repository observation superseded this request",
                false,
            )
        })?;
    Ok(RepositoryObservation {
        generation: snapshot.generation,
        observed_at_unix_ms: snapshot.observed_at_unix_ms,
        changed_ref_count: snapshot.changed_ref_count,
        worktrees_changed: snapshot.worktrees_changed,
        change_count: snapshot.change_count,
        refs_truncated,
        worktrees_truncated,
    })
}

pub fn diff_ref_snapshots(
    executable: &Path,
    session: &session::RepositorySession,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<RefSnapshotDiff, UpdateError> {
    let latest = session.latest_observation();
    let from = &session.discovered;
    let to = &latest.discovered;
    repository::verify_graph_fingerprint(from, cancelled, deadline).map_err(from_preview)?;
    repository::verify_graph_fingerprint(to, cancelled, deadline).map_err(from_preview)?;

    let old_refs = from
        .refs
        .iter()
        .map(|reference| (reference.name.as_str(), reference))
        .collect::<BTreeMap<_, _>>();
    let new_refs = to
        .refs
        .iter()
        .map(|reference| (reference.name.as_str(), reference))
        .collect::<BTreeMap<_, _>>();
    let names = old_refs
        .keys()
        .chain(new_refs.keys())
        .copied()
        .collect::<BTreeSet<_>>();
    let refs_complete = !from.refs_truncated && !to.refs_truncated;
    let mut changes = Vec::new();
    let mut truncated = false;
    for name in names {
        check_active(cancelled, deadline)?;
        let old = old_refs.get(name).copied();
        let new = new_refs.get(name).copied();
        if old
            .zip(new)
            .is_some_and(|(old, new)| ref_tip(old) == ref_tip(new))
        {
            continue;
        }
        if changes.len() == REF_DIFF_LIMIT {
            truncated = true;
            break;
        }
        let item = match (old, new) {
            (None, Some(new)) if refs_complete => RefSnapshotChange {
                name: name.to_owned(),
                kind: new.kind,
                change: RefSnapshotChangeKind::Created,
                old_oid: None,
                new_oid: Some(ref_tip(new).to_owned()),
                added_count: None,
                added_commits: Vec::new(),
                added_commits_truncated: false,
                replaced_count: None,
                deleted_merge_status: None,
            },
            (None, Some(new)) => unknown_change(name, new.kind, None, Some(ref_tip(new))),
            (Some(old), None) if refs_complete => {
                let deleted_merge_status =
                    deleted_merge_status(executable, from, old, cancelled, deadline)?;
                RefSnapshotChange {
                    name: name.to_owned(),
                    kind: old.kind,
                    change: RefSnapshotChangeKind::Deleted,
                    old_oid: Some(ref_tip(old).to_owned()),
                    new_oid: None,
                    added_count: None,
                    added_commits: Vec::new(),
                    added_commits_truncated: false,
                    replaced_count: None,
                    deleted_merge_status,
                }
            }
            (Some(old), None) => unknown_change(name, old.kind, Some(ref_tip(old)), None),
            (Some(old), Some(new)) => compare_ref(executable, from, old, new, cancelled, deadline)?,
            (None, None) => continue,
        };
        changes.push(item);
    }
    repository::verify_graph_fingerprint(from, cancelled, deadline).map_err(from_preview)?;
    repository::verify_graph_fingerprint(to, cancelled, deadline).map_err(from_preview)?;
    let worktrees_changed = latest.worktrees_changed;
    let complete = refs_complete && !truncated;
    Ok(RefSnapshotDiff {
        from_generation: session.info.generation.clone(),
        to_generation: latest.generation,
        observed_at_unix_ms: latest.observed_at_unix_ms,
        changes,
        truncated,
        complete,
        worktrees_changed,
    })
}

pub fn to_detail_error(error: UpdateError) -> crate::details::DetailError {
    crate::details::DetailError {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
    }
}

fn compare_ref(
    executable: &Path,
    discovered: &DiscoveredRepository,
    old: &RefInfo,
    new: &RefInfo,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<RefSnapshotChange, UpdateError> {
    let old_oid = ref_tip(old);
    let new_oid = ref_tip(new);
    if repository::history_boundary_limited(discovered) {
        return Ok(unknown_change(
            old.name.as_str(),
            new.kind,
            Some(old_oid),
            Some(new_oid),
        ));
    }
    match is_ancestor(
        executable, discovered, old_oid, new_oid, cancelled, deadline,
    )? {
        Some(true) => {
            let added_count = match rev_list_count(
                executable,
                discovered,
                &[new_oid, "--not", old_oid],
                cancelled,
                deadline,
            ) {
                Ok(count) => count,
                Err(error) if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) => {
                    return Err(error);
                }
                Err(_) => {
                    return Ok(unknown_change(
                        new.name.as_str(),
                        new.kind,
                        Some(old_oid),
                        Some(new_oid),
                    ));
                }
            };
            let oids = match rev_list_oids(
                executable,
                discovered,
                &[
                    "--topo-order",
                    "--reverse",
                    "--max-count=21",
                    new_oid,
                    "--not",
                    old_oid,
                ],
                cancelled,
                deadline,
            ) {
                Ok(oids) => oids,
                Err(error) if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) => {
                    return Err(error);
                }
                Err(_) => {
                    return Ok(unknown_change(
                        new.name.as_str(),
                        new.kind,
                        Some(old_oid),
                        Some(new_oid),
                    ));
                }
            };
            let added_commits_truncated = oids.len() > ADDED_COMMIT_LIMIT;
            let oids = oids
                .into_iter()
                .take(ADDED_COMMIT_LIMIT)
                .collect::<Vec<_>>();
            let added_commits = match repository::read_commit_summaries(
                executable, discovered, &oids, cancelled, deadline,
            ) {
                Ok(commits) => commits,
                Err(error) if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) => {
                    return Err(from_preview(error));
                }
                Err(_) => {
                    return Ok(unknown_change(
                        new.name.as_str(),
                        new.kind,
                        Some(old_oid),
                        Some(new_oid),
                    ));
                }
            };
            Ok(RefSnapshotChange {
                name: new.name.clone(),
                kind: new.kind,
                change: RefSnapshotChangeKind::FastForward,
                old_oid: Some(old_oid.to_owned()),
                new_oid: Some(new_oid.to_owned()),
                added_count: Some(added_count),
                added_commits,
                added_commits_truncated,
                replaced_count: None,
                deleted_merge_status: None,
            })
        }
        Some(false) => {
            let replaced_count = match rev_list_count(
                executable,
                discovered,
                &[old_oid, "--not", new_oid],
                cancelled,
                deadline,
            ) {
                Ok(count) => count,
                Err(error) if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) => {
                    return Err(error);
                }
                Err(_) => {
                    return Ok(unknown_change(
                        new.name.as_str(),
                        new.kind,
                        Some(old_oid),
                        Some(new_oid),
                    ));
                }
            };
            Ok(RefSnapshotChange {
                name: new.name.clone(),
                kind: new.kind,
                change: RefSnapshotChangeKind::Rewritten,
                old_oid: Some(old_oid.to_owned()),
                new_oid: Some(new_oid.to_owned()),
                added_count: None,
                added_commits: Vec::new(),
                added_commits_truncated: false,
                replaced_count: Some(replaced_count),
                deleted_merge_status: None,
            })
        }
        None => Ok(unknown_change(
            new.name.as_str(),
            new.kind,
            Some(old_oid),
            Some(new_oid),
        )),
    }
}

fn deleted_merge_status(
    executable: &Path,
    discovered: &DiscoveredRepository,
    deleted: &RefInfo,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<MergeStatus>, UpdateError> {
    if deleted.kind != RefKind::LocalBranch || repository::history_boundary_limited(discovered) {
        return Ok(None);
    }
    let Some(base_oid) = discovered
        .navigation
        .as_ref()
        .ok()
        .and_then(|navigation| navigation.default_base.as_ref())
        .map(|base| base.oid.as_str())
    else {
        return Ok(None);
    };
    match is_ancestor(
        executable,
        discovered,
        ref_tip(deleted),
        base_oid,
        cancelled,
        deadline,
    ) {
        Ok(Some(true)) => Ok(Some(MergeStatus::Merged)),
        Ok(Some(false)) => Ok(Some(MergeStatus::NotMerged)),
        Ok(None) => Ok(None),
        Err(error) if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) => Err(error),
        Err(_) => Ok(None),
    }
}

fn is_ancestor(
    executable: &Path,
    discovered: &DiscoveredRepository,
    older: &str,
    newer: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<bool>, UpdateError> {
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    let output = git
        .run(
            Path::new(&discovered.info.path),
            &[
                string_arg("-c"),
                string_arg("core.commitGraph=false"),
                string_arg("merge-base"),
                string_arg("--is-ancestor"),
                string_arg(older),
                string_arg(newer),
            ],
            None,
            1024,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    match output.status.code() {
        Some(0) => Ok(Some(true)),
        Some(1) => Ok(Some(false)),
        _ => Ok(None),
    }
}

fn rev_list_count(
    executable: &Path,
    discovered: &DiscoveredRepository,
    args: &[&str],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<u64, UpdateError> {
    let mut git_args = vec![
        string_arg("-c"),
        string_arg("core.commitGraph=false"),
        string_arg("rev-list"),
        string_arg("--count"),
    ];
    git_args.extend(args.iter().map(string_arg));
    let output = run_git(executable, discovered, &git_args, cancelled, deadline, 128)?;
    let count = std::str::from_utf8(&output.stdout)
        .map_err(|_| update_error(ErrorCode::GitError, "Git returned an invalid count", false))?
        .trim()
        .parse::<u64>()
        .map_err(|_| update_error(ErrorCode::GitError, "Git returned an invalid count", false))?;
    Ok(count)
}

fn rev_list_oids(
    executable: &Path,
    discovered: &DiscoveredRepository,
    args: &[&str],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<String>, UpdateError> {
    let mut git_args = vec![
        string_arg("-c"),
        string_arg("core.commitGraph=false"),
        string_arg("rev-list"),
    ];
    git_args.extend(args.iter().map(string_arg));
    let output = run_git(
        executable,
        discovered,
        &git_args,
        cancelled,
        deadline,
        REF_DIFF_OUTPUT_LIMIT,
    )?;
    let text = std::str::from_utf8(&output.stdout).map_err(|_| {
        update_error(
            ErrorCode::GitError,
            "Git returned invalid commit IDs",
            false,
        )
    })?;
    Ok(text.lines().map(str::to_owned).collect())
}

fn run_git(
    executable: &Path,
    discovered: &DiscoveredRepository,
    args: &[std::ffi::OsString],
    cancelled: &AtomicBool,
    deadline: Instant,
    limit: usize,
) -> Result<crate::git_command::CommandOutput, UpdateError> {
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    let output = git
        .run(
            Path::new(&discovered.info.path),
            args,
            None,
            limit,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(update_error(
            if repository::is_missing_object_diagnostic(&output.stderr) {
                ErrorCode::MissingObject
            } else {
                ErrorCode::GitError
            },
            "Git could not compare the reference snapshots completely",
            false,
        ))
    }
}

fn ref_tip(reference: &RefInfo) -> &str {
    reference.peeled_oid.as_deref().unwrap_or(&reference.oid)
}

fn unknown_change(
    name: &str,
    kind: RefKind,
    old: Option<&str>,
    new: Option<&str>,
) -> RefSnapshotChange {
    RefSnapshotChange {
        name: name.to_owned(),
        kind,
        change: RefSnapshotChangeKind::Unknown,
        old_oid: old.map(str::to_owned),
        new_oid: new.map(str::to_owned),
        added_count: None,
        added_commits: Vec::new(),
        added_commits_truncated: false,
        replaced_count: None,
        deleted_merge_status: None,
    }
}

fn from_preview(error: repository::PreviewError) -> UpdateError {
    update_error(error.code, &error.message, error.retryable)
}

fn from_git(error: GitFailure) -> UpdateError {
    match error {
        GitFailure::Cancelled => update_error(ErrorCode::Cancelled, "Request cancelled", false),
        GitFailure::Timeout => update_error(
            ErrorCode::Timeout,
            "Repository update check timed out",
            true,
        ),
        GitFailure::ResourceLimit => update_error(
            ErrorCode::ResourceLimit,
            "Git output exceeded a resource limit",
            false,
        ),
        GitFailure::Unavailable(message) => {
            update_error(ErrorCode::GitUnavailable, &message, false)
        }
        GitFailure::CommandFailed(message) => update_error(ErrorCode::GitError, &message, false),
    }
}

fn update_error(code: ErrorCode, message: &str, retryable: bool) -> UpdateError {
    UpdateError {
        code,
        message: message.to_owned(),
        retryable,
    }
}

fn check_active(cancelled: &AtomicBool, deadline: Instant) -> Result<(), UpdateError> {
    if cancelled.load(std::sync::atomic::Ordering::Acquire) {
        Err(update_error(
            ErrorCode::Cancelled,
            "Request cancelled",
            false,
        ))
    } else if Instant::now() >= deadline {
        Err(update_error(
            ErrorCode::Timeout,
            "Repository update check timed out",
            true,
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use commitscope_core::{RepositoryScope, SessionPersistenceStatus, StoreStatus};
    use std::{
        fs,
        path::PathBuf,
        process::{Command, Output},
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicU64, Ordering},
        },
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_REPO: AtomicU64 = AtomicU64::new(1);

    struct TestRepo(PathBuf);

    impl TestRepo {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "commitscope-updates-{}-{}",
                std::process::id(),
                NEXT_REPO.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            git(&path, &["init", "-q", "--initial-branch=main"]);
            git(&path, &["config", "user.name", "Update Test"]);
            git(&path, &["config", "user.email", "update@example.test"]);
            fs::write(path.join("file.txt"), "old\n").unwrap();
            git(&path, &["add", "file.txt"]);
            git(&path, &["commit", "-q", "-m", "initial"]);
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

    fn executable() -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|directory| directory.join("git"))
            .find(|path| path.is_file())
            .unwrap()
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

    #[test]
    fn observe_and_diff_preserve_browse_generation_and_report_fast_forward() {
        let repo = TestRepo::new();
        let executable = executable();
        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        let discovered = Arc::new(
            repository::discover_repository(
                &executable,
                repo.path().to_str().unwrap(),
                &cancelled,
                deadline,
            )
            .unwrap(),
        );
        let browse_generation = "browse-generation".to_owned();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let session = session::RepositorySession {
            info: commitscope_core::RepositorySessionInfo {
                repo_id: "repo-test".into(),
                generation: browse_generation.clone(),
                repository_key: "repo-key".into(),
                worktree_id: "worktree-id".into(),
                scope: RepositoryScope::Head,
                tips: discovered.scope_tips.clone(),
                observed_at_unix_ms: now,
                repository: discovered.info.clone(),
                previous_view: None,
                persistence: SessionPersistenceStatus {
                    recent: StoreStatus::Disabled,
                    last_seen: StoreStatus::Disabled,
                },
            },
            discovered: Arc::clone(&discovered),
            history: Arc::new(crate::history::HistoryState::new()),
            latest_observation: Arc::new(std::sync::Mutex::new(session::LatestObservationSlot {
                snapshot: session::LatestObservedSnapshot {
                    generation: browse_generation.clone(),
                    discovered,
                    observed_at_unix_ms: now,
                    changed_ref_count: 0,
                    worktrees_changed: false,
                    change_count: 0,
                },
                sequence: 0,
            })),
            excluded_tips_cache: Arc::new(std::sync::Mutex::new(Vec::new())),
        };

        fs::write(repo.path().join("file.txt"), "new\n").unwrap();
        git(repo.path(), &["add", "file.txt"]);
        git(repo.path(), &["commit", "-q", "-m", "advance"]);
        let observation = observe_repository(&executable, &session, &cancelled, deadline).unwrap();
        assert_eq!(observation.changed_ref_count, 1);
        assert_eq!(observation.change_count, 2);
        assert_ne!(observation.generation, browse_generation);
        assert_eq!(session.info.generation, browse_generation);

        let diff = diff_ref_snapshots(&executable, &session, &cancelled, deadline).unwrap();
        assert_eq!(diff.from_generation, browse_generation);
        assert_eq!(diff.to_generation, observation.generation);
        assert!(diff.complete);
        assert_eq!(diff.changes.len(), 1);
        assert_eq!(diff.changes[0].change, RefSnapshotChangeKind::FastForward);
        assert_eq!(diff.changes[0].added_count, Some(1));
        assert_eq!(diff.changes[0].added_commits.len(), 1);
        assert_eq!(diff.changes[0].added_commits[0].summary, "advance");
    }
}
