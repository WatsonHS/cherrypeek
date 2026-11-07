use crate::{
    git_command::{GitFailure, GitLineStream, ReadOnlyGit, string_arg},
    repository::{self, DiscoveredRepository, PreviewError},
};
use commitscope_core::{
    ErrorCode, HistoryCommit, LastViewedSnapshot, NewSinceLastSeenStatus, StoreStatus,
};
use std::{
    collections::{HashSet, VecDeque},
    path::Path,
    sync::{Mutex, TryLockError, atomic::AtomicBool},
    time::Instant,
};

const CACHE_PAGE_LIMIT: usize = 8;
const CACHE_BYTES_LIMIT: usize = 16 * 1024 * 1024;
const OID_LINE_LIMIT: usize = 80;

pub struct HistoryState {
    query: Mutex<Option<Query>>,
    baseline: Mutex<Baseline>,
}

#[derive(Clone)]
pub struct Baseline {
    pub previous_view: Option<LastViewedSnapshot>,
    pub status: StoreStatus,
}

struct Query {
    id: String,
    page_size: u16,
    issued_frontier: u32,
    stream_position: u32,
    cached_bytes: usize,
    cached_pages: VecDeque<Page>,
    stream: Option<GitLineStream>,
    pending_oid: Option<String>,
    baseline: Baseline,
    marker_status: NewSinceLastSeenStatus,
    total_new_count: Option<u64>,
    prefix_offset: u32,
    prefix_count: u64,
    prefix_open: bool,
    divider_oid: Option<String>,
}

struct Page {
    offset: u32,
    commits: Vec<HistoryCommit>,
    has_more: bool,
    bytes: usize,
}

#[derive(Clone, Debug)]
pub struct HistoryPage {
    pub commits: Vec<HistoryCommit>,
    pub offset: u32,
    pub page_size: u16,
    pub cursor: String,
    pub previous_cursor: Option<String>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    pub new_since_last_seen_status: NewSinceLastSeenStatus,
    pub last_seen_divider_oid: Option<String>,
}

impl Default for HistoryState {
    fn default() -> Self {
        Self::new()
    }
}

impl HistoryState {
    pub fn new() -> Self {
        Self {
            query: Mutex::new(None),
            baseline: Mutex::new(Baseline {
                previous_view: None,
                status: StoreStatus::Ok,
            }),
        }
    }

    pub fn set_baseline(&self, baseline: Baseline) {
        *self.baseline.lock().expect("history baseline poisoned") = baseline;
    }

