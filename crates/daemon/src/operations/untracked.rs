//! Read-only comparison of untracked paths with files newly introduced by a fast-forward.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

use commitscope_core::{DirtyOperationPath, ErrorCode, UntrackedDifference};
use sha2::{Digest, Sha256};

use super::{Inspector, OperationResult, from_git, operation_error};
use crate::git_command::string_arg;

const MAX_FILES: usize = 200;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_DIFF_LINES: usize = 2_000;
const MAX_DIFF_CELLS: usize = 2_000_000;

#[derive(Debug)]
pub(super) struct Candidate {
    pub(super) raw: Vec<u8>,
    pub(super) data: Vec<u8>,
    /// Git mode, including object type (for example 100644 or 120000).
    pub(super) mode: u32,
    pub(super) identical: bool,
    pub(super) difference: Option<UntrackedDifference>,
}

#[derive(Debug)]
pub(super) struct Comparison {
    pub(super) files: Vec<Candidate>,
    pub(super) blocked: Vec<DirtyOperationPath>,
    pub(super) token: Option<String>,
}

#[derive(Debug, Clone)]
struct AddedFile {
    path: Vec<u8>,
    mode: u32,
    oid: String,
}

struct Pending {
    dirty: DirtyOperationPath,
    upstream: AddedFile,
    local: LocalEntry,
}

