//! P4-12: blame of one file at one commit. Runs `git blame --incremental` by object ID, ignores the
//! repository's ignore-revs list, follows only whole-file renames, and streams blocks in bounded
//! chunks. Finished results are cached by (commit, path) in the application data directory, never
//! in the repository.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::{Duration, Instant, SystemTime},
};

use commitscope_core::{
    BlameBlock, BlameChunk, BlameCommit, ErrorCode, GitPath, ReadBlameParams, TreeEntryKind,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    details::{
        DetailError, detail_error, from_git, git_path, hex_decode, raw_path_arg, validate_oid,
        validate_path_hex,
    },
    files::{BINARY_SNIFF, commit_args, count_lines, lookup_entry, read_blob},
    git_command::{GitFailure, ReadOnlyGit, string_arg},
    repository, session,
    session_store::SessionStore,
};

type BlameResult<T> = Result<T, DetailError>;

pub const BLAME_TIMEOUT: Duration = Duration::from_secs(55);
const FILE_BYTE_LIMIT: u64 = 1024 * 1024;
const FILE_LINE_LIMIT: u64 = 20_000;
const LINE_BYTES: usize = 64 * 1024;
const CHUNK_ITEMS: usize = 5_000;
/// Chunk payload budget, well under the 512 KiB response target once the envelope is added.
const CHUNK_BYTES: usize = 320 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_millis(200);
const SUMMARY_LIMIT: usize = 4 * 1024;
const IDENTITY_LIMIT: usize = 1024;
const CACHE_VERSION: u32 = 1;
const CACHE_ENTRY_LIMIT: u64 = 32 * 1024 * 1024;
const CACHE_TOTAL_LIMIT: u64 = 128 * 1024 * 1024;

/// Receives each chunk; `true` marks the last one. Returns false when the request can no longer be answered.
pub type Emit<'a> = dyn FnMut(BlameChunk, bool) -> bool + 'a;

fn cancelled_error() -> DetailError {
    detail_error(ErrorCode::Cancelled, "Request was cancelled", false)
}