    pub fn read_page(
        &self,
        executable: &Path,
        discovered: &DiscoveredRepository,
        cursor: Option<&str>,
        page_size: u16,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<HistoryPage, PreviewError> {
        self.with_page(
            executable,
            discovered,
            cursor,
            page_size,
            cancelled,
            deadline,
            |page| Ok(page.clone()),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_page<T>(
        &self,
        executable: &Path,
        discovered: &DiscoveredRepository,
        cursor: Option<&str>,
        page_size: u16,
        cancelled: &AtomicBool,
        deadline: Instant,
        emit: impl FnOnce(&HistoryPage) -> Result<T, PreviewError>,
    ) -> Result<T, PreviewError> {
        let mut emit = Some(emit);
        if !(1..=500).contains(&page_size) {
            return Err(invalid_request("pageSize must be between 1 and 500"));
        }
        let mut query = match self.query.try_lock() {
            Ok(query) => query,
            Err(TryLockError::WouldBlock) => return Err(busy_error()),
            Err(TryLockError::Poisoned(_)) => {
                return Err(repository::internal_error("History state is unavailable"));
            }
        };

        if cursor.is_none()
            && query
                .as_ref()
                .is_none_or(|query| query.page_size != page_size)
        {
            let baseline = self
                .baseline
                .lock()
                .map_err(|_| repository::internal_error("History baseline is unavailable"))?
                .clone();
            *query = Some(Query::new(page_size, baseline)?);
        }
        let query = query.as_mut().ok_or_else(invalid_cursor)?;
        if query.page_size != page_size {
            return Err(invalid_cursor());
        }
        let offset = match cursor {
            None => 0,
            Some(cursor) => parse_cursor(cursor, &query.id, page_size)?,
        };
        if offset > query.issued_frontier {
            return Err(invalid_cursor());
        }

        if let Err(error) = verify_graph_fingerprint(discovered, cancelled, deadline) {
            query.reset_stream();
            query.pending_oid = None;
            query.stream_position = 0;
            return Err(error);
        }
        if let Some(page) = query.cached_pages.iter().find(|page| page.offset == offset) {
            let result = make_page(query, page);
            if let Err(error) = verify_graph_fingerprint(discovered, cancelled, deadline) {
                query.reset_stream();
                query.pending_oid = None;
                query.stream_position = 0;
                return Err(error);
            }
            check_page_active(query, cancelled, deadline)?;
            return emit_page(query, &result, &mut emit);
        }

        if query.stream.is_none() && query.stream_position > 0 {
            query.stream_position = 0;
            query.pending_oid = None;
        }
        if offset != query.stream_position {
            query.reset_stream();
            query.stream_position = 0;
            query.pending_oid = None;
        }
        if query.stream.is_none() && !discovered.scope_tips.is_empty() {
            query.stream = Some(start_stream(executable, discovered)?);
        }

        while query.stream_position < offset {
            let skipped = next_oid(query, discovered, cancelled, deadline)
                .and_then(|oid| oid.ok_or_else(invalid_cursor));
            match skipped {
                Ok(_) => query.stream_position = query.stream_position.saturating_add(1),
                Err(error) => {
                    query.reset_stream();
                    query.pending_oid = None;
                    query.stream_position = 0;
                    return Err(error);
                }
            }
        }

        let mut page = if discovered.scope_tips.is_empty() {
            if offset != 0 {
                return Err(invalid_cursor());
            }
            Page {
                offset: 0,
                commits: Vec::new(),
                has_more: false,
                bytes: 0,
            }
        } else {
            match read_page_from_stream(query, executable, discovered, offset, cancelled, deadline)
            {
                Ok(page) => page,
                Err(error) => {
                    query.reset_stream();
                    query.pending_oid = None;
                    query.stream_position = 0;
                    return Err(error);
                }
            }
        };
        if let Err(error) = mark_page(
            query, &mut page, executable, discovered, cancelled, deadline,
        ) {
            query.reset_stream();
            query.pending_oid = None;
            query.stream_position = 0;
            return Err(error);
        }
        if let Err(error) = verify_graph_fingerprint(discovered, cancelled, deadline) {
            disable_markers(query, &mut page);
            query.reset_stream();
            query.pending_oid = None;
            query.stream_position = 0;
            return Err(error);
        }
        query.stream_position = offset.saturating_add(page.commits.len() as u32);
        query.issued_frontier = query.issued_frontier.max(query.stream_position);
        let result = make_page(query, &page);
        if page.bytes <= CACHE_BYTES_LIMIT {
            while query.cached_pages.len() >= CACHE_PAGE_LIMIT
                || query.cached_bytes.saturating_add(page.bytes) > CACHE_BYTES_LIMIT
            {
                if let Some(evicted) = query.cached_pages.pop_front() {
                    query.cached_bytes = query.cached_bytes.saturating_sub(evicted.bytes);
                } else {
                    break;
                }
            }
            query.cached_bytes = query.cached_bytes.saturating_add(page.bytes);
            query.cached_pages.push_back(page);
        }
        check_page_active(query, cancelled, deadline)?;
        emit_page(query, &result, &mut emit)
    }
}

fn check_page_active(
    query: &mut Query,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), PreviewError> {
    let error = if cancelled.load(std::sync::atomic::Ordering::Acquire) {
        Some(repository::cancelled_error())
    } else if Instant::now() >= deadline {
        Some(repository::timeout_error())
    } else {
        None
    };
    if let Some(error) = error {
        query.reset_stream();
        query.pending_oid = None;
        query.stream_position = 0;
        return Err(error);
    }
    Ok(())
}

fn emit_page<T>(
    query: &mut Query,
    page: &HistoryPage,
    emit: &mut Option<impl FnOnce(&HistoryPage) -> Result<T, PreviewError>>,
) -> Result<T, PreviewError> {
    let result = emit.take().expect("history page callback used once")(page);
    if result.is_err() {
        query.reset_stream();
        query.pending_oid = None;
        query.stream_position = 0;
    }
    result
}

impl Query {
    fn new(page_size: u16, baseline: Baseline) -> Result<Self, PreviewError> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes)
            .map_err(|_| repository::internal_error("Could not create history cursor"))?;
        let mut id = String::with_capacity(32);
        for byte in bytes {
            use std::fmt::Write as _;
            let _ = write!(id, "{byte:02x}");
        }
        let marker_status = match (&baseline.previous_view, baseline.status) {
            (None, StoreStatus::Ok) => NewSinceLastSeenStatus::FirstView,
            (Some(_), StoreStatus::Ok) => NewSinceLastSeenStatus::Ready,
            _ => NewSinceLastSeenStatus::Unavailable,
        };
        Ok(Self {
            id,
            page_size,
            issued_frontier: 0,
            stream_position: 0,
            cached_bytes: 0,
            cached_pages: VecDeque::new(),
            stream: None,
            pending_oid: None,
            baseline,
            marker_status,
            total_new_count: None,
            prefix_offset: 0,
            prefix_count: 0,
            prefix_open: true,
            divider_oid: None,
        })
    }

    fn reset_stream(&mut self) {
        self.stream.take();
    }
}

fn mark_page(
    query: &mut Query,
    page: &mut Page,
    executable: &Path,
    discovered: &DiscoveredRepository,
    cancelled: &AtomicBool,
    request_deadline: Instant,
) -> Result<(), PreviewError> {
    if query.marker_status == NewSinceLastSeenStatus::Unavailable {
        clear_markers(query, page);
        return Ok(());
    }
    match query.marker_status {
        NewSinceLastSeenStatus::FirstView => {
            for commit in &mut page.commits {
                commit.is_new_since_last_seen = false;
            }
        }
        NewSinceLastSeenStatus::Ready => {
            let previous = query
                .baseline
                .previous_view
                .as_ref()
                .expect("ready marker has a previous view");
            let mut current_tips = discovered.scope_tips.clone();
            current_tips.sort();
            let mut previous_tips = previous.tips.clone();
            previous_tips.sort();
            let marker_deadline =
                request_deadline.min(Instant::now() + std::time::Duration::from_secs(2));
            let classification = if previous.tips.is_empty() {
                Some(vec![true; page.commits.len()])
            } else if current_tips == previous_tips || query.total_new_count == Some(0) {
                Some(vec![false; page.commits.len()])
            } else if page.commits.is_empty() {
                Some(Vec::new())
            } else {
                marker_classification(
                    executable,
                    discovered,
                    &page.commits,
                    &previous.tips,
                    &mut query.total_new_count,
                    cancelled,
                    request_deadline,
                    marker_deadline,
                )?
            };
            match classification {
                Some(flags) => {
                    for (commit, is_new) in page.commits.iter_mut().zip(flags) {
                        commit.is_new_since_last_seen = is_new;
                    }
                }
                None => {
                    query.marker_status = NewSinceLastSeenStatus::Unavailable;
                    query.divider_oid = None;
                    clear_markers(query, page);
                    return Ok(());
                }
            }
            update_prefix(query, page);
        }
        NewSinceLastSeenStatus::Unavailable => unreachable!(),
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn marker_classification(
    executable: &Path,
    discovered: &DiscoveredRepository,
    commits: &[HistoryCommit],
    old_tips: &[String],
    total_new_count: &mut Option<u64>,
    cancelled: &AtomicBool,
    request_deadline: Instant,
    marker_deadline: Instant,
) -> Result<Option<Vec<bool>>, PreviewError> {
    if Instant::now() >= marker_deadline {
        return Ok(None);
    }
    let git = match ReadOnlyGit::new(executable.to_path_buf()) {
        Ok(git) => git,
        Err(_) => return Ok(None),
    };
    let cwd = Path::new(&discovered.info.path);
    let mut flags = vec![false; commits.len()];
    if total_new_count.is_none() {
        let mut args = vec![
            string_arg("-c"),
            string_arg("core.commitGraph=false"),
            string_arg("rev-list"),
            string_arg("--count"),
        ];
        args.extend(discovered.scope_tips.iter().map(string_arg));
        args.push(string_arg("--not"));
        args.extend(old_tips.iter().map(string_arg));
        args.push(string_arg("--"));
        let count = match git.run(cwd, &args, None, 128, cancelled, marker_deadline) {
            Ok(output) if output.status.success() => output,
            Err(GitFailure::Cancelled) => return Err(repository::cancelled_error()),
            Err(GitFailure::Timeout) if Instant::now() >= request_deadline => {
                return Err(repository::timeout_error());
            }
            _ => return Ok(None),
        };
        if Instant::now() >= request_deadline {
            return Err(repository::timeout_error());
        }
        if Instant::now() >= marker_deadline {
            return Ok(None);
        }
        let Ok(value) = std::str::from_utf8(&count.stdout) else {
            return Ok(None);
        };
        let value = value.strip_suffix('\n').unwrap_or(value);
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Ok(None);
        }
        let Ok(value) = value.parse::<u64>() else {
            return Ok(None);
        };
        *total_new_count = Some(value);
    }
    if *total_new_count == Some(0) {
        return Ok(Some(flags));
    }

    let mut candidate_indexes = HashSet::with_capacity(commits.len());
    let mut args = vec![
        string_arg("-c"),
        string_arg("core.commitGraph=false"),
        string_arg("rev-list"),
    ];
    for commit in commits {
        candidate_indexes.insert(commit.commit.oid.as_str());
    }
    args.extend(old_tips.iter().map(string_arg));
    args.push(string_arg("--"));
    let mut stream = match git.stream_lines(cwd, &args, OID_LINE_LIMIT) {
        Ok(stream) => stream,
        Err(GitFailure::Cancelled) => return Err(repository::cancelled_error()),
        Err(_) => return Ok(None),
    };
    let mut found_old = HashSet::with_capacity(commits.len());
    loop {
        if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            return Err(repository::cancelled_error());
        }
        if Instant::now() >= request_deadline {
            return Err(repository::timeout_error());
        }
        if Instant::now() >= marker_deadline {
            return Ok(None);
        }
        match stream.next_line(cancelled, marker_deadline) {
            Ok(Some(line)) => {
                let Ok(oid) = std::str::from_utf8(&line) else {
                    return Ok(None);
                };
                if oid.len() != discovered.oid_length
                    || !oid.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Ok(None);
                }
                let oid = oid.to_ascii_lowercase();
                if candidate_indexes.contains(oid.as_str()) {
                    found_old.insert(oid);
                    if found_old.len() == commits.len() {
                        break;
                    }
                }
            }
            Ok(None) => break,
            Err(GitFailure::Cancelled) => return Err(repository::cancelled_error()),
            Err(GitFailure::Timeout) => {
                if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                    return Err(repository::cancelled_error());
                }
                if Instant::now() >= request_deadline {
                    return Err(repository::timeout_error());
                }
                return Ok(None);
            }
            Err(_) => return Ok(None),
        }
    }
    for (index, commit) in commits.iter().enumerate() {
        flags[index] = !found_old.contains(&commit.commit.oid);
    }
    Ok(Some(flags))
}

