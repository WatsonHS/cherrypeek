use crate::{
    git_command::{GitFailure, ReadOnlyGit, string_arg},
    repository, session,
};
use commitscope_core::{
    BranchesContainingParams, BranchesContainingResult, ChangedFile, ChangedFileStatus,
    ChangedFilesPage, CommitDetails, CommitUpdate, CommitUpdateState, ErrorCode, FileDiff,
    FileDiffKind, GetCommitParams, GitPath, ListChangedFilesParams, MergeCommitsPage,
    ReadDiffParams, ReadMergeCommitsParams, RefInfo, RefKind, Trailer, WorktreeInfo,
};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::atomic::AtomicBool,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const DIFF_FILE_LIMIT: usize = 20_000;
const DIFF_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const PATH_LIMIT: usize = 16 * 1024;
const MERGE_COMMIT_LIMIT: usize = 10_000;
const MERGE_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
pub(crate) const FILE_DIFF_BLOB_LIMIT: u64 = 2 * 1024 * 1024;
pub(crate) const FILE_DIFF_PATCH_LIMIT: usize = 128 * 1024;
pub(crate) const FILE_DIFF_LINE_LIMIT: usize = 2_000;
pub(crate) const FILE_DIFF_LINE_BYTES: usize = 32 * 1024;
/// Whole-file diffs (P4-11): the new side may have at most this many lines, and the patch must fit the response.
pub(crate) const FULL_FILE_LINE_LIMIT: usize = 5_000;
pub(crate) const FULL_FILE_PATCH_LIMIT: usize = 400 * 1024;
/// Enough context lines to cover any file within the whole-file limit.
pub(crate) const FULL_FILE_CONTEXT: usize = 100_000;

#[derive(Debug)]
pub struct DetailError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

type DetailResult<T> = Result<T, DetailError>;

pub fn get_commit(
    executable: &Path,
    session: &session::RepositorySession,
    params: &GetCommitParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<CommitDetails> {
    validate_oid(&params.oid, session.discovered.oid_length)?;
    let oid = params.oid.to_ascii_lowercase();
    let mut parsed = repository::read_commit_metadata(
        executable,
        &session.discovered,
        std::slice::from_ref(&oid),
        cancelled,
        deadline,
    )
    .map_err(from_preview)?;
    let parsed = parsed.pop().ok_or_else(|| {
        detail_error(
            ErrorCode::MissingObject,
            "Commit object was not found",
            false,
        )
    })?;
    let (trailers, message_without_trailers) = parse_trailers(
        executable,
        &session.discovered.info.path,
        &parsed.message,
        cancelled,
        deadline,
    )?;
    let navigation = session.discovered.navigation.as_ref().ok();
    let refs: Vec<RefInfo> = session
        .discovered
        .refs
        .iter()
        .filter(|reference| {
            reference.oid.eq_ignore_ascii_case(&oid)
                || reference
                    .peeled_oid
                    .as_deref()
                    .is_some_and(|peeled| peeled.eq_ignore_ascii_case(&oid))
        })
        .cloned()
        .collect();
    let worktrees: Vec<WorktreeInfo> = navigation
        .into_iter()
        .flat_map(|navigation| navigation.worktrees.iter())
        .filter(|worktree| {
            worktree
                .head_oid
                .as_deref()
                .is_some_and(|head| head.eq_ignore_ascii_case(&oid))
        })
        .cloned()
        .collect();
    let update = check_scope_update(executable, session, &oid, cancelled, deadline)?;
    Ok(CommitDetails {
        commit: parsed.summary,
        message: parsed.message,
        message_without_trailers,
        trailers,
        refs,
        worktrees,
        observed_at_unix_ms: session.info.observed_at_unix_ms,
        refs_truncated: session.discovered.refs_truncated,
        worktrees_truncated: navigation.is_none_or(|navigation| navigation.worktrees_truncated),
        update,
    })
}

enum ScopeTipsSnapshot {
    Tips(Vec<String>),
    Unavailable,
    Inconclusive,
}

fn check_scope_update(
    executable: &Path,
    session: &session::RepositorySession,
    oid: &str,
    cancelled: &AtomicBool,
    request_deadline: Instant,
) -> DetailResult<CommitUpdate> {
    let checked_at = now_unix_ms();
    let hint_deadline = request_deadline.min(Instant::now() + std::time::Duration::from_secs(1));
    let unknown = || CommitUpdate {
        state: CommitUpdateState::Unknown,
        reason: None,
        checked_at_unix_ms: checked_at,
    };
    if repository::verify_graph_fingerprint(&session.discovered, cancelled, hint_deadline).is_err()
    {
        return if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            Err(from_git(GitFailure::Cancelled))
        } else {
            Ok(unknown())
        };
    }
    let old = reachability(
        executable,
        &session.discovered.info.path,
        oid,
        &session.discovered.scope_tips,
        session.discovered.oid_length,
        repository::history_boundary_limited(&session.discovered),
        session.discovered.refs_truncated,
        cancelled,
        hint_deadline,
    );
    let old = match old {
        Ok(Some(true)) => true,
        Ok(Some(false)) | Ok(None) => return Ok(unknown()),
        Err(error) if error.code == ErrorCode::Cancelled => return Err(error),
        Err(_) => return Ok(unknown()),
    };
    if !old {
        return Ok(unknown());
    }
    if repository::verify_graph_fingerprint(&session.discovered, cancelled, hint_deadline).is_err()
    {
        return if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            Err(from_git(GitFailure::Cancelled))
        } else {
            Ok(unknown())
        };
    }
    let tips = match live_scope_tips(executable, session, cancelled, hint_deadline) {
        Ok(ScopeTipsSnapshot::Unavailable) => {
            return Ok(CommitUpdate {
                state: CommitUpdateState::Affected,
                reason: Some(commitscope_core::CommitUpdateReason::ScopeUnavailable),
                checked_at_unix_ms: checked_at,
            });
        }
        Ok(ScopeTipsSnapshot::Inconclusive) => return Ok(unknown()),
        Ok(ScopeTipsSnapshot::Tips(tips)) => tips,
        Err(error) if error.code == ErrorCode::Cancelled => return Err(error),
        Err(_) => return Ok(unknown()),
    };
    let live_reachable = reachability(
        executable,
        &session.discovered.info.path,
        oid,
        &tips,
        session.discovered.oid_length,
        repository::history_boundary_limited(&session.discovered),
        false,
        cancelled,
        hint_deadline,
    );
    if repository::verify_graph_fingerprint(&session.discovered, cancelled, hint_deadline).is_err()
    {
        return if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            Err(from_git(GitFailure::Cancelled))
        } else {
            Ok(unknown())
        };
    }
    match live_reachable {
        Ok(Some(true)) => Ok(CommitUpdate {
            state: CommitUpdateState::Unaffected,
            reason: None,
            checked_at_unix_ms: checked_at,
        }),
        Ok(Some(false)) => Ok(CommitUpdate {
            state: CommitUpdateState::Affected,
            reason: Some(commitscope_core::CommitUpdateReason::NoLongerReachable),
            checked_at_unix_ms: checked_at,
        }),
        Ok(None) => Ok(unknown()),
        Err(error) if error.code == ErrorCode::Cancelled => Err(error),
        Err(_) => Ok(unknown()),
    }
}

