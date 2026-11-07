use crate::{
    details::{self, DetailError},
    git_command::{GitFailure, ReadOnlyGit, string_arg},
    repository::{self, DiscoveredRepository},
    session,
};
use commitscope_core::{
    ErrorCode, GetHandoffFactsParams, HandoffFacts, HandoffParentGroup, RefInfo, RefKind,
    RepositoryNavigation, RepositoryScope,
};
use std::{collections::BTreeSet, path::Path, sync::atomic::AtomicBool, time::Instant};

const HANDOFF_COMMIT_LIMIT: usize = 50;
const HANDOFF_GROUP_LIMIT: usize = 127;
const HANDOFF_OVERLAP_LIMIT: usize = 20;
const REF_NAME_LIMIT: usize = 16 * 1024;
const GIT_COUNT_LIMIT: usize = 4096;
const PATH_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

pub fn get_handoff_facts(
    executable: &Path,
    session: &session::RepositorySession,
    params: &GetHandoffFactsParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<HandoffFacts, DetailError> {
    repository::verify_graph_fingerprint(&session.discovered, cancelled, deadline)
        .map_err(from_preview)?;
    let discovered = &session.discovered;
    let navigation = discovered.navigation.as_ref().ok();
    let branch_ref = match params.branch_ref.as_deref() {
        Some(name) => Some(name),
        None => frozen_scope_branch_ref(&session.info.scope, discovered, navigation),
    };
    let branch = branch_ref
        .and_then(|name| captured_ref(discovered, name))
        .filter(|reference| reference.kind == RefKind::LocalBranch)
        .cloned();
    let base = navigation.and_then(|captured| captured.default_base.clone());
    let window_worktree = navigation
        .into_iter()
        .flat_map(|captured| captured.worktrees.iter())
        .find(|worktree| worktree.is_current)
        .cloned();
    let checked_out_by = branch
        .as_ref()
        .map(|branch| {
            navigation
                .into_iter()
                .flat_map(|captured| captured.worktrees.iter())
                .filter(|worktree| {
                    worktree.head_reference.as_deref() == Some(&branch.name)
                        && worktree.head_oid.as_deref() == Some(&branch.oid)
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let checked_out_by_complete = navigation.is_some_and(|captured| !captured.worktrees_truncated);
    let operation_worktree = branch.as_ref().and_then(|branch| {
        let captured = navigation?;
        if captured.worktrees_truncated || !checked_out_by_complete {
            return None;
        }
        let worktrees = captured.worktrees.iter().filter(|worktree| {
            worktree.available
                && !worktree.is_bare
                && worktree.head_reference.as_deref() == Some(&branch.name)
                && worktree.head_oid.as_deref() == Some(&branch.oid)
        });
        if let Some(requested_id) = params.operation_worktree_id.as_deref() {
            let mut matching = worktrees.filter(|worktree| worktree.id == requested_id);
            let selected = matching.next()?;
            if matching.next().is_none() {
                Some(selected.clone())
            } else {
                None
            }
        } else {
            let mut matching = worktrees;
            let selected = matching.next()?;
            if matching.next().is_none() {
                Some(selected.clone())
            } else {
                None
            }
        }
    });
    let stale_worktree = params.stale_worktree_id.as_deref().and_then(|id| {
        navigation
            .into_iter()
            .flat_map(|captured| captured.worktrees.iter())
            .find(|worktree| {
                worktree.id == id
                    && (worktree.prunable_reason.is_some()
                        || (!worktree.available && !worktree.is_main))
            })
            .cloned()
    });

    let selected_commit = match params.selected_oid.as_deref() {
        Some(oid) => {
            validate_oid(oid, discovered.oid_length)?;
            repository::read_commit_summaries(
                executable,
                discovered,
                &[oid.to_ascii_lowercase()],
                cancelled,
                deadline,
            )
            .map_err(from_preview)?
            .into_iter()
            .next()
        }
        None => None,
    };

    let mut ahead = None;
    let mut behind = None;
    let mut overlap_paths = Vec::new();
    let mut overlap_complete = false;
    let mut overlap_truncated = false;
    let mut branch_commits = Vec::new();
    let mut branch_commits_count = None;
    let mut branch_commits_truncated = false;
    let mut merge_status = None;

    if let (Some(branch), Some(base), Some(captured_navigation)) =
        (branch.as_ref(), base.as_ref(), navigation)
        && branch.kind == RefKind::LocalBranch
        && !discovered.refs_truncated
    {
        let branch_tip = branch.peeled_oid.as_deref().unwrap_or(&branch.oid);
        if !repository::history_boundary_limited(discovered) {
            let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
            let repo_path = Path::new(&discovered.info.path);
            if let Some((branch_ahead, base_behind)) =
                read_ahead_behind(&git, repo_path, &base.oid, branch_tip, cancelled, deadline)?
            {
                ahead = Some(branch_ahead);
                behind = Some(base_behind);
            }
            if let Some((paths, truncated)) =
                read_overlap_paths(&git, repo_path, &base.oid, branch_tip, cancelled, deadline)?
            {
                overlap_paths = paths;
                overlap_complete = true;
                overlap_truncated = truncated;
            }
            if let Some((commits, count, truncated)) = read_branch_commits(
                executable, &git, repo_path, discovered, &base.oid, branch_tip, cancelled, deadline,
            )? {
                branch_commits = commits;
                branch_commits_count = Some(count);
                branch_commits_truncated = truncated;
            }
        }
        let merge = crate::navigation::ref_merge_status(
            executable,
            &discovered.info.path,
            captured_navigation,
            std::slice::from_ref(&branch.name),
            discovered.oid_length,
            repository::history_boundary_limited(discovered),
            cancelled,
            deadline,
        );
        match merge {
            Ok(result) => merge_status = result.statuses.first().map(|status| status.status),
            Err(error) if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) => {
                return Err(navigation_error(error.code, error.message));
            }
            Err(_) => {}
        }
    }

    let mut changed_files = Vec::new();
    let mut changed_files_count = None;
    let mut changed_files_truncated = false;
    if let Some(commit) = selected_commit.as_ref() {
        let params = commitscope_core::ListChangedFilesParams {
            oid: commit.oid.clone(),
            parent_index: (!commit.parents.is_empty()).then_some(0),
            offset: 0,
            page_size: HANDOFF_COMMIT_LIMIT as u16,
        };
        match details::list_changed_files(executable, session, &params, cancelled, deadline) {
            Ok(page) => {
                changed_files = page.files;
                changed_files_count = Some(u64::from(page.total_files));
                changed_files_truncated = page.has_more;
            }
            Err(error) if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Timeout) => {
                return Err(error);
            }
            Err(_) => changed_files_truncated = true,
        }
    }

    let (merge_parent_groups, merge_parent_groups_truncated) = match selected_commit.as_ref() {
        Some(commit) if commit.parents.len() > 1 => {
            read_merge_parent_groups(executable, session, commit, cancelled, deadline)?
        }
        _ => (Vec::new(), false),
    };

    repository::verify_graph_fingerprint(discovered, cancelled, deadline).map_err(from_preview)?;
    Ok(HandoffFacts {
        observed_at_unix_ms: session.info.observed_at_unix_ms,
        repository: discovered.info.clone(),
        scope: session.info.scope.clone(),
        window_worktree,
        branch,
        base,
        operation_worktree,
        selected_commit,
        ahead,
        behind,
        overlap_paths,
        overlap_complete,
        overlap_truncated,
        branch_commits,
        branch_commits_truncated,
        branch_commits_count,
        changed_files,
        changed_files_truncated,
        changed_files_count,
        merge_parent_groups,
        merge_parent_groups_truncated,
        merge_status,
        checked_out_by,
        checked_out_by_complete,
        stale_worktree,
    })
}

fn frozen_scope_branch_ref<'a>(
    scope: &'a RepositoryScope,
    discovered: &'a DiscoveredRepository,
    navigation: Option<&'a RepositoryNavigation>,
) -> Option<&'a str> {
    match scope {
        RepositoryScope::Head => discovered.info.head_reference.as_deref(),
        RepositoryScope::Worktree(id) => navigation?
            .worktrees
            .iter()
            .find(|worktree| worktree.id == *id && worktree.available)?
            .head_reference
            .as_deref(),
        RepositoryScope::Ref(name) => captured_ref(discovered, name)
            .filter(|reference| reference.kind == RefKind::LocalBranch)
            .map(|reference| reference.name.as_str()),
        RepositoryScope::AllBranches => None,
    }
}

fn captured_ref<'a>(discovered: &'a DiscoveredRepository, name: &str) -> Option<&'a RefInfo> {
    if name.len() > REF_NAME_LIMIT || !name.starts_with("refs/") {
        return None;
    }
    discovered
        .refs
        .iter()
        .find(|reference| reference.name == name)
}

