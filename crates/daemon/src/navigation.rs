use crate::git_command::{GitFailure, ReadOnlyGit, string_arg};
use commitscope_core::{
    DefaultBase, ErrorCode, MergeStatus, RefInfo, RefKind, RefMergeStatus, RefMergeStatusResult,
    RepositoryNavigation, WorktreeInfo,
};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

const WORKTREE_LIMIT: usize = 128;
const WORKTREE_OUTPUT_LIMIT: usize = 1024 * 1024;
const WORKTREE_PATH_LIMIT: usize = 16 * 1024;
const REF_NAME_LIMIT: usize = 16 * 1024;

#[derive(Debug, Clone)]
pub struct NavigationError {
    pub code: ErrorCode,
    pub message: String,
}

#[allow(clippy::too_many_arguments)]
pub fn capture(
    executable: &Path,
    repository_path: &str,
    current_worktree_path: &str,
    common_dir: &str,
    object_format: &str,
    refs: &[RefInfo],
    refs_truncated: bool,
    observed_at_unix_ms: u64,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<RepositoryNavigation, NavigationError> {
    let worktrees = read_worktrees(
        executable,
        repository_path,
        current_worktree_path,
        common_dir,
        object_format,
        cancelled,
        deadline,
    )?;
    let default_base = if refs_truncated {
        None
    } else {
        default_base(executable, repository_path, refs, cancelled, deadline)?
    };
    Ok(RepositoryNavigation {
        refs: refs.to_vec(),
        refs_truncated,
        worktrees: worktrees.0,
        worktrees_truncated: worktrees.1,
        default_base,
        observed_at_unix_ms,
    })
}

pub fn resolve_scope_tip(
    executable: &Path,
    repository_path: &str,
    refs: &[RefInfo],
    ref_name: &str,
    oid_length: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<String, NavigationError> {
    if ref_name.len() > REF_NAME_LIMIT
        || !(ref_name.starts_with("refs/heads/")
            || ref_name.starts_with("refs/remotes/")
            || ref_name.starts_with("refs/tags/"))
        || !refs.iter().any(|reference| reference.name == ref_name)
    {
        return Err(scope_unavailable(
            "The selected reference is not in the captured reference list",
        ));
    }
    let reference = refs
        .iter()
        .find(|reference| reference.name == ref_name)
        .ok_or_else(|| {
            scope_unavailable("The selected reference is not in the captured reference list")
        })?;
    let captured_oid = reference.peeled_oid.as_deref().unwrap_or(&reference.oid);
    validate_oid(captured_oid, oid_length)?;
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_git_error)?;
    let output = git
        .run(
            Path::new(repository_path),
            &[
                string_arg("rev-parse"),
                string_arg("--verify"),
                string_arg("--end-of-options"),
                string_arg(format!("{captured_oid}^{{commit}}")),
            ],
            None,
            4096,
            cancelled,
            deadline,
        )
        .map_err(map_git_error)?;
    if !output.status.success() {
        return Err(scope_unavailable(
            "The selected reference does not resolve to a commit",
        ));
    }
    let oid = one_line(&output.stdout)
        .ok_or_else(|| scope_unavailable("Git returned an invalid commit ID"))?;
    validate_oid(&oid, oid_length)?;
    Ok(oid)
}

pub fn resolve_worktree_tip(
    navigation: &RepositoryNavigation,
    id: &str,
) -> Result<Option<String>, NavigationError> {
    let worktree = navigation
        .worktrees
        .iter()
        .find(|worktree| worktree.id == id)
        .ok_or_else(|| {
            scope_unavailable("The selected worktree is not in the captured worktree list")
        })?;
    if !worktree.available || worktree.is_bare {
        return Err(scope_unavailable("The selected worktree is unavailable"));
    }
    Ok(worktree.head_oid.clone())
}

#[allow(clippy::too_many_arguments)]
pub fn scope_tips(
    executable: &Path,
    repository_path: &str,
    navigation: &RepositoryNavigation,
    refs_truncated: bool,
    scope: &commitscope_core::RepositoryScope,
    head_oid: Option<&str>,
    oid_length: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<String>, NavigationError> {
    use commitscope_core::RepositoryScope;
    match scope {
        RepositoryScope::Head => Ok(head_oid.into_iter().map(str::to_owned).collect()),
        RepositoryScope::AllBranches => {
            if refs_truncated {
                return Err(NavigationError {
                    code: ErrorCode::ResourceLimit,
                    message:
                        "All branches cannot be resolved because the reference list was truncated"
                            .into(),
                });
            }
            let mut tips = Vec::new();
            for reference in &navigation.refs {
                if matches!(reference.kind, RefKind::LocalBranch | RefKind::RemoteBranch) {
                    validate_oid(&reference.oid, oid_length)?;
                    if !tips.contains(&reference.oid) {
                        tips.push(reference.oid.clone());
                    }
                }
            }
            Ok(tips)
        }
        RepositoryScope::Ref(name) => Ok(vec![resolve_scope_tip(
            executable,
            repository_path,
            &navigation.refs,
            name,
            oid_length,
            cancelled,
            deadline,
        )?]),
        RepositoryScope::Worktree(id) => {
            Ok(resolve_worktree_tip(navigation, id)?.into_iter().collect())
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn ref_merge_status(
    executable: &Path,
    repository_path: &str,
    navigation: &RepositoryNavigation,
    ref_names: &[String],
    oid_length: usize,
    history_boundary_limited: bool,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<RefMergeStatusResult, NavigationError> {
    if ref_names.is_empty() || ref_names.len() > 50 {
        return Err(NavigationError {
            code: ErrorCode::InvalidRequest,
            message: "refNames must contain between 1 and 50 names".into(),
        });
    }
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_git_error)?;
    let mut statuses = Vec::with_capacity(ref_names.len());
    for name in ref_names {
        if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err(if cancelled.load(Ordering::Acquire) {
                NavigationError {
                    code: ErrorCode::Cancelled,
                    message: "Reference status query cancelled".into(),
                }
            } else {
                NavigationError {
                    code: ErrorCode::Timeout,
                    message: "Reference status query timed out".into(),
                }
            });
        }
        let Some(reference) = navigation
            .refs
            .iter()
            .find(|reference| reference.name == *name && reference.kind == RefKind::LocalBranch)
        else {
            return Err(scope_unavailable(
                "Merge status only accepts captured local branches",
            ));
        };
        validate_oid(&reference.oid, oid_length)?;
        let status = match navigation.default_base.as_ref() {
            None => MergeStatus::Unavailable,
            Some(base) => {
                validate_oid(&base.oid, oid_length)?;
                let output = git.run(
                    Path::new(repository_path),
                    &[
                        string_arg("merge-base"),
                        string_arg("--is-ancestor"),
                        string_arg(&reference.oid),
                        string_arg(&base.oid),
                    ],
                    None,
                    4096,
                    cancelled,
                    deadline,
                );
                match output {
                    Ok(output) if output.status.success() => MergeStatus::Merged,
                    Ok(output) if output.status.code() == Some(1) && !history_boundary_limited => {
                        match crate::patch_equivalence::compare(
                            &git,
                            Path::new(repository_path),
                            &base.oid,
                            &reference.oid,
                            cancelled,
                            deadline,
                        ) {
                            Ok(true) => MergeStatus::PatchEquivalent,
                            Ok(false) => MergeStatus::NotMerged,
                            Err(error @ (GitFailure::Cancelled | GitFailure::Timeout)) => {
                                return Err(map_git_error(error));
                            }
                            Err(_) => MergeStatus::Unavailable,
                        }
                    }
                    Ok(output) if output.status.code() == Some(1) => MergeStatus::Unavailable,
                    Err(GitFailure::Cancelled) => {
                        return Err(NavigationError {
                            code: ErrorCode::Cancelled,
                            message: "Reference status query cancelled".into(),
                        });
                    }
                    Err(GitFailure::Timeout) => {
                        return Err(NavigationError {
                            code: ErrorCode::Timeout,
                            message: "Reference status query timed out".into(),
                        });
                    }
                    _ => MergeStatus::Unavailable,
                }
            }
        };
        statuses.push(RefMergeStatus {
            name: name.clone(),
            oid: reference.oid.clone(),
            status,
        });
    }
    Ok(RefMergeStatusResult {
        default_base: navigation.default_base.clone(),
        statuses,
    })
}

fn default_base(
    executable: &Path,
    repository_path: &str,
    refs: &[RefInfo],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<DefaultBase>, NavigationError> {
    let origin_head = refs
        .iter()
        .find(|reference| {
            reference.name == "refs/remotes/origin/HEAD"
                && reference.kind == RefKind::RemoteBranch
                && reference.symbolic_target.as_deref().is_some_and(|target| {
                    target.starts_with("refs/remotes/origin/")
                        && refs
                            .iter()
                            .any(|item| item.name == target && item.kind == RefKind::RemoteBranch)
                })
        })
        .and_then(|reference| reference.symbolic_target.as_deref());
    let candidates = [
        origin_head,
        Some("refs/remotes/origin/main"),
        Some("refs/remotes/origin/master"),
        Some("refs/heads/main"),
        Some("refs/heads/master"),
    ];
    for name in candidates.into_iter().flatten() {
        let Some(reference) = refs.iter().find(|reference| reference.name == name) else {
            continue;
        };
        match resolve_scope_tip(
            executable,
            repository_path,
            refs,
            name,
            reference.oid.len(),
            cancelled,
            deadline,
        ) {
            Ok(oid) => {
                return Ok(Some(DefaultBase {
                    name: name.to_owned(),
                    oid,
                }));
            }
            Err(error) if error.code == ErrorCode::ScopeUnavailable => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

fn read_worktrees(
    executable: &Path,
    repository_path: &str,
    current_worktree_path: &str,
    common_dir: &str,
    object_format: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(Vec<WorktreeInfo>, bool), NavigationError> {
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_git_error)?;
    let output = git
        .run(
            Path::new(repository_path),
            &[
                string_arg("worktree"),
                string_arg("list"),
                string_arg("--porcelain"),
                string_arg("-z"),
            ],
            None,
            WORKTREE_OUTPUT_LIMIT,
            cancelled,
            deadline,
        )
        .map_err(map_git_error)?;
    if !output.status.success() {
        return Err(NavigationError {
            code: ErrorCode::GitError,
            message: "Git could not list worktrees".into(),
        });
    }
    let records = parse_worktree_porcelain(&output.stdout)?;
    let truncated = records.len() > WORKTREE_LIMIT;
    let mut result = Vec::with_capacity(records.len().min(WORKTREE_LIMIT));
    let oid_length = match object_format {
        "sha1" => 40,
        "sha256" => 64,
        _ => {
            return Err(NavigationError {
                code: ErrorCode::UnsupportedRepository,
                message: "Unsupported object format".into(),
            });
        }
    };
    for (index, record) in records.into_iter().take(WORKTREE_LIMIT).enumerate() {
        if cancelled.load(Ordering::Acquire) {
            return Err(NavigationError {
                code: ErrorCode::Cancelled,
                message: "Worktree query cancelled".into(),
            });
        }
        let path = record
            .path
            .ok_or_else(|| malformed_worktree("Missing worktree path"))?;
        if path.is_empty()
            || path.len() > WORKTREE_PATH_LIMIT
            || path.contains('\0')
            || !Path::new(&path).is_absolute()
        {
            return Err(malformed_worktree(
                "Worktree path is invalid or exceeds its limit",
            ));
        }
        let head_oid = match record.head.as_deref() {
            None => None,
            Some(oid) if oid.len() == oid_length && oid.bytes().all(|b| b == b'0') => None,
            Some(oid) => {
                validate_oid(oid, oid_length)?;
                Some(oid.to_ascii_lowercase())
            }
        };
        let id = worktree_id(common_dir, object_format, &path);
        let is_current = canonical_equal(&path, current_worktree_path);
        let available = !record.bare && record.prunable.is_none() && Path::new(&path).is_dir();
        result.push(WorktreeInfo {
            is_main: index == 0,
            is_current,
            id,
            path: path.clone(),
            head_oid,
            head_reference: record.branch,
            is_bare: record.bare,
            is_detached: record.detached,
            locked_reason: record.locked,
            prunable_reason: record.prunable,
            available,
        });
    }
    Ok((result, truncated))
}

#[derive(Default)]
struct WorktreeRecord {
    path: Option<String>,
    head: Option<String>,
    branch: Option<String>,
    bare: bool,
    detached: bool,
    locked: Option<String>,
    prunable: Option<String>,
}

fn parse_worktree_porcelain(bytes: &[u8]) -> Result<Vec<WorktreeRecord>, NavigationError> {
    if bytes.len() > WORKTREE_OUTPUT_LIMIT {
        return Err(NavigationError {
            code: ErrorCode::ResourceLimit,
            message: "Worktree list exceeds the output limit".into(),
        });
    }
    let fields = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut records = Vec::new();
    let mut record = WorktreeRecord::default();
    let mut has_fields = false;
    for field in fields {
        if field.is_empty() {
            if has_fields {
                records.push(record);
                record = WorktreeRecord::default();
                has_fields = false;
            }
            continue;
        }
        has_fields = true;
        let (key, value) = match field.iter().position(|byte| *byte == b' ') {
            Some(index) => (&field[..index], Some(&field[index + 1..])),
            None => (field, None),
        };
        let text = |bytes: &[u8]| {
            String::from_utf8(bytes.to_vec())
                .map_err(|_| malformed_worktree("Worktree metadata is not valid UTF-8"))
        };
        match (key, value) {
            (b"worktree", Some(value)) => record.path = Some(text(value)?),
            (b"HEAD", Some(value)) => record.head = Some(text(value)?),
            (b"branch", Some(value)) => record.branch = Some(text(value)?),
            (b"bare", None) => record.bare = true,
            (b"detached", None) => record.detached = true,
            (b"locked", None) => record.locked = Some(String::new()),
            (b"locked", Some(value)) => record.locked = Some(text(value)?),
            (b"prunable", None) => record.prunable = Some(String::new()),
            (b"prunable", Some(value)) => record.prunable = Some(text(value)?),
            _ => return Err(malformed_worktree("Git returned an unknown worktree field")),
        }
    }
    if has_fields {
        records.push(record);
    }
    Ok(records)
}

fn canonical_equal(a: &str, b: &str) -> bool {
    matches!((Path::new(a).canonicalize(), Path::new(b).canonicalize()), (Ok(a), Ok(b)) if a == b)
}

fn worktree_id(common_dir: &str, object_format: &str, path: &str) -> String {
    let mut repository_hash = Sha256::new();
    repository_hash.update(b"commitscope:repository:v1\0");
    repository_hash.update((common_dir.len() as u64).to_be_bytes());
    repository_hash.update(common_dir.as_bytes());
    repository_hash.update((object_format.len() as u64).to_be_bytes());
    repository_hash.update(object_format.as_bytes());
    let repository_key = format!("sha256:{}", hex(&repository_hash.finalize()));
    let mut hash = Sha256::new();
    hash.update(b"commitscope:navigation-worktree:v1\0");
    hash.update((repository_key.len() as u64).to_be_bytes());
    hash.update(repository_key.as_bytes());
    hash.update((path.len() as u64).to_be_bytes());
    hash.update(path.as_bytes());
    format!("worktree:{}", hex(&hash.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn one_line(bytes: &[u8]) -> Option<String> {
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    String::from_utf8(bytes.to_vec()).ok()
}
fn validate_oid(oid: &str, expected_length: usize) -> Result<(), NavigationError> {
    if oid.len() != expected_length || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(malformed_worktree("Git returned an invalid object ID"));
    }
    Ok(())
}
fn scope_unavailable(message: &str) -> NavigationError {
    NavigationError {
        code: ErrorCode::ScopeUnavailable,
        message: message.into(),
    }
}
fn malformed_worktree(message: &str) -> NavigationError {
    NavigationError {
        code: ErrorCode::GitError,
        message: message.into(),
    }
}
fn map_git_error(error: GitFailure) -> NavigationError {
    match error {
        GitFailure::Cancelled => NavigationError {
            code: ErrorCode::Cancelled,
            message: "Navigation query cancelled".into(),
        },
        GitFailure::Timeout => NavigationError {
            code: ErrorCode::Timeout,
            message: "Navigation query timed out".into(),
        },
        GitFailure::ResourceLimit => NavigationError {
            code: ErrorCode::ResourceLimit,
            message: "Navigation output exceeds the limit".into(),
        },
        GitFailure::Unavailable(message) => NavigationError {
            code: ErrorCode::RepositoryUnavailable,
            message,
        },
        GitFailure::CommandFailed(message) => NavigationError {
            code: ErrorCode::GitError,
            message,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicBool, AtomicU64, Ordering},
    };

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct TempRepo(PathBuf);
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git_path() -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").expect("PATH"))
            .map(|directory| directory.join(if cfg!(windows) { "git.exe" } else { "git" }))
            .find(|path| path.is_file())
            .expect("git executable")
    }

    fn fixture() -> (TempRepo, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "commitscope-navigation-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let path = root.join("main");
        fs::create_dir_all(&path).unwrap();
        let repo = TempRepo(root);
        run_git(&path, &["init", "-q", "-b", "main"]);
        run_git(&path, &["config", "user.name", "Navigation Test"]);
        run_git(&path, &["config", "user.email", "navigation@example.test"]);
        (repo, path)
    }

    fn run_git(path: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Navigation Test")
            .env("GIT_AUTHOR_EMAIL", "navigation@example.test")
            .env("GIT_COMMITTER_NAME", "Navigation Test")
            .env("GIT_COMMITTER_EMAIL", "navigation@example.test")
            .output()
            .expect("run git fixture command");
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn commit(path: &Path, contents: &str, message: &str) -> String {
        fs::write(path.join("file.txt"), contents).unwrap();
        run_git(path, &["add", "file.txt"]);
        run_git(path, &["commit", "-q", "-m", message]);
        run_git(path, &["rev-parse", "HEAD"])
    }

    fn discover(path: &Path) -> crate::repository::DiscoveredRepository {
        let cancelled = AtomicBool::new(false);
        crate::repository::discover_repository(
            &git_path(),
            &path.to_string_lossy(),
            &cancelled,
            Instant::now() + std::time::Duration::from_secs(10),
        )
        .unwrap()
    }

    #[test]
    fn porcelain_parser_preserves_embedded_newlines_and_locked_reason() {
        let bytes = b"worktree /tmp/main\nrepo\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0worktree /tmp/linked\nrepo\0HEAD 0000000000000000000000000000000000000000\0locked custom reason\0\0";
        let records = parse_worktree_porcelain(bytes).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].path.as_deref(), Some("/tmp/main\nrepo"));
        assert_eq!(records[0].branch.as_deref(), Some("refs/heads/main"));
        assert_eq!(records[1].locked.as_deref(), Some("custom reason"));
    }

    #[test]
    fn reference_scope_resolves_the_captured_oid_after_the_ref_moves() {
        let (_repo, path) = fixture();
        let captured = commit(&path, "first", "first");
        run_git(&path, &["update-ref", "refs/heads/feature", &captured]);
        let discovered = discover(&path);
        let changed = commit(&path, "second", "second");
        run_git(&path, &["update-ref", "refs/heads/feature", &changed]);

        let tip = resolve_scope_tip(
            &git_path(),
            &path.to_string_lossy(),
            &discovered.refs,
            "refs/heads/feature",
            discovered.oid_length,
            &AtomicBool::new(false),
            Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(tip, captured);
    }

    #[test]
    fn merge_status_uses_branch_as_ancestor_of_frozen_default_base() {
        let (_repo, path) = fixture();
        let first = commit(&path, "first", "first");
        let base = commit(&path, "base", "base");
        run_git(&path, &["update-ref", "refs/remotes/origin/main", &base]);
        run_git(
            &path,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        run_git(&path, &["update-ref", "refs/heads/merged", &first]);
        let _ahead = commit(&path, "ahead", "ahead");
        run_git(&path, &["branch", "ahead"]);
        let discovered = discover(&path);
        let navigation = discovered.navigation.as_ref().unwrap();
        assert_eq!(
            navigation.default_base.as_ref().unwrap().name,
            "refs/remotes/origin/main"
        );
        assert_eq!(navigation.default_base.as_ref().unwrap().oid, base);
        let moved = run_git(&path, &["rev-parse", "HEAD"]);
        run_git(&path, &["update-ref", "refs/remotes/origin/main", &moved]);
        let result = ref_merge_status(
            &git_path(),
            &path.to_string_lossy(),
            navigation,
            &["refs/heads/merged".into(), "refs/heads/ahead".into()],
            discovered.oid_length,
            crate::repository::history_boundary_limited(&discovered),
            &AtomicBool::new(false),
            Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(result.statuses[0].status, MergeStatus::Merged);
        assert_eq!(result.statuses[1].status, MergeStatus::NotMerged);
        let shallow_result = ref_merge_status(
            &git_path(),
            &path.to_string_lossy(),
            navigation,
            &["refs/heads/ahead".into()],
            discovered.oid_length,
            true,
            &AtomicBool::new(false),
            Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(shallow_result.statuses[0].status, MergeStatus::Unavailable);
        let independent = run_git(
            &path,
            &["merge-base", "--is-ancestor", "refs/heads/merged", &base],
        );
        assert!(independent.is_empty());
    }

    #[test]
    fn merge_status_recognizes_rewritten_patches_without_changing_repository() {
        for scenario in [
            "merge",
            "squash",
            "rebase",
            "cherry-pick",
            "modified-squash",
            "partial",
            "empty",
        ] {
            let (_repo, path) = fixture();
            let root = commit(&path, "root\n", "root");
            run_git(&path, &["checkout", "-q", "-b", "feature"]);
            let first = if scenario == "empty" {
                run_git(&path, &["commit", "-q", "--allow-empty", "-m", "empty"]);
                run_git(&path, &["rev-parse", "HEAD"])
            } else {
                commit(&path, "root\nfirst\n", "first feature change")
            };
            let tip = if scenario == "empty" {
                first.clone()
            } else {
                commit(&path, "root\nfirst\nsecond\n", "second feature change")
            };
            run_git(&path, &["checkout", "-q", "main"]);
            fs::write(path.join("unrelated.txt"), "main advanced\n").unwrap();
            run_git(&path, &["add", "unrelated.txt"]);
            run_git(&path, &["commit", "-q", "-m", "base advanced"]);
            match scenario {
                "merge" => {
                    run_git(&path, &["merge", "-q", "--no-ff", "feature", "-m", "merge"]);
                }
                "squash" | "modified-squash" => {
                    run_git(&path, &["merge", "-q", "--squash", "feature"]);
                    if scenario == "modified-squash" {
                        fs::write(path.join("extra.txt"), "additional changes while merging\n")
                            .unwrap();
                        run_git(&path, &["add", "extra.txt"]);
                    }
                    run_git(
                        &path,
                        &["commit", "-q", "-m", "squashed with different message"],
                    );
                }
                "cherry-pick" => {
                    run_git(&path, &["cherry-pick", &first, &tip]);
                }
                "partial" => {
                    run_git(&path, &["cherry-pick", &first]);
                }
                "rebase" => {
                    run_git(&path, &["checkout", "-q", "-b", "rebased", "feature"]);
                    run_git(&path, &["rebase", "main"]);
                    run_git(&path, &["checkout", "-q", "main"]);
                    run_git(&path, &["merge", "--ff-only", "rebased"]);
                }
                _ => {}
            }
            let base = run_git(&path, &["rev-parse", "main"]);
            run_git(&path, &["update-ref", "refs/remotes/origin/main", &base]);
            let discovered = discover(&path);
            // Moving live refs after capture must not affect the old comparison.
            run_git(&path, &["update-ref", "refs/remotes/origin/main", &root]);
            let before = [
                run_git(&path, &["show-ref"]),
                run_git(&path, &["status", "--porcelain=v1"]),
                run_git(&path, &["count-objects", "-v"]),
            ];
            let result = ref_merge_status(
                &git_path(),
                &path.to_string_lossy(),
                discovered.navigation.as_ref().unwrap(),
                &["refs/heads/feature".into()],
                discovered.oid_length,
                false,
                &AtomicBool::new(false),
                Instant::now() + std::time::Duration::from_secs(10),
            )
            .unwrap();
            let expected = match scenario {
                "merge" => MergeStatus::Merged,
                "squash" | "rebase" | "cherry-pick" => MergeStatus::PatchEquivalent,
                _ => MergeStatus::NotMerged,
            };
            assert_eq!(result.statuses[0].status, expected, "{scenario}");
            assert_eq!(
                before,
                [
                    run_git(&path, &["show-ref"]),
                    run_git(&path, &["status", "--porcelain=v1"]),
                    run_git(&path, &["count-objects", "-v"])
                ]
            );
            let cherry = run_git(&path, &["cherry", &base, &tip]);
            if matches!(scenario, "rebase" | "cherry-pick") {
                assert_eq!(cherry.lines().count(), 2);
                assert!(
                    cherry.lines().all(|line| line.starts_with("- ")),
                    "{cherry}"
                );
            } else if matches!(scenario, "squash" | "modified-squash" | "partial") {
                assert!(cherry.lines().any(|line| line.starts_with("+ ")));
            }
            if matches!(scenario, "squash" | "modified-squash") {
                use std::io::Write;
                use std::process::Stdio;
                let independent_id = |patch: String| {
                    let mut child = Command::new("git")
                        .args(["patch-id", "--stable"])
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .spawn()
                        .unwrap();
                    child
                        .stdin
                        .take()
                        .unwrap()
                        .write_all(patch.as_bytes())
                        .unwrap();
                    let output = child.wait_with_output().unwrap();
                    assert!(output.status.success());
                    String::from_utf8(output.stdout)
                        .unwrap()
                        .split_whitespace()
                        .next()
                        .unwrap()
                        .to_owned()
                };
                let aggregate = independent_id(run_git(&path, &["diff", &root, &tip]));
                let base_patch = independent_id(run_git(&path, &["show", "--format=", &base]));
                assert_eq!(aggregate == base_patch, scenario == "squash");
            }
        }
    }

    #[test]
    fn patch_comparison_limits_and_cancellation_are_inconclusive() {
        use std::io::Write;
        use std::process::Stdio;
        let (_repo, path) = fixture();
        let root = commit(&path, "root\n", "root");
        let mut input = String::new();
        for index in 0..513 {
            input.push_str("commit refs/heads/large\ncommitter Test <test@example.test> 1700000000 +0000\ndata 5\nempty\n");
            if index == 0 {
                input.push_str(&format!("from {root}\n"));
            }
            input.push('\n');
        }
        let mut child = Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(["fast-import", "--quiet"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success());
        let discovered = discover(&path);
        let result = ref_merge_status(
            &git_path(),
            &path.to_string_lossy(),
            discovered.navigation.as_ref().unwrap(),
            &["refs/heads/large".into()],
            discovered.oid_length,
            false,
            &AtomicBool::new(false),
            Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(result.statuses[0].status, MergeStatus::Unavailable);
        let git = ReadOnlyGit::new(git_path()).unwrap();
        let cancelled = crate::patch_equivalence::compare(
            &git,
            &path,
            &root,
            &root,
            &AtomicBool::new(true),
            Instant::now() + std::time::Duration::from_secs(5),
        );
        assert!(matches!(cancelled, Err(GitFailure::Cancelled)));
    }

    #[test]
    fn worktree_snapshot_preserves_path_and_marks_window_root() {
        let (_repo, path) = fixture();
        commit(&path, "first", "first");
        let linked = path.parent().unwrap().join("linked worktree\nwith newline");
        let linked_text = linked.to_string_lossy().into_owned();
        run_git(
            &path,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "linked",
                &linked_text,
                "HEAD",
            ],
        );
        let nested = path.join("nested");
        fs::create_dir(&nested).unwrap();
        let discovered = discover(&nested);
        let navigation = discovered.navigation.unwrap();
        assert_eq!(navigation.worktrees.len(), 2);
        assert!(navigation.worktrees[0].is_main);
        assert!(navigation.worktrees[0].is_current);
        assert_eq!(
            navigation.worktrees[1].path,
            linked.canonicalize().unwrap().to_string_lossy()
        );
        assert!(!navigation.worktrees[1].is_current);
        assert_eq!(
            navigation.worktrees[1].head_reference.as_deref(),
            Some("refs/heads/linked")
        );
    }

    #[test]
    fn session_preview_reads_scope_tips_instead_of_window_head() {
        let (_repo, path) = fixture();
        let other_tip = commit(&path, "other", "other");
        run_git(&path, &["branch", "other"]);
        let window_tip = commit(&path, "window", "window");
        let discovered = discover(&path);
        assert_eq!(
            discovered.info.head_oid.as_deref(),
            Some(window_tip.as_str())
        );
        let mut other_scope = discovered.clone();
        other_scope.scope_tips = vec![other_tip.clone()];
        let page = crate::repository::read_discovered_preview(
            &git_path(),
            &other_scope,
            &AtomicBool::new(false),
            Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(
            page.commits.first().map(|commit| commit.oid.as_str()),
            Some(other_tip.as_str())
        );
        assert_ne!(
            page.commits.first().map(|commit| commit.oid.as_str()),
            Some(window_tip.as_str())
        );
    }
}