/// Compare only local status entries already known to overlap this update.
/// No index, worktree, or object database writes are performed.
pub(super) fn compare(
    i: &Inspector<'_>,
    head: &str,
    target: &str,
    affected: Vec<DirtyOperationPath>,
) -> OperationResult<Comparison> {
    let added = added_files(i, head, target)?;
    let worktree = i.directory.canonicalize().map_err(|error| {
        operation_error(ErrorCode::GitError, &format!("解析工作区路径失败：{error}"))
    })?;
    let branch = i.line(&["symbolic-ref", "--quiet", "HEAD"])?;
    let all_affected = affected.clone();
    let mut blocked = Vec::new();
    let mut seen_candidates = BTreeSet::new();
    let mut pending = Vec::new();
    let mut local_bytes = 0usize;

    // Keep each affected status record intact for the caller's dirty blocker. A directory entry
    // may cover many upstream additions, so candidates are discovered from the Git tree diff.
    for dirty in affected {
        i.check_budget()?;
        let mut raw = super::decode_hex(&dirty.path.raw_hex);
        // `status --ignored=matching` reports collapsed directory entries with a trailing slash.
        if raw.last() == Some(&b'/') {
            raw.pop();
        }
        let matching = matching_added(&added, &raw);
        if matching.is_empty() {
            blocked.push(dirty);
            continue;
        }
        if dirty.staged || dirty.unstaged || !dirty.untracked {
            blocked.push(dirty);
            continue;
        }

        let mut dirty_blocked = false;
        for upstream in &matching {
            i.check_budget()?;
            let local = match read_local(i.directory, &upstream.path)? {
                LocalPath::Missing => {
                    // Ignored directory status may cover unrelated ignored files. An absent
                    // descendant is not a collision; disappearance of an exact path is a race.
                    if raw == upstream.path {
                        dirty_blocked = true;
                    }
                    continue;
                }
                LocalPath::Unsafe => {
                    dirty_blocked = true;
                    continue;
                }
                LocalPath::Entry(entry) => entry,
            };
            if !seen_candidates.insert(upstream.path.clone()) {
                continue;
            }
            if seen_candidates.len() > MAX_FILES
                || local_bytes.saturating_add(local.data.len()) > MAX_BYTES
            {
                return Ok(over_limit(all_affected));
            }
            match upstream.mode {
                0o100644 | 0o100755 | 0o120000 => {}
                // Submodules and other object types are never replacement candidates.
                _ => {
                    dirty_blocked = true;
                    continue;
                }
            }
            local_bytes = local_bytes.saturating_add(local.data.len());
            pending.push(Pending {
                dirty: dirty.clone(),
                upstream: (*upstream).clone(),
                local,
            });
        }
        if dirty_blocked {
            blocked.push(dirty.clone());
        }
    }

    if pending.is_empty() {
        return Ok(Comparison {
            files: Vec::new(),
            blocked,
            token: None,
        });
    }
    let oids = unique_oids(&pending);
    let object_input = batch_input(&oids);
    let sizes = batch_blob_sizes(i, &oids, &object_input)?;
    let upstream_bytes = pending.iter().try_fold(0usize, |sum, item| {
        sum.checked_add(*sizes.get(&item.upstream.oid)?)
    });
    let Some(upstream_bytes) = upstream_bytes else {
        return Err(operation_error(ErrorCode::GitError, "上游 blob 大小缺失"));
    };
    if local_bytes.saturating_add(upstream_bytes) > MAX_BYTES {
        return Ok(over_limit(all_affected));
    }
    let upstream_blobs = batch_blobs(i, &oids, &object_input, &sizes)?;
    let regular_paths: Vec<Vec<u8>> = pending
        .iter()
        .filter(|item| is_regular(item.local.mode) && is_regular(item.upstream.mode))
        .map(|item| item.upstream.path.clone())
        .collect();
    let unsafe_attributes = if regular_paths.is_empty() {
        BTreeSet::new()
    } else {
        unsafe_attributes(i, &regular_paths, target)?
    };
    let (autocrlf_transforms, symlinks_disabled) = relevant_config(i)?;

    let mut files = Vec::new();
    let mut token_rows: Vec<UntrackedTokenRow> = Vec::new();
    let mut diff_cells_left = MAX_DIFF_CELLS;
    for item in pending {
        i.check_budget()?;
        let upstream_data = upstream_blobs
            .get(&item.upstream.oid)
            .ok_or_else(|| operation_error(ErrorCode::GitError, "上游 blob 读取结果缺失"))?;
        if upstream_data.len() != sizes[&item.upstream.oid] {
            return Err(operation_error(
                ErrorCode::GitError,
                "上游 blob 大小在读取期间发生变化",
            ));
        }
        let identical = item.local.mode == item.upstream.mode && item.local.data == *upstream_data;
        let regular_pair = is_regular(item.local.mode) && is_regular(item.upstream.mode);
        if (regular_pair
            && (unsafe_attributes.contains(&item.upstream.path) || autocrlf_transforms))
            || (item.local.mode == 0o120000 && identical && symlinks_disabled)
        {
            blocked.push(item.dirty);
            continue;
        }
        if !identical && !regular_pair {
            blocked.push(item.dirty);
            continue;
        }
        let difference = (!identical).then(|| {
            let (upstream_only_lines, local_only_lines) =
                line_difference(upstream_data, &item.local.data, &mut diff_cells_left);
            UntrackedDifference {
                upstream_only_lines,
                local_only_lines,
            }
        });
        let local_digest: [u8; 32] = Sha256::digest(&item.local.data).into();
        files.push(Candidate {
            raw: item.upstream.path.clone(),
            data: item.local.data,
            mode: item.local.mode,
            identical,
            difference,
        });
        token_rows.push((
            item.upstream.path,
            local_digest,
            item.local.mode,
            item.upstream.oid,
            item.upstream.mode,
        ));
    }
    files.sort_by(|a, b| a.raw.cmp(&b.raw));
    token_rows.sort_by(|a, b| a.0.cmp(&b.0));
    let token = if blocked.is_empty() && !token_rows.is_empty() {
        Some(make_token(&worktree, &branch, head, target, &token_rows))
    } else {
        None
    };
    Ok(Comparison {
        files,
        blocked,
        token,
    })
}

fn over_limit(mut blocked: Vec<DirtyOperationPath>) -> Comparison {
    blocked.sort_by(|a, b| a.path.raw_hex.cmp(&b.path.raw_hex));
    blocked.dedup_by(|a, b| a.path.raw_hex == b.path.raw_hex);
    Comparison {
        files: Vec::new(),
        blocked,
        token: None,
    }
}