fn update_prefix(query: &mut Query, page: &Page) {
    if query.marker_status != NewSinceLastSeenStatus::Ready
        || query.prefix_offset != page.offset
        || !query.prefix_open
    {
        return;
    }
    for commit in &page.commits {
        if commit.is_new_since_last_seen {
            query.prefix_count = query.prefix_count.saturating_add(1);
        } else {
            query.prefix_open = false;
            if query.prefix_count > 0 && Some(query.prefix_count) == query.total_new_count {
                query.divider_oid = Some(commit.commit.oid.clone());
            }
            break;
        }
    }
    query.prefix_offset = page.offset.saturating_add(page.commits.len() as u32);
}

fn clear_markers(query: &mut Query, page: &mut Page) {
    for commit in &mut page.commits {
        commit.is_new_since_last_seen = false;
    }
    for cached in &mut query.cached_pages {
        for commit in &mut cached.commits {
            commit.is_new_since_last_seen = false;
        }
    }
    query.divider_oid = None;
}

fn disable_markers(query: &mut Query, page: &mut Page) {
    query.marker_status = NewSinceLastSeenStatus::Unavailable;
    query.total_new_count = None;
    query.prefix_offset = 0;
    query.prefix_count = 0;
    query.prefix_open = false;
    clear_markers(query, page);
}

