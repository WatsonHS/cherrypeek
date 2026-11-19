//! Zero-intermediate-state diverged branch sync and conflict resolution preview / completion (M8).
//!
//! `preview_merge` runs `git merge-tree --write-tree -z` using an isolated temporary `GIT_OBJECT_DIRECTORY`
//! and `GIT_ALTERNATE_OBJECT_DIRECTORIES` pointing at the repository's object database, so previewing clean or
//! conflicted merges writes zero bytes into the repository.
//! `run_complete_merge` builds the resolved tree in a temporary `GIT_INDEX_FILE`, creates the commit object
//! via `commit-tree`, and atomically advances the worktree and branch ref without leaving `MERGE_HEAD` or
//! `rebase-merge` state on disk.

use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};

use commitscope_core::{
    ErrorCode, GitPath, MergeConflictFile, MergeDiffHunk, MergePreviewResult, MergeSyncMode,
    MergeUnsupportedReason, OperationBlocker as Blocker, OperationCheck, OperationRun,
    PreviewMergeParams, ResolvedMergeFile, UpdatedRef,
};

use super::{
    Inspector, OperationResult, dirty_blocker, dirty_paths, ensure_index_clean, from_git,
    full_branch_or_remote_ref, full_oid, full_ref, invalid, operation_error, overlaps_sorted_paths,
    sorted_paths, validate_workspace_path_hex,
};
use crate::{
    details::git_path,
    git_command::{CommandOutput, GitFailure, ReadOnlyGit, string_arg},
    session,
};

const MAX_CONFLICT_FILES: usize = 10;
const MAX_SINGLE_CONFLICT_BYTES: usize = 128 * 1024;
const MAX_TOTAL_CONFLICT_BYTES: usize = 512 * 1024;
const MAX_COMMIT_MESSAGE_BYTES: usize = 64 * 1024;
const MERGE_WRITE_STDOUT_LIMIT: usize = 8 * 1024 * 1024;

static SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new(label: &str) -> OperationResult<Self> {
        let seq = SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "commitscope-merge-{label}-{}-{seq}",
            std::process::id()
        ));
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&dir).map_err(|error| {
            operation_error(ErrorCode::GitError, &format!("创建临时目录失败：{error}"))
        })?;
        Ok(Self(dir))
    }

    fn objects_dir(&self) -> OperationResult<PathBuf> {
        let objects = self.0.join("objects");
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&objects).map_err(|error| {
            operation_error(
                ErrorCode::GitError,
                &format!("创建临时对象目录失败：{error}"),
            )
        })?;
        Ok(objects)
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct PreflightOutcome {
    blockers: Vec<Blocker>,
    preserved_dirty_count: u32,
    head_ref: Option<String>,
    head_oid: Option<String>,
}

struct DivergedPair {
    merge_base_oid: String,
    ahead: u64,
}

#[derive(Default)]
struct StageSet {
    stage1: Option<(String, String)>,
    stage2: Option<(String, String)>,
    stage3: Option<(String, String)>,
}

struct ParsedMergeTree {
    partial_tree_oid: String,
    stages: BTreeMap<Vec<u8>, StageSet>,
    messages: Vec<MergeTreeMessage>,
}

struct MergeTreeMessage {
    paths: Vec<Vec<u8>>,
    conflict_type: String,
    human_message: String,
}

enum MergeInspection {
    Clean {
        merge_base_oid: String,
        auto_merged_count: u32,
        can_single_commit_rebase: bool,
        single_commit_summary: Option<String>,
        default_message: String,
    },
    Conflicted {
        merge_base_oid: String,
        auto_merged_count: u32,
        default_message: String,
        files: Vec<MergeConflictFile>,
    },
    Unsupported {
        reason: MergeUnsupportedReason,
        message: String,
        conflict_paths: Vec<GitPath>,
    },
}

#[derive(Clone, Copy)]
struct MergeTargetSpec<'a> {
    target_ref: &'a str,
    expected_target_oid: &'a str,
    source_ref: &'a str,
    expected_source_oid: &'a str,
    expected_head_oid: Option<&'a str>,
    switch_to_target: bool,
}

fn validate_target_spec(
    spec: MergeTargetSpec<'_>,
    i: &Inspector<'_>,
    oid_length: usize,
) -> OperationResult<()> {
    full_ref(spec.target_ref, "refs/heads/")?;
    full_branch_or_remote_ref(spec.source_ref)?;
    if spec.target_ref == spec.source_ref {
        return Err(invalid("目标分支和源分支不能相同"));
    }
    for reference in [spec.target_ref, spec.source_ref] {
        if !i.output(&["check-ref-format", reference])?.status.success()
            || i.output(&["symbolic-ref", "--quiet", reference])?
                .status
                .success()
        {
            return Err(invalid("不支持该引用"));
        }
    }
    full_oid(spec.expected_target_oid, oid_length)?;
    full_oid(spec.expected_source_oid, oid_length)?;
    if let Some(expected_head) = spec.expected_head_oid {
        full_oid(expected_head, oid_length)?;
    }
    Ok(())
}

fn preflight(
    i: &Inspector<'_>,
    spec: MergeTargetSpec<'_>,
    oid_length: usize,
) -> OperationResult<PreflightOutcome> {
    validate_target_spec(spec, i, oid_length)?;
    let mut outcome = PreflightOutcome {
        blockers: Vec::new(),
        preserved_dirty_count: 0,
        head_ref: None,
        head_oid: None,
    };

    if i.line(&["rev-parse", "--is-bare-repository"])? == "true" {
        outcome.blockers.push(Blocker::Bare);
        return Ok(outcome);
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
            outcome.blockers.push(Blocker::InProgress {
                operation: operation.into(),
            });
        }
    }
    if !outcome.blockers.is_empty() {
        return Ok(outcome);
    }

    if let Some(blocker) = ensure_index_clean(i)? {
        outcome.blockers.push(blocker);
        return Ok(outcome);
    }

    let head_oid = i.oid("HEAD")?;
    let head_ref = i.head_reference()?;
    if let Some(expected_head) = spec.expected_head_oid
        && head_oid.as_deref() != Some(expected_head)
    {
        outcome.blockers.push(Blocker::RefChanged);
        return Ok(outcome);
    }
    if i.oid(spec.target_ref)?.as_deref() != Some(spec.expected_target_oid)
        || i.oid(spec.source_ref)?.as_deref() != Some(spec.expected_source_oid)
    {
        outcome.blockers.push(Blocker::RefChanged);
        return Ok(outcome);
    }

    let worktrees = i.read(&["worktree", "list", "--porcelain", "-z"])?;
    let current_worktree = i.directory.canonicalize().ok();
    let mut worktree = String::new();
    for field in worktrees.split(|b| *b == 0) {
        if let Some(path) = field.strip_prefix(b"worktree ") {
            worktree = String::from_utf8_lossy(path).into_owned();
        }
        if field.strip_prefix(b"branch ") == Some(spec.target_ref.as_bytes())
            && Path::new(&worktree).canonicalize().ok() != current_worktree
        {
            outcome.blockers.push(Blocker::CheckedOutElsewhere {
                worktree_path: worktree.clone(),
            });
        }
    }
    if !outcome.blockers.is_empty() {
        return Ok(outcome);
    }

    let target_is_head = head_ref.as_deref() == Some(spec.target_ref);
    if target_is_head || spec.switch_to_target {
        let (dirty, dirty_raw) = dirty_paths(i)?;
        if !dirty.is_empty() {
            let tracked_dirty: Vec<_> = dirty
                .iter()
                .filter(|entry| entry.staged || entry.unstaged || !entry.untracked)
                .cloned()
                .collect();
            if !tracked_dirty.is_empty() {
                outcome.blockers.push(dirty_blocker(tracked_dirty));
                return Ok(outcome);
            }

            // Untracked / ignored paths block only if they collide with incoming tree changes.
            let changed_a =
                diff_tree_paths_raw(i, spec.expected_target_oid, spec.expected_source_oid)?;
            let sorted_a = sorted_paths(&changed_a);
            let mut changed_head = Vec::new();
            let mut changed_target = Vec::new();
            if !target_is_head {
                if let Some(ref current_head) = head_oid {
                    changed_head = diff_tree_paths_raw(i, current_head, spec.expected_source_oid)?;
                    changed_target =
                        diff_tree_paths_raw(i, current_head, spec.expected_target_oid)?;
                } else {
                    outcome.blockers.push(dirty_blocker(dirty));
                    return Ok(outcome);
                }
            }
            let sorted_head = sorted_paths(&changed_head);
            let sorted_target = sorted_paths(&changed_target);
            let overlapping: Vec<_> = dirty
                .iter()
                .zip(dirty_raw.iter())
                .filter(|(_, raw)| {
                    overlaps_sorted_paths(&sorted_a, raw)
                        || (!sorted_head.is_empty() && overlaps_sorted_paths(&sorted_head, raw))
                        || (!sorted_target.is_empty() && overlaps_sorted_paths(&sorted_target, raw))
                })
                .map(|(entry, _)| entry.clone())
                .collect();
            if !overlapping.is_empty() {
                outcome.blockers.push(dirty_blocker(overlapping));
                return Ok(outcome);
            }
            outcome.preserved_dirty_count = u32::try_from(dirty.len()).unwrap_or(u32::MAX);
        }
    }

    outcome.head_ref = head_ref;
    outcome.head_oid = head_oid;
    Ok(outcome)
}

