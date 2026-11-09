//! P4-10: the files page. A tree at one commit, a file's content, the literal-path history of a file
//! or directory reachable from that commit, and one file's change in one commit. Everything reads
//! committed objects only, with attributes taken from the commit rather than the working tree.

use std::{
    collections::HashMap, ffi::OsString, path::Path, sync::atomic::AtomicBool, time::Instant,
};

use commitscope_core::{
    ChangedFileStatus, ErrorCode, FileContent, FileContentKind, FileDiff, FileHistoryChange,
    FileHistoryEntry, FileHistoryPage, ListTreeParams, ReadDiffParams, ReadFileChangeParams,
    ReadFileContentParams, ReadFileHistoryParams, SearchPathKind, TreeEntry, TreeEntryKind,
    TreePage,
};

use crate::{
    details::{
        self, DetailError, detail_error, from_git, from_preview, git_output_error, git_path,
        hex_decode, is_lfs_pointer, json_char_len, json_text_len, raw_path_arg, validate_oid,
        validate_path_hex,
    },
    git_command::{GitFailure, ReadOnlyGit, string_arg},
    repository, session,
};

type FilesResult<T> = Result<T, DetailError>;

const TREE_OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
const HISTORY_OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
/// Text sent for the content tab; the whole response must stay under the 512 KiB response target.
pub(crate) const CONTENT_TEXT_LIMIT: usize = 400 * 1024;
/// Blobs up to this size are read whole so the total line count is known.
const CONTENT_FULL_READ: u64 = 8 * 1024 * 1024;
const CONTENT_LINE_BYTES: usize = 256 * 1024;
pub(crate) const BINARY_SNIFF: usize = 8 * 1024;
const SYMLINK_LIMIT: usize = 16 * 1024;
/// List pages stop early once their JSON reaches this size; the daemon refuses responses over 512 KiB.
pub(crate) const PAGE_BYTE_BUDGET: usize = 400 * 1024;

/// True once `item` no longer fits the page budget; the first item is always kept.
pub(crate) fn over_budget<T: serde::Serialize>(item: &T, used: &mut usize, kept: usize) -> bool {
    let size = serde_json::to_vec(item).map_or(PAGE_BYTE_BUDGET, |bytes| bytes.len() + 1);
    if kept > 0 && *used + size > PAGE_BYTE_BUDGET {
        return true;
    }
    *used += size;
    false
}

fn null_device() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}

/// Every commit read starts with these: literal pathspecs, and attributes from the commit.
pub(crate) fn commit_args(commit: &str) -> Vec<OsString> {
    vec![
        string_arg("-c"),
        string_arg(format!("core.attributesFile={}", null_device())),
        string_arg("--literal-pathspecs"),
        string_arg(format!("--attr-source={commit}")),
    ]
}

fn path_bytes(raw_hex: &str) -> FilesResult<Vec<u8>> {
    hex_decode(raw_hex).map_err(|()| {
        detail_error(
            ErrorCode::InvalidRequest,
            "Invalid raw repository path",
            false,
        )
    })
}

fn executable_git(executable: &Path) -> FilesResult<ReadOnlyGit> {
    ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)
}

/// One `ls-tree --long` record.
#[derive(Debug, Clone)]
pub(crate) struct LsTreeEntry {
    pub(crate) mode: String,
    pub(crate) kind: TreeEntryKind,
    pub(crate) oid: String,
    pub(crate) size: Option<u64>,
    pub(crate) path: Vec<u8>,
}

pub(crate) fn parse_ls_tree(bytes: &[u8], oid_length: usize) -> FilesResult<Vec<LsTreeEntry>> {
    let mut entries = Vec::new();
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| detail_error(ErrorCode::GitError, "Malformed ls-tree record", false))?;
        let meta = std::str::from_utf8(&record[..tab])
            .map_err(|_| detail_error(ErrorCode::GitError, "Malformed ls-tree metadata", false))?;
        let mut fields = meta.split(' ').filter(|field| !field.is_empty());
        let (Some(mode), Some(kind), Some(oid), Some(size)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            return Err(detail_error(
                ErrorCode::GitError,
                "Malformed ls-tree metadata",
                false,
            ));
        };
        if oid.len() != oid_length || mode.len() != 6 {
            return Err(detail_error(
                ErrorCode::GitError,
                "Unexpected ls-tree object",
                false,
            ));
        }
        let kind = match kind {
            "tree" => TreeEntryKind::Directory,
            "commit" => TreeEntryKind::Submodule,
            "blob" if mode == "120000" => TreeEntryKind::Symlink,
            "blob" => TreeEntryKind::File,
            _ => {
                return Err(detail_error(
                    ErrorCode::GitError,
                    "Unknown ls-tree object type",
                    false,
                ));
            }
        };
        entries.push(LsTreeEntry {
            mode: mode.to_owned(),
            kind,
            oid: oid.to_ascii_lowercase(),
            size: size.parse::<u64>().ok(),
            path: record[tab + 1..].to_vec(),
        });
    }
    Ok(entries)
}

