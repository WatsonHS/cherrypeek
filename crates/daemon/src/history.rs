use crate::{
    git_command::{GitFailure, GitLineStream, ReadOnlyGit, string_arg},
    graph::{self, Checkpoint, LayoutState},
    repository::{self, DiscoveredRepository, PreviewError},
};
use commitscope_core::{
    ErrorCode, HistoryCommit, HistoryDateLocation, LastViewedSnapshot, LocateCommitParams,
    LocateHistoryDateParams, NewSinceLastSeenStatus, StoreStatus,
};
use std::{
    collections::{HashSet, VecDeque},
    mem::size_of,
    path::Path,
    sync::{Mutex, TryLockError, atomic::AtomicBool},
    time::Instant,
};

const CACHE_PAGE_LIMIT: usize = 8;
const CACHE_BYTES_LIMIT: usize = 16 * 1024 * 1024;
const OID_LINE_LIMIT: usize = 80;
const TOPOLOGY_LINE_LIMIT: usize = 9 * 1024;
const DATE_INDEX_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const DATE_INDEX_LINE_GROWTH: usize = 64 * 1024;
const DATE_INDEX_RECORD_GROWTH: usize = 1024;
const DATE_INDEX_READ_AHEAD_BYTES: usize = 256 * 1024;
// Queue payload is capped at 16 MiB; stream-side, producer-side and line scratch are also bounded.
const TOPOLOGY_READ_AHEAD_BYTES: usize = 16 * 1024 * 1024;

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
    date_index: Option<DateTopologyIndex>,
    topology_position: u32,
    pending_entry: Option<TopologyEntry>,
    layout: LayoutState,
    checkpoints: VecDeque<Checkpoint>,
    checkpoint_bytes: usize,
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

#[derive(Default)]
struct LayoutWork {
    state: LayoutState,
    checkpoints: Vec<Checkpoint>,
}

#[derive(Clone)]
struct MarkerState {
    status: NewSinceLastSeenStatus,
    total_new_count: Option<u64>,
    prefix_offset: u32,
    prefix_count: u64,
    prefix_open: bool,
    divider_oid: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TopologyEntry {
    oid: String,
    parents: Vec<String>,
}

struct LocatedCommit {
    oid: String,
    page_offset: Option<u32>,
}

#[derive(Clone, Copy)]
struct DateIndexKey {
    timestamp: i64,
    ordinal: u32,
}

struct DateTopologyIndex {
    lines: Vec<u8>,
    offsets: Vec<u32>,
    dates: Vec<DateIndexKey>,
    oid_length: usize,
}

impl DateTopologyIndex {
    fn new(oid_length: usize) -> Self {
        Self {
            lines: Vec::new(),
            offsets: Vec::new(),
            dates: Vec::new(),
            oid_length,
        }
    }

    fn append(&mut self, timestamp: i64, ordinal: u32, topology: &[u8]) -> bool {
        let Some(next_line_len) = self.lines.len().checked_add(topology.len() + 1) else {
            return false;
        };
        let Some(next_record_count) = self.offsets.len().checked_add(1) else {
            return false;
        };
        let Some(next_line_capacity) =
            capacity_for(self.lines.capacity(), next_line_len, DATE_INDEX_LINE_GROWTH)
        else {
            return false;
        };
        let Some(next_record_capacity) = capacity_for(
            self.offsets.capacity().max(self.dates.capacity()),
            next_record_count,
            DATE_INDEX_RECORD_GROWTH,
        ) else {
            return false;
        };
        let estimated_capacity = next_line_capacity
            .saturating_add(next_record_capacity.saturating_mul(size_of::<u32>()))
            .saturating_add(next_record_capacity.saturating_mul(size_of::<DateIndexKey>()));
        if estimated_capacity > DATE_INDEX_LIMIT_BYTES || self.lines.len() > u32::MAX as usize {
            return false;
        }
        if self.lines.capacity() < next_line_capacity
            && self
                .lines
                .try_reserve_exact(next_line_capacity - self.lines.len())
                .is_err()
        {
            return false;
        }
        if self.offsets.capacity() < next_record_capacity
            && self
                .offsets
                .try_reserve_exact(next_record_capacity - self.offsets.len())
                .is_err()
        {
            return false;
        }
        if self.dates.capacity() < next_record_capacity
            && self
                .dates
                .try_reserve_exact(next_record_capacity - self.dates.len())
                .is_err()
        {
            return false;
        }
        if self.allocated_bytes() > DATE_INDEX_LIMIT_BYTES {
            return false;
        }

        self.offsets.push(self.lines.len() as u32);
        self.lines.extend_from_slice(topology);
        self.lines.push(b'\n');
        self.dates.push(DateIndexKey { timestamp, ordinal });
        true
    }

    fn finish(&mut self) {
        self.dates.sort_unstable_by(|left, right| {
            right
                .timestamp
                .cmp(&left.timestamp)
                .then_with(|| left.ordinal.cmp(&right.ordinal))
        });
    }

    fn target(
        &self,
        before_timestamp: i64,
        page_size: u16,
    ) -> Result<Option<LocatedCommit>, PreviewError> {
        let date_position = self
            .dates
            .partition_point(|entry| entry.timestamp >= before_timestamp);
        let Some(entry) = self.dates.get(date_position) else {
            return Ok(None);
        };
        let Some(topology) = self.topology(entry.ordinal)? else {
            return Ok(None);
        };
        let page_size = u32::from(page_size);
        Ok(Some(LocatedCommit {
            oid: topology.oid,
            page_offset: Some(entry.ordinal / page_size * page_size),
        }))
    }

    fn topology(&self, ordinal: u32) -> Result<Option<TopologyEntry>, PreviewError> {
        let ordinal = ordinal as usize;
        let Some(start) = self.offsets.get(ordinal).copied() else {
            return Ok(None);
        };
        let end = self
            .offsets
            .get(ordinal + 1)
            .copied()
            .map_or(self.lines.len(), |offset| offset as usize);
        let start = start as usize;
        if end <= start || end > self.lines.len() || self.lines[end - 1] != b'\n' {
            return Err(repository::git_error("Cached history topology is invalid"));
        }
        parse_topology_entry(&self.lines[start..end - 1], self.oid_length).map(Some)
    }

    fn allocated_bytes(&self) -> usize {
        self.lines
            .capacity()
            .saturating_add(self.offsets.capacity().saturating_mul(size_of::<u32>()))
            .saturating_add(
                self.dates
                    .capacity()
                    .saturating_mul(size_of::<DateIndexKey>()),
            )
    }
}

fn capacity_for(current: usize, required: usize, growth: usize) -> Option<usize> {
    if required <= current {
        return Some(current);
    }
    let rounded = required
        .checked_add(growth - 1)?
        .checked_div(growth)?
        .checked_mul(growth)?;
    Some(rounded.max(current))
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
        with_page_in_query(
            query, executable, discovered, cursor, None, page_size, cancelled, deadline, emit,
        )
    }

