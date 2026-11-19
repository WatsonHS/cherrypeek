//! P4-09: the working tree of the open directory. Status, one file's staged or unstaged diff, and a
//! working-tree file itself. Commands honour the user's Git configuration so clean / smudge filters
//! behave as in a terminal (user decision, 2026-11-09); fsmonitor, external diff, textconv and hooks
//! stay disabled, and `--no-optional-locks` keeps Git from refreshing the index.

use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Instant,
};

use commitscope_core::{
    ChangedFileStatus, ErrorCode, FileDiffKind, ReadWorkspaceDiffParams, ReadWorkspaceFileParams,
    ReadWorkspaceStatusParams, WorkspaceChange, WorkspaceConflict, WorkspaceDiff, WorkspaceEntry,
    WorkspaceFile, WorkspaceFileKind, WorkspaceOperation, WorkspaceSide, WorkspaceStatus,
};

use crate::{
    details::{
        DetailError, FILE_DIFF_BLOB_LIMIT, FULL_FILE_CONTEXT, collect_patch, detail_error,
        from_git, git_output_error, git_path, hex_decode, is_lfs_pointer, now_unix_ms,
        raw_path_arg, validate_path_hex,
    },
    files::{BINARY_SNIFF, over_budget, read_blob, text_head},
    git_command::{ReadOnlyGit, string_arg},
    session,
};

type WorkspaceResult<T> = Result<T, DetailError>;

const STATUS_OUTPUT_LIMIT: usize = 64 * 1024 * 1024;
const NUMSTAT_OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
/// Above this many tracked changes the per-file line counts are skipped (reported as null).
const NUMSTAT_PATH_LIMIT: usize = 5_000;
/// Cap argv pathspec fan-out so status numstat avoids OS command-line limits across platforms.
const NUMSTAT_ARGV_PATH_LIMIT: usize = 256;
const NUMSTAT_ARGV_BYTE_LIMIT: usize = 16 * 1024;
const FILE_READ_LIMIT: u64 = 1024 * 1024;
const FILE_TEXT_LIMIT: usize = 256 * 1024;
const GITLINK_MODE: &str = "160000";

struct Worktree {
    root: PathBuf,
    git_dir: PathBuf,
    oid_length: usize,
}

fn worktree(session: &session::RepositorySession) -> WorkspaceResult<Worktree> {
    let info = &session.discovered.info;
    let root = info
        .worktree_path
        .as_deref()
        .filter(|_| !info.is_bare)
        .ok_or_else(|| {
            detail_error(
                ErrorCode::InvalidRequest,
                "A bare repository has no working tree",
                false,
            )
        })?;
    let root = PathBuf::from(root);
    let git_dir = PathBuf::from(&info.git_dir);
    let git_dir = if git_dir.is_absolute() {
        git_dir
    } else {
        root.join(git_dir)
    };
    Ok(Worktree {
        root,
        git_dir,
        oid_length: session.discovered.oid_length,
    })
}

fn user_git(executable: &Path) -> WorkspaceResult<ReadOnlyGit> {
    Ok(ReadOnlyGit::new(executable.to_path_buf())
        .map_err(from_git)?
        .with_user_config())
}

fn diff_flags() -> Vec<OsString> {
    [
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--ignore-submodules=none",
        "--submodule=short",
    ]
    .into_iter()
    .map(string_arg)
    .collect()
}

/// One porcelain v2 record.
#[derive(Debug, Clone, Default)]
struct StatusRecord {
    path: Vec<u8>,
    original_path: Option<Vec<u8>>,
    staged: Option<u8>,
    unstaged: Option<u8>,
    head_mode: String,
    index_mode: String,
    worktree_mode: String,
    head_oid: Option<String>,
    index_oid: Option<String>,
    submodule: bool,
    untracked: bool,
    conflict: Option<WorkspaceConflict>,
}

#[derive(Debug, Default)]
struct StatusOutput {
    head_oid: Option<String>,
    head_branch: Option<String>,
    records: Vec<StatusRecord>,
}

fn status_letter(byte: u8) -> Option<u8> {
    (byte != b'.').then_some(byte)
}

fn conflict_kind(xy: &[u8]) -> Option<WorkspaceConflict> {
    Some(match xy {
        b"DD" => WorkspaceConflict::BothDeleted,
        b"AU" => WorkspaceConflict::AddedByUs,
        b"UD" => WorkspaceConflict::DeletedByThem,
        b"UA" => WorkspaceConflict::AddedByThem,
        b"DU" => WorkspaceConflict::DeletedByUs,
        b"AA" => WorkspaceConflict::BothAdded,
        b"UU" => WorkspaceConflict::BothModified,
        _ => return None,
    })
}

fn real_oid(value: &str, oid_length: usize) -> Option<String> {
    (value.len() == oid_length && value.bytes().any(|byte| byte != b'0'))
        .then(|| value.to_ascii_lowercase())
}

fn parse_status(bytes: &[u8], oid_length: usize) -> WorkspaceResult<StatusOutput> {
    let malformed = || detail_error(ErrorCode::GitError, "Malformed git status output", false);
    let mut output = StatusOutput::default();
    let mut fields = bytes.split(|byte| *byte == 0).peekable();
    while let Some(record) = fields.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(header) = record.strip_prefix(b"# ") {
            let header = String::from_utf8_lossy(header);
            if let Some(oid) = header.strip_prefix("branch.oid ") {
                output.head_oid = real_oid(oid, oid_length);
            } else if let Some(branch) = header.strip_prefix("branch.head ") {
                output.head_branch = (branch != "(detached)").then(|| branch.to_owned());
            }
            continue;
        }
        let kind = record[0];
        match kind {
            b'?' => output.records.push(StatusRecord {
                path: record.get(2..).ok_or_else(malformed)?.to_vec(),
                untracked: true,
                ..StatusRecord::default()
            }),
            b'!' => {}
            b'1' | b'2' | b'u' => {
                // Fixed fields are space separated; the path is everything after them.
                let field_count = match kind {
                    b'1' => 8,
                    b'2' => 9,
                    _ => 10,
                };
                let mut parts = record.splitn(field_count + 1, |byte| *byte == b' ');
                let fixed: Vec<&[u8]> = parts.by_ref().take(field_count).collect();
                let path = parts.next().ok_or_else(malformed)?.to_vec();
                if fixed.len() != field_count || fixed[1].len() != 2 {
                    return Err(malformed());
                }
                let text = |index: usize| String::from_utf8_lossy(fixed[index]).into_owned();
                let xy = fixed[1];
                let mut entry = StatusRecord {
                    path,
                    submodule: fixed[2].first() == Some(&b'S'),
                    ..StatusRecord::default()
                };
                if kind == b'u' {
                    entry.conflict = Some(conflict_kind(xy).ok_or_else(malformed)?);
                    entry.worktree_mode = text(6);
                } else {
                    entry.staged = status_letter(xy[0]);
                    entry.unstaged = status_letter(xy[1]);
                    entry.head_mode = text(3);
                    entry.index_mode = text(4);
                    entry.worktree_mode = text(5);
                    entry.head_oid = real_oid(&text(6), oid_length);
                    entry.index_oid = real_oid(&text(7), oid_length);
                    if kind == b'2' {
                        entry.original_path = Some(fields.next().ok_or_else(malformed)?.to_vec());
                    }
                }
                output.records.push(entry);
            }
            _ => return Err(malformed()),
        }
    }
    Ok(output)
}