fn read_page_from_stream(
    query: &mut Query,
    executable: &Path,
    discovered: &DiscoveredRepository,
    offset: u32,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Page, PreviewError> {
    if discovered.scope_tips.is_empty() {
        return Ok(Page {
            offset,
            commits: Vec::new(),
            has_more: false,
            bytes: 0,
        });
    }
    let mut oids = Vec::with_capacity(query.page_size as usize + 1);
    while oids.len() <= query.page_size as usize {
        let Some(oid) = next_oid(query, discovered, cancelled, deadline)? else {
            break;
        };
        oids.push(oid);
    }
    let has_more = oids.len() > query.page_size as usize;
    if has_more {
        query.pending_oid = oids.pop();
    }
    let commits =
        repository::read_commit_summaries(executable, discovered, &oids, cancelled, deadline)?
            .into_iter()
            .map(|commit| HistoryCommit {
                commit,
                is_new_since_last_seen: false,
            })
            .collect::<Vec<_>>();
    let bytes = commits
        .iter()
        .map(|item| serde_json::to_vec(item).map_or(0, |v| v.len()))
        .sum();
    Ok(Page {
        offset,
        commits,
        has_more,
        bytes,
    })
}

fn next_oid(
    query: &mut Query,
    discovered: &DiscoveredRepository,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<String>, PreviewError> {
    if let Some(oid) = query.pending_oid.take() {
        return Ok(Some(oid));
    }
    let Some(stream) = query.stream.as_mut() else {
        return Ok(None);
    };
    let line = stream
        .next_line(cancelled, deadline)
        .map_err(map_git_failure)?;
    let Some(line) = line else { return Ok(None) };
    let oid = std::str::from_utf8(&line)
        .map_err(|_| repository::git_error("Git returned a non-UTF-8 object ID"))?;
    if oid.len() != discovered.oid_length || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(repository::git_error("Git returned an invalid object ID"));
    }
    Ok(Some(oid.to_ascii_lowercase()))
}

fn start_stream(
    executable: &Path,
    discovered: &DiscoveredRepository,
) -> Result<GitLineStream, PreviewError> {
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_git_failure)?;
    let mut args = vec![
        string_arg("-c"),
        string_arg("core.commitGraph=false"),
        string_arg("rev-list"),
        string_arg("--topo-order"),
    ];
    args.extend(discovered.scope_tips.iter().map(string_arg));
    args.push(string_arg("--"));
    git.stream_lines(Path::new(&discovered.info.path), &args, OID_LINE_LIMIT)
        .map_err(map_git_failure)
}