    pub fn with_located_page<T>(
        &self,
        executable: &Path,
        discovered: &DiscoveredRepository,
        params: &LocateCommitParams,
        cancelled: &AtomicBool,
        deadline: Instant,
        emit: impl FnOnce(&HistoryPage) -> Result<T, PreviewError>,
    ) -> Result<T, PreviewError> {
        let mut oid = params.oid.to_ascii_lowercase();
        if oid.len() < 4
            || oid.len() > discovered.oid_length
            || !oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(invalid_request("提交 hash 至少需要 4 位十六进制字符"));
        }
        if oid.len() < discovered.oid_length {
            let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_git_failure)?;
            let output = git
                .run(
                    Path::new(&discovered.info.path),
                    &[
                        string_arg("rev-parse"),
                        string_arg("--verify"),
                        string_arg("--end-of-options"),
                        string_arg(format!("{oid}^{{commit}}")),
                    ],
                    None,
                    16 * 1024,
                    cancelled,
                    deadline,
                )
                .map_err(map_git_failure)?;
            let resolved = String::from_utf8_lossy(&output.stdout)
                .trim()
                .to_ascii_lowercase();
            if !output.status.success() || !resolved.starts_with(&oid) {
                return Err(invalid_request("找不到唯一的提交，请检查或补全 hash"));
            }
            oid = resolved;
        }
        self.with_located_target(
            executable,
            discovered,
            LocatedCommit {
                oid,
                page_offset: None,
            },
            params.page_size,
            cancelled,
            deadline,
            emit,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_located_target<T>(
        &self,
        executable: &Path,
        discovered: &DiscoveredRepository,
        target: LocatedCommit,
        page_size: u16,
        cancelled: &AtomicBool,
        deadline: Instant,
        emit: impl FnOnce(&HistoryPage) -> Result<T, PreviewError>,
    ) -> Result<T, PreviewError> {
        if !(1..=500).contains(&page_size) {
            return Err(invalid_request("pageSize must be between 1 and 500"));
        }
        validate_topology_oid(&target.oid, discovered.oid_length)?;
        let mut query = match self.query.try_lock() {
            Ok(query) => query,
            Err(TryLockError::WouldBlock) => return Err(busy_error()),
            Err(TryLockError::Poisoned(_)) => {
                return Err(repository::internal_error("History state is unavailable"));
            }
        };
        let same_query = query
            .as_ref()
            .is_some_and(|query| query.page_size == page_size);
        if same_query {
            return with_page_in_query(
                query.as_mut().expect("matching query exists"),
                executable,
                discovered,
                None,
                Some(target),
                page_size,
                cancelled,
                deadline,
                emit,
            );
        }
        let baseline = self
            .baseline
            .lock()
            .map_err(|_| repository::internal_error("History baseline is unavailable"))?
            .clone();
        let mut fresh = Query::new(page_size, baseline)?;
        let result = with_page_in_query(
            &mut fresh,
            executable,
            discovered,
            None,
            Some(target),
            page_size,
            cancelled,
            deadline,
            emit,
        )?;
        *query = Some(fresh);
        Ok(result)
    }

    #[cfg(test)]
    pub fn with_located_date_page<T>(
        &self,
        executable: &Path,
        discovered: &DiscoveredRepository,
        params: &LocateHistoryDateParams,
        cancelled: &AtomicBool,
        deadline: Instant,
        emit: impl FnOnce(&HistoryPage) -> Result<T, PreviewError>,
    ) -> Result<T, PreviewError> {
        self.with_located_date_page_and_location(
            executable,
            discovered,
            params,
            (cancelled, deadline),
            |_, _| Ok(()),
            emit,
        )?
        .ok_or_else(|| {
            repository::internal_error("Date location unexpectedly omitted its history page")
        })
    }

    pub fn with_located_date_page_and_location<T>(
        &self,
        executable: &Path,
        discovered: &DiscoveredRepository,
        params: &LocateHistoryDateParams,
        budget: (&AtomicBool, Instant),
        mut emit_location: impl FnMut(&HistoryDateLocation, bool) -> Result<(), PreviewError>,
        emit_page: impl FnOnce(&HistoryPage) -> Result<T, PreviewError>,
    ) -> Result<Option<T>, PreviewError> {
        let (cancelled, deadline) = budget;
        if !(1..=500).contains(&params.page_size) {
            return Err(invalid_request("pageSize must be between 1 and 500"));
        }
        let known_cursors = params.known_cursors.as_deref();
        if known_cursors.is_some_and(|cursors| {
            cursors.len() > 9 || cursors.iter().any(|cursor| cursor.len() > 512)
        }) {
            return Err(invalid_request(
                "knownCursors must contain at most 9 cursors of at most 512 characters",
            ));
        }
        if discovered.scope_tips.is_empty() {
            return Err(no_commits_before_date());
        }
        let mut query_guard = match self.query.try_lock() {
            Ok(query) => query,
            Err(TryLockError::WouldBlock) => return Err(busy_error()),
            Err(TryLockError::Poisoned(_)) => {
                return Err(repository::internal_error("History state is unavailable"));
            }
        };
        let needs_fresh = query_guard
            .as_ref()
            .is_none_or(|query| query.page_size != params.page_size);
        let mut fresh = if needs_fresh {
            let baseline = self
                .baseline
                .lock()
                .map_err(|_| repository::internal_error("History baseline is unavailable"))?
                .clone();
            Some(Query::new(params.page_size, baseline)?)
        } else {
            None
        };
        if fresh.is_some()
            && let Some(previous) = query_guard.as_mut()
        {
            previous.reset_stream();
            previous.pending_entry = None;
        }
        let query = fresh
            .as_mut()
            .or_else(|| query_guard.as_mut())
            .expect("fresh or existing history query");

        verify_query_snapshot(query, discovered, cancelled, deadline)?;
        let target = if let Some(index) = query.date_index.as_ref() {
            let target = index.target(params.before_timestamp, params.page_size)?;
            check_active(cancelled, deadline)?;
            verify_query_snapshot(query, discovered, cancelled, deadline)?;
            target
        } else {
            // Avoid keeping the live rev-list child and its read-ahead queue beside the staged index.
            query.reset_stream();
            query.pending_entry = None;
            query.topology_position = 0;
            let (index, target) = locate_date_target(
                executable,
                discovered,
                params.page_size,
                params.before_timestamp,
                cancelled,
                deadline,
            )?;
            check_active(cancelled, deadline)?;
            verify_query_snapshot(query, discovered, cancelled, deadline)?;
            if let Some(index) = index {
                query.date_index = Some(index);
                query.pending_entry = None;
                query.topology_position = 0;
            }
            target
        };
        let target = target.ok_or_else(no_commits_before_date)?;
        let target_offset = target.page_offset.ok_or_else(|| {
            repository::internal_error("Date location did not include a page offset")
        })?;
        let location = HistoryDateLocation {
            oid: target.oid.clone(),
            cursor: format!("v1:{}:{}", query.id, target_offset),
            offset: target_offset,
            page_size: params.page_size,
        };
        if let Some(known_cursors) = known_cursors {
            check_active(cancelled, deadline)?;
            verify_query_snapshot(query, discovered, cancelled, deadline)?;
            let reused = known_cursors
                .iter()
                .any(|cursor| cursor == &location.cursor);
            emit_location(&location, reused)?;
            if reused {
                return Ok(None);
            }
        }
        let result = with_page_in_query(
            query,
            executable,
            discovered,
            None,
            Some(target),
            params.page_size,
            cancelled,
            deadline,
            emit_page,
        )?;
        if let Some(fresh) = fresh {
            *query_guard = Some(fresh);
        }
        Ok(Some(result))
    }
}