fn run_status(
    git: &ReadOnlyGit,
    tree: &Worktree,
    pathspecs: &[OsString],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> WorkspaceResult<StatusOutput> {
    let mut args: Vec<OsString> = [
        "--literal-pathspecs",
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
        "--ignored=no",
        "--find-renames",
        "--no-ahead-behind",
    ]
    .into_iter()
    .map(string_arg)
    .collect();
    if !pathspecs.is_empty() {
        args.push(string_arg("--"));
        args.extend(pathspecs.iter().cloned());
    }
    let output = git
        .run(
            &tree.root,
            &args,
            None,
            STATUS_OUTPUT_LIMIT,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(git_output_error(&output.stderr));
    }
    parse_status(&output.stdout, tree.oid_length)
}

#[derive(Debug, Clone, Copy)]
struct LineCounts {
    additions: Option<u64>,
    deletions: Option<u64>,
    binary: bool,
}

/// `diff --numstat -z`: "a\td\tpath\0", or for a rename "a\td\t\0old\0new\0". Keyed by the new path.
fn parse_numstat_z(bytes: &[u8]) -> HashMap<Vec<u8>, LineCounts> {
    let mut counts = HashMap::new();
    let mut fields = bytes.split(|byte| *byte == 0);
    while let Some(record) = fields.next() {
        if record.is_empty() {
            continue;
        }
        let mut parts = record.splitn(3, |byte| *byte == b'\t');
        let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            let _old = fields.next();
            fields.next().unwrap_or_default().to_vec()
        } else {
            path.to_vec()
        };
        let parse = |value: &[u8]| {
            std::str::from_utf8(value)
                .ok()
                .and_then(|text| text.parse::<u64>().ok())
        };
        let binary = added == b"-" || deleted == b"-";
        counts.insert(
            path,
            LineCounts {
                additions: parse(added),
                deletions: parse(deleted),
                binary,
            },
        );
    }
    counts
}

fn run_numstat(
    git: &ReadOnlyGit,
    tree: &Worktree,
    cached: bool,
    pathspecs: &[OsString],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> WorkspaceResult<HashMap<Vec<u8>, LineCounts>> {
    let mut args = vec![string_arg("--literal-pathspecs"), string_arg("diff")];
    if cached {
        args.push(string_arg("--cached"));
        args.push(string_arg("--find-renames"));
    } else {
        args.push(string_arg("--no-renames"));
    }
    args.extend(diff_flags());
    args.extend([string_arg("--numstat"), string_arg("-z"), string_arg("--")]);
    args.extend(pathspecs.iter().cloned());
    let output = git
        .run(
            &tree.root,
            &args,
            None,
            NUMSTAT_OUTPUT_LIMIT,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(git_output_error(&output.stderr));
    }
    Ok(parse_numstat_z(&output.stdout))
}

#[derive(Debug, PartialEq, Eq)]
enum NumstatPlan {
    Skip,
    Run(Vec<OsString>),
}

fn raw_bytes_to_os_string(bytes: &[u8]) -> Option<OsString> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Some(std::ffi::OsStr::from_bytes(bytes).to_os_string())
    }
    #[cfg(windows)]
    {
        std::str::from_utf8(bytes).ok().map(OsString::from)
    }
}

fn build_side_numstat_plan(mut raw_paths: Vec<&[u8]>) -> NumstatPlan {
    if raw_paths.is_empty() {
        return NumstatPlan::Skip;
    }
    raw_paths.sort_unstable();
    raw_paths.dedup();
    let total_bytes: usize = raw_paths.iter().map(|path| path.len()).sum();
    if raw_paths.len() > NUMSTAT_ARGV_PATH_LIMIT || total_bytes > NUMSTAT_ARGV_BYTE_LIMIT {
        // Fall back to an unscoped diff when argv bounds are tight; `--no-renames` / dirty index still apply.
        return NumstatPlan::Run(Vec::new());
    }
    match raw_paths
        .into_iter()
        .map(raw_bytes_to_os_string)
        .collect::<Option<Vec<_>>>()
    {
        Some(specs) => NumstatPlan::Run(specs),
        None => NumstatPlan::Run(Vec::new()),
    }
}

fn build_numstat_plans(records: &[StatusRecord]) -> (NumstatPlan, NumstatPlan) {
    let tracked_changes = records
        .iter()
        .filter(|record| !record.untracked && record.conflict.is_none())
        .count();
    if tracked_changes == 0 || tracked_changes > NUMSTAT_PATH_LIMIT {
        return (NumstatPlan::Skip, NumstatPlan::Skip);
    }
    let mut staged_raw = Vec::new();
    let mut unstaged_raw = Vec::new();
    for record in records
        .iter()
        .filter(|record| !record.untracked && record.conflict.is_none())
    {
        if record.staged.is_some() {
            staged_raw.push(record.path.as_slice());
            if let Some(original) = record.original_path.as_deref() {
                staged_raw.push(original);
            }
        }
        if record.unstaged.is_some() {
            unstaged_raw.push(record.path.as_slice());
        }
    }
    (
        build_side_numstat_plan(staged_raw),
        build_side_numstat_plan(unstaged_raw),
    )
}

fn change_status(letter: u8) -> ChangedFileStatus {
    match letter {
        b'A' => ChangedFileStatus::Added,
        b'D' => ChangedFileStatus::Deleted,
        b'R' => ChangedFileStatus::Renamed,
        b'C' => ChangedFileStatus::Copied,
        b'T' => ChangedFileStatus::TypeChanged,
        _ => ChangedFileStatus::Modified,
    }
}