fn added_files(i: &Inspector<'_>, head: &str, target: &str) -> OperationResult<Vec<AddedFile>> {
    let output = i.read(&[
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--diff-filter=A",
        "--raw",
        "--no-abbrev",
        "-z",
        head,
        target,
        "--",
    ])?;
    let records: Vec<&[u8]> = output
        .split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .collect();
    let mut files = Vec::new();
    let mut index = 0;
    while index < records.len() {
        i.check_budget()?;
        let metadata = records[index];
        index += 1;
        let (Some(metadata), Some(path)) = (parse_raw_metadata(metadata), records.get(index))
        else {
            return Err(operation_error(
                ErrorCode::GitError,
                "Git returned malformed raw diff",
            ));
        };
        index += 1;
        if metadata.3 != b'A' {
            continue;
        }
        files.push(AddedFile {
            path: path.to_vec(),
            mode: metadata.1,
            oid: metadata.2.to_owned(),
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn parse_raw_metadata(record: &[u8]) -> Option<(u32, u32, &str, u8)> {
    let text = std::str::from_utf8(record).ok()?;
    let text = text.strip_prefix(':')?;
    let mut fields = text.split_ascii_whitespace();
    let old_mode = u32::from_str_radix(fields.next()?, 8).ok()?;
    let new_mode = u32::from_str_radix(fields.next()?, 8).ok()?;
    let _old_oid = fields.next()?;
    let new_oid = fields.next()?;
    let status = fields.next()?.as_bytes().first().copied()?;
    Some((old_mode, new_mode, new_oid, status))
}

fn unique_oids(pending: &[Pending]) -> Vec<String> {
    pending
        .iter()
        .map(|item| item.upstream.oid.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn batch_input(oids: &[String]) -> Vec<u8> {
    let mut input = Vec::new();
    for oid in oids {
        input.extend_from_slice(oid.as_bytes());
        input.push(b'\n');
    }
    input
}

fn parse_cat_file_header(line: &[u8]) -> Option<(&str, &str, usize)> {
    let mut fields = line
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|field| !field.is_empty());
    let oid = std::str::from_utf8(fields.next()?).ok()?;
    let kind = std::str::from_utf8(fields.next()?).ok()?;
    let size = std::str::from_utf8(fields.next()?).ok()?.parse().ok()?;
    fields.next().is_none().then_some((oid, kind, size))
}

fn batch_blob_sizes(
    i: &Inspector<'_>,
    oids: &[String],
    input: &[u8],
) -> OperationResult<BTreeMap<String, usize>> {
    let output = i
        .git
        .run(
            i.directory,
            &[string_arg("cat-file"), string_arg("--batch-check")],
            Some(input),
            1024 * 1024,
            i.cancelled,
            i.deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(operation_error(
            ErrorCode::GitError,
            "读取上游 blob 大小失败",
        ));
    }
    let mut sizes = BTreeMap::new();
    for (expected, line) in oids.iter().zip(output.stdout.split(|b| *b == b'\n')) {
        let Some((oid, kind, size)) = parse_cat_file_header(line) else {
            return Err(operation_error(ErrorCode::GitError, "上游对象不是 blob"));
        };
        if oid != expected.as_str() || kind != "blob" {
            return Err(operation_error(
                ErrorCode::GitError,
                "Git 返回了无效的 blob 大小",
            ));
        }
        sizes.insert(expected.clone(), size);
    }
    if sizes.len() != oids.len() {
        return Err(operation_error(
            ErrorCode::GitError,
            "Git 返回的 blob 大小数量不匹配",
        ));
    }
    Ok(sizes)
}

fn batch_blobs(
    i: &Inspector<'_>,
    oids: &[String],
    input: &[u8],
    sizes: &BTreeMap<String, usize>,
) -> OperationResult<BTreeMap<String, Vec<u8>>> {
    let output_limit = MAX_BYTES + MAX_FILES * 256;
    let output = i
        .git
        .run(
            i.directory,
            &[string_arg("cat-file"), string_arg("--batch")],
            Some(input),
            output_limit,
            i.cancelled,
            i.deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(operation_error(ErrorCode::GitError, "读取上游 blob 失败"));
    }
    let mut blobs = BTreeMap::new();
    let mut offset = 0;
    while offset < output.stdout.len() {
        let Some(header_end_rel) = output.stdout[offset..].iter().position(|b| *b == b'\n') else {
            return Err(operation_error(
                ErrorCode::GitError,
                "Git 返回了不完整的 blob header",
            ));
        };
        let header_end = offset + header_end_rel;
        let Some((oid, kind, size)) = parse_cat_file_header(&output.stdout[offset..header_end])
        else {
            return Err(operation_error(
                ErrorCode::GitError,
                "Git 返回了无效的 blob header",
            ));
        };
        if kind != "blob" {
            return Err(operation_error(
                ErrorCode::GitError,
                "Git 返回的对象不是 blob",
            ));
        }
        let expected_size = sizes
            .get(oid)
            .copied()
            .ok_or_else(|| operation_error(ErrorCode::GitError, "Git 返回了未请求的 blob"))?;
        if size != expected_size {
            return Err(operation_error(
                ErrorCode::GitError,
                "Git 返回的 blob 大小与预检不一致",
            ));
        }
        let data_start = header_end + 1;
        let data_end = data_start
            .checked_add(size)
            .filter(|end| *end < output.stdout.len())
            .ok_or_else(|| operation_error(ErrorCode::GitError, "Git 返回了截断的 blob"))?;
        if output.stdout[data_end] != b'\n' {
            return Err(operation_error(ErrorCode::GitError, "Git blob 分隔符无效"));
        }
        blobs.insert(oid.to_owned(), output.stdout[data_start..data_end].to_vec());
        offset = data_end + 1;
    }
    if blobs.len() != oids.len() {
        return Err(operation_error(
            ErrorCode::GitError,
            "Git 返回的 blob 数量不匹配",
        ));
    }
    Ok(blobs)
}

fn is_regular(mode: u32) -> bool {
    matches!(mode, 0o100644 | 0o100755)
}

enum LocalPath {
    Missing,
    Unsafe,
    Entry(LocalEntry),
}

struct LocalEntry {
    data: Vec<u8>,
    mode: u32,
}

fn read_local(root: &Path, raw: &[u8]) -> OperationResult<LocalPath> {
    let Some(path) = raw_path(raw) else {
        return Ok(LocalPath::Unsafe);
    };
    let mut current = root.to_path_buf();
    let components: Vec<_> = path.components().collect();
    if components.is_empty()
        || components
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Ok(LocalPath::Unsafe);
    }
    for component in &components[..components.len() - 1] {
        let Component::Normal(name) = component else {
            return Ok(LocalPath::Unsafe);
        };
        current.push(name);
        match fs::symlink_metadata(current.join(".git")) {
            Ok(_) => return Ok(LocalPath::Unsafe),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Ok(LocalPath::Unsafe),
        }
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LocalPath::Missing);
            }
            Err(error) => {
                return Err(operation_error(
                    ErrorCode::GitError,
                    &format!("读取工作区路径失败：{error}"),
                ));
            }
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Ok(LocalPath::Unsafe);
        }
    }
    let Some(Component::Normal(leaf)) = components.last() else {
        return Ok(LocalPath::Unsafe);
    };
    current.push(leaf);
    let metadata = match fs::symlink_metadata(&current) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LocalPath::Missing);
        }
        Err(error) => {
            return Err(operation_error(
                ErrorCode::GitError,
                &format!("读取工作区路径失败：{error}"),
            ));
        }
    };
    if metadata.file_type().is_symlink() {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let target = fs::read_link(&current).map_err(|error| {
                operation_error(ErrorCode::GitError, &format!("读取符号链接失败：{error}"))
            })?;
            return Ok(LocalPath::Entry(LocalEntry {
                data: target.as_os_str().as_bytes().to_vec(),
                mode: 0o120000,
            }));
        }
        #[cfg(not(unix))]
        return Ok(LocalPath::Unsafe);
    }
    if !metadata.is_file() {
        return Ok(LocalPath::Unsafe);
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Ok(LocalPath::Unsafe);
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(&current).map_err(|error| {
        operation_error(ErrorCode::GitError, &format!("读取工作区文件失败：{error}"))
    })?;
    let opened_metadata = file.metadata().map_err(|error| {
        operation_error(ErrorCode::GitError, &format!("读取工作区路径失败：{error}"))
    })?;
    if !opened_metadata.is_file() {
        return Ok(LocalPath::Unsafe);
    }
    let mut data = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|error| {
            operation_error(ErrorCode::GitError, &format!("读取工作区文件失败：{error}"))
        })?;
    if data.len() > MAX_BYTES {
        return Ok(LocalPath::Unsafe);
    }
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        if opened_metadata.permissions().mode() & 0o100 != 0 {
            0o100755
        } else {
            0o100644
        }
    };
    #[cfg(not(unix))]
    let mode = 0o100644;
    Ok(LocalPath::Entry(LocalEntry { data, mode }))
}