#[allow(clippy::too_many_arguments)]
fn with_page_in_query<T>(
    query: &mut Query,
    executable: &Path,
    discovered: &DiscoveredRepository,
    cursor: Option<&str>,
    locate: Option<LocatedCommit>,
    page_size: u16,
    cancelled: &AtomicBool,
    deadline: Instant,
    emit: impl FnOnce(&HistoryPage) -> Result<T, PreviewError>,
) -> Result<T, PreviewError> {
    let mut emit = Some(emit);
    if query.page_size != page_size {
        return Err(invalid_cursor());
    }
    let located = locate.is_some();
    let offset = if let Some(target) = locate {
        if discovered.scope_tips.is_empty() {
            return Err(scope_unavailable());
        }
        if let Some(page) = query.cached_pages.iter().find(|page| {
            page.commits
                .iter()
                .any(|commit| commit.commit.oid == target.oid)
        }) {
            page.offset
        } else if let Some(offset) = target.page_offset {
            offset
        } else {
            if let Err(error) = verify_graph_fingerprint(discovered, cancelled, deadline) {
                query.reset_walk();
                return Err(error);
            }
            query.reset_stream();
            let offset = locate_oid_offset(
                executable,
                discovered,
                &target.oid,
                page_size,
                cancelled,
                deadline,
            )?;
            if let Err(error) = verify_graph_fingerprint(discovered, cancelled, deadline) {
                query.reset_walk();
                return Err(error);
            }
            offset
        }
    } else {
        match cursor {
            None => 0,
            Some(cursor) => parse_cursor(cursor, &query.id, page_size)?,
        }
    };
    if !located && offset > query.issued_frontier {
        return Err(invalid_cursor());
    }

    if let Err(error) = verify_graph_fingerprint(discovered, cancelled, deadline) {
        query.reset_walk();
        if error.code == ErrorCode::SnapshotChanged {
            query.clear_graph_cache();
        }
        return Err(error);
    }
    if let Some(page) = query.cached_pages.iter().find(|page| page.offset == offset) {
        let result = make_page(query, page);
        if let Err(error) = verify_graph_fingerprint(discovered, cancelled, deadline) {
            query.reset_walk();
            if error.code == ErrorCode::SnapshotChanged {
                query.clear_graph_cache();
            }
            return Err(error);
        }
        check_page_active(query, cancelled, deadline)?;
        return emit_page(query, &result, &mut emit);
    }

    let mut layout_work = if discovered.scope_tips.is_empty() {
        LayoutWork::default()
    } else {
        match prepare_layout_at_offset(query, executable, discovered, offset, cancelled, deadline) {
            Ok(layout) => layout,
            Err(error) => {
                query.reset_walk();
                return Err(error);
            }
        }
    };
    let (mut page, topology) = if discovered.scope_tips.is_empty() {
        if offset != 0 {
            return Err(invalid_cursor());
        }
        (
            Page {
                offset: 0,
                commits: Vec::new(),
                has_more: false,
                bytes: 0,
            },
            Vec::new(),
        )
    } else {
        match read_page_from_stream(query, executable, discovered, offset, cancelled, deadline) {
            Ok(page) => page,
            Err(error) => {
                query.reset_walk();
                return Err(error);
            }
        }
    };
    if let Err(error) = layout_page(
        &mut page,
        &topology,
        &mut layout_work,
        query.checkpoint_bytes,
        query.checkpoints.len(),
        cancelled,
        deadline,
    ) {
        query.reset_walk();
        return Err(error);
    }
    let marker_state = query.marker_state();
    if let Err(error) = mark_page(
        query, &mut page, executable, discovered, cancelled, deadline,
    ) {
        query.restore_marker_state(marker_state);
        query.reset_walk();
        return Err(error);
    }
    if let Err(error) = verify_graph_fingerprint(discovered, cancelled, deadline) {
        query.restore_marker_state(marker_state);
        query.reset_walk();
        return Err(error);
    }
    if !page.has_more && !layout_work.state.active_slots.is_empty() {
        query.reset_walk();
        return Err(repository::git_error(
            "Git history ended with unresolved graph lanes",
        ));
    }
    let next_position = offset.saturating_add(page.commits.len() as u32);
    let result = make_page(query, &page);
    if let Err(error) = check_page_active(query, cancelled, deadline) {
        query.restore_marker_state(marker_state);
        return Err(error);
    }
    let emitted = match emit_page(query, &result, &mut emit) {
        Ok(emitted) => emitted,
        Err(error) => {
            query.restore_marker_state(marker_state);
            return Err(error);
        }
    };
    query.stream_position = next_position;
    query.layout = layout_work.state;
    query.issued_frontier = query.issued_frontier.max(query.stream_position);
    commit_checkpoints(query, &layout_work.checkpoints);
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
    Ok(emitted)
}