fn workspace_change(
    letter: Option<u8>,
    gitlink: bool,
    counts: Option<&LineCounts>,
) -> Option<WorkspaceChange> {
    let letter = letter?;
    Some(WorkspaceChange {
        status: change_status(letter),
        additions: counts
            .filter(|counts| !counts.binary)
            .and_then(|counts| counts.additions),
        deletions: counts
            .filter(|counts| !counts.binary)
            .and_then(|counts| counts.deletions),
        binary: counts.is_some_and(|counts| counts.binary),
        gitlink,
    })
}

fn operation(git_dir: &Path) -> WorkspaceOperation {
    let exists = |name: &str| git_dir.join(name).exists();
    if exists("rebase-merge") || exists("rebase-apply") {
        WorkspaceOperation::Rebase
    } else if exists("MERGE_HEAD") {
        WorkspaceOperation::Merge
    } else if exists("CHERRY_PICK_HEAD") {
        WorkspaceOperation::CherryPick
    } else if exists("REVERT_HEAD") {
        WorkspaceOperation::Revert
    } else if exists("BISECT_LOG") {
        WorkspaceOperation::Bisect
    } else {
        WorkspaceOperation::None
    }
}

#[cfg(unix)]
pub(crate) fn native_path(bytes: &[u8]) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
}

#[cfg(windows)]
pub(crate) fn native_path(bytes: &[u8]) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(bytes).into_owned())
}

