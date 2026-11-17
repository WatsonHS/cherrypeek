//! P5-01: operations the user triggers that write to the repository or use the network.
//!
//! This is the only module that builds a Git runner in operation mode. Each operation is a fixed
//! argument template; the caller supplies only validated names, never Git arguments.

mod untracked;
mod untracked_backup;

use std::{
    ffi::OsString,
    path::Path,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

use commitscope_core::{
    ErrorCode, FetchRepositoryParams, FetchResult, PushRepositoryParams, PushResult,
};

use crate::{
    details::{DetailError, now_unix_ms},
    git_command::{GitFailure, ReadOnlyGit, string_arg},
    session,
};

/// A fetch or push of a large repository over a slow link can take minutes; the user can cancel it.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(600);
pub const PUSH_TIMEOUT: Duration = Duration::from_secs(600);
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
    combined_git_message(stderr, &[], fallback)
}

fn combined_git_message(stderr: &[u8], stdout: &[u8], fallback: &str) -> String {
    let err = String::from_utf8_lossy(stderr).trim().to_owned();
    let out = String::from_utf8_lossy(stdout).trim().to_owned();
    let combined = match (err.is_empty(), out.is_empty()) {
        (true, true) => return fallback.to_owned(),
        (false, true) => err,
        (true, false) => out,
        (false, false) if err.contains(&out) => err,
        (false, false) => format!("{err}\n{out}"),
    };
    let mut message: String = combined.chars().take(MAX_ERROR_CHARS).collect();
    if combined.chars().count() > MAX_ERROR_CHARS {
        message.push('…');
    }
    message
}

fn push_rejection_detected(stdout: &[u8], stderr: &[u8]) -> bool {
    let out = String::from_utf8_lossy(stdout);
    if out.lines().any(|line| line.starts_with("!\t")) {
        return true;
    }
    let err = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    let out_lower = out.to_ascii_lowercase();
    [
        "[rejected]",
        "[remote rejected]",
        "non-fast-forward",
        "fetch first",
    ]
    .iter()
    .any(|needle| err.contains(needle) || out_lower.contains(needle))
}