fn cut(text: &str, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.to_owned(), false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

/// Groups blocks into chunks; a commit travels with the first block that names it.
struct ChunkBuilder<'e, 'a> {
    commit: String,
    path: GitPath,
    total_lines: u32,
    blocks: Vec<BlameBlock>,
    commits: Vec<BlameCommit>,
    bytes: usize,
    sent_blocks: u32,
    last_flush: Instant,
    emit: &'e mut Emit<'a>,
}

impl ChunkBuilder<'_, '_> {
    fn push(
        &mut self,
        block: BlameBlock,
        commit: Option<BlameCommit>,
        streaming: bool,
    ) -> BlameResult<()> {
        let size = serde_json::to_vec(&block).map_or(256, |bytes| bytes.len() + 1)
            + commit.as_ref().map_or(0, |commit| {
                serde_json::to_vec(commit).map_or(16 * 1024, |bytes| bytes.len() + 1)
            });
        if !self.blocks.is_empty()
            && (self.blocks.len() == CHUNK_ITEMS
                || self.commits.len() + usize::from(commit.is_some()) > CHUNK_ITEMS
                || self.bytes + size > CHUNK_BYTES)
        {
            self.flush(false)?;
        }
        self.blocks.push(block);
        self.commits.extend(commit);
        self.bytes += size;
        if streaming && self.last_flush.elapsed() >= FLUSH_INTERVAL {
            self.flush(false)?;
        }
        Ok(())
    }

    fn flush(&mut self, done: bool) -> BlameResult<()> {
        self.sent_blocks += u32::try_from(self.blocks.len()).unwrap_or(u32::MAX);
        let chunk = BlameChunk {
            commit: self.commit.clone(),
            path: self.path.clone(),
            total_lines: self.total_lines,
            blocks: std::mem::take(&mut self.blocks),
            commits: std::mem::take(&mut self.commits),
        };
        self.bytes = 0;
        self.last_flush = Instant::now();
        if (self.emit)(chunk, done) {
            Ok(())
        } else {
            Err(cancelled_error())
        }
    }
}

pub fn read_blame(
    executable: &Path,
    session: &session::RepositorySession,
    params: &ReadBlameParams,
    cancelled: &AtomicBool,
    deadline: Instant,
    emit: &mut Emit<'_>,
) -> BlameResult<u32> {
    let cache = if repository::history_boundary_limited(&session.discovered) {
        None
    } else {
        SessionStore::from_env()
            .blame_cache_root(&session.discovered.info)
            .ok()
            .map(|root| BlameCache { root })
    };
    read_blame_at(
        executable,
        Path::new(&session.discovered.info.path),
        session.discovered.oid_length,
        cache.as_ref(),
        params,
        cancelled,
        deadline,
        emit,
    )
}

#[allow(clippy::too_many_arguments)]
fn read_blame_at(
    executable: &Path,
    repo: &Path,
    oid_length: usize,
    cache: Option<&BlameCache>,
    params: &ReadBlameParams,
    cancelled: &AtomicBool,
    deadline: Instant,
    emit: &mut Emit<'_>,
) -> BlameResult<u32> {
    let commit = params.commit.to_ascii_lowercase();
    let path_hex = params.path_hex.to_ascii_lowercase();
    validate_oid(&commit, oid_length)?;
    validate_path_hex(Some(&path_hex))?;
    let path_bytes = hex_decode(&path_hex).map_err(|()| {
        detail_error(
            ErrorCode::InvalidRequest,
            "Invalid raw repository path",
            false,
        )
    })?;
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    let entry = lookup_entry(
        &git, repo, &commit, &path_hex, oid_length, cancelled, deadline,
    )?
    .ok_or_else(|| {
        detail_error(
            ErrorCode::MissingObject,
            "The file does not exist at this commit",
            false,
        )
    })?;
    if entry.kind != TreeEntryKind::File {
        return Err(detail_error(
            ErrorCode::InvalidRequest,
            "Only regular files can be blamed",
            false,
        ));
    }
    if entry.size.unwrap_or(u64::MAX) > FILE_BYTE_LIMIT {
        return Err(detail_error(
            ErrorCode::ResourceLimit,
            "The file is over the 1 MiB blame limit",
            false,
        ));
    }
    let content = read_blob(
        &git,
        repo,
        &entry.oid,
        FILE_BYTE_LIMIT as usize + 1,
        cancelled,
        deadline,
    )?;
    if content[..content.len().min(BINARY_SNIFF)].contains(&0) {
        return Err(detail_error(
            ErrorCode::InvalidRequest,
            "Binary files cannot be blamed",
            false,
        ));
    }
    let total = count_lines(&content);
    if total > FILE_LINE_LIMIT {
        return Err(detail_error(
            ErrorCode::ResourceLimit,
            "The file is over the 20,000 line blame limit",
            false,
        ));
    }
    let total_lines = total as u32;
    let mut builder = ChunkBuilder {
        commit: commit.clone(),
        path: git_path(path_bytes.clone()),
        total_lines,
        blocks: Vec::new(),
        commits: Vec::new(),
        bytes: 0,
        sent_blocks: 0,
        last_flush: Instant::now(),
        emit,
    };

    if let Some(cached) = cache.and_then(|cache| cache.load(&commit, &path_hex, total_lines)) {
        let commits: HashMap<&str, &BlameCommit> = cached
            .commits
            .iter()
            .map(|item| (item.oid.as_str(), item))
            .collect();
        let mut sent = HashSet::new();
        for block in &cached.blocks {
            let first = sent.insert(block.oid.clone());
            let commit = first
                .then(|| commits.get(block.oid.as_str()).map(|item| (*item).clone()))
                .flatten();
            builder.push(block.clone(), commit, false)?;
        }
        builder.flush(true)?;
        return Ok(builder.sent_blocks);
    }

    let mut args = commit_args(&commit);
    args.splice(0..0, [string_arg("-c"), string_arg("core.quotePath=false")]);
    args.extend([
        string_arg("blame"),
        string_arg("--incremental"),
        string_arg("--no-textconv"),
        string_arg("--no-ignore-revs-file"),
        string_arg(&commit),
        string_arg("--"),
        raw_path_arg(&path_hex)?,
    ]);
    let mut stream = git
        .stream_lines(repo, &args, LINE_BYTES)
        .map_err(from_git)?;
    let mut parser = IncrementalParser::new(oid_length, path_bytes);
    let mut covered = vec![false; total_lines as usize];
    let mut all_blocks = Vec::new();
    let mut all_commits = Vec::new();
    loop {
        let line = match stream.next_line(cancelled, deadline) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(GitFailure::ResourceLimit) => {
                return Err(detail_error(
                    ErrorCode::ResourceLimit,
                    "A blame output line is too long",
                    false,
                ));
            }
            Err(error) => return Err(from_git(error)),
        };
        let Some((block, commit)) = parser.line(&line)? else {
            continue;
        };
        let start = block.start_line as usize;
        let end = start + block.line_count as usize;
        if block.line_count == 0
            || start == 0
            || end - 1 > covered.len()
            || covered[start - 1..end - 1].iter().any(|line| *line)
        {
            return Err(detail_error(
                ErrorCode::GitError,
                "Blame output does not match the file",
                false,
            ));
        }
        covered[start - 1..end - 1]
            .iter_mut()
            .for_each(|line| *line = true);
        all_blocks.push(block.clone());
        all_commits.extend(commit.clone());
        builder.push(block, commit, true)?;
    }
    drop(stream);
    if covered.iter().any(|line| !line) {
        return Err(detail_error(
            ErrorCode::GitError,
            "Blame output did not cover the file",
            false,
        ));
    }
    builder.flush(true)?;
    if let Some(cache) = cache {
        cache.store(&CachedBlame {
            version: CACHE_VERSION,
            commit,
            path_hex,
            total_lines,
            blocks: all_blocks,
            commits: all_commits,
        });
    }
    Ok(builder.sent_blocks)
}

