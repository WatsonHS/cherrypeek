//! P5-01: operations the user triggers that write to the repository or use the network.
//!
//! This is the only module that builds a Git runner in operation mode. Each operation is a fixed
//! argument template; the caller supplies only validated names, never Git arguments.

use std::{
    ffi::OsString,
    path::Path,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

use commitscope_core::{ErrorCode, FetchRepositoryParams, FetchResult};

use crate::{
    details::{DetailError, now_unix_ms},
    git_command::{GitFailure, ReadOnlyGit, string_arg},
    session,
};

/// A fetch of a large repository over a slow link can take minutes; the user can cancel it.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(600);
const REMOTE_LIST_LIMIT: usize = 64 * 1024;
const MAX_REMOTES: usize = 64;
const MAX_REMOTE_NAME_BYTES: usize = 256;
const MAX_ERROR_CHARS: usize = 2000;

type OperationResult<T> = Result<T, DetailError>;

pub fn fetch_repository(
    executable: &Path,
    session: &session::RepositorySession,
    params: &FetchRepositoryParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> OperationResult<FetchResult> {
    let _guard = RepositoryOperationGuard::acquire(session)?;
    fetch_at(
        executable,
        Path::new(&session.discovered.info.path),
        params,
        cancelled,
        deadline,
    )
}

fn fetch_at(
    executable: &Path,
    directory: &Path,
    params: &FetchRepositoryParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> OperationResult<FetchResult> {
    let reader = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    let configured = list_remotes(&reader, directory, cancelled, deadline)?;
    if configured.is_empty() {
        return Err(operation_error(
            ErrorCode::InvalidRequest,
            "这个仓库没有配置远端，无法 fetch",
        ));
    }
    let remotes = match &params.remote {
        None => configured,
        Some(name) => {
            if !configured.contains(name) {
                return Err(operation_error(
                    ErrorCode::InvalidRequest,
                    "指定的远端不在这个仓库的远端列表里",
                ));
            }
            vec![name.clone()]
        }
    };

    let mut args: Vec<OsString> = ["fetch", "--quiet", "--no-recurse-submodules"]
        .into_iter()
        .map(string_arg)
        .collect();
    if params.prune {
        args.push(string_arg("--prune"));
    }
    match &params.remote {
        None => args.push(string_arg("--all")),
        Some(name) => {
            args.push(string_arg("--"));
            args.push(string_arg(name));
        }
    }
    let output = reader
        .for_operation()
        .run(directory, &args, None, 64 * 1024, cancelled, deadline)
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(operation_error(
            ErrorCode::GitError,
            &git_message(&output.stderr, "git fetch 失败"),
        ));
    }
    Ok(FetchResult {
        remotes,
        finished_at_unix_ms: now_unix_ms(),
    })
}

/// Remote names from the repository's configuration, read with the isolated read-only runner.
fn list_remotes(
    git: &ReadOnlyGit,
    directory: &Path,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> OperationResult<Vec<String>> {
    let output = git
        .run(
            directory,
            &[string_arg("remote")],
            None,
            REMOTE_LIST_LIMIT,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(operation_error(
            ErrorCode::GitError,
            &git_message(&output.stderr, "无法读取远端列表"),
        ));
    }
    let names: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|name| {
            // A name that could be read as an option never reaches a command line.
            !name.is_empty() && !name.starts_with('-') && name.len() <= MAX_REMOTE_NAME_BYTES
        })
        .map(str::to_owned)
        .collect();
    if names.len() > MAX_REMOTES {
        return Err(operation_error(
            ErrorCode::ResourceLimit,
            "远端数量超过上限，无法在这里 fetch",
        ));
    }
    Ok(names)
}

/// Git's own words, bounded; they are shown as untrusted text.
fn git_message(stderr: &[u8], fallback: &str) -> String {
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim();
    if text.is_empty() {
        return fallback.to_owned();
    }
    let mut message: String = text.chars().take(MAX_ERROR_CHARS).collect();
    if text.chars().count() > MAX_ERROR_CHARS {
        message.push('…');
    }
    message
}

fn operation_error(code: ErrorCode, message: &str) -> DetailError {
    DetailError {
        code,
        message: message.to_owned(),
        retryable: false,
    }
}

fn from_git(error: GitFailure) -> DetailError {
    match error {
        GitFailure::Cancelled => operation_error(ErrorCode::Cancelled, "操作已取消"),
        GitFailure::Timeout => operation_error(ErrorCode::Timeout, "操作超时，已停止"),
        GitFailure::ResourceLimit => {
            operation_error(ErrorCode::ResourceLimit, "Git 的输出超过上限，已停止")
        }
        GitFailure::Unavailable(message) => operation_error(ErrorCode::GitUnavailable, &message),
        GitFailure::CommandFailed(message) => operation_error(ErrorCode::GitError, &message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TestDir(PathBuf);

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn git_bin() -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|entry| entry.join(if cfg!(windows) { "git.exe" } else { "git" }))
            .find(|candidate| candidate.is_file())
            .expect("Git is available for the operation unit tests")
    }

    fn run(repository: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new(git_bin())
            .arg("-C")
            .arg(repository)
            .args([
                "-c",
                "user.name=Operation Test",
                "-c",
                "user.email=operation@example.invalid",
                "-c",
                "protocol.file.allow=always",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "commitscope-operations-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    fn commit(repository: &Path, file: &str, text: &str) {
        std::fs::write(repository.join(file), text).unwrap();
        run(repository, &["add", "."]);
        run(repository, &["commit", "--quiet", "-m", file]);
    }

    /// `upstream` with one commit on main and a `topic` branch, and a clone of it in `local`.
    fn fixture(label: &str) -> (PathBuf, PathBuf, TestDir) {
        let root = temp_root(label);
        let upstream = root.join("upstream");
        let local = root.join("local");
        std::fs::create_dir_all(&upstream).unwrap();
        run(&upstream, &["init", "--quiet", "-b", "main"]);
        commit(&upstream, "a.txt", "one\n");
        run(&upstream, &["branch", "topic"]);
        run(
            &root,
            &[
                "clone",
                "--quiet",
                upstream.to_str().unwrap(),
                local.to_str().unwrap(),
            ],
        );
        (upstream, local, TestDir(root))
    }

    fn fetch(local: &Path, remote: Option<&str>, prune: bool) -> OperationResult<FetchResult> {
        fetch_at(
            &git_bin(),
            local,
            &FetchRepositoryParams {
                remote: remote.map(str::to_owned),
                prune,
            },
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(30),
        )
    }

    /// Everything a fetch must leave alone: HEAD, local branches, the index and the working tree.
    fn local_state(local: &Path) -> (String, String, String, Vec<u8>) {
        (
            run(local, &["rev-parse", "HEAD"]),
            run(
                local,
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads",
                ],
            ),
            run(local, &["status", "--porcelain=v2", "--branch"]),
            std::fs::read(local.join(".git/index")).unwrap(),
        )
    }

    #[test]
    fn fetch_updates_remote_tracking_refs_and_nothing_local() {
        let (upstream, local, _guard) = fixture("fetch");
        commit(&upstream, "b.txt", "two\n");
        let new_tip = run(&upstream, &["rev-parse", "main"]);
        std::fs::write(local.join("dirty.txt"), "uncommitted").unwrap();
        let before = local_state(&local);
        assert_ne!(run(&local, &["rev-parse", "origin/main"]), new_tip);

        let result = fetch(&local, None, false).unwrap();

        assert_eq!(result.remotes, ["origin"]);
        assert_eq!(run(&local, &["rev-parse", "origin/main"]), new_tip);
        // `status --branch` reports the new behind count, so compare it without the branch header.
        let after = local_state(&local);
        assert_eq!(
            (&before.0, &before.1, &before.3),
            (&after.0, &after.1, &after.3)
        );
        assert!(after.2.contains("? dirty.txt"));
        assert_eq!(
            std::fs::read_to_string(local.join("dirty.txt")).unwrap(),
            "uncommitted"
        );
    }

    #[test]
    fn prune_is_opt_in() {
        let (upstream, local, _guard) = fixture("prune");
        run(&upstream, &["branch", "-D", "topic"]);
        fetch(&local, Some("origin"), false).unwrap();
        assert!(!run(&local, &["branch", "-r", "--list", "origin/topic"]).is_empty());
        fetch(&local, Some("origin"), true).unwrap();
        assert!(run(&local, &["branch", "-r", "--list", "origin/topic"]).is_empty());
    }

    #[test]
    fn a_repository_without_remotes_and_an_unknown_remote_are_refused_before_git_runs() {
        let (upstream, local, _guard) = fixture("refuse");
        assert_eq!(
            fetch(&upstream, None, false).unwrap_err().code,
            ErrorCode::InvalidRequest
        );
        for name in ["elsewhere", "--upload-pack=touch /tmp/x"] {
            assert_eq!(
                fetch(&local, Some(name), false).unwrap_err().code,
                ErrorCode::InvalidRequest
            );
        }
    }

    #[test]
    fn an_unreachable_remote_reports_git_s_words_and_leaves_the_repository_usable() {
        let (upstream, local, _guard) = fixture("unreachable");
        let moved = upstream.with_file_name("moved");
        std::fs::rename(&upstream, &moved).unwrap();
        let before = local_state(&local);
        let error = fetch(&local, None, false).unwrap_err();
        assert_eq!(error.code, ErrorCode::GitError);
        assert!(!error.message.is_empty());
        assert_eq!(before, local_state(&local));
        std::fs::rename(&moved, &upstream).unwrap();
        fetch(&local, None, false).unwrap();
    }

    #[test]
    fn a_cancelled_fetch_stops_without_running() {
        let (_upstream, local, _guard) = fixture("cancel");
        let error = fetch_at(
            &git_bin(),
            &local,
            &FetchRepositoryParams {
                remote: None,
                prune: false,
            },
            &AtomicBool::new(true),
            Instant::now() + Duration::from_secs(30),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
    }
}

use commitscope_core::{
    BranchSync, BranchSyncResult, BranchSyncState, DirtyOperationPath, GetBranchSyncParams,
    OperationBlocker as Blocker, OperationCheck, OperationCommit, OperationParams, OperationRun,
    RefTarget, RepositoryOperation as Operation, SwitchTarget, UpdatedRef,
};

struct Inspector<'a> {
    git: ReadOnlyGit,
    directory: &'a Path,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}
impl Inspector<'_> {
    fn output(&self, args: &[&str]) -> OperationResult<crate::git_command::CommandOutput> {
        self.git
            .run(
                self.directory,
                &args.iter().map(string_arg).collect::<Vec<_>>(),
                None,
                8 * 1024 * 1024,
                self.cancelled,
                self.deadline,
            )
            .map_err(from_git)
    }
    fn read(&self, args: &[&str]) -> OperationResult<Vec<u8>> {
        let output = self.output(args)?;
        if !output.status.success() {
            return Err(operation_error(
                ErrorCode::GitError,
                &git_message(&output.stderr, "Git 预检失败"),
            ));
        }
        Ok(output.stdout)
    }
    fn line(&self, args: &[&str]) -> OperationResult<String> {
        Ok(String::from_utf8_lossy(&self.read(args)?).trim().into())
    }
    fn oid(&self, name: &str) -> OperationResult<Option<String>> {
        let output = self.output(&[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{name}^{{commit}}"),
        ])?;
        Ok(output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned()))
    }
    fn counts(&self, left: &str, right: &str) -> OperationResult<(u64, u64)> {
        let text = self.line(&[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{left}...{right}"),
        ])?;
        let mut counts = text
            .split_whitespace()
            .filter_map(|s| s.parse::<u64>().ok());
        counts
            .next()
            .zip(counts.next())
            .ok_or_else(|| operation_error(ErrorCode::GitError, "Invalid ahead/behind counts"))
    }
    fn upstream(&self, name: &str) -> OperationResult<Option<String>> {
        let value = self.line(&["for-each-ref", "--format=%(refname)%00%(upstream)", name])?;
        Ok(value.lines().find_map(|s| {
            s.split_once('\0')
                .filter(|(n, u)| *n == name && !u.is_empty())
                .map(|(_, u)| u.into())
        }))
    }
}

pub fn get_branch_sync(
    executable: &Path,
    session: &session::RepositorySession,
    params: &GetBranchSyncParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> OperationResult<BranchSyncResult> {
    if params.ref_names.len() > 50 {
        return Err(operation_error(
            ErrorCode::InvalidRequest,
            "最多查询 50 个分支",
        ));
    }
    let navigation = session
        .discovered
        .navigation
        .as_ref()
        .map_err(|e| operation_error(e.code, &e.message))?;
    let inspector = Inspector {
        git: ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?,
        directory: Path::new(&session.discovered.info.path),
        cancelled,
        deadline,
    };
    let mut branches = Vec::new();
    for name in &params.ref_names {
        let reference = navigation
            .refs
            .iter()
            .find(|r| r.name == *name && name.starts_with("refs/heads/"))
            .ok_or_else(|| operation_error(ErrorCode::InvalidRequest, "分支不在冻结快照中"))?;
        let upstream = navigation
            .branch_upstreams
            .iter()
            .find(|r| r.ref_name == *name)
            .and_then(|u| {
                navigation
                    .refs
                    .iter()
                    .find(|r| r.name == u.upstream_ref_name)
            })
            .map(|r| RefTarget {
                ref_name: r.name.clone(),
                oid: r.oid.clone(),
            });
        let (ahead, behind, state) = if let Some(upstream) = &upstream {
            match inspector.counts(&reference.oid, &upstream.oid) {
                Ok((a, b)) => (
                    Some(a),
                    Some(b),
                    match (a, b) {
                        (0, 0) => BranchSyncState::UpToDate,
                        (0, _) => BranchSyncState::Behind,
                        (_, 0) => BranchSyncState::Ahead,
                        _ => BranchSyncState::Diverged,
                    },
                ),
                Err(e) if e.code == ErrorCode::Cancelled => return Err(e),
                Err(_) => (None, None, BranchSyncState::Unavailable),
            }
        } else {
            (
                None,
                None,
                if navigation
                    .branch_upstreams
                    .iter()
                    .any(|r| r.ref_name == *name)
                {
                    BranchSyncState::Unavailable
                } else {
                    BranchSyncState::NoUpstream
                },
            )
        };
        branches.push(BranchSync {
            ref_name: name.clone(),
            oid: reference.oid.clone(),
            upstream,
            ahead,
            behind,
            state,
            checked_out_by: navigation
                .worktrees
                .iter()
                .filter(|w| w.head_reference.as_deref() == Some(name))
                .map(|w| w.path.clone())
                .collect(),
        });
    }
    Ok(BranchSyncResult {
        branches,
        last_fetch_unix_ms: navigation.last_fetch_unix_ms,
    })
}

struct Prepared {
    check: OperationCheck,
    args: Vec<String>,
    updated: Option<UpdatedRef>,
}
fn invalid(message: &str) -> DetailError {
    operation_error(ErrorCode::InvalidRequest, message)
}
fn full_oid(oid: &str, length: usize) -> OperationResult<()> {
    if oid.len() != length || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("必须提供当前仓库格式的完整 OID"));
    }
    Ok(())
}
fn full_ref(name: &str, prefix: &str) -> OperationResult<()> {
    if !name.starts_with(prefix) || name.len() > 16384 || name.contains(['\0', '\n']) {
        return Err(invalid("必须提供完整分支引用名"));
    }
    Ok(())
}
fn dirty_paths(i: &Inspector<'_>) -> OperationResult<(Vec<DirtyOperationPath>, u32)> {
    let bytes = i.read(&[
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=none",
    ])?;
    let mut fields = bytes.split(|b| *b == 0).filter(|s| !s.is_empty());
    let mut paths = Vec::new();
    let mut visible_count = 0;
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            return Err(invalid("Invalid status record"));
        }
        let x = field[0];
        let y = field[1];
        // Ignored entries participate in overwrite checks, but are not uncommitted changes.
        // A rename contributes two safety paths and one visible file.
        if x != b'!' {
            visible_count += 1;
        }
        paths.push(DirtyOperationPath {
            path: crate::details::git_path(field[3..].to_vec()),
            staged: x != b' ' && x != b'?' && x != b'!',
            unstaged: y != b' ' && y != b'?' && y != b'!',
            untracked: x == b'?' || x == b'!',
        });
        if x == b'R' || x == b'C' || y == b'R' || y == b'C' {
            let old = fields
                .next()
                .ok_or_else(|| invalid("Invalid rename record"))?;
            paths.push(DirtyOperationPath {
                path: crate::details::git_path(old.to_vec()),
                staged: x != b' ',
                unstaged: y != b' ',
                untracked: false,
            });
        }
    }
    Ok((paths, visible_count))
}
fn dirty_blocker(mut paths: Vec<DirtyOperationPath>) -> Blocker {
    let paths_truncated = paths.len() > 50;
    paths.truncate(50);
    Blocker::Dirty {
        paths,
        paths_truncated,
    }
}
fn commit_examples(
    i: &Inspector<'_>,
    left: &str,
    right: &str,
) -> OperationResult<Vec<OperationCommit>> {
    let bytes = i.read(&[
        "log",
        "--max-count=10",
        "--format=%H%x00%s",
        &format!("{left}..{right}"),
    ])?;
    Ok(String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|s| {
            s.split_once('\0').map(|(oid, summary)| OperationCommit {
                oid: oid.into(),
                summary: summary.chars().take(500).collect(),
            })
        })
        .collect())
}
fn path_overlap(a: &[u8], b: &[u8]) -> bool {
    let a = a.strip_suffix(b"/").unwrap_or(a);
    let b = b.strip_suffix(b"/").unwrap_or(b);
    a == b
        || (a.starts_with(b) && a.get(b.len()) == Some(&b'/'))
        || (b.starts_with(a) && b.get(a.len()) == Some(&b'/'))
}
fn prepare(
    i: &Inspector<'_>,
    operation: &Operation,
    oid_length: usize,
) -> OperationResult<Prepared> {
    let mut p = Prepared {
        check: OperationCheck {
            allowed: false,
            blockers: Vec::new(),
            preserved_dirty_count: 0,
        },
        args: Vec::new(),
        updated: None,
    };
    if i.line(&["rev-parse", "--is-bare-repository"])? == "true" {
        p.check.blockers.push(Blocker::Bare);
        return Ok(p);
    }
    let git_dir = i.line(&["rev-parse", "--absolute-git-dir"])?;
    for (file, operation) in [
        ("MERGE_HEAD", "merge"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherryPick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_LOG", "bisect"),
        ("sequencer", "sequencer"),
    ] {
        if Path::new(&git_dir).join(file).exists() {
            p.check.blockers.push(Blocker::InProgress {
                operation: operation.into(),
            });
        }
    }
    if !p.check.blockers.is_empty() {
        return Ok(p);
    }
    let head = i.oid("HEAD")?;
    let head_ref = i.output(&["symbolic-ref", "--quiet", "HEAD"])?;
    let head_ref = String::from_utf8_lossy(&head_ref.stdout).trim().to_owned();
    let switching;
    let target;
    let branch;
    let mut new_name = None;
    match operation {
        Operation::FastForward {
            ref_name,
            expected_oid,
            upstream_oid,
        } => {
            full_ref(ref_name, "refs/heads/")?;
            if !i.output(&["check-ref-format", ref_name])?.status.success()
                || i.output(&["symbolic-ref", "--quiet", ref_name])?
                    .status
                    .success()
            {
                return Err(invalid("不支持该引用"));
            }
            full_oid(expected_oid, oid_length)?;
            full_oid(upstream_oid, oid_length)?;
            if i.oid(ref_name)?.as_deref() != Some(expected_oid) {
                p.check.blockers.push(Blocker::RefChanged);
                return Ok(p);
            }
            let Some(upstream) = i.upstream(ref_name)? else {
                p.check.blockers.push(Blocker::NoUpstream);
                return Ok(p);
            };
            if i.oid(&upstream)?.as_deref() != Some(upstream_oid) {
                p.check.blockers.push(Blocker::RefChanged);
                return Ok(p);
            }
            let (ahead, behind) = i.counts(expected_oid, upstream_oid)?;
            if ahead > 0 && behind > 0 {
                let local_commits = commit_examples(i, upstream_oid, expected_oid)?;
                let upstream_commits = commit_examples(i, expected_oid, upstream_oid)?;
                let base = i.line(&["merge-base", expected_oid, upstream_oid])?;
                let left = i.read(&[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--name-only",
                    "-z",
                    &base,
                    expected_oid,
                    "--",
                ])?;
                let right = i.read(&[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--name-only",
                    "-z",
                    &base,
                    upstream_oid,
                    "--",
                ])?;
                let mut overlap_paths: Vec<_> = left
                    .split(|b| *b == 0)
                    .filter(|a| {
                        !a.is_empty() && right.split(|b| *b == 0).any(|b| path_overlap(a, b))
                    })
                    .map(|p| crate::details::git_path(p.to_vec()))
                    .collect();
                let overlap_paths_truncated = overlap_paths.len() > 20;
                overlap_paths.truncate(20);
                p.check.blockers.push(Blocker::Diverged {
                    ahead,
                    behind,
                    local_commits,
                    upstream_commits,
                    local_commits_truncated: ahead > 10,
                    upstream_commits_truncated: behind > 10,
                    overlap_paths,
                    overlap_paths_truncated,
                });
                return Ok(p);
            }
            if ahead > 0 {
                p.check.blockers.push(Blocker::NotFastForward);
                return Ok(p);
            }
            target = upstream_oid.clone();
            branch = ref_name.clone();
            switching = head_ref == *ref_name;
            p.args = if switching {
                vec![
                    "merge".into(),
                    "--ff-only".into(),
                    "--no-edit".into(),
                    "--no-autostash".into(),
                    target.clone(),
                ]
            } else {
                vec![
                    "update-ref".into(),
                    ref_name.clone(),
                    target.clone(),
                    expected_oid.clone(),
                ]
            };
            p.updated = Some(UpdatedRef {
                ref_name: ref_name.clone(),
                old_oid: Some(expected_oid.clone()),
                new_oid: target.clone(),
            });
        }
        Operation::Switch {
            target: selected,
            expected_oid,
            expected_head_oid,
        } => {
            full_oid(expected_oid, oid_length)?;
            full_oid(expected_head_oid, oid_length)?;
            if head.as_deref() != Some(expected_head_oid) {
                p.check.blockers.push(Blocker::RefChanged);
                return Ok(p);
            }
            let reference = match selected {
                SwitchTarget::Local { ref_name } => {
                    full_ref(ref_name, "refs/heads/")?;
                    ref_name
                }
                SwitchTarget::Remote { remote_ref_name } => {
                    full_ref(remote_ref_name, "refs/remotes/")?;
                    remote_ref_name
                }
            };
            if !i.output(&["check-ref-format", reference])?.status.success()
                || i.output(&["symbolic-ref", "--quiet", reference])?
                    .status
                    .success()
            {
                return Err(invalid("不支持该引用"));
            }
            if i.oid(reference)?.as_deref() != Some(expected_oid) {
                p.check.blockers.push(Blocker::RefChanged);
                return Ok(p);
            }
            target = expected_oid.clone();
            switching = true;
            match selected {
                SwitchTarget::Local { ref_name } => {
                    branch = ref_name.clone();
                    p.args = vec![
                        "switch".into(),
                        "--no-guess".into(),
                        "--no-overwrite-ignore".into(),
                        "--no-recurse-submodules".into(),
                        "--".into(),
                        ref_name[11..].into(),
                    ];
                }
                SwitchTarget::Remote { remote_ref_name } => {
                    let remotes = list_remotes(&i.git, i.directory, i.cancelled, i.deadline)?;
                    let prefix = remotes
                        .iter()
                        .map(|r| format!("refs/remotes/{r}/"))
                        .filter(|r| remote_ref_name.starts_with(r))
                        .max_by_key(|r| r.len())
                        .ok_or_else(|| invalid("远端分支没有对应的远端"))?;
                    let name = remote_ref_name[prefix.len()..].to_owned();
                    branch = format!("refs/heads/{name}");
                    new_name = Some(name.clone());
                    p.args = vec![
                        "switch".into(),
                        "--no-overwrite-ignore".into(),
                        "--no-recurse-submodules".into(),
                        "--track=direct".into(),
                        "-c".into(),
                        name,
                        "--".into(),
                        remote_ref_name.clone(),
                    ];
                    p.updated = Some(UpdatedRef {
                        ref_name: branch.clone(),
                        old_oid: None,
                        new_oid: target.clone(),
                    });
                }
            }
        }
        Operation::CreateBranch {
            name,
            start_oid,
            switch_after,
            expected_head_oid,
        } => {
            full_oid(start_oid, oid_length)?;
            full_oid(expected_head_oid, oid_length)?;
            if head.as_deref() != Some(expected_head_oid)
                || i.oid(start_oid)?.as_deref() != Some(start_oid)
            {
                p.check.blockers.push(Blocker::RefChanged);
                return Ok(p);
            }
            target = start_oid.clone();
            branch = format!("refs/heads/{name}");
            new_name = Some(name.clone());
            switching = *switch_after;
            p.args = if switching {
                vec![
                    "switch".into(),
                    "--no-overwrite-ignore".into(),
                    "--no-recurse-submodules".into(),
                    "--no-track".into(),
                    "-c".into(),
                    name.clone(),
                    "--".into(),
                    target.clone(),
                ]
            } else {
                vec![
                    "branch".into(),
                    "--no-track".into(),
                    "--".into(),
                    name.clone(),
                    target.clone(),
                ]
            };
            p.updated = Some(UpdatedRef {
                ref_name: branch.clone(),
                old_oid: None,
                new_oid: target.clone(),
            });
        }
    }
    if let Some(name) = new_name {
        if name.is_empty()
            || name.len() > 16384
            || name.bytes().any(|b| b < 32 || b == 127)
            || name.starts_with(['-', '.'])
            || name == "HEAD"
            || !i.output(&["check-ref-format", &branch])?.status.success()
        {
            p.check.blockers.push(Blocker::NameInvalid);
            return Ok(p);
        }
        if i.output(&["show-ref", "--verify", "--quiet", &branch])?
            .status
            .success()
        {
            p.check.blockers.push(Blocker::NameExists);
            return Ok(p);
        }
        // Ref names also conflict when one is a directory prefix of the other.
        if i.line(&["for-each-ref", "--format=%(refname)", "refs/heads/"])?
            .lines()
            .any(|existing| path_overlap(existing.as_bytes(), branch.as_bytes()))
        {
            p.check.blockers.push(Blocker::NameExists);
            return Ok(p);
        }
    }
    let worktrees = i.read(&["worktree", "list", "--porcelain", "-z"])?;
    let mut worktree = String::new();
    for field in worktrees.split(|b| *b == 0) {
        if let Some(path) = field.strip_prefix(b"worktree ") {
            worktree = String::from_utf8_lossy(path).into();
        }
        if field.strip_prefix(b"branch ") == Some(branch.as_bytes())
            && Path::new(&worktree).canonicalize().ok() != i.directory.canonicalize().ok()
        {
            p.check.blockers.push(Blocker::CheckedOutElsewhere {
                worktree_path: worktree.clone(),
            });
        }
    }
    if !p.check.blockers.is_empty() {
        return Ok(p);
    }
    if switching {
        let Some(head) = &head else {
            p.check.blockers.push(Blocker::UnsafeState {
                message: "未出生的 HEAD 暂不支持此操作".into(),
            });
            return Ok(p);
        };
        let (paths, preserved_dirty_count) = dirty_paths(i)?;
        let changed = i.read(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "-z",
            head,
            &target,
            "--",
        ])?;
        // Conservatively reject intersecting dirty paths, including ignored/untracked directories.
        let affected: Vec<_> = paths
            .iter()
            .filter(|p| {
                changed
                    .split(|b| *b == 0)
                    .filter(|s| !s.is_empty())
                    .any(|c| path_overlap(&decode_hex(&p.path.raw_hex), c))
            })
            .cloned()
            .collect();
        if !affected.is_empty() {
            p.check.blockers.push(dirty_blocker(affected));
            return Ok(p);
        }
        if !i.read(&["ls-files", "--unmerged", "-z"])?.is_empty() {
            p.check.blockers.push(Blocker::UnsafeState {
                message: "index 中有未解决的冲突".into(),
            });
            return Ok(p);
        }
        // Hidden worktree modifications cannot be proven safe from status alone.
        let flags = i.read(&["ls-files", "-v", "-z"])?;
        if flags.split(|b| *b == 0).any(|r| {
            r.first()
                .is_some_and(|b| b.is_ascii_lowercase() || *b == b'S')
        }) {
            p.check.blockers.push(Blocker::UnsafeState {
                message: "包含 skip-worktree 或 assume-unchanged 条目，请交给 Agent".into(),
            });
            return Ok(p);
        }
        if matches!(operation, Operation::FastForward { .. }) && paths.iter().any(|p| p.staged) {
            p.check.blockers.push(dirty_blocker(
                paths.into_iter().filter(|p| p.staged).collect(),
            ));
            return Ok(p);
        }
        p.check.preserved_dirty_count = preserved_dirty_count;
    }
    p.check.allowed = true;
    Ok(p)
}
fn decode_hex(hex: &str) -> Vec<u8> {
    hex.as_bytes()
        .chunks_exact(2)
        .filter_map(|s| {
            std::str::from_utf8(s)
                .ok()
                .and_then(|s| u8::from_str_radix(s, 16).ok())
        })
        .collect()
}