fn unsafe_attributes(
    i: &Inspector<'_>,
    paths: &[Vec<u8>],
    target: &str,
) -> OperationResult<BTreeSet<Vec<u8>>> {
    // Refuse paths with any configured conversion/filter attribute, even if the current
    // checkout settings might make it inert. This keeps byte comparison deterministic.
    let unique_paths: BTreeSet<_> = paths.iter().cloned().collect();
    let mut input = Vec::new();
    for path in &unique_paths {
        input.extend_from_slice(path);
        input.push(0);
    }
    let mut unsafe_paths = BTreeSet::new();
    for source in [None, Some(target)] {
        let mut args = vec![
            string_arg("check-attr"),
            string_arg("-z"),
            string_arg("--stdin"),
            string_arg("--all"),
        ];
        if let Some(source) = source {
            args.push(string_arg(format!("--source={source}")));
        }
        let git = i.git.with_user_config();
        let output = git
            .run(
                i.directory,
                &args,
                Some(&input),
                1024 * 1024,
                i.cancelled,
                i.deadline,
            )
            .map_err(from_git)?;
        if !output.status.success() {
            return Ok(unique_paths);
        }
        let mut fields = output.stdout.split(|b| *b == 0).peekable();
        while let Some(path) = fields.next() {
            if path.is_empty() && fields.peek().is_none() {
                break;
            }
            let (Some(attribute), Some(value)) = (fields.next(), fields.next()) else {
                return Ok(unique_paths);
            };
            if matches!(
                attribute,
                b"filter" | b"text" | b"crlf" | b"eol" | b"ident" | b"working-tree-encoding"
            ) && value != b"unspecified"
                && value != b"unset"
            {
                unsafe_paths.insert(path.to_vec());
            }
        }
    }
    Ok(unsafe_paths)
}