fn make_page(query: &Query, page: &Page) -> HistoryPage {
    let cursor = format!("v1:{}:{}", query.id, page.offset);
    let previous_cursor = (page.offset > 0).then(|| {
        format!(
            "v1:{}:{}",
            query.id,
            page.offset.saturating_sub(query.page_size as u32)
        )
    });
    let next_cursor = page.has_more.then(|| {
        format!(
            "v1:{}:{}",
            query.id,
            page.offset.saturating_add(page.commits.len() as u32)
        )
    });
    HistoryPage {
        commits: page.commits.clone(),
        offset: page.offset,
        page_size: query.page_size,
        cursor,
        previous_cursor,
        has_more: page.has_more,
        next_cursor,
        new_since_last_seen_status: query.marker_status,
        last_seen_divider_oid: query.divider_oid.clone(),
    }
}

fn parse_cursor(cursor: &str, query_id: &str, page_size: u16) -> Result<u32, PreviewError> {
    let Some(rest) = cursor.strip_prefix("v1:") else {
        return Err(invalid_cursor());
    };
    let Some((id, raw_offset)) = rest.split_once(':') else {
        return Err(invalid_cursor());
    };
    if id != query_id
        || cursor.len() > 512
        || raw_offset.is_empty()
        || !raw_offset.bytes().all(|byte| byte.is_ascii_digit())
        || (raw_offset.starts_with('0') && raw_offset != "0")
    {
        return Err(invalid_cursor());
    }
    let offset = raw_offset.parse::<u32>().map_err(|_| invalid_cursor())?;
    if offset % page_size as u32 != 0 {
        return Err(invalid_cursor());
    }
    Ok(offset)
}