pub fn push_repository(
    executable: &Path,
    session: &session::RepositorySession,
    params: &PushRepositoryParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> OperationResult<PushResult> {
    let _guard = RepositoryOperationGuard::acquire(session)?;
    push_at(
        executable,
        Path::new(&session.discovered.info.path),
        session.discovered.oid_length,
        params,
        cancelled,
        deadline,
    )
}

fn push_at(
    executable: &Path,
    directory: &Path,
    oid_length: usize,
    params: &PushRepositoryParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> OperationResult<PushResult> {
    let reader = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    let inspector = Inspector {
        git: reader,
        directory,
        cancelled,
        deadline,
    };
    full_ref(&params.ref_name, "refs/heads/")?;
    if !inspector
        .output(&["check-ref-format", &params.ref_name])?
        .status
        .success()
        || inspector
            .output(&["symbolic-ref", "--quiet", &params.ref_name])?
            .status
            .success()
    {
        return Err(invalid("不支持该引用"));
    }
    full_oid(&params.expected_oid, oid_length)?;
    if let Some(remote) = &params.remote
        && (remote.is_empty() || remote.starts_with('-') || remote.len() > MAX_REMOTE_NAME_BYTES)
    {
        return Err(invalid("远端名称无效"));
    }

    if inspector.oid(&params.ref_name)?.as_deref() != Some(&params.expected_oid) {
        return Ok(PushResult::Rejected {
            blockers: vec![Blocker::RefChanged],
        });
    }

    let configured = list_remotes(&inspector.git, directory, cancelled, deadline)?;
    if configured.is_empty() {
        return Err(operation_error(
            ErrorCode::InvalidRequest,
            "这个仓库没有配置远端，无法推送",
        ));
    }

    let upstream_raw = inspector.read(&[
        "for-each-ref",
        "--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)",
        &params.ref_name,
    ])?;
    let upstream_info = String::from_utf8_lossy(&upstream_raw)
        .lines()
        .find_map(|line| {
            let mut parts = line.split('\0');
            let ref_name = parts.next()?;
            if ref_name != params.ref_name {
                return None;
            }
            let full = parts.next().unwrap_or("").to_owned();
            let remote = parts.next().unwrap_or("").to_owned();
            let remote_ref = parts.next().unwrap_or("").to_owned();
            (!full.is_empty() && !remote.is_empty() && !remote_ref.is_empty())
                .then_some((full, remote, remote_ref))
        });

    let (remote_name, remote_merge_ref, target_tracking_ref, will_set_upstream) =
        if let Some((upstream_full, upstream_remote, upstream_ref)) = upstream_info {
            if !configured.contains(&upstream_remote) {
                return Err(invalid("当前分支的上游远端不在这个仓库的远端配置中"));
            }
            if let Some(req_remote) = &params.remote
                && req_remote != &upstream_remote
            {
                return Err(invalid("指定的远端与当前分支已配置的上游不一致"));
            }
            if let Some(u_oid) = inspector.oid(&upstream_full)? {
                let (ahead, behind) = inspector.counts(&params.expected_oid, &u_oid)?;
                if ahead > 0 && behind > 0 {
                    return Ok(PushResult::Rejected {
                        blockers: vec![build_diverged_blocker(
                            &inspector,
                            &params.expected_oid,
                            &u_oid,
                            ahead,
                            behind,
                        )?],
                    });
                }
                if ahead == 0 && behind > 0 {
                    return Ok(PushResult::Rejected {
                        blockers: vec![Blocker::NotFastForward],
                    });
                }
            }
            (upstream_remote, upstream_ref, upstream_full, false)
        } else {
            let Some(req_remote) = &params.remote else {
                return Ok(PushResult::Rejected {
                    blockers: vec![Blocker::NoUpstream],
                });
            };
            if !params.set_upstream {
                return Ok(PushResult::Rejected {
                    blockers: vec![Blocker::NoUpstream],
                });
            }
            if !configured.contains(req_remote) {
                return Err(invalid("指定的远端不在这个仓库的远端列表里"));
            }
            let short = &params.ref_name["refs/heads/".len()..];
            let tracking = format!("refs/remotes/{req_remote}/{short}");
            if let Some(u_oid) = inspector.oid(&tracking)? {
                let (ahead, behind) = inspector.counts(&params.expected_oid, &u_oid)?;
                if ahead > 0 && behind > 0 {
                    return Ok(PushResult::Rejected {
                        blockers: vec![build_diverged_blocker(
                            &inspector,
                            &params.expected_oid,
                            &u_oid,
                            ahead,
                            behind,
                        )?],
                    });
                }
                if ahead == 0 && behind > 0 {
                    return Ok(PushResult::Rejected {
                        blockers: vec![Blocker::NotFastForward],
                    });
                }
            }
            (req_remote.clone(), params.ref_name.clone(), tracking, true)
        };

    let refspec = format!("{}:{remote_merge_ref}", params.ref_name);
    let mut args = vec![
        string_arg("push"),
        string_arg("--porcelain"),
        string_arg("--no-recurse-submodules"),
        string_arg("--no-force-with-lease"),
        string_arg("--no-follow-tags"),
    ];
    if will_set_upstream {
        args.push(string_arg("--set-upstream"));
    }
    args.push(string_arg("--"));
    args.push(string_arg(&remote_name));
    args.push(string_arg(&refspec));

    let output = inspector
        .git
        .for_operation()
        .run(directory, &args, None, 256 * 1024, cancelled, deadline)
        .map_err(from_git)?;
    if !output.status.success() {
        if push_rejection_detected(&output.stdout, &output.stderr) {
            return Ok(PushResult::Rejected {
                blockers: vec![Blocker::RemoteRejected {
                    remote: remote_name,
                    message: combined_git_message(
                        &output.stderr,
                        &output.stdout,
                        "远端拒绝了推送（可能落后于远端分支或受分支保护限制）",
                    ),
                }],
            });
        }
        return Err(operation_error(
            ErrorCode::GitError,
            &combined_git_message(&output.stderr, &output.stdout, "git push 失败"),
        ));
    }

    let new_oid = inspector
        .oid(&target_tracking_ref)?
        .unwrap_or_else(|| params.expected_oid.clone());
    Ok(PushResult::Done {
        remote: remote_name,
        ref_name: params.ref_name.clone(),
        remote_ref_name: target_tracking_ref,
        new_oid,
        set_upstream: will_set_upstream,
        finished_at_unix_ms: now_unix_ms(),
    })
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
    fn check_budget(&self) -> OperationResult<()> {
        if self.cancelled.load(std::sync::atomic::Ordering::Acquire) {
            return Err(from_git(GitFailure::Cancelled));
        }
        if Instant::now() >= self.deadline {
            return Err(from_git(GitFailure::Timeout));
        }
        Ok(())
    }
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
    fn head_reference(&self) -> OperationResult<Option<String>> {
        let output = self.output(&["symbolic-ref", "--quiet", "HEAD"])?;
        Ok(output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned()))
    }

    fn head_matches(&self, expected: &UpdatedRef) -> OperationResult<bool> {
        Ok(
            self.head_reference()?.as_deref() == Some(expected.ref_name.as_str())
                && self.oid("HEAD")? == expected.old_oid,
        )
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

struct GitCommandSpec {
    args: Vec<OsString>,
    stdin: Option<Vec<u8>>,
    ignore_failure: bool,
    error_fallback: &'static str,
}

impl GitCommandSpec {
    fn from_strings(args: Vec<String>, error_fallback: &'static str) -> Self {
        Self {
            args: args.into_iter().map(OsString::from).collect(),
            stdin: None,
            ignore_failure: false,
            error_fallback,
        }
    }
}

struct Prepared {
    check: OperationCheck,
    commands: Vec<GitCommandSpec>,
    updated: Option<UpdatedRef>,
    replacement_files: Vec<untracked::Candidate>,
    verify_fast_forward_before_merge: Option<UpdatedRef>,
    read_committed_head: bool,
    prior_head_oid: Option<String>,
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
fn full_branch_or_remote_ref(name: &str) -> OperationResult<()> {
    if !(name.starts_with("refs/heads/") || name.starts_with("refs/remotes/"))
        || name.len() > 16384
        || name.contains(['\0', '\n'])
    {
        return Err(invalid("必须提供完整分支引用名"));
    }
    Ok(())
}
fn raw_path_os(bytes: Vec<u8>) -> OperationResult<OsString> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Ok(OsString::from_vec(bytes))
    }
    #[cfg(windows)]
    {
        String::from_utf8(bytes)
            .map(OsString::from)
            .map_err(|_| invalid("当前平台无法无损表示该仓库路径"))
    }
}
fn validate_workspace_path_hex(directory: &Path, hex: &str) -> OperationResult<Vec<u8>> {
    if hex.is_empty()
        || hex.len() > 32 * 1024
        || !hex.len().is_multiple_of(2)
        || !hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(invalid("工作区路径编码无效"));
    }
    let bytes = decode_hex(hex);
    let unsafe_component = |component: &[u8]| {
        component.is_empty()
            || component == b"."
            || component == b".."
            || component.eq_ignore_ascii_case(b".git")
    };
    if bytes.is_empty()
        || bytes.contains(&0)
        || (cfg!(windows) && (bytes.contains(&b'\\') || bytes.contains(&b':')))
        || bytes.split(|byte| *byte == b'/').any(unsafe_component)
    {
        return Err(invalid("路径必须位于当前工作区内"));
    }
    let root = directory
        .canonicalize()
        .map_err(|_| operation_error(ErrorCode::RepositoryUnavailable, "工作区目录不可用"))?;
    let parts: Vec<&[u8]> = bytes.split(|byte| *byte == b'/').collect();
    let mut ancestor = directory.to_path_buf();
    for component in &parts[..parts.len().saturating_sub(1)] {
        ancestor.push(crate::workspace::native_path(component));
        if std::fs::symlink_metadata(&ancestor).is_err() {
            break;
        }
        let Ok(canonical) = ancestor.canonicalize() else {
            return Err(invalid("路径必须位于当前工作区内"));
        };
        if !canonical.starts_with(&root) {
            return Err(invalid("路径不能通过符号链接越出工作区"));
        }
    }
    Ok(bytes)
}
fn build_diverged_blocker(
    i: &Inspector<'_>,
    left_oid: &str,
    right_oid: &str,
    ahead: u64,
    behind: u64,
) -> OperationResult<Blocker> {
    let local_commits = commit_examples(i, right_oid, left_oid)?;
    let upstream_commits = commit_examples(i, left_oid, right_oid)?;
    let merge_base = i.output(&["merge-base", left_oid, right_oid])?;
    let (overlap_paths, overlap_paths_truncated) = if merge_base.status.success() {
        let base = String::from_utf8_lossy(&merge_base.stdout)
            .trim()
            .to_owned();
        if base.is_empty() {
            (Vec::new(), false)
        } else {
            let left = i.read(&[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--name-only",
                "-z",
                &base,
                left_oid,
                "--",
            ])?;
            let right = i.read(&[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--name-only",
                "-z",
                &base,
                right_oid,
                "--",
            ])?;
            let right_paths = sorted_paths(&right);
            let mut overlap = Vec::new();
            for path in left.split(|b| *b == 0).filter(|path| !path.is_empty()) {
                i.check_budget()?;
                if overlaps_sorted_paths(&right_paths, path) {
                    overlap.push(crate::details::git_path(path.to_vec()));
                }
            }
            let truncated = overlap.len() > 20;
            overlap.truncate(20);
            (overlap, truncated)
        }
    } else {
        (Vec::new(), false)
    };
    Ok(Blocker::Diverged {
        ahead,
        behind,
        local_commits,
        upstream_commits,
        local_commits_truncated: ahead > 10,
        upstream_commits_truncated: behind > 10,
        overlap_paths,
        overlap_paths_truncated,
    })
}
fn ensure_index_clean(i: &Inspector<'_>) -> OperationResult<Option<Blocker>> {
    if !i.read(&["ls-files", "--unmerged", "-z"])?.is_empty() {
        return Ok(Some(Blocker::UnsafeState {
            message: "index 中有未解决的冲突".into(),
        }));
    }
    let flags = i.read(&["ls-files", "-v", "-z"])?;
    if flags.split(|b| *b == 0).any(|r| {
        r.first()
            .is_some_and(|b| b.is_ascii_lowercase() || *b == b'S')
    }) {
        return Ok(Some(Blocker::UnsafeState {
            message: "包含 skip-worktree 或 assume-unchanged 条目，请交给 Agent".into(),
        }));
    }
    Ok(None)
}
fn parse_single_status_record(bytes: &[u8], raw_path: &[u8]) -> OperationResult<Option<(u8, u8)>> {
    let mut fields = bytes.split(|b| *b == 0).filter(|s| !s.is_empty());
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            return Err(invalid("Invalid status record"));
        }
        let x = field[0];
        let y = field[1];
        let path = &field[3..];
        if x == b'R' || x == b'C' || y == b'R' || y == b'C' {
            let _old = fields
                .next()
                .ok_or_else(|| invalid("Invalid rename record"))?;
        }
        if path == raw_path {
            return Ok(Some((x, y)));
        }
    }
    Ok(None)
}
fn dirty_paths(i: &Inspector<'_>) -> OperationResult<(Vec<DirtyOperationPath>, Vec<Vec<u8>>)> {
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
    let mut visible_paths = Vec::new();
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            return Err(invalid("Invalid status record"));
        }
        let x = field[0];
        let y = field[1];
        // Ignored entries participate in overwrite checks, but are not uncommitted changes.
        // A rename contributes two safety paths and one visible file.
        if x != b'!' {
            visible_paths.push(field[3..].to_vec());
        }
        paths.push(DirtyOperationPath {
            path: crate::details::git_path(field[3..].to_vec()),
            staged: x != b' ' && x != b'?' && x != b'!',
            unstaged: y != b' ' && y != b'?' && y != b'!',
            untracked: x == b'?' || x == b'!',
            replace: None,
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
                replace: None,
            });
        }
    }
    Ok((paths, visible_paths))
}
const MAX_DIRTY_PATHS: usize = 50;