fn locate_oid_offset(
    executable: &Path,
    discovered: &DiscoveredRepository,
    oid: &str,
    page_size: u16,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<u32, PreviewError> {
    let mut stream = start_stream(executable, discovered)?;
    let mut ordinal = 0_u32;
    while let Some(entry) = read_stream_entry(&mut stream, discovered, cancelled, deadline)? {
        if entry.oid.eq_ignore_ascii_case(oid) {
            let page_size = u32::from(page_size);
            return Ok(ordinal / page_size * page_size);
        }
        ordinal = ordinal.checked_add(1).ok_or_else(|| {
            repository::resource_limit("History position exceeds the supported cursor range")
        })?;
    }
    Err(scope_unavailable())
}

fn locate_date_target(
    executable: &Path,
    discovered: &DiscoveredRepository,
    page_size: u16,
    before_timestamp: i64,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(Option<DateTopologyIndex>, Option<LocatedCommit>), PreviewError> {
    if discovered.scope_tips.is_empty() {
        return Err(no_commits_before_date());
    }
    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_git_failure)?;
    let mut args = vec![
        string_arg("-c"),
        string_arg("core.commitGraph=false"),
        string_arg("rev-list"),
        string_arg("--timestamp"),
        string_arg("--parents"),
        string_arg("--topo-order"),
    ];
    args.extend(discovered.scope_tips.iter().map(string_arg));
    args.push(string_arg("--"));
    let mut stream = git
        .stream_lines_buffered(
            Path::new(&discovered.info.path),
            &args,
            TOPOLOGY_LINE_LIMIT,
            DATE_INDEX_READ_AHEAD_BYTES,
        )
        .map_err(map_git_failure)?;
    let mut best: Option<(i64, u32, String)> = None;
    let mut index = Some(DateTopologyIndex::new(discovered.oid_length));
    let mut ordinal = 0_u32;
    while let Some(line) = stream
        .next_line(cancelled, deadline)
        .map_err(map_git_failure)?
    {
        check_active(cancelled, deadline)?;
        let separator = line
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or_else(|| repository::git_error("Git returned an invalid dated history record"))?;
        let timestamp = std::str::from_utf8(&line[..separator])
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .ok_or_else(|| repository::git_error("Git returned an invalid committer timestamp"))?;
        let topology = &line[separator + 1..];
        let entry = parse_topology_entry(topology, discovered.oid_length)?;
        if timestamp < before_timestamp
            && best
                .as_ref()
                .is_none_or(|(best_timestamp, _, _)| timestamp > *best_timestamp)
        {
            best = Some((timestamp, ordinal, entry.oid.clone()));
        }
        if index
            .as_mut()
            .is_some_and(|index| !index.append(timestamp, ordinal, topology))
        {
            index = None;
        }
        ordinal = ordinal.checked_add(1).ok_or_else(|| {
            repository::resource_limit("History position exceeds the supported cursor range")
        })?;
    }
    if let Some(index) = index.as_mut() {
        index.finish();
    }
    let target = if let Some(index) = index.as_ref() {
        index.target(before_timestamp, page_size)?
    } else {
        best.map(|(_, ordinal, oid)| LocatedCommit {
            oid,
            page_offset: Some(ordinal / u32::from(page_size) * u32::from(page_size)),
        })
    };
    Ok((index, target))
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
        query.reset_walk();
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
        query.reset_walk();
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
            date_index: None,
            topology_position: 0,
            pending_entry: None,
            layout: LayoutState::default(),
            checkpoints: VecDeque::new(),
            checkpoint_bytes: 0,
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

    fn reset_walk(&mut self) {
        self.reset_stream();
        self.pending_entry = None;
        self.stream_position = 0;
        self.topology_position = 0;
        self.layout = LayoutState::default();
    }

    fn clear_graph_cache(&mut self) {
        self.checkpoints.clear();
        self.checkpoint_bytes = 0;
        self.cached_pages.clear();
        self.cached_bytes = 0;
        self.issued_frontier = 0;
        self.date_index = None;
        self.topology_position = 0;
    }

    fn marker_state(&self) -> MarkerState {
        MarkerState {
            status: self.marker_status,
            total_new_count: self.total_new_count,
            prefix_offset: self.prefix_offset,
            prefix_count: self.prefix_count,
            prefix_open: self.prefix_open,
            divider_oid: self.divider_oid.clone(),
        }
    }

    fn restore_marker_state(&mut self, state: MarkerState) {
        self.marker_status = state.status;
        self.total_new_count = state.total_new_count;
        self.prefix_offset = state.prefix_offset;
        self.prefix_count = state.prefix_count;
        self.prefix_open = state.prefix_open;
        self.divider_oid = state.divider_oid;
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

fn read_page_from_stream(
    query: &mut Query,
    executable: &Path,
    discovered: &DiscoveredRepository,
    offset: u32,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(Page, Vec<TopologyEntry>), PreviewError> {
    if discovered.scope_tips.is_empty() {
        return Ok((
            Page {
                offset,
                commits: Vec::new(),
                has_more: false,
                bytes: 0,
            },
            Vec::new(),
        ));
    }
    let mut entries = Vec::with_capacity(query.page_size as usize + 1);
    while entries.len() <= query.page_size as usize {
        let Some(entry) = next_topology_entry(query, discovered, cancelled, deadline)? else {
            break;
        };
        entries.push(entry);
    }
    let has_more = entries.len() > query.page_size as usize;
    if has_more {
        query.pending_entry = entries.pop();
    }
    let oids = entries
        .iter()
        .map(|entry| entry.oid.clone())
        .collect::<Vec<_>>();
    let summaries =
        repository::read_commit_summaries(executable, discovered, &oids, cancelled, deadline)?;
    if summaries.len() != entries.len()
        || summaries
            .iter()
            .zip(&entries)
            .any(|(summary, entry)| summary.oid != entry.oid)
    {
        return Err(repository::git_error(
            "Git topology stream did not match commit summary objects",
        ));
    }
    let commits = summaries
        .into_iter()
        .map(|commit| HistoryCommit {
            commit,
            is_new_since_last_seen: false,
            graph: commitscope_core::HistoryGraph {
                lane: 0,
                color: 0,
                parents: Vec::new(),
                boundary: false,
                above: 0,
                below: 0,
                hidden_lane_count: 0,
                hidden_through_ranges: Vec::new(),
                segments: Vec::new(),
            },
        })
        .collect::<Vec<_>>();
    let bytes = commits
        .iter()
        .map(|item| serde_json::to_vec(item).map_or(0, |v| v.len()))
        .sum();
    Ok((
        Page {
            offset,
            commits,
            has_more,
            bytes,
        },
        entries,
    ))
}

fn next_topology_entry(
    query: &mut Query,
    discovered: &DiscoveredRepository,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<TopologyEntry>, PreviewError> {
    if let Some(entry) = query.pending_entry.take() {
        return Ok(Some(entry));
    }
    if let Some(index) = query.date_index.as_ref() {
        let entry = index.topology(query.topology_position)?;
        if entry.is_some() {
            query.topology_position = query.topology_position.saturating_add(1);
        }
        return Ok(entry);
    }
    let Some(stream) = query.stream.as_mut() else {
        return Ok(None);
    };
    read_stream_entry(stream, discovered, cancelled, deadline)
}

fn read_stream_entry(
    stream: &mut GitLineStream,
    discovered: &DiscoveredRepository,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<TopologyEntry>, PreviewError> {
    let line = stream
        .next_line(cancelled, deadline)
        .map_err(map_git_failure)?;
    let Some(line) = line else { return Ok(None) };
    parse_topology_entry(&line, discovered.oid_length).map(Some)
}

fn parse_topology_entry(line: &[u8], oid_length: usize) -> Result<TopologyEntry, PreviewError> {
    let text = std::str::from_utf8(line)
        .map_err(|_| repository::git_error("Git returned a non-UTF-8 topology record"))?;
    let mut fields = text.split_ascii_whitespace();
    let oid = fields
        .next()
        .ok_or_else(|| repository::git_error("Git returned an empty topology record"))?;
    let mut parents = Vec::new();
    for parent in fields {
        if parents.len() >= 128 {
            return Err(repository::resource_limit(
                "A history commit has more than 128 effective parents",
            ));
        }
        validate_topology_oid(parent, oid_length)?;
        parents.push(parent.to_ascii_lowercase());
    }
    validate_topology_oid(oid, oid_length)?;
    Ok(TopologyEntry {
        oid: oid.to_ascii_lowercase(),
        parents,
    })
}

fn validate_topology_oid(oid: &str, oid_length: usize) -> Result<(), PreviewError> {
    if oid.len() != oid_length || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(repository::git_error(
            "Git returned an invalid topology object ID",
        ));
    }
    Ok(())
}

fn prepare_layout_at_offset(
    query: &mut Query,
    executable: &Path,
    discovered: &DiscoveredRepository,
    offset: u32,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<LayoutWork, PreviewError> {
    if query.date_index.is_some() {
        return prepare_layout_from_date_index(query, offset, cancelled, deadline);
    }
    if query.stream.is_some()
        && query.stream_position == offset
        && query.layout.next_ordinal == offset
    {
        return Ok(LayoutWork {
            state: query.layout.clone(),
            checkpoints: Vec::new(),
        });
    }

    let mut best = LayoutState::default();
    if query.layout.next_ordinal <= offset {
        best = query.layout.clone();
    }
    for checkpoint in &query.checkpoints {
        if checkpoint.next_ordinal > offset || checkpoint.next_ordinal <= best.next_ordinal {
            continue;
        }
        best = LayoutState {
            next_ordinal: checkpoint.next_ordinal,
            active_slots: checkpoint.active_slots.clone(),
            boundary_oid: Some(checkpoint.boundary_oid.clone()),
        };
    }

    query.reset_stream();
    query.pending_entry = None;
    query.stream_position = 0;
    query.stream = Some(start_stream(executable, discovered)?);
    let mut work = LayoutWork {
        state: best,
        checkpoints: Vec::new(),
    };

    for ordinal in 0..work.state.next_ordinal {
        check_active(cancelled, deadline)?;
        let entry = next_topology_entry(query, discovered, cancelled, deadline)?
            .ok_or_else(snapshot_changed_error)?;
        if ordinal + 1 == work.state.next_ordinal
            && work.state.boundary_oid.as_deref() != Some(entry.oid.as_str())
        {
            return Err(snapshot_changed_error());
        }
    }
    while work.state.next_ordinal < offset {
        check_active(cancelled, deadline)?;
        let entry = next_topology_entry(query, discovered, cancelled, deadline)?
            .ok_or_else(invalid_cursor)?;
        let _ = work
            .state
            .advance(&entry.oid, &entry.parents, &entry.parents)
            .map_err(map_layout_error)?;
        stage_checkpoint(
            &mut work.checkpoints,
            work.state.checkpoint(),
            query.checkpoint_bytes,
            query.checkpoints.len(),
        );
    }
    query.stream_position = offset;
    Ok(work)
}

fn prepare_layout_from_date_index(
    query: &mut Query,
    offset: u32,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<LayoutWork, PreviewError> {
    let pending_is_next =
        query.pending_entry.is_some() && query.topology_position == offset.saturating_add(1);
    if query.stream_position == offset
        && query.layout.next_ordinal == offset
        && (query.topology_position == offset || pending_is_next)
    {
        return Ok(LayoutWork {
            state: query.layout.clone(),
            checkpoints: Vec::new(),
        });
    }

    let mut best = LayoutState::default();
    if query.layout.next_ordinal <= offset {
        best = query.layout.clone();
    }
    for checkpoint in &query.checkpoints {
        if checkpoint.next_ordinal > offset || checkpoint.next_ordinal <= best.next_ordinal {
            continue;
        }
        best = LayoutState {
            next_ordinal: checkpoint.next_ordinal,
            active_slots: checkpoint.active_slots.clone(),
            boundary_oid: Some(checkpoint.boundary_oid.clone()),
        };
    }

    let index = query
        .date_index
        .as_ref()
        .expect("date index checked before layout preparation");
    if best.next_ordinal > 0 {
        let boundary = index
            .topology(best.next_ordinal - 1)?
            .ok_or_else(snapshot_changed_error)?;
        if best.boundary_oid.as_deref() != Some(boundary.oid.as_str()) {
            return Err(snapshot_changed_error());
        }
    }
    let mut work = LayoutWork {
        state: best,
        checkpoints: Vec::new(),
    };
    let checkpoint_bytes = query.checkpoint_bytes;
    let checkpoint_count = query.checkpoints.len();
    while work.state.next_ordinal < offset {
        check_active(cancelled, deadline)?;
        let entry = index
            .topology(work.state.next_ordinal)?
            .ok_or_else(invalid_cursor)?;
        let _ = work
            .state
            .advance(&entry.oid, &entry.parents, &entry.parents)
            .map_err(map_layout_error)?;
        stage_checkpoint(
            &mut work.checkpoints,
            work.state.checkpoint(),
            checkpoint_bytes,
            checkpoint_count,
        );
    }
    query.reset_stream();
    query.pending_entry = None;
    query.stream_position = offset;
    query.topology_position = offset;
    Ok(work)
}

fn layout_page(
    page: &mut Page,
    entries: &[TopologyEntry],
    work: &mut LayoutWork,
    checkpoint_bytes_used: usize,
    checkpoint_count_used: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), PreviewError> {
    if page.commits.len() != entries.len() {
        return Err(repository::git_error(
            "History summaries and topology rows have different lengths",
        ));
    }
    for (commit, entry) in page.commits.iter_mut().zip(entries) {
        check_active(cancelled, deadline)?;
        if commit.commit.oid != entry.oid {
            return Err(repository::git_error(
                "History summary and topology object IDs do not match",
            ));
        }
        commit.graph = work
            .state
            .advance(&entry.oid, &entry.parents, &commit.commit.parents)
            .map_err(map_layout_error)?;
        if work
            .state
            .next_ordinal
            .is_multiple_of(graph::CHECKPOINT_INTERVAL)
        {
            stage_checkpoint(
                &mut work.checkpoints,
                work.state.checkpoint(),
                checkpoint_bytes_used,
                checkpoint_count_used,
            );
        }
    }
    page.bytes = page
        .commits
        .iter()
        .map(|item| serde_json::to_vec(item).map_or(0, |v| v.len()))
        .sum();
    Ok(())
}

fn stage_checkpoint(
    staged: &mut Vec<Checkpoint>,
    checkpoint: Option<Checkpoint>,
    reserved_bytes: usize,
    reserved_count: usize,
) {
    let Some(checkpoint) = checkpoint else { return };
    if reserved_count >= graph::CHECKPOINT_LIMIT
        || checkpoint.estimated_bytes > graph::CHECKPOINT_BYTES_LIMIT.saturating_sub(reserved_bytes)
    {
        return;
    }
    staged.push(checkpoint);
    let mut total = staged
        .iter()
        .map(|point| point.estimated_bytes)
        .sum::<usize>();
    while staged.len() + reserved_count > graph::CHECKPOINT_LIMIT
        || total.saturating_add(reserved_bytes) > graph::CHECKPOINT_BYTES_LIMIT
    {
        let removed = staged.remove(0);
        total = total.saturating_sub(removed.estimated_bytes);
    }
}

fn commit_checkpoints(query: &mut Query, staged: &[Checkpoint]) {
    for checkpoint in staged {
        if let Some(index) = query
            .checkpoints
            .iter()
            .position(|saved| saved.next_ordinal == checkpoint.next_ordinal)
        {
            query.checkpoint_bytes = query
                .checkpoint_bytes
                .saturating_sub(query.checkpoints.remove(index).unwrap().estimated_bytes);
        }
        query.checkpoint_bytes = query
            .checkpoint_bytes
            .saturating_add(checkpoint.estimated_bytes);
        query.checkpoints.push_back(checkpoint.clone());
    }
    let mut ordered = query.checkpoints.drain(..).collect::<Vec<_>>();
    ordered.sort_by_key(|checkpoint| checkpoint.next_ordinal);
    query.checkpoints = ordered.into();
    while query.checkpoints.len() > graph::CHECKPOINT_LIMIT
        || query.checkpoint_bytes > graph::CHECKPOINT_BYTES_LIMIT
    {
        if let Some(removed) = query.checkpoints.pop_front() {
            query.checkpoint_bytes = query
                .checkpoint_bytes
                .saturating_sub(removed.estimated_bytes);
        } else {
            break;
        }
    }
}

fn map_layout_error(error: graph::LayoutError) -> PreviewError {
    match error {
        graph::LayoutError::ResourceLimit => {
            repository::resource_limit("History graph layout exceeded its state limit")
        }
    }
}

fn check_active(cancelled: &AtomicBool, deadline: Instant) -> Result<(), PreviewError> {
    if cancelled.load(std::sync::atomic::Ordering::Acquire) {
        return Err(repository::cancelled_error());
    }
    if Instant::now() >= deadline {
        return Err(repository::timeout_error());
    }
    Ok(())
}

fn snapshot_changed_error() -> PreviewError {
    PreviewError {
        code: ErrorCode::SnapshotChanged,
        message: "The frozen history order changed; refresh the repository".into(),
        retryable: false,
    }
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
        string_arg("--parents"),
    ];
    args.extend(discovered.scope_tips.iter().map(string_arg));
    args.push(string_arg("--"));
    git.stream_lines_buffered(
        Path::new(&discovered.info.path),
        &args,
        TOPOLOGY_LINE_LIMIT,
        TOPOLOGY_READ_AHEAD_BYTES,
    )
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

fn verify_query_snapshot(
    query: &mut Query,
    discovered: &DiscoveredRepository,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), PreviewError> {
    if let Err(error) = verify_graph_fingerprint(discovered, cancelled, deadline) {
        if error.code == ErrorCode::SnapshotChanged {
            query.reset_walk();
            query.clear_graph_cache();
        }
        return Err(error);
    }
    Ok(())
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

fn scope_unavailable() -> PreviewError {
    PreviewError {
        code: ErrorCode::ScopeUnavailable,
        message: "Commit is not reachable in the current snapshot scope".into(),
        retryable: false,
    }
}

fn no_commits_before_date() -> PreviewError {
    PreviewError {
        code: ErrorCode::ScopeUnavailable,
        message: "该日期及之前没有提交".into(),
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
            "commitscope-history-{}-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after Unix epoch")
                .as_nanos()
        ));
        fs::create_dir(&root).expect("create a unique temporary repository");
        let repo = TempRepo(root.clone());
        run_git(&root, &["init", "-q", "--initial-branch=main"]);
        run_git(&root, &["config", "gc.auto", "0"]);
        run_git(&root, &["config", "maintenance.auto", "false"]);
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
        let mut command = Command::new("git");
        for (name, _) in
            std::env::vars_os().filter(|(name, _)| name.to_string_lossy().starts_with("GIT_"))
        {
            command.env_remove(name);
        }
        let output = command
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
        if !output.status.success() {
            let head = fs::read_to_string(path.join(".git/HEAD"))
                .unwrap_or_else(|error| format!("<unreadable: {error}>"))
                .trim()
                .to_owned();
            let refs = fs::read_dir(path.join(".git/refs/heads"))
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .map(|entry| entry.path())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            panic!(
                "git {args:?} failed in {}: {}; HEAD={head:?}; branch refs={refs:?}",
                path.display(),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn diagnostic_git(path: &Path, args: &[&str]) -> (bool, String, String) {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .expect("run diagnostic Git command");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        )
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

    fn locate_page(
        state: &HistoryState,
        discovered: &DiscoveredRepository,
        oid: &str,
        size: u16,
    ) -> Result<HistoryPage, PreviewError> {
        state.with_located_page(
            &git_executable(),
            discovered,
            &LocateCommitParams {
                oid: oid.to_owned(),
                page_size: size,
            },
            &AtomicBool::new(false),
            Instant::now() + std::time::Duration::from_secs(5),
            |page| Ok(page.clone()),
        )
    }

    fn locate_date_page(
        state: &HistoryState,
        discovered: &DiscoveredRepository,
        before_timestamp: i64,
        size: u16,
    ) -> Result<HistoryPage, PreviewError> {
        state.with_located_date_page(
            &git_executable(),
            discovered,
            &LocateHistoryDateParams {
                before_timestamp,
                page_size: size,
                known_cursors: None,
            },
            &AtomicBool::new(false),
            Instant::now() + std::time::Duration::from_secs(5),
            |page| Ok(page.clone()),
        )
    }

    fn commit_at(path: &Path, message: &str, timestamp: i64) {
        let mut command = Command::new("git");
        for (name, _) in
            std::env::vars_os().filter(|(name, _)| name.to_string_lossy().starts_with("GIT_"))
        {
            command.env_remove(name);
        }
        let date = format!("@{timestamp} +0000");
        let output = command
            .arg("-C")
            .arg(path)
            .args(["add", "history.txt"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .expect("stage dated fixture commit");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );

        let mut command = Command::new("git");
        for (name, _) in
            std::env::vars_os().filter(|(name, _)| name.to_string_lossy().starts_with("GIT_"))
        {
            command.env_remove(name);
        }
        let output = command
            .arg("-C")
            .arg(path)
            .args(["commit", "-q", "-m", message])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "History Test")
            .env("GIT_AUTHOR_EMAIL", "history@example.test")
            .env("GIT_COMMITTER_NAME", "History Test")
            .env("GIT_COMMITTER_EMAIL", "history@example.test")
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .expect("create dated fixture commit");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
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
        assert_eq!(replay.commits[0].graph.lane, 0);
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
    fn locate_beyond_issued_frontier_returns_page_with_working_previous_and_next_cursors() {
        let (_repo, path) = make_repo(12);
        let discovered = discover(&path);
        let state = HistoryState::new();
        let first = read_page(&state, &discovered, None, 2).expect("first page");
        let target = run_git(&path, &["rev-parse", "HEAD~8"]);
        let located = locate_page(&state, &discovered, &target, 2).expect("locate commit");
        let prefix = locate_page(&state, &discovered, &target[..8].to_ascii_uppercase(), 2)
            .expect("locate abbreviated commit without an index");
        assert_eq!(prefix.offset, located.offset);
        assert!(
            prefix
                .commits
                .iter()
                .any(|commit| commit.commit.oid == target)
        );
        for invalid in ["abc", "HEAD~1", "00000000"] {
            assert_eq!(
                locate_page(&state, &discovered, invalid, 2)
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidRequest
            );
        }
        assert_eq!(located.offset, 8);
        assert!(
            located
                .commits
                .iter()
                .any(|commit| commit.commit.oid == target)
        );
        assert_eq!(
            located.cursor,
            format!("v1:{}:8", first.cursor.split(':').nth(1).unwrap())
        );
        let previous = read_page(&state, &discovered, located.previous_cursor.as_deref(), 2)
            .expect("previous page");
        assert_eq!(previous.offset, 6);
        let next =
            read_page(&state, &discovered, located.next_cursor.as_deref(), 2).expect("next page");
        assert_eq!(next.offset, 10);
    }

    #[test]
    fn locate_history_date_selects_maximum_eligible_committer_time_in_topology_order() {
        let (_repo, path) = make_repo(0);
        let dated_commits = [
            ("old", 100),
            ("first-tie", 340),
            ("second-tie", 340),
            ("newer-topology-lower-time", 200),
            ("excluded", 500),
        ];
        for (message, timestamp) in dated_commits {
            fs::write(path.join("history.txt"), format!("{message}\n"))
                .expect("write dated fixture commit");
            commit_at(&path, message, timestamp);
        }
        let discovered = discover(&path);
        let state = HistoryState::new();
        let page = locate_date_page(&state, &discovered, 400, 2).expect("locate date");
        let expected = run_git(&path, &["rev-parse", "HEAD~2"]);
        assert_eq!(page.offset, 2);
        assert_eq!(page.commits[0].commit.oid, expected);
        assert_eq!(page.commits.len(), 2);
        assert!(
            page.commits
                .iter()
                .any(|commit| commit.commit.oid == expected)
        );
        assert!(
            state
                .query
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .date_index
                .as_ref()
                .is_some_and(|index| index.allocated_bytes() <= DATE_INDEX_LIMIT_BYTES)
        );

        let second_date = locate_date_page(&state, &discovered, 250, 2)
            .expect("locate another date from the cached index");
        assert_eq!(second_date.offset, 0);
        assert_eq!(
            second_date.commits[1].commit.oid,
            run_git(&path, &["rev-parse", "HEAD~1"])
        );

        let known_cursors = vec![page.cursor.clone()];
        let mut reused_location = None;
        let mut reused_page_emitted = false;
        let reuse = state
            .with_located_date_page_and_location(
                &git_executable(),
                &discovered,
                &LocateHistoryDateParams {
                    before_timestamp: 400,
                    page_size: 2,
                    known_cursors: Some(known_cursors),
                },
                (
                    &AtomicBool::new(false),
                    Instant::now() + std::time::Duration::from_secs(5),
                ),
                |location, reused| {
                    assert!(reused);
                    reused_location = Some(location.clone());
                    Ok(())
                },
                |_| {
                    reused_page_emitted = true;
                    Ok(())
                },
            )
            .expect("reuse loaded page");
        assert!(reuse.is_none());
        assert!(!reused_page_emitted);
        let reused_location = reused_location.expect("date location sent");
        assert_eq!(reused_location.oid, expected);
        assert_eq!(reused_location.cursor, page.cursor);
        assert_eq!(reused_location.offset, page.offset);

        let mut missed_location = None;
        let fallback = state
            .with_located_date_page_and_location(
                &git_executable(),
                &discovered,
                &LocateHistoryDateParams {
                    before_timestamp: 400,
                    page_size: 2,
                    known_cursors: Some(vec!["v1:stale-query:0".into()]),
                },
                (
                    &AtomicBool::new(false),
                    Instant::now() + std::time::Duration::from_secs(5),
                ),
                |location, reused| {
                    assert!(!reused);
                    missed_location = Some(location.clone());
                    Ok(())
                },
                |page| Ok(page.clone()),
            )
            .expect("stale cursor falls back to a full page");
        let fallback = fallback.expect("page sent after cursor miss");
        assert_eq!(fallback.cursor, missed_location.unwrap().cursor);
        assert_eq!(fallback.offset, page.offset);

        let baseline = HistoryState::new();
        let first = read_page(&baseline, &discovered, None, 2).expect("baseline first page");
        let second = read_page(&baseline, &discovered, first.next_cursor.as_deref(), 2)
            .expect("baseline located page");
        let third = read_page(&baseline, &discovered, second.next_cursor.as_deref(), 2)
            .expect("baseline next page");
        assert_eq!(
            page.commits
                .iter()
                .map(|commit| &commit.graph)
                .collect::<Vec<_>>(),
            second
                .commits
                .iter()
                .map(|commit| &commit.graph)
                .collect::<Vec<_>>()
        );
        let previous = read_page(&state, &discovered, page.previous_cursor.as_deref(), 2)
            .expect("cached topology previous page");
        let next = read_page(&state, &discovered, page.next_cursor.as_deref(), 2)
            .expect("cached topology next page");
        assert_eq!(
            previous
                .commits
                .iter()
                .map(|commit| &commit.graph)
                .collect::<Vec<_>>(),
            first
                .commits
                .iter()
                .map(|commit| &commit.graph)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            next.commits
                .iter()
                .map(|commit| &commit.graph)
                .collect::<Vec<_>>(),
            third
                .commits
                .iter()
                .map(|commit| &commit.graph)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn date_topology_index_sorts_reverse_timestamps_and_keeps_topology_ties() {
        let timestamps = [100, 340, 340, 200, 500];
        let oids = (1..=timestamps.len())
            .map(|value| format!("{value:040x}"))
            .collect::<Vec<_>>();
        let mut index = DateTopologyIndex::new(40);
        for (ordinal, timestamp) in timestamps.into_iter().enumerate() {
            let parent = ordinal
                .checked_sub(1)
                .map(|parent| format!(" {}", oids[parent]))
                .unwrap_or_default();
            let line = format!("{}{parent}", oids[ordinal]);
            assert!(index.append(timestamp, ordinal as u32, line.as_bytes()));
        }
        index.finish();

        let tied = index.target(400, 2).unwrap().unwrap();
        assert_eq!(tied.oid, oids[1]);
        assert_eq!(tied.page_offset, Some(0));
        let lower_topology = index.target(250, 2).unwrap().unwrap();
        assert_eq!(lower_topology.oid, oids[3]);
        assert_eq!(lower_topology.page_offset, Some(2));
        assert!(index.target(100, 2).unwrap().is_none());
    }

    #[test]
    fn date_topology_index_rejects_growth_past_its_capacity_budget() {
        let mut index = DateTopologyIndex::new(40);
        let too_large = vec![b'x'; DATE_INDEX_LIMIT_BYTES];
        assert!(!index.append(1, 0, &too_large));
        assert_eq!(index.allocated_bytes(), 0);
    }

    #[test]
    fn locate_scope_miss_and_cancellation_preserve_existing_cursor() {
        let (_repo, path) = make_repo(8);
        let discovered = discover(&path);
        let state = HistoryState::new();
        let first = read_page(&state, &discovered, None, 2).expect("first page");
        let missing = "f".repeat(discovered.oid_length);
        assert_eq!(
            locate_page(&state, &discovered, &missing, 2)
                .unwrap_err()
                .code,
            ErrorCode::ScopeUnavailable
        );
        let second = read_page(&state, &discovered, first.next_cursor.as_deref(), 2)
            .expect("cursor survives scope miss");
        assert_eq!(second.offset, 2);

        let no_date_match = state
            .with_located_date_page(
                &git_executable(),
                &discovered,
                &LocateHistoryDateParams {
                    before_timestamp: i64::MIN,
                    page_size: 2,
                    known_cursors: None,
                },
                &AtomicBool::new(false),
                Instant::now() + std::time::Duration::from_secs(5),
                |page| Ok(page.clone()),
            )
            .unwrap_err();
        assert_eq!(no_date_match.code, ErrorCode::ScopeUnavailable);
        assert_eq!(no_date_match.message, "该日期及之前没有提交");
        let after_date_miss = read_page(&state, &discovered, second.next_cursor.as_deref(), 2)
            .expect("cursor survives date miss");
        assert_eq!(after_date_miss.offset, 4);

        let cancelled = AtomicBool::new(true);
        let error = state
            .with_located_page(
                &git_executable(),
                &discovered,
                &LocateCommitParams {
                    oid: second.commits[0].commit.oid.clone(),
                    page_size: 2,
                },
                &cancelled,
                Instant::now() + std::time::Duration::from_secs(5),
                |page| Ok(page.clone()),
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        let date_cancelled = state
            .with_located_date_page(
                &git_executable(),
                &discovered,
                &LocateHistoryDateParams {
                    before_timestamp: i64::MAX,
                    page_size: 2,
                    known_cursors: None,
                },
                &cancelled,
                Instant::now() + std::time::Duration::from_secs(5),
                |page| Ok(page.clone()),
            )
            .unwrap_err();
        assert_eq!(date_cancelled.code, ErrorCode::Cancelled);
        let third = read_page(&state, &discovered, second.next_cursor.as_deref(), 2)
            .expect("cursor survives cancelled locate");
        assert_eq!(third.offset, 4);

        let cancellable = HistoryState::new();
        let first = read_page(&cancellable, &discovered, None, 2)
            .expect("first page before cancelled date build");
        let error = cancellable
            .with_located_date_page(
                &git_executable(),
                &discovered,
                &LocateHistoryDateParams {
                    before_timestamp: i64::MAX,
                    page_size: 2,
                    known_cursors: None,
                },
                &AtomicBool::new(true),
                Instant::now() + std::time::Duration::from_secs(5),
                |page| Ok(page.clone()),
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert!(
            cancellable
                .query
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .date_index
                .is_none()
        );
        let retried = read_page(&cancellable, &discovered, first.next_cursor.as_deref(), 2)
            .expect("cursor remains usable after cancelled cache build");
        assert_eq!(retried.offset, 2);
    }

    #[test]
    fn graph_layout_is_identical_across_page_sizes_and_evicted_page_replay() {
        let (_repo, path) = make_repo(18);
        let discovered = discover(&path);
        let mut baseline = None;
        for page_size in [1, 2, 7, 200, 500] {
            let state = HistoryState::new();
            let mut cursor = None;
            let mut graph_by_oid = std::collections::HashMap::new();
            let mut first_cursor = None;
            loop {
                let page = read_page(&state, &discovered, cursor.as_deref(), page_size)
                    .expect("read graph page");
                first_cursor.get_or_insert_with(|| page.cursor.clone());
                for commit in &page.commits {
                    graph_by_oid.insert(commit.commit.oid.clone(), commit.graph.clone());
                }
                cursor = page.next_cursor;
                if cursor.is_none() {
                    break;
                }
            }
            let replay = read_page(&state, &discovered, first_cursor.as_deref(), page_size)
                .expect("replay first graph page");
            for commit in replay.commits {
                assert_eq!(graph_by_oid.get(&commit.commit.oid), Some(&commit.graph));
            }
            if let Some(expected) = &baseline {
                assert_eq!(expected, &graph_by_oid);
            } else {
                baseline = Some(graph_by_oid);
            }
        }
    }

    #[test]
    fn failed_page_emit_does_not_publish_frontier_page_or_pending_checkpoint() {
        let (_repo, path) = make_repo(450);
        let discovered = discover(&path);
        let state = HistoryState::new();
        let first = read_page(&state, &discovered, None, 200).unwrap_or_else(|error| {
            let head = fs::read_to_string(path.join(".git/HEAD"))
                .unwrap_or_else(|read_error| format!("<unreadable: {read_error}>"));
            let rev_list = diagnostic_git(&path, &["rev-list", "--count", "HEAD"]);
            let fsck = diagnostic_git(&path, &["fsck", "--full", "--no-reflogs"]);
            panic!(
                "first page failed: {error:?}; repo={}; HEAD={head:?}; rev-list={rev_list:?}; fsck={fsck:?}",
                path.display()
            );
        });
        let cursor = first.next_cursor.clone().expect("second page cursor");
        let error = state
            .with_page(
                &git_executable(),
                &discovered,
                Some(&cursor),
                200,
                &AtomicBool::new(false),
                Instant::now() + std::time::Duration::from_secs(10),
                |_| Err::<(), _>(repository::cancelled_error()),
            )
            .expect_err("failed response callback must fail the page");
        assert_eq!(error.code, ErrorCode::Cancelled);
        {
            let guard = state.query.lock().unwrap();
            let query = guard.as_ref().unwrap();
            assert_eq!(query.issued_frontier, 200);
            assert_eq!(query.cached_pages.len(), 1);
            assert_eq!(query.layout.next_ordinal, 0);
            assert_eq!(query.checkpoints.len(), 1);
            assert_eq!(query.checkpoints[0].next_ordinal, 200);
        }

        let retried = read_page(&state, &discovered, Some(&cursor), 200)
            .expect("retry from completed checkpoint");
        let reference_state = HistoryState::new();
        let reference_first = read_page(&reference_state, &discovered, None, 200).unwrap();
        let reference = read_page(
            &reference_state,
            &discovered,
            reference_first.next_cursor.as_deref(),
            200,
        )
        .unwrap();
        assert_eq!(retried.commits, reference.commits);
        let guard = state.query.lock().unwrap();
        let query = guard.as_ref().unwrap();
        assert_eq!(query.issued_frontier, 400);
        assert_eq!(query.cached_pages.len(), 2);
        assert!(
            query
                .checkpoints
                .iter()
                .any(|point| point.next_ordinal == 400)
        );
    }

    #[test]
    fn graph_parents_follow_git_effective_graft_and_shallow_boundaries() {
        let (_repo, path) = make_repo(4);
        let commits = run_git(&path, &["rev-list", "--reverse", "HEAD"])
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let head = commits.last().unwrap();
        let root = commits.first().unwrap();
        let raw_parent = &commits[commits.len() - 2];
        let grafts = path.join(".git/info/grafts");
        fs::write(&grafts, format!("{head} {root}\n")).expect("write graft boundary");
        let discovered = discover(&path);
        let page =
            read_page(&HistoryState::new(), &discovered, None, 20).expect("read grafted graph");
        let expected = run_git(&path, &["rev-list", "--topo-order", "--parents", "HEAD"])
            .lines()
            .map(|line| {
                let mut fields = line.split_ascii_whitespace();
                let oid = fields.next().unwrap().to_owned();
                let parents = fields.map(str::to_owned).collect::<Vec<_>>();
                (oid, parents)
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(page.commits.len(), expected.len());
        for commit in &page.commits {
            assert_eq!(commit.graph.parents, expected[&commit.commit.oid]);
        }
        let grafted_head = page
            .commits
            .iter()
            .find(|commit| commit.commit.oid == *head)
            .unwrap();
        assert_eq!(
            grafted_head.graph.parents.as_slice(),
            std::slice::from_ref(root)
        );
        assert_eq!(
            grafted_head.commit.parents.as_slice(),
            std::slice::from_ref(raw_parent)
        );
        assert!(grafted_head.graph.boundary);
        assert!(page.commits.last().unwrap().graph.below == 0);

        fs::remove_file(&grafts).expect("remove graft boundary");
        let shallow_file = path.join(".git/shallow");
        fs::write(&shallow_file, format!("{head}\n")).expect("write shallow boundary");
        let shallow = discover(&path);
        let page = read_page(&HistoryState::new(), &shallow, None, 20).expect("read shallow graph");
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].commit.oid, *head);
        assert!(page.commits[0].commit.parents.len() == 1);
        assert!(page.commits[0].graph.parents.is_empty());
        assert!(page.commits[0].graph.boundary);
        assert_eq!(page.commits[0].graph.below, 0);
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
    fn date_topology_cache_is_cleared_when_shallow_fingerprint_changes() {
        let (_repo, path) = make_repo(5);
        let discovered = discover(&path);
        let state = HistoryState::new();
        let _ = locate_date_page(&state, &discovered, i64::MAX, 2)
            .expect("build the date topology cache");
        assert!(
            state
                .query
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .date_index
                .is_some()
        );

        fs::write(
            Path::new(&discovered.info.common_dir).join("shallow"),
            "boundary changed\n",
        )
        .expect("mutate shallow boundary");
        assert_eq!(
            locate_date_page(&state, &discovered, i64::MAX, 2)
                .unwrap_err()
                .code,
            ErrorCode::SnapshotChanged
        );
        let query = state.query.lock().unwrap();
        let query = query.as_ref().unwrap();
        assert!(query.date_index.is_none());
        assert!(query.cached_pages.is_empty());
        assert_eq!(query.issued_frontier, 0);
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