fn verify_graph_fingerprint(
    discovered: &DiscoveredRepository,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), PreviewError> {
    repository::verify_graph_fingerprint(discovered, cancelled, deadline)
}

fn map_git_failure(error: GitFailure) -> PreviewError {
    match error {
        GitFailure::Cancelled => repository::cancelled_error(),
        GitFailure::Timeout => repository::timeout_error(),
        GitFailure::ResourceLimit => {
            repository::resource_limit("Git history output exceeded its limit")
        }
        GitFailure::CommandFailed(message) => {
            let stderr = message
                .split_once(": ")
                .map_or(message.as_str(), |(_, stderr)| stderr);
            if repository::is_missing_object_diagnostic(stderr.as_bytes()) {
                repository::PreviewError {
                    code: ErrorCode::MissingObject,
                    message: "A history object is missing or unavailable".into(),
                    retryable: false,
                }
            } else {
                repository::git_error("Git failed while reading repository history")
            }
        }
        GitFailure::Unavailable(message) => repository::git_error(&message),
    }
}

fn invalid_request(message: &str) -> PreviewError {
    PreviewError {
        code: ErrorCode::InvalidRequest,
        message: message.into(),
        retryable: false,
    }
}

fn invalid_cursor() -> PreviewError {
    PreviewError {
        code: ErrorCode::InvalidCursor,
        message: "History cursor is invalid or expired".into(),
        retryable: false,
    }
}