fn dirty_blocker(paths: Vec<DirtyOperationPath>) -> Blocker {
    dirty_blocker_with_token(paths, None)
}
fn dirty_blocker_with_token(
    mut paths: Vec<DirtyOperationPath>,
    replace_token: Option<String>,
) -> Blocker {
    let paths_truncated = paths.len() > MAX_DIRTY_PATHS;
    paths.truncate(MAX_DIRTY_PATHS);
    Blocker::Dirty {
        paths,
        paths_truncated,
        replace_token: if paths_truncated { None } else { replace_token },
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

/// Sort raw Git paths once. Lookups preserve exact bytes and component boundaries.
fn sorted_paths(bytes: &[u8]) -> Vec<&[u8]> {
    let mut paths: Vec<_> = bytes
        .split(|b| *b == 0)
        .filter(|path| !path.is_empty())
        .map(|path| path.strip_suffix(b"/").unwrap_or(path))
        .collect();
    paths.sort_unstable();
    paths.dedup();
    paths
}

fn overlaps_sorted_paths(paths: &[&[u8]], path: &[u8]) -> bool {
    let path = path.strip_suffix(b"/").unwrap_or(path);
    // A changed path can be this path or one of its parent components (file/directory replacement).
    if paths.binary_search(&path).is_ok()
        || path
            .iter()
            .enumerate()
            .filter(|(_, byte)| **byte == b'/')
            .any(|(end, _)| paths.binary_search(&&path[..end]).is_ok())
    {
        return true;
    }
    // Search from "path/", not "path": siblings such as "path.txt" sort before descendants.
    let mut prefix = path.to_vec();
    prefix.push(b'/');
    let index = paths.partition_point(|candidate| *candidate < prefix.as_slice());
    paths
        .get(index)
        .is_some_and(|candidate| candidate.starts_with(&prefix))
}
fn prepare(
    i: &Inspector<'_>,
    operation: &Operation,
    oid_length: usize,
) -> OperationResult<Prepared> {
    let head = i.oid("HEAD")?;
    let mut p = Prepared {
        check: OperationCheck {
            allowed: false,
            blockers: Vec::new(),
            preserved_dirty_count: 0,
            identical_untracked_count: 0,
        },
        commands: Vec::new(),
        updated: None,
        replacement_files: Vec::new(),
        verify_fast_forward_before_merge: None,
        read_committed_head: false,
        prior_head_oid: head.clone(),
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
    let head_ref = i.head_reference()?.unwrap_or_default();
    let mut switching = false;
    let mut reject_staged = false;
    let mut target = String::new();
    let mut check_other_worktree_branch: Option<String> = None;
    let mut new_name: Option<String> = None;
    let mut created_branch: Option<String> = None;
    match operation {
        Operation::FastForward {
            ref_name,
            expected_oid,
            upstream_oid,
            replace_untracked,
            discard_untracked,
        } => {
            if replace_untracked.is_some() && discard_untracked.is_some() {
                return Err(invalid("备份和丢弃只能选择一种"));
            }
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
                p.check.blockers.push(build_diverged_blocker(
                    i,
                    expected_oid,
                    upstream_oid,
                    ahead,
                    behind,
                )?);
                return Ok(p);
            }
            if ahead > 0 {
                p.check.blockers.push(Blocker::NotFastForward);
                return Ok(p);
            }
            target = upstream_oid.clone();
            check_other_worktree_branch = Some(ref_name.clone());
            switching = head_ref == *ref_name;
            reject_staged = switching;
            if (replace_untracked.is_some() || discard_untracked.is_some()) && !switching {
                p.check.blockers.push(Blocker::RefChanged);
                return Ok(p);
            }
            let args = if switching {
                vec![
                    "merge".into(),
                    "--ff-only".into(),
                    "--no-overwrite-ignore".into(),
                    "--no-squash".into(),
                    "--no-stat".into(),
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
            p.commands
                .push(GitCommandSpec::from_strings(args, "快进更新失败"));
            let updated = UpdatedRef {
                ref_name: ref_name.clone(),
                old_oid: Some(expected_oid.clone()),
                new_oid: target.clone(),
            };
            if switching {
                p.verify_fast_forward_before_merge = Some(updated.clone());
            }
            p.updated = Some(updated);
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
                    check_other_worktree_branch = Some(ref_name.clone());
                    p.commands.push(GitCommandSpec::from_strings(
                        vec![
                            "switch".into(),
                            "--no-guess".into(),
                            "--no-overwrite-ignore".into(),
                            "--no-recurse-submodules".into(),
                            "--".into(),
                            ref_name[11..].into(),
                        ],
                        "切换分支失败",
                    ));
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
                    let branch = format!("refs/heads/{name}");
                    check_other_worktree_branch = Some(branch.clone());
                    created_branch = Some(branch.clone());
                    new_name = Some(name.clone());
                    p.commands.push(GitCommandSpec::from_strings(
                        vec![
                            "switch".into(),
                            "--no-overwrite-ignore".into(),
                            "--no-recurse-submodules".into(),
                            "--track=direct".into(),
                            "-c".into(),
                            name,
                            "--".into(),
                            remote_ref_name.clone(),
                        ],
                        "切换分支失败",
                    ));
                    p.updated = Some(UpdatedRef {
                        ref_name: branch,
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
            let branch = format!("refs/heads/{name}");
            check_other_worktree_branch = Some(branch.clone());
            created_branch = Some(branch.clone());
            new_name = Some(name.clone());
            switching = *switch_after;
            let args = if switching {
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
            p.commands
                .push(GitCommandSpec::from_strings(args, "新建分支失败"));
            p.updated = Some(UpdatedRef {
                ref_name: branch,
                old_oid: None,
                new_oid: target.clone(),
            });
        }
        Operation::DeleteBranch {
            ref_name,
            expected_oid,
            base_ref_name,
        } => {
            full_ref(ref_name, "refs/heads/")?;
            full_branch_or_remote_ref(base_ref_name)?;
            if !i.output(&["check-ref-format", ref_name])?.status.success()
                || i.output(&["symbolic-ref", "--quiet", ref_name])?
                    .status
                    .success()
                || !i
                    .output(&["check-ref-format", base_ref_name])?
                    .status
                    .success()
                || i.output(&["symbolic-ref", "--quiet", base_ref_name])?
                    .status
                    .success()
            {
                return Err(invalid("不支持该引用"));
            }
            if ref_name == base_ref_name {
                return Err(invalid("不能删除基准分支"));
            }
            full_oid(expected_oid, oid_length)?;
            if i.oid(ref_name)?.as_deref() != Some(expected_oid) {
                p.check.blockers.push(Blocker::RefChanged);
                return Ok(p);
            }
            let worktrees = i.read(&["worktree", "list", "--porcelain", "-z"])?;
            let mut worktree = String::new();
            for field in worktrees.split(|b| *b == 0) {
                if let Some(path) = field.strip_prefix(b"worktree ") {
                    worktree = String::from_utf8_lossy(path).into();
                }
                if field.strip_prefix(b"branch ") == Some(ref_name.as_bytes()) {
                    p.check.blockers.push(Blocker::CheckedOutElsewhere {
                        worktree_path: worktree.clone(),
                    });
                }
            }
            if p.check.blockers.is_empty() && head_ref == *ref_name {
                p.check.blockers.push(Blocker::CheckedOutElsewhere {
                    worktree_path: i.directory.to_string_lossy().into_owned(),
                });
            }
            if !p.check.blockers.is_empty() {
                return Ok(p);
            }
            let Some(base_oid) = i.oid(base_ref_name)? else {
                p.check.blockers.push(Blocker::RefChanged);
                return Ok(p);
            };
            if !i
                .output(&["merge-base", "--is-ancestor", expected_oid, &base_oid])?
                .status
                .success()
            {
                p.check.blockers.push(Blocker::NotAncestorMerged {
                    base_ref_name: base_ref_name.clone(),
                });
                return Ok(p);
            }
            p.commands.push(GitCommandSpec::from_strings(
                vec![
                    "update-ref".into(),
                    "-d".into(),
                    ref_name.clone(),
                    expected_oid.clone(),
                ],
                "删除分支失败",
            ));
            let short = &ref_name["refs/heads/".len()..];
            p.commands.push(GitCommandSpec {
                args: vec![
                    string_arg("config"),
                    string_arg("--local"),
                    string_arg("--remove-section"),
                    OsString::from(format!("branch.{short}")),
                ],
                stdin: None,
                ignore_failure: true,
                error_fallback: "清理分支配置失败",
            });
        }
        Operation::FastForwardMerge {
            target_ref,
            expected_target_oid,
            source_ref,
            expected_source_oid,
            switch_to_target,
        } => {
            full_ref(target_ref, "refs/heads/")?;
            full_branch_or_remote_ref(source_ref)?;
            if target_ref == source_ref {
                return Err(invalid("目标分支和源分支不能相同"));
            }
            for reference in [target_ref, source_ref] {
                if !i.output(&["check-ref-format", reference])?.status.success()
                    || i.output(&["symbolic-ref", "--quiet", reference])?
                        .status
                        .success()
                {
                    return Err(invalid("不支持该引用"));
                }
            }
            full_oid(expected_target_oid, oid_length)?;
            full_oid(expected_source_oid, oid_length)?;
            if i.oid(target_ref)?.as_deref() != Some(expected_target_oid)
                || i.oid(source_ref)?.as_deref() != Some(expected_source_oid)
            {
                p.check.blockers.push(Blocker::RefChanged);
                return Ok(p);
            }
            let (target_only, source_only) = i.counts(expected_target_oid, expected_source_oid)?;
            if target_only > 0 && source_only > 0 {
                p.check.blockers.push(build_diverged_blocker(
                    i,
                    expected_target_oid,
                    expected_source_oid,
                    target_only,
                    source_only,
                )?);
                return Ok(p);
            }
            if source_only == 0 {
                p.check.blockers.push(Blocker::NotFastForward);
                return Ok(p);
            }
            target = expected_source_oid.clone();
            check_other_worktree_branch = Some(target_ref.clone());
            let target_is_head = head_ref == *target_ref;
            switching = target_is_head || *switch_to_target;
            reject_staged = target_is_head;
            if target_is_head {
                p.commands.push(GitCommandSpec::from_strings(
                    vec![
                        "merge".into(),
                        "--ff-only".into(),
                        "--no-overwrite-ignore".into(),
                        "--no-squash".into(),
                        "--no-stat".into(),
                        "--no-edit".into(),
                        "--no-autostash".into(),
                        expected_source_oid.clone(),
                    ],
                    "快进合入失败",
                ));
            } else {
                p.commands.push(GitCommandSpec::from_strings(
                    vec![
                        "update-ref".into(),
                        target_ref.clone(),
                        expected_source_oid.clone(),
                        expected_target_oid.clone(),
                    ],
                    "快进合入失败",
                ));
                if *switch_to_target {
                    p.commands.push(GitCommandSpec::from_strings(
                        vec![
                            "switch".into(),
                            "--no-guess".into(),
                            "--no-overwrite-ignore".into(),
                            "--no-recurse-submodules".into(),
                            "--".into(),
                            target_ref["refs/heads/".len()..].into(),
                        ],
                        "切换到目标分支失败",
                    ));
                }
            }
            p.updated = Some(UpdatedRef {
                ref_name: target_ref.clone(),
                old_oid: Some(expected_target_oid.clone()),
                new_oid: expected_source_oid.clone(),
            });
        }
        Operation::WorkspaceStage { paths_hex, all } => {
            if let Some(blocker) = ensure_index_clean(i)? {
                p.check.blockers.push(blocker);
                return Ok(p);
            }
            if *all {
                if !paths_hex.is_empty() {
                    return Err(invalid("全量暂存不能同时指定路径列表"));
                }
                p.commands.push(GitCommandSpec {
                    args: vec![
                        string_arg("--literal-pathspecs"),
                        string_arg("add"),
                        string_arg("-A"),
                    ],
                    stdin: None,
                    ignore_failure: false,
                    error_fallback: "暂存改动失败",
                });
            } else {
                if paths_hex.is_empty() || paths_hex.len() > 2000 {
                    return Err(invalid("请选择 1 至 2000 个文件路径"));
                }
                let mut stdin = Vec::new();
                for hex in paths_hex {
                    let bytes = validate_workspace_path_hex(i.directory, hex)?;
                    stdin.extend_from_slice(&bytes);
                    stdin.push(0);
                }
                p.commands.push(GitCommandSpec {
                    args: vec![
                        string_arg("--literal-pathspecs"),
                        string_arg("add"),
                        string_arg("-A"),
                        string_arg("--pathspec-from-file=-"),
                        string_arg("--pathspec-file-nul"),
                    ],
                    stdin: Some(stdin),
                    ignore_failure: false,
                    error_fallback: "暂存文件失败",
                });
            }
        }
        Operation::WorkspaceUnstage { paths_hex, all } => {
            if let Some(blocker) = ensure_index_clean(i)? {
                p.check.blockers.push(blocker);
                return Ok(p);
            }
            if *all {
                if !paths_hex.is_empty() {
                    return Err(invalid("全量取消暂存不能同时指定路径列表"));
                }
                if head.is_some() {
                    p.commands.push(GitCommandSpec {
                        args: vec![string_arg("reset"), string_arg("-q"), string_arg("HEAD")],
                        stdin: None,
                        ignore_failure: false,
                        error_fallback: "取消暂存失败",
                    });
                } else {
                    let cached = i.read(&["ls-files", "--cached", "-z"])?;
                    if !cached.is_empty() {
                        p.commands.push(GitCommandSpec {
                            args: vec![
                                string_arg("--literal-pathspecs"),
                                string_arg("rm"),
                                string_arg("--cached"),
                                string_arg("-q"),
                                string_arg("--ignore-unmatch"),
                                string_arg("--pathspec-from-file=-"),
                                string_arg("--pathspec-file-nul"),
                            ],
                            stdin: Some(cached),
                            ignore_failure: false,
                            error_fallback: "取消暂存失败",
                        });
                    }
                }
            } else {
                if paths_hex.is_empty() || paths_hex.len() > 2000 {
                    return Err(invalid("请选择 1 至 2000 个文件路径"));
                }
                let mut stdin = Vec::new();
                for hex in paths_hex {
                    let bytes = validate_workspace_path_hex(i.directory, hex)?;
                    stdin.extend_from_slice(&bytes);
                    stdin.push(0);
                }
                let args = if head.is_some() {
                    vec![
                        string_arg("--literal-pathspecs"),
                        string_arg("restore"),
                        string_arg("--staged"),
                        string_arg("--pathspec-from-file=-"),
                        string_arg("--pathspec-file-nul"),
                    ]
                } else {
                    vec![
                        string_arg("--literal-pathspecs"),
                        string_arg("rm"),
                        string_arg("--cached"),
                        string_arg("-q"),
                        string_arg("--ignore-unmatch"),
                        string_arg("--pathspec-from-file=-"),
                        string_arg("--pathspec-file-nul"),
                    ]
                };
                p.commands.push(GitCommandSpec {
                    args,
                    stdin: Some(stdin),
                    ignore_failure: false,
                    error_fallback: "取消暂存文件失败",
                });
            }
        }
        Operation::WorkspaceDiscard {
            path_hex,
            untracked,
            expected_head_oid,
        } => {
            if let Some(expected) = expected_head_oid {
                full_oid(expected, oid_length)?;
                if head.as_deref() != Some(expected.as_str()) {
                    p.check.blockers.push(Blocker::RefChanged);
                    return Ok(p);
                }
            }
            if let Some(blocker) = ensure_index_clean(i)? {
                p.check.blockers.push(blocker);
                return Ok(p);
            }
            let raw_path = validate_workspace_path_hex(i.directory, path_hex)?;
            let raw_os = raw_path_os(raw_path.clone())?;
            let user_git = i.git.with_user_config();
            let status_output = user_git
                .run(
                    i.directory,
                    &[
                        string_arg("--literal-pathspecs"),
                        string_arg("status"),
                        string_arg("--porcelain=v1"),
                        string_arg("-z"),
                        string_arg("--untracked-files=all"),
                        string_arg("--"),
                        raw_os.clone(),
                    ],
                    None,
                    1024 * 1024,
                    i.cancelled,
                    i.deadline,
                )
                .map_err(from_git)?;
            if !status_output.status.success() {
                return Err(operation_error(
                    ErrorCode::GitError,
                    &git_message(&status_output.stderr, "无法核对文件状态"),
                ));
            }
            let Some((x, y)) = parse_single_status_record(&status_output.stdout, &raw_path)? else {
                p.check.blockers.push(Blocker::RefChanged);
                return Ok(p);
            };
            if *untracked {
                let target_fs = i.directory.join(crate::workspace::native_path(&raw_path));
                let Ok(meta) = std::fs::symlink_metadata(&target_fs) else {
                    p.check.blockers.push(Blocker::RefChanged);
                    return Ok(p);
                };
                if x != b'?' || y != b'?' || meta.is_dir() {
                    p.check.blockers.push(Blocker::RefChanged);
                    return Ok(p);
                }
                p.commands.push(GitCommandSpec {
                    args: vec![
                        string_arg("--literal-pathspecs"),
                        string_arg("clean"),
                        string_arg("-f"),
                        string_arg("-q"),
                        string_arg("--"),
                        raw_os,
                    ],
                    stdin: None,
                    ignore_failure: false,
                    error_fallback: "删除未跟踪文件失败",
                });
            } else {
                if x == b'?' || x == b'!' || y == b' ' || y == b'?' || y == b'!' {
                    p.check.blockers.push(Blocker::RefChanged);
                    return Ok(p);
                }
                p.commands.push(GitCommandSpec {
                    args: vec![
                        string_arg("--literal-pathspecs"),
                        string_arg("restore"),
                        string_arg("--worktree"),
                        string_arg("--"),
                        raw_os,
                    ],
                    stdin: None,
                    ignore_failure: false,
                    error_fallback: "丢弃未暂存改动失败",
                });
            }
        }
        Operation::WorkspaceCommit {
            message,
            expected_head_oid,
        } => {
            if message.trim().is_empty() || message.len() > 65_536 || message.contains('\0') {
                return Err(invalid("请输入有效的提交说明"));
            }
            if let Some(expected) = expected_head_oid {
                full_oid(expected, oid_length)?;
                if head.as_deref() != Some(expected.as_str()) {
                    p.check.blockers.push(Blocker::RefChanged);
                    return Ok(p);
                }
            }
            if let Some(blocker) = ensure_index_clean(i)? {
                p.check.blockers.push(blocker);
                return Ok(p);
            }
            let has_staged = if head.is_some() {
                let output = i
                    .git
                    .with_user_config()
                    .run(
                        i.directory,
                        &[
                            string_arg("diff"),
                            string_arg("--cached"),
                            string_arg("--quiet"),
                            string_arg("--exit-code"),
                        ],
                        None,
                        1024,
                        i.cancelled,
                        i.deadline,
                    )
                    .map_err(from_git)?;
                match output.status.code() {
                    Some(0) => false,
                    Some(1) => true,
                    _ => {
                        return Err(operation_error(
                            ErrorCode::GitError,
                            &git_message(&output.stderr, "无法检查暂存区改动"),
                        ));
                    }
                }
            } else {
                !i.read(&["ls-files", "--cached", "-z"])?.is_empty()
            };
            if !has_staged {
                p.check.blockers.push(Blocker::UnsafeState {
                    message: "暂存区没有改动可提交，请先暂存文件".into(),
                });
                return Ok(p);
            }
            p.read_committed_head = true;
            p.commands.push(GitCommandSpec {
                args: vec![
                    string_arg("commit"),
                    string_arg("--quiet"),
                    string_arg("--cleanup=whitespace"),
                    string_arg("-F"),
                    string_arg("-"),
                ],
                stdin: Some(message.as_bytes().to_vec()),
                ignore_failure: false,
                error_fallback: "提交失败",
            });
        }
    }
    if let (Some(name), Some(branch)) = (new_name, created_branch) {
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
    if let Some(branch) = check_other_worktree_branch {
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
        let (paths, visible_dirty_paths) = dirty_paths(i)?;
        let changed = i.read(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--name-only",
            "-z",
            head,
            &target,
            "--",
        ])?;
        // Conservatively reject intersecting dirty paths, including ignored/untracked directories.
        let changed_paths = sorted_paths(&changed);
        p.check.preserved_dirty_count = visible_dirty_paths
            .iter()
            .filter(|path| !overlaps_sorted_paths(&changed_paths, path))
            .count()
            .min(u32::MAX as usize) as u32;
        let mut affected = Vec::new();
        for path in &paths {
            i.check_budget()?;
            let raw = decode_hex(&path.path.raw_hex);
            if overlaps_sorted_paths(&changed_paths, &raw) {
                affected.push(path.clone());
            }
        }
        if reject_staged && paths.iter().any(|p| p.staged) {
            p.check.blockers.push(dirty_blocker(
                paths.iter().filter(|p| p.staged).cloned().collect(),
            ));
            return Ok(p);
        }
        if let Some(blocker) = ensure_index_clean(i)? {
            p.check.blockers.push(blocker);
            return Ok(p);
        }
        if let Operation::FastForward {
            replace_untracked,
            discard_untracked,
            ..
        } = operation
        {
            let consent = replace_untracked.as_ref().or(discard_untracked.as_ref());
            if !affected.is_empty() {
                let comparison = untracked::compare(i, head, &target, affected)?;
                let mut blockers = comparison.blocked;
                let mut token = comparison.token.filter(|_| blockers.is_empty());
                for file in &comparison.files {
                    if file.identical {
                        p.check.identical_untracked_count += 1;
                    } else {
                        blockers.push(DirtyOperationPath {
                            path: crate::details::git_path(file.raw.clone()),
                            staged: false,
                            unstaged: false,
                            untracked: true,
                            replace: file.difference.clone(),
                        });
                    }
                }
                if blockers.is_empty() || blockers.len() > MAX_DIRTY_PATHS {
                    token = None;
                }
                let accepted = match consent {
                    Some(confirmed) => token.as_ref() == Some(confirmed),
                    None => blockers.is_empty(),
                };
                if !accepted {
                    p.check.blockers.push(if blockers.is_empty() {
                        Blocker::RefChanged
                    } else {
                        dirty_blocker_with_token(blockers, token)
                    });
                    return Ok(p);
                }
                p.replacement_files = comparison.files;
            } else if consent.is_some() {
                p.check.blockers.push(Blocker::RefChanged);
                return Ok(p);
            }
        } else if !affected.is_empty() {
            p.check.blockers.push(dirty_blocker(affected));
            return Ok(p);
        }
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
    let recovery_inspector = Inspector {
        cancelled: &uncancellable,
        deadline: Instant::now() + Duration::from_secs(120),
        ..i
    };
    let displacement = if prepared.replacement_files.is_empty() {
        None
    } else {
        Some(untracked_backup::displace(
            session,
            prepared.replacement_files,
        )?)
    };
    let updating_worktree = prepared.verify_fast_forward_before_merge.as_ref();
    if let Some(expected) = updating_worktree {
        let still_current = (|| -> OperationResult<bool> {
            if !recovery_inspector.head_matches(expected)? {
                return Ok(false);
            }
            let upstream = recovery_inspector.upstream(&expected.ref_name)?;
            let Some(upstream) = upstream else {
                return Ok(false);
            };
            Ok(recovery_inspector.oid(&upstream)?.as_deref() == Some(&expected.new_oid))
        })();
        if !matches!(still_current, Ok(true)) {
            if let Some(displacement) = displacement {
                // Git hasn't run. Only restore into paths that are still vacant.
                displacement.restore()?;
            }
            still_current?;
            return Ok(OperationRun::Rejected {
                blockers: vec![Blocker::RefChanged],
            });
        }
    }
    let write_deadline = Instant::now() + Duration::from_secs(120);
    let write: OperationResult<()> = (|| {
        for command in &prepared.commands {
            let output = recovery_inspector
                .git
                .for_operation()
                .run(
                    recovery_inspector.directory,
                    &command.args,
                    command.stdin.as_deref(),
                    64 * 1024,
                    &uncancellable,
                    write_deadline,
                )
                .map_err(from_git)?;
            if !output.status.success() && !command.ignore_failure {
                return Err(operation_error(
                    ErrorCode::GitError,
                    &combined_git_message(&output.stderr, &output.stdout, command.error_fallback),
                ));
            }
        }
        Ok(())
    })();
    if let Err(failure) = write {
        if let Some(displacement) = displacement {
            if updating_worktree
                .is_some_and(|expected| recovery_inspector.head_matches(expected).unwrap_or(false))
            {
                if let Err(error) = displacement.restore() {
                    return Err(operation_error(
                        failure.code,
                        &format!("{}；{}", failure.message, error.message),
                    ));
                }
            } else {
                return Err(operation_error(
                    failure.code,
                    &format!(
                        "{}；仓库状态已变化或无法确认，本地副本保留在 {}",
                        failure.message,
                        displacement.recovery_path().display()
                    ),
                ));
            }
        }
        return Err(failure);
    }
    let final_head = recovery_inspector
        .oid("HEAD")
        .and_then(|oid| Ok((oid, recovery_inspector.head_reference()?)));
    let (head_oid, head_reference) = match (final_head, &displacement) {
        (Ok(head), _) => head,
        (Err(error), Some(displacement)) => {
            return Err(operation_error(
                error.code,
                &format!(
                    "快进命令已完成，无法读取最新状态：{}。本地副本保留在 {}",
                    error.message,
                    displacement.recovery_path().display()
                ),
            ));
        }
        (Err(error), None) => return Err(error),
    };
    if let (Some(expected), Some(files)) = (updating_worktree, displacement.as_ref())
        && (head_reference.as_deref() != Some(&expected.ref_name)
            || head_oid.as_deref() != Some(&expected.new_oid))
    {
        return Err(operation_error(
            ErrorCode::GitError,
            &format!(
                "执行后工作区分支与预期不符，本地副本保留在 {}",
                files.recovery_path().display()
            ),
        ));
    }
    let discard = matches!(
        &params.operation,
        Operation::FastForward {
            discard_untracked: Some(_),
            ..
        }
    );
    let untracked = displacement
        .map(|files| files.finish(discard))
        .transpose()?;
    let (committed_oid, updated_ref) = if prepared.read_committed_head {
        let committed = head_oid.clone();
        let updated = match (&head_reference, &committed) {
            (Some(ref_name), Some(new_oid)) => Some(UpdatedRef {
                ref_name: ref_name.clone(),
                old_oid: prepared.prior_head_oid,
                new_oid: new_oid.clone(),
            }),
            _ => None,
        };
        (committed, updated)
    } else {
        (None, prepared.updated)
    };
    Ok(OperationRun::Done {
        head_oid,
        head_reference,
        updated_ref,
        untracked,
        committed_oid,
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

    #[test]
    fn sorted_path_lookup_matches_component_overlap_for_all_small_subsets() {
        let candidates: &[&[u8]] = &[
            b"src",
            b"src/",
            b"src/a",
            b"src/a/b",
            b"src-a",
            b"src.txt",
            b"src0",
            b"src/\xff",
            b"\xfe/name",
            b"other/file",
        ];
        for mask in 0..(1 << candidates.len()) {
            let selected: Vec<_> = candidates
                .iter()
                .enumerate()
                .filter(|(bit, _)| mask & (1 << bit) != 0)
                .map(|(_, path)| *path)
                .collect();
            let mut bytes = Vec::new();
            for path in &selected {
                bytes.extend_from_slice(path);
                bytes.push(0);
            }
            let sorted = sorted_paths(&bytes);
            for path in candidates {
                assert_eq!(
                    overlaps_sorted_paths(&sorted, path),
                    selected.iter().any(|other| path_overlap(other, path)),
                    "mask={mask}, path={path:?}",
                );
            }
        }
    }

    #[test]
    fn path_preflight_honours_cancellation_and_deadline() {
        let cancelled = AtomicBool::new(true);
        let mut inspector = Inspector {
            git: ReadOnlyGit::new(git_bin()).unwrap(),
            directory: Path::new("."),
            cancelled: &cancelled,
            deadline: Instant::now() + Duration::from_secs(30),
        };
        assert_eq!(
            inspector.check_budget().unwrap_err().code,
            ErrorCode::Cancelled
        );
        cancelled.store(false, std::sync::atomic::Ordering::Release);
        inspector.deadline = Instant::now();
        assert_eq!(
            inspector.check_budget().unwrap_err().code,
            ErrorCode::Timeout
        );
    }

    #[test]
    fn push_supports_ahead_and_set_upstream_and_refuses_non_fast_forward() {
        let root = temp_root("push");
        let _guard = TestDir(root.clone());
        let bare = root.join("bare.git");
        let seed = root.join("seed");
        let local = root.join("local");
        std::fs::create_dir_all(&bare).unwrap();
        run(&bare, &["init", "--quiet", "--bare", "-b", "main"]);
        run(
            &root,
            &[
                "clone",
                "--quiet",
                bare.to_str().unwrap(),
                seed.to_str().unwrap(),
            ],
        );
        commit(&seed, "a.txt", "one\n");
        run(&seed, &["push", "--quiet", "-u", "origin", "main"]);
        run(
            &root,
            &[
                "clone",
                "--quiet",
                bare.to_str().unwrap(),
                local.to_str().unwrap(),
            ],
        );

        commit(&local, "b.txt", "two\n");
        let head_main = run(&local, &["rev-parse", "refs/heads/main"]);
        let pushed = push_at(
            &git_bin(),
            &local,
            40,
            &PushRepositoryParams {
                ref_name: "refs/heads/main".into(),
                expected_oid: head_main.clone(),
                remote: None,
                set_upstream: false,
            },
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(30),
        )
        .unwrap();
        assert!(matches!(
            pushed,
            PushResult::Done {
                set_upstream: false,
                ..
            }
        ));
        assert_eq!(run(&bare, &["rev-parse", "refs/heads/main"]), head_main);

        run(&local, &["checkout", "--quiet", "-b", "feat"]);
        commit(&local, "c.txt", "feat\n");
        let feat_oid = run(&local, &["rev-parse", "refs/heads/feat"]);
        let published = push_at(
            &git_bin(),
            &local,
            40,
            &PushRepositoryParams {
                ref_name: "refs/heads/feat".into(),
                expected_oid: feat_oid.clone(),
                remote: Some("origin".into()),
                set_upstream: true,
            },
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(30),
        )
        .unwrap();
        assert!(matches!(
            published,
            PushResult::Done {
                set_upstream: true,
                ..
            }
        ));
        assert_eq!(run(&bare, &["rev-parse", "refs/heads/feat"]), feat_oid);

        // Remote advances via seed; local commits on main and pushes without fetching first -> RemoteRejected.
        run(&local, &["checkout", "--quiet", "main"]);
        run(&seed, &["pull", "--ff-only", "--quiet", "origin", "main"]);
        commit(&seed, "seed.txt", "remote ahead\n");
        run(&seed, &["push", "--quiet", "origin", "main"]);
        let remote_main = run(&bare, &["rev-parse", "refs/heads/main"]);
        commit(&local, "local.txt", "local ahead\n");
        let local_main = run(&local, &["rev-parse", "refs/heads/main"]);
        let rejected = push_at(
            &git_bin(),
            &local,
            40,
            &PushRepositoryParams {
                ref_name: "refs/heads/main".into(),
                expected_oid: local_main,
                remote: None,
                set_upstream: false,
            },
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(30),
        )
        .unwrap();
        match rejected {
            PushResult::Rejected { blockers } => {
                assert!(matches!(
                    blockers.as_slice(),
                    [Blocker::RemoteRejected { remote, .. }] if remote == "origin"
                ));
            }
            PushResult::Done { .. } => panic!("non-fast-forward push must not overwrite remote"),
        }
        assert_eq!(run(&bare, &["rev-parse", "refs/heads/main"]), remote_main);
    }
}