#[derive(Debug, Default)]
struct PendingCommit {
    author_name: Option<String>,
    author_email: Option<String>,
    author_time: Option<i64>,
    summary: Option<(String, bool)>,
    lossy: bool,
}

/// Parses `git blame --incremental`: a "<oid> <orig> <final> <count>" header, commit attributes the
/// first time a commit appears, then "filename <path>" closing the group.
struct IncrementalParser {
    oid_length: usize,
    path: Vec<u8>,
    header: Option<(String, u32, u32, u32)>,
    pending: HashMap<String, PendingCommit>,
    emitted: HashSet<String>,
}

impl IncrementalParser {
    fn new(oid_length: usize, path: Vec<u8>) -> Self {
        Self {
            oid_length,
            path,
            header: None,
            pending: HashMap::new(),
            emitted: HashSet::new(),
        }
    }

    fn line(&mut self, line: &[u8]) -> BlameResult<Option<(BlameBlock, Option<BlameCommit>)>> {
        let malformed = || detail_error(ErrorCode::GitError, "Malformed blame output", false);
        let Some((oid, original_start, start, count)) = self.header.clone() else {
            let text = std::str::from_utf8(line).map_err(|_| malformed())?;
            let parts: Vec<&str> = text.split(' ').collect();
            if parts.len() != 4
                || parts[0].len() != self.oid_length
                || !parts[0].bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(malformed());
            }
            let number = |value: &str| value.parse::<u32>().map_err(|_| malformed());
            self.header = Some((
                parts[0].to_ascii_lowercase(),
                number(parts[1])?,
                number(parts[2])?,
                number(parts[3])?,
            ));
            return Ok(None);
        };
        if let Some(raw) = line.strip_prefix(b"filename ") {
            self.header = None;
            let original = unquote(raw);
            let commit = if self.emitted.insert(oid.clone()) {
                let pending = self.pending.remove(&oid).unwrap_or_default();
                let (summary, summary_truncated) = pending.summary.unwrap_or_default();
                Some(BlameCommit {
                    oid: oid.clone(),
                    summary,
                    summary_truncated,
                    author_name: pending.author_name.unwrap_or_default(),
                    author_email: pending.author_email.unwrap_or_default(),
                    author_time: pending.author_time.unwrap_or(0),
                    text_lossy: pending.lossy,
                })
            } else {
                None
            };
            let block = BlameBlock {
                start_line: start,
                line_count: count,
                oid,
                original_start_line: original_start,
                original_path: (original != self.path).then(|| git_path(original)),
            };
            return Ok(Some((block, commit)));
        }
        if self.emitted.contains(&oid) {
            return Ok(None);
        }
        let entry = self.pending.entry(oid).or_default();
        let space = line
            .iter()
            .position(|byte| *byte == b' ')
            .unwrap_or(line.len());
        let (key, value) = (&line[..space], line.get(space + 1..).unwrap_or_default());
        let decoded = String::from_utf8_lossy(value);
        let lossy = matches!(decoded, std::borrow::Cow::Owned(_));
        match key {
            b"author" => {
                entry.author_name = Some(cut(&decoded, IDENTITY_LIMIT).0);
                entry.lossy |= lossy;
            }
            b"author-mail" => {
                let email = decoded
                    .strip_prefix('<')
                    .and_then(|value| value.strip_suffix('>'))
                    .unwrap_or(&decoded);
                entry.author_email = Some(cut(email, IDENTITY_LIMIT).0);
                entry.lossy |= lossy;
            }
            b"author-time" => entry.author_time = decoded.parse::<i64>().ok(),
            b"summary" => {
                entry.summary = Some(cut(&decoded, SUMMARY_LIMIT));
                entry.lossy |= lossy;
            }
            _ => {}
        }
        Ok(None)
    }
}