fn read_ahead_behind(
    git: &ReadOnlyGit,
    repository_path: &Path,
    base_oid: &str,
    branch_oid: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<(u64, u64)>, DetailError> {
    let output = match git.run(
        repository_path,
        &[
            string_arg("-c"),
            string_arg("core.commitGraph=false"),
            string_arg("rev-list"),
            string_arg("--left-right"),
            string_arg("--count"),
            string_arg(format!("{base_oid}...{branch_oid}")),
            string_arg("--"),
        ],
        None,
        GIT_COUNT_LIMIT,
        cancelled,
        deadline,
    ) {
        Ok(output) if output.status.success() => output,
        Ok(_) => return Ok(None),
        Err(error) if is_soft_git_failure(&error) => return Ok(None),
        Err(error) => return Err(from_git(error)),
    };
    let mut counts = output
        .stdout
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|part| !part.is_empty());
    let behind = parse_u64(counts.next())
        .ok_or_else(|| git_error("Git returned an invalid behind count"))?;
    let ahead =
        parse_u64(counts.next()).ok_or_else(|| git_error("Git returned an invalid ahead count"))?;
    if counts.next().is_some() {
        return Err(git_error("Git returned extra ahead/behind fields"));
    }
    Ok(Some((ahead, behind)))
}

fn read_overlap_paths(
    git: &ReadOnlyGit,
    repository_path: &Path,
    base_oid: &str,
    branch_oid: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<(Vec<commitscope_core::GitPath>, bool)>, DetailError> {
    let merge_base = match run_git(
        git,
        repository_path,
        &[
            string_arg("merge-base"),
            string_arg(base_oid),
            string_arg(branch_oid),
        ],
        GIT_COUNT_LIMIT,
        cancelled,
        deadline,
    ) {
        Ok(output) if output.status.success() => trim_line(&output.stdout).to_vec(),
        Ok(_) => return Ok(None),
        Err(error) if error.code == ErrorCode::ResourceLimit => return Ok(None),
        Err(error) => return Err(error),
    };
    if merge_base.is_empty() || !merge_base.iter().all(u8::is_ascii_hexdigit) {
        return Ok(None);
    }
    let left = match read_changed_paths(
        git,
        repository_path,
        &merge_base,
        base_oid,
        cancelled,
        deadline,
    ) {
        Ok(paths) => paths,
        Err(error) if error.code == ErrorCode::ResourceLimit => return Ok(None),
        Err(error) => return Err(error),
    };
    let right = match read_changed_paths(
        git,
        repository_path,
        &merge_base,
        branch_oid,
        cancelled,
        deadline,
    ) {
        Ok(paths) => paths,
        Err(error) if error.code == ErrorCode::ResourceLimit => return Ok(None),
        Err(error) => return Err(error),
    };
    let intersection = left.intersection(&right).cloned().collect::<Vec<_>>();
    let truncated = intersection.len() > HANDOFF_OVERLAP_LIMIT;
    let paths = intersection
        .into_iter()
        .take(HANDOFF_OVERLAP_LIMIT)
        .map(git_path)
        .collect();
    Ok(Some((paths, truncated)))
}

fn read_changed_paths(
    git: &ReadOnlyGit,
    repository_path: &Path,
    base_oid: &[u8],
    tip_oid: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<BTreeSet<Vec<u8>>, DetailError> {
    let base_oid = std::str::from_utf8(base_oid)
        .map_err(|_| git_error("Git returned a non-UTF-8 merge base"))?;
    let output = run_git(
        git,
        repository_path,
        &[
            string_arg("diff"),
            string_arg("--no-ext-diff"),
            string_arg("--no-textconv"),
            string_arg("--ignore-submodules=none"),
            string_arg("--no-relative"),
            string_arg("--no-renames"),
            string_arg("--name-only"),
            string_arg("-z"),
            string_arg(base_oid),
            string_arg(tip_oid),
            string_arg("--"),
        ],
        PATH_OUTPUT_LIMIT,
        cancelled,
        deadline,
    )?;
    if !output.status.success() {
        return Err(git_output_error(&output.stderr));
    }
    if output
        .stdout
        .split(|byte| *byte == 0)
        .any(|path| path.len() > REF_NAME_LIMIT)
    {
        return Err(resource_error("Git path exceeds the handoff path limit"));
    }
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(<[u8]>::to_vec)
        .collect())
}

fn read_branch_commits(
    executable: &Path,
    git: &ReadOnlyGit,
    repository_path: &Path,
    discovered: &DiscoveredRepository,
    base_oid: &str,
    branch_oid: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<(Vec<commitscope_core::CommitSummary>, u64, bool)>, DetailError> {
    let count_output = match run_git(
        git,
        repository_path,
        &[
            string_arg("-c"),
            string_arg("core.commitGraph=false"),
            string_arg("rev-list"),
            string_arg("--count"),
            string_arg(branch_oid),
            string_arg("--not"),
            string_arg(base_oid),
            string_arg("--"),
        ],
        GIT_COUNT_LIMIT,
        cancelled,
        deadline,
    ) {
        Ok(output) if output.status.success() => output,
        Ok(_) => return Ok(None),
        Err(error) if is_soft_detail_failure(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let count = parse_u64(Some(trim_line(&count_output.stdout)))
        .ok_or_else(|| git_error("Git returned an invalid branch commit count"))?;
    let list_output = run_git(
        git,
        repository_path,
        &[
            string_arg("-c"),
            string_arg("core.commitGraph=false"),
            string_arg("rev-list"),
            string_arg("--topo-order"),
            string_arg(format!("--max-count={HANDOFF_COMMIT_LIMIT}")),
            string_arg(branch_oid),
            string_arg("--not"),
            string_arg(base_oid),
            string_arg("--"),
        ],
        HANDOFF_COMMIT_LIMIT * discovered.oid_length.saturating_add(1),
        cancelled,
        deadline,
    )?;
    if !list_output.status.success() {
        return Err(git_output_error(&list_output.stderr));
    }
    let oids = parse_oid_lines(&list_output.stdout, discovered.oid_length)?;
    let commits =
        repository::read_commit_summaries(executable, discovered, &oids, cancelled, deadline)
            .map_err(from_preview)?;
    Ok(Some((commits, count, count > HANDOFF_COMMIT_LIMIT as u64)))
}

fn read_merge_parent_groups(
    executable: &Path,
    session: &session::RepositorySession,
    commit: &commitscope_core::CommitSummary,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(Vec<HandoffParentGroup>, bool), DetailError> {
    if repository::history_boundary_limited(&session.discovered) {
        return Ok((
            commit
                .parents
                .iter()
                .enumerate()
                .skip(1)
                .map(|(index, _)| HandoffParentGroup {
                    parent_index: index as u16,
                    total_count: None,
                    commits: Vec::new(),
                    truncated: true,
                })
                .collect(),
            true,
        ));
    }
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    let first_parent = commit
        .parents
        .first()
        .expect("merge commit has a first parent");
    let mut remaining = HANDOFF_COMMIT_LIMIT;
    let mut groups = Vec::with_capacity(commit.parents.len() - 1);
    let mut any_truncated = false;
    for (parent_index, parent_oid) in commit.parents.iter().enumerate().skip(1) {
        let count_output = run_git(
            &git,
            Path::new(&session.discovered.info.path),
            &[
                string_arg("-c"),
                string_arg("core.commitGraph=false"),
                string_arg("rev-list"),
                string_arg("--count"),
                string_arg(parent_oid),
                string_arg("--not"),
                string_arg(first_parent),
                string_arg("--"),
            ],
            GIT_COUNT_LIMIT,
            cancelled,
            deadline,
        )?;
        if !count_output.status.success() {
            return Err(git_output_error(&count_output.stderr));
        }
        let total_count = parse_u64(Some(trim_line(&count_output.stdout)))
            .ok_or_else(|| git_error("Git returned an invalid merge group count"))?;
        let page_limit = remaining.max(1);
        let list_output = run_git(
            &git,
            Path::new(&session.discovered.info.path),
            &[
                string_arg("-c"),
                string_arg("core.commitGraph=false"),
                string_arg("rev-list"),
                string_arg("--topo-order"),
                string_arg(format!("--max-count={page_limit}")),
                string_arg(parent_oid),
                string_arg("--not"),
                string_arg(first_parent),
                string_arg("--"),
            ],
            page_limit.saturating_mul(session.discovered.oid_length + 1),
            cancelled,
            deadline,
        )?;
        if !list_output.status.success() {
            return Err(git_output_error(&list_output.stderr));
        }
        let oids = parse_oid_lines(&list_output.stdout, session.discovered.oid_length)?;
        let summaries = repository::read_commit_summaries(
            executable,
            &session.discovered,
            &oids,
            cancelled,
            deadline,
        )
        .map_err(from_preview)?;
        let took = summaries.len().min(remaining);
        let truncated = total_count > took as u64;
        remaining = remaining.saturating_sub(took);
        any_truncated |= truncated;
        groups.push(HandoffParentGroup {
            parent_index: parent_index as u16,
            total_count: Some(total_count),
            commits: summaries.into_iter().take(took).collect(),
            truncated,
        });
    }
    if groups.len() > HANDOFF_GROUP_LIMIT {
        groups.truncate(HANDOFF_GROUP_LIMIT);
        any_truncated = true;
    }
    Ok((groups, any_truncated))
}

fn run_git(
    git: &ReadOnlyGit,
    repository_path: &Path,
    args: &[std::ffi::OsString],
    output_limit: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<crate::git_command::CommandOutput, DetailError> {
    git.run(
        repository_path,
        args,
        None,
        output_limit,
        cancelled,
        deadline,
    )
    .map_err(from_git)
}

fn parse_oid_lines(bytes: &[u8], oid_length: usize) -> Result<Vec<String>, DetailError> {
    bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            if line.len() != oid_length || !line.iter().all(u8::is_ascii_hexdigit) {
                return Err(git_error("Git returned an invalid object ID"));
            }
            Ok(String::from_utf8_lossy(line).to_ascii_lowercase())
        })
        .collect()
}

fn validate_oid(oid: &str, expected_len: usize) -> Result<(), DetailError> {
    if oid.len() == expected_len && oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(DetailError {
            code: ErrorCode::InvalidRequest,
            message: "Commit OID has an invalid format".into(),
            retryable: false,
        })
    }
}

fn parse_u64(value: Option<&[u8]>) -> Option<u64> {
    std::str::from_utf8(value?).ok()?.trim().parse().ok()
}

fn trim_line(bytes: &[u8]) -> &[u8] {
    bytes.strip_suffix(b"\n").unwrap_or(bytes)
}

fn git_path(raw: Vec<u8>) -> commitscope_core::GitPath {
    let text_lossy = std::str::from_utf8(&raw).is_err();
    let display = String::from_utf8_lossy(&raw).into_owned();
    let raw_hex = raw.iter().map(|byte| format!("{byte:02x}")).collect();
    commitscope_core::GitPath {
        display,
        raw_hex,
        text_lossy,
    }
}

fn from_preview(error: repository::PreviewError) -> DetailError {
    DetailError {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
    }
}

fn from_git(error: GitFailure) -> DetailError {
    let (code, message, retryable) = match error {
        GitFailure::Cancelled => (
            ErrorCode::Cancelled,
            "Handoff facts request was cancelled".into(),
            true,
        ),
        GitFailure::Timeout => (
            ErrorCode::Timeout,
            "Handoff facts request timed out".into(),
            true,
        ),
        GitFailure::ResourceLimit => (
            ErrorCode::ResourceLimit,
            "Handoff facts exceeded a Git output limit".into(),
            false,
        ),
        GitFailure::Unavailable(message) => (ErrorCode::GitUnavailable, message, true),
        GitFailure::CommandFailed(message) => (ErrorCode::GitError, message, false),
    };
    DetailError {
        code,
        message,
        retryable,
    }
}

fn is_soft_git_failure(error: &GitFailure) -> bool {
    matches!(
        error,
        GitFailure::ResourceLimit | GitFailure::Unavailable(_) | GitFailure::CommandFailed(_)
    )
}

fn is_soft_detail_failure(error: &DetailError) -> bool {
    matches!(
        error.code,
        ErrorCode::ResourceLimit | ErrorCode::GitUnavailable | ErrorCode::GitError
    )
}

fn navigation_error(code: ErrorCode, message: String) -> DetailError {
    DetailError {
        code,
        message,
        retryable: matches!(code, ErrorCode::Cancelled | ErrorCode::Timeout),
    }
}

fn git_output_error(stderr: &[u8]) -> DetailError {
    DetailError {
        code: ErrorCode::GitError,
        message: String::from_utf8_lossy(stderr)
            .trim()
            .chars()
            .take(512)
            .collect(),
        retryable: false,
    }
}

fn git_error(message: &str) -> DetailError {
    DetailError {
        code: ErrorCode::GitError,
        message: message.into(),
        retryable: false,
    }
}

fn resource_error(message: &str) -> DetailError {
    DetailError {
        code: ErrorCode::ResourceLimit,
        message: message.into(),
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{repository, session::SessionManager, session_store::SessionStore};
    use std::{
        env, fs,
        path::PathBuf,
        process::{Command, Output},
        sync::{Arc, atomic::AtomicBool},
        time::Duration,
    };

    struct FixtureDir(PathBuf);

    impl FixtureDir {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = env::temp_dir().join(format!(
                "commitscope-handoff-test-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create isolated handoff fixture directory");
            Self(path)
        }
    }

    impl Drop for FixtureDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn handoff_facts_distinguish_window_and_branch_worktrees_without_faking_missing_base() {
        if env::var_os("COMMITSCOPE_APP_DATA_DIR").is_some() {
            eprintln!(
                "skip handoff fixture: app data override would make SessionStore write outside the temporary fixture"
            );
            return;
        }
        let git = git_executable();
        let fixture = FixtureDir::new();
        let repository_path = fixture.0.join("repository with spaces");
        let linked_path = fixture.0.join("feature worktree");
        fs::create_dir_all(&repository_path).expect("create fixture repository");
        run_git(
            &git,
            &repository_path,
            &["init", "--quiet", "--initial-branch=window"],
        );
        run_git(
            &git,
            &repository_path,
            &["config", "user.name", "Fixture Author"],
        );
        run_git(
            &git,
            &repository_path,
            &["config", "user.email", "fixture@example.invalid"],
        );
        run_git(&git, &repository_path, &["config", "gc.auto", "0"]);
        run_git(
            &git,
            &repository_path,
            &["config", "maintenance.auto", "false"],
        );
        fs::write(repository_path.join("base.txt"), "base\n").expect("write base file");
        run_git(&git, &repository_path, &["add", "base.txt"]);
        run_git(
            &git,
            &repository_path,
            &["commit", "--quiet", "-m", "window base"],
        );
        run_git(
            &git,
            &repository_path,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "feature",
                linked_path.to_str().expect("UTF-8 fixture path"),
                "HEAD",
            ],
        );
        let linked_path =
            fs::canonicalize(&linked_path).expect("canonicalize linked worktree path");
        fs::write(linked_path.join("feature.txt"), "feature\n").expect("write feature file");
        run_git(&git, &linked_path, &["add", "feature.txt"]);
        run_git(
            &git,
            &linked_path,
            &["commit", "--quiet", "-m", "feature commit"],
        );
        let branch_oid = stdout_line(run_git(
            &git,
            &repository_path,
            &["rev-parse", "refs/heads/feature"],
        ));

        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(20);
        let discovered = Arc::new(
            repository::discover_repository(
                &git,
                repository_path.to_str().expect("UTF-8 fixture path"),
                &cancelled,
                deadline,
            )
            .expect("discover the independent fixture"),
        );
        let mut manager = SessionManager::new(SessionStore::from_env());
        let open_cancelled = Arc::new(AtomicBool::new(false));
        let intent = manager.begin_open(Arc::clone(&open_cancelled));
        let opened = manager
            .commit_open(intent, &open_cancelled, Arc::clone(&discovered))
            .expect("commit the fixture session");
        let linked_id = discovered
            .navigation
            .as_ref()
            .expect("captured worktree list")
            .worktrees
            .iter()
            .find(|worktree| worktree.path == linked_path.to_string_lossy().as_ref())
            .expect("linked feature worktree is in the frozen snapshot")
            .id
            .clone();

        let facts = get_handoff_facts(
            &git,
            &opened.session,
            &GetHandoffFactsParams {
                branch_ref: Some("refs/heads/feature".into()),
                selected_oid: Some(branch_oid.clone()),
                operation_worktree_id: None,
                stale_worktree_id: None,
            },
            &cancelled,
            deadline,
        )
        .expect("read facts from the frozen fixture snapshot");

        let window = facts.window_worktree.expect("captured window worktree");
        let operation = facts
            .operation_worktree
            .expect("unique worktree actually on feature");
        assert_ne!(window.id, operation.id, "W1 is not guessed to be T1");
        assert_eq!(operation.id, linked_id);
        assert_eq!(operation.head_oid.as_deref(), Some(branch_oid.as_str()));
        assert_eq!(
            facts.branch.as_ref().map(|branch| branch.name.as_str()),
            Some("refs/heads/feature")
        );
        assert_eq!(facts.base, None, "there is no default base in this fixture");
        assert_eq!(
            facts.ahead, None,
            "missing base is not reported as zero ahead"
        );
        assert_eq!(
            facts.behind, None,
            "missing base is not reported as zero behind"
        );
        assert_eq!(facts.merge_status, None);
        assert_eq!(facts.changed_files_count, Some(1));
        assert_eq!(
            facts.changed_files[0]
                .new_path
                .as_ref()
                .map(|path| path.display.as_str()),
            Some("feature.txt")
        );
    }

    fn git_executable() -> PathBuf {
        env::split_paths(&env::var_os("PATH").expect("PATH available"))
            .map(|path| path.join("git"))
            .find(|path| path.is_file())
            .expect("git executable exists on PATH")
    }

    fn run_git(git: &Path, cwd: &Path, args: &[&str]) -> Output {
        let output = Command::new(git)
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .expect("run fixture git command");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    fn stdout_line(output: Output) -> String {
        String::from_utf8(output.stdout)
            .expect("git OID output is UTF-8")
            .trim()
            .to_owned()
    }
}