fn ls_tree(
    git: &ReadOnlyGit,
    repo: &Path,
    commit: &str,
    pathspec: Option<OsString>,
    oid_length: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> FilesResult<Vec<LsTreeEntry>> {
    let mut args = commit_args(commit);
    args.extend([
        string_arg("ls-tree"),
        string_arg("-z"),
        string_arg("--long"),
        string_arg("--full-tree"),
        string_arg(commit),
    ]);
    if let Some(pathspec) = pathspec {
        args.push(string_arg("--"));
        args.push(pathspec);
    }
    let output = git
        .run(repo, &args, None, TREE_OUTPUT_LIMIT, cancelled, deadline)
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(git_output_error(&output.stderr));
    }
    parse_ls_tree(&output.stdout, oid_length)
}

/// The tree entry for exactly this path at this commit, if there is one.
pub(crate) fn lookup_entry(
    git: &ReadOnlyGit,
    repo: &Path,
    commit: &str,
    raw_hex: &str,
    oid_length: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> FilesResult<Option<LsTreeEntry>> {
    let wanted = path_bytes(raw_hex)?;
    let entries = ls_tree(
        git,
        repo,
        commit,
        Some(raw_path_arg(raw_hex)?),
        oid_length,
        cancelled,
        deadline,
    )?;
    Ok(entries.into_iter().find(|entry| entry.path == wanted))
}

pub(crate) fn read_blob(
    git: &ReadOnlyGit,
    repo: &Path,
    oid: &str,
    limit: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> FilesResult<Vec<u8>> {
    let output = git
        .run(
            repo,
            &[string_arg("cat-file"), string_arg("blob"), string_arg(oid)],
            None,
            limit,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(git_output_error(&output.stderr));
    }
    Ok(output.stdout)
}

pub fn list_tree(
    executable: &Path,
    session: &session::RepositorySession,
    params: &ListTreeParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> FilesResult<TreePage> {
    list_tree_at(
        executable,
        Path::new(&session.discovered.info.path),
        session.discovered.oid_length,
        params,
        cancelled,
        deadline,
    )
}

pub(crate) fn list_tree_at(
    executable: &Path,
    repo: &Path,
    oid_length: usize,
    params: &ListTreeParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> FilesResult<TreePage> {
    let commit = params.commit.to_ascii_lowercase();
    validate_oid(&commit, oid_length)?;
    validate_path_hex(params.path_hex.as_deref())?;
    let directory = params.path_hex.as_deref().map(str::to_ascii_lowercase);
    let git = executable_git(executable)?;
    // "dir/" lists the directory's children; no pathspec lists the root.
    let pathspec = directory
        .as_deref()
        .map(|hex| raw_path_arg(&format!("{hex}2f")))
        .transpose()?;
    let mut entries = ls_tree(
        &git, repo, &commit, pathspec, oid_length, cancelled, deadline,
    )?;
    if directory.is_some() && entries.is_empty() {
        return Err(detail_error(
            ErrorCode::MissingObject,
            "The directory does not exist at this commit",
            false,
        ));
    }
    let name = |entry: &LsTreeEntry| {
        entry
            .path
            .rsplit(|byte| *byte == b'/')
            .next()
            .unwrap_or(&entry.path)
            .to_vec()
    };
    entries.sort_by(|left, right| {
        (left.kind != TreeEntryKind::Directory)
            .cmp(&(right.kind != TreeEntryKind::Directory))
            .then_with(|| name(left).cmp(&name(right)))
    });
    let total = u32::try_from(entries.len()).map_err(|_| {
        detail_error(
            ErrorCode::ResourceLimit,
            "The directory has too many entries",
            false,
        )
    })?;
    let offset = params.offset.min(total);
    let mut page: Vec<TreeEntry> = Vec::new();
    let mut used = 0;
    for entry in entries
        .into_iter()
        .skip(offset as usize)
        .take(usize::from(params.limit))
    {
        let entry = TreeEntry {
            name: git_path(name(&entry)),
            path: git_path(entry.path),
            kind: entry.kind,
            mode: entry.mode,
            oid: entry.oid,
            size: match entry.kind {
                TreeEntryKind::File | TreeEntryKind::Symlink => entry.size,
                _ => None,
            },
        };
        if over_budget(&entry, &mut used, page.len()) {
            break;
        }
        page.push(entry);
    }
    let shown = u32::try_from(page.len()).unwrap_or(u32::MAX);
    Ok(TreePage {
        commit,
        path: directory
            .map(|hex| path_bytes(&hex).map(git_path))
            .transpose()?,
        entries: page,
        offset,
        total,
        has_more: offset + shown < total,
    })
}

pub fn read_file_content(
    executable: &Path,
    session: &session::RepositorySession,
    params: &ReadFileContentParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> FilesResult<FileContent> {
    read_file_content_at(
        executable,
        Path::new(&session.discovered.info.path),
        session.discovered.oid_length,
        params,
        cancelled,
        deadline,
    )
}

/// Splits text into lines and keeps what fits the line budget and the byte budget, counted as the
/// text will be encoded in the JSON response.
pub(crate) fn text_head(
    bytes: &[u8],
    max_lines: usize,
    byte_limit: usize,
) -> (String, u32, bool, bool) {
    let mut text = String::new();
    let mut encoded = 0usize;
    let mut lines = 0u32;
    let mut lossy = false;
    let mut truncated = false;
    let mut rest = bytes;
    while !rest.is_empty() {
        if lines as usize == max_lines {
            truncated = true;
            break;
        }
        let (line, next) = match rest.iter().position(|byte| *byte == b'\n') {
            Some(index) => (&rest[..index], &rest[index + 1..]),
            None => (rest, &rest[rest.len()..]),
        };
        let decoded = String::from_utf8_lossy(line);
        if matches!(decoded, std::borrow::Cow::Owned(_)) {
            lossy = true;
        }
        let line_bytes = json_text_len(&decoded) + 2;
        if encoded + line_bytes > byte_limit {
            truncated = true;
            if lines == 0 {
                // A single line longer than the budget: keep its start, cut at a character.
                let mut budget = byte_limit.saturating_sub(2);
                for character in decoded.chars() {
                    let size = json_char_len(character);
                    if size > budget {
                        break;
                    }
                    budget -= size;
                    text.push(character);
                }
                text.push('\n');
                lines = 1;
            }
            break;
        }
        text.push_str(&decoded);
        text.push('\n');
        encoded += line_bytes;
        lines += 1;
        rest = next;
    }
    (text, lines, lossy, truncated)
}

pub(crate) fn count_lines(bytes: &[u8]) -> u64 {
    let newlines = bytes.iter().filter(|byte| **byte == b'\n').count() as u64;
    newlines + u64::from(!bytes.is_empty() && bytes.last() != Some(&b'\n'))
}

pub(crate) fn read_file_content_at(
    executable: &Path,
    repo: &Path,
    oid_length: usize,
    params: &ReadFileContentParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> FilesResult<FileContent> {
    let commit = params.commit.to_ascii_lowercase();
    validate_oid(&commit, oid_length)?;
    validate_path_hex(Some(&params.path_hex))?;
    let git = executable_git(executable)?;
    let path = git_path(path_bytes(&params.path_hex)?);
    let mut content = FileContent {
        commit: commit.clone(),
        path,
        kind: FileContentKind::Missing,
        text: String::new(),
        lines: 0,
        total_lines: None,
        truncated: false,
        size: None,
        text_lossy: false,
        symlink_target: None,
        blob_oid: None,
    };
    let Some(entry) = lookup_entry(
        &git,
        repo,
        &commit,
        &params.path_hex.to_ascii_lowercase(),
        oid_length,
        cancelled,
        deadline,
    )?
    else {
        return Ok(content);
    };
    content.blob_oid = Some(entry.oid.clone());
    content.size = entry.size;
    match entry.kind {
        TreeEntryKind::Directory => {
            content.blob_oid = None;
            return Ok(content);
        }
        TreeEntryKind::Submodule => {
            content.kind = FileContentKind::Submodule;
            content.size = None;
            return Ok(content);
        }
        TreeEntryKind::Symlink => {
            content.kind = FileContentKind::Symlink;
            content.symlink_target = Some(git_path(read_blob(
                &git,
                repo,
                &entry.oid,
                SYMLINK_LIMIT,
                cancelled,
                deadline,
            )?));
            return Ok(content);
        }
        TreeEntryKind::File => {}
    }
    let size = entry.size.unwrap_or(0);
    if size <= 1024 {
        let bytes = read_blob(&git, repo, &entry.oid, 1025, cancelled, deadline)?;
        if is_lfs_pointer(&bytes) {
            content.kind = FileContentKind::Lfs;
            return Ok(content);
        }
    }
    let max_lines = usize::from(params.max_lines);
    if size <= CONTENT_FULL_READ {
        let bytes = read_blob(
            &git,
            repo,
            &entry.oid,
            usize::try_from(size)
                .unwrap_or(usize::MAX)
                .saturating_add(1),
            cancelled,
            deadline,
        )?;
        if bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0) {
            content.kind = FileContentKind::Binary;
            return Ok(content);
        }
        let (text, lines, lossy, truncated) = text_head(&bytes, max_lines, CONTENT_TEXT_LIMIT);
        content.kind = FileContentKind::Text;
        content.total_lines = Some(count_lines(&bytes));
        content.text = text;
        content.lines = lines;
        content.text_lossy = lossy;
        content.truncated = truncated;
        return Ok(content);
    }
    // Large blobs: read only the head; the total line count stays unknown.
    let mut stream = git
        .stream_lines(
            repo,
            &[
                string_arg("cat-file"),
                string_arg("blob"),
                string_arg(&entry.oid),
            ],
            CONTENT_LINE_BYTES,
        )
        .map_err(from_git)?;
    let mut head = Vec::new();
    let mut read_lines = 0usize;
    loop {
        if read_lines > max_lines || head.len() > CONTENT_TEXT_LIMIT {
            break;
        }
        match stream.next_line(cancelled, deadline) {
            Ok(Some(line)) => {
                head.extend_from_slice(&line);
                head.push(b'\n');
                read_lines += 1;
            }
            Ok(None) => break,
            Err(GitFailure::ResourceLimit) => break,
            Err(error) => return Err(from_git(error)),
        }
    }
    drop(stream);
    if head[..head.len().min(BINARY_SNIFF)].contains(&0) {
        content.kind = FileContentKind::Binary;
        return Ok(content);
    }
    let (text, lines, lossy, _) = text_head(&head, max_lines, CONTENT_TEXT_LIMIT);
    content.kind = FileContentKind::Text;
    content.text = text;
    content.lines = lines;
    content.text_lossy = lossy;
    content.truncated = true;
    Ok(content)
}

pub fn read_file_history(
    executable: &Path,
    session: &session::RepositorySession,
    params: &ReadFileHistoryParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> FilesResult<FileHistoryPage> {
    read_file_history_at(
        executable,
        Path::new(&session.discovered.info.path),
        session.discovered.oid_length,
        params,
        cancelled,
        deadline,
    )
}

/// A cursor names its offset and the query it belongs to, so it cannot be replayed on another path.
fn history_key(commit: &str, kind: SearchPathKind, path_hex: &str, message: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in commit
        .bytes()
        .chain([0])
        .chain(format!("{kind:?}").bytes())
        .chain([0])
        .chain(path_hex.bytes())
        .chain([0])
        .chain(message.bytes())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[derive(Debug, Default)]
struct HistoryRecord {
    oid: String,
    /// Set only for merges; their change is read separately against this parent.
    first_parent_of_merge: Option<String>,
    statuses: Vec<u8>,
    additions: u64,
    deletions: u64,
    binary: bool,
}

fn parse_history_log(bytes: &[u8], oid_length: usize) -> FilesResult<Vec<HistoryRecord>> {
    let malformed = || detail_error(ErrorCode::GitError, "Malformed history record", false);
    let mut records: Vec<HistoryRecord> = Vec::new();
    for line in bytes.split(|byte| *byte == b'\n') {
        if let Some(header) = line.strip_prefix(&[1u8]) {
            // "\x01<oid> <parent> <parent>..."
            let header = std::str::from_utf8(header).map_err(|_| malformed())?;
            let mut fields = header.split(' ').filter(|field| !field.is_empty());
            let oid = fields.next().ok_or_else(malformed)?;
            let parents: Vec<&str> = fields.collect();
            if oid.len() != oid_length || parents.iter().any(|parent| parent.len() != oid_length) {
                return Err(detail_error(
                    ErrorCode::GitError,
                    "Malformed history object ID",
                    false,
                ));
            }
            records.push(HistoryRecord {
                oid: oid.to_owned(),
                first_parent_of_merge: (parents.len() > 1).then(|| parents[0].to_owned()),
                ..HistoryRecord::default()
            });
            continue;
        }
        if let Some(record) = records.last_mut() {
            add_diff_line(record, line);
        }
    }
    Ok(records)
}

/// Adds one `--raw` or `--numstat` line to the record's change.
fn add_diff_line(record: &mut HistoryRecord, line: &[u8]) {
    if line.first() == Some(&b':') {
        // ":<old mode> <new mode> <old oid> <new oid> <status>\t<path>"
        let meta = line.split(|byte| *byte == b'\t').next().unwrap_or(line);
        if let Some(status) = meta
            .rsplit(|byte| *byte == b' ')
            .next()
            .and_then(|field| field.first())
        {
            record.statuses.push(*status);
        }
        return;
    }
    if !line.contains(&b'\t') {
        return;
    }
    let mut fields = line.splitn(3, |byte| *byte == b'\t');
    let (Some(added), Some(deleted)) = (fields.next(), fields.next()) else {
        return;
    };
    if added == b"-" || deleted == b"-" {
        record.binary = true;
        return;
    }
    let parse = |value: &[u8]| {
        std::str::from_utf8(value)
            .ok()
            .and_then(|text| text.parse::<u64>().ok())
    };
    if let (Some(added), Some(deleted)) = (parse(added), parse(deleted)) {
        record.additions += added;
        record.deletions += deleted;
    }
}

/// `git log` prints no diff for merges, so their change against the first parent comes from one
/// `git diff-tree --stdin` run. Passing the parent explicitly makes Git compare against it alone.
#[allow(clippy::too_many_arguments)]
fn add_merge_changes(
    git: &ReadOnlyGit,
    repo: &Path,
    commit: &str,
    path_hex: &str,
    oid_length: usize,
    records: &mut [HistoryRecord],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> FilesResult<()> {
    let mut input = Vec::new();
    let mut index_by_oid = HashMap::new();
    for (index, record) in records.iter().enumerate() {
        if let Some(parent) = &record.first_parent_of_merge {
            input.extend_from_slice(format!("{} {parent}\n", record.oid).as_bytes());
            index_by_oid.insert(record.oid.clone(), index);
        }
    }
    if input.is_empty() {
        return Ok(());
    }
    let mut args = commit_args(commit);
    args.extend([
        string_arg("diff-tree"),
        string_arg("--stdin"),
        string_arg("-r"),
        string_arg("--raw"),
        string_arg("--numstat"),
        string_arg("--no-renames"),
        string_arg("--no-abbrev"),
        string_arg("--no-ext-diff"),
        string_arg("--no-textconv"),
        string_arg("--"),
    ]);
    if !path_hex.is_empty() {
        args.push(raw_path_arg(path_hex)?);
    }
    let output = git
        .run(
            repo,
            &args,
            Some(&input),
            HISTORY_OUTPUT_LIMIT,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(git_output_error(&output.stderr));
    }
    // diff-tree prints the merge's ID on its own line before that merge's changes.
    let mut current = None;
    for line in output.stdout.split(|byte| *byte == b'\n') {
        if line.len() == oid_length && line.iter().all(u8::is_ascii_hexdigit) {
            current = std::str::from_utf8(line)
                .ok()
                .and_then(|oid| index_by_oid.get(oid).copied());
            continue;
        }
        if let Some(index) = current {
            add_diff_line(&mut records[index], line);
        }
    }
    Ok(())
}

fn status_from_letter(letter: u8) -> ChangedFileStatus {
    match letter {
        b'A' => ChangedFileStatus::Added,
        b'D' => ChangedFileStatus::Deleted,
        b'T' => ChangedFileStatus::TypeChanged,
        b'R' => ChangedFileStatus::Renamed,
        b'C' => ChangedFileStatus::Copied,
        _ => ChangedFileStatus::Modified,
    }
}

pub(crate) fn read_file_history_at(
    executable: &Path,
    repo: &Path,
    oid_length: usize,
    params: &ReadFileHistoryParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> FilesResult<FileHistoryPage> {
    let commit = params.commit.to_ascii_lowercase();
    validate_oid(&commit, oid_length)?;
    let path_hex = params.path_hex.to_ascii_lowercase();
    if path_hex.is_empty() {
        if params.kind != SearchPathKind::Directory {
            return Err(detail_error(
                ErrorCode::InvalidRequest,
                "A file history needs a path",
                false,
            ));
        }
    } else {
        validate_path_hex(Some(&path_hex))?;
    }
    let key = history_key(&commit, params.kind, &path_hex, &params.message);
    let offset: u64 = match params.cursor.as_deref() {
        None => 0,
        Some(cursor) => {
            let mut parts = cursor.splitn(3, ':');
            match (
                parts.next(),
                parts.next().and_then(|value| value.parse::<u64>().ok()),
                parts.next(),
            ) {
                (Some("v1"), Some(offset), Some(cursor_key)) if cursor_key == key => offset,
                _ => {
                    return Err(detail_error(
                        ErrorCode::InvalidCursor,
                        "The history cursor belongs to another query",
                        false,
                    ));
                }
            }
        }
    };
    let page_size = usize::from(params.page_size);
    let git = executable_git(executable)?;
    let mut args = commit_args(&commit);
    args.extend([
        string_arg("log"),
        string_arg("--format=format:%x01%H %P"),
        string_arg("--raw"),
        string_arg("--numstat"),
        string_arg("--no-renames"),
        // No --diff-merges here: it also changes which merges are listed, unlike `git log -- <path>`.
        string_arg("--no-abbrev"),
        string_arg("--no-ext-diff"),
        string_arg("--no-textconv"),
        string_arg(format!("--skip={offset}")),
        string_arg(format!("--max-count={}", page_size + 1)),
    ]);
    if !params.message.is_empty() {
        args.extend([
            string_arg("--regexp-ignore-case"),
            string_arg("--fixed-strings"),
            string_arg(format!("--grep={}", params.message)),
        ]);
    }
    args.push(string_arg(&commit));
    args.push(string_arg("--"));
    if !path_hex.is_empty() {
        args.push(raw_path_arg(&path_hex)?);
    }
    let output = git
        .run(repo, &args, None, HISTORY_OUTPUT_LIMIT, cancelled, deadline)
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(git_output_error(&output.stderr));
    }
    let mut records = parse_history_log(&output.stdout, oid_length)?;
    let mut has_more = records.len() > page_size;
    records.truncate(page_size);
    add_merge_changes(
        &git,
        repo,
        &commit,
        &path_hex,
        oid_length,
        &mut records,
        cancelled,
        deadline,
    )?;
    let oids: Vec<String> = records.iter().map(|record| record.oid.clone()).collect();
    let summaries: HashMap<String, commitscope_core::CommitSummary> =
        repository::read_commits(&git, repo, &oids, oid_length, cancelled, deadline)
            .map_err(from_preview)?
            .into_iter()
            .map(|parsed| (parsed.summary.oid.clone(), parsed.summary))
            .collect();
    let mut entries = Vec::with_capacity(records.len());
    let mut used = 0;
    for record in records {
        let summary = summaries.get(&record.oid).cloned().ok_or_else(|| {
            detail_error(
                ErrorCode::MissingObject,
                "A history commit could not be read",
                false,
            )
        })?;
        let mut status = if params.kind == SearchPathKind::File {
            record
                .statuses
                .first()
                .copied()
                .map_or(ChangedFileStatus::Modified, status_from_letter)
        } else if !record.statuses.is_empty()
            && record.statuses.iter().all(|letter| *letter == b'A')
        {
            ChangedFileStatus::Added
        } else if !record.statuses.is_empty()
            && record.statuses.iter().all(|letter| *letter == b'D')
        {
            ChangedFileStatus::Deleted
        } else {
            ChangedFileStatus::Modified
        };
        // History follows the literal path; a file that appears here may have been renamed from elsewhere.
        let mut old_path = None;
        let parent = summary.parents.first();
        if let (SearchPathKind::File, ChangedFileStatus::Added, Some(parent)) =
            (params.kind, status, parent)
            && let Ok(changes) = details::read_diff(
                executable,
                &repo.to_string_lossy(),
                &record.oid,
                Some(parent),
                oid_length,
                cancelled,
                deadline,
            )
            && let Some(renamed) = changes.into_iter().find(|change| {
                change.status == ChangedFileStatus::Renamed
                    && change
                        .new_path
                        .as_ref()
                        .is_some_and(|path| path.raw_hex == path_hex)
            })
        {
            status = ChangedFileStatus::Renamed;
            old_path = renamed.old_path;
        }
        let entry = FileHistoryEntry {
            commit: summary,
            change: FileHistoryChange {
                status,
                old_path,
                additions: (!record.binary).then_some(record.additions),
                deletions: (!record.binary).then_some(record.deletions),
                binary: record.binary,
                files: u32::try_from(record.statuses.len().max(1)).unwrap_or(u32::MAX),
            },
        };
        if over_budget(&entry, &mut used, entries.len()) {
            has_more = true;
            break;
        }
        entries.push(entry);
    }
    let next_offset = offset + entries.len() as u64;
    Ok(FileHistoryPage {
        commit,
        path: git_path(path_bytes(&path_hex)?),
        entries,
        next_cursor: has_more.then(|| format!("v1:{next_offset}:{key}")),
    })
}

/// One file's change in one commit: finds the raw path pair the commit changed, then reads it as a commit diff.
pub fn read_file_change(
    executable: &Path,
    session: &session::RepositorySession,
    params: &ReadFileChangeParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> FilesResult<FileDiff> {
    let oid = params.oid.to_ascii_lowercase();
    let oid_length = session.discovered.oid_length;
    validate_oid(&oid, oid_length)?;
    validate_path_hex(Some(&params.path_hex))?;
    validate_path_hex(params.old_path_hex.as_deref())?;
    let repo = Path::new(&session.discovered.info.path);
    let git = executable_git(executable)?;
    let commit = repository::read_commits(
        &git,
        repo,
        std::slice::from_ref(&oid),
        oid_length,
        cancelled,
        deadline,
    )
    .map_err(from_preview)?
    .pop()
    .ok_or_else(|| {
        detail_error(
            ErrorCode::MissingObject,
            "Commit object was not found",
            false,
        )
    })?;
    let parent_oid = match params.parent_index {
        None if commit.summary.parents.is_empty() => None,
        Some(index) if usize::from(index) < commit.summary.parents.len() => {
            Some(commit.summary.parents[usize::from(index)].clone())
        }
        _ => {
            return Err(detail_error(
                ErrorCode::InvalidRequest,
                "parentIndex does not match the commit's parents",
                false,
            ));
        }
    };
    let changes = details::read_diff(
        executable,
        &session.discovered.info.path,
        &oid,
        parent_oid.as_deref(),
        oid_length,
        cancelled,
        deadline,
    )?;
    let path_hex = params.path_hex.to_ascii_lowercase();
    let old_hex = params.old_path_hex.as_deref().map(str::to_ascii_lowercase);
    let raw =
        |path: &Option<commitscope_core::GitPath>| path.as_ref().map(|path| path.raw_hex.clone());
    let change = changes
        .into_iter()
        .find(|change| match &old_hex {
            Some(old) => {
                raw(&change.old_path).as_deref() == Some(old.as_str())
                    && raw(&change.new_path).as_deref() == Some(path_hex.as_str())
            }
            None => {
                raw(&change.new_path).as_deref() == Some(path_hex.as_str())
                    || change.new_path.is_none()
                        && raw(&change.old_path).as_deref() == Some(path_hex.as_str())
            }
        })
        .ok_or_else(|| {
            detail_error(
                ErrorCode::InvalidRequest,
                "This commit does not change the path against that parent",
                false,
            )
        })?;
    details::read_file_diff(
        executable,
        session,
        &ReadDiffParams {
            oid,
            parent_index: params.parent_index,
            old_path_hex: raw(&change.old_path),
            new_path_hex: raw(&change.new_path),
            full_file: params.full_file,
        },
        cancelled,
        deadline,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    pub(crate) struct TestRepo(pub(crate) std::path::PathBuf);

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub(crate) fn test_git_path() -> std::path::PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|entry| entry.join(if cfg!(windows) { "git.exe" } else { "git" }))
            .find(|candidate| candidate.is_file())
            .expect("Git is available for the files unit tests")
    }

    pub(crate) fn run(git: &Path, repository: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new(git)
            .arg("-C")
            .arg(repository)
            .args([
                "-c",
                "user.name=Files Test",
                "-c",
                "user.email=files@example.invalid",
            ])
            .args(args)
            .env("GIT_AUTHOR_DATE", "2026-11-01T10:00:00+08:00")
            .env("GIT_COMMITTER_DATE", "2026-11-01T10:00:00+08:00")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn hex(text: &str) -> String {
        text.bytes().map(|byte| format!("{byte:02x}")).collect()
    }

    /// root: a.txt, src/old.rs; second: rename src/old.rs to src/new.rs; third: edit src/new.rs.
    fn fixture(label: &str) -> (std::path::PathBuf, TestRepo, Vec<String>) {
        let git = test_git_path();
        let path =
            std::env::temp_dir().join(format!("commitscope-files-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(path.join("src")).unwrap();
        run(&git, &path, &["init", "--quiet", "-b", "main"]);
        std::fs::write(path.join("a.txt"), "alpha\n").unwrap();
        let body: String = (1..=30)
            .map(|line| format!("let value{line} = {line};\n"))
            .collect();
        std::fs::write(path.join("src/old.rs"), &body).unwrap();
        run(&git, &path, &["add", "."]);
        run(&git, &path, &["commit", "--quiet", "-m", "root"]);
        run(&git, &path, &["mv", "src/old.rs", "src/new.rs"]);
        run(&git, &path, &["commit", "--quiet", "-m", "rename"]);
        std::fs::write(
            path.join("src/new.rs"),
            body.replace("let value20 = 20;", "let value20 = 200;"),
        )
        .unwrap();
        run(&git, &path, &["commit", "--quiet", "-am", "edit"]);
        let commits = run(&git, &path, &["rev-list", "HEAD"])
            .lines()
            .map(str::to_owned)
            .collect();
        (path.clone(), TestRepo(path), commits)
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }

    #[test]
    fn tree_lists_directories_first_and_pages() {
        let (path, _cleanup, commits) = fixture("tree");
        let git = test_git_path();
        let cancelled = AtomicBool::new(false);
        let root = list_tree_at(
            &git,
            &path,
            40,
            &ListTreeParams {
                commit: commits[0].clone(),
                path_hex: None,
                offset: 0,
                limit: 500,
            },
            &cancelled,
            deadline(),
        )
        .unwrap();
        let names: Vec<_> = root
            .entries
            .iter()
            .map(|entry| entry.name.display.clone())
            .collect();
        assert_eq!(names, ["src", "a.txt"]);
        assert_eq!(root.entries[0].kind, TreeEntryKind::Directory);
        assert_eq!(root.entries[1].size, Some(6));
        let src = list_tree_at(
            &git,
            &path,
            40,
            &ListTreeParams {
                commit: commits[0].clone(),
                path_hex: Some(hex("src")),
                offset: 0,
                limit: 1,
            },
            &cancelled,
            deadline(),
        )
        .unwrap();
        assert_eq!(src.entries[0].path.display, "src/new.rs");
        assert_eq!((src.total, src.has_more), (1, false));
        let missing = list_tree_at(
            &git,
            &path,
            40,
            &ListTreeParams {
                commit: commits[0].clone(),
                path_hex: Some(hex("nope")),
                offset: 0,
                limit: 10,
            },
            &cancelled,
            deadline(),
        );
        assert_eq!(missing.unwrap_err().code, ErrorCode::MissingObject);
    }

    #[test]
    fn content_reads_text_with_limits_and_reports_missing_paths() {
        let (path, _cleanup, commits) = fixture("content");
        let git = test_git_path();
        let cancelled = AtomicBool::new(false);
        let file = read_file_content_at(
            &git,
            &path,
            40,
            &ReadFileContentParams {
                commit: commits[0].clone(),
                path_hex: hex("src/new.rs"),
                max_lines: 5,
            },
            &cancelled,
            deadline(),
        )
        .unwrap();
        assert_eq!(file.kind, FileContentKind::Text);
        assert_eq!(
            (file.lines, file.total_lines, file.truncated),
            (5, Some(30), true)
        );
        assert!(file.text.starts_with("let value1 = 1;\n"));
        let gone = read_file_content_at(
            &git,
            &path,
            40,
            &ReadFileContentParams {
                commit: commits[0].clone(),
                path_hex: hex("src/old.rs"),
                max_lines: 5,
            },
            &cancelled,
            deadline(),
        )
        .unwrap();
        assert_eq!(gone.kind, FileContentKind::Missing);
        let old = read_file_content_at(
            &git,
            &path,
            40,
            &ReadFileContentParams {
                commit: commits[2].clone(),
                path_hex: hex("src/old.rs"),
                max_lines: 5000,
            },
            &cancelled,
            deadline(),
        )
        .unwrap();
        assert_eq!((old.kind, old.truncated), (FileContentKind::Text, false));
    }

    #[test]
    fn text_head_keeps_the_start_of_an_overlong_line() {
        let (text, lines, lossy, truncated) = text_head(b"abcdef\nnext\n", 10, 5);
        assert_eq!(
            (text.as_str(), lines, lossy, truncated),
            ("abc\n", 1, false, true)
        );
        let (_, lines, lossy, _) = text_head(b"ok\n\xff\n", 10, 100);
        assert_eq!((lines, lossy), (2, true));
        // Escapes count at their encoded size: ten ESC bytes take 60 bytes in JSON.
        let escapes = [[0x1b_u8; 10].as_slice(), b"\n"].concat();
        assert!(text_head(&escapes, 10, 40).3);
        assert!(!text_head(&escapes, 10, 62).3);
        assert_eq!(count_lines(b"a\nb"), 2);
        assert_eq!(count_lines(b""), 0);
    }

    #[test]
    fn history_follows_the_literal_path_and_names_the_rename_source() {
        let (path, _cleanup, commits) = fixture("history");
        let git = test_git_path();
        let cancelled = AtomicBool::new(false);
        let params = |cursor: Option<String>, page_size: u16| ReadFileHistoryParams {
            commit: commits[0].clone(),
            path_hex: hex("src/new.rs"),
            kind: SearchPathKind::File,
            message: String::new(),
            cursor,
            page_size,
        };
        let first = read_file_history_at(&git, &path, 40, &params(None, 1), &cancelled, deadline())
            .unwrap();
        assert_eq!(first.entries.len(), 1);
        assert_eq!(first.entries[0].commit.oid, commits[0]);
        assert_eq!(
            (
                first.entries[0].change.additions,
                first.entries[0].change.deletions
            ),
            (Some(1), Some(1))
        );
        let second = read_file_history_at(
            &git,
            &path,
            40,
            &params(first.next_cursor.clone(), 1),
            &cancelled,
            deadline(),
        )
        .unwrap();
        assert_eq!(second.entries[0].commit.oid, commits[1]);
        assert_eq!(second.entries[0].change.status, ChangedFileStatus::Renamed);
        assert_eq!(
            second.entries[0].change.old_path.as_ref().unwrap().display,
            "src/old.rs"
        );
        assert_eq!(
            second.next_cursor, None,
            "the root commit only knew src/old.rs"
        );
        let wrong = read_file_history_at(
            &git,
            &path,
            40,
            &ReadFileHistoryParams {
                message: "other".into(),
                ..params(first.next_cursor, 1)
            },
            &cancelled,
            deadline(),
        );
        assert_eq!(wrong.unwrap_err().code, ErrorCode::InvalidCursor);
        let directory = read_file_history_at(
            &git,
            &path,
            40,
            &ReadFileHistoryParams {
                commit: commits[0].clone(),
                path_hex: String::new(),
                kind: SearchPathKind::Directory,
                message: "REN".into(),
                cursor: None,
                page_size: 10,
            },
            &cancelled,
            deadline(),
        )
        .unwrap();
        assert_eq!(
            directory.entries.len(),
            1,
            "message filter is case-insensitive and literal"
        );
        assert_eq!(
            directory.entries[0].change.files, 2,
            "the rename touches two paths without rename detection"
        );
    }
}