fn relevant_config(i: &Inspector<'_>) -> OperationResult<(bool, bool)> {
    let user_git = i.git.with_user_config();
    let output = user_git
        .run(
            i.directory,
            &[
                string_arg("config"),
                string_arg("--get-regexp"),
                string_arg("^(core\\.(autocrlf|symlinks))$"),
            ],
            None,
            1024,
            i.cancelled,
            i.deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(operation_error(
            ErrorCode::GitError,
            "读取 Git 内容配置失败",
        ));
    }
    let mut autocrlf_transforms = false;
    let mut symlinks_disabled = false;
    if output.status.success() {
        for line in output.stdout.split(|byte| *byte == b'\n') {
            let Some(space) = line.iter().position(|byte| *byte == b' ') else {
                continue;
            };
            let (key, value) = (&line[..space], &line[space + 1..]);
            if key.eq_ignore_ascii_case(b"core.autocrlf") {
                autocrlf_transforms |= matches_config_bool(value, true);
            } else if key.eq_ignore_ascii_case(b"core.symlinks") {
                symlinks_disabled |= matches_config_bool(value, false);
            }
        }
    }
    Ok((autocrlf_transforms, symlinks_disabled))
}

fn matches_config_bool(value: &[u8], expected: bool) -> bool {
    let value = value.to_ascii_lowercase();
    if expected {
        matches!(value.as_slice(), b"true" | b"yes" | b"on" | b"1")
    } else {
        matches!(value.as_slice(), b"false" | b"no" | b"off" | b"0")
    }
}

fn line_difference(
    upstream: &[u8],
    local: &[u8],
    cells_left: &mut usize,
) -> (Option<u32>, Option<u32>) {
    if upstream.contains(&0) || local.contains(&0) {
        return (None, None);
    }
    let Some(upstream_lines) = lines_bounded(upstream) else {
        return (None, None);
    };
    let Some(local_lines) = lines_bounded(local) else {
        return (None, None);
    };
    let n = upstream_lines.len();
    let m = local_lines.len();
    let cells = n.saturating_mul(m);
    if n > MAX_DIFF_LINES || m > MAX_DIFF_LINES || cells > *cells_left {
        return (None, None);
    }
    *cells_left -= cells;
    let mut previous = vec![0u32; m + 1];
    let mut current = vec![0u32; m + 1];
    for upstream_line in &upstream_lines {
        current[0] = 0;
        for (column, local_line) in local_lines.iter().enumerate() {
            current[column + 1] = if upstream_line == local_line {
                previous[column] + 1
            } else {
                current[column].max(previous[column + 1])
            };
        }
        std::mem::swap(&mut previous, &mut current);
    }
    let common = previous[m];
    (
        (n as u32).checked_sub(common),
        (m as u32).checked_sub(common),
    )
}