fn diff_tree_paths_raw(i: &Inspector<'_>, from: &str, to: &str) -> OperationResult<Vec<u8>> {
    i.read(&[
        "diff-tree",
        "--no-renames",
        "-r",
        "--name-only",
        "-z",
        from,
        to,
    ])
}

fn analyze_diverged_pair(
    i: &Inspector<'_>,
    target_oid: &str,
    source_oid: &str,
) -> OperationResult<Result<DivergedPair, MergePreviewResult>> {
    let base_out = i.output(&["merge-base", "--all", target_oid, source_oid])?;
    if !base_out.status.success() {
        return Ok(Err(MergePreviewResult::Unsupported {
            reason: MergeUnsupportedReason::UnrelatedHistories,
            message: "两个分支没有共同祖先，请交给 Agent 处理。".into(),
            conflict_paths: Vec::new(),
        }));
    }
    let bases: Vec<String> = String::from_utf8_lossy(&base_out.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();
    if bases.is_empty() {
        return Ok(Err(MergePreviewResult::Unsupported {
            reason: MergeUnsupportedReason::UnrelatedHistories,
            message: "两个分支没有共同祖先，请交给 Agent 处理。".into(),
            conflict_paths: Vec::new(),
        }));
    }
    if bases.len() > 1 {
        return Ok(Err(MergePreviewResult::Unsupported {
            reason: MergeUnsupportedReason::CrissCross,
            message: "存在多个共同祖先（criss-cross 合并），请交给 Agent 处理。".into(),
            conflict_paths: Vec::new(),
        }));
    }
    let (ahead, behind) = i.counts(target_oid, source_oid)?;
    if ahead == 0 || behind == 0 {
        return Ok(Err(MergePreviewResult::Blocked {
            blockers: vec![Blocker::NotFastForward],
        }));
    }
    Ok(Ok(DivergedPair {
        merge_base_oid: bases[0].clone(),
        ahead,
    }))
}

fn build_default_message(target_ref: &str, source_ref: &str) -> String {
    let short_target = target_ref.strip_prefix("refs/heads/").unwrap_or(target_ref);
    if let Some(remote_short) = source_ref.strip_prefix("refs/remotes/") {
        let remote_leaf = remote_short
            .split_once('/')
            .map(|(_, leaf)| leaf)
            .unwrap_or(remote_short);
        if remote_leaf == short_target {
            return format!("Merge remote-tracking branch '{remote_short}'");
        }
        return format!("Merge remote-tracking branch '{remote_short}' into {short_target}");
    }
    let short_source = source_ref.strip_prefix("refs/heads/").unwrap_or(source_ref);
    format!("Merge branch '{short_source}' into {short_target}")
}

fn both_sides_modified_count(
    i: &Inspector<'_>,
    merge_base_oid: &str,
    target_oid: &str,
    source_oid: &str,
) -> OperationResult<usize> {
    let target_raw = diff_tree_paths_raw(i, merge_base_oid, target_oid)?;
    let source_raw = diff_tree_paths_raw(i, merge_base_oid, source_oid)?;
    let target_paths: BTreeSet<&[u8]> = target_raw
        .split(|b| *b == 0)
        .filter(|path| !path.is_empty())
        .collect();
    let count = source_raw
        .split(|b| *b == 0)
        .filter(|path| !path.is_empty() && target_paths.contains(path))
        .count();
    Ok(count)
}

fn parse_merge_tree_output(stdout: &[u8]) -> OperationResult<ParsedMergeTree> {
    let records: Vec<&[u8]> = stdout.split(|b| *b == 0).collect();
    let Some(first) = records.first() else {
        return Err(operation_error(
            ErrorCode::GitError,
            "Git merge-tree 输出为空",
        ));
    };
    let partial_tree_oid = String::from_utf8_lossy(first).trim().to_owned();
    if partial_tree_oid.is_empty() {
        return Err(operation_error(
            ErrorCode::GitError,
            "Git merge-tree 未返回部分结果树",
        ));
    }

    let mut pos = 1usize;
    let mut stages: BTreeMap<Vec<u8>, StageSet> = BTreeMap::new();
    while pos < records.len() && !records[pos].is_empty() {
        let record = records[pos];
        pos += 1;
        let Some(tab) = record.iter().position(|b| *b == b'\t') else {
            return Err(operation_error(
                ErrorCode::GitError,
                "Git merge-tree 阶段条目格式无效",
            ));
        };
        let meta = std::str::from_utf8(&record[..tab]).map_err(|_| {
            operation_error(ErrorCode::GitError, "Git merge-tree 阶段元数据非 UTF-8")
        })?;
        let mut parts = meta.split_ascii_whitespace();
        let (Some(mode), Some(blob_oid), Some(stage), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(operation_error(
                ErrorCode::GitError,
                "Git merge-tree 阶段条目字段数量无效",
            ));
        };
        let entry = stages.entry(record[tab + 1..].to_vec()).or_default();
        match stage {
            "1" => entry.stage1 = Some((mode.to_owned(), blob_oid.to_owned())),
            "2" => entry.stage2 = Some((mode.to_owned(), blob_oid.to_owned())),
            "3" => entry.stage3 = Some((mode.to_owned(), blob_oid.to_owned())),
            _ => {
                return Err(operation_error(
                    ErrorCode::GitError,
                    "Git merge-tree 返回了未知阶段号",
                ));
            }
        }
    }

    if pos < records.len() && records[pos].is_empty() {
        pos += 1;
    }

    let mut messages = Vec::new();
    while pos < records.len() && !records[pos].is_empty() {
        let count_str = std::str::from_utf8(records[pos]).map_err(|_| {
            operation_error(ErrorCode::GitError, "Git merge-tree 冲突消息路径计数无效")
        })?;
        let path_count: usize = count_str.parse().map_err(|_| {
            operation_error(
                ErrorCode::GitError,
                "Git merge-tree 冲突消息路径计数解析失败",
            )
        })?;
        pos += 1;
        if pos.saturating_add(path_count).saturating_add(2) > records.len() {
            return Err(operation_error(
                ErrorCode::GitError,
                "Git merge-tree 冲突消息被截断",
            ));
        }
        let mut paths = Vec::with_capacity(path_count);
        for item in &records[pos..pos + path_count] {
            paths.push((*item).to_vec());
        }
        pos += path_count;
        let conflict_type = String::from_utf8_lossy(records[pos]).trim().to_owned();
        let human_message = String::from_utf8_lossy(records[pos + 1]).trim().to_owned();
        pos += 2;
        messages.push(MergeTreeMessage {
            paths,
            conflict_type,
            human_message,
        });
    }

    Ok(ParsedMergeTree {
        partial_tree_oid,
        stages,
        messages,
    })
}

fn check_structural_or_binary_conflict_messages(
    parsed: &ParsedMergeTree,
) -> Option<MergeInspection> {
    let mut unsupported_msgs = Vec::new();
    let mut binary_conflict = false;
    let mut conflict_path_bytes: BTreeSet<Vec<u8>> = BTreeSet::new();

    for msg in &parsed.messages {
        if !msg.conflict_type.starts_with("CONFLICT") {
            continue;
        }
        if msg.conflict_type != "CONFLICT (contents)" && msg.conflict_type != "CONFLICT (content)" {
            if msg.conflict_type.to_ascii_lowercase().contains("binary") {
                binary_conflict = true;
            }
            if !msg.human_message.is_empty() {
                unsupported_msgs.push(msg.human_message.clone());
            } else {
                unsupported_msgs.push(msg.conflict_type.clone());
            }
            for path in &msg.paths {
                conflict_path_bytes.insert(path.clone());
            }
        }
    }

    if unsupported_msgs.is_empty() {
        return None;
    }

    for path in parsed.stages.keys() {
        conflict_path_bytes.insert(path.clone());
    }
    let conflict_paths: Vec<GitPath> = conflict_path_bytes.into_iter().map(git_path).collect();
    Some(MergeInspection::Unsupported {
        reason: if binary_conflict {
            MergeUnsupportedReason::BinaryOrNonUtf8
        } else {
            MergeUnsupportedReason::StructuralConflict
        },
        message: unsupported_msgs.join("\n"),
        conflict_paths,
    })
}

#[allow(clippy::too_many_arguments)]
fn run_git_with_env(
    git: &ReadOnlyGit,
    cwd: &Path,
    args: &[&str],
    extra_env: &[(&OsStr, &OsStr)],
    input: Option<&[u8]>,
    stdout_limit: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> OperationResult<CommandOutput> {
    let os_args: Vec<OsString> = args.iter().map(string_arg).collect();
    git.run_with_env(
        cwd,
        &os_args,
        extra_env,
        input,
        stdout_limit,
        cancelled,
        deadline,
    )
    .map_err(from_git)
}

fn read_blob_checked(
    i: &Inspector<'_>,
    extra_env: &[(&OsStr, &OsStr)],
    oid: &str,
) -> OperationResult<Result<Vec<u8>, MergeUnsupportedReason>> {
    let size_out = run_git_with_env(
        &i.git,
        i.directory,
        &["cat-file", "-s", oid],
        extra_env,
        None,
        1024,
        i.cancelled,
        i.deadline,
    )?;
    if !size_out.status.success() {
        return Err(operation_error(
            ErrorCode::GitError,
            &super::combined_git_message(
                &size_out.stderr,
                &size_out.stdout,
                "读取冲突文件大小失败",
            ),
        ));
    }
    let size: usize = String::from_utf8_lossy(&size_out.stdout)
        .trim()
        .parse()
        .map_err(|_| operation_error(ErrorCode::GitError, "冲突文件大小格式无效"))?;
    if size > MAX_SINGLE_CONFLICT_BYTES {
        return Ok(Err(MergeUnsupportedReason::TooManyOrTooLarge));
    }
    let blob_out = run_git_with_env(
        &i.git,
        i.directory,
        &["cat-file", "blob", oid],
        extra_env,
        None,
        MAX_SINGLE_CONFLICT_BYTES + 1024,
        i.cancelled,
        i.deadline,
    )?;
    if !blob_out.status.success() {
        return Err(operation_error(
            ErrorCode::GitError,
            &super::combined_git_message(
                &blob_out.stderr,
                &blob_out.stdout,
                "读取冲突文件内容失败",
            ),
        ));
    }
    if blob_out.stdout.contains(&0) || std::str::from_utf8(&blob_out.stdout).is_err() {
        return Ok(Err(MergeUnsupportedReason::BinaryOrNonUtf8));
    }
    Ok(Ok(blob_out.stdout))
}

fn create_empty_blob_in_scratch(
    i: &Inspector<'_>,
    extra_env: &[(&OsStr, &OsStr)],
) -> OperationResult<String> {
    let out = run_git_with_env(
        &i.git,
        i.directory,
        &["hash-object", "-w", "--stdin"],
        extra_env,
        Some(b""),
        1024,
        i.cancelled,
        i.deadline,
    )?;
    if !out.status.success() {
        return Err(operation_error(
            ErrorCode::GitError,
            &super::combined_git_message(&out.stderr, &out.stdout, "创建临时空对象失败"),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn parse_hunk_side_pair(token: &str) -> OperationResult<(u32, u32)> {
    let trimmed = &token[1..];
    let (start_str, count_str) = match trimmed.split_once(',') {
        Some((s, c)) => (s, Some(c)),
        None => (trimmed, None),
    };
    let raw_start: u32 = start_str
        .parse()
        .map_err(|_| operation_error(ErrorCode::GitError, "解析 diff hunk 行号失败"))?;
    let count: u32 = match count_str {
        Some(c) => c
            .parse()
            .map_err(|_| operation_error(ErrorCode::GitError, "解析 diff hunk 行数失败"))?,
        None => 1,
    };
    let start = if count == 0 {
        raw_start
    } else {
        raw_start.saturating_sub(1)
    };
    Ok((start, count))
}

fn compute_diff_hunks(
    i: &Inspector<'_>,
    extra_env: &[(&OsStr, &OsStr)],
    base_oid: &str,
    side_oid: &str,
) -> OperationResult<Vec<MergeDiffHunk>> {
    if base_oid == side_oid {
        return Ok(Vec::new());
    }
    let out = run_git_with_env(
        &i.git,
        i.directory,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "-U0",
            base_oid,
            side_oid,
        ],
        extra_env,
        None,
        MERGE_WRITE_STDOUT_LIMIT,
        i.cancelled,
        i.deadline,
    )?;
    let code = out.status.code();
    if code != Some(0) && code != Some(1) {
        return Err(operation_error(
            ErrorCode::GitError,
            &super::combined_git_message(&out.stderr, &out.stdout, "计算三方 diff hunk 失败"),
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut hunks = Vec::new();
    for line in text.lines() {
        if !line.starts_with("@@ ") {
            continue;
        }
        let Some(end) = line[3..].find(" @@") else {
            continue;
        };
        let header = &line[3..3 + end];
        let mut parts = header.split_ascii_whitespace();
        let (Some(left), Some(right)) = (parts.next(), parts.next()) else {
            continue;
        };
        if !left.starts_with('-') || !right.starts_with('+') {
            continue;
        }
        let (base_start, base_count) = parse_hunk_side_pair(left)?;
        let (side_start, side_count) = parse_hunk_side_pair(right)?;
        hunks.push(MergeDiffHunk {
            base_start,
            base_count,
            side_start,
            side_count,
        });
    }
    Ok(hunks)
}

fn inspect_merge_in_scratch(
    i: &Inspector<'_>,
    session: &session::RepositorySession,
    spec: MergeTargetSpec<'_>,
    pair: &DivergedPair,
    read_conflict_contents: bool,
) -> OperationResult<MergeInspection> {
    let scratch = ScratchDir::new("preview")?;
    let scratch_objects = scratch.objects_dir()?;
    let repo_objects = Path::new(&session.discovered.info.common_dir).join("objects");
    let extra_env = [
        (
            OsStr::new("GIT_OBJECT_DIRECTORY"),
            scratch_objects.as_os_str(),
        ),
        (
            OsStr::new("GIT_ALTERNATE_OBJECT_DIRECTORIES"),
            repo_objects.as_os_str(),
        ),
    ];

    let default_message = build_default_message(spec.target_ref, spec.source_ref);
    let both_modified = both_sides_modified_count(
        i,
        &pair.merge_base_oid,
        spec.expected_target_oid,
        spec.expected_source_oid,
    )?;

    let mt_out = run_git_with_env(
        &i.git,
        i.directory,
        &[
            "merge-tree",
            "--write-tree",
            "-z",
            spec.expected_target_oid,
            spec.expected_source_oid,
        ],
        &extra_env,
        None,
        MERGE_WRITE_STDOUT_LIMIT,
        i.cancelled,
        i.deadline,
    )?;

    match mt_out.status.code() {
        Some(0) => {
            let mut can_single_commit_rebase = false;
            let mut single_commit_summary = None;
            if pair.ahead == 1 {
                let parents_line =
                    i.line(&["rev-list", "--parents", "-n", "1", spec.expected_target_oid])?;
                let tokens: Vec<_> = parents_line.split_ascii_whitespace().collect();
                if tokens.len() == 2
                    && tokens[0] == spec.expected_target_oid
                    && tokens[1] == pair.merge_base_oid
                {
                    let rebase_arg = format!("--merge-base={}", pair.merge_base_oid);
                    let rebase_out = run_git_with_env(
                        &i.git,
                        i.directory,
                        &[
                            "merge-tree",
                            "--write-tree",
                            "-z",
                            &rebase_arg,
                            spec.expected_source_oid,
                            spec.expected_target_oid,
                        ],
                        &extra_env,
                        None,
                        MERGE_WRITE_STDOUT_LIMIT,
                        i.cancelled,
                        i.deadline,
                    )?;
                    if rebase_out.status.code() == Some(0) {
                        can_single_commit_rebase = true;
                        single_commit_summary = Some(i.line(&[
                            "show",
                            "-s",
                            "--format=%s",
                            spec.expected_target_oid,
                        ])?);
                    }
                }
            }
            Ok(MergeInspection::Clean {
                merge_base_oid: pair.merge_base_oid.clone(),
                auto_merged_count: u32::try_from(both_modified).unwrap_or(u32::MAX),
                can_single_commit_rebase,
                single_commit_summary,
                default_message,
            })
        }
        Some(1) => {
            let parsed = parse_merge_tree_output(&mt_out.stdout)?;
            if let Some(unsupported) = check_structural_or_binary_conflict_messages(&parsed) {
                return Ok(unsupported);
            }
            let conflict_paths: Vec<GitPath> =
                parsed.stages.keys().cloned().map(git_path).collect();
            if parsed.stages.is_empty() {
                return Ok(MergeInspection::Unsupported {
                    reason: MergeUnsupportedReason::StructuralConflict,
                    message: "检测到非普通文本冲突，请交给 Agent 处理。".into(),
                    conflict_paths,
                });
            }
            if parsed.stages.len() > MAX_CONFLICT_FILES {
                return Ok(MergeInspection::Unsupported {
                    reason: MergeUnsupportedReason::TooManyOrTooLarge,
                    message: format!(
                        "共有 {} 个冲突文件（超过轻量合并上限 {MAX_CONFLICT_FILES} 个），请交给 Agent 处理。",
                        parsed.stages.len()
                    ),
                    conflict_paths,
                });
            }
            let auto_merged_count =
                u32::try_from(both_modified.saturating_sub(parsed.stages.len()))
                    .unwrap_or(u32::MAX);
            if !read_conflict_contents {
                let files = parsed
                    .stages
                    .into_iter()
                    .map(|(raw_path, stages)| {
                        let (_, mode) = match (stages.stage2, stages.stage3) {
                            (Some((m2, _)), Some((m3, _))) if m2 == m3 => (m2.clone(), m2),
                            _ => {
                                return Err(MergeUnsupportedReason::StructuralConflict);
                            }
                        };
                        Ok(MergeConflictFile {
                            path: git_path(raw_path),
                            mode,
                            base_text: String::new(),
                            ours_text: String::new(),
                            theirs_text: String::new(),
                            left_hunks: Vec::new(),
                            right_hunks: Vec::new(),
                        })
                    })
                    .collect::<Result<Vec<_>, MergeUnsupportedReason>>();
                return match files {
                    Ok(files) => Ok(MergeInspection::Conflicted {
                        merge_base_oid: pair.merge_base_oid.clone(),
                        auto_merged_count,
                        default_message,
                        files,
                    }),
                    Err(reason) => Ok(MergeInspection::Unsupported {
                        reason,
                        message: "存在结构性冲突（非双方普通文件），请交给 Agent 处理。".into(),
                        conflict_paths,
                    }),
                };
            }

            let mut empty_blob_oid: Option<String> = None;
            let mut total_bytes = 0usize;
            let mut files = Vec::with_capacity(parsed.stages.len());

            for (raw_path, stages) in parsed.stages {
                let path_obj = git_path(raw_path.clone());
                if path_obj.text_lossy {
                    return Ok(MergeInspection::Unsupported {
                        reason: MergeUnsupportedReason::BinaryOrNonUtf8,
                        message: format!(
                            "冲突路径 `{}` 不是有效 UTF-8，请交给 Agent 处理。",
                            path_obj.display
                        ),
                        conflict_paths,
                    });
                }
                let (Some((ours_mode, ours_oid)), Some((theirs_mode, theirs_oid))) =
                    (stages.stage2.as_ref(), stages.stage3.as_ref())
                else {
                    return Ok(MergeInspection::Unsupported {
                        reason: MergeUnsupportedReason::StructuralConflict,
                        message: format!(
                            "`{}` 属于删除/修改冲突或非双边普通文件，请交给 Agent 处理。",
                            path_obj.display
                        ),
                        conflict_paths,
                    });
                };
                if ours_mode != theirs_mode
                    || (ours_mode != "100644" && ours_mode != "100755")
                    || stages
                        .stage1
                        .as_ref()
                        .is_some_and(|(m, _)| m != "100644" && m != "100755")
                {
                    return Ok(MergeInspection::Unsupported {
                        reason: MergeUnsupportedReason::StructuralConflict,
                        message: format!(
                            "`{}` 文件权限模式不一致或包含子模块/符号链接冲突，请交给 Agent 处理。",
                            path_obj.display
                        ),
                        conflict_paths,
                    });
                }

                let (base_oid, base_bytes) = match &stages.stage1 {
                    Some((_, oid)) => match read_blob_checked(i, &extra_env, oid)? {
                        Ok(bytes) => (oid.clone(), bytes),
                        Err(reason) => {
                            let message = unsupported_reason_text(&reason, &path_obj.display);
                            return Ok(MergeInspection::Unsupported {
                                reason,
                                message,
                                conflict_paths,
                            });
                        }
                    },
                    None => {
                        let empty_oid = match &empty_blob_oid {
                            Some(oid) => oid.clone(),
                            None => {
                                let oid = create_empty_blob_in_scratch(i, &extra_env)?;
                                empty_blob_oid = Some(oid.clone());
                                oid
                            }
                        };
                        (empty_oid, Vec::new())
                    }
                };
                let ours_bytes = match read_blob_checked(i, &extra_env, ours_oid)? {
                    Ok(bytes) => bytes,
                    Err(reason) => {
                        let message = unsupported_reason_text(&reason, &path_obj.display);
                        return Ok(MergeInspection::Unsupported {
                            reason,
                            message,
                            conflict_paths,
                        });
                    }
                };
                let theirs_bytes = match read_blob_checked(i, &extra_env, theirs_oid)? {
                    Ok(bytes) => bytes,
                    Err(reason) => {
                        let message = unsupported_reason_text(&reason, &path_obj.display);
                        return Ok(MergeInspection::Unsupported {
                            reason,
                            message,
                            conflict_paths,
                        });
                    }
                };

                total_bytes = total_bytes
                    .saturating_add(base_bytes.len())
                    .saturating_add(ours_bytes.len())
                    .saturating_add(theirs_bytes.len());
                if total_bytes > MAX_TOTAL_CONFLICT_BYTES {
                    return Ok(MergeInspection::Unsupported {
                        reason: MergeUnsupportedReason::TooManyOrTooLarge,
                        message: "冲突文件总体积超过轻量合并上限（512 KiB），请交给 Agent 处理。"
                            .into(),
                        conflict_paths,
                    });
                }

                let left_hunks = compute_diff_hunks(i, &extra_env, &base_oid, ours_oid)?;
                let right_hunks = compute_diff_hunks(i, &extra_env, &base_oid, theirs_oid)?;

                files.push(MergeConflictFile {
                    path: path_obj,
                    mode: ours_mode.clone(),
                    base_text: String::from_utf8(base_bytes).expect("validated UTF-8"),
                    ours_text: String::from_utf8(ours_bytes).expect("validated UTF-8"),
                    theirs_text: String::from_utf8(theirs_bytes).expect("validated UTF-8"),
                    left_hunks,
                    right_hunks,
                });
            }

            Ok(MergeInspection::Conflicted {
                merge_base_oid: pair.merge_base_oid.clone(),
                auto_merged_count,
                default_message,
                files,
            })
        }
        _ => Err(operation_error(
            ErrorCode::GitError,
            &super::combined_git_message(&mt_out.stderr, &mt_out.stdout, "合并预演失败"),
        )),
    }
}

fn unsupported_reason_text(reason: &MergeUnsupportedReason, display_path: &str) -> String {
    match reason {
        MergeUnsupportedReason::BinaryOrNonUtf8 => {
            format!("`{display_path}` 是二进制或非 UTF-8 文件，请交给 Agent 处理。")
        }
        MergeUnsupportedReason::TooManyOrTooLarge => {
            format!("`{display_path}` 体积超过单文件上限（128 KiB），请交给 Agent 处理。")
        }
        MergeUnsupportedReason::StructuralConflict => {
            format!("`{display_path}` 存在结构性冲突，请交给 Agent 处理。")
        }
        MergeUnsupportedReason::CrissCross => {
            "存在多个共同祖先（criss-cross 合并），请交给 Agent 处理。".into()
        }
        MergeUnsupportedReason::UnrelatedHistories => {
            "两个分支没有共同祖先，请交给 Agent 处理。".into()
        }
    }
}

pub fn preview_merge(
    executable: &Path,
    session: &session::RepositorySession,
    params: &PreviewMergeParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> OperationResult<MergePreviewResult> {
    let i = Inspector {
        git: ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?,
        directory: Path::new(&session.discovered.info.path),
        cancelled,
        deadline,
    };
    let spec = MergeTargetSpec {
        target_ref: &params.target_ref,
        expected_target_oid: &params.expected_target_oid,
        source_ref: &params.source_ref,
        expected_source_oid: &params.expected_source_oid,
        expected_head_oid: None,
        switch_to_target: false,
    };
    let pre = preflight(&i, spec, session.discovered.oid_length)?;
    if !pre.blockers.is_empty() {
        return Ok(MergePreviewResult::Blocked {
            blockers: pre.blockers,
        });
    }
    let pair = match analyze_diverged_pair(
        &i,
        &params.expected_target_oid,
        &params.expected_source_oid,
    )? {
        Ok(pair) => pair,
        Err(result) => return Ok(result),
    };
    match inspect_merge_in_scratch(&i, session, spec, &pair, true)? {
        MergeInspection::Clean {
            merge_base_oid,
            auto_merged_count,
            can_single_commit_rebase,
            single_commit_summary,
            default_message,
        } => Ok(MergePreviewResult::Clean {
            merge_base_oid,
            auto_merged_count,
            can_single_commit_rebase,
            single_commit_summary,
            default_message,
        }),
        MergeInspection::Conflicted {
            merge_base_oid,
            auto_merged_count,
            default_message,
            files,
        } => Ok(MergePreviewResult::Conflicted {
            merge_base_oid,
            auto_merged_count,
            default_message,
            files,
        }),
        MergeInspection::Unsupported {
            reason,
            message,
            conflict_paths,
        } => Ok(MergePreviewResult::Unsupported {
            reason,
            message,
            conflict_paths,
        }),
    }
}

struct CompleteMergeArgs<'a> {
    target_ref: &'a str,
    expected_target_oid: &'a str,
    source_ref: &'a str,
    expected_source_oid: &'a str,
    expected_head_oid: Option<&'a str>,
    mode: MergeSyncMode,
    message: &'a str,
    resolved_files: &'a [ResolvedMergeFile],
    switch_to_target: bool,
}

fn validate_resolved_files(
    directory: &Path,
    mode: MergeSyncMode,
    message: &str,
    resolved_files: &[ResolvedMergeFile],
) -> OperationResult<Vec<(Vec<u8>, String, String)>> {
    if message.trim().is_empty()
        || message.len() > MAX_COMMIT_MESSAGE_BYTES
        || message.contains('\0')
    {
        return Err(invalid("请输入有效的提交说明"));
    }
    if resolved_files.len() > MAX_CONFLICT_FILES {
        return Err(invalid("冲突解决文件数量超出上限"));
    }
    if mode == MergeSyncMode::SingleCommitRebase && !resolved_files.is_empty() {
        return Err(invalid("单提交变基模式不支持附加冲突解决文件"));
    }
    let mut total = 0usize;
    let mut seen_paths = BTreeSet::new();
    let mut validated = Vec::with_capacity(resolved_files.len());
    for file in resolved_files {
        let raw_path = validate_workspace_path_hex(directory, &file.path_hex)?;
        if std::str::from_utf8(&raw_path).is_err() {
            return Err(invalid("冲突路径必须是有效 UTF-8"));
        }
        if !seen_paths.insert(raw_path.clone()) {
            return Err(invalid("冲突解决文件列表包含重复路径"));
        }
        if file.mode != "100644" && file.mode != "100755" {
            return Err(invalid("文件权限模式无效"));
        }
        if file.contents.contains('\0') {
            return Err(invalid("冲突解决内容不能包含 NUL 字节"));
        }
        total = total.saturating_add(file.contents.len());
        if total > MAX_TOTAL_CONFLICT_BYTES {
            return Err(invalid("冲突解决内容总大小超出上限"));
        }
        validated.push((raw_path, file.mode.clone(), file.contents.clone()));
    }
    Ok(validated)
}

pub(super) fn check_complete_merge(
    session: &session::RepositorySession,
    i: &Inspector<'_>,
    args: &super::Operation,
    oid_length: usize,
) -> OperationResult<OperationCheck> {
    let super::Operation::CompleteMerge {
        target_ref,
        expected_target_oid,
        source_ref,
        expected_source_oid,
        expected_head_oid,
        mode,
        message,
        resolved_files,
        switch_to_target,
    } = args
    else {
        unreachable!("check_complete_merge called with non-CompleteMerge operation");
    };

    let validated = validate_resolved_files(i.directory, *mode, message, resolved_files)?;
    let spec = MergeTargetSpec {
        target_ref,
        expected_target_oid,
        source_ref,
        expected_source_oid,
        expected_head_oid: expected_head_oid.as_deref(),
        switch_to_target: *switch_to_target,
    };
    let pre = preflight(i, spec, oid_length)?;
    if !pre.blockers.is_empty() {
        return Ok(OperationCheck {
            allowed: false,
            blockers: pre.blockers,
            preserved_dirty_count: pre.preserved_dirty_count,
            identical_untracked_count: 0,
        });
    }

    let pair = match analyze_diverged_pair(i, expected_target_oid, expected_source_oid)? {
        Ok(pair) => pair,
        Err(MergePreviewResult::Blocked { blockers }) => {
            return Ok(OperationCheck {
                allowed: false,
                blockers,
                preserved_dirty_count: pre.preserved_dirty_count,
                identical_untracked_count: 0,
            });
        }
        Err(MergePreviewResult::Unsupported { message, .. }) => {
            return Ok(OperationCheck {
                allowed: false,
                blockers: vec![Blocker::UnsafeState { message }],
                preserved_dirty_count: pre.preserved_dirty_count,
                identical_untracked_count: 0,
            });
        }
        Err(_) => unreachable!(),
    };

    match inspect_merge_in_scratch(i, session, spec, &pair, false)? {
        MergeInspection::Clean {
            can_single_commit_rebase,
            ..
        } => {
            if *mode == MergeSyncMode::SingleCommitRebase && !can_single_commit_rebase {
                return Ok(OperationCheck {
                    allowed: false,
                    blockers: vec![Blocker::UnsafeState {
                        message: "该分叉不满足单提交无冲突线性变基条件".into(),
                    }],
                    preserved_dirty_count: pre.preserved_dirty_count,
                    identical_untracked_count: 0,
                });
            }
            if !validated.is_empty() {
                return Err(invalid("无冲突分叉不应附带冲突解决文件"));
            }
        }
        MergeInspection::Conflicted { files, .. } => {
            if *mode == MergeSyncMode::SingleCommitRebase {
                return Ok(OperationCheck {
                    allowed: false,
                    blockers: vec![Blocker::UnsafeState {
                        message: "存在文本冲突，不能执行无冲突单提交变基".into(),
                    }],
                    preserved_dirty_count: pre.preserved_dirty_count,
                    identical_untracked_count: 0,
                });
            }
            let expected_paths: BTreeSet<Vec<u8>> = files
                .into_iter()
                .map(|file| super::decode_hex(&file.path.raw_hex))
                .collect();
            let provided_paths: BTreeSet<Vec<u8>> =
                validated.into_iter().map(|(raw, _, _)| raw).collect();
            if expected_paths != provided_paths {
                return Err(invalid("提交的已解决文件列表与当前冲突文件集合不一致"));
            }
        }
        MergeInspection::Unsupported { message, .. } => {
            return Ok(OperationCheck {
                allowed: false,
                blockers: vec![Blocker::UnsafeState { message }],
                preserved_dirty_count: pre.preserved_dirty_count,
                identical_untracked_count: 0,
            });
        }
    }

    Ok(OperationCheck {
        allowed: true,
        blockers: Vec::new(),
        preserved_dirty_count: pre.preserved_dirty_count,
        identical_untracked_count: 0,
    })
}

pub(super) fn run_complete_merge(
    executable: &Path,
    session: &session::RepositorySession,
    i: &Inspector<'_>,
    args: &super::Operation,
    oid_length: usize,
    cancelled: &AtomicBool,
) -> OperationResult<OperationRun> {
    let super::Operation::CompleteMerge {
        target_ref,
        expected_target_oid,
        source_ref,
        expected_source_oid,
        expected_head_oid,
        mode,
        message,
        resolved_files,
        switch_to_target,
    } = args
    else {
        unreachable!("run_complete_merge called with non-CompleteMerge operation");
    };

    run_complete_merge_inner(
        executable,
        session,
        i,
        CompleteMergeArgs {
            target_ref,
            expected_target_oid,
            source_ref,
            expected_source_oid,
            expected_head_oid: expected_head_oid.as_deref(),
            mode: *mode,
            message,
            resolved_files,
            switch_to_target: *switch_to_target,
        },
        oid_length,
        cancelled,
    )
}

fn run_complete_merge_inner(
    executable: &Path,
    session: &session::RepositorySession,
    i: &Inspector<'_>,
    args: CompleteMergeArgs<'_>,
    oid_length: usize,
    cancelled: &AtomicBool,
) -> OperationResult<OperationRun> {
    let validated =
        validate_resolved_files(i.directory, args.mode, args.message, args.resolved_files)?;
    let spec = MergeTargetSpec {
        target_ref: args.target_ref,
        expected_target_oid: args.expected_target_oid,
        source_ref: args.source_ref,
        expected_source_oid: args.expected_source_oid,
        expected_head_oid: args.expected_head_oid,
        switch_to_target: args.switch_to_target,
    };
    let pre = preflight(i, spec, oid_length)?;
    if !pre.blockers.is_empty() {
        return Ok(OperationRun::Rejected {
            blockers: pre.blockers,
        });
    }
    let pair = match analyze_diverged_pair(i, args.expected_target_oid, args.expected_source_oid)? {
        Ok(pair) => pair,
        Err(MergePreviewResult::Blocked { blockers }) => {
            return Ok(OperationRun::Rejected { blockers });
        }
        Err(MergePreviewResult::Unsupported { message, .. }) => {
            return Ok(OperationRun::Rejected {
                blockers: vec![Blocker::UnsafeState { message }],
            });
        }
        Err(_) => unreachable!(),
    };
    let inspection = inspect_merge_in_scratch(i, session, spec, &pair, false)?;

    match &inspection {
        MergeInspection::Clean {
            can_single_commit_rebase,
            ..
        } => {
            if args.mode == MergeSyncMode::SingleCommitRebase && !*can_single_commit_rebase {
                return Ok(OperationRun::Rejected {
                    blockers: vec![Blocker::UnsafeState {
                        message: "该分叉不满足单提交无冲突线性变基条件".into(),
                    }],
                });
            }
            if !validated.is_empty() {
                return Err(invalid("无冲突分叉不应附带冲突解决文件"));
            }
        }
        MergeInspection::Conflicted { files, .. } => {
            if args.mode == MergeSyncMode::SingleCommitRebase {
                return Ok(OperationRun::Rejected {
                    blockers: vec![Blocker::UnsafeState {
                        message: "存在文本冲突，不能执行无冲突单提交变基".into(),
                    }],
                });
            }
            let expected_paths: BTreeSet<Vec<u8>> = files
                .iter()
                .map(|file| super::decode_hex(&file.path.raw_hex))
                .collect();
            let provided_paths: BTreeSet<Vec<u8>> =
                validated.iter().map(|(raw, _, _)| raw.clone()).collect();
            if expected_paths != provided_paths {
                return Err(invalid("提交的已解决文件列表与当前冲突文件集合不一致"));
            }
        }
        MergeInspection::Unsupported { message, .. } => {
            return Ok(OperationRun::Rejected {
                blockers: vec![Blocker::UnsafeState {
                    message: message.clone(),
                }],
            });
        }
    }

    if cancelled.load(Ordering::Acquire) {
        return Err(from_git(GitFailure::Cancelled));
    }

    let uncancellable = AtomicBool::new(false);
    let write_deadline = Instant::now() + Duration::from_secs(120);
    let op_git = i.git.for_operation();

    let (new_commit_oid, reflog_reason) = match args.mode {
        MergeSyncMode::SingleCommitRebase => {
            let rebase_arg = format!("--merge-base={}", pair.merge_base_oid);
            let mt_out = run_git_with_env(
                &op_git,
                i.directory,
                &[
                    "merge-tree",
                    "--write-tree",
                    "-z",
                    &rebase_arg,
                    args.expected_source_oid,
                    args.expected_target_oid,
                ],
                &[],
                None,
                MERGE_WRITE_STDOUT_LIMIT,
                &uncancellable,
                write_deadline,
            )?;
            if mt_out.status.code() != Some(0) {
                return Err(operation_error(
                    ErrorCode::GitError,
                    &super::combined_git_message(
                        &mt_out.stderr,
                        &mt_out.stdout,
                        "构建单提交变基树失败",
                    ),
                ));
            }
            let final_tree_oid =
                String::from_utf8_lossy(mt_out.stdout.split(|b| *b == 0).next().unwrap_or(&[]))
                    .trim()
                    .to_owned();
            if final_tree_oid.is_empty() {
                return Err(operation_error(
                    ErrorCode::GitError,
                    "构建单提交变基树失败：未返回树对象",
                ));
            }

            let author_out = run_git_with_env(
                &op_git,
                i.directory,
                &[
                    "show",
                    "-s",
                    "--format=%an%x00%ae%x00%ad%x00%s%x00%B",
                    "--date=raw",
                    args.expected_target_oid,
                ],
                &[],
                None,
                128 * 1024,
                &uncancellable,
                write_deadline,
            )?;
            if !author_out.status.success() {
                return Err(operation_error(
                    ErrorCode::GitError,
                    &super::combined_git_message(
                        &author_out.stderr,
                        &author_out.stdout,
                        "读取原提交作者信息失败",
                    ),
                ));
            }
            let parts: Vec<&[u8]> = author_out.stdout.splitn(5, |b| *b == 0).collect();
            if parts.len() != 5 {
                return Err(operation_error(
                    ErrorCode::GitError,
                    "解析原提交作者信息失败",
                ));
            }
            let author_name = String::from_utf8_lossy(parts[0]).into_owned();
            let author_email = String::from_utf8_lossy(parts[1]).into_owned();
            let author_date = String::from_utf8_lossy(parts[2]).into_owned();
            let orig_summary = String::from_utf8_lossy(parts[3]).into_owned();
            let orig_body = String::from_utf8_lossy(parts[4]).into_owned();
            let commit_message = if args.message.trim() == orig_summary.trim() {
                orig_body
            } else {
                args.message.to_owned()
            };

            let commit_out = run_git_with_env(
                &op_git,
                i.directory,
                &[
                    "commit-tree",
                    &final_tree_oid,
                    "-p",
                    args.expected_source_oid,
                ],
                &[
                    (OsStr::new("GIT_AUTHOR_NAME"), OsStr::new(&author_name)),
                    (OsStr::new("GIT_AUTHOR_EMAIL"), OsStr::new(&author_email)),
                    (OsStr::new("GIT_AUTHOR_DATE"), OsStr::new(&author_date)),
                ],
                Some(commit_message.as_bytes()),
                4096,
                &uncancellable,
                write_deadline,
            )?;
            if !commit_out.status.success() {
                return Err(operation_error(
                    ErrorCode::GitError,
                    &super::combined_git_message(
                        &commit_out.stderr,
                        &commit_out.stdout,
                        "创建变基提交失败",
                    ),
                ));
            }
            let oid = String::from_utf8_lossy(&commit_out.stdout)
                .trim()
                .to_owned();
            (
                oid,
                format!("rebase (single commit) onto {}", args.source_ref),
            )
        }
        MergeSyncMode::MergeCommit => {
            let mt_out = run_git_with_env(
                &op_git,
                i.directory,
                &[
                    "merge-tree",
                    "--write-tree",
                    "-z",
                    args.expected_target_oid,
                    args.expected_source_oid,
                ],
                &[],
                None,
                MERGE_WRITE_STDOUT_LIMIT,
                &uncancellable,
                write_deadline,
            )?;
            let final_tree_oid = match mt_out.status.code() {
                Some(0) => {
                    if !validated.is_empty() {
                        return Err(invalid("无冲突合并不应附带解决文件"));
                    }
                    let tree = String::from_utf8_lossy(
                        mt_out.stdout.split(|b| *b == 0).next().unwrap_or(&[]),
                    )
                    .trim()
                    .to_owned();
                    if tree.is_empty() {
                        return Err(operation_error(
                            ErrorCode::GitError,
                            "merge-tree 未返回结果树",
                        ));
                    }
                    tree
                }
                Some(1) => {
                    let parsed = parse_merge_tree_output(&mt_out.stdout)?;
                    if let Some(MergeInspection::Unsupported { message, .. }) =
                        check_structural_or_binary_conflict_messages(&parsed)
                    {
                        return Err(operation_error(ErrorCode::GitError, &message));
                    }
                    let scratch = ScratchDir::new("index")?;
                    let index_file = scratch.0.join("temp.index");
                    let idx_env = [(OsStr::new("GIT_INDEX_FILE"), index_file.as_os_str())];
                    let read_tree_out = run_git_with_env(
                        &op_git,
                        i.directory,
                        &["read-tree", &parsed.partial_tree_oid],
                        &idx_env,
                        None,
                        4096,
                        &uncancellable,
                        write_deadline,
                    )?;
                    if !read_tree_out.status.success() {
                        return Err(operation_error(
                            ErrorCode::GitError,
                            &super::combined_git_message(
                                &read_tree_out.stderr,
                                &read_tree_out.stdout,
                                "初始化临时合并索引失败",
                            ),
                        ));
                    }

                    let mut index_info = Vec::new();
                    for (raw_path, mode, contents) in &validated {
                        let hash_out = run_git_with_env(
                            &op_git,
                            i.directory,
                            &["hash-object", "-w", "--stdin"],
                            &[],
                            Some(contents.as_bytes()),
                            4096,
                            &uncancellable,
                            write_deadline,
                        )?;
                        if !hash_out.status.success() {
                            return Err(operation_error(
                                ErrorCode::GitError,
                                &super::combined_git_message(
                                    &hash_out.stderr,
                                    &hash_out.stdout,
                                    "写入解决后文件内容失败",
                                ),
                            ));
                        }
                        let blob_oid = String::from_utf8_lossy(&hash_out.stdout).trim().to_owned();
                        index_info.extend_from_slice(mode.as_bytes());
                        index_info.extend_from_slice(b" blob ");
                        index_info.extend_from_slice(blob_oid.as_bytes());
                        index_info.push(b'\t');
                        index_info.extend_from_slice(raw_path);
                        index_info.push(0);
                    }
                    let upd_out = run_git_with_env(
                        &op_git,
                        i.directory,
                        &["update-index", "-z", "--index-info"],
                        &idx_env,
                        Some(&index_info),
                        4096,
                        &uncancellable,
                        write_deadline,
                    )?;
                    if !upd_out.status.success() {
                        return Err(operation_error(
                            ErrorCode::GitError,
                            &super::combined_git_message(
                                &upd_out.stderr,
                                &upd_out.stdout,
                                "更新临时合并索引失败",
                            ),
                        ));
                    }
                    let wt_out = run_git_with_env(
                        &op_git,
                        i.directory,
                        &["write-tree"],
                        &idx_env,
                        None,
                        4096,
                        &uncancellable,
                        write_deadline,
                    )?;
                    if !wt_out.status.success() {
                        return Err(operation_error(
                            ErrorCode::GitError,
                            &super::combined_git_message(
                                &wt_out.stderr,
                                &wt_out.stdout,
                                "写入合并树对象失败",
                            ),
                        ));
                    }
                    String::from_utf8_lossy(&wt_out.stdout).trim().to_owned()
                }
                _ => {
                    return Err(operation_error(
                        ErrorCode::GitError,
                        &super::combined_git_message(
                            &mt_out.stderr,
                            &mt_out.stdout,
                            "执行合入计算失败",
                        ),
                    ));
                }
            };

            let commit_out = run_git_with_env(
                &op_git,
                i.directory,
                &[
                    "commit-tree",
                    &final_tree_oid,
                    "-p",
                    args.expected_target_oid,
                    "-p",
                    args.expected_source_oid,
                ],
                &[],
                Some(args.message.as_bytes()),
                4096,
                &uncancellable,
                write_deadline,
            )?;
            if !commit_out.status.success() {
                return Err(operation_error(
                    ErrorCode::GitError,
                    &super::combined_git_message(
                        &commit_out.stderr,
                        &commit_out.stdout,
                        "创建合并提交失败",
                    ),
                ));
            }
            let oid = String::from_utf8_lossy(&commit_out.stdout)
                .trim()
                .to_owned();
            (oid, format!("merge {}", args.source_ref))
        }
    };

    let target_is_head = pre.head_ref.as_deref() == Some(args.target_ref);
    if target_is_head {
        let rt_out = run_git_with_env(
            &op_git,
            i.directory,
            &[
                "read-tree",
                "-m",
                "-u",
                args.expected_target_oid,
                &new_commit_oid,
            ],
            &[],
            None,
            64 * 1024,
            &uncancellable,
            write_deadline,
        )?;
        if !rt_out.status.success() {
            return Err(operation_error(
                ErrorCode::GitError,
                &super::combined_git_message(
                    &rt_out.stderr,
                    &rt_out.stdout,
                    "更新工作区到新提交失败",
                ),
            ));
        }

        let ur_out = run_git_with_env(
            &op_git,
            i.directory,
            &[
                "update-ref",
                "-m",
                &reflog_reason,
                args.target_ref,
                &new_commit_oid,
                args.expected_target_oid,
            ],
            &[],
            None,
            64 * 1024,
            &uncancellable,
            write_deadline,
        )?;
        if !ur_out.status.success() {
            let _ = run_git_with_env(
                &op_git,
                i.directory,
                &[
                    "read-tree",
                    "-m",
                    "-u",
                    &new_commit_oid,
                    args.expected_target_oid,
                ],
                &[],
                None,
                64 * 1024,
                &uncancellable,
                write_deadline,
            );
            return Err(operation_error(
                ErrorCode::GitError,
                &super::combined_git_message(
                    &ur_out.stderr,
                    &ur_out.stdout,
                    "推进当前分支引用失败",
                ),
            ));
        }
    } else {
        let ur_out = run_git_with_env(
            &op_git,
            i.directory,
            &[
                "update-ref",
                "-m",
                &reflog_reason,
                args.target_ref,
                &new_commit_oid,
                args.expected_target_oid,
            ],
            &[],
            None,
            64 * 1024,
            &uncancellable,
            write_deadline,
        )?;
        if !ur_out.status.success() {
            return Err(operation_error(
                ErrorCode::GitError,
                &super::combined_git_message(
                    &ur_out.stderr,
                    &ur_out.stdout,
                    "推进目标分支引用失败",
                ),
            ));
        }
        if args.switch_to_target {
            let short_target = &args.target_ref["refs/heads/".len()..];
            let sw_out = run_git_with_env(
                &op_git,
                i.directory,
                &[
                    "switch",
                    "--no-guess",
                    "--no-overwrite-ignore",
                    "--no-recurse-submodules",
                    "--",
                    short_target,
                ],
                &[],
                None,
                64 * 1024,
                &uncancellable,
                write_deadline,
            )?;
            if !sw_out.status.success() {
                return Err(operation_error(
                    ErrorCode::GitError,
                    &super::combined_git_message(
                        &sw_out.stderr,
                        &sw_out.stdout,
                        "切换到目标分支失败",
                    ),
                ));
            }
        }
    }

    let recovery_inspector = Inspector {
        git: ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?,
        directory: i.directory,
        cancelled: &uncancellable,
        deadline: Instant::now() + Duration::from_secs(30),
    };
    let head_oid = recovery_inspector.oid("HEAD")?;
    let head_reference = recovery_inspector.head_reference()?;
    let (added_count, added_min_unix, added_max_unix) = super::measure_added_range(
        executable,
        i.directory,
        oid_length,
        args.expected_target_oid,
        &new_commit_oid,
    );
    Ok(OperationRun::Done {
        head_oid,
        head_reference,
        updated_ref: Some(UpdatedRef {
            ref_name: args.target_ref.to_owned(),
            old_oid: Some(args.expected_target_oid.to_owned()),
            new_oid: new_commit_oid.clone(),
        }),
        untracked: None,
        committed_oid: Some(new_commit_oid),
        added_count,
        added_min_unix,
        added_max_unix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository;
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
            .expect("Git is available for merge unit tests")
    }

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "commitscope-merge-unit-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    fn run_git(repo: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new(git_bin())
            .arg("-C")
            .arg(repo)
            .args([
                "-c",
                "user.name=Default Committer",
                "-c",
                "user.email=committer@example.invalid",
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

    fn open_session(repo: &Path) -> session::RepositorySession {
        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(30);
        let discovered = repository::discover_repository(
            &git_bin(),
            repo.to_str().unwrap(),
            &cancelled,
            deadline,
        )
        .unwrap();
        let mut manager =
            crate::session::SessionManager::new(crate::session_store::SessionStore::from_env());
        let intent = manager.begin_open(std::sync::Arc::new(AtomicBool::new(false)));
        let committed = manager
            .commit_open(intent, &cancelled, std::sync::Arc::new(discovered))
            .unwrap();
        (*committed.session).clone()
    }

    fn list_objects(repo: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let obj_root = repo.join(".git/objects");
        if let Ok(entries) = std::fs::read_dir(&obj_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if let Ok(sub) = std::fs::read_dir(&path) {
                        for item in sub.flatten() {
                            out.push(item.path());
                        }
                    }
                } else {
                    out.push(path);
                }
            }
        }
        out.sort();
        out
    }

    #[test]
    fn preview_is_zero_write_and_clean_single_commit_rebase_preserves_author() {
        let root = temp_root("clean-rebase");
        let _guard = TestDir(root.clone());
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "--quiet", "-b", "main"]);
        std::fs::write(repo.join("base.txt"), "base\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "--quiet", "-m", "base"]);

        run_git(&repo, &["branch", "topic"]);
        std::fs::write(repo.join("local.txt"), "local work\n").unwrap();
        run_git(&repo, &["add", "."]);
        let mut local_cmd = std::process::Command::new(git_bin());
        local_cmd.arg("-C").arg(&repo).args([
            "-c",
            "user.name=Local Author",
            "-c",
            "user.email=author@example.invalid",
            "commit",
            "--quiet",
            "--date=1700001234 +0800",
            "-m",
            "feat: preserve my author\n\nDetailed body line.\n",
        ]);
        assert!(local_cmd.status().unwrap().success());
        let main_oid = run_git(&repo, &["rev-parse", "refs/heads/main"]);

        run_git(&repo, &["checkout", "--quiet", "topic"]);
        std::fs::write(repo.join("topic.txt"), "topic work\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "--quiet", "-m", "topic commit"]);
        let topic_oid = run_git(&repo, &["rev-parse", "refs/heads/topic"]);
        run_git(&repo, &["checkout", "--quiet", "main"]);

        let objects_before = list_objects(&repo);
        let session = open_session(&repo);
        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(30);

        let preview = preview_merge(
            &git_bin(),
            &session,
            &PreviewMergeParams {
                target_ref: "refs/heads/main".into(),
                expected_target_oid: main_oid.clone(),
                source_ref: "refs/heads/topic".into(),
                expected_source_oid: topic_oid.clone(),
            },
            &cancelled,
            deadline,
        )
        .unwrap();
        let objects_after = list_objects(&repo);
        assert_eq!(objects_before, objects_after);

        match preview {
            MergePreviewResult::Clean {
                can_single_commit_rebase,
                single_commit_summary,
                ..
            } => {
                assert!(can_single_commit_rebase);
                assert_eq!(
                    single_commit_summary.as_deref(),
                    Some("feat: preserve my author")
                );
            }
            other => panic!("expected Clean preview, got {other:?}"),
        }

        let op = commitscope_core::RepositoryOperation::CompleteMerge {
            target_ref: "refs/heads/main".into(),
            expected_target_oid: main_oid.clone(),
            source_ref: "refs/heads/topic".into(),
            expected_source_oid: topic_oid.clone(),
            expected_head_oid: Some(main_oid),
            mode: MergeSyncMode::SingleCommitRebase,
            message: "feat: preserve my author".into(),
            resolved_files: Vec::new(),
            switch_to_target: false,
        };
        let inspector = Inspector {
            git: ReadOnlyGit::new(git_bin()).unwrap(),
            directory: &repo,
            cancelled: &cancelled,
            deadline,
        };
        let check = check_complete_merge(&session, &inspector, &op, 40).unwrap();
        assert!(check.allowed);
        let done =
            run_complete_merge(&git_bin(), &session, &inspector, &op, 40, &cancelled).unwrap();
        assert!(matches!(done, OperationRun::Done { .. }));
        assert_eq!(run_git(&repo, &["rev-parse", "HEAD^"]), topic_oid);
        assert_eq!(
            run_git(
                &repo,
                &[
                    "show",
                    "-s",
                    "--format=%an|%ae|%ad|%B",
                    "--date=raw",
                    "HEAD"
                ]
            )
            .trim(),
            "Local Author|author@example.invalid|1700001234 +0800|feat: preserve my author\n\nDetailed body line."
        );
        assert!(run_git(&repo, &["status", "--porcelain"]).is_empty());
    }

    #[test]
    fn conflicted_merge_commit_handles_content_and_add_add_atomically() {
        let root = temp_root("conflicted-merge");
        let _guard = TestDir(root.clone());
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "--quiet", "-b", "main"]);
        std::fs::write(repo.join("shared.txt"), "line1\nbase\nline3\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "--quiet", "-m", "base"]);

        run_git(&repo, &["branch", "feat"]);
        std::fs::write(repo.join("shared.txt"), "line1\nours\nline3\n").unwrap();
        std::fs::write(repo.join("both_added.txt"), "ours-added\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "--quiet", "-m", "main change"]);
        let main_oid = run_git(&repo, &["rev-parse", "refs/heads/main"]);

        run_git(&repo, &["checkout", "--quiet", "feat"]);
        std::fs::write(repo.join("shared.txt"), "line1\ntheirs\nline3\n").unwrap();
        std::fs::write(repo.join("both_added.txt"), "theirs-added\n").unwrap();
        std::fs::write(repo.join("feat_only.txt"), "feat-only\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "--quiet", "-m", "feat change"]);
        let feat_oid = run_git(&repo, &["rev-parse", "refs/heads/feat"]);
        run_git(&repo, &["checkout", "--quiet", "main"]);

        let objects_before = list_objects(&repo);
        let session = open_session(&repo);
        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(30);

        let preview = preview_merge(
            &git_bin(),
            &session,
            &PreviewMergeParams {
                target_ref: "refs/heads/main".into(),
                expected_target_oid: main_oid.clone(),
                source_ref: "refs/heads/feat".into(),
                expected_source_oid: feat_oid.clone(),
            },
            &cancelled,
            deadline,
        )
        .unwrap();
        assert_eq!(objects_before, list_objects(&repo));

        let files = match preview {
            MergePreviewResult::Conflicted { files, .. } => files,
            other => panic!("expected Conflicted, got {other:?}"),
        };
        assert_eq!(files.len(), 2);
        let resolved: Vec<ResolvedMergeFile> = files
            .iter()
            .map(|f| {
                let contents = if f.path.display == "shared.txt" {
                    "line1\nours\ntheirs\nline3\n".to_owned()
                } else {
                    "ours-added\ntheirs-added\n".to_owned()
                };
                ResolvedMergeFile {
                    path_hex: f.path.raw_hex.clone(),
                    mode: f.mode.clone(),
                    contents,
                }
            })
            .collect();

        let op = commitscope_core::RepositoryOperation::CompleteMerge {
            target_ref: "refs/heads/main".into(),
            expected_target_oid: main_oid.clone(),
            source_ref: "refs/heads/feat".into(),
            expected_source_oid: feat_oid.clone(),
            expected_head_oid: Some(main_oid.clone()),
            mode: MergeSyncMode::MergeCommit,
            message: "Merge branch 'feat' into main".into(),
            resolved_files: resolved,
            switch_to_target: false,
        };
        let inspector = Inspector {
            git: ReadOnlyGit::new(git_bin()).unwrap(),
            directory: &repo,
            cancelled: &cancelled,
            deadline,
        };
        let check = check_complete_merge(&session, &inspector, &op, 40).unwrap();
        assert!(check.allowed);
        let done =
            run_complete_merge(&git_bin(), &session, &inspector, &op, 40, &cancelled).unwrap();
        assert!(matches!(done, OperationRun::Done { .. }));
        assert_eq!(run_git(&repo, &["rev-parse", "HEAD^1"]), main_oid);
        assert_eq!(run_git(&repo, &["rev-parse", "HEAD^2"]), feat_oid);
        assert!(!repo.join(".git/MERGE_HEAD").exists());
        assert!(run_git(&repo, &["status", "--porcelain"]).is_empty());
        assert_eq!(
            std::fs::read_to_string(repo.join("shared.txt")).unwrap(),
            "line1\nours\ntheirs\nline3\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("both_added.txt")).unwrap(),
            "ours-added\ntheirs-added\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("feat_only.txt")).unwrap(),
            "feat-only\n"
        );
    }
}
