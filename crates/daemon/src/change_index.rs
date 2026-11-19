//! First-parent file changes; raw paths are persisted as SQLite BLOBs.
use crate::{
    git_command::{GitFailure, ReadOnlyGit, string_arg},
    metadata_index::IndexError,
};
use commitscope_core::{ChangedFile, ErrorCode};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{OnceLock, atomic::AtomicBool},
    time::Instant,
};

const ATTR_DISCOVERY_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const ATTR_BATCH_CHECK_LIMIT: usize = 4 * 1024 * 1024;
const MERGE_PATH_DIFF_LIMIT: usize = 32 * 1024 * 1024;
const DIFF_TREE_OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
const MAX_TRACKED_ATTR_PATHS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BackfillTuning {
    pub workers: usize,
    pub packed_git_window_mib: usize,
    pub packed_git_limit_mib: usize,
    pub delta_base_cache_mib: usize,
    pub sqlite_writer_cache_kib: i64,
    pub sqlite_reader_mmap_bytes: i64,
}

impl BackfillTuning {
    pub(crate) fn for_hardware(
        logical_cores: usize,
        perf_cores: usize,
        total_memory_mib: usize,
    ) -> Self {
        let logical = logical_cores.max(1);
        let cpu_workers = if perf_cores > 0 {
            perf_cores.max((logical * 3) / 4).min(logical)
        } else {
            logical.saturating_sub(2).max(2)
        }
        .clamp(2, 12);

        if total_memory_mib <= 8 * 1024 {
            Self {
                workers: cpu_workers.min(4),
                packed_git_window_mib: 32,
                packed_git_limit_mib: 96,
                delta_base_cache_mib: 16,
                sqlite_writer_cache_kib: -32_768,
                sqlite_reader_mmap_bytes: 33_554_432,
            }
        } else if total_memory_mib <= 16 * 1024 {
            Self {
                workers: cpu_workers.min(6),
                packed_git_window_mib: 32,
                packed_git_limit_mib: 160,
                delta_base_cache_mib: 24,
                sqlite_writer_cache_kib: -49_152,
                sqlite_reader_mmap_bytes: 67_108_864,
            }
        } else if total_memory_mib <= 32 * 1024 {
            Self {
                workers: cpu_workers.min(8),
                packed_git_window_mib: 64,
                packed_git_limit_mib: 256,
                delta_base_cache_mib: 32,
                sqlite_writer_cache_kib: -65_536,
                sqlite_reader_mmap_bytes: 134_217_728,
            }
        } else {
            Self {
                workers: cpu_workers.min(12),
                packed_git_window_mib: 64,
                packed_git_limit_mib: 384,
                delta_base_cache_mib: 48,
                sqlite_writer_cache_kib: -98_304,
                sqlite_reader_mmap_bytes: 134_217_728,
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn probe_host_memory_and_perf_cores() -> (usize, usize) {
    fn sysctl_u64(name: &std::ffi::CStr) -> Option<u64> {
        let mut value = 0_u64;
        let mut size = std::mem::size_of::<u64>();
        // SAFETY: passing valid NUL-terminated sysctl name and output buffer sized for u64.
        let rc = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&mut value as *mut u64).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc == 0 && size == std::mem::size_of::<u64>() {
            Some(value)
        } else {
            None
        }
    }
    fn sysctl_u32(name: &std::ffi::CStr) -> Option<u32> {
        let mut value = 0_u32;
        let mut size = std::mem::size_of::<u32>();
        // SAFETY: passing valid NUL-terminated sysctl name and output buffer sized for u32.
        let rc = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&mut value as *mut u32).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc == 0 && size == std::mem::size_of::<u32>() {
            Some(value)
        } else {
            None
        }
    }
    let total_memory_mib = sysctl_u64(c"hw.memsize")
        .map(|bytes| (bytes / (1024 * 1024)) as usize)
        .filter(|&mib| mib > 0)
        .unwrap_or(8192);
    let perf_cores = sysctl_u32(c"hw.perflevel0.logicalcpu").unwrap_or(0) as usize;
    (perf_cores, total_memory_mib)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn probe_host_memory_and_perf_cores() -> (usize, usize) {
    // SAFETY: _SC_PHYS_PAGES and _SC_PAGESIZE are standard POSIX sysconf queries.
    let pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
    // SAFETY: _SC_PAGESIZE is a standard POSIX sysconf query.
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    let physical_bytes = if pages > 0 && page_size > 0 {
        (pages as u128).saturating_mul(page_size as u128)
    } else {
        0
    };
    let cgroup_bytes = std::fs::read_to_string("/sys/fs/cgroup/memory.max")
        .ok()
        .and_then(|s| s.trim().parse::<u128>().ok());
    let effective_bytes = match (physical_bytes, cgroup_bytes) {
        (0, Some(cg)) => cg,
        (phys, Some(cg)) if cg > 0 && cg < phys => cg,
        (phys, _) => phys,
    };
    let mib = (effective_bytes / (1024 * 1024)) as usize;
    (0, if mib > 0 { mib } else { 8192 })
}

#[cfg(windows)]
fn probe_host_memory_and_perf_cores() -> (usize, usize) {
    #[repr(C)]
    struct MemoryStatusEx {
        dw_length: u32,
        dw_memory_load: u32,
        ull_total_phys: u64,
        ull_avail_phys: u64,
        ull_total_page_file: u64,
        ull_avail_page_file: u64,
        ull_total_virtual: u64,
        ull_avail_virtual: u64,
        ull_avail_extended_virtual: u64,
    }
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
    }
    let mut status = MemoryStatusEx {
        dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    // SAFETY: `status` is properly initialized with exact struct size in `dw_length`.
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    let mib = if ok != 0 && status.ull_total_phys > 0 {
        (status.ull_total_phys / (1024 * 1024)) as usize
    } else {
        8192
    };
    (0, mib)
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "android",
    windows
)))]
fn probe_host_memory_and_perf_cores() -> (usize, usize) {
    (0, 8192)
}

