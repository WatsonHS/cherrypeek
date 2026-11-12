//! First-parent file changes; raw paths are persisted as SQLite BLOBs.
use crate::{
    git_command::{ReadOnlyGit, string_arg},
    metadata_index::IndexError,
    repository::ParsedCommitMetadata,
};
use commitscope_core::{ChangedFile, ErrorCode};
use std::{path::Path, sync::atomic::AtomicBool, time::Instant};
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
pub(crate) fn has_attributes(
    git: &ReadOnlyGit,
    repo: &Path,
    tips: &[String],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<bool, IndexError> {
    let mut args = vec![
        string_arg("log"),
        string_arg("-1"),
        string_arg("--format=%H"),
    ];
    args.extend(tips.iter().map(string_arg));
    args.extend([
        string_arg("--"),
        string_arg(".gitattributes"),
        string_arg(":(glob)**/.gitattributes"),
    ]);
    let out = git
        .run(repo, &args, None, 4096, cancelled, deadline)
        .map_err(git_error)?;
    if !out.status.success() {
        return Err(fail("无法检查历史属性文件"));
    }
    Ok(!out.stdout.is_empty())
}
pub(crate) fn read_batch(
    git: &ReadOnlyGit,
    repo: &Path,
    commits: &[ParsedCommitMetadata],
    oid_length: usize,
    attributes: bool,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<Vec<ChangedFile>>, IndexError> {
    if attributes && commits.len() > 1 {
        return commits
            .iter()
            .map(|c| {
                read_batch(
                    git,
                    repo,
                    std::slice::from_ref(c),
                    oid_length,
                    true,
                    cancelled,
                    deadline,
                )
                .map(|mut v| v.remove(0))
            })
            .collect();
    }
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut args = vec![
        string_arg("-c"),
        string_arg(format!("core.attributesFile={null}")),
    ];
    args.push(string_arg(format!(
        "--attr-source={}",
        commits[0].summary.oid
    )));
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
        input.push_str(&c.summary.oid);
        if let Some(parent) = c.summary.parents.first() {
            input.push(' ');
            input.push_str(parent);
        }
        input.push('\n');
    }
    let out = git
        .run(
            repo,
            &args,
            Some(input.as_bytes()),
            32 * 1024 * 1024,
            cancelled,
            deadline,
        )
        .map_err(git_error)?;
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
fn parse_batch(
    bytes: &[u8],
    commits: &[ParsedCommitMetadata],
    oid_length: usize,
) -> Result<Vec<Vec<ChangedFile>>, IndexError> {
    let fields: Vec<&[u8]> = bytes.split(|b| *b == 0).collect();
    let mut pos = 0;
    let mut offset = 0;
    let mut result = Vec::new();
    for c in commits {
        if fields.get(pos).copied() != Some(c.summary.oid.as_bytes()) {
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