/// Undoes Git's C-style path quoting ("a\tb", "\303\251").
fn unquote(raw: &[u8]) -> Vec<u8> {
    let Some(inner) = raw
        .strip_prefix(b"\"")
        .and_then(|rest| rest.strip_suffix(b"\""))
    else {
        return raw.to_vec();
    };
    let mut output = Vec::with_capacity(inner.len());
    let mut index = 0;
    while index < inner.len() {
        let byte = inner[index];
        index += 1;
        if byte != b'\\' || index == inner.len() {
            output.push(byte);
            continue;
        }
        let escaped = inner[index];
        index += 1;
        match escaped {
            b'a' => output.push(0x07),
            b'b' => output.push(0x08),
            b'f' => output.push(0x0c),
            b'n' => output.push(b'\n'),
            b'r' => output.push(b'\r'),
            b't' => output.push(b'\t'),
            b'v' => output.push(0x0b),
            b'0'..=b'3'
                if inner.get(index..index + 2).is_some_and(|digits| {
                    digits.iter().all(|digit| (b'0'..=b'7').contains(digit))
                }) =>
            {
                let digits = &inner[index..index + 2];
                output.push((escaped - b'0') * 64 + (digits[0] - b'0') * 8 + (digits[1] - b'0'));
                index += 2;
            }
            other => output.push(other),
        }
    }
    output
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedBlame {
    version: u32,
    commit: String,
    path_hex: String,
    total_lines: u32,
    blocks: Vec<BlameBlock>,
    commits: Vec<BlameCommit>,
}

struct BlameCache {
    root: PathBuf,
}

impl BlameCache {
    fn file(&self, commit: &str, path_hex: &str) -> PathBuf {
        let digest = Sha256::digest(format!("{commit}\0{path_hex}").as_bytes());
        let name: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        self.root.join(format!("{name}.json"))
    }

    fn load(&self, commit: &str, path_hex: &str, total_lines: u32) -> Option<CachedBlame> {
        let path = self.file(commit, path_hex);
        let meta = fs::symlink_metadata(&path).ok()?;
        if !meta.is_file() || meta.len() > CACHE_ENTRY_LIMIT {
            return None;
        }
        let mut bytes = Vec::new();
        fs::File::open(&path)
            .ok()?
            .take(CACHE_ENTRY_LIMIT)
            .read_to_end(&mut bytes)
            .ok()?;
        let cached: CachedBlame = match serde_json::from_slice(&bytes) {
            Ok(cached) => cached,
            Err(_) => {
                let _ = fs::remove_file(&path);
                return None;
            }
        };
        let covered: u64 = cached
            .blocks
            .iter()
            .map(|block| u64::from(block.line_count))
            .sum();
        let named: HashSet<&str> = cached
            .commits
            .iter()
            .map(|commit| commit.oid.as_str())
            .collect();
        if cached.version != CACHE_VERSION
            || cached.commit != commit
            || cached.path_hex != path_hex
            || cached.total_lines != total_lines
            || covered != u64::from(total_lines)
            || cached
                .blocks
                .iter()
                .any(|block| !named.contains(block.oid.as_str()))
        {
            let _ = fs::remove_file(&path);
            return None;
        }
        // Recently used entries survive eviction.
        if let Ok(handle) = fs::OpenOptions::new().write(true).open(&path) {
            let _ = handle.set_modified(SystemTime::now());
        }
        Some(cached)
    }

    fn store(&self, cached: &CachedBlame) {
        let Ok(bytes) = serde_json::to_vec(cached) else {
            return;
        };
        if bytes.len() as u64 > CACHE_ENTRY_LIMIT {
            return;
        }
        let target = self.file(&cached.commit, &cached.path_hex);
        let temporary = target.with_extension(format!("{}.tmp", std::process::id()));
        let written = fs::File::create(&temporary)
            .and_then(|mut file| file.write_all(&bytes).and_then(|()| file.sync_all()));
        if written.is_err() || fs::rename(&temporary, &target).is_err() {
            let _ = fs::remove_file(&temporary);
            return;
        }
        self.evict();
    }

    /// Least recently used entries go first once the cache is over its total size.
    fn evict(&self) {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        let mut files: Vec<(SystemTime, u64, PathBuf)> = entries
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
            })
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                Some((
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    meta.len(),
                    entry.path(),
                ))
            })
            .collect();
        let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
        if total <= CACHE_TOTAL_LIMIT {
            return;
        }
        files.sort();
        for (_, size, path) in files {
            if total <= CACHE_TOTAL_LIMIT * 3 / 4 {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total -= size;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    struct TestDir(PathBuf);

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git_path_bin() -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|entry| entry.join(if cfg!(windows) { "git.exe" } else { "git" }))
            .find(|candidate| candidate.is_file())
            .expect("Git is available for the blame unit tests")
    }

    fn run(git: &Path, repository: &Path, args: &[&str], date: &str) -> String {
        let output = std::process::Command::new(git)
            .arg("-C")
            .arg(repository)
            .args([
                "-c",
                "user.name=Blame Test",
                "-c",
                "user.email=blame@example.invalid",
            ])
            .args(args)
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
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

    /// old.txt with 4 lines, renamed to "new file.txt", then line 2 edited.
    fn fixture(label: &str) -> (PathBuf, TestDir, Vec<String>) {
        let git = git_path_bin();
        let path =
            std::env::temp_dir().join(format!("commitscope-blame-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        run(
            &git,
            &path,
            &["init", "--quiet", "-b", "main"],
            "2026-01-01T00:00:00Z",
        );
        fs::write(path.join("old.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        run(&git, &path, &["add", "."], "2026-01-01T00:00:00Z");
        run(
            &git,
            &path,
            &["commit", "--quiet", "-m", "root"],
            "2026-01-01T00:00:00Z",
        );
        run(
            &git,
            &path,
            &["mv", "old.txt", "new file.txt"],
            "2026-01-02T00:00:00Z",
        );
        run(
            &git,
            &path,
            &["commit", "--quiet", "-m", "rename"],
            "2026-01-02T00:00:00Z",
        );
        fs::write(path.join("new file.txt"), "one\nTWO\nthree\nfour\n").unwrap();
        run(
            &git,
            &path,
            &["commit", "--quiet", "-am", "edit two"],
            "2026-01-03T00:00:00Z",
        );
        let commits = run(&git, &path, &["rev-list", "HEAD"], "2026-01-03T00:00:00Z")
            .lines()
            .map(str::to_owned)
            .collect();
        (path.clone(), TestDir(path), commits)
    }

    fn collect(
        repo: &Path,
        cache: Option<&BlameCache>,
        commit: &str,
        file: &str,
    ) -> BlameResult<Vec<(BlameChunk, bool)>> {
        let mut chunks = Vec::new();
        let cancelled = AtomicBool::new(false);
        let params = ReadBlameParams {
            commit: commit.to_owned(),
            path_hex: hex(file),
        };
        read_blame_at(
            &git_path_bin(),
            repo,
            40,
            cache,
            &params,
            &cancelled,
            Instant::now() + BLAME_TIMEOUT,
            &mut |chunk, done| {
                chunks.push((chunk, done));
                true
            },
        )?;
        Ok(chunks)
    }

    fn lines_by_commit(chunks: &[(BlameChunk, bool)]) -> Vec<(u32, String, Option<String>)> {
        let mut blocks: Vec<_> = chunks
            .iter()
            .flat_map(|(chunk, _)| chunk.blocks.clone())
            .collect();
        blocks.sort_by_key(|block| block.start_line);
        blocks
            .into_iter()
            .flat_map(|block| {
                (0..block.line_count).map(move |offset| {
                    (
                        block.start_line + offset,
                        block.oid.clone(),
                        block
                            .original_path
                            .as_ref()
                            .map(|path| path.display.clone()),
                    )
                })
            })
            .collect()
    }

    #[test]
    fn blame_covers_every_line_and_names_the_path_before_a_rename() {
        let (repo, _cleanup, commits) = fixture("cover");
        let chunks = collect(&repo, None, &commits[0], "new file.txt").unwrap();
        assert!(chunks.last().unwrap().1, "the last chunk is marked done");
        assert_eq!(chunks.iter().filter(|(_, done)| *done).count(), 1);
        let lines = lines_by_commit(&chunks);
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[1].1, commits[0], "line 2 comes from the edit");
        assert_eq!(lines[0].1, commits[2], "line 1 comes from the root commit");
        assert_eq!(lines[0].2.as_deref(), Some("old.txt"));
        assert_eq!(lines[1].2, None);
        let named: Vec<_> = chunks
            .iter()
            .flat_map(|(chunk, _)| chunk.commits.clone())
            .collect();
        assert_eq!(named.len(), 2, "each commit is sent once");
        let edit = named
            .iter()
            .find(|commit| commit.oid == commits[0])
            .unwrap();
        assert_eq!(
            (
                edit.summary.as_str(),
                edit.author_email.as_str(),
                edit.author_time
            ),
            ("edit two", "blame@example.invalid", 1_767_398_400)
        );
    }

    #[test]
    fn blame_is_served_from_the_cache_after_the_first_read() {
        let (repo, _cleanup, commits) = fixture("cache");
        let root =
            std::env::temp_dir().join(format!("commitscope-blame-store-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let _cache_cleanup = TestDir(root.clone());
        let cache = BlameCache { root: root.clone() };
        let first = collect(&repo, Some(&cache), &commits[0], "new file.txt").unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        // Editing the cached summary proves the second read comes from the cache, not from Git.
        let entry = fs::read_dir(&root).unwrap().next().unwrap().unwrap().path();
        let text = fs::read_to_string(&entry)
            .unwrap()
            .replace("edit two", "cached edit");
        fs::write(&entry, text).unwrap();
        let second = collect(&repo, Some(&cache), &commits[0], "new file.txt").unwrap();
        assert_eq!(lines_by_commit(&first), lines_by_commit(&second));
        assert_eq!(second.len(), 1, "a cache hit is sent at once");
        assert!(
            second[0]
                .0
                .commits
                .iter()
                .any(|commit| commit.summary == "cached edit")
        );
        // Another path at the same commit is a different entry.
        collect(&repo, Some(&cache), &commits[2], "old.txt").unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
    }

    #[test]
    fn blame_rejects_binary_and_missing_files() {
        let (repo, _cleanup, commits) = fixture("reject");
        let git = git_path_bin();
        fs::write(repo.join("data.bin"), b"a\0b").unwrap();
        run(&git, &repo, &["add", "."], "2026-01-04T00:00:00Z");
        run(
            &git,
            &repo,
            &["commit", "--quiet", "-m", "binary"],
            "2026-01-04T00:00:00Z",
        );
        let head = run(&git, &repo, &["rev-parse", "HEAD"], "2026-01-04T00:00:00Z");
        assert_eq!(
            collect(&repo, None, &head, "data.bin").unwrap_err().code,
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            collect(&repo, None, &commits[0], "old.txt")
                .unwrap_err()
                .code,
            ErrorCode::MissingObject
        );
    }

    #[test]
    fn blame_ignores_the_repository_ignore_revs_setting() {
        let (repo, _cleanup, commits) = fixture("ignore-revs");
        let git = git_path_bin();
        // A configured ignore list would hide the edit commit; a missing file would make Git fail.
        fs::write(repo.join("ignored-revs"), format!("{}\n", commits[0])).unwrap();
        run(
            &git,
            &repo,
            &["config", "--add", "blame.ignoreRevsFile", "ignored-revs"],
            "2026-01-04T00:00:00Z",
        );
        run(
            &git,
            &repo,
            &["config", "--add", "blame.ignoreRevsFile", "missing-file"],
            "2026-01-04T00:00:00Z",
        );
        let lines = lines_by_commit(&collect(&repo, None, &commits[0], "new file.txt").unwrap());
        assert_eq!(
            lines[1].1, commits[0],
            "the edit is still blamed on its own commit"
        );
    }

    #[test]
    fn unquote_handles_octal_and_escapes() {
        assert_eq!(unquote(b"\"a\\tb\""), b"a\tb");
        assert_eq!(unquote(b"\"\\303\\251.txt\""), "é.txt".as_bytes());
        assert_eq!(unquote(b"plain name"), b"plain name");
    }

    #[test]
    fn chunks_stay_under_the_item_limit() {
        let mut sent = Vec::new();
        let mut emit = |chunk: BlameChunk, done: bool| {
            sent.push((chunk.blocks.len(), chunk.commits.len(), done));
            true
        };
        let mut builder = ChunkBuilder {
            commit: "a".repeat(40),
            path: git_path(b"f".to_vec()),
            total_lines: 12_000,
            blocks: Vec::new(),
            commits: Vec::new(),
            bytes: 0,
            sent_blocks: 0,
            last_flush: Instant::now(),
            emit: &mut emit,
        };
        for line in 1..=12_000 {
            let block = BlameBlock {
                start_line: line,
                line_count: 1,
                oid: "b".repeat(40),
                original_start_line: line,
                original_path: None,
            };
            builder.push(block, None, false).unwrap();
        }
        builder.flush(true).unwrap();
        assert_eq!(builder.sent_blocks, 12_000);
        assert!(sent.iter().all(|(blocks, _, _)| *blocks <= CHUNK_ITEMS));
        assert_eq!(sent.iter().filter(|(_, _, done)| *done).count(), 1);
    }
}
