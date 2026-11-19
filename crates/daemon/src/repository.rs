use crate::git_command::{CommandOutput, GitFailure, ReadOnlyGit, string_arg};
use commitscope_core::{
    CommitIdentity, CommitSummary, ErrorCode, RefInfo, RefKind, RepositoryInfo,
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

const GRAPH_BOUNDARY_FILE_LIMIT: usize = 1024 * 1024;

const PATH_LIMIT: usize = 16 * 1024;
const REF_LIMIT: usize = 2_000;
const REF_QUERY_COUNT: usize = REF_LIMIT + 1;
const REF_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const COMMIT_PAGE_LIMIT: usize = 200;
const COMMIT_QUERY_COUNT: usize = COMMIT_PAGE_LIMIT + 1;
const MAX_OBJECT_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_OBJECT_BYTES: usize = 32 * 1024 * 1024;
const MAX_IDENTITY_BYTES: usize = 4 * 1024;
const MAX_PARENT_COUNT: usize = 128;
const SUMMARY_LIMIT: usize = 4 * 1024;

#[derive(Debug)]
pub struct PreviewError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

pub struct PreviewTail {
    pub commits: Vec<CommitSummary>,
    pub has_more: bool,
}

#[derive(Debug, Clone)]
pub struct DiscoveredRepository {
    pub info: RepositoryInfo,
    pub refs: Vec<RefInfo>,
    pub refs_truncated: bool,
    pub oid_length: usize,
    pub graph_boundary: GraphBoundaryFingerprint,
    pub scope_tips: Vec<String>,
    pub navigation:
        Result<commitscope_core::RepositoryNavigation, crate::navigation::NavigationError>,
}

#[derive(Debug, Clone)]
pub struct ParsedCommitMetadata {
    pub summary: CommitSummary,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphBoundaryFingerprint {
    shallow: Option<String>,
    grafts: Option<String>,
}

pub fn read_repository_preview(
    executable: &Path,
    input_path: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
    mut emit_repository: impl FnMut(RepositoryInfo, Vec<RefInfo>, bool) -> Result<(), PreviewError>,
) -> Result<PreviewTail, PreviewError> {
    let discovered = discover_repository(executable, input_path, cancelled, deadline)?;
    emit_repository(
        discovered.info.clone(),
        discovered.refs.clone(),
        discovered.refs_truncated,
    )?;
    read_discovered_preview(executable, &discovered, cancelled, deadline)
}

pub fn discover_repository(
    executable: &Path,
    input_path: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<DiscoveredRepository, PreviewError> {
    let path = normalize_repository_path(input_path)?;
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_git_failure)?;

    let (bare, git_dir_raw, common_dir_raw, is_shallow, object_format) =
        discover_repository_probe(&git, &path, cancelled, deadline)?;
    let git_dir = canonical_git_path(git_dir_raw)?;
    let common_dir = canonical_git_path(common_dir_raw)?;
    let worktree_path = if bare {
        None
    } else {
        Some(canonical_git_path(git_path(
            &git,
            &path,
            "--show-toplevel",
            cancelled,
            deadline,
        )?)?)
    };
    let oid_length = match object_format.as_str() {
        "sha1" => 40,
        "sha256" => 64,
        _ => {
            return Err(preview_error(
                ErrorCode::UnsupportedRepository,
                "Git object format is not supported",
                false,
            ));
        }
    };

    let head_reference = symbolic_head(&git, &path, cancelled, deadline)?;
    let head_oid = match resolve_head(
        &git,
        &path,
        head_reference.as_deref(),
        oid_length,
        true,
        cancelled,
        deadline,
    )? {
        HeadState::Unborn => None,
        HeadState::Commit(oid) => Some(oid),
    };
    let (refs, refs_truncated) = read_refs(&git, &path, oid_length, cancelled, deadline)?;
    let repository_path = worktree_path.clone().unwrap_or_else(|| git_dir.clone());
    let repository = RepositoryInfo {
        path: repository_path,
        git_dir,
        common_dir,
        worktree_path,
        is_bare: bare,
        is_shallow,
        object_format,
        head_oid: head_oid.clone(),
        head_reference,
    };
    let graph_boundary = graph_boundary_fingerprint(&repository.common_dir, cancelled, deadline)?;

    if cancelled.load(Ordering::Acquire) {
        return Err(cancelled_error());
    }
    let observed_at_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    let mut navigation = crate::navigation::capture(
        executable,
        &repository.path,
        repository
            .worktree_path
            .as_deref()
            .unwrap_or(&repository.path),
        &repository.common_dir,
        &repository.object_format,
        &refs,
        refs_truncated,
        observed_at_unix_ms,
        cancelled,
        deadline,
    );
    if cancelled.load(Ordering::Acquire) {
        return Err(cancelled_error());
    }
    if let Some(first) = navigation.as_ref().ok().cloned() {
        let refs_recheck = read_refs(&git, &path, oid_length, cancelled, deadline);
        match refs_recheck {
            Ok((current_refs, current_truncated)) if current_refs == refs && current_truncated == refs_truncated => {}
            Ok(_) => navigation = Err(crate::navigation::NavigationError {
                code: ErrorCode::SnapshotChanged,
                message: "References changed while the navigation snapshot was being captured; refresh and retry".into(),
            }),
            Err(error) if error.code == ErrorCode::Cancelled => return Err(error),
            Err(error) => navigation = Err(crate::navigation::NavigationError { code: error.code, message: error.message }),
        }
        if navigation.is_ok() {
            let second = crate::navigation::capture(
                executable,
                &repository.path,
                repository
                    .worktree_path
                    .as_deref()
                    .unwrap_or(&repository.path),
                &repository.common_dir,
                &repository.object_format,
                &refs,
                refs_truncated,
                observed_at_unix_ms,
                cancelled,
                deadline,
            );
            match second {
                Ok(second) if second.worktrees == first.worktrees
                    && second.worktrees_truncated == first.worktrees_truncated
                    && second.default_base == first.default_base => {}
                Ok(_) => navigation = Err(crate::navigation::NavigationError {
                    code: ErrorCode::SnapshotChanged,
                    message: "Worktrees changed while the navigation snapshot was being captured; refresh and retry".into(),
                }),
                Err(error) if error.code == ErrorCode::Cancelled => return Err(repository_navigation_error(error)),
                Err(error) => navigation = Err(error),
            }
        }
        if navigation.is_ok() {
            match symbolic_head(&git, &path, cancelled, deadline) {
                Ok(current_reference) => match resolve_head(
                    &git,
                    &path,
                    current_reference.as_deref(),
                    oid_length,
                    false,
                    cancelled,
                    deadline,
                ) {
                    Ok(HeadState::Commit(oid)) => {
                        if current_reference != repository.head_reference
                            || Some(oid) != repository.head_oid
                        {
                            navigation = Err(crate::navigation::NavigationError {
                                code: ErrorCode::SnapshotChanged,
                                message: "HEAD changed while the navigation snapshot was being captured; refresh and retry".into(),
                            });
                        }
                    }
                    Ok(HeadState::Unborn) => {
                        if current_reference != repository.head_reference
                            || repository.head_oid.is_some()
                        {
                            navigation = Err(crate::navigation::NavigationError {
                                code: ErrorCode::SnapshotChanged,
                                message: "HEAD changed while the navigation snapshot was being captured; refresh and retry".into(),
                            });
                        }
                    }
                    Err(error) if error.code == ErrorCode::Cancelled => return Err(error),
                    Err(error) => {
                        navigation = Err(crate::navigation::NavigationError {
                            code: error.code,
                            message: error.message,
                        })
                    }
                },
                Err(error) if error.code == ErrorCode::Cancelled => return Err(error),
                Err(error) => {
                    navigation = Err(crate::navigation::NavigationError {
                        code: error.code,
                        message: error.message,
                    })
                }
            }
        }
    }
    Ok(DiscoveredRepository {
        scope_tips: head_oid.into_iter().collect(),
        info: repository,
        refs,
        refs_truncated,
        oid_length,
        graph_boundary,
        navigation,
    })
}

fn repository_navigation_error(error: crate::navigation::NavigationError) -> PreviewError {
    PreviewError {
        code: error.code,
        message: error.message,
        retryable: false,
    }
}

pub fn read_discovered_preview(
    executable: &Path,
    discovered: &DiscoveredRepository,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<PreviewTail, PreviewError> {
    if discovered.scope_tips.is_empty() {
        return Ok(PreviewTail {
            commits: Vec::new(),
            has_more: false,
        });
    }
    let path = Path::new(&discovered.info.path);
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_git_failure)?;
    let (oids, has_more) = read_commit_oids(
        &git,
        path,
        &discovered.scope_tips,
        discovered.oid_length,
        cancelled,
        deadline,
    )?;
    let commits: Vec<CommitSummary> = read_commits(
        &git,
        path,
        &oids,
        discovered.oid_length,
        cancelled,
        deadline,
    )?
    .into_iter()
    .map(|parsed| parsed.summary)
    .collect();
    Ok(PreviewTail { commits, has_more })
}

fn canonical_git_path(path: String) -> Result<String, PreviewError> {
    let canonical = Path::new(&path)
        .canonicalize()
        .map_err(|error| map_path_error(error, "Repository metadata path is unavailable"))?;
    path_to_string(&canonical)
}

pub fn verify_graph_fingerprint(
    discovered: &DiscoveredRepository,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), PreviewError> {
    let current = graph_boundary_fingerprint(&discovered.info.common_dir, cancelled, deadline)?;
    if current != discovered.graph_boundary {
        return Err(preview_error(
            ErrorCode::SnapshotChanged,
            "The shallow or graft history boundary changed; refresh the repository",
            false,
        ));
    }
    Ok(())
}

pub fn history_boundary_limited(discovered: &DiscoveredRepository) -> bool {
    discovered.info.is_shallow
        || discovered.graph_boundary.shallow.is_some()
        || discovered.graph_boundary.grafts.is_some()
}

fn graph_boundary_fingerprint(
    common_dir: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<GraphBoundaryFingerprint, PreviewError> {
    check_active(cancelled, deadline)?;
    let root = Path::new(common_dir);
    Ok(GraphBoundaryFingerprint {
        shallow: boundary_file_fingerprint(&root.join("shallow"), cancelled, deadline)?,
        grafts: boundary_file_fingerprint(&root.join("info").join("grafts"), cancelled, deadline)?,
    })
}

fn boundary_file_fingerprint(
    path: &Path,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<String>, PreviewError> {
    check_active(cancelled, deadline)?;
    if let Some(parent) = path.parent() {
        match fs::symlink_metadata(parent) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => {
                return Err(preview_error(
                    ErrorCode::UnsupportedRepository,
                    "A history boundary directory is not a regular directory",
                    false,
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(map_path_error(
                    error,
                    "History boundary directory is unavailable",
                ));
            }
        }
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(map_path_error(
                error,
                "History boundary metadata is unavailable",
            ));
        }
    };
    if !metadata.file_type().is_file() || metadata.len() > GRAPH_BOUNDARY_FILE_LIMIT as u64 {
        return Err(preview_error(
            ErrorCode::UnsupportedRepository,
            "A shallow or graft boundary file is unsafe or exceeds 1 MiB",
            false,
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|error| {
        preview_error(
            ErrorCode::UnsupportedRepository,
            format!("Could not safely open history boundary file: {error}"),
            false,
        )
    })?;
    let opened_metadata = file.metadata().map_err(|error| {
        preview_error(
            ErrorCode::UnsupportedRepository,
            format!("Could not inspect history boundary file: {error}"),
            false,
        )
    })?;
    if !opened_metadata.file_type().is_file()
        || opened_metadata.len() > GRAPH_BOUNDARY_FILE_LIMIT as u64
    {
        return Err(preview_error(
            ErrorCode::UnsupportedRepository,
            "A shallow or graft boundary file changed or exceeds 1 MiB",
            false,
        ));
    }
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.take(GRAPH_BOUNDARY_FILE_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            preview_error(
                ErrorCode::RepositoryUnavailable,
                format!("Could not read history boundary file: {error}"),
                false,
            )
        })?;
    check_active(cancelled, deadline)?;
    if bytes.len() > GRAPH_BOUNDARY_FILE_LIMIT {
        return Err(preview_error(
            ErrorCode::UnsupportedRepository,
            "A shallow or graft boundary file exceeds 1 MiB",
            false,
        ));
    }
    let mut hash = Sha256::new();
    hash.update(b"commitscope:history-boundary:v1\0");
    hash.update(&bytes);
    Ok(Some(format!("sha256:{:x}", hash.finalize())))
}

pub fn internal_error(message: &str) -> PreviewError {
    preview_error(ErrorCode::RepositoryUnavailable, message, false)
}

pub fn git_error(message: &str) -> PreviewError {
    preview_error(ErrorCode::GitError, message, false)
}

pub fn timeout_error() -> PreviewError {
    preview_error(ErrorCode::Timeout, "History query timed out", true)
}

fn normalize_repository_path(input: &str) -> Result<PathBuf, PreviewError> {
    if input.len() > PATH_LIMIT || input.contains('\0') {
        return Err(preview_error(
            ErrorCode::InvalidRequest,
            "Repository path is too long or contains a NUL byte",
            false,
        ));
    }
    let input_path = Path::new(input);
    if !input_path.is_absolute() {
        return Err(preview_error(
            ErrorCode::InvalidRequest,
            "Repository path must be absolute",
            false,
        ));
    }
    let canonical = input_path
        .canonicalize()
        .map_err(|error| map_path_error(error, "Repository path is unavailable"))?;
    if !canonical.is_dir() {
        return Err(preview_error(
            ErrorCode::NotARepository,
            "The selected path is not a directory",
            false,
        ));
    }
    path_to_string(&canonical)?;
    Ok(canonical)
}

fn discover_repository_probe(
    git: &ReadOnlyGit,
    path: &Path,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(bool, String, String, bool, String), PreviewError> {
    let probe = run_git_status(
        git,
        path,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--is-bare-repository",
            "--git-dir",
            "--git-common-dir",
            "--is-shallow-repository",
            "--show-object-format",
        ],
        None,
        16 * 1024,
        cancelled,
        deadline,
    )?;
    if !probe.status.success() {
        if String::from_utf8_lossy(&probe.stderr).contains("not a git repository") {
            return Err(preview_error(
                ErrorCode::NotARepository,
                "The selected directory is not a Git repository",
                false,
            ));
        }
        return Err(git_exit_error(&probe));
    }
    let stripped = strip_one_lf(probe.stdout)?;
    let lines: Vec<&[u8]> = stripped.split(|byte| *byte == b'\n').collect();
    if lines.len() == 5 {
        let bare = parse_bool(lines[0])?;
        let git_dir = validate_probe_path(lines[1])?;
        let common_dir = validate_probe_path(lines[2])?;
        let is_shallow = parse_bool(lines[3])?;
        let object_format = String::from_utf8(lines[4].to_vec()).map_err(|_| {
            preview_error(
                ErrorCode::GitError,
                "Git returned non-UTF-8 repository metadata",
                false,
            )
        })?;
        return Ok((bare, git_dir, common_dir, is_shallow, object_format));
    }
    let bare = git_bool(git, path, "--is-bare-repository", cancelled, deadline)?;
    let git_dir = git_path(git, path, "--git-dir", cancelled, deadline)?;
    let common_dir = git_path(git, path, "--git-common-dir", cancelled, deadline)?;
    let is_shallow = git_bool(git, path, "--is-shallow-repository", cancelled, deadline)?;
    let object_format = git_string(git, path, "--show-object-format", cancelled, deadline)?;
    Ok((bare, git_dir, common_dir, is_shallow, object_format))
}

fn validate_probe_path(bytes: &[u8]) -> Result<String, PreviewError> {
    if bytes.contains(&0) {
        return Err(preview_error(
            ErrorCode::UnsupportedRepository,
            "Repository path contains an unsupported NUL byte",
            false,
        ));
    }
    let value = String::from_utf8(bytes.to_vec()).map_err(|_| {
        preview_error(
            ErrorCode::UnsupportedRepository,
            "Repository path cannot be represented as UTF-8",
            false,
        )
    })?;
    if !Path::new(&value).is_absolute() {
        return Err(preview_error(
            ErrorCode::GitError,
            "Git returned a non-absolute repository path",
            false,
        ));
    }
    Ok(value)
}

fn git_bool(
    git: &ReadOnlyGit,
    path: &Path,
    flag: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<bool, PreviewError> {
    let value = git_string(git, path, flag, cancelled, deadline)?;
    parse_bool(value.as_bytes())
}

fn parse_bool(value: &[u8]) -> Result<bool, PreviewError> {
    match value {
        b"true" => Ok(true),
        b"false" => Ok(false),
        _ => Err(preview_error(
            ErrorCode::GitError,
            "Git returned an invalid repository flag",
            false,
        )),
    }
}

fn git_path(
    git: &ReadOnlyGit,
    path: &Path,
    option: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<String, PreviewError> {
    let output = run_git(
        git,
        path,
        &["rev-parse", "--path-format=absolute", option],
        None,
        64 * 1024,
        cancelled,
        deadline,
    )?;
    let bytes = strip_one_lf(output.stdout)?;
    if bytes.contains(&0) {
        return Err(preview_error(
            ErrorCode::UnsupportedRepository,
            "Repository path contains an unsupported NUL byte",
            false,
        ));
    }
    let value = String::from_utf8(bytes.to_vec()).map_err(|_| {
        preview_error(
            ErrorCode::UnsupportedRepository,
            "Repository path cannot be represented as UTF-8",
            false,
        )
    })?;
    if !Path::new(&value).is_absolute() {
        return Err(preview_error(
            ErrorCode::GitError,
            "Git returned a non-absolute repository path",
            false,
        ));
    }
    Ok(value)
}

fn git_string(
    git: &ReadOnlyGit,
    path: &Path,
    option: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<String, PreviewError> {
    let output = run_git(
        git,
        path,
        &["rev-parse", option],
        None,
        4096,
        cancelled,
        deadline,
    )?;
    let bytes = strip_one_lf(output.stdout)?;
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        preview_error(
            ErrorCode::GitError,
            "Git returned non-UTF-8 repository metadata",
            false,
        )
    })
}

fn symbolic_head(
    git: &ReadOnlyGit,
    path: &Path,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<String>, PreviewError> {
    let output = run_git_status(
        git,
        path,
        &["symbolic-ref", "--quiet", "HEAD"],
        None,
        4096,
        cancelled,
        deadline,
    )?;
    if output.status.success() {
        let bytes = strip_one_lf(output.stdout)?;
        let reference = String::from_utf8(bytes.to_vec()).map_err(|_| {
            preview_error(
                ErrorCode::UnsupportedRepository,
                "HEAD reference cannot be represented as UTF-8",
                false,
            )
        })?;
        Ok(Some(reference))
    } else if output.status.code() == Some(1) {
        Ok(None)
    } else {
        Err(git_exit_error(&output))
    }
}

enum HeadState {
    Unborn,
    Commit(String),
}

fn resolve_head(
    git: &ReadOnlyGit,
    path: &Path,
    head_reference: Option<&str>,
    oid_length: usize,
    verify_object: bool,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<HeadState, PreviewError> {
    let output = run_git_status(
        git,
        path,
        &["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
        None,
        4096,
        cancelled,
        deadline,
    )?;
    if output.status.success() {
        let bytes = strip_one_lf(output.stdout)?;
        let oid = String::from_utf8(bytes.to_vec()).map_err(|_| {
            preview_error(
                ErrorCode::GitError,
                "Git returned an invalid HEAD object ID",
                false,
            )
        })?;
        validate_oid(&oid, oid_length)?;
        if verify_object {
            let object = run_git_status(
                git,
                path,
                &["cat-file", "-e", "HEAD^{commit}"],
                None,
                4096,
                cancelled,
                deadline,
            )?;
            if !object.status.success() {
                return Err(preview_error(
                    ErrorCode::MissingObject,
                    "HEAD commit object is unavailable",
                    false,
                ));
            }
        }
        return Ok(HeadState::Commit(oid));
    }

    if let Some(reference) = head_reference {
        let ref_output = run_git_status(
            git,
            path,
            &["show-ref", "--verify", "--quiet", reference],
            None,
            4096,
            cancelled,
            deadline,
        )?;
        if ref_output.status.code() == Some(1) && ref_output.stdout.is_empty() {
            return Ok(HeadState::Unborn);
        }
        if !ref_output.status.success() {
            if ref_output.status.code() == Some(128)
                && String::from_utf8_lossy(&ref_output.stderr).contains("bad ref")
            {
                return Err(preview_error(
                    ErrorCode::MissingObject,
                    "HEAD reference points to an unavailable object",
                    false,
                ));
            }
            return Err(git_exit_error(&ref_output));
        }
    }
    Err(preview_error(
        ErrorCode::MissingObject,
        "HEAD does not resolve to an available commit",
        false,
    ))
}

fn read_refs(
    git: &ReadOnlyGit,
    path: &Path,
    oid_length: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(Vec<RefInfo>, bool), PreviewError> {
    let output = run_git_status(
        git,
        path,
        &[
            "for-each-ref",
            &format!("--count={REF_QUERY_COUNT}"),
            "--sort=refname",
            "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(symref)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
        None,
        REF_OUTPUT_LIMIT,
        cancelled,
        deadline,
    )?;
    if !output.status.success() {
        if is_missing_object_diagnostic(&output.stderr) {
            return Err(preview_error(
                ErrorCode::MissingObject,
                "A history object is missing or unavailable",
                false,
            ));
        }
        return Err(git_exit_error(&output));
    }
    let mut refs = Vec::new();
    for line in output.stdout.split(|byte| *byte == b'\n') {
        check_active(cancelled, deadline)?;
        if line.is_empty() {
            continue;
        }
        let fields: Vec<_> = line.split(|byte| *byte == 0).collect();
        if fields.len() != 4 {
            return Err(preview_error(
                ErrorCode::GitError,
                "Git returned malformed reference fields",
                false,
            ));
        }
        let name = field_string(fields[0], "reference name")?;
        let kind = if name.starts_with("refs/heads/") {
            RefKind::LocalBranch
        } else if name.starts_with("refs/remotes/") {
            RefKind::RemoteBranch
        } else if name.starts_with("refs/tags/") {
            RefKind::Tag
        } else {
            return Err(preview_error(
                ErrorCode::GitError,
                "Git returned a reference outside the requested namespaces",
                false,
            ));
        };
        let oid = field_string(fields[1], "reference object ID")?;
        validate_oid(&oid, oid_length)?;
        let peeled_oid = if fields[2].is_empty() {
            None
        } else {
            let value = field_string(fields[2], "peeled reference object ID")?;
            validate_oid(&value, oid_length)?;
            Some(value)
        };
        let symbolic_target = if fields[3].is_empty() {
            None
        } else {
            Some(field_string(fields[3], "symbolic reference target")?)
        };
        refs.push(RefInfo {
            name,
            kind,
            oid,
            peeled_oid,
            symbolic_target,
        });
    }
    let refs_truncated = refs.len() > REF_LIMIT;
    refs.truncate(REF_LIMIT);
    Ok((refs, refs_truncated))
}

fn read_commit_oids(
    git: &ReadOnlyGit,
    path: &Path,
    tips: &[String],
    oid_length: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(Vec<String>, bool), PreviewError> {
    let mut args = vec![
        string_arg("rev-list"),
        string_arg("--topo-order"),
        string_arg(format!("--max-count={COMMIT_QUERY_COUNT}")),
    ];
    args.extend(tips.iter().map(string_arg));
    args.push(string_arg("--"));
    let output = git
        .run(path, &args, None, 32 * 1024, cancelled, deadline)
        .map_err(map_git_failure)?;
    if !output.status.success() {
        if is_missing_object_diagnostic(&output.stderr) {
            return Err(preview_error(
                ErrorCode::MissingObject,
                "A history object is missing or unavailable",
                false,
            ));
        }
        return Err(git_exit_error(&output));
    }
    let mut oids = Vec::new();
    for line in output.stdout.split(|byte| *byte == b'\n') {
        check_active(cancelled, deadline)?;
        if line.is_empty() {
            continue;
        }
        let oid = field_string(line, "commit object ID")?;
        validate_oid(&oid, oid_length)?;
        oids.push(oid);
        if oids.len() > COMMIT_QUERY_COUNT {
            return Err(resource_limit("Git returned too many commit IDs"));
        }
    }
    let has_more = oids.len() > COMMIT_PAGE_LIMIT;
    oids.truncate(COMMIT_PAGE_LIMIT);
    Ok((oids, has_more))
}

pub fn read_commit_summaries(
    executable: &Path,
    discovered: &DiscoveredRepository,
    oids: &[String],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<CommitSummary>, PreviewError> {
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_git_failure)?;
    Ok(read_commits(
        &git,
        Path::new(&discovered.info.path),
        oids,
        discovered.oid_length,
        cancelled,
        deadline,
    )?
    .into_iter()
    .map(|parsed| parsed.summary)
    .collect())
}

pub(crate) fn verify_commit_oids(
    executable: &Path,
    discovered: &DiscoveredRepository,
    oids: &[String],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), PreviewError> {
    if oids.is_empty() {
        return Ok(());
    }
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_git_failure)?;
    let mut batch_input = String::with_capacity(oids.len() * (discovered.oid_length + 1));
    for oid in oids {
        batch_input.push_str(oid);
        batch_input.push('\n');
    }
    let output = run_git(
        &git,
        Path::new(&discovered.info.path),
        &["cat-file", "--batch-check"],
        Some(batch_input.as_bytes()),
        1024 * 1024,
        cancelled,
        deadline,
    )?;
    let stdout_text = std::str::from_utf8(&output.stdout).map_err(|_| {
        preview_error(
            ErrorCode::MissingObject,
            "Commit verification returned invalid output",
            false,
        )
    })?;
    let lines: Vec<&str> = stdout_text.lines().collect();
    if lines.len() != oids.len() {
        return Err(preview_error(
            ErrorCode::MissingObject,
            "Commit OID does not exist or is not a commit",
            false,
        ));
    }
    for (expected, line) in oids.iter().zip(lines) {
        let mut parts = line.split_ascii_whitespace();
        let oid = parts.next();
        let kind = parts.next();
        let size = parts.next();
        if !oid.is_some_and(|value| value.eq_ignore_ascii_case(expected))
            || kind != Some("commit")
            || size.is_none()
            || parts.next().is_some()
        {
            return Err(preview_error(
                ErrorCode::MissingObject,
                "Commit OID does not exist or is not a commit",
                false,
            ));
        }
    }
    Ok(())
}

pub fn read_commit_metadata(
    executable: &Path,
    discovered: &DiscoveredRepository,
    oids: &[String],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<ParsedCommitMetadata>, PreviewError> {
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_git_failure)?;
    read_commits(
        &git,
        Path::new(&discovered.info.path),
        oids,
        discovered.oid_length,
        cancelled,
        deadline,
    )
}

pub(crate) fn read_commits(
    git: &ReadOnlyGit,
    path: &Path,
    oids: &[String],
    oid_length: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<ParsedCommitMetadata>, PreviewError> {
    if oids.is_empty() {
        return Ok(Vec::new());
    }
    let mut input = Vec::with_capacity(oids.len() * (oid_length + 1));
    for oid in oids {
        input.extend_from_slice(oid.as_bytes());
        input.push(b'\n');
    }
    let output_limit = MAX_TOTAL_OBJECT_BYTES + 128 * 1024;
    let output = run_git(
        git,
        path,
        &[
            "cat-file",
            "--batch=%(objectname) %(objecttype) %(objectsize)",
        ],
        Some(&input),
        output_limit,
        cancelled,
        deadline,
    )?;
    let mut cursor = 0;
    let mut total_object_bytes = 0_usize;
    let mut commits = Vec::with_capacity(oids.len());
    for expected_oid in oids {
        check_active(cancelled, deadline)?;
        let header = take_line(&output.stdout, &mut cursor)?;
        let header = std::str::from_utf8(header).map_err(|_| {
            preview_error(
                ErrorCode::GitError,
                "cat-file returned an invalid object header",
                false,
            )
        })?;
        let fields: Vec<_> = header.split_ascii_whitespace().collect();
        if fields.len() != 3 {
            if fields.len() == 2 && fields[1] == "missing" {
                return Err(preview_error(
                    ErrorCode::MissingObject,
                    "A commit object is missing",
                    false,
                ));
            }
            return Err(preview_error(
                ErrorCode::GitError,
                "cat-file returned a malformed object header",
                false,
            ));
        }
        if fields[0] != expected_oid {
            return Err(preview_error(
                ErrorCode::GitError,
                "cat-file returned an unexpected object ID",
                false,
            ));
        }
        if fields[1] != "commit" {
            return Err(preview_error(
                ErrorCode::MissingObject,
                "A history entry is not a commit object",
                false,
            ));
        }
        let object_size: usize = fields[2].parse().map_err(|_| {
            preview_error(
                ErrorCode::GitError,
                "cat-file returned an invalid object size",
                false,
            )
        })?;
        if object_size > MAX_OBJECT_BYTES {
            return Err(resource_limit("A commit object exceeds 1 MiB"));
        }
        total_object_bytes = total_object_bytes
            .checked_add(object_size)
            .ok_or_else(|| resource_limit("Commit object size overflow"))?;
        if total_object_bytes > MAX_TOTAL_OBJECT_BYTES {
            return Err(resource_limit(
                "Commit objects exceed 32 MiB for one preview",
            ));
        }
        let end = cursor
            .checked_add(object_size)
            .filter(|end| *end <= output.stdout.len())
            .ok_or_else(|| {
                preview_error(
                    ErrorCode::MissingObject,
                    "cat-file ended inside a commit object",
                    false,
                )
            })?;
        let object = &output.stdout[cursor..end];
        cursor = end;
        if output.stdout.get(cursor) != Some(&b'\n') {
            return Err(preview_error(
                ErrorCode::GitError,
                "cat-file object length did not end at its delimiter",
                false,
            ));
        }
        cursor += 1;
        commits.push(parse_commit(
            expected_oid,
            object,
            oid_length,
            cancelled,
            deadline,
        )?);
    }
    if cursor != output.stdout.len() {
        return Err(preview_error(
            ErrorCode::GitError,
            "cat-file returned extra bytes after the requested objects",
            false,
        ));
    }
    Ok(commits)
}

fn parse_commit(
    oid: &str,
    bytes: &[u8],
    oid_length: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<ParsedCommitMetadata, PreviewError> {
    let separator = bytes
        .windows(2)
        .position(|window| window == b"\n\n")
        .ok_or_else(|| {
            preview_error(
                ErrorCode::GitError,
                "Commit object has no header terminator",
                false,
            )
        })?;
    let headers = &bytes[..separator];
    let message = &bytes[separator + 2..];
    let mut parents = Vec::new();
    let mut author = None;
    let mut committer = None;
    let mut encoding = None;
    for line in headers.split(|byte| *byte == b'\n') {
        check_active(cancelled, deadline)?;
        if line.starts_with(b" ") {
            // Continuation lines belong to multi-line headers such as gpgsig.
            continue;
        }
        let Some(separator) = line.iter().position(|byte| *byte == b' ') else {
            continue;
        };
        let (name, value) = line.split_at(separator);
        let value = &value[1..];
        match name {
            b"parent" => {
                if parents.len() >= MAX_PARENT_COUNT {
                    return Err(resource_limit("A commit has more than 128 parents"));
                }
                let parent = field_string(value, "parent object ID")?;
                validate_oid(&parent, oid_length)?;
                parents.push(parent);
            }
            b"author" => {
                if value.len() > MAX_IDENTITY_BYTES {
                    return Err(resource_limit("A commit identity exceeds 4 KiB"));
                }
                if author.is_none() {
                    author = Some(parse_identity(value)?);
                }
            }
            b"committer" => {
                if value.len() > MAX_IDENTITY_BYTES {
                    return Err(resource_limit("A commit identity exceeds 4 KiB"));
                }
                if committer.is_none() {
                    committer = Some(parse_identity(value)?);
                }
            }
            b"encoding" => encoding = Some(value),
            _ => {}
        }
    }
    let author = author
        .ok_or_else(|| preview_error(ErrorCode::GitError, "Commit object has no author", false))?;
    let committer = committer.ok_or_else(|| {
        preview_error(ErrorCode::GitError, "Commit object has no committer", false)
    })?;
    let encoding_lossy = encoding.is_some_and(|name| {
        !name.eq_ignore_ascii_case(b"utf-8") && !name.eq_ignore_ascii_case(b"utf8")
    });
    let text_lossy = std::str::from_utf8(bytes).is_err() || encoding_lossy;
    let summary_line = message
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    let mut summary = String::from_utf8_lossy(summary_line).into_owned();
    let summary_truncated = summary.len() > SUMMARY_LIMIT;
    if summary_truncated {
        let mut boundary = SUMMARY_LIMIT;
        while !summary.is_char_boundary(boundary) {
            boundary -= 1;
        }
        summary.truncate(boundary);
    }
    let summary = CommitSummary {
        oid: oid.to_owned(),
        parents,
        summary,
        summary_truncated,
        author,
        committer,
        text_lossy,
    };
    Ok(ParsedCommitMetadata {
        summary,
        message: String::from_utf8_lossy(message).into_owned(),
    })
}

fn parse_identity(value: &[u8]) -> Result<CommitIdentity, PreviewError> {
    let offset_separator = value
        .iter()
        .rposition(|byte| *byte == b' ')
        .ok_or_else(|| {
            preview_error(
                ErrorCode::GitError,
                "Commit identity has no time zone",
                false,
            )
        })?;
    let offset = &value[offset_separator + 1..];
    if offset.len() != 5
        || !matches!(offset[0], b'+' | b'-')
        || !offset[1..].iter().all(u8::is_ascii_digit)
    {
        return Err(preview_error(
            ErrorCode::GitError,
            "Commit identity has an invalid time zone",
            false,
        ));
    }
    let timestamp_separator = value[..offset_separator]
        .iter()
        .rposition(|byte| *byte == b' ')
        .ok_or_else(|| {
            preview_error(
                ErrorCode::GitError,
                "Commit identity has no timestamp",
                false,
            )
        })?;
    let timestamp = &value[timestamp_separator + 1..offset_separator];
    let timestamp_text = std::str::from_utf8(timestamp)
        .map_err(|_| preview_error(ErrorCode::GitError, "Commit timestamp is not ASCII", false))?;
    timestamp_text
        .parse::<i64>()
        .map_err(|_| preview_error(ErrorCode::GitError, "Commit timestamp is invalid", false))?;
    let identity = &value[..timestamp_separator];
    let email_start = identity
        .windows(2)
        .rposition(|window| window == b" <")
        .ok_or_else(|| preview_error(ErrorCode::GitError, "Commit identity has no email", false))?;
    if identity.last() != Some(&b'>') || email_start + 2 > identity.len() - 1 {
        return Err(preview_error(
            ErrorCode::GitError,
            "Commit identity has malformed name/email",
            false,
        ));
    }
    Ok(CommitIdentity {
        name: String::from_utf8_lossy(&identity[..email_start]).into_owned(),
        email: String::from_utf8_lossy(&identity[email_start + 2..identity.len() - 1]).into_owned(),
        timestamp: timestamp_text.to_owned(),
        offset: String::from_utf8_lossy(offset).into_owned(),
    })
}

fn run_git(
    git: &ReadOnlyGit,
    path: &Path,
    arguments: &[&str],
    input: Option<&[u8]>,
    output_limit: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<CommandOutput, PreviewError> {
    let output = run_git_status(
        git,
        path,
        arguments,
        input,
        output_limit,
        cancelled,
        deadline,
    )?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(git_exit_error(&output))
    }
}

fn run_git_status(
    git: &ReadOnlyGit,
    path: &Path,
    arguments: &[&str],
    input: Option<&[u8]>,
    output_limit: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<CommandOutput, PreviewError> {
    let args: Vec<_> = arguments.iter().map(string_arg).collect();
    git.run(path, &args, input, output_limit, cancelled, deadline)
        .map_err(map_git_failure)
}

fn strip_one_lf(bytes: Vec<u8>) -> Result<Vec<u8>, PreviewError> {
    let Some(without_delimiter) = bytes.strip_suffix(b"\n") else {
        return Err(preview_error(
            ErrorCode::GitError,
            "Git omitted a metadata line delimiter",
            false,
        ));
    };
    Ok(without_delimiter.to_vec())
}

fn take_line<'a>(bytes: &'a [u8], cursor: &mut usize) -> Result<&'a [u8], PreviewError> {
    let remaining = bytes.get(*cursor..).ok_or_else(|| {
        preview_error(
            ErrorCode::GitError,
            "cat-file output ended unexpectedly",
            false,
        )
    })?;
    let end = remaining
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| {
            preview_error(
                ErrorCode::GitError,
                "cat-file output has an incomplete header",
                false,
            )
        })?;
    let line = &remaining[..end];
    *cursor += end + 1;
    Ok(line)
}

fn field_string(bytes: &[u8], field_name: &str) -> Result<String, PreviewError> {
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        preview_error(
            ErrorCode::UnsupportedRepository,
            format!("{field_name} cannot be represented as UTF-8"),
            false,
        )
    })
}

fn path_to_string(path: &Path) -> Result<String, PreviewError> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        preview_error(
            ErrorCode::UnsupportedRepository,
            "Repository path cannot be represented as UTF-8",
            false,
        )
    })
}

fn map_path_error(error: std::io::Error, message: &str) -> PreviewError {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        preview_error(ErrorCode::PermissionDenied, message, false)
    } else {
        preview_error(ErrorCode::RepositoryUnavailable, message, true)
    }
}

fn validate_oid(oid: &str, expected_length: usize) -> Result<(), PreviewError> {
    if oid.len() != expected_length || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(preview_error(
            ErrorCode::GitError,
            "Git returned an object ID that does not match the repository object format",
            false,
        ));
    }
    Ok(())
}

fn git_exit_error(output: &CommandOutput) -> PreviewError {
    let status = output
        .status
        .code()
        .map_or_else(|| "signal".to_owned(), |code| code.to_string());
    let detail = String::from_utf8_lossy(&output.stderr);
    let sanitized: String = detail
        .chars()
        .filter(|character| !character.is_control() || *character == '\n' || *character == '\t')
        .take(512)
        .collect();
    let message = if sanitized.trim().is_empty() {
        format!("Git command failed (exit {status})")
    } else {
        format!("Git command failed (exit {status}): {}", sanitized.trim())
    };
    let code = if detail.to_ascii_lowercase().contains("permission denied") {
        ErrorCode::PermissionDenied
    } else {
        ErrorCode::GitError
    };
    preview_error(code, message, false)
}

pub fn is_missing_object_diagnostic(stderr: &[u8]) -> bool {
    let detail = String::from_utf8_lossy(stderr);
    detail.contains("bad object")
        || detail.contains("Could not read")
        || detail.contains("missing object")
        || detail.contains("promisor remote")
}

fn map_git_failure(error: GitFailure) -> PreviewError {
    match error {
        GitFailure::Cancelled => cancelled_error(),
        GitFailure::Timeout => {
            preview_error(ErrorCode::Timeout, "Repository preview timed out", true)
        }
        GitFailure::ResourceLimit => resource_limit("Git output exceeded a resource limit"),
        GitFailure::CommandFailed(message) => preview_error(ErrorCode::GitError, message, false),
        GitFailure::Unavailable(message) => {
            preview_error(ErrorCode::GitUnavailable, message, false)
        }
    }
}

pub fn cancelled_error() -> PreviewError {
    preview_error(ErrorCode::Cancelled, "请求已取消", false)
}

fn check_active(cancelled: &AtomicBool, deadline: Instant) -> Result<(), PreviewError> {
    if cancelled.load(Ordering::Acquire) {
        Err(cancelled_error())
    } else if Instant::now() >= deadline {
        Err(preview_error(
            ErrorCode::Timeout,
            "Repository preview exceeded its time limit",
            true,
        ))
    } else {
        Ok(())
    }
}

pub fn resource_limit(message: &str) -> PreviewError {
    preview_error(ErrorCode::ResourceLimit, message, false)
}

fn preview_error(code: ErrorCode, message: impl Into<String>, retryable: bool) -> PreviewError {
    PreviewError {
        code,
        message: message.into(),
        retryable,
    }
}