fn lines_bounded(data: &[u8]) -> Option<Vec<&[u8]>> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, byte) in data.iter().enumerate() {
        if *byte == b'\n' {
            if lines.len() == MAX_DIFF_LINES {
                return None;
            }
            lines.push(&data[start..=index]);
            start = index + 1;
        }
    }
    if start < data.len() {
        if lines.len() == MAX_DIFF_LINES {
            return None;
        }
        lines.push(&data[start..]);
    }
    Some(lines)
}

type UntrackedTokenRow = (Vec<u8>, [u8; 32], u32, String, u32);

fn make_token(
    worktree: &Path,
    branch: &str,
    head: &str,
    target: &str,
    rows: &[UntrackedTokenRow],
) -> String {
    let mut hash = Sha256::new();
    hash.update(b"commitscope-untracked-replace-v1\0");
    hash_field(&mut hash, head.as_bytes());
    hash_field(&mut hash, target.as_bytes());
    hash_field(&mut hash, path_bytes(worktree));
    hash_field(&mut hash, branch.as_bytes());
    for (raw, local_digest, local_mode, upstream_oid, upstream_mode) in rows {
        hash_field(&mut hash, raw);
        hash_field(&mut hash, local_digest);
        hash.update(local_mode.to_be_bytes());
        hash_field(&mut hash, upstream_oid.as_bytes());
        hash.update(upstream_mode.to_be_bytes());
    }
    let digest = hash.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_field(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}

fn path_bytes(path: &Path) -> &[u8] {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes()
    }
    #[cfg(not(unix))]
    {
        // Non-Unix paths are represented losslessly by their native string form on supported
        // repository platforms.
        path.to_str().unwrap_or_default().as_bytes()
    }
}

fn matching_added<'a>(added: &'a [AddedFile], path: &[u8]) -> Vec<&'a AddedFile> {
    let mut matches = Vec::new();
    if let Ok(index) = added.binary_search_by(|entry| entry.path.as_slice().cmp(path)) {
        matches.push(&added[index]);
    }
    let mut prefix = path.to_vec();
    prefix.push(b'/');
    let start = added.partition_point(|entry| entry.path.as_slice() < prefix.as_slice());
    for entry in &added[start..] {
        if !entry.path.starts_with(&prefix) {
            break;
        }
        matches.push(entry);
    }
    for (end, _) in path.iter().enumerate().filter(|(_, byte)| **byte == b'/') {
        if let Ok(index) = added.binary_search_by(|entry| entry.path.as_slice().cmp(&path[..end])) {
            matches.push(&added[index]);
        }
    }
    matches.sort_by(|a, b| a.path.cmp(&b.path));
    matches.dedup_by(|a, b| a.path == b.path);
    matches
}

fn raw_path(raw: &[u8]) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;
        Some(PathBuf::from(OsString::from_vec(raw.to_vec())))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(raw.to_vec()).ok().map(PathBuf::from)
    }
}

#[cfg(test)]
mod tests {
    use super::line_difference;

    #[test]
    fn line_counts_keep_final_newline_distinct() {
        let mut budget = 100;
        assert_eq!(
            line_difference(b"one\n", b"one", &mut budget),
            (Some(1), Some(1))
        );
    }

    #[test]
    fn line_counts_handle_duplicate_lines() {
        let mut budget = 100;
        assert_eq!(
            line_difference(b"a\nb\na\n", b"a\na\n", &mut budget),
            (Some(1), Some(0))
        );
    }

    #[test]
    fn line_counts_stop_when_shared_budget_is_exhausted() {
        let mut budget = 1;
        assert_eq!(
            line_difference(b"a\nb\n", b"a\n", &mut budget),
            (None, None)
        );
        assert_eq!(budget, 1);
    }
}