fn busy_error() -> PreviewError {
    PreviewError {
        code: ErrorCode::Busy,
        message: "A history page is already being read".into(),
        retryable: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct TempRepo(PathBuf);

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git_executable() -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").expect("PATH"))
            .map(|directory| directory.join(if cfg!(windows) { "git.exe" } else { "git" }))
            .find(|path| path.is_file())
            .expect("git executable")
    }

    fn make_repo(count: usize) -> (TempRepo, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "commitscope-history-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("create temporary repository");
        let repo = TempRepo(root.clone());
        run_git(&root, &["init", "-q"]);
        run_git(&root, &["config", "user.name", "History Test"]);
        run_git(&root, &["config", "user.email", "history@example.test"]);
        for index in 0..count {
            fs::write(root.join("history.txt"), format!("commit {index}\n"))
                .expect("write fixture file");
            run_git(&root, &["add", "history.txt"]);
            run_git(&root, &["commit", "-q", "-m", &format!("commit {index}")]);
        }
        (repo, root)
    }

    fn run_git(path: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "History Test")
            .env("GIT_AUTHOR_EMAIL", "history@example.test")
            .env("GIT_COMMITTER_NAME", "History Test")
            .env("GIT_COMMITTER_EMAIL", "history@example.test")
            .output()
            .expect("run fixture git");
        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn discover(path: &Path) -> DiscoveredRepository {
        repository::discover_repository(
            &git_executable(),
            path.to_str().expect("fixture path utf-8"),
            &AtomicBool::new(false),
            Instant::now() + std::time::Duration::from_secs(5),
        )
        .expect("discover fixture repository")
    }

    fn read_page(
        state: &HistoryState,
        discovered: &DiscoveredRepository,
        cursor: Option<&str>,
        size: u16,
    ) -> Result<HistoryPage, PreviewError> {
        state.read_page(
            &git_executable(),
            discovered,
            cursor,
            size,
            &AtomicBool::new(false),
            Instant::now() + std::time::Duration::from_secs(5),
        )
    }

    #[test]
    fn pages_continue_replay_after_eviction_and_reject_unissued_offsets() {
        let (_repo, path) = make_repo(10);
        let discovered = discover(&path);
        let state = HistoryState::new();
        let mut cursor = None;
        let mut cursor_zero = String::new();
        let mut oids = Vec::new();
        for page_index in 0..10 {
            let page = read_page(&state, &discovered, cursor.as_deref(), 1).expect("read page");
            if page_index == 0 {
                cursor_zero.clone_from(&page.cursor);
            }
            assert_eq!(page.offset, page_index);
            assert_eq!(page.commits.len(), 1);
            oids.push(page.commits[0].commit.oid.clone());
            cursor = page.next_cursor;
        }
        assert!(cursor.is_none());
        let replay =
            read_page(&state, &discovered, Some(&cursor_zero), 1).expect("replay evicted page");
        assert_eq!(replay.commits[0].commit.oid, oids[0]);
        assert_eq!(
            state
                .read_page(
                    &git_executable(),
                    &discovered,
                    Some(&cursor_zero),
                    1,
                    &AtomicBool::new(true),
                    Instant::now() + std::time::Duration::from_secs(5),
                )
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        let mut parts = cursor_zero.split(':');
        let _version = parts.next().unwrap();
        let query = parts.next().unwrap();
        let invalid = format!("v1:{query}:11");
        assert_eq!(
            read_page(&state, &discovered, Some(&invalid), 1)
                .unwrap_err()
                .code,
            ErrorCode::InvalidCursor
        );
        assert_eq!(
            read_page(&state, &discovered, Some(&format!("v1:{query}:+1")), 1)
                .unwrap_err()
                .code,
            ErrorCode::InvalidCursor
        );
    }

    #[test]
    fn traversal_remains_bound_to_captured_head_and_detects_boundary_changes() {
        let (_repo, path) = make_repo(4);
        let discovered = discover(&path);
        let state = HistoryState::new();
        let first = read_page(&state, &discovered, None, 2).expect("first page");
        run_git(&path, &["add", "history.txt"]);
        fs::write(path.join("history.txt"), "external commit\n").expect("write external commit");
        run_git(&path, &["add", "history.txt"]);
        run_git(&path, &["commit", "-q", "-m", "external commit"]);
        let next = read_page(&state, &discovered, first.next_cursor.as_deref(), 2)
            .expect("captured second page");
        assert!(
            !next
                .commits
                .iter()
                .any(|commit| commit.commit.summary == "external commit")
        );

        fs::write(
            Path::new(&discovered.info.common_dir).join("shallow"),
            "boundary changed\n",
        )
        .expect("mutate shallow boundary");
        assert_eq!(
            read_page(&state, &discovered, Some(&first.cursor), 2)
                .unwrap_err()
                .code,
            ErrorCode::SnapshotChanged
        );
    }

    #[test]
    fn last_seen_marks_new_reachability_and_places_divider_before_first_old_commit() {
        let (_repo, path) = make_repo(3);
        let old_tip = run_git(&path, &["rev-parse", "HEAD"]);
        for index in 3..5 {
            fs::write(path.join("history.txt"), format!("commit {index}\n"))
                .expect("write fixture file");
            run_git(&path, &["add", "history.txt"]);
            run_git(&path, &["commit", "-q", "-m", &format!("commit {index}")]);
        }
        let discovered = discover(&path);
        let state = HistoryState::new();
        state.set_baseline(Baseline {
            previous_view: Some(LastViewedSnapshot {
                tips: vec![old_tip.clone()],
                viewed_at_unix_ms: 1,
            }),
            status: StoreStatus::Ok,
        });

        let first = read_page(&state, &discovered, None, 2).expect("read new commits");
        assert_eq!(
            first.new_since_last_seen_status,
            NewSinceLastSeenStatus::Ready
        );
        assert!(
            first
                .commits
                .iter()
                .all(|commit| commit.is_new_since_last_seen)
        );
        assert_eq!(first.last_seen_divider_oid, None);
        let second = read_page(&state, &discovered, first.next_cursor.as_deref(), 2)
            .expect("read previous commits");
        assert!(!second.commits[0].is_new_since_last_seen);
        assert_eq!(second.commits[0].commit.oid, old_tip);
        assert_eq!(
            second.last_seen_divider_oid.as_deref(),
            Some(old_tip.as_str())
        );
        let replay = read_page(&state, &discovered, Some(&first.cursor), 2)
            .expect("replay earlier page after divider proof");
        assert!(
            replay
                .commits
                .iter()
                .all(|commit| commit.is_new_since_last_seen)
        );
        assert_eq!(
            replay.last_seen_divider_oid.as_deref(),
            Some(old_tip.as_str())
        );
    }

    #[test]
    fn first_view_and_empty_previous_tips_have_distinct_marker_semantics() {
        let (_repo, path) = make_repo(2);
        let discovered = discover(&path);
        let first_view = read_page(&HistoryState::new(), &discovered, None, 2).unwrap();
        assert_eq!(
            first_view.new_since_last_seen_status,
            NewSinceLastSeenStatus::FirstView
        );
        assert!(
            first_view
                .commits
                .iter()
                .all(|commit| !commit.is_new_since_last_seen)
        );

        let state = HistoryState::new();
        state.set_baseline(Baseline {
            previous_view: Some(LastViewedSnapshot {
                tips: Vec::new(),
                viewed_at_unix_ms: 1,
            }),
            status: StoreStatus::Ok,
        });
        let empty_previous = read_page(&state, &discovered, None, 2).unwrap();
        assert_eq!(
            empty_previous.new_since_last_seen_status,
            NewSinceLastSeenStatus::Ready
        );
        assert!(
            empty_previous
                .commits
                .iter()
                .all(|commit| commit.is_new_since_last_seen)
        );
        assert_eq!(empty_previous.last_seen_divider_oid, None);
    }

    #[test]
    fn missing_old_only_ancestor_disables_markers_instead_of_mislabeling_shared_commits() {
        let (_repo, path) = make_repo(2);
        let shared = run_git(&path, &["rev-parse", "HEAD"]);
        let current_branch = run_git(&path, &["branch", "--show-current"]);
        run_git(&path, &["branch", "old-history"]);
        run_git(&path, &["checkout", "old-history"]);
        fs::write(path.join("history.txt"), "old one\n").unwrap();
        run_git(&path, &["add", "history.txt"]);
        run_git(&path, &["commit", "-q", "-m", "old one"]);
        let missing_ancestor = run_git(&path, &["rev-parse", "HEAD"]);
        fs::write(path.join("history.txt"), "old two\n").unwrap();
        run_git(&path, &["add", "history.txt"]);
        run_git(&path, &["commit", "-q", "-m", "old two"]);
        let old_tip = run_git(&path, &["rev-parse", "HEAD"]);

        run_git(&path, &["checkout", &current_branch]);
        for message in ["new one", "new two"] {
            fs::write(path.join("history.txt"), format!("{message}\n")).unwrap();
            run_git(&path, &["add", "history.txt"]);
            run_git(&path, &["commit", "-q", "-m", message]);
        }
        let object_path = path
            .join(".git/objects")
            .join(&missing_ancestor[..2])
            .join(&missing_ancestor[2..]);
        fs::remove_file(object_path).expect("remove only the old history ancestor");

        // Git's negative-revision traversal silently skips this missing old-only
        // ancestor. A positive old-tip walk detects it before absence can mean new.
        let output = Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(["rev-list", &shared, "--not", &old_tip, "--"])
            .output()
            .expect("run negative traversal oracle");
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains(&shared));

        let discovered = discover(&path);
        let state = HistoryState::new();
        state.set_baseline(Baseline {
            previous_view: Some(LastViewedSnapshot {
                tips: vec![old_tip],
                viewed_at_unix_ms: 1,
            }),
            status: StoreStatus::Ok,
        });
        let page = read_page(&state, &discovered, None, 1).expect("history remains readable");
        assert_eq!(
            page.new_since_last_seen_status,
            NewSinceLastSeenStatus::Unavailable
        );
        assert!(
            page.commits
                .iter()
                .all(|commit| !commit.is_new_since_last_seen)
        );
        assert_eq!(page.last_seen_divider_oid, None);
    }
}