pub fn read_status(
    executable: &Path,
    session: &session::RepositorySession,
    params: &ReadWorkspaceStatusParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> WorkspaceResult<WorkspaceStatus> {
    let tree = worktree(session)?;
    read_status_at(executable, &tree, params, cancelled, deadline)
}

fn read_status_at(
    executable: &Path,
    tree: &Worktree,
    params: &ReadWorkspaceStatusParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> WorkspaceResult<WorkspaceStatus> {
    let git = user_git(executable)?;
    let status = run_status(&git, tree, &[], cancelled, deadline)?;
    let (staged_plan, unstaged_plan) = build_numstat_plans(&status.records);
    let head_oid = status.head_oid.as_deref();
    let (staged_counts, unstaged_counts, draft_commit_message) =
        match (&staged_plan, &unstaged_plan) {
            (NumstatPlan::Skip, NumstatPlan::Skip) => (
                HashMap::new(),
                HashMap::new(),
                read_draft_commit_message(executable, tree, head_oid, cancelled, deadline),
            ),
            _ => std::thread::scope(|scope| -> WorkspaceResult<_> {
                let draft_handle = scope.spawn(|| {
                    read_draft_commit_message(executable, tree, head_oid, cancelled, deadline)
                });
                let (staged_res, unstaged_res) = match (&staged_plan, &unstaged_plan) {
                    (NumstatPlan::Run(staged_specs), NumstatPlan::Run(unstaged_specs)) => {
                        let staged_handle = scope.spawn(|| {
                            run_numstat(&git, tree, true, staged_specs, cancelled, deadline)
                        });
                        let unstaged_res =
                            run_numstat(&git, tree, false, unstaged_specs, cancelled, deadline);
                        let staged_res = staged_handle.join().unwrap_or_else(|_| {
                            Err(detail_error(
                                ErrorCode::GitError,
                                "Workspace numstat worker failed",
                                false,
                            ))
                        });
                        (staged_res, unstaged_res)
                    }
                    (NumstatPlan::Run(staged_specs), NumstatPlan::Skip) => (
                        run_numstat(&git, tree, true, staged_specs, cancelled, deadline),
                        Ok(HashMap::new()),
                    ),
                    (NumstatPlan::Skip, NumstatPlan::Run(unstaged_specs)) => (
                        Ok(HashMap::new()),
                        run_numstat(&git, tree, false, unstaged_specs, cancelled, deadline),
                    ),
                    (NumstatPlan::Skip, NumstatPlan::Skip) => unreachable!(),
                };
                let draft_commit_message = draft_handle.join().unwrap_or(None);
                Ok((staged_res?, unstaged_res?, draft_commit_message))
            })?,
        };
    let mut records = status.records;
    records.sort_by(|left, right| left.path.cmp(&right.path));
    records.dedup_by(|right, left| right.path == left.path);
    let total_paths = u32::try_from(records.len()).unwrap_or(u32::MAX);
    let conflict_count = u32::try_from(
        records
            .iter()
            .filter(|record| record.conflict.is_some())
            .count(),
    )
    .unwrap_or(u32::MAX);
    let limit = usize::from(params.max_entries);
    let listed = records.len();
    records.truncate(limit);
    let mut entries: Vec<WorkspaceEntry> = Vec::with_capacity(records.len());
    let mut used = 0;
    for entry in records.into_iter().map(|record| {
        let gitlink = record.submodule
            || [&record.head_mode, &record.index_mode, &record.worktree_mode]
                .iter()
                .any(|mode| mode.as_str() == GITLINK_MODE);
        let untracked_size = record
            .untracked
            .then(|| {
                std::fs::symlink_metadata(tree.root.join(native_path(&record.path)))
                    .ok()
                    .map(|meta| meta.len())
            })
            .flatten();
        WorkspaceEntry {
            staged: workspace_change(record.staged, gitlink, staged_counts.get(&record.path)),
            unstaged: workspace_change(record.unstaged, gitlink, unstaged_counts.get(&record.path)),
            original_path: record.original_path.map(git_path),
            path: git_path(record.path),
            untracked: record.untracked,
            untracked_size,
            conflict: record.conflict,
        }
    }) {
        // Long paths can make 2,000 entries larger than one response; the rest is reported as incomplete.
        if over_budget(&entry, &mut used, entries.len()) {
            break;
        }
        entries.push(entry);
    }
    let complete = entries.len() == listed;
    Ok(WorkspaceStatus {
        observed_at_unix_ms: now_unix_ms(),
        head_reference: status
            .head_branch
            .map(|branch| format!("refs/heads/{branch}")),
        head_oid: status.head_oid,
        operation: operation(&tree.git_dir),
        entries,
        complete,
        total_paths,
        conflict_count,
        draft_commit_message,
    })
}

fn clean_draft_message(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    let cleaned = text
        .lines()
        .filter(|line| !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    let trimmed = cleaned.trim();
    (!trimmed.is_empty() && trimmed.len() <= 65_536).then(|| trimmed.to_owned())
}

fn read_draft_commit_message(
    executable: &Path,
    tree: &Worktree,
    head_oid: Option<&str>,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Option<String> {
    for name in ["MERGE_MSG", "SQUASH_MSG", "COMMIT_EDITMSG"] {
        let path = tree.git_dir.join(name);
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() > 64 * 1024 {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Some(cleaned) = clean_draft_message(&bytes) else {
            continue;
        };
        if name == "COMMIT_EDITMSG"
            && let Some(oid) = head_oid
        {
            let Ok(ro_git) = ReadOnlyGit::new(executable.to_path_buf()) else {
                continue;
            };
            let Ok(output) = ro_git.run(
                &tree.root,
                &[
                    string_arg("log"),
                    string_arg("-1"),
                    string_arg("--format=%B"),
                    string_arg(oid),
                ],
                None,
                128 * 1024,
                cancelled,
                deadline,
            ) else {
                continue;
            };
            if !output.status.success() {
                continue;
            }
            if String::from_utf8_lossy(&output.stdout).trim() == cleaned {
                continue;
            }
        }
        return Some(cleaned);
    }
    None
}

fn decode_path(hex: &str) -> WorkspaceResult<Vec<u8>> {
    hex_decode(hex).map_err(|()| {
        detail_error(
            ErrorCode::InvalidRequest,
            "Invalid raw repository path",
            false,
        )
    })
}

fn blob_size(
    git: &ReadOnlyGit,
    tree: &Worktree,
    oid: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> WorkspaceResult<u64> {
    let output = git
        .run(
            &tree.root,
            &[string_arg("cat-file"), string_arg("-s"), string_arg(oid)],
            None,
            64,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(git_output_error(&output.stderr));
    }
    std::str::from_utf8(&output.stdout)
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok())
        .ok_or_else(|| detail_error(ErrorCode::GitError, "Invalid blob size", false))
}

fn small_blob_is_lfs(
    git: &ReadOnlyGit,
    tree: &Worktree,
    oid: Option<&str>,
    size: Option<u64>,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> WorkspaceResult<bool> {
    match (oid, size) {
        (Some(oid), Some(size)) if size <= 1024 => Ok(is_lfs_pointer(&read_blob(
            git, &tree.root, oid, 1025, cancelled, deadline,
        )?)),
        _ => Ok(false),
    }
}

pub fn read_diff(
    executable: &Path,
    session: &session::RepositorySession,
    params: &ReadWorkspaceDiffParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> WorkspaceResult<WorkspaceDiff> {
    let tree = worktree(session)?;
    read_diff_at(executable, &tree, params, cancelled, deadline)
}

fn read_diff_at(
    executable: &Path,
    tree: &Worktree,
    params: &ReadWorkspaceDiffParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> WorkspaceResult<WorkspaceDiff> {
    validate_path_hex(Some(&params.path_hex))?;
    validate_path_hex(params.old_path_hex.as_deref())?;
    let path = decode_path(&params.path_hex)?;
    let old_path = params
        .old_path_hex
        .as_deref()
        .map(decode_path)
        .transpose()?;
    let mut pathspecs = vec![raw_path_arg(&params.path_hex.to_ascii_lowercase())?];
    if let Some(old) = params.old_path_hex.as_deref() {
        pathspecs.push(raw_path_arg(&old.to_ascii_lowercase())?);
    }
    let git = user_git(executable)?;
    let status = run_status(&git, tree, &pathspecs, cancelled, deadline)?;
    let staged = params.side == WorkspaceSide::Staged;
    let record = status
        .records
        .into_iter()
        .find(|record| {
            record.path == path
                && record.conflict.is_none()
                && !record.untracked
                && if staged {
                    record.staged.is_some()
                } else {
                    record.unstaged.is_some()
                }
                && (!staged || record.original_path == old_path)
        })
        .ok_or_else(|| {
            detail_error(
                ErrorCode::MissingObject,
                "The file is no longer changed in that group",
                false,
            )
        })?;
    let gitlink = record.submodule
        || [&record.head_mode, &record.index_mode, &record.worktree_mode]
            .iter()
            .any(|mode| mode.as_str() == GITLINK_MODE);
    let letter = if staged {
        record.staged
    } else {
        record.unstaged
    };
    let deleted = letter == Some(b'D');
    let added = letter == Some(b'A');
    // Sizes: staged compares HEAD → index; unstaged compares index → working tree.
    let (old_oid, new_oid) = if staged {
        (
            record.head_oid.clone().filter(|_| !added),
            record.index_oid.clone().filter(|_| !deleted),
        )
    } else {
        (record.index_oid.clone(), None)
    };
    // A gitlink names a commit in the submodule's own repository; there is no blob here to measure.
    let old_size = if gitlink {
        None
    } else {
        old_oid
            .as_deref()
            .map(|oid| blob_size(&git, tree, oid, cancelled, deadline))
            .transpose()?
    };
    let new_size = if gitlink {
        None
    } else if staged {
        new_oid
            .as_deref()
            .map(|oid| blob_size(&git, tree, oid, cancelled, deadline))
            .transpose()?
    } else if deleted {
        None
    } else {
        std::fs::symlink_metadata(tree.root.join(native_path(&path)))
            .ok()
            .map(|meta| meta.len())
    };
    let mut diff = WorkspaceDiff {
        side: params.side,
        path: git_path(path),
        old_path: if staged {
            record.original_path.map(git_path)
        } else {
            None
        },
        kind: FileDiffKind::Text,
        patch: String::new(),
        truncated: false,
        text_lossy: false,
        old_size,
        new_size,
    };
    diff.kind = if gitlink {
        FileDiffKind::Gitlink
    } else if old_size.is_some_and(|size| size > FILE_DIFF_BLOB_LIMIT)
        || new_size.is_some_and(|size| size > FILE_DIFF_BLOB_LIMIT)
    {
        FileDiffKind::TooLarge
    } else if small_blob_is_lfs(
        &git,
        tree,
        old_oid.as_deref(),
        old_size,
        cancelled,
        deadline,
    )? || small_blob_is_lfs(
        &git,
        tree,
        new_oid.as_deref(),
        new_size,
        cancelled,
        deadline,
    )? {
        FileDiffKind::Lfs
    } else if run_numstat(&git, tree, staged, &pathspecs, cancelled, deadline)?
        .values()
        .any(|counts| counts.binary)
    {
        FileDiffKind::Binary
    } else {
        FileDiffKind::Text
    };
    // A gitlink still gets its "Subproject commit" lines (--submodule=short): they are the only place the
    // workspace page can show which commit the reference moved between.
    if !matches!(diff.kind, FileDiffKind::Text | FileDiffKind::Gitlink) {
        return Ok(diff);
    }
    let mut args: Vec<OsString> = vec![
        string_arg("-c"),
        string_arg("diff.suppressBlankEmpty=false"),
        string_arg("-c"),
        string_arg("diff.noprefix=false"),
        string_arg("--literal-pathspecs"),
        string_arg("diff"),
    ];
    if staged {
        args.extend([string_arg("--cached"), string_arg("--find-renames")]);
    } else {
        args.push(string_arg("--no-renames"));
    }
    args.extend(diff_flags());
    args.extend([
        string_arg("--text"),
        string_arg(if params.full_file {
            format!("--unified={FULL_FILE_CONTEXT}")
        } else {
            "--unified=3".to_owned()
        }),
        string_arg("--diff-algorithm=myers"),
        string_arg("--indent-heuristic"),
        string_arg("--no-relative"),
        string_arg("--"),
    ]);
    args.extend(pathspecs);
    let (patch, truncated, text_lossy) = collect_patch(
        &git,
        &tree.root,
        &args,
        params.full_file,
        cancelled,
        deadline,
    )?;
    diff.patch = patch;
    diff.truncated = truncated;
    diff.text_lossy = text_lossy;
    Ok(diff)
}

pub fn read_file(
    session: &session::RepositorySession,
    params: &ReadWorkspaceFileParams,
) -> WorkspaceResult<WorkspaceFile> {
    let tree = worktree(session)?;
    read_file_at(&tree, params)
}

fn invalid_path() -> DetailError {
    detail_error(
        ErrorCode::InvalidRequest,
        "The path must stay inside the working tree",
        false,
    )
}

fn read_file_at(
    tree: &Worktree,
    params: &ReadWorkspaceFileParams,
) -> WorkspaceResult<WorkspaceFile> {
    validate_path_hex(Some(&params.path_hex))?;
    let bytes = decode_path(&params.path_hex)?;
    let unsafe_component = |component: &[u8]| {
        component.is_empty()
            || component == b"."
            || component == b".."
            || component.eq_ignore_ascii_case(b".git")
    };
    if bytes.contains(&0)
        || (cfg!(windows) && (bytes.contains(&b'\\') || bytes.contains(&b':')))
        || bytes.split(|byte| *byte == b'/').any(unsafe_component)
    {
        return Err(invalid_path());
    }
    let mut file = WorkspaceFile {
        path: git_path(bytes.clone()),
        kind: WorkspaceFileKind::Missing,
        text: String::new(),
        lines: 0,
        truncated: false,
        size: None,
        text_lossy: false,
        symlink_target: None,
    };
    let full = tree.root.join(native_path(&bytes));
    // A symlinked parent directory must not lead outside the working tree.
    let root = tree.root.canonicalize().map_err(|_| {
        detail_error(
            ErrorCode::RepositoryUnavailable,
            "The working tree is unavailable",
            true,
        )
    })?;
    match full.parent().map(Path::canonicalize) {
        Some(Ok(parent)) if parent.starts_with(&root) => {}
        Some(Ok(_)) => return Err(invalid_path()),
        _ => return Ok(file),
    }
    let meta = match std::fs::symlink_metadata(&full) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(file),
        Err(error) => return Err(io_error(&error)),
    };
    file.size = Some(meta.len());
    if meta.file_type().is_symlink() {
        file.kind = WorkspaceFileKind::Symlink;
        let target = std::fs::read_link(&full).map_err(|error| io_error(&error))?;
        file.symlink_target = Some(git_path(path_bytes(&target)));
        return Ok(file);
    }
    if !meta.is_file() {
        file.kind = WorkspaceFileKind::NotFile;
        file.size = None;
        return Ok(file);
    }
    if meta.len() > FILE_READ_LIMIT {
        file.kind = WorkspaceFileKind::TooLarge;
        return Ok(file);
    }
    let content = read_no_follow(&full).map_err(|error| io_error(&error))?;
    file.size = Some(content.len() as u64);
    if content[..content.len().min(BINARY_SNIFF)].contains(&0) {
        file.kind = WorkspaceFileKind::Binary;
        return Ok(file);
    }
    let (text, lines, lossy, truncated) =
        text_head(&content, usize::from(params.max_lines), FILE_TEXT_LIMIT);
    file.kind = WorkspaceFileKind::Text;
    file.text = text;
    file.lines = lines;
    file.text_lossy = lossy;
    file.truncated = truncated;
    Ok(file)
}

fn io_error(error: &std::io::Error) -> DetailError {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        detail_error(
            ErrorCode::PermissionDenied,
            "The file cannot be read",
            false,
        )
    } else {
        detail_error(
            ErrorCode::RepositoryUnavailable,
            "The file could not be read",
            true,
        )
    }
}

/// Opens without following a symlink swapped in after the metadata check, and reads at most the limit.
fn read_no_follow(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let handle = options.open(path)?;
    if !handle.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    let mut content = Vec::new();
    handle.take(FILE_READ_LIMIT).read_to_end(&mut content)?;
    Ok(content)
}

#[cfg(unix)]
fn path_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
fn path_bytes(path: &Path) -> Vec<u8> {
    path.to_string_lossy().replace('\\', "/").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

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
            .expect("Git is available for the workspace unit tests")
    }

    fn run(repository: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new(git_bin())
            .arg("-C")
            .arg(repository)
            .args([
                "-c",
                "user.name=Workspace Test",
                "-c",
                "user.email=workspace@example.invalid",
            ])
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn hex(text: &str) -> String {
        text.bytes().map(|byte| format!("{byte:02x}")).collect()
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "commitscope-workspace-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    /// a.txt staged and unstaged edits, c.txt → d.txt staged rename, u.txt untracked, x.log ignored.
    fn fixture(label: &str) -> (Worktree, TestDir) {
        let root = temp_root(label);
        run(&root, &["init", "--quiet", "-b", "main"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        std::fs::write(
            root.join("c.txt"),
            (1..=20)
                .map(|line| format!("line {line}\n"))
                .collect::<String>(),
        )
        .unwrap();
        run(&root, &["add", "."]);
        run(&root, &["commit", "--quiet", "-m", "root"]);
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        run(&root, &["add", "a.txt"]);
        std::fs::write(root.join("a.txt"), "two\nthree\n").unwrap();
        run(&root, &["mv", "c.txt", "d.txt"]);
        std::fs::write(root.join("u.txt"), "hello").unwrap();
        std::fs::write(root.join(".git/info/exclude"), "*.log\n").unwrap();
        std::fs::write(root.join("x.log"), "ignored").unwrap();
        let tree = Worktree {
            git_dir: root.join(".git"),
            root: root.clone(),
            oid_length: 40,
        };
        (tree, TestDir(root))
    }

    fn status(tree: &Worktree, max_entries: u16) -> WorkspaceStatus {
        read_status_at(
            &git_bin(),
            tree,
            &ReadWorkspaceStatusParams { max_entries },
            &AtomicBool::new(false),
            deadline(),
        )
        .unwrap()
    }

    fn diff(
        tree: &Worktree,
        side: WorkspaceSide,
        path: &str,
        old: Option<&str>,
        full_file: bool,
    ) -> WorkspaceResult<WorkspaceDiff> {
        let params = ReadWorkspaceDiffParams {
            side,
            path_hex: hex(path),
            old_path_hex: old.map(hex),
            full_file,
        };
        read_diff_at(
            &git_bin(),
            tree,
            &params,
            &AtomicBool::new(false),
            deadline(),
        )
    }

    fn file(tree: &Worktree, path: &str) -> WorkspaceResult<WorkspaceFile> {
        read_file_at(
            tree,
            &ReadWorkspaceFileParams {
                path_hex: hex(path),
                max_lines: 100,
            },
        )
    }

    #[test]
    fn status_groups_staged_unstaged_and_untracked_paths() {
        let (tree, _cleanup) = fixture("status");
        let status = status(&tree, 2000);
        let paths: Vec<_> = status
            .entries
            .iter()
            .map(|entry| entry.path.display.as_str())
            .collect();
        assert_eq!(
            paths,
            ["a.txt", "d.txt", "u.txt"],
            "ignored files are not listed"
        );
        assert_eq!(
            (status.total_paths, status.complete, status.conflict_count),
            (3, true, 0)
        );
        assert_eq!(status.head_reference.as_deref(), Some("refs/heads/main"));
        assert_eq!(status.operation, WorkspaceOperation::None);
        let a = &status.entries[0];
        let staged = a.staged.as_ref().unwrap();
        let unstaged = a.unstaged.as_ref().unwrap();
        assert_eq!(
            (staged.status, staged.additions, staged.deletions),
            (ChangedFileStatus::Modified, Some(1), Some(1))
        );
        assert_eq!((unstaged.additions, unstaged.deletions), (Some(1), Some(0)));
        let d = &status.entries[1];
        assert_eq!(
            d.staged.as_ref().unwrap().status,
            ChangedFileStatus::Renamed
        );
        assert_eq!(d.original_path.as_ref().unwrap().display, "c.txt");
        assert!(d.unstaged.is_none());
        let u = &status.entries[2];
        assert!(u.untracked && u.staged.is_none());
        assert_eq!(u.untracked_size, Some(5));
        let cut = self::status(&tree, 2);
        assert_eq!(
            (cut.entries.len(), cut.complete, cut.total_paths),
            (2, false, 3)
        );
    }

    #[test]
    fn long_paths_cut_the_status_to_one_response() {
        let (tree, _cleanup) = fixture("budget");
        std::fs::create_dir(tree.root.join("many")).unwrap();
        for index in 0..1200 {
            std::fs::write(
                tree.root
                    .join("many")
                    .join(format!("{}-{index:04}", "x".repeat(180))),
                "x",
            )
            .unwrap();
        }
        let status = status(&tree, 2000);
        assert_eq!(status.total_paths, 1203);
        assert!(!status.complete && status.entries.len() > 100 && status.entries.len() < 1203);
        assert!(serde_json::to_vec(&status).unwrap().len() < 450 * 1024);
    }

    #[test]
    fn diffs_follow_the_requested_group() {
        let (tree, _cleanup) = fixture("diff");
        let staged = diff(&tree, WorkspaceSide::Staged, "a.txt", None, false).unwrap();
        assert!(staged.patch.contains("-one\n+two\n"), "{}", staged.patch);
        assert!(!staged.patch.contains("three"));
        let unstaged = diff(&tree, WorkspaceSide::Unstaged, "a.txt", None, false).unwrap();
        assert!(
            unstaged.patch.contains(" two\n+three\n"),
            "{}",
            unstaged.patch
        );
        assert_eq!((unstaged.old_size, unstaged.new_size), (Some(4), Some(10)));
        let renamed = diff(&tree, WorkspaceSide::Staged, "d.txt", Some("c.txt"), false).unwrap();
        assert_eq!(renamed.old_path.as_ref().unwrap().display, "c.txt");
        assert_eq!(renamed.kind, FileDiffKind::Text);
        let missing = diff(&tree, WorkspaceSide::Unstaged, "d.txt", None, false).unwrap_err();
        assert_eq!(missing.code, ErrorCode::MissingObject);
        assert_eq!(
            diff(&tree, WorkspaceSide::Staged, "u.txt", None, false)
                .unwrap_err()
                .code,
            ErrorCode::MissingObject
        );
        // Whole-file context covers lines far from the edit.
        let edited: String = (1..=20)
            .map(|line| {
                if line == 10 {
                    "ten\n".to_owned()
                } else {
                    format!("line {line}\n")
                }
            })
            .collect();
        std::fs::write(tree.root.join("d.txt"), edited).unwrap();
        let short = diff(&tree, WorkspaceSide::Unstaged, "d.txt", None, false).unwrap();
        let full = diff(&tree, WorkspaceSide::Unstaged, "d.txt", None, true).unwrap();
        // Over 5,000 lines on one side: whole-file context is refused, the normal diff still works.
        let long: String = (1..=5_200).map(|line| format!("-- row {line}\n")).collect();
        std::fs::write(tree.root.join("a.txt"), &long).unwrap();
        let refused = diff(&tree, WorkspaceSide::Unstaged, "a.txt", None, true).unwrap_err();
        assert_eq!(refused.code, ErrorCode::ResourceLimit);
        assert!(
            diff(&tree, WorkspaceSide::Unstaged, "a.txt", None, false)
                .unwrap()
                .truncated
        );
        assert!(!short.patch.contains(" line 1\n"), "{}", short.patch);
        assert!(
            full.patch.contains(" line 1\n") && full.patch.contains(" line 20\n"),
            "{}",
            full.patch
        );
    }

    #[test]
    fn worktree_filters_run_for_the_working_tree_side() {
        let (tree, _cleanup) = fixture("filter");
        // A clean filter that drops comment lines: the comment never reaches the diff.
        run(
            &tree.root,
            &["config", "filter.strip.clean", "sed -e /^#/d"],
        );
        std::fs::write(tree.root.join(".gitattributes"), "*.up filter=strip\n").unwrap();
        std::fs::write(tree.root.join("f.up"), "a\n").unwrap();
        run(&tree.root, &["add", ".gitattributes", "f.up"]);
        run(&tree.root, &["commit", "--quiet", "-m", "filter"]);
        std::fs::write(tree.root.join("f.up"), "b\n# local note\n").unwrap();
        let unstaged = diff(&tree, WorkspaceSide::Unstaged, "f.up", None, false).unwrap();
        assert!(
            unstaged.patch.contains("-a\n+b\n") && !unstaged.patch.contains("note"),
            "{}",
            unstaged.patch
        );
    }

    #[test]
    fn conflicts_are_listed_without_a_diff() {
        let root = temp_root("conflict");
        let _cleanup = TestDir(root.clone());
        run(&root, &["init", "--quiet", "-b", "main"]);
        std::fs::write(root.join("f.txt"), "base\n").unwrap();
        run(&root, &["add", "."]);
        run(&root, &["commit", "--quiet", "-m", "base"]);
        run(&root, &["checkout", "--quiet", "-b", "other"]);
        std::fs::write(root.join("f.txt"), "other\n").unwrap();
        run(&root, &["commit", "--quiet", "-am", "other"]);
        run(&root, &["checkout", "--quiet", "main"]);
        std::fs::write(root.join("f.txt"), "main\n").unwrap();
        run(&root, &["commit", "--quiet", "-am", "main"]);
        run(&root, &["merge", "--quiet", "other"]);
        let tree = Worktree {
            git_dir: root.join(".git"),
            root: root.clone(),
            oid_length: 40,
        };
        let status = status(&tree, 2000);
        assert_eq!(status.operation, WorkspaceOperation::Merge);
        assert_eq!(status.conflict_count, 1);
        assert_eq!(
            status.entries[0].conflict,
            Some(WorkspaceConflict::BothModified)
        );
        assert_eq!(
            diff(&tree, WorkspaceSide::Unstaged, "f.txt", None, false)
                .unwrap_err()
                .code,
            ErrorCode::MissingObject
        );
        assert!(file(&tree, "f.txt").unwrap().text.contains("<<<<<<<"));
    }

    #[test]
    fn empty_repositories_and_deletions_are_reported() {
        let root = temp_root("unborn");
        let _cleanup = TestDir(root.clone());
        run(&root, &["init", "--quiet", "-b", "main"]);
        std::fs::write(root.join("staged.txt"), "a\n").unwrap();
        run(&root, &["add", "staged.txt"]);
        let tree = Worktree {
            git_dir: root.join(".git"),
            root: root.clone(),
            oid_length: 40,
        };
        let unborn = status(&tree, 2000);
        assert_eq!(
            (unborn.head_oid.as_deref(), unborn.head_reference.as_deref()),
            (None, Some("refs/heads/main"))
        );
        let added = unborn.entries[0].staged.as_ref().unwrap();
        assert_eq!(
            (added.status, added.additions),
            (ChangedFileStatus::Added, Some(1))
        );
        assert!(
            diff(&tree, WorkspaceSide::Staged, "staged.txt", None, false)
                .unwrap()
                .patch
                .contains("+a\n")
        );

        run(&root, &["commit", "--quiet", "-m", "first"]);
        std::fs::write(root.join("other.txt"), "b\n").unwrap();
        run(&root, &["add", "other.txt"]);
        run(&root, &["commit", "--quiet", "-m", "second"]);
        run(&root, &["rm", "--quiet", "staged.txt"]);
        std::fs::remove_file(root.join("other.txt")).unwrap();
        let status = status(&tree, 2000);
        let staged = status
            .entries
            .iter()
            .find(|entry| entry.path.display == "staged.txt")
            .unwrap();
        let unstaged = status
            .entries
            .iter()
            .find(|entry| entry.path.display == "other.txt")
            .unwrap();
        assert_eq!(
            staged.staged.as_ref().unwrap().status,
            ChangedFileStatus::Deleted
        );
        assert_eq!(
            unstaged.unstaged.as_ref().unwrap().status,
            ChangedFileStatus::Deleted
        );
        let removed = diff(&tree, WorkspaceSide::Unstaged, "other.txt", None, false).unwrap();
        assert!(removed.patch.contains("-b\n"));
        assert_eq!((removed.old_size, removed.new_size), (Some(2), None));
        assert_eq!(
            file(&tree, "other.txt").unwrap().kind,
            WorkspaceFileKind::Missing
        );
    }

    #[test]
    fn linked_worktrees_read_their_own_directory() {
        let (main, _cleanup) = fixture("linked-main");
        run(&main.root, &["commit", "--quiet", "-m", "staged changes"]);
        let linked_root = temp_root("linked");
        let _linked_cleanup = TestDir(linked_root.clone());
        std::fs::remove_dir(&linked_root).unwrap();
        run(
            &main.root,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "side",
                linked_root.to_str().unwrap(),
            ],
        );
        std::fs::write(linked_root.join("only-here.txt"), "x\n").unwrap();
        let git_dir = run(&linked_root, &["rev-parse", "--absolute-git-dir"]);
        let linked = Worktree {
            git_dir: PathBuf::from(git_dir),
            root: linked_root.canonicalize().unwrap(),
            oid_length: 40,
        };
        let status = status(&linked, 2000);
        assert_eq!(status.head_reference.as_deref(), Some("refs/heads/side"));
        let paths: Vec<_> = status
            .entries
            .iter()
            .map(|entry| entry.path.display.as_str())
            .collect();
        assert_eq!(paths, ["only-here.txt"]);
        assert!(
            self::status(&main, 2000)
                .entries
                .iter()
                .all(|entry| entry.path.display != "only-here.txt")
        );
    }

    #[test]
    fn files_are_read_only_inside_the_working_tree() {
        let (tree, _cleanup) = fixture("file");
        let untracked = file(&tree, "u.txt").unwrap();
        assert_eq!(
            (
                untracked.kind,
                untracked.text.as_str(),
                untracked.lines,
                untracked.size
            ),
            (WorkspaceFileKind::Text, "hello\n", 1, Some(5))
        );
        assert_eq!(
            file(&tree, "nope.txt").unwrap().kind,
            WorkspaceFileKind::Missing
        );
        for path in ["../outside", ".git/config", "a/./b", "/etc/passwd"] {
            assert_eq!(
                file(&tree, path).unwrap_err().code,
                ErrorCode::InvalidRequest,
                "{path}"
            );
        }
        std::fs::write(tree.root.join("bin.dat"), b"a\0b").unwrap();
        assert_eq!(
            file(&tree, "bin.dat").unwrap().kind,
            WorkspaceFileKind::Binary
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("a.txt", tree.root.join("link")).unwrap();
            let link = file(&tree, "link").unwrap();
            assert_eq!(
                (link.kind, link.symlink_target.unwrap().display),
                (WorkspaceFileKind::Symlink, "a.txt".to_owned())
            );
            let outside = std::env::temp_dir().canonicalize().unwrap();
            std::os::unix::fs::symlink(&outside, tree.root.join("escape")).unwrap();
            assert_eq!(
                file(&tree, "escape/anything").unwrap_err().code,
                ErrorCode::InvalidRequest
            );
        }
    }

    #[test]
    fn draft_commit_message_filters_stale_head_and_reads_pending_drafts() {
        let (tree, _cleanup) = fixture("draft-msg");
        // No draft initially (fixture committed with -m root).
        assert_eq!(status(&tree, 2000).draft_commit_message, None);
        // COMMIT_EDITMSG equal to HEAD commit message is ignored as stale.
        std::fs::write(tree.git_dir.join("COMMIT_EDITMSG"), "root\n# comment\n").unwrap();
        assert_eq!(status(&tree, 2000).draft_commit_message, None);
        // Distinct COMMIT_EDITMSG becomes available with comments stripped.
        std::fs::write(
            tree.git_dir.join("COMMIT_EDITMSG"),
            "feat: pending draft\n\nbody line\n# Please enter the commit message\n",
        )
        .unwrap();
        assert_eq!(
            status(&tree, 2000).draft_commit_message.as_deref(),
            Some("feat: pending draft\n\nbody line")
        );
        // MERGE_MSG takes precedence over COMMIT_EDITMSG.
        std::fs::write(
            tree.git_dir.join("MERGE_MSG"),
            "Merge branch 'topic'\n# Conflicts:\n#\ta.txt\n",
        )
        .unwrap();
        assert_eq!(
            status(&tree, 2000).draft_commit_message.as_deref(),
            Some("Merge branch 'topic'")
        );
    }

    #[test]
    fn status_numstat_handles_single_side_and_renamed_with_unstaged_edits() {
        let root = temp_root("numstat-sides");
        let _cleanup = TestDir(root.clone());
        run(&root, &["init", "--quiet", "-b", "main"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(
            root.join("c.txt"),
            (1..=20)
                .map(|line| format!("line {line}\n"))
                .collect::<String>(),
        )
        .unwrap();
        run(&root, &["add", "."]);
        run(&root, &["commit", "--quiet", "-m", "root"]);
        let tree = Worktree {
            git_dir: root.join(".git"),
            root: root.clone(),
            oid_length: 40,
        };

        // Unstaged-only edit skips cached numstat and counts exact lines.
        std::fs::write(root.join("a.txt"), "one\ntwo-edited\nthree\n").unwrap();
        let unstaged_only = status(&tree, 2000);
        let entry = unstaged_only.entries.first().unwrap();
        assert!(entry.staged.is_none());
        let unstaged = entry.unstaged.as_ref().unwrap();
        assert_eq!((unstaged.additions, unstaged.deletions), (Some(2), Some(1)));

        // Staged-only edit skips worktree numstat and counts exact lines.
        run(&root, &["add", "a.txt"]);
        let staged_only = status(&tree, 2000);
        let entry = staged_only.entries.first().unwrap();
        assert!(entry.unstaged.is_none());
        let staged = entry.staged.as_ref().unwrap();
        assert_eq!((staged.additions, staged.deletions), (Some(2), Some(1)));

        // Staged rename + unstaged modification + pending draft message concurrently.
        run(&root, &["commit", "--quiet", "-m", "baseline"]);
        run(&root, &["mv", "c.txt", "d.txt"]);
        let mut edited: String = (1..=20).map(|line| format!("line {line}\n")).collect();
        edited.push_str("line 21\n");
        std::fs::write(root.join("d.txt"), edited).unwrap();
        std::fs::write(
            tree.git_dir.join("COMMIT_EDITMSG"),
            "feat: draft rename\n# comment\n",
        )
        .unwrap();
        let both = status(&tree, 2000);
        assert_eq!(both.entries.len(), 1);
        let d = &both.entries[0];
        assert_eq!(d.original_path.as_ref().unwrap().display, "c.txt");
        let staged = d.staged.as_ref().unwrap();
        assert_eq!(staged.status, ChangedFileStatus::Renamed);
        assert_eq!((staged.additions, staged.deletions), (Some(0), Some(0)));
        let unstaged = d.unstaged.as_ref().unwrap();
        assert_eq!(unstaged.status, ChangedFileStatus::Modified);
        assert_eq!((unstaged.additions, unstaged.deletions), (Some(1), Some(0)));
        assert_eq!(
            both.draft_commit_message.as_deref(),
            Some("feat: draft rename")
        );
    }

    #[test]
    fn numstat_plan_bounds_argv_and_skips_clean_sides() {
        let ignored_only = vec![
            StatusRecord {
                path: b"new.txt".to_vec(),
                untracked: true,
                ..StatusRecord::default()
            },
            StatusRecord {
                path: b"conflict.txt".to_vec(),
                conflict: Some(WorkspaceConflict::BothModified),
                ..StatusRecord::default()
            },
        ];
        assert_eq!(
            build_numstat_plans(&ignored_only),
            (NumstatPlan::Skip, NumstatPlan::Skip)
        );

        let over_total_limit: Vec<StatusRecord> = (0..=NUMSTAT_PATH_LIMIT)
            .map(|index| StatusRecord {
                path: format!("f-{index}.txt").into_bytes(),
                unstaged: Some(b'M'),
                ..StatusRecord::default()
            })
            .collect();
        assert_eq!(
            build_numstat_plans(&over_total_limit),
            (NumstatPlan::Skip, NumstatPlan::Skip)
        );

        let staged_rename = vec![StatusRecord {
            path: b"d.txt".to_vec(),
            original_path: Some(b"c.txt".to_vec()),
            staged: Some(b'R'),
            ..StatusRecord::default()
        }];
        assert_eq!(
            build_numstat_plans(&staged_rename),
            (
                NumstatPlan::Run(vec![OsString::from("c.txt"), OsString::from("d.txt")]),
                NumstatPlan::Skip,
            )
        );

        let over_argv_count: Vec<StatusRecord> = (0..=NUMSTAT_ARGV_PATH_LIMIT)
            .map(|index| StatusRecord {
                path: format!("u-{index}.txt").into_bytes(),
                unstaged: Some(b'M'),
                ..StatusRecord::default()
            })
            .collect();
        assert_eq!(
            build_numstat_plans(&over_argv_count),
            (NumstatPlan::Skip, NumstatPlan::Run(Vec::new()))
        );

        let over_argv_bytes = vec![
            StatusRecord {
                path: vec![b'a'; 9_000],
                unstaged: Some(b'M'),
                ..StatusRecord::default()
            },
            StatusRecord {
                path: vec![b'b'; 9_000],
                unstaged: Some(b'M'),
                ..StatusRecord::default()
            },
        ];
        assert_eq!(
            build_numstat_plans(&over_argv_bytes),
            (NumstatPlan::Skip, NumstatPlan::Run(Vec::new()))
        );
    }
}