pub fn check_operation(
    executable: &Path,
    session: &session::RepositorySession,
    params: &OperationParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> OperationResult<OperationCheck> {
    let i = Inspector {
        git: ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?,
        directory: Path::new(&session.discovered.info.path),
        cancelled,
        deadline,
    };
    Ok(prepare(&i, &params.operation, session.discovered.oid_length)?.check)
}

pub fn run_operation(
    executable: &Path,
    session: &session::RepositorySession,
    params: &OperationParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> OperationResult<OperationRun> {
    let _guard = RepositoryOperationGuard::acquire(session)?;
    let i = Inspector {
        git: ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?,
        directory: Path::new(&session.discovered.info.path),
        cancelled,
        deadline,
    };
    let prepared = prepare(&i, &params.operation, session.discovered.oid_length)?;
    if !prepared.check.allowed {
        return Ok(OperationRun::Rejected {
            blockers: prepared.check.blockers,
        });
    }
    if cancelled.load(std::sync::atomic::Ordering::Acquire) {
        return Err(from_git(GitFailure::Cancelled));
    }
    // Local writes cannot be cancelled halfway through an index/worktree update.
    let uncancellable = AtomicBool::new(false);
    let output = i
        .git
        .for_operation()
        .run(
            i.directory,
            &prepared.args.iter().map(string_arg).collect::<Vec<_>>(),
            None,
            64 * 1024,
            &uncancellable,
            Instant::now() + Duration::from_secs(120),
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(operation_error(
            ErrorCode::GitError,
            &git_message(&output.stderr, "Git 操作失败，请重新读取实际状态"),
        ));
    }
    let i = Inspector {
        cancelled: &uncancellable,
        deadline: Instant::now() + Duration::from_secs(10),
        ..i
    };
    let head_oid = i.oid("HEAD")?;
    let reference = i.output(&["symbolic-ref", "--quiet", "HEAD"])?;
    let head_reference = reference
        .status
        .success()
        .then(|| String::from_utf8_lossy(&reference.stdout).trim().to_owned());
    Ok(OperationRun::Done {
        head_oid,
        head_reference,
        updated_ref: prepared.updated,
    })
}

/// A lock in application data serializes writers across daemon processes / linked worktrees.
/// It never creates a lock file in the repository; OS locks are released after crashes as well.
struct RepositoryOperationGuard(std::fs::File);
impl RepositoryOperationGuard {
    #[cfg(unix)]
    fn acquire(session: &session::RepositorySession) -> OperationResult<Self> {
        use sha2::{Digest, Sha256};
        use std::os::{
            fd::AsRawFd,
            unix::fs::{MetadataExt, OpenOptionsExt},
        };
        let root = crate::session_store::SessionStore::from_env()
            .metadata_cache_root(&session.discovered.info)
            .map_err(|_| {
                operation_error(
                    ErrorCode::RepositoryUnavailable,
                    "操作锁的应用数据目录不可用",
                )
            })?;
        let key = Sha256::digest(session.info.repository_key.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let path = root.join(format!("operation-{key}.lock"));
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| {
                operation_error(ErrorCode::RepositoryUnavailable, "无法取得安全的操作锁")
            })?;
        let metadata = file
            .metadata()
            .map_err(|_| operation_error(ErrorCode::RepositoryUnavailable, "无法读取操作锁"))?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err(operation_error(
                ErrorCode::RepositoryUnavailable,
                "操作锁路径不安全",
            ));
        }
        // SAFETY: flock operates on this live owned descriptor, without dereferencing pointers.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(operation_error(
                ErrorCode::Busy,
                "另一个窗口正在操作这个仓库",
            ));
        }
        Ok(Self(file))
    }
    #[cfg(not(unix))]
    fn acquire(_session: &session::RepositorySession) -> OperationResult<Self> {
        Err(operation_error(
            ErrorCode::RepositoryUnavailable,
            "当前平台尚未实现跨进程仓库操作锁",
        ))
    }
}
impl Drop for RepositoryOperationGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: this guard owns the live descriptor until after drop returns.
            unsafe {
                libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}