pub(crate) fn host_backfill_tuning() -> BackfillTuning {
    static TUNING: OnceLock<BackfillTuning> = OnceLock::new();
    *TUNING.get_or_init(|| {
        let logical_cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        let (perf_cores, total_memory_mib) = probe_host_memory_and_perf_cores();
        BackfillTuning::for_hardware(logical_cores, perf_cores, total_memory_mib)
    })
}

#[derive(Debug, Clone)]
pub(crate) struct CommitForChanges {
    pub oid: String,
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AttributeStrategy {
    None,
    TrackedPaths(Vec<String>),
    PerCommit,
}

fn fail(message: &str) -> IndexError {
    IndexError {
        code: ErrorCode::GitError,
        message: message.into(),
    }
}

fn git_error(e: crate::git_command::GitFailure) -> IndexError {
    let e = crate::details::from_git(e);
    IndexError {
        code: e.code,
        message: e.message,
    }
}

/// Discovers whether `.gitattributes` exists anywhere in the snapshot history so commits with
/// identical attribute blobs can be batched safely via `diff-tree --stdin`.
pub(crate) fn discover_attributes(
    git: &ReadOnlyGit,
    repo: &Path,
    tips: &[String],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<AttributeStrategy, IndexError> {
    if tips.is_empty() {
        return Ok(AttributeStrategy::None);
    }
    let mut args = vec![
        string_arg("log"),
        string_arg("--full-history"),
        string_arg("-m"),
        string_arg("--raw"),
        string_arg("--no-abbrev"),
        string_arg("--no-renames"),
        string_arg("-z"),
        string_arg("--format="),
    ];
    args.extend(tips.iter().map(string_arg));
    args.extend([
        string_arg("--"),
        string_arg(".gitattributes"),
        string_arg(":(glob)**/.gitattributes"),
    ]);
    let out = match git.run(
        repo,
        &args,
        None,
        ATTR_DISCOVERY_OUTPUT_LIMIT,
        cancelled,
        deadline,
    ) {
        Ok(out) => out,
        Err(GitFailure::ResourceLimit) => return Ok(AttributeStrategy::PerCommit),
        Err(err) => return Err(git_error(err)),
    };
    if !out.status.success() {
        return Err(fail("无法检查历史属性文件"));
    }
    let mut paths = BTreeSet::new();
    let mut fields = out.stdout.split(|b| *b == 0);
    while let Some(field) = fields.next() {
        let trimmed = field.trim_ascii_start();
        if trimmed.starts_with(b":")
            && let Some(path) = fields.next()
            && !path.is_empty()
        {
            paths.insert(path.to_vec());
        }
    }
    if paths.is_empty() {
        return Ok(AttributeStrategy::None);
    }
    if paths.len() > MAX_TRACKED_ATTR_PATHS {
        return Ok(AttributeStrategy::PerCommit);
    }
    let mut utf8_paths = Vec::with_capacity(paths.len());
    for raw in paths {
        let Ok(text) = String::from_utf8(raw) else {
            return Ok(AttributeStrategy::PerCommit);
        };
        if text.contains(['\n', '\r', '\0', ':']) {
            return Ok(AttributeStrategy::PerCommit);
        }
        utf8_paths.push(text);
    }
    Ok(AttributeStrategy::TrackedPaths(utf8_paths))
}

pub(crate) fn read_commits_changes(
    git: &ReadOnlyGit,
    repo: &Path,
    commits: &[CommitForChanges],
    oid_length: usize,
    strategy: &AttributeStrategy,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<Vec<ChangedFile>>, IndexError> {
    if commits.is_empty() {
        return Ok(Vec::new());
    }
    match strategy {
        AttributeStrategy::None => {
            read_same_attr_batch(git, repo, commits, oid_length, None, cancelled, deadline)
        }
        AttributeStrategy::PerCommit => commits
            .iter()
            .map(|c| {
                read_same_attr_batch(
                    git,
                    repo,
                    std::slice::from_ref(c),
                    oid_length,
                    Some(&c.oid),
                    cancelled,
                    deadline,
                )
                .map(|mut v| v.remove(0))
            })
            .collect(),
        AttributeStrategy::TrackedPaths(paths) => {
            if commits.len() == 1 {
                return read_same_attr_batch(
                    git,
                    repo,
                    commits,
                    oid_length,
                    Some(&commits[0].oid),
                    cancelled,
                    deadline,
                );
            }
            let Some(groups) =
                group_by_attr_signature(git, repo, commits, paths, cancelled, deadline)?
            else {
                return read_commits_changes(
                    git,
                    repo,
                    commits,
                    oid_length,
                    &AttributeStrategy::PerCommit,
                    cancelled,
                    deadline,
                );
            };
            let mut results = vec![Vec::new(); commits.len()];
            for (_, indices) in groups {
                let group: Vec<CommitForChanges> =
                    indices.iter().map(|&idx| commits[idx].clone()).collect();
                let source = group[0].oid.as_str();
                let batch_results = read_same_attr_batch(
                    git,
                    repo,
                    &group,
                    oid_length,
                    Some(source),
                    cancelled,
                    deadline,
                )?;
                for (idx, files) in indices.into_iter().zip(batch_results) {
                    results[idx] = files;
                }
            }
            Ok(results)
        }
    }
}

type AttrGroups = BTreeMap<Vec<String>, Vec<usize>>;
type MergeParentPaths = Vec<(String, Vec<Vec<u8>>)>;

fn group_by_attr_signature(
    git: &ReadOnlyGit,
    repo: &Path,
    commits: &[CommitForChanges],
    paths: &[String],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<AttrGroups>, IndexError> {
    let mut input = String::new();
    for commit in commits {
        for path in paths {
            input.push_str(&commit.oid);
            input.push(':');
            input.push_str(path);
            input.push('\n');
        }
    }
    let args = [
        string_arg("cat-file"),
        string_arg("--batch-check=%(objectname)"),
    ];
    let out = match git.run(
        repo,
        &args,
        Some(input.as_bytes()),
        ATTR_BATCH_CHECK_LIMIT,
        cancelled,
        deadline,
    ) {
        Ok(out) => out,
        Err(GitFailure::ResourceLimit) => return Ok(None),
        Err(err) => return Err(git_error(err)),
    };
    if !out.status.success() {
        return Ok(None);
    }
    let Ok(stdout) = std::str::from_utf8(&out.stdout) else {
        return Ok(None);
    };
    let mut lines: Vec<&str> = stdout
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let expected = commits.len().saturating_mul(paths.len());
    if lines.len() != expected {
        return Ok(None);
    }
    let mut groups: BTreeMap<Vec<String>, Vec<usize>> = BTreeMap::new();
    for (commit_idx, chunk) in lines.chunks_exact(paths.len()).enumerate() {
        let signature: Vec<String> = chunk
            .iter()
            .map(|line| {
                if line.ends_with(" missing") {
                    String::new()
                } else {
                    (*line).to_owned()
                }
            })
            .collect();
        groups.entry(signature).or_default().push(commit_idx);
    }
    Ok(Some(groups))
}

fn read_same_attr_batch(
    git: &ReadOnlyGit,
    repo: &Path,
    commits: &[CommitForChanges],
    oid_length: usize,
    attr_source: Option<&str>,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<Vec<ChangedFile>>, IndexError> {
    if commits.is_empty() {
        return Ok(Vec::new());
    }
    let tuning = host_backfill_tuning();
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let source = attr_source.unwrap_or(&commits[0].oid);
    let mut args = vec![
        string_arg("-c"),
        string_arg(format!("core.attributesFile={null}")),
        string_arg("-c"),
        string_arg("core.bigFileThreshold=2m"),
        string_arg("-c"),
        string_arg(format!(
            "core.packedGitWindowSize={}m",
            tuning.packed_git_window_mib
        )),
        string_arg("-c"),
        string_arg(format!(
            "core.packedGitLimit={}m",
            tuning.packed_git_limit_mib
        )),
        string_arg("-c"),
        string_arg(format!(
            "core.deltaBaseCacheLimit={}m",
            tuning.delta_base_cache_mib
        )),
        string_arg(format!("--attr-source={source}")),
    ];
    args.extend(
        [
            "diff-tree",
            "--stdin",
            "--always",
            "--root",
            "-r",
            "--raw",
            "--numstat",
            "-z",
            "--no-abbrev",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=none",
            "--no-relative",
            "--submodule=short",
            "--diff-algorithm=myers",
            "--indent-heuristic",
            "--find-renames=50%",
            "-l20000",
        ]
        .iter()
        .map(string_arg),
    );
    args.push(string_arg(format!("-O{null}")));
    args.push(string_arg("--"));
    let mut input = String::new();
    for c in commits {
        input.push_str(&c.oid);
        if let Some(parent) = c.parents.first() {
            input.push(' ');
            input.push_str(parent);
        }
        input.push('\n');
    }
    let out = match git.run(
        repo,
        &args,
        Some(input.as_bytes()),
        DIFF_TREE_OUTPUT_LIMIT,
        cancelled,
        deadline,
    ) {
        Ok(out) => out,
        Err(GitFailure::ResourceLimit) if commits.len() > 1 => {
            let mid = commits.len() / 2;
            let mut left = read_same_attr_batch(
                git,
                repo,
                &commits[..mid],
                oid_length,
                attr_source,
                cancelled,
                deadline,
            )?;
            let right = read_same_attr_batch(
                git,
                repo,
                &commits[mid..],
                oid_length,
                attr_source,
                cancelled,
                deadline,
            )?;
            left.extend(right);
            return Ok(left);
        }
        Err(err) => return Err(git_error(err)),
    };
    if !out.status.success() {
        return Err(fail(&format!(
            "文件改动索引失败：{}",
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let warnings = String::from_utf8_lossy(&out.stderr);
    if warnings.contains("rename detection") || warnings.contains("too many files") {
        return Err(IndexError {
            code: ErrorCode::ResourceLimit,
            message: "重命名检测超过上限；未保存不完整文件统计".into(),
        });
    }
    parse_batch(&out.stdout, commits, oid_length)
}

/// Reads raw changed paths between merge commits and non-first parents in one batched `diff-tree`
/// invocation without computing line stats or rename detection.
pub(crate) fn read_merge_parent_paths(
    git: &ReadOnlyGit,
    repo: &Path,
    pairs: &[(String, String)],
    boundary_limited: bool,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<MergeParentPaths, IndexError> {
    if pairs.is_empty() {
        return Ok(Vec::new());
    }
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut args = Vec::new();
    if boundary_limited {
        args.push(string_arg("-c"));
        args.push(string_arg("core.commitGraph=false"));
    }
    let tuning = host_backfill_tuning();
    args.extend([
        string_arg("-c"),
        string_arg(format!("core.attributesFile={null}")),
        string_arg("-c"),
        string_arg("diff.external="),
        string_arg("-c"),
        string_arg(format!(
            "core.packedGitWindowSize={}m",
            tuning.packed_git_window_mib
        )),
        string_arg("-c"),
        string_arg(format!(
            "core.packedGitLimit={}m",
            tuning.packed_git_limit_mib
        )),
        string_arg("-c"),
        string_arg(format!(
            "core.deltaBaseCacheLimit={}m",
            tuning.delta_base_cache_mib
        )),
        string_arg("diff-tree"),
        string_arg("--stdin"),
        string_arg("--always"),
        string_arg("-r"),
        string_arg("--raw"),
        string_arg("--no-renames"),
        string_arg("-z"),
        string_arg("--no-abbrev"),
        string_arg("--no-ext-diff"),
        string_arg("--no-textconv"),
        string_arg("--ignore-submodules=none"),
        string_arg("--no-relative"),
        string_arg("--submodule=short"),
        string_arg(format!("-O{null}")),
        string_arg("--"),
    ]);
    let mut input = String::new();
    for (commit, parent) in pairs {
        input.push_str(commit);
        input.push(' ');
        input.push_str(parent);
        input.push('\n');
    }
    let out = match git.run(
        repo,
        &args,
        Some(input.as_bytes()),
        MERGE_PATH_DIFF_LIMIT,
        cancelled,
        deadline,
    ) {
        Ok(out) => out,
        Err(GitFailure::ResourceLimit) if pairs.len() > 1 => {
            let mid = pairs.len() / 2;
            let mut left = read_merge_parent_paths(
                git,
                repo,
                &pairs[..mid],
                boundary_limited,
                cancelled,
                deadline,
            )?;
            let right = read_merge_parent_paths(
                git,
                repo,
                &pairs[mid..],
                boundary_limited,
                cancelled,
                deadline,
            )?;
            left.extend(right);
            return Ok(left);
        }
        Err(err) => return Err(git_error(err)),
    };
    if !out.status.success() {
        return Err(fail(&format!(
            "文件改动索引失败：{}",
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let fields: Vec<&[u8]> = out.stdout.split(|b| *b == 0).collect();
    let mut field_index = 0usize;
    let mut results = Vec::with_capacity(pairs.len());
    for (commit_oid, _) in pairs {
        while field_index < fields.len() && fields[field_index].is_empty() {
            field_index += 1;
        }
        let header = fields
            .get(field_index)
            .ok_or_else(|| fail("合并路径输出被截断"))?;
        let header_oid = header
            .split(|b| b.is_ascii_whitespace())
            .next()
            .unwrap_or_default();
        if header_oid != commit_oid.as_bytes() {
            return Err(fail("合并路径分组与提交 OID 不匹配"));
        }
        field_index += 1;
        let mut paths = Vec::new();
        while field_index < fields.len() && fields[field_index].first() == Some(&b':') {
            let raw_header = fields[field_index];
            let status = raw_header
                .rsplit(|b| b.is_ascii_whitespace())
                .next()
                .unwrap_or_default();
            if status
                .first()
                .is_some_and(|kind| matches!(kind, b'R' | b'C'))
            {
                return Err(fail("合并路径意外开启了重命名检测"));
            }
            field_index += 1;
            let path = fields
                .get(field_index)
                .ok_or_else(|| fail("合并路径记录缺少路径字段"))?;
            if !path.is_empty() {
                paths.push((*path).to_vec());
            }
            field_index += 1;
        }
        results.push((commit_oid.clone(), paths));
    }
    if fields[field_index..]
        .iter()
        .any(|f| !f.is_empty() && f.first() == Some(&b':'))
    {
        return Err(fail("合并路径输出包含多余记录"));
    }
    Ok(results)
}

fn parse_batch(
    bytes: &[u8],
    commits: &[CommitForChanges],
    oid_length: usize,
) -> Result<Vec<Vec<ChangedFile>>, IndexError> {
    let fields: Vec<&[u8]> = bytes.split(|b| *b == 0).collect();
    let mut pos = 0;
    let mut offset = 0;
    let mut result = Vec::new();
    for c in commits {
        if fields.get(pos).copied() != Some(c.oid.as_bytes()) {
            return Err(fail("文件改动分组与提交 OID 不匹配"));
        }
        offset += fields[pos].len() + 1;
        pos += 1;
        let start = offset;
        while let Some(field) = fields.get(pos) {
            let consume = if field.first() == Some(&b':') {
                let status = field.rsplit(|b| *b == b' ').next().unwrap_or_default();
                if matches!(status.first(), Some(b'R' | b'C')) {
                    3
                } else {
                    2
                }
            } else if field.contains(&b'\t') {
                if field.ends_with(b"\t") { 3 } else { 1 }
            } else {
                break;
            };
            if pos + consume > fields.len() {
                return Err(fail("文件改动输出被截断"));
            }
            for field in &fields[pos..pos + consume] {
                offset += field.len() + 1;
            }
            pos += consume;
        }
        if offset > bytes.len() {
            return Err(fail("文件改动输出边界无效"));
        }
        result.push(
            crate::details::parse_diff_output(&bytes[start..offset], oid_length).map_err(|e| {
                IndexError {
                    code: e.code,
                    message: e.message,
                }
            })?,
        );
    }
    if fields[pos..].iter().any(|f| !f.is_empty()) {
        return Err(fail("文件改动输出包含多余分组"));
    }
    Ok(result)
}

pub(crate) fn decode_hex(hex: &str) -> Result<Vec<u8>, IndexError> {
    if !hex.len().is_multiple_of(2) || hex.len() > 32768 {
        return Err(fail("无效原始路径编码"));
    }
    hex.as_bytes()
        .chunks_exact(2)
        .map(|v| {
            std::str::from_utf8(v)
                .ok()
                .and_then(|s| u8::from_str_radix(s, 16).ok())
                .ok_or_else(|| fail("无效原始路径编码"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
        time::Duration,
    };

    static NEXT_REPO: AtomicU64 = AtomicU64::new(1);

    struct TestRepo(PathBuf);

    impl TestRepo {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "commitscope-change-index-{}-{}",
                std::process::id(),
                NEXT_REPO.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            git(&path, &["init", "-q", "-b", "main"]);
            git(&path, &["config", "user.name", "Change Index Test"]);
            git(&path, &["config", "user.email", "changes@example.test"]);
            Self(path)
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git(path: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    fn meta(repo: &Path, rev: &str) -> CommitForChanges {
        let oid = git(repo, &["rev-parse", rev]);
        let parents_line = git(repo, &["show", "-s", "--format=%P", &oid]);
        let parents = parents_line.split_whitespace().map(str::to_owned).collect();
        CommitForChanges { oid, parents }
    }

    fn test_git_path() -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|entry| entry.join(if cfg!(windows) { "git.exe" } else { "git" }))
            .find(|candidate| candidate.is_file())
            .expect("Git binary on PATH")
    }

    #[test]
    fn grouped_attributes_and_batched_merge_paths_match_per_commit_semantics() {
        let repo = TestRepo::new();
        let ro_git = ReadOnlyGit::new(test_git_path()).unwrap();
        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(30);

        fs::write(repo.0.join("a.dat"), "one\ntwo\n").unwrap();
        git(&repo.0, &["add", "a.dat"]);
        git(&repo.0, &["commit", "-qm", "c1 text before attrs"]);
        let c1 = meta(&repo.0, "HEAD");

        assert_eq!(
            discover_attributes(
                &ro_git,
                &repo.0,
                std::slice::from_ref(&c1.oid),
                &cancelled,
                deadline
            )
            .unwrap(),
            AttributeStrategy::None
        );

        fs::write(repo.0.join(".gitattributes"), "*.dat binary\n").unwrap();
        git(&repo.0, &["add", ".gitattributes"]);
        git(&repo.0, &["commit", "-qm", "c2 enable binary rule"]);
        let c2 = meta(&repo.0, "HEAD");

        fs::write(repo.0.join("b.dat"), "line1\nline2\n").unwrap();
        git(&repo.0, &["add", "b.dat"]);
        git(&repo.0, &["commit", "-qm", "c3 dat is binary"]);
        let c3 = meta(&repo.0, "HEAD");

        // Side branch adds a file merged back into main to test non-first-parent raw path batching.
        git(&repo.0, &["checkout", "-qb", "side"]);
        fs::write(repo.0.join("side-only.txt"), "side\n").unwrap();
        git(&repo.0, &["add", "side-only.txt"]);
        git(&repo.0, &["commit", "-qm", "side commit"]);
        git(&repo.0, &["checkout", "-q", "main"]);
        fs::write(repo.0.join("main.txt"), "main\n").unwrap();
        git(&repo.0, &["add", "main.txt"]);
        git(&repo.0, &["commit", "-qm", "c4 main commit"]);
        let c4 = meta(&repo.0, "HEAD");

        git(
            &repo.0,
            &["merge", "--no-ff", "-m", "m5 merge side", "side"],
        );
        let m5 = meta(&repo.0, "HEAD");

        assert_eq!(
            discover_attributes(
                &ro_git,
                &repo.0,
                std::slice::from_ref(&m5.oid),
                &cancelled,
                deadline
            )
            .unwrap(),
            AttributeStrategy::TrackedPaths(vec![".gitattributes".into()])
        );

        let strategy = AttributeStrategy::TrackedPaths(vec![".gitattributes".into()]);
        let changes = read_commits_changes(
            &ro_git,
            &repo.0,
            &[m5.clone(), c4, c3, c2, c1],
            40,
            &strategy,
            &cancelled,
            deadline,
        )
        .unwrap();
        assert_eq!(changes.len(), 5);
        // c1 (index 4): before `.gitattributes` existed -> a.dat is text (2 additions).
        assert!(!changes[4][0].binary);
        assert_eq!(changes[4][0].additions, Some(2));
        // c3 (index 2): `.gitattributes` marks *.dat binary -> b.dat is binary.
        assert!(changes[2][0].binary);
        assert_eq!(changes[2][0].additions, None);

        let merge_pairs = vec![(m5.oid.clone(), m5.parents[1].clone())];
        let merge_paths =
            read_merge_parent_paths(&ro_git, &repo.0, &merge_pairs, false, &cancelled, deadline)
                .unwrap();
        assert_eq!(merge_paths.len(), 1);
        assert!(merge_paths[0].1.contains(&b"main.txt".to_vec()));
    }

    #[test]
    fn adaptive_backfill_tuning_scales_across_hardware_tiers_and_host_probe_succeeds() {
        let low = BackfillTuning::for_hardware(8, 0, 8 * 1024);
        assert_eq!(low.workers, 4);
        assert_eq!(low.packed_git_limit_mib, 96);
        assert_eq!(low.sqlite_reader_mmap_bytes, 33_554_432);

        let mid = BackfillTuning::for_hardware(8, 6, 16 * 1024);
        assert_eq!(mid.workers, 6);
        assert_eq!(mid.packed_git_limit_mib, 160);
        assert_eq!(mid.sqlite_reader_mmap_bytes, 67_108_864);

        let high = BackfillTuning::for_hardware(10, 8, 32 * 1024);
        assert_eq!(high.workers, 8);
        assert_eq!(high.packed_git_window_mib, 64);
        assert_eq!(high.packed_git_limit_mib, 256);
        assert_eq!(high.sqlite_reader_mmap_bytes, 134_217_728);

        let workstation = BackfillTuning::for_hardware(16, 12, 64 * 1024);
        assert_eq!(workstation.workers, 12);
        assert_eq!(workstation.packed_git_limit_mib, 384);
        assert_eq!(workstation.sqlite_writer_cache_kib, -98_304);

        let host = host_backfill_tuning();
        assert!((2..=12).contains(&host.workers));
        assert!(host.packed_git_limit_mib >= 96);
    }
}