fn live_scope_tips(
    executable: &Path,
    session: &session::RepositorySession,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<ScopeTipsSnapshot> {
    use commitscope_core::RepositoryScope;
    let path = Path::new(&session.discovered.info.path);
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    match &session.info.scope {
        RepositoryScope::Head => resolve_live_ref_tip(
            &git,
            path,
            "HEAD",
            session.discovered.oid_length,
            cancelled,
            deadline,
        ),
        RepositoryScope::Ref(name) => {
            if !session
                .discovered
                .refs
                .iter()
                .any(|reference| &reference.name == name)
                || !name.starts_with("refs/")
            {
                return Ok(ScopeTipsSnapshot::Inconclusive);
            }
            resolve_live_ref_tip(
                &git,
                path,
                name,
                session.discovered.oid_length,
                cancelled,
                deadline,
            )
        }
        RepositoryScope::AllBranches => {
            let format = "--format=%(objectname)%00%(refname)%00";
            let output = git
                .run(
                    path,
                    &[
                        string_arg("for-each-ref"),
                        string_arg("--count=2001"),
                        string_arg(format),
                        string_arg("refs/heads"),
                        string_arg("refs/remotes"),
                    ],
                    None,
                    16 * 1024 * 1024,
                    cancelled,
                    deadline,
                )
                .map_err(from_git)?;
            if !output.status.success() {
                return Err(git_output_error(&output.stderr));
            }
            let mut fields = output.stdout.split(|byte| *byte == 0);
            let mut tips = Vec::new();
            let mut ref_count = 0usize;
            while let Some(oid) = fields.next() {
                if oid.is_empty() {
                    break;
                }
                let oid = oid.strip_prefix(b"\n").unwrap_or(oid);
                if oid.is_empty() {
                    break;
                }
                let Some(raw_name) = fields.next() else {
                    return Ok(ScopeTipsSnapshot::Inconclusive);
                };
                let name = raw_name.strip_suffix(b"\n").unwrap_or(raw_name);
                if name.is_empty() {
                    return Ok(ScopeTipsSnapshot::Inconclusive);
                }
                ref_count += 1;
                if ref_count > 2000 {
                    return Ok(ScopeTipsSnapshot::Inconclusive);
                }
                if oid.len() != session.discovered.oid_length
                    || !oid.iter().all(u8::is_ascii_hexdigit)
                {
                    return Ok(ScopeTipsSnapshot::Inconclusive);
                }
                let tip = String::from_utf8_lossy(oid).to_ascii_lowercase();
                if !tips.contains(&tip) {
                    tips.push(tip);
                }
            }
            Ok(ScopeTipsSnapshot::Tips(tips))
        }
        RepositoryScope::Worktree(id) => {
            let navigation = match &session.discovered.navigation {
                Ok(value) => value,
                Err(_) => return Ok(ScopeTipsSnapshot::Inconclusive),
            };
            let Some(worktree) = navigation
                .worktrees
                .iter()
                .find(|worktree| worktree.id == *id && worktree.available)
            else {
                return Ok(ScopeTipsSnapshot::Unavailable);
            };
            let canonical = match Path::new(&worktree.path).canonicalize() {
                Ok(path) => path,
                Err(_) => return Ok(ScopeTipsSnapshot::Unavailable),
            };
            if canonical.to_string_lossy() != worktree.path {
                return Ok(ScopeTipsSnapshot::Unavailable);
            }
            let wt_path = canonical.as_path();
            let tips = resolve_live_ref_tip(
                &git,
                wt_path,
                "HEAD",
                session.discovered.oid_length,
                cancelled,
                deadline,
            )?;
            if let ScopeTipsSnapshot::Tips(_) = &tips {
                let common = git
                    .run(
                        wt_path,
                        &[
                            string_arg("rev-parse"),
                            string_arg("--path-format=absolute"),
                            string_arg("--git-common-dir"),
                        ],
                        None,
                        16 * 1024,
                        cancelled,
                        deadline,
                    )
                    .map_err(from_git)?;
                if !common.status.success() {
                    return Ok(ScopeTipsSnapshot::Unavailable);
                }
                let common_path = String::from_utf8_lossy(&common.stdout)
                    .trim_end_matches(['\r', '\n'])
                    .to_owned();
                if Path::new(&common_path)
                    .canonicalize()
                    .ok()
                    .as_ref()
                    .is_none_or(|actual| {
                        actual.to_string_lossy() != session.discovered.info.common_dir
                    })
                {
                    return Ok(ScopeTipsSnapshot::Unavailable);
                }
            }
            Ok(tips)
        }
    }
}

fn resolve_live_ref_tip(
    git: &ReadOnlyGit,
    repository_path: &Path,
    reference: &str,
    expected_length: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<ScopeTipsSnapshot> {
    let output = git
        .run(
            repository_path,
            &[
                string_arg("rev-parse"),
                string_arg("--verify"),
                string_arg("--end-of-options"),
                string_arg(reference),
            ],
            None,
            16 * 1024,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Ok(ScopeTipsSnapshot::Unavailable);
    }
    let oid = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_ascii_lowercase();
    if oid.len() != expected_length || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(ScopeTipsSnapshot::Inconclusive);
    }
    let commit_expression = format!("{oid}^{{commit}}");
    let peeled = git
        .run(
            repository_path,
            &[
                string_arg("rev-parse"),
                string_arg("--verify"),
                string_arg("--end-of-options"),
                string_arg(commit_expression),
            ],
            None,
            16 * 1024,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !peeled.status.success() {
        return Ok(ScopeTipsSnapshot::Inconclusive);
    }
    let commit_oid = String::from_utf8_lossy(&peeled.stdout)
        .trim()
        .to_ascii_lowercase();
    if commit_oid.len() != expected_length
        || !commit_oid.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Ok(ScopeTipsSnapshot::Inconclusive);
    }
    Ok(ScopeTipsSnapshot::Tips(vec![commit_oid]))
}

// None means the finite walk ended without a proof either way (for example a
// shallow boundary or truncated reference snapshot); Some(false) is only
// returned after a complete, non-boundary walk reaches EOF.
#[allow(clippy::too_many_arguments)]
fn reachability(
    executable: &Path,
    repository_path: &str,
    oid: &str,
    tips: &[String],
    oid_length: usize,
    boundary_limited: bool,
    refs_truncated: bool,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<Option<bool>> {
    if tips.is_empty() {
        return Ok((!boundary_limited && !refs_truncated).then_some(false));
    }
    let mut remaining: std::collections::BTreeSet<String> =
        tips.iter().map(|tip| tip.to_ascii_lowercase()).collect();
    if remaining.remove(&oid.to_ascii_lowercase()) {
        return Ok(Some(true));
    }
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    let mut args = vec![
        string_arg("-c"),
        string_arg("core.commitGraph=false"),
        string_arg("rev-list"),
        string_arg("--topo-order"),
        string_arg(format!("--ancestry-path={oid}")),
    ];
    args.extend(remaining.iter().map(string_arg));
    args.push(string_arg("--not"));
    args.push(string_arg(oid));
    let mut stream = git
        .stream_lines(Path::new(repository_path), &args, oid_length)
        .map_err(from_git)?;
    let mut scanned_bytes = 0usize;
    loop {
        match stream.next_line(cancelled, deadline) {
            Ok(Some(line)) => {
                scanned_bytes = scanned_bytes.saturating_add(line.len() + 1);
                if scanned_bytes > 16 * 1024 * 1024 {
                    return Ok(None);
                }
                if line.len() != oid_length || !line.iter().all(u8::is_ascii_hexdigit) {
                    return Err(detail_error(
                        ErrorCode::GitError,
                        "rev-list returned an invalid object ID",
                        false,
                    ));
                }
                let current = String::from_utf8_lossy(&line).to_ascii_lowercase();
                if remaining.remove(&current) {
                    return Ok(Some(true));
                }
            }
            Ok(None) => return Ok((!boundary_limited && !refs_truncated).then_some(false)),
            Err(error) => return Err(from_git(error)),
        }
    }
}

fn parse_trailers(
    executable: &Path,
    repository_path: &str,
    message: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<(Vec<Trailer>, String)> {
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    let empty_git_dir = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let parse_args = [
        string_arg(format!("--git-dir={empty_git_dir}")),
        string_arg("interpret-trailers"),
        string_arg("--parse"),
        string_arg("--only-input"),
        string_arg("--unfold"),
        string_arg("--no-divider"),
    ];
    let output = git
        .run(
            Path::new(repository_path),
            &parse_args,
            Some(message.as_bytes()),
            256 * 1024,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(detail_error(
            ErrorCode::UnsupportedRepository,
            "Git cannot safely parse commit trailers",
            false,
        ));
    }
    let parsed = String::from_utf8_lossy(&output.stdout);
    let trailers: Vec<Trailer> = parsed
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some(Trailer {
                key: key.to_owned(),
                value: value.trim_start().to_owned(),
            })
        })
        .collect();
    if trailers.len() > 4096 {
        return Err(detail_error(
            ErrorCode::ResourceLimit,
            "Commit has more than 4096 trailers",
            false,
        ));
    }
    if trailers.is_empty() {
        return Ok((trailers, message.to_owned()));
    }
    // Git normalizes the input without repository trailer configuration. Split
    // only when that normalized full message ends in Git's parsed trailer bytes
    // and the remaining normalized prefix is an exact prefix of the original.
    let normalize_args = [
        string_arg(format!("--git-dir={empty_git_dir}")),
        string_arg("interpret-trailers"),
        string_arg("--only-input"),
        string_arg("--unfold"),
        string_arg("--no-divider"),
    ];
    let normalized = git
        .run(
            Path::new(repository_path),
            &normalize_args,
            Some(message.as_bytes()),
            1024 * 1024,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !normalized.status.success() || !normalized.stdout.ends_with(&output.stdout) {
        return Ok((trailers, message.to_owned()));
    }
    let normalized_body = &normalized.stdout[..normalized.stdout.len() - output.stdout.len()];
    let body = std::str::from_utf8(normalized_body)
        .ok()
        .and_then(|prefix| message.strip_prefix(prefix))
        .map(|_| {
            message[..normalized_body.len()]
                .trim_end_matches(['\r', '\n'])
                .to_owned()
        })
        .unwrap_or_else(|| message.to_owned());
    Ok((trailers, body))
}

pub fn list_changed_files(
    executable: &Path,
    session: &session::RepositorySession,
    params: &ListChangedFilesParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<ChangedFilesPage> {
    validate_oid(&params.oid, session.discovered.oid_length)?;
    let oid = params.oid.to_ascii_lowercase();
    let mut parsed = repository::read_commit_metadata(
        executable,
        &session.discovered,
        std::slice::from_ref(&oid),
        cancelled,
        deadline,
    )
    .map_err(from_preview)?;
    let commit = parsed.pop().ok_or_else(|| {
        detail_error(
            ErrorCode::MissingObject,
            "Commit object was not found",
            false,
        )
    })?;
    let parent_index = match (commit.summary.parents.len(), params.parent_index) {
        (0, None) => None,
        (0, Some(_)) => {
            return Err(detail_error(
                ErrorCode::InvalidRequest,
                "Root commits require parentIndex=null",
                false,
            ));
        }
        (_, None) => {
            return Err(detail_error(
                ErrorCode::InvalidRequest,
                "Non-root commits require an explicit parentIndex",
                false,
            ));
        }
        (count, Some(index)) if usize::from(index) < count => Some(index),
        _ => {
            return Err(detail_error(
                ErrorCode::InvalidRequest,
                "parentIndex is outside the commit parent list",
                false,
            ));
        }
    };
    let parent_oid = parent_index.map(|index| commit.summary.parents[usize::from(index)].clone());
    if parent_oid.is_none() && repository::history_boundary_limited(&session.discovered) {
        return Err(detail_error(
            ErrorCode::UnsupportedRepository,
            "A shallow or grafted repository cannot prove root diff semantics",
            false,
        ));
    }
    repository::verify_graph_fingerprint(&session.discovered, cancelled, deadline)
        .map_err(from_preview)?;
    let diff = read_diff(
        executable,
        &session.discovered.info.path,
        &oid,
        parent_oid.as_deref(),
        session.discovered.oid_length,
        cancelled,
        deadline,
    )?;
    repository::verify_graph_fingerprint(&session.discovered, cancelled, deadline)
        .map_err(from_preview)?;
    let total_files = u32::try_from(diff.len()).map_err(|_| {
        detail_error(
            ErrorCode::ResourceLimit,
            "Changed file count exceeds protocol limits",
            false,
        )
    })?;
    if params.offset > total_files {
        return Err(detail_error(
            ErrorCode::InvalidRequest,
            "offset exceeds the changed file count",
            false,
        ));
    }
    let end = params
        .offset
        .saturating_add(u32::from(params.page_size))
        .min(total_files);
    let files = diff[params.offset as usize..end as usize].to_vec();
    let overview = build_overview(&diff)?;
    Ok(ChangedFilesPage {
        oid,
        parent_index,
        parent_oid,
        offset: params.offset,
        page_size: params.page_size,
        total_files,
        has_more: end < total_files,
        files,
        overview,
    })
}

pub fn read_file_diff(
    executable: &Path,
    session: &session::RepositorySession,
    params: &ReadDiffParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<FileDiff> {
    let oid = params.oid.to_ascii_lowercase();
    validate_oid(&oid, session.discovered.oid_length)?;
    validate_path_hex(params.old_path_hex.as_deref())?;
    validate_path_hex(params.new_path_hex.as_deref())?;

    let mut parsed = repository::read_commit_metadata(
        executable,
        &session.discovered,
        std::slice::from_ref(&oid),
        cancelled,
        deadline,
    )
    .map_err(from_preview)?;
    let commit = parsed.pop().ok_or_else(|| {
        detail_error(
            ErrorCode::MissingObject,
            "Commit object was not found",
            false,
        )
    })?;
    let parent_index = match (commit.summary.parents.len(), params.parent_index) {
        (0, None) => None,
        (0, Some(_)) => {
            return Err(detail_error(
                ErrorCode::InvalidRequest,
                "Root commits require parentIndex=null",
                false,
            ));
        }
        (_, None) => {
            return Err(detail_error(
                ErrorCode::InvalidRequest,
                "Non-root commits require an explicit parentIndex",
                false,
            ));
        }
        (count, Some(index)) if usize::from(index) < count => Some(index),
        _ => {
            return Err(detail_error(
                ErrorCode::InvalidRequest,
                "parentIndex is outside the commit parent list",
                false,
            ));
        }
    };
    let parent_oid = parent_index.map(|index| commit.summary.parents[usize::from(index)].clone());
    if parent_oid.is_none() && repository::history_boundary_limited(&session.discovered) {
        return Err(detail_error(
            ErrorCode::UnsupportedRepository,
            "A shallow or grafted repository cannot prove root diff semantics",
            false,
        ));
    }
    repository::verify_graph_fingerprint(&session.discovered, cancelled, deadline)
        .map_err(from_preview)?;
    let files = read_diff(
        executable,
        &session.discovered.info.path,
        &oid,
        parent_oid.as_deref(),
        session.discovered.oid_length,
        cancelled,
        deadline,
    )?;
    let old_path_hex = params.old_path_hex.as_deref().map(str::to_ascii_lowercase);
    let new_path_hex = params.new_path_hex.as_deref().map(str::to_ascii_lowercase);
    let file = files
        .into_iter()
        .find(|file| {
            file.old_path.as_ref().map(|path| path.raw_hex.as_str()) == old_path_hex.as_deref()
                && file.new_path.as_ref().map(|path| path.raw_hex.as_str())
                    == new_path_hex.as_deref()
        })
        .ok_or_else(|| {
            detail_error(
                ErrorCode::InvalidRequest,
                "The selected raw path pair is not changed by this commit parent",
                false,
            )
        })?;

    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    let (old_blob, new_blob) = if file.gitlink {
        (None, None)
    } else {
        (
            file.old_oid
                .as_deref()
                .map(|blob| blob_info(&git, session, blob, cancelled, deadline))
                .transpose()?,
            file.new_oid
                .as_deref()
                .map(|blob| blob_info(&git, session, blob, cancelled, deadline))
                .transpose()?,
        )
    };
    let old_size = old_blob.as_ref().map(|blob| blob.size);
    let new_size = new_blob.as_ref().map(|blob| blob.size);
    let kind = if file.gitlink {
        FileDiffKind::Gitlink
    } else if old_size.is_some_and(|size| size > FILE_DIFF_BLOB_LIMIT)
        || new_size.is_some_and(|size| size > FILE_DIFF_BLOB_LIMIT)
    {
        FileDiffKind::TooLarge
    } else if has_lfs_pointer(&git, session, old_blob.as_ref(), cancelled, deadline)?
        || has_lfs_pointer(&git, session, new_blob.as_ref(), cancelled, deadline)?
    {
        FileDiffKind::Lfs
    } else if file.binary {
        FileDiffKind::Binary
    } else {
        FileDiffKind::Text
    };
    let mut patch = String::new();
    let mut truncated = false;
    let mut text_lossy = false;
    if kind == FileDiffKind::Text {
        let args = file_diff_args(
            &oid,
            parent_oid.as_deref(),
            &file,
            old_blob.as_ref().map(|blob| blob.oid.as_str()),
            new_blob.as_ref().map(|blob| blob.oid.as_str()),
            params.full_file,
        )?;
        (patch, truncated, text_lossy) = collect_patch(
            &git,
            Path::new(&session.discovered.info.path),
            &args,
            params.full_file,
            cancelled,
            deadline,
        )?;
    }
    repository::verify_graph_fingerprint(&session.discovered, cancelled, deadline)
        .map_err(from_preview)?;
    Ok(FileDiff {
        oid,
        parent_index,
        parent_oid,
        file,
        kind,
        patch,
        truncated,
        text_lossy,
        old_size,
        new_size,
    })
}

/// Bytes a character takes inside a JSON string: control characters, quotes and backslashes are escaped.
pub(crate) fn json_char_len(character: char) -> usize {
    match character {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        character if (character as u32) < 0x20 => 6,
        character => character.len_utf8(),
    }
}

/// Bytes a string takes inside a JSON string, so response budgets hold for escape-heavy text.
pub(crate) fn json_text_len(text: &str) -> usize {
    text.chars().map(json_char_len).sum()
}

/// Streams one file's patch within the response limits. A normal diff is cut at the limit and marked
/// truncated; a whole-file diff that does not fit fails with RESOURCE_LIMIT so the caller can fall back.
pub(crate) fn collect_patch(
    git: &ReadOnlyGit,
    cwd: &Path,
    args: &[std::ffi::OsString],
    full_file: bool,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<(String, bool, bool)> {
    let too_large = || {
        detail_error(
            ErrorCode::ResourceLimit,
            "The whole file is over the full-file diff limit",
            false,
        )
    };
    let mut stream = git
        .stream_lines(cwd, args, FILE_DIFF_LINE_BYTES)
        .map_err(from_git)?;
    let (line_limit, byte_limit) = if full_file {
        (FULL_FILE_LINE_LIMIT * 2, FULL_FILE_PATCH_LIMIT)
    } else {
        (FILE_DIFF_LINE_LIMIT, FILE_DIFF_PATCH_LIMIT)
    };
    let mut patch = String::new();
    let mut truncated = false;
    let mut text_lossy = false;
    let mut lines = 0usize;
    let mut encoded = 0usize;
    let mut new_side_lines = 0usize;
    let mut old_side_lines = 0usize;
    // File headers ("--- a/x", "+++ b/x") come before the first hunk; after it every line is content.
    let mut in_hunk = false;
    loop {
        match stream.next_line(cancelled, deadline) {
            Ok(Some(line)) => {
                let decoded = String::from_utf8_lossy(&line);
                let line_bytes = json_text_len(&decoded).saturating_add(1);
                in_hunk |= line.starts_with(b"@@");
                if in_hunk && matches!(line.first(), Some(b' ' | b'+')) {
                    new_side_lines += 1;
                }
                if in_hunk && matches!(line.first(), Some(b' ' | b'-')) {
                    old_side_lines += 1;
                }
                let over = lines == line_limit
                    || encoded.saturating_add(line_bytes) > byte_limit
                    || (full_file && new_side_lines.max(old_side_lines) > FULL_FILE_LINE_LIMIT);
                if over && full_file {
                    return Err(too_large());
                }
                if over {
                    truncated = true;
                    break;
                }
                if std::str::from_utf8(&line).is_err() {
                    text_lossy = true;
                }
                patch.push_str(&decoded);
                patch.push('\n');
                lines += 1;
                encoded += line_bytes;
            }
            Ok(None) => break,
            Err(GitFailure::ResourceLimit) if full_file => return Err(too_large()),
            Err(GitFailure::ResourceLimit) => {
                truncated = true;
                break;
            }
            Err(error) => return Err(from_git(error)),
        }
    }
    Ok((patch, truncated, text_lossy))
}

pub(crate) fn has_lfs_pointer(
    git: &ReadOnlyGit,
    session: &session::RepositorySession,
    blob: Option<&BlobInfo>,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<bool> {
    let Some(blob) = blob.filter(|blob| blob.size <= 1024) else {
        return Ok(false);
    };
    Ok(is_lfs_pointer(&read_small_blob(
        git, session, &blob.oid, cancelled, deadline,
    )?))
}

pub(crate) struct BlobInfo {
    pub(crate) oid: String,
    pub(crate) size: u64,
}

pub(crate) fn blob_info(
    git: &ReadOnlyGit,
    session: &session::RepositorySession,
    oid: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<BlobInfo> {
    validate_oid(oid, session.discovered.oid_length)?;
    let path = Path::new(&session.discovered.info.path);
    let type_output = git
        .run(
            path,
            &[string_arg("cat-file"), string_arg("-t"), string_arg(oid)],
            None,
            64,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !type_output.status.success() || trim_line(&type_output.stdout) != b"blob" {
        return Err(detail_error(
            ErrorCode::MissingObject,
            "The selected file blob is unavailable",
            false,
        ));
    }
    let size_output = git
        .run(
            path,
            &[string_arg("cat-file"), string_arg("-s"), string_arg(oid)],
            None,
            64,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !size_output.status.success() {
        return Err(git_output_error(&size_output.stderr));
    }
    let size = std::str::from_utf8(trim_line(&size_output.stdout))
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| detail_error(ErrorCode::GitError, "Invalid blob size", false))?;
    Ok(BlobInfo {
        oid: oid.to_owned(),
        size,
    })
}

pub(crate) fn read_small_blob(
    git: &ReadOnlyGit,
    session: &session::RepositorySession,
    oid: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<Vec<u8>> {
    let output = git
        .run(
            Path::new(&session.discovered.info.path),
            &[string_arg("cat-file"), string_arg("blob"), string_arg(oid)],
            None,
            1025,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(git_output_error(&output.stderr));
    }
    Ok(output.stdout)
}

pub(crate) fn is_lfs_pointer(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let lines: Vec<&str> = text.trim_end_matches(['\r', '\n']).split('\n').collect();
    lines.len() == 3
        && lines[0] == "version https://git-lfs.github.com/spec/v1"
        && lines[1]
            .strip_prefix("oid sha256:")
            .is_some_and(|oid| oid.len() == 64 && oid.bytes().all(|byte| byte.is_ascii_hexdigit()))
        && lines[2]
            .strip_prefix("size ")
            .is_some_and(|size| !size.is_empty() && size.bytes().all(|byte| byte.is_ascii_digit()))
}

fn file_diff_args(
    oid: &str,
    parent_oid: Option<&str>,
    file: &ChangedFile,
    old_blob: Option<&str>,
    new_blob: Option<&str>,
    full_file: bool,
) -> DetailResult<Vec<std::ffi::OsString>> {
    let context = if full_file {
        format!("--unified={FULL_FILE_CONTEXT}")
    } else {
        "--unified=3".to_owned()
    };
    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut args = vec![
        string_arg("-c"),
        string_arg(format!("core.attributesFile={null_device}")),
        string_arg("--literal-pathspecs"),
        string_arg(format!("--attr-source={oid}")),
    ];
    if let (Some(old_blob), Some(new_blob)) = (old_blob, new_blob) {
        args.push(string_arg("diff"));
        args.extend([
            string_arg("--no-ext-diff"),
            string_arg("--no-textconv"),
            string_arg("--no-color"),
            string_arg("--text"),
            string_arg(&context),
            string_arg("--diff-algorithm=myers"),
            string_arg("--indent-heuristic"),
        ]);
        args.push(string_arg(old_blob));
        args.push(string_arg(new_blob));
        args.push(string_arg("--"));
        return Ok(args);
    }
    args.push(string_arg("diff-tree"));
    args.push(string_arg("--no-commit-id"));
    args.push(string_arg("-p"));
    args.push(string_arg("-r"));
    args.push(string_arg("--no-renames"));
    args.extend([
        string_arg("--no-ext-diff"),
        string_arg("--no-textconv"),
        string_arg("--no-color"),
        string_arg("--text"),
        string_arg(&context),
        string_arg("--diff-algorithm=myers"),
        string_arg("--indent-heuristic"),
        string_arg(format!("-O{null_device}")),
        string_arg("--ignore-submodules=none"),
        string_arg("--submodule=short"),
    ]);
    if let Some(parent_oid) = parent_oid {
        args.push(string_arg(parent_oid));
        args.push(string_arg(oid));
    } else {
        args.push(string_arg("--root"));
        args.push(string_arg(oid));
    }
    args.push(string_arg("--"));
    let path = file
        .new_path
        .as_ref()
        .or(file.old_path.as_ref())
        .ok_or_else(|| detail_error(ErrorCode::GitError, "Changed file has no raw path", false))?;
    args.push(raw_path_arg(&path.raw_hex)?);
    Ok(args)
}

pub(crate) fn raw_path_arg(raw_hex: &str) -> DetailResult<std::ffi::OsString> {
    let bytes = hex_decode(raw_hex)
        .map_err(|_| detail_error(ErrorCode::GitError, "Invalid raw repository path", false))?;
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Ok(std::ffi::OsString::from_vec(bytes))
    }
    #[cfg(windows)]
    {
        String::from_utf8(bytes)
            .map(std::ffi::OsString::from)
            .map_err(|_| {
                detail_error(
                    ErrorCode::UnsupportedRepository,
                    "This platform cannot represent the raw Git path losslessly",
                    false,
                )
            })
    }
}

pub(crate) fn validate_path_hex(value: Option<&str>) -> DetailResult<()> {
    if value.is_some_and(|value| {
        value.is_empty()
            || value.len() > PATH_LIMIT * 2
            || value.len() % 2 != 0
            || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        Err(detail_error(
            ErrorCode::InvalidRequest,
            "raw path must be bounded even-length hexadecimal",
            false,
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn trim_line(bytes: &[u8]) -> &[u8] {
    bytes.strip_suffix(b"\n").unwrap_or(bytes)
}

#[derive(Debug)]
struct RawEntry {
    status: ChangedFileStatus,
    old_path: Option<Vec<u8>>,
    new_path: Option<Vec<u8>>,
    old_oid: Option<String>,
    new_oid: Option<String>,
    old_mode: String,
    new_mode: String,
    similarity: Option<u8>,
}

pub(crate) fn read_diff(
    executable: &Path,
    repository_path: &str,
    oid: &str,
    parent_oid: Option<&str>,
    oid_length: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<Vec<ChangedFile>> {
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut args = vec![
        string_arg("-c"),
        string_arg(format!("core.attributesFile={null_device}")),
        string_arg("-c"),
        string_arg("diff.external="),
        string_arg(format!("--attr-source={oid}")),
        string_arg("diff-tree"),
        string_arg("--no-commit-id"),
        string_arg("--raw"),
        string_arg("--numstat"),
        string_arg("-z"),
        string_arg("-r"),
        string_arg("--no-abbrev"),
        string_arg("--no-ext-diff"),
        string_arg("--no-textconv"),
        string_arg("--ignore-submodules=none"),
        string_arg("--no-relative"),
        string_arg("--submodule=short"),
        string_arg("--diff-algorithm=myers"),
        string_arg("--indent-heuristic"),
        string_arg(format!("-O{null_device}")),
        string_arg("--find-renames=50%"),
        string_arg("--find-copies=50%"),
        string_arg("-l20000"),
    ];
    if let Some(parent) = parent_oid {
        args.push(string_arg(parent));
        args.push(string_arg(oid));
    } else {
        args.push(string_arg("--root"));
        args.push(string_arg(oid));
    }
    args.push(string_arg("--"));
    let output = git
        .run(
            Path::new(repository_path),
            &args,
            None,
            DIFF_OUTPUT_LIMIT,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(git_output_error(&output.stderr));
    }
    let warning = String::from_utf8_lossy(&output.stderr);
    if warning.contains("rename detection was skipped")
        || warning.contains("inexact rename detection")
        || warning.contains("too many files")
    {
        return Err(detail_error(
            ErrorCode::ResourceLimit,
            "Git could not complete bounded rename detection",
            false,
        ));
    }
    parse_diff_output(&output.stdout, oid_length)
}

fn parse_diff_output(bytes: &[u8], oid_length: usize) -> DetailResult<Vec<ChangedFile>> {
    // The raw and numstat streams are emitted in corresponding path order.
    // Parse raw records first, then pair each record with its numstat record.
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    if fields.len() > DIFF_FILE_LIMIT * 8 + 4 {
        return Err(detail_error(
            ErrorCode::ResourceLimit,
            "Changed file count exceeds 20000",
            false,
        ));
    }
    let mut raw = Vec::new();
    let mut stats = Vec::new();
    let mut i = 0;
    while i < fields.len() {
        if fields[i].is_empty() {
            i += 1;
            continue;
        }
        if fields[i][0] == b':' {
            let header = std::str::from_utf8(fields[i])
                .map_err(|_| detail_error(ErrorCode::GitError, "Invalid raw diff header", false))?;
            let mut parts = header[1..].split_whitespace();
            let old_mode = parts
                .next()
                .ok_or_else(|| detail_error(ErrorCode::GitError, "Invalid raw diff mode", false))?
                .to_owned();
            let new_mode = parts
                .next()
                .ok_or_else(|| detail_error(ErrorCode::GitError, "Invalid raw diff mode", false))?
                .to_owned();
            let old_oid = parts
                .next()
                .ok_or_else(|| detail_error(ErrorCode::GitError, "Invalid raw diff oid", false))?;
            let new_oid = parts
                .next()
                .ok_or_else(|| detail_error(ErrorCode::GitError, "Invalid raw diff oid", false))?;
            let code = parts.next().ok_or_else(|| {
                detail_error(ErrorCode::GitError, "Invalid raw diff status", false)
            })?;
            let (status, similarity) = parse_status(code)?;
            i += 1;
            let first = fields
                .get(i)
                .ok_or_else(|| detail_error(ErrorCode::GitError, "Missing raw diff path", false))?
                .to_vec();
            i += 1;
            let (old_path, new_path) = if matches!(
                status,
                ChangedFileStatus::Renamed | ChangedFileStatus::Copied
            ) {
                let second = fields
                    .get(i)
                    .ok_or_else(|| {
                        detail_error(ErrorCode::GitError, "Missing second raw diff path", false)
                    })?
                    .to_vec();
                i += 1;
                (Some(first), Some(second))
            } else {
                match status {
                    ChangedFileStatus::Added => (None, Some(first)),
                    ChangedFileStatus::Deleted => (Some(first), None),
                    _ => (Some(first.clone()), Some(first)),
                }
            };
            for path in old_path.iter().chain(new_path.iter()) {
                if path.len() > PATH_LIMIT {
                    return Err(detail_error(
                        ErrorCode::ResourceLimit,
                        "A changed path exceeds 16 KiB",
                        false,
                    ));
                }
            }
            if old_oid.len() != oid_length
                || new_oid.len() != oid_length
                || !old_oid
                    .bytes()
                    .chain(new_oid.bytes())
                    .all(|b| b.is_ascii_hexdigit())
            {
                return Err(detail_error(
                    ErrorCode::GitError,
                    "Raw diff returned an object ID with the wrong object format",
                    false,
                ));
            }
            let old_oid_value =
                (!old_oid.bytes().all(|b| b == b'0')).then(|| old_oid.to_ascii_lowercase());
            let new_oid_value =
                (!new_oid.bytes().all(|b| b == b'0')).then(|| new_oid.to_ascii_lowercase());
            raw.push(RawEntry {
                status,
                old_path,
                new_path,
                old_oid: old_oid_value,
                new_oid: new_oid_value,
                old_mode,
                new_mode,
                similarity,
            });
        } else if fields[i].contains(&b'\t') {
            let stat = fields[i];
            let first_tab = stat.iter().position(|b| *b == b'\t').unwrap();
            let second_tab = stat[first_tab + 1..]
                .iter()
                .position(|b| *b == b'\t')
                .map(|p| p + first_tab + 1)
                .ok_or_else(|| {
                    detail_error(ErrorCode::GitError, "Invalid numstat record", false)
                })?;
            let add = &stat[..first_tab];
            let del = &stat[first_tab + 1..second_tab];
            let path = &stat[second_tab + 1..];
            i += 1;
            let (old_path, new_path) = if path.is_empty() {
                let old = fields
                    .get(i)
                    .ok_or_else(|| {
                        detail_error(ErrorCode::GitError, "Missing numstat rename source", false)
                    })?
                    .to_vec();
                i += 1;
                let new = fields
                    .get(i)
                    .ok_or_else(|| {
                        detail_error(
                            ErrorCode::GitError,
                            "Missing numstat rename destination",
                            false,
                        )
                    })?
                    .to_vec();
                i += 1;
                (Some(old), Some(new))
            } else {
                (None, Some(path.to_vec()))
            };
            stats.push((
                parse_numstat(add)?,
                parse_numstat(del)?,
                add == b"-" && del == b"-",
                old_path,
                new_path,
            ));
        } else {
            return Err(detail_error(
                ErrorCode::GitError,
                "Unexpected NUL-delimited diff record",
                false,
            ));
        }
        if raw.len() > DIFF_FILE_LIMIT {
            return Err(detail_error(
                ErrorCode::ResourceLimit,
                "Changed file count exceeds 20000",
                false,
            ));
        }
    }
    if raw.len() != stats.len() {
        return Err(detail_error(
            ErrorCode::GitError,
            "Raw diff and numstat record counts differ",
            false,
        ));
    }
    let mut result = Vec::with_capacity(raw.len());
    for (entry, (additions, deletions, binary, old_stat_path, new_stat_path)) in
        raw.into_iter().zip(stats)
    {
        // Validate pairing by raw bytes. Rename output uses two paths in both streams.
        let path_mismatch = match entry.status {
            ChangedFileStatus::Renamed | ChangedFileStatus::Copied => {
                entry.old_path.as_deref() != old_stat_path.as_deref()
                    || entry.new_path.as_deref() != new_stat_path.as_deref()
            }
            ChangedFileStatus::Deleted => entry.old_path.as_deref() != new_stat_path.as_deref(),
            ChangedFileStatus::Added
            | ChangedFileStatus::Modified
            | ChangedFileStatus::TypeChanged => {
                entry.new_path.as_deref() != new_stat_path.as_deref()
            }
        };
        if path_mismatch {
            return Err(detail_error(
                ErrorCode::GitError,
                "Raw diff and numstat paths differ",
                false,
            ));
        }
        let gitlink = entry.old_mode == "160000" || entry.new_mode == "160000";
        result.push(ChangedFile {
            status: entry.status,
            old_path: entry.old_path.map(git_path),
            new_path: entry.new_path.map(git_path),
            old_oid: entry.old_oid,
            new_oid: entry.new_oid,
            old_mode: entry.old_mode,
            new_mode: entry.new_mode,
            similarity: entry.similarity,
            additions,
            deletions,
            binary,
            gitlink,
        });
    }
    Ok(result)
}

pub fn read_merge_commits(
    executable: &Path,
    session: &session::RepositorySession,
    params: &ReadMergeCommitsParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<MergeCommitsPage> {
    validate_oid(&params.oid, session.discovered.oid_length)?;
    if repository::history_boundary_limited(&session.discovered) {
        return Err(detail_error(
            ErrorCode::UnsupportedRepository,
            "Merge groups cannot be proven complete with shallow or grafted history",
            false,
        ));
    }
    let oid = params.oid.to_ascii_lowercase();
    let mut parsed = repository::read_commit_metadata(
        executable,
        &session.discovered,
        std::slice::from_ref(&oid),
        cancelled,
        deadline,
    )
    .map_err(from_preview)?;
    let commit = parsed.pop().ok_or_else(|| {
        detail_error(
            ErrorCode::MissingObject,
            "Commit object was not found",
            false,
        )
    })?;
    let first = commit.summary.parents.first().ok_or_else(|| {
        detail_error(
            ErrorCode::InvalidRequest,
            "Root commit has no merge parent group",
            false,
        )
    })?;
    let parent = commit
        .summary
        .parents
        .get(usize::from(params.parent_index))
        .filter(|_| params.parent_index > 0)
        .ok_or_else(|| {
            detail_error(
                ErrorCode::InvalidRequest,
                "parentIndex must select a non-first parent",
                false,
            )
        })?;
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    repository::verify_graph_fingerprint(&session.discovered, cancelled, deadline)
        .map_err(from_preview)?;
    let args = [
        string_arg("-c"),
        string_arg("core.commitGraph=false"),
        string_arg("rev-list"),
        string_arg("--topo-order"),
        string_arg(parent),
        string_arg("--not"),
        string_arg(first),
        string_arg("--"),
    ];
    let output = git
        .run(
            Path::new(&session.discovered.info.path),
            &args,
            None,
            MERGE_OUTPUT_LIMIT,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(git_output_error(&output.stderr));
    }
    let mut oids = Vec::new();
    for line in output
        .stdout
        .split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
    {
        if line.len() != session.discovered.oid_length || !line.iter().all(u8::is_ascii_hexdigit) {
            return Err(detail_error(
                ErrorCode::GitError,
                "rev-list returned an invalid object ID",
                false,
            ));
        }
        oids.push(String::from_utf8_lossy(line).to_ascii_lowercase());
        if oids.len() > MERGE_COMMIT_LIMIT {
            return Err(detail_error(
                ErrorCode::ResourceLimit,
                "Merge brought-in commits exceed 10000",
                false,
            ));
        }
    }
    if params.offset as usize > oids.len() {
        return Err(detail_error(
            ErrorCode::InvalidRequest,
            "offset exceeds the brought-in commit count",
            false,
        ));
    }
    let mut authors: BTreeMap<(String, String), u32> = BTreeMap::new();
    let mut page_commits = Vec::new();
    let mut total_object_bytes = 0usize;
    for (batch_index, batch) in oids.chunks(16).enumerate() {
        let parsed_batch = repository::read_commit_metadata(
            executable,
            &session.discovered,
            batch,
            cancelled,
            deadline,
        )
        .map_err(from_preview)?;
        for (local_index, parsed) in parsed_batch.into_iter().enumerate() {
            let metadata_bytes = parsed
                .message
                .len()
                .saturating_add(parsed.summary.summary.len())
                .saturating_add(
                    parsed.summary.author.name.len()
                        + parsed.summary.author.email.len()
                        + parsed.summary.author.timestamp.len()
                        + parsed.summary.author.offset.len(),
                )
                .saturating_add(
                    parsed.summary.committer.name.len()
                        + parsed.summary.committer.email.len()
                        + parsed.summary.committer.timestamp.len()
                        + parsed.summary.committer.offset.len(),
                )
                .saturating_add(
                    parsed
                        .summary
                        .parents
                        .len()
                        .saturating_mul(session.discovered.oid_length)
                        .saturating_add(64),
                );
            total_object_bytes =
                total_object_bytes
                    .checked_add(metadata_bytes)
                    .ok_or_else(|| {
                        detail_error(
                            ErrorCode::ResourceLimit,
                            "Merge metadata exceeds its byte budget",
                            false,
                        )
                    })?;
            if total_object_bytes > MERGE_OUTPUT_LIMIT {
                return Err(detail_error(
                    ErrorCode::ResourceLimit,
                    "Merge metadata exceeds 16 MiB",
                    false,
                ));
            }
            let absolute_index = batch_index * 16 + local_index;
            if absolute_index >= params.offset as usize
                && absolute_index < params.offset as usize + usize::from(params.page_size)
            {
                page_commits.push(parsed.summary.clone());
            }
            let key = (
                parsed.summary.author.name.clone(),
                parsed.summary.author.email.clone(),
            );
            *authors.entry(key).or_default() += 1;
        }
        if authors.len() > 1000 {
            return Err(detail_error(
                ErrorCode::ResourceLimit,
                "Merge group exceeds 1000 authors",
                false,
            ));
        }
    }
    repository::verify_graph_fingerprint(&session.discovered, cancelled, deadline)
        .map_err(from_preview)?;
    let total = oids.len();
    let end = (params.offset as usize + usize::from(params.page_size)).min(total);
    let commits = page_commits;
    let authors = authors
        .into_iter()
        .map(|((name, email), count)| commitscope_core::MergeAuthorCount { name, email, count })
        .collect();
    Ok(MergeCommitsPage {
        oid,
        parent_index: params.parent_index,
        parent_oid: parent.clone(),
        first_parent_oid: first.clone(),
        offset: params.offset,
        page_size: params.page_size,
        total_commits: total as u32,
        has_more: end < total,
        commits,
        authors,
    })
}

pub fn branches_containing(
    executable: &Path,
    session: &session::RepositorySession,
    params: &BranchesContainingParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> DetailResult<BranchesContainingResult> {
    validate_oid(&params.oid, session.discovered.oid_length)?;
    let normalized_oid = params.oid.to_ascii_lowercase();
    repository::read_commit_metadata(
        executable,
        &session.discovered,
        std::slice::from_ref(&normalized_oid),
        cancelled,
        deadline,
    )
    .map_err(from_preview)?;
    repository::verify_graph_fingerprint(&session.discovered, cancelled, deadline)
        .map_err(from_preview)?;
    let refs: Vec<RefInfo> = session
        .discovered
        .refs
        .iter()
        .filter(|reference| matches!(reference.kind, RefKind::LocalBranch | RefKind::RemoteBranch))
        .cloned()
        .collect();
    let mut by_tip: BTreeMap<String, Vec<RefInfo>> = BTreeMap::new();
    let mut branches = Vec::new();
    for reference in refs {
        validate_oid(&reference.oid, session.discovered.oid_length)?;
        let tip = reference
            .peeled_oid
            .as_deref()
            .unwrap_or(&reference.oid)
            .to_ascii_lowercase();
        if tip == normalized_oid {
            branches.push(reference);
        } else {
            by_tip.entry(tip).or_default().push(reference);
        }
    }
    let mut complete_walk = by_tip.is_empty();
    let mut exceeded = false;
    if !by_tip.is_empty() {
        let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
        let mut args = vec![
            string_arg("-c"),
            string_arg("core.commitGraph=false"),
            string_arg("rev-list"),
            string_arg("--topo-order"),
            string_arg(format!("--ancestry-path={normalized_oid}")),
        ];
        args.extend(by_tip.keys().map(string_arg));
        args.push(string_arg("--not"));
        args.push(string_arg(&normalized_oid));
        let mut stream = git
            .stream_lines(
                Path::new(&session.discovered.info.path),
                &args,
                session.discovered.oid_length,
            )
            .map_err(from_git)?;
        let mut scanned_bytes = 0usize;
        loop {
            match stream.next_line(cancelled, deadline) {
                Ok(Some(line)) => {
                    scanned_bytes = scanned_bytes.saturating_add(line.len() + 1);
                    if scanned_bytes > MERGE_OUTPUT_LIMIT {
                        exceeded = true;
                        break;
                    }
                    if line.len() != session.discovered.oid_length
                        || !line.iter().all(u8::is_ascii_hexdigit)
                    {
                        return Err(detail_error(
                            ErrorCode::GitError,
                            "rev-list returned an invalid object ID",
                            false,
                        ));
                    }
                    let oid = String::from_utf8_lossy(&line).to_ascii_lowercase();
                    if let Some(found) = by_tip.remove(&oid) {
                        branches.extend(found);
                    }
                    if by_tip.is_empty() {
                        complete_walk = true;
                        break;
                    }
                }
                Ok(None) => {
                    complete_walk = true;
                    break;
                }
                Err(GitFailure::Cancelled) => return Err(from_git(GitFailure::Cancelled)),
                Err(error) => return Err(from_git(error)),
            }
        }
    }
    repository::verify_graph_fingerprint(&session.discovered, cancelled, deadline)
        .map_err(from_preview)?;
    branches.sort_by(|left, right| left.name.cmp(&right.name));
    let boundary_limited = repository::history_boundary_limited(&session.discovered);
    let complete =
        complete_walk && !exceeded && !session.discovered.refs_truncated && !boundary_limited;
    Ok(BranchesContainingResult {
        oid: normalized_oid,
        branches,
        observed_at_unix_ms: session.info.observed_at_unix_ms,
        complete,
        refs_truncated: session.discovered.refs_truncated,
        boundary_limited,
    })
}

fn build_overview(files: &[ChangedFile]) -> DetailResult<commitscope_core::ChangeOverview> {
    let mut counts = commitscope_core::ChangeCounts {
        added: 0,
        modified: 0,
        deleted: 0,
        renamed: 0,
        copied: 0,
        type_changed: 0,
    };
    let mut additions = 0_u64;
    let mut deletions = 0_u64;
    let mut binary_files = 0;
    let mut gitlink_files = 0;
    let mut directories: BTreeMap<Option<Vec<u8>>, (u32, u64, u64)> = BTreeMap::new();
    for file in files {
        match file.status {
            ChangedFileStatus::Added => counts.added += 1,
            ChangedFileStatus::Modified => counts.modified += 1,
            ChangedFileStatus::Deleted => counts.deleted += 1,
            ChangedFileStatus::Renamed => counts.renamed += 1,
            ChangedFileStatus::Copied => counts.copied += 1,
            ChangedFileStatus::TypeChanged => counts.type_changed += 1,
        }
        binary_files += u32::from(file.binary);
        gitlink_files += u32::from(file.gitlink);
        if let Some(value) = file.additions {
            additions = additions
                .checked_add(value)
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or_else(|| {
                    detail_error(
                        ErrorCode::ResourceLimit,
                        "Diff line count exceeds JavaScript's safe integer range",
                        false,
                    )
                })?;
        }
        if let Some(value) = file.deletions {
            deletions = deletions
                .checked_add(value)
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or_else(|| {
                    detail_error(
                        ErrorCode::ResourceLimit,
                        "Diff line count exceeds JavaScript's safe integer range",
                        false,
                    )
                })?;
        }
        let source = if file.status == ChangedFileStatus::Deleted {
            file.old_path.as_ref()
        } else {
            file.new_path.as_ref().or(file.old_path.as_ref())
        };
        let dir = source
            .and_then(|path| hex_decode(&path.raw_hex).ok())
            .and_then(|bytes| {
                bytes
                    .iter()
                    .position(|b| *b == b'/')
                    .map(|i| bytes[..i].to_vec())
            });
        let entry = directories.entry(dir).or_default();
        entry.0 += 1;
        entry.1 += file.additions.unwrap_or(0);
        entry.2 += file.deletions.unwrap_or(0);
    }
    let directories = directories
        .into_iter()
        .map(|(path, (total_files, additions, deletions))| {
            commitscope_core::DirectoryChangeOverview {
                path: path.map(git_path),
                total_files,
                additions,
                deletions,
            }
        })
        .collect();
    Ok(commitscope_core::ChangeOverview {
        total_files: files.len() as u32,
        counts,
        additions,
        deletions,
        binary_files,
        gitlink_files,
        directories,
    })
}

pub(crate) fn parse_status(code: &str) -> DetailResult<(ChangedFileStatus, Option<u8>)> {
    let status = code
        .as_bytes()
        .first()
        .copied()
        .ok_or_else(|| detail_error(ErrorCode::GitError, "Empty diff status", false))?;
    let similarity = code.get(1..).and_then(|suffix| suffix.parse::<u8>().ok());
    let status = match status {
        b'A' => ChangedFileStatus::Added,
        b'M' => ChangedFileStatus::Modified,
        b'D' => ChangedFileStatus::Deleted,
        b'R' => ChangedFileStatus::Renamed,
        b'C' => ChangedFileStatus::Copied,
        b'T' => ChangedFileStatus::TypeChanged,
        _ => {
            return Err(detail_error(
                ErrorCode::GitError,
                "Unknown diff status",
                false,
            ));
        }
    };
    Ok((status, similarity))
}

pub(crate) fn parse_numstat(bytes: &[u8]) -> DetailResult<Option<u64>> {
    if bytes == b"-" {
        Ok(None)
    } else {
        let value = std::str::from_utf8(bytes)
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or_else(|| detail_error(ErrorCode::GitError, "Invalid numstat count", false))?;
        if value > 9_007_199_254_740_991 {
            return Err(detail_error(
                ErrorCode::ResourceLimit,
                "Per-file diff count exceeds JavaScript's safe integer range",
                false,
            ));
        }
        Ok(Some(value))
    }
}
pub(crate) fn git_path(bytes: Vec<u8>) -> GitPath {
    let display = String::from_utf8_lossy(&bytes).into_owned();
    let text_lossy = std::str::from_utf8(&bytes).is_err();
    GitPath {
        display,
        raw_hex: bytes.iter().map(|b| format!("{b:02x}")).collect(),
        text_lossy,
    }
}
pub(crate) fn hex_decode(value: &str) -> Result<Vec<u8>, ()> {
    if !value.len().is_multiple_of(2) {
        return Err(());
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(|_| ()))
        .collect()
}
pub(crate) fn validate_oid(oid: &str, length: usize) -> DetailResult<()> {
    if oid.len() != length || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        Err(detail_error(
            ErrorCode::InvalidRequest,
            "oid must be a full object ID for this repository",
            false,
        ))
    } else {
        Ok(())
    }
}
pub(crate) fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().min(u128::from(u64::MAX)) as u64
        })
}
pub(crate) fn from_preview(error: repository::PreviewError) -> DetailError {
    DetailError {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
    }
}
pub(crate) fn from_git(error: GitFailure) -> DetailError {
    match error {
        GitFailure::Cancelled => detail_error(ErrorCode::Cancelled, "Request was cancelled", false),
        GitFailure::Timeout => detail_error(ErrorCode::Timeout, "Git operation timed out", true),
        GitFailure::ResourceLimit => detail_error(
            ErrorCode::ResourceLimit,
            "Git output exceeded the configured limit",
            false,
        ),
        GitFailure::Unavailable(message) => detail_error(ErrorCode::GitUnavailable, &message, true),
        GitFailure::CommandFailed(message) => detail_error(ErrorCode::GitError, &message, false),
    }
}
pub(crate) fn git_output_error(stderr: &[u8]) -> DetailError {
    let message = String::from_utf8_lossy(stderr)
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(512)
        .collect::<String>();
    if message.contains("missing") || message.contains("bad object") {
        detail_error(
            ErrorCode::MissingObject,
            "A commit or parent object is unavailable",
            false,
        )
    } else {
        detail_error(ErrorCode::GitError, &message, false)
    }
}
pub(crate) fn detail_error(code: ErrorCode, message: &str, retryable: bool) -> DetailError {
    DetailError {
        code,
        message: message.to_owned(),
        retryable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_numstat_parser_preserves_rename_paths_and_sha256_null_oid() {
        let zero = "0".repeat(64);
        let added = "a".repeat(64);
        let renamed_old = "b".repeat(64);
        let renamed_new = "c".repeat(64);
        let raw_old = b"raw-\xff.txt";
        let raw_new = b"renamed\xfe.txt";
        let mut output = Vec::new();
        output.extend_from_slice(format!(":000000 100644 {zero} {added} A\0").as_bytes());
        output.extend_from_slice(b"created.txt\0");
        output.extend_from_slice(
            format!(":100644 100644 {renamed_old} {renamed_new} R098\0").as_bytes(),
        );
        output.extend_from_slice(raw_old);
        output.push(0);
        output.extend_from_slice(raw_new);
        output.push(0);
        output.extend_from_slice(b"1\t0\tcreated.txt\0");
        output.extend_from_slice(b"2\t1\t\0");
        output.extend_from_slice(raw_old);
        output.push(0);
        output.extend_from_slice(raw_new);
        output.push(0);

        let files = parse_diff_output(&output, 64).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].status, ChangedFileStatus::Added);
        assert_eq!(files[0].old_oid, None);
        assert_eq!(files[0].new_oid.as_deref(), Some(added.as_str()));
        assert_eq!(files[1].status, ChangedFileStatus::Renamed);
        assert_eq!(files[1].similarity, Some(98));
        assert_eq!(
            files[1].old_path.as_ref().unwrap().raw_hex,
            "7261772dff2e747874"
        );
        assert_eq!(
            files[1].new_path.as_ref().unwrap().raw_hex,
            "72656e616d6564fe2e747874"
        );
        assert!(files[1].old_path.as_ref().unwrap().text_lossy);
        assert_eq!(files[1].additions, Some(2));
        assert_eq!(files[1].deletions, Some(1));
    }

    #[test]
    fn parser_rejects_mismatched_raw_and_numstat_paths() {
        let old = "1".repeat(40);
        let new = "2".repeat(40);
        let mut output = format!(":100644 100644 {old} {new} M\0real.txt\0").into_bytes();
        output.extend_from_slice(b"1\t0\tfake.txt\0");
        assert_eq!(
            parse_diff_output(&output, 40).unwrap_err().code,
            ErrorCode::GitError
        );
    }

    #[test]
    fn gitlink_modes_are_marked_without_reading_submodule_content() {
        let old = "1".repeat(40);
        let new = "2".repeat(40);
        let mut output = format!(":160000 160000 {old} {new} M\0vendor/module\0").into_bytes();
        output.extend_from_slice(b"-\t-\tvendor/module\0");
        let files = parse_diff_output(&output, 40).unwrap();
        assert!(files[0].gitlink);
        assert!(files[0].binary);
        assert_eq!(files[0].additions, None);
    }

    #[test]
    fn live_annotated_tag_resolves_to_the_peeled_commit_oid() {
        let git = test_git_path();
        let path = std::env::temp_dir().join(format!(
            "commitscope-details-tag-{}-{}",
            std::process::id(),
            now_unix_ms()
        ));
        std::fs::create_dir_all(&path).unwrap();
        struct TempRepo(std::path::PathBuf);
        impl Drop for TempRepo {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = TempRepo(path.clone());
        test_git(&git, &path, &["init", "--quiet", "--initial-branch=main"]);
        test_git(
            &git,
            &path,
            &[
                "-c",
                "user.name=Detail Test",
                "-c",
                "user.email=detail@example.invalid",
                "commit",
                "--allow-empty",
                "--quiet",
                "-m",
                "root",
            ],
        );
        test_git(&git, &path, &["tag", "-a", "v1", "-m", "annotated"]);
        let expected = String::from_utf8(test_git(&git, &path, &["rev-parse", "HEAD^{commit}"]))
            .unwrap()
            .trim()
            .to_owned();
        let reader = ReadOnlyGit::new(git).unwrap();
        let resolved = resolve_live_ref_tip(
            &reader,
            &path,
            "refs/tags/v1",
            expected.len(),
            &AtomicBool::new(false),
            Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
        assert!(matches!(resolved, ScopeTipsSnapshot::Tips(tips) if tips == [expected]));
    }

    #[test]
    fn blob_pair_diff_contains_only_the_selected_file_content() {
        let git = test_git_path();
        let path = test_repo_path("blob-diff");
        let _cleanup = TestRepo(path.clone());
        std::fs::create_dir_all(&path).unwrap();
        test_git(&git, &path, &["init", "--quiet"]);
        configure_test_identity(&git, &path);
        std::fs::write(path.join("selected.txt"), "before selected\n").unwrap();
        std::fs::write(path.join("sibling.txt"), "before sibling\n").unwrap();
        test_git(&git, &path, &["add", "."]);
        test_git(&git, &path, &["commit", "--quiet", "-m", "first"]);
        let old_blob = git_output(&git, &path, &["rev-parse", "HEAD:selected.txt"]);
        std::fs::write(path.join("selected.txt"), "after selected\n").unwrap();
        std::fs::write(path.join("sibling.txt"), "after sibling\n").unwrap();
        test_git(&git, &path, &["add", "."]);
        test_git(&git, &path, &["commit", "--quiet", "-m", "second"]);
        let commit = git_output(&git, &path, &["rev-parse", "HEAD"]);
        let new_blob = git_output(&git, &path, &["rev-parse", "HEAD:selected.txt"]);
        let file = test_changed_file(
            Some(git_path(b"selected.txt")),
            Some(git_path(b"selected.txt")),
            Some(old_blob.clone()),
            Some(new_blob.clone()),
        );
        let args = file_diff_args(
            &commit,
            Some(&git_output(&git, &path, &["rev-parse", "HEAD^"])),
            &file,
            Some(&old_blob),
            Some(&new_blob),
            false,
        )
        .unwrap();
        let output = run_stream(&git, &path, args);
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("before selected"));
        assert!(text.contains("after selected"));
        assert!(!text.contains("sibling"));
    }

    #[test]
    fn tree_diff_uses_literal_raw_path_for_root_add_and_parent_delete() {
        let git = test_git_path();
        let path = test_repo_path("literal-diff");
        let _cleanup = TestRepo(path.clone());
        std::fs::create_dir_all(&path).unwrap();
        test_git(&git, &path, &["init", "--quiet"]);
        configure_test_identity(&git, &path);
        let unusual = "literal[*] file.txt";
        std::fs::write(path.join(unusual), "first line\n").unwrap();
        std::fs::write(path.join("literalX file.txt"), "must not match\n").unwrap();
        test_git(&git, &path, &["add", "."]);
        test_git(&git, &path, &["commit", "--quiet", "-m", "root"]);
        let root = git_output(&git, &path, &["rev-parse", "HEAD"]);
        let blob = git_output(&git, &path, &["rev-parse", &format!("HEAD:{unusual}")]);
        let file = test_changed_file(
            None,
            Some(git_path(unusual.as_bytes())),
            None,
            Some(blob.clone()),
        );
        let args = file_diff_args(&root, None, &file, None, Some(&blob), false).unwrap();
        let output = run_stream(&git, &path, args);
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("first line"));
        assert!(!text.contains("must not match"));

        test_git(&git, &path, &["rm", "--", unusual]);
        test_git(&git, &path, &["commit", "--quiet", "-m", "delete"]);
        let deleted_commit = git_output(&git, &path, &["rev-parse", "HEAD"]);
        let parent = git_output(&git, &path, &["rev-parse", "HEAD^"]);
        let deleted = test_changed_file(
            Some(git_path(unusual.as_bytes())),
            None,
            Some(blob.clone()),
            None,
        );
        let args = file_diff_args(
            &deleted_commit,
            Some(&parent),
            &deleted,
            Some(&blob),
            None,
            false,
        )
        .unwrap();
        let output = run_stream(&git, &path, args);
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("-first line"));
        assert!(!text.contains("must not match"));
    }

    #[test]
    fn lfs_pointer_detection_requires_standard_pointer_fields() {
        let pointer = format!(
            "version https://git-lfs.github.com/spec/v1\noid sha256:{}\nsize 42\n",
            "a".repeat(64)
        );
        assert!(is_lfs_pointer(pointer.as_bytes()));
        assert!(!is_lfs_pointer(
            b"ordinary text\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsize 42\n"
        ));
    }

    struct TestRepo(std::path::PathBuf);

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn test_repo_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "commitscope-details-{label}-{}-{}",
            std::process::id(),
            now_unix_ms()
        ))
    }

    fn configure_test_identity(git: &Path, repository: &Path) {
        test_git(git, repository, &["config", "user.name", "Detail Test"]);
        test_git(
            git,
            repository,
            &["config", "user.email", "detail@example.invalid"],
        );
    }

    fn git_output(git: &Path, repository: &Path, args: &[&str]) -> String {
        String::from_utf8(test_git(git, repository, args))
            .unwrap()
            .trim()
            .to_owned()
    }

    fn git_path(bytes: &[u8]) -> GitPath {
        GitPath {
            display: String::from_utf8_lossy(bytes).into_owned(),
            raw_hex: bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
            text_lossy: std::str::from_utf8(bytes).is_err(),
        }
    }

    fn test_changed_file(
        old_path: Option<GitPath>,
        new_path: Option<GitPath>,
        old_oid: Option<String>,
        new_oid: Option<String>,
    ) -> ChangedFile {
        ChangedFile {
            status: if old_oid.is_none() {
                ChangedFileStatus::Added
            } else if new_oid.is_none() {
                ChangedFileStatus::Deleted
            } else {
                ChangedFileStatus::Modified
            },
            old_path,
            new_path,
            old_oid,
            new_oid,
            old_mode: "100644".into(),
            new_mode: "100644".into(),
            similarity: None,
            additions: None,
            deletions: None,
            binary: false,
            gitlink: false,
        }
    }

    fn run_stream(git: &Path, repository: &Path, args: Vec<std::ffi::OsString>) -> Vec<u8> {
        let reader = ReadOnlyGit::new(git.to_path_buf()).unwrap();
        let mut stream = reader
            .stream_lines(repository, &args, FILE_DIFF_LINE_BYTES)
            .unwrap();
        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let mut output = Vec::new();
        while let Some(line) = stream.next_line(&cancelled, deadline).unwrap() {
            output.extend_from_slice(&line);
            output.push(b'\n');
        }
        output
    }

    fn test_git_path() -> std::path::PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|entry| entry.join(if cfg!(windows) { "git.exe" } else { "git" }))
            .find(|candidate| candidate.is_file())
            .expect("Git is available for the detail unit test")
    }

    fn test_git(git: &Path, repository: &Path, args: &[&str]) -> Vec<u8> {
        let output = std::process::Command::new(git)
            .arg("-C")
            .arg(repository)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }
}
