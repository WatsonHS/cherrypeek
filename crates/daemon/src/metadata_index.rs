use crate::{
    git_command::{GitFailure, ReadOnlyGit, string_arg},
    repository, session,
    session_store::SessionStore,
};
use commitscope_core::{
    ErrorCode, MetadataIndexAction, MetadataIndexCoverage, MetadataIndexFailure,
    MetadataIndexState, MetadataIndexStatus,
};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const APPLICATION_ID: i32 = 0x43534958;
const SCHEMA_VERSION: i32 = 1;
const DEFAULT_QUOTA: u64 = 2 * 1024 * 1024 * 1024;
const MIN_QUOTA: u64 = 256 * 1024;
const MAX_BATCH: usize = 64;
const KNOWN_SIDECARS: [&str; 3] = ["-journal", "-wal", "-shm"];
type CachedStatus = Option<(
    String,
    String,
    String,
    MetadataIndexStatus,
    Option<FileStamp>,
)>;

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

#[derive(Debug)]
pub struct IndexError {
    pub code: ErrorCode,
    pub message: String,
}

struct IndexTask {
    snapshot_key: String,
    repo_id: String,
    generation: String,
    cancelled: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    user_cancelled: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

#[derive(Default)]
pub struct TaskManager {
    task: Mutex<Option<IndexTask>>,
    status: Arc<Mutex<CachedStatus>>,
    operation: Mutex<()>,
    active_context: Arc<Mutex<Option<(String, String)>>>,
}

#[derive(Clone, Copy)]
enum StopKind {
    Pause,
    Cancel,
    External,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileStamp {
    length: u64,
    modified_ns: u128,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl FileStamp {
    fn same_file(&self, other: &Self) -> bool {
        #[cfg(unix)]
        {
            self.device == other.device && self.inode == other.inode
        }
        #[cfg(not(unix))]
        {
            true
        }
    }
}

fn file_stamp(path: &Path) -> Result<FileStamp, IndexError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| unavailable("Could not inspect metadata database file"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || link_count(&metadata) > 1 {
        return Err(unavailable(
            "Metadata database file has an unsafe type or link count",
        ));
    }
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    #[cfg(unix)]
    let stamp = FileStamp {
        length: metadata.len(),
        modified_ns,
        device: metadata.dev(),
        inode: metadata.ino(),
    };
    #[cfg(not(unix))]
    let stamp = FileStamp {
        length: metadata.len(),
        modified_ns,
    };
    Ok(stamp)
}

impl TaskManager {
    pub fn activate(&self, session: &session::RepositorySession) {
        *self
            .active_context
            .lock()
            .expect("metadata active context mutex poisoned") = Some((
            session.info.repo_id.clone(),
            session.info.generation.clone(),
        ));
        if let Some(task) = self
            .task
            .lock()
            .expect("metadata task mutex poisoned")
            .as_ref()
            && (task.repo_id != session.info.repo_id || task.generation != session.info.generation)
        {
            task.cancelled.store(true, Ordering::Release);
        }
    }

    pub fn deactivate(&self, repo_id: &str, generation: &str) {
        let mut active = self
            .active_context
            .lock()
            .expect("metadata active context mutex poisoned");
        if active
            .as_ref()
            .is_some_and(|context| context.0 == repo_id && context.1 == generation)
        {
            *active = None;
            if let Some(task) = self
                .task
                .lock()
                .expect("metadata task mutex poisoned")
                .as_ref()
            {
                task.cancelled.store(true, Ordering::Release);
            }
        }
    }

    pub fn shutdown(&self) {
        // Invalidate queued ensure/control calls before waiting for the serialized task operation.
        *self
            .active_context
            .lock()
            .expect("metadata active context mutex poisoned") = None;
        let _operation = self
            .operation
            .lock()
            .expect("metadata task operation mutex poisoned");
        if let Some(task) = self
            .task
            .lock()
            .expect("metadata task mutex poisoned")
            .take()
        {
            task.cancelled.store(true, Ordering::Release);
            let _ = task.handle.join();
        }
    }

    pub fn status(
        &self,
        store: &SessionStore,
        session: &session::RepositorySession,
        quota: u64,
    ) -> MetadataIndexStatus {
        if let Ok((key, _)) = snapshot_identity(session) {
            let cached = self
                .status
                .lock()
                .expect("metadata status mutex poisoned")
                .as_ref()
                .filter(|(repo, generation, snapshot, _, _)| {
                    repo == &session.info.repo_id
                        && generation == &session.info.generation
                        && snapshot == &key
                })
                .cloned();
            if let Some((_, _, _, mut status, stored_stamp)) = cached {
                let actual = cache_file_stamp(store, session).ok().flatten();
                if let Some(stamp) = actual.as_ref() {
                    status.disk_bytes = stamp.length;
                }
                if !matches!(
                    status.state,
                    MetadataIndexState::Idle | MetadataIndexState::Queued
                ) && (stored_stamp.is_some() || actual.is_some())
                {
                    let changed = match (stored_stamp.as_ref(), actual.as_ref()) {
                        (Some(before), Some(after)) => {
                            !before.same_file(after)
                                || (status.state != MetadataIndexState::Running && before != after)
                        }
                        (Some(_), None) => true,
                        (None, _) => false,
                    };
                    if changed || actual.is_none() {
                        status.state = MetadataIndexState::Unavailable;
                        status.coverage = MetadataIndexCoverage {
                            processed: 0,
                            complete: false,
                        };
                        status.error = Some(MetadataIndexFailure {
                            code: if actual.is_none() {
                                ErrorCode::IndexUnavailable
                            } else {
                                ErrorCode::IndexCorrupt
                            },
                            message: if actual.is_none() {
                                "Metadata index database was removed"
                            } else {
                                "Metadata index database changed outside the active index task"
                            }
                            .into(),
                        });
                    }
                }
                return status;
            }
            let mut status = idle_status(quota, None);
            status.snapshot_key = Some(key);
            return status;
        }
        idle_status(
            quota,
            Some(unavailable(
                "Could not derive the metadata snapshot identity",
            )),
        )
    }

    fn remember(&self, session: &session::RepositorySession, status: MetadataIndexStatus) {
        if let Some(snapshot_key) = status
            .snapshot_key
            .clone()
            .or_else(|| snapshot_identity(session).ok().map(|(key, _)| key))
        {
            let stamp = cache_file_stamp(&SessionStore::from_env(), session)
                .ok()
                .flatten();
            let active = self
                .active_context
                .lock()
                .expect("metadata active context mutex poisoned");
            if !active.as_ref().is_some_and(|context| {
                context.0 == session.info.repo_id && context.1 == session.info.generation
            }) {
                return;
            }
            *self.status.lock().expect("metadata status mutex poisoned") = Some((
                session.info.repo_id.clone(),
                session.info.generation.clone(),
                snapshot_key,
                status,
                stamp,
            ));
        }
    }

    pub fn ensure(
        &self,
        store: SessionStore,
        session: Arc<session::RepositorySession>,
        executable: PathBuf,
        quota: u64,
        requests: crate::server::ActiveRequests,
    ) {
        let _operation = self
            .operation
            .lock()
            .expect("metadata task operation mutex poisoned");
        if !self
            .active_context
            .lock()
            .expect("metadata active context mutex poisoned")
            .as_ref()
            .is_some_and(|context| {
                context.0 == session.info.repo_id && context.1 == session.info.generation
            })
        {
            return;
        }
        let Ok((key, _)) = snapshot_identity(&session) else {
            return;
        };
        {
            let mut task = self.task.lock().expect("metadata task mutex poisoned");
            if task.as_ref().is_some_and(|task| task.handle.is_finished())
                && let Some(finished) = task.take()
            {
                let _ = finished.handle.join();
            }
            if task.as_ref().is_some_and(|task| {
                task.snapshot_key == key
                    && task.repo_id == session.info.repo_id
                    && task.generation == session.info.generation
                    && !task.cancelled.load(Ordering::Acquire)
            }) {
                return;
            }
        }
        let current = self.status(&store, &session, quota);
        if matches!(
            current.state,
            MetadataIndexState::Paused
                | MetadataIndexState::Cancelled
                | MetadataIndexState::Complete
                | MetadataIndexState::QuotaLimited
                | MetadataIndexState::Failed
                | MetadataIndexState::Unavailable
        ) {
            self.remember(&session, current);
            return;
        }
        self.start_locked(store, session, executable, quota, requests, false);
    }

    pub fn control(
        &self,
        action: MetadataIndexAction,
        store: SessionStore,
        session: Arc<session::RepositorySession>,
        executable: Option<PathBuf>,
        quota: u64,
        requests: crate::server::ActiveRequests,
    ) -> MetadataIndexStatus {
        let _operation = self
            .operation
            .lock()
            .expect("metadata task operation mutex poisoned");
        if !self
            .active_context
            .lock()
            .expect("metadata active context mutex poisoned")
            .as_ref()
            .is_some_and(|context| {
                context.0 == session.info.repo_id && context.1 == session.info.generation
            })
        {
            let mut status = status(&store, &session, quota);
            status.state = MetadataIndexState::Failed;
            status.error = Some(MetadataIndexFailure {
                code: ErrorCode::StaleContext,
                message: "Repository session changed before the index control was applied".into(),
            });
            return status;
        }
        let mut queued_confirmation = false;
        let mut action_failure = None;
        match action {
            MetadataIndexAction::Pause => {
                self.stop_locked(StopKind::Pause, &session);
                let _ = set_persisted_state(&store, &session, quota, MetadataIndexState::Paused);
            }
            MetadataIndexAction::Cancel => {
                self.stop_locked(StopKind::Cancel, &session);
                let _ = set_persisted_state(&store, &session, quota, MetadataIndexState::Cancelled);
            }
            MetadataIndexAction::Rebuild => {
                self.stop_locked(StopKind::External, &session);
                let rebuilt = match reset_for_rebuild(&store, &session, quota) {
                    Ok(status) => {
                        self.remember(&session, status);
                        true
                    }
                    Err(error) => {
                        let mut status = idle_status(quota, Some(error));
                        status.snapshot_key = snapshot_identity(&session).ok().map(|(key, _)| key);
                        status.state = MetadataIndexState::Failed;
                        self.remember(&session, status.clone());
                        action_failure = Some(status);
                        false
                    }
                };
                if rebuilt && let Some(executable) = executable {
                    self.start_locked(
                        store.clone(),
                        Arc::clone(&session),
                        executable,
                        quota,
                        requests,
                        true,
                    );
                    queued_confirmation = true;
                }
            }
            MetadataIndexAction::Resume => {
                let existing = status(&store, &session, quota);
                self.remember(&session, existing);
                let completed = self
                    .status
                    .lock()
                    .expect("metadata status mutex poisoned")
                    .as_ref()
                    .is_some_and(|(repo, generation, _, status, _)| {
                        repo == &session.info.repo_id
                            && generation == &session.info.generation
                            && status.state == MetadataIndexState::Complete
                    });
                if completed {
                    return self.status(&store, &session, quota);
                }
                if let Some(executable) = executable {
                    self.start_locked(
                        store.clone(),
                        Arc::clone(&session),
                        executable,
                        quota,
                        requests,
                        true,
                    );
                    queued_confirmation = true;
                }
            }
        }
        if let Some(status) = action_failure {
            return status;
        }
        if queued_confirmation
            && let Some((repo, generation, key, status, _stamp)) = self
                .status
                .lock()
                .expect("metadata status mutex poisoned")
                .as_ref()
            && repo == &session.info.repo_id
            && generation == &session.info.generation
        {
            let mut status = status.clone();
            if status.state == MetadataIndexState::Paused
                || status.state == MetadataIndexState::Cancelled
            {
                status.state = MetadataIndexState::Queued;
            }
            status.snapshot_key = Some(key.clone());
            return status;
        }
        let current = status(&store, &session, quota);
        self.remember(&session, current.clone());
        current
    }

    fn stop_locked(&self, kind: StopKind, session: &session::RepositorySession) {
        let task = self
            .task
            .lock()
            .expect("metadata task mutex poisoned")
            .take();
        if let Some(task) = task {
            if !matches!(kind, StopKind::External)
                && (task.repo_id != session.info.repo_id
                    || task.generation != session.info.generation)
            {
                *self.task.lock().expect("metadata task mutex poisoned") = Some(task);
                return;
            }
            if matches!(kind, StopKind::Pause) {
                task.paused.store(true, Ordering::Release);
            }
            if matches!(kind, StopKind::Cancel) {
                task.user_cancelled.store(true, Ordering::Release);
            }
            task.cancelled.store(true, Ordering::Release);
            let _ = task.handle.join();
        }
    }

    fn start_locked(
        &self,
        store: SessionStore,
        session: Arc<session::RepositorySession>,
        executable: PathBuf,
        quota: u64,
        requests: crate::server::ActiveRequests,
        force: bool,
    ) {
        let Ok((snapshot_key, _)) = snapshot_identity(&session) else {
            return;
        };
        self.stop_locked(StopKind::External, &session);
        let cancelled = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let user_cancelled = Arc::new(AtomicBool::new(false));
        let cancel_worker = Arc::clone(&cancelled);
        let pause_worker = Arc::clone(&paused);
        let user_cancel_worker = Arc::clone(&user_cancelled);
        let key_for_worker = snapshot_key.clone();
        let progress_status = Arc::clone(&self.status);
        let active_context = Arc::clone(&self.active_context);
        let session_worker = Arc::clone(&session);
        let mut initial_status = self.status(&store, &session, quota);
        initial_status.state = MetadataIndexState::Queued;
        initial_status.coverage.complete = false;
        initial_status.error = None;
        let mut queued = initial_status.clone();
        queued.snapshot_key = Some(key_for_worker.clone());
        queued.state = MetadataIndexState::Queued;
        self.remember(&session, queued.clone());
        let handle = thread::spawn(move || {
            // Index work only consumes a batch when interactive requests are idle.
            let gate_cancel = Arc::clone(&cancel_worker);
            let remember = |status: MetadataIndexStatus| {
                let stamp = cache_file_stamp(&store, &session_worker).ok().flatten();
                let active = active_context
                    .lock()
                    .expect("metadata active context mutex poisoned");
                if !active.as_ref().is_some_and(|context| {
                    context.0 == session_worker.info.repo_id
                        && context.1 == session_worker.info.generation
                }) {
                    return;
                }
                if let Some(snapshot) = status.snapshot_key.clone() {
                    *progress_status
                        .lock()
                        .expect("metadata status mutex poisoned") = Some((
                        session_worker.info.repo_id.clone(),
                        session_worker.info.generation.clone(),
                        snapshot,
                        status,
                        stamp,
                    ));
                }
            };
            remember(queued);
            let gate = || {
                while !gate_cancel.load(Ordering::Acquire)
                    && requests
                        .lock()
                        .map(|active| active.values().any(|request| request.blocks_background))
                        .unwrap_or(true)
                {
                    thread::sleep(Duration::from_millis(25));
                }
            };
            gate();
            if !gate_cancel.load(Ordering::Acquire) {
                let status = run_index(
                    &store,
                    Arc::clone(&session_worker),
                    &executable,
                    quota,
                    &cancel_worker,
                    &pause_worker,
                    &user_cancel_worker,
                    force,
                    gate,
                    remember,
                );
                remember(status);
            }
        });
        let active = self
            .active_context
            .lock()
            .expect("metadata active context mutex poisoned");
        if !active.as_ref().is_some_and(|context| {
            context.0 == session.info.repo_id && context.1 == session.info.generation
        }) {
            cancelled.store(true, Ordering::Release);
            drop(active);
            let _ = handle.join();
            return;
        }
        *self.task.lock().expect("metadata task mutex poisoned") = Some(IndexTask {
            snapshot_key,
            repo_id: session.info.repo_id.clone(),
            generation: session.info.generation.clone(),
            cancelled,
            paused,
            user_cancelled,
            handle,
        });
    }
}

pub fn configured_quota() -> Result<u64, IndexError> {
    let Some(value) = std::env::var_os("COMMITSCOPE_INDEX_QUOTA_BYTES") else {
        return Ok(DEFAULT_QUOTA);
    };
    let value = value
        .to_str()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| unavailable("COMMITSCOPE_INDEX_QUOTA_BYTES must be an integer"))?;
    if !(MIN_QUOTA..=DEFAULT_QUOTA).contains(&value) {
        return Err(unavailable(
            "COMMITSCOPE_INDEX_QUOTA_BYTES is outside 256 KiB to 2 GiB",
        ));
    }
    Ok(value)
}

pub fn snapshot_identity(
    session: &session::RepositorySession,
) -> Result<(String, Vec<String>), IndexError> {
    let mut tips = session.discovered.scope_tips.clone();
    tips.sort();
    tips.dedup();
    let fingerprint = format!("{:?}", session.discovered.graph_boundary);
    let material = serde_json::to_vec(&(
        1_u8,
        &session.info.repository_key,
        &session.info.repository.object_format,
        &tips,
        fingerprint,
    ))
    .map_err(|_| corrupt("Could not encode the metadata index snapshot identity"))?;
    let key = hex(&Sha256::digest(material));
    Ok((key, tips))
}

pub fn idle_status(quota: u64, error: Option<IndexError>) -> MetadataIndexStatus {
    MetadataIndexStatus {
        snapshot_key: None,
        state: if error.is_some() {
            MetadataIndexState::Unavailable
        } else {
            MetadataIndexState::Idle
        },
        coverage: MetadataIndexCoverage {
            processed: 0,
            complete: false,
        },
        disk_bytes: 0,
        quota_bytes: quota,
        error: error.map(|error| MetadataIndexFailure {
            code: error.code,
            message: error.message,
        }),
    }
}

pub fn status(
    store: &SessionStore,
    session: &session::RepositorySession,
    quota: u64,
) -> MetadataIndexStatus {
    match IndexStore::open(store, session, quota) {
        Ok(index) => index.status(session),
        Err(error) => idle_status(quota, Some(error)),
    }
}

pub fn reset_for_rebuild(
    store: &SessionStore,
    session: &session::RepositorySession,
    quota: u64,
) -> Result<MetadataIndexStatus, IndexError> {
    let path = database_path(store, session)?;
    check_known_files(&path)?;
    for target in known_files(&path) {
        match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if !metadata.file_type().is_file() || metadata.nlink() != 1 {
                    return Err(unavailable(
                        "Metadata index cache file has an unsafe type or link count",
                    ));
                }
                fs::remove_file(&target)
                    .map_err(|_| unavailable("Could not remove the repository metadata cache"))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(unavailable(
                    "Could not inspect the repository metadata cache",
                ));
            }
        }
    }
    let index = IndexStore::open(store, session, quota)?;
    let (key, tips) = snapshot_identity(session)?;
    index.ensure_snapshot(session, &key, &tips)?;
    Ok(index.status(session))
}

#[allow(clippy::too_many_arguments)]
pub fn run_index(
    store: &SessionStore,
    session: Arc<session::RepositorySession>,
    executable: &Path,
    quota: u64,
    cancelled: &AtomicBool,
    paused: &AtomicBool,
    user_cancelled: &AtomicBool,
    force: bool,
    idle_gate: impl Fn(),
    progress: impl Fn(MetadataIndexStatus),
) -> MetadataIndexStatus {
    let result = run_index_inner(
        store,
        &session,
        executable,
        quota,
        cancelled,
        paused,
        user_cancelled,
        force,
        &idle_gate,
        &progress,
    );
    match result {
        Ok(status) => status,
        Err(error) => {
            let replaced = error.message.contains("was replaced while open");
            let mut status = if replaced {
                idle_status(quota, None)
            } else {
                match IndexStore::open(store, &session, quota) {
                    Ok(index) => index.status(&session),
                    Err(_) => idle_status(quota, None),
                }
            };
            status.snapshot_key = snapshot_identity(&session).ok().map(|(key, _)| key);
            status.state = match error.code {
                ErrorCode::ResourceLimit
                    if error.message.contains("quota")
                        || error.message.contains("SQLite is full") =>
                {
                    MetadataIndexState::QuotaLimited
                }
                ErrorCode::Cancelled if paused.load(Ordering::Acquire) => {
                    MetadataIndexState::Paused
                }
                ErrorCode::Cancelled if user_cancelled.load(Ordering::Acquire) => {
                    MetadataIndexState::Cancelled
                }
                ErrorCode::Cancelled => MetadataIndexState::Running,
                ErrorCode::IndexUnavailable => MetadataIndexState::Unavailable,
                _ => MetadataIndexState::Failed,
            };
            status.error = if error.code == ErrorCode::Cancelled {
                None
            } else {
                Some(MetadataIndexFailure {
                    code: error.code,
                    message: error.message,
                })
            };
            if replaced {
                status.coverage = MetadataIndexCoverage {
                    processed: 0,
                    complete: false,
                };
                status.disk_bytes = 0;
            }
            if !replaced
                && !matches!(
                    status.state,
                    MetadataIndexState::Running | MetadataIndexState::Unavailable
                )
                && let Ok(index) = IndexStore::open(store, &session, quota)
                && let Ok((snapshot_key, _)) = snapshot_identity(&session)
            {
                let _ = index.set_state(&snapshot_key, status.state, None);
            }
            status
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_index_inner(
    store: &SessionStore,
    session: &session::RepositorySession,
    executable: &Path,
    quota: u64,
    cancelled: &AtomicBool,
    paused: &AtomicBool,
    user_cancelled: &AtomicBool,
    force: bool,
    idle_gate: &impl Fn(),
    progress: &impl Fn(MetadataIndexStatus),
) -> Result<MetadataIndexStatus, IndexError> {
    let index = IndexStore::open(store, session, quota)?;
    let (snapshot_key, tips) = snapshot_identity(session)?;
    repository::verify_graph_fingerprint(
        &session.discovered,
        cancelled,
        Instant::now() + Duration::from_secs(15),
    )
    .map_err(map_repository_error)?;
    let _processed = index.ensure_snapshot(session, &snapshot_key, &tips)?;
    let persisted_state = index.persisted_state(&snapshot_key)?;
    if persisted_state == MetadataIndexState::Complete
        || (!force
            && matches!(
                persisted_state,
                MetadataIndexState::Paused
                    | MetadataIndexState::Cancelled
                    | MetadataIndexState::QuotaLimited
                    | MetadataIndexState::Failed
                    | MetadataIndexState::Unavailable
            ))
    {
        return Ok(index.status(session));
    }
    index.set_state(&snapshot_key, MetadataIndexState::Running, None)?;
    progress(index.status(session));
    if tips.is_empty() {
        index.mark_complete(&snapshot_key)?;
        let status = index.status(session);
        progress(status.clone());
        return Ok(status);
    }

    let git = ReadOnlyGit::new(executable.to_path_buf()).map_err(map_git_error)?;
    let mut args = vec![
        string_arg("-c"),
        string_arg("core.commitGraph=false"),
        string_arg("rev-list"),
        string_arg("--topo-order"),
    ];
    args.extend(tips.iter().map(string_arg));
    let mut stream = git
        .stream_lines(Path::new(&session.info.repository.path), &args, 128)
        .map_err(map_git_error)?;
    let deadline = Instant::now() + Duration::from_secs(60 * 60);
    let mut ordinal = 0_u64;
    let mut batch = Vec::<String>::with_capacity(MAX_BATCH);
    let mut checkpoint_last = None;
    let expected_checkpoint = index.checkpoint(&snapshot_key)?;
    loop {
        if cancelled.load(Ordering::Acquire) || paused.load(Ordering::Acquire) {
            drop(stream);
            if paused.load(Ordering::Acquire) {
                index.set_state(&snapshot_key, MetadataIndexState::Paused, None)?;
            } else if user_cancelled.load(Ordering::Acquire) {
                index.set_state(&snapshot_key, MetadataIndexState::Cancelled, None)?;
            }
            return Err(IndexError {
                code: ErrorCode::Cancelled,
                message: "Metadata index task stopped by request".into(),
            });
        }
        idle_gate();
        if cancelled.load(Ordering::Acquire) || paused.load(Ordering::Acquire) {
            continue;
        }
        let line = stream
            .next_line(cancelled, deadline)
            .map_err(map_git_error)?;
        let Some(line) = line else { break };
        let oid =
            String::from_utf8(line).map_err(|_| corrupt("Git returned a non-UTF-8 object ID"))?;
        if oid.len() != session.discovered.oid_length
            || !oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(corrupt("Git returned a malformed commit object ID"));
        }
        if ordinal < expected_checkpoint.0 {
            let expected = index.member_oid(&snapshot_key, ordinal)?;
            if expected.as_deref() != Some(oid.as_str()) {
                return Err(corrupt(
                    "The fixed snapshot does not match its persisted index checkpoint",
                ));
            }
            checkpoint_last = Some(oid);
            ordinal += 1;
            continue;
        }
        batch.push(oid);
        ordinal += 1;
        if batch.len() == MAX_BATCH {
            idle_gate();
            if cancelled.load(Ordering::Acquire) || paused.load(Ordering::Acquire) {
                continue;
            }
            index_batch(
                &index,
                session,
                &snapshot_key,
                &batch,
                executable,
                cancelled,
                quota,
            )?;
            batch.clear();
            progress(index.status(session));
        }
    }
    if !batch.is_empty() {
        idle_gate();
        if cancelled.load(Ordering::Acquire) || paused.load(Ordering::Acquire) {
            if paused.load(Ordering::Acquire) {
                index.set_state(&snapshot_key, MetadataIndexState::Paused, None)?;
            } else if user_cancelled.load(Ordering::Acquire) {
                index.set_state(&snapshot_key, MetadataIndexState::Cancelled, None)?;
            }
            return Err(IndexError {
                code: ErrorCode::Cancelled,
                message: "Metadata index task stopped by request".into(),
            });
        }
        index_batch(
            &index,
            session,
            &snapshot_key,
            &batch,
            executable,
            cancelled,
            quota,
        )?;
        progress(index.status(session));
    }
    if ordinal < expected_checkpoint.0
        || (expected_checkpoint.0 > 0
            && checkpoint_last.as_deref() != expected_checkpoint.1.as_deref())
    {
        return Err(corrupt(
            "The fixed snapshot ended before its persisted index checkpoint",
        ));
    }
    if cancelled.load(Ordering::Acquire) || paused.load(Ordering::Acquire) {
        if paused.load(Ordering::Acquire) {
            index.set_state(&snapshot_key, MetadataIndexState::Paused, None)?;
        } else if user_cancelled.load(Ordering::Acquire) {
            index.set_state(&snapshot_key, MetadataIndexState::Cancelled, None)?;
        }
        return Err(IndexError {
            code: ErrorCode::Cancelled,
            message: "Metadata index task stopped by request".into(),
        });
    }
    repository::verify_graph_fingerprint(
        &session.discovered,
        cancelled,
        Instant::now() + Duration::from_secs(15),
    )
    .map_err(map_repository_error)?;
    index.mark_complete(&snapshot_key)?;
    let status = index.status(session);
    progress(status.clone());
    Ok(status)
}

fn index_batch(
    index: &IndexStore,
    session: &session::RepositorySession,
    snapshot_key: &str,
    oids: &[String],
    executable: &Path,
    cancelled: &AtomicBool,
    quota: u64,
) -> Result<(), IndexError> {
    repository::verify_graph_fingerprint(
        &session.discovered,
        cancelled,
        Instant::now() + Duration::from_secs(15),
    )
    .map_err(map_repository_error)?;
    let parsed = repository::read_commit_metadata(
        executable,
        &session.discovered,
        oids,
        cancelled,
        Instant::now() + Duration::from_secs(60),
    )
    .map_err(map_repository_error)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(IndexError {
            code: ErrorCode::Cancelled,
            message: "Metadata index task was cancelled".into(),
        });
    }
    if parsed.len() != oids.len() {
        return Err(corrupt("Git returned an incomplete metadata batch"));
    }
    index.insert_batch(snapshot_key, &parsed, quota)?;
    repository::verify_graph_fingerprint(
        &session.discovered,
        cancelled,
        Instant::now() + Duration::from_secs(15),
    )
    .map_err(map_repository_error)?;
    Ok(())
}

struct IndexStore {
    path: PathBuf,
    quota: u64,
    opened_identity: FileStamp,
    connection: Mutex<Connection>,
}

impl IndexStore {
    fn open(
        store: &SessionStore,
        session: &session::RepositorySession,
        quota: u64,
    ) -> Result<Self, IndexError> {
        let path = database_path(store, session)?;
        check_known_files(&path)?;
        let connection = Connection::open(&path).map_err(map_sql_error)?;
        let opened_identity = file_stamp(&path)?;
        let index = Self {
            path,
            quota,
            opened_identity,
            connection: Mutex::new(connection),
        };
        let connection = index.connection()?;
        connection
            .busy_timeout(Duration::from_millis(250))
            .map_err(map_sql_error)?;
        connection
            .pragma_update(None, "trusted_schema", "OFF")
            .map_err(map_sql_error)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(map_sql_error)?;
        connection
            .pragma_update(None, "cache_size", -2048_i64)
            .map_err(map_sql_error)?;
        index.validate_existing(&connection)?;
        index.configure(&connection)?;
        index.initialize(&connection)?;
        drop(connection);
        Ok(index)
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>, IndexError> {
        self.verify_identity()?;
        check_known_files(&self.path)?;
        let connection = self
            .connection
            .lock()
            .expect("metadata SQLite connection poisoned");
        self.verify_identity()?;
        Ok(connection)
    }

    fn verify_identity(&self) -> Result<(), IndexError> {
        let actual = file_stamp(&self.path).map_err(|error| IndexError {
            code: error.code,
            message: format!(
                "Metadata index database was replaced while open (it may have been removed): {}",
                error.message
            ),
        })?;
        if !self.opened_identity.same_file(&actual) {
            return Err(corrupt(
                "Metadata index database was replaced while open; reopen the index",
            ));
        }
        Ok(())
    }

    fn configure(&self, connection: &Connection) -> Result<(), IndexError> {
        connection
            .pragma_update(None, "journal_mode", "DELETE")
            .map_err(map_sql_error)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(map_sql_error)?;
        let page_size: i64 = connection
            .pragma_query_value(None, "page_size", |row| row.get(0))
            .map_err(map_sql_error)?;
        let max_pages =
            i64::try_from((self.quota / 3) / u64::try_from(page_size).unwrap_or(1).max(1))
                .unwrap_or(i64::MAX)
                .max(1);
        connection
            .pragma_update(None, "max_page_count", max_pages)
            .map_err(map_sql_error)?;
        Ok(())
    }

    fn initialize(&self, connection: &Connection) -> Result<(), IndexError> {
        let version: i32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(map_sql_error)?;
        let app_id: i32 = connection
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .map_err(map_sql_error)?;
        if version == 0 && app_id == 0 {
            let user_tables: i64 = connection.query_row("SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |row| row.get(0)).map_err(map_sql_error)?;
            if user_tables != 0 {
                return Err(IndexError {
                    code: ErrorCode::IndexVersionUnsupported,
                    message:
                        "Unrecognized metadata database contents; rebuild this repository index"
                            .into(),
                });
            }
            let tx = connection.unchecked_transaction().map_err(map_sql_error)?;
            tx.execute_batch("CREATE TABLE commits(oid TEXT PRIMARY KEY, parents_json TEXT NOT NULL, summary TEXT NOT NULL, summary_truncated INTEGER NOT NULL, message TEXT NOT NULL, author_name TEXT NOT NULL, author_email TEXT NOT NULL, author_timestamp TEXT NOT NULL, author_offset TEXT NOT NULL, committer_name TEXT NOT NULL, committer_email TEXT NOT NULL, committer_timestamp TEXT NOT NULL, committer_offset TEXT NOT NULL, text_lossy INTEGER NOT NULL); CREATE TABLE snapshots(snapshot_key TEXT PRIMARY KEY, tips_json TEXT NOT NULL, graph_fingerprint TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, last_used_unix_ms INTEGER NOT NULL, last_oid TEXT); CREATE TABLE snapshot_commits(snapshot_key TEXT NOT NULL REFERENCES snapshots(snapshot_key) ON DELETE CASCADE, ordinal INTEGER NOT NULL, oid TEXT NOT NULL REFERENCES commits(oid), PRIMARY KEY(snapshot_key, ordinal), UNIQUE(snapshot_key, oid)); CREATE INDEX snapshot_commits_oid ON snapshot_commits(snapshot_key, oid);").map_err(map_sql_error)?;
            tx.pragma_update(None, "application_id", APPLICATION_ID)
                .map_err(map_sql_error)?;
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(map_sql_error)?;
            tx.commit().map_err(map_sql_error)?;
        } else if version != SCHEMA_VERSION || app_id != APPLICATION_ID {
            return Err(IndexError {
                code: ErrorCode::IndexVersionUnsupported,
                message:
                    "Metadata index schema version is unsupported; rebuild this repository index"
                        .into(),
            });
        }
        Ok(())
    }

    fn validate_existing(&self, connection: &Connection) -> Result<(), IndexError> {
        let version: i32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(map_sql_error)?;
        let app_id: i32 = connection
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .map_err(map_sql_error)?;
        if version == 0 && app_id == 0 {
            let user_tables: i64 = connection.query_row("SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |row| row.get(0)).map_err(map_sql_error)?;
            if user_tables != 0 {
                return Err(IndexError {
                    code: ErrorCode::IndexVersionUnsupported,
                    message:
                        "Unrecognized metadata database contents; rebuild this repository index"
                            .into(),
                });
            }
            return Ok(());
        }
        if version != SCHEMA_VERSION || app_id != APPLICATION_ID {
            return Err(IndexError {
                code: ErrorCode::IndexVersionUnsupported,
                message:
                    "Metadata index schema version is unsupported; rebuild this repository index"
                        .into(),
            });
        }
        let check: String = connection
            .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
            .map_err(map_sql_error)?;
        if check != "ok" {
            return Err(corrupt(
                "Metadata index integrity check failed; rebuild this repository index",
            ));
        }
        Ok(())
    }

    fn ensure_snapshot(
        &self,
        session: &session::RepositorySession,
        key: &str,
        tips: &[String],
    ) -> Result<u64, IndexError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction().map_err(map_sql_error)?;
        let tips_json =
            serde_json::to_string(tips).map_err(|_| corrupt("Could not encode snapshot tips"))?;
        let fingerprint = format!("{:?}", session.discovered.graph_boundary);
        tx.execute("INSERT OR IGNORE INTO snapshots(snapshot_key,tips_json,graph_fingerprint,processed,complete,state,last_used_unix_ms,last_oid) VALUES(?1,?2,?3,0,0,'idle',?4,NULL)", params![key,tips_json,fingerprint,i64::try_from(now_ms()).unwrap_or(i64::MAX)]).map_err(map_sql_error)?;
        let stored: (String, String, i64) = tx
            .query_row(
                "SELECT tips_json,graph_fingerprint,processed FROM snapshots WHERE snapshot_key=?1",
                [key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(map_sql_error)?;
        if stored.0 != tips_json || stored.1 != fingerprint {
            return Err(corrupt(
                "Metadata snapshot key does not match its frozen inputs",
            ));
        }
        tx.execute(
            "UPDATE snapshots SET last_used_unix_ms=?2 WHERE snapshot_key=?1",
            params![key, i64::try_from(now_ms()).unwrap_or(i64::MAX)],
        )
        .map_err(map_sql_error)?;
        tx.execute("DELETE FROM snapshots WHERE snapshot_key<>?1 AND snapshot_key NOT IN (SELECT snapshot_key FROM snapshots WHERE snapshot_key<>?1 ORDER BY last_used_unix_ms DESC LIMIT 7)", [key]).map_err(map_sql_error)?;
        tx.commit().map_err(map_sql_error)?;
        u64::try_from(stored.2).map_err(|_| corrupt("Metadata index processed count is invalid"))
    }

    fn checkpoint(&self, key: &str) -> Result<(u64, Option<String>), IndexError> {
        self.connection()?
            .query_row(
                "SELECT processed,last_oid FROM snapshots WHERE snapshot_key=?1",
                [key],
                |row| Ok((row.get::<_, i64>(0)?, row.get(1)?)),
            )
            .map(|(processed, last)| {
                Ok((
                    u64::try_from(processed)
                        .map_err(|_| corrupt("Metadata index processed count is invalid"))?,
                    last,
                ))
            })
            .map_err(map_sql_error)?
    }

    fn member_oid(&self, key: &str, ordinal: u64) -> Result<Option<String>, IndexError> {
        let ordinal =
            i64::try_from(ordinal).map_err(|_| corrupt("Metadata index ordinal is invalid"))?;
        self.connection()?
            .query_row(
                "SELECT oid FROM snapshot_commits WHERE snapshot_key=?1 AND ordinal=?2",
                params![key, ordinal],
                |row| row.get(0),
            )
            .optional()
            .map_err(map_sql_error)
    }

    fn is_complete(&self, key: &str) -> Result<bool, IndexError> {
        self.connection()?
            .query_row(
                "SELECT complete FROM snapshots WHERE snapshot_key=?1",
                [key],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value != 0)
            .map_err(map_sql_error)
    }

    fn persisted_state(&self, key: &str) -> Result<MetadataIndexState, IndexError> {
        self.connection()?
            .query_row(
                "SELECT state FROM snapshots WHERE snapshot_key=?1",
                [key],
                |row| row.get::<_, String>(0),
            )
            .map(|value| parse_state(&value))
            .map_err(map_sql_error)
    }

    fn set_state(
        &self,
        key: &str,
        state: MetadataIndexState,
        error: Option<&str>,
    ) -> Result<(), IndexError> {
        let _ = error;
        let connection = self.connection()?;
        connection
            .execute(
                "UPDATE snapshots SET state=?2 WHERE snapshot_key=?1",
                params![key, state_name(state)],
            )
            .map_err(map_sql_error)?;
        Ok(())
    }

    fn insert_batch(
        &self,
        key: &str,
        commits: &[repository::ParsedCommitMetadata],
        quota: u64,
    ) -> Result<(), IndexError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction().map_err(map_sql_error)?;
        let mut ordinal: i64 = tx
            .query_row(
                "SELECT processed FROM snapshots WHERE snapshot_key=?1",
                [key],
                |row| row.get(0),
            )
            .map_err(map_sql_error)?;
        for parsed in commits {
            let commit = &parsed.summary;
            tx.execute("INSERT OR IGNORE INTO commits(oid,parents_json,summary,summary_truncated,message,author_name,author_email,author_timestamp,author_offset,committer_name,committer_email,committer_timestamp,committer_offset,text_lossy) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)", params![commit.oid,serde_json::to_string(&commit.parents).map_err(|_| corrupt("Could not encode commit parents"))?,commit.summary,commit.summary_truncated,parsed.message,commit.author.name,commit.author.email,commit.author.timestamp,commit.author.offset,commit.committer.name,commit.committer.email,commit.committer.timestamp,commit.committer.offset,commit.text_lossy]).map_err(map_sql_error)?;
            tx.execute(
                "INSERT OR IGNORE INTO snapshot_commits(snapshot_key,ordinal,oid) VALUES(?1,?2,?3)",
                params![key, ordinal, commit.oid],
            )
            .map_err(map_sql_error)?;
            ordinal = ordinal
                .checked_add(1)
                .ok_or_else(|| corrupt("Metadata index ordinal overflow"))?;
        }
        tx.execute(
            "UPDATE snapshots SET processed=?2,last_oid=?3,state='running' WHERE snapshot_key=?1",
            params![
                key,
                ordinal,
                commits.last().map(|commit| commit.summary.oid.as_str())
            ],
        )
        .map_err(map_sql_error)?;
        if disk_bytes(&self.path)? > quota
            || self
                .path
                .metadata()
                .map_err(|_| unavailable("Could not inspect metadata database size"))?
                .len()
                > quota / 3
        {
            return Err(IndexError {
                code: ErrorCode::ResourceLimit,
                message: "Metadata index reached the repository disk quota".into(),
            });
        }
        self.verify_identity()?;
        tx.commit().map_err(map_sql_error)?;
        Ok(())
    }

    fn mark_complete(&self, key: &str) -> Result<(), IndexError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction().map_err(map_sql_error)?;
        let processed: i64 = tx
            .query_row(
                "SELECT processed FROM snapshots WHERE snapshot_key=?1",
                [key],
                |row| row.get(0),
            )
            .map_err(map_sql_error)?;
        let members: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM snapshot_commits WHERE snapshot_key=?1",
                [key],
                |row| row.get(0),
            )
            .map_err(map_sql_error)?;
        if processed != members {
            return Err(corrupt(
                "Metadata coverage does not match committed snapshot members",
            ));
        }
        tx.execute(
            "UPDATE snapshots SET complete=1,state='complete' WHERE snapshot_key=?1",
            [key],
        )
        .map_err(map_sql_error)?;
        tx.commit().map_err(map_sql_error)
    }

    fn status(&self, session: &session::RepositorySession) -> MetadataIndexStatus {
        let Ok((key, _)) = snapshot_identity(session) else {
            return idle_status(self.quota, Some(corrupt("Invalid snapshot identity")));
        };
        let disk = disk_bytes(&self.path).unwrap_or(0);
        let row = self.connection().and_then(|connection| {
            connection
                .query_row(
                    "SELECT processed,complete,state FROM snapshots WHERE snapshot_key=?1",
                    [&key],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(map_sql_error)
        });
        match row {
            Ok(Some((processed, complete, state))) => MetadataIndexStatus {
                snapshot_key: Some(key),
                state: parse_state(&state),
                coverage: MetadataIndexCoverage {
                    processed: u64::try_from(processed).unwrap_or(0),
                    complete: complete != 0,
                },
                disk_bytes: disk,
                quota_bytes: self.quota,
                error: None,
            },
            Ok(None) => MetadataIndexStatus {
                snapshot_key: Some(key),
                state: MetadataIndexState::Idle,
                coverage: MetadataIndexCoverage {
                    processed: 0,
                    complete: false,
                },
                disk_bytes: disk,
                quota_bytes: self.quota,
                error: None,
            },
            Err(error) => {
                let mut status = idle_status(self.quota, Some(error));
                status.snapshot_key = Some(key);
                status.disk_bytes = disk;
                status
            }
        }
    }
}

fn database_path(
    store: &SessionStore,
    session: &session::RepositorySession,
) -> Result<PathBuf, IndexError> {
    let root = store
        .metadata_cache_root(&session.info.repository)
        .map_err(|_| {
            unavailable("Application data directory is unavailable or overlaps the repository")
        })?;
    let digest = hex(&Sha256::digest(session.info.repository_key.as_bytes()));
    let repo_dir = root.join(digest);
    fs::create_dir_all(&repo_dir)
        .map_err(|_| unavailable("Could not create the metadata index cache directory"))?;
    let metadata = fs::symlink_metadata(&repo_dir)
        .map_err(|_| unavailable("Could not inspect metadata index cache directory"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(unavailable("Metadata index cache directory is unsafe"));
    }
    Ok(repo_dir.join("index.sqlite3"))
}

fn cache_file_stamp(
    store: &SessionStore,
    session: &session::RepositorySession,
) -> Result<Option<FileStamp>, IndexError> {
    let path = database_path(store, session)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(unavailable("Could not inspect metadata database file")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || link_count(&metadata) > 1 {
        return Err(unavailable(
            "Metadata database file has an unsafe type or link count",
        ));
    }
    check_known_files(&path)?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    #[cfg(unix)]
    let stamp = FileStamp {
        length: disk_bytes(&path)?,
        modified_ns,
        device: metadata.dev(),
        inode: metadata.ino(),
    };
    #[cfg(not(unix))]
    let stamp = FileStamp {
        length: disk_bytes(&path)?,
        modified_ns,
    };
    Ok(Some(stamp))
}

#[cfg(unix)]
fn link_count(metadata: &fs::Metadata) -> u64 {
    metadata.nlink()
}
#[cfg(not(unix))]
fn link_count(_metadata: &fs::Metadata) -> u64 {
    1
}

fn set_persisted_state(
    store: &SessionStore,
    session: &session::RepositorySession,
    quota: u64,
    state: MetadataIndexState,
) -> Result<(), IndexError> {
    let index = IndexStore::open(store, session, quota)?;
    let (key, tips) = snapshot_identity(session)?;
    index.ensure_snapshot(session, &key, &tips)?;
    if !index.is_complete(&key)? {
        index.set_state(&key, state, None)?;
    }
    Ok(())
}

fn known_files(path: &Path) -> Vec<PathBuf> {
    let mut files = vec![path.to_path_buf()];
    for suffix in KNOWN_SIDECARS {
        files.push(PathBuf::from(format!("{}{}", path.display(), suffix)));
    }
    files
}

fn check_known_files(path: &Path) -> Result<(), IndexError> {
    for file in known_files(path) {
        match fs::symlink_metadata(&file) {
            Ok(metadata)
                if metadata.file_type().is_symlink()
                    || !metadata.is_file()
                    || link_count(&metadata) > 1 =>
            {
                return Err(unavailable(
                    "Metadata index cache file has an unsafe type or link count",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(unavailable("Could not inspect metadata index cache files")),
        }
    }
    Ok(())
}

fn disk_bytes(path: &Path) -> Result<u64, IndexError> {
    known_files(path)
        .into_iter()
        .try_fold(0_u64, |sum, file| match fs::symlink_metadata(file) {
            Ok(metadata) if metadata.is_file() => sum
                .checked_add(metadata.len())
                .ok_or_else(|| unavailable("Metadata index size overflow")),
            Ok(_) => Err(unavailable("Metadata index sidecar has an unsafe type")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(sum),
            Err(_) => Err(unavailable("Could not inspect metadata index size")),
        })
}

fn map_git_error(error: GitFailure) -> IndexError {
    let (code, message) = match error {
        GitFailure::Cancelled => (
            ErrorCode::Cancelled,
            "Metadata index task was cancelled".into(),
        ),
        GitFailure::Timeout => (
            ErrorCode::Timeout,
            "Metadata index Git operation timed out".into(),
        ),
        GitFailure::ResourceLimit => (
            ErrorCode::ResourceLimit,
            "Metadata index Git output exceeded its limit".into(),
        ),
        GitFailure::Unavailable(message) => (ErrorCode::GitUnavailable, message),
        GitFailure::CommandFailed(message) => (ErrorCode::GitError, message),
    };
    IndexError { code, message }
}

fn map_repository_error(error: repository::PreviewError) -> IndexError {
    IndexError {
        code: error.code,
        message: error.message,
    }
}
fn map_sql_error(error: rusqlite::Error) -> IndexError {
    if matches!(&error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::DiskFull)
    {
        return IndexError {
            code: ErrorCode::ResourceLimit,
            message: "SQLite is full within the metadata disk quota".into(),
        };
    }
    let message = error.to_string();
    if matches!(error, rusqlite::Error::SqliteFailure(_, _)) {
        IndexError {
            code: ErrorCode::IndexCorrupt,
            message: "Metadata index is damaged; rebuild this repository index".into(),
        }
    } else {
        IndexError {
            code: ErrorCode::IndexUnavailable,
            message: format!("Metadata index unavailable: {message}"),
        }
    }
}
fn unavailable(message: &str) -> IndexError {
    IndexError {
        code: ErrorCode::IndexUnavailable,
        message: message.into(),
    }
}
fn corrupt(message: &str) -> IndexError {
    IndexError {
        code: ErrorCode::IndexCorrupt,
        message: message.into(),
    }
}
fn state_name(state: MetadataIndexState) -> &'static str {
    match state {
        MetadataIndexState::Idle => "idle",
        MetadataIndexState::Queued => "queued",
        MetadataIndexState::Running => "running",
        MetadataIndexState::Paused => "paused",
        MetadataIndexState::Cancelled => "cancelled",
        MetadataIndexState::Complete => "complete",
        MetadataIndexState::QuotaLimited => "quotaLimited",
        MetadataIndexState::Unavailable => "unavailable",
        MetadataIndexState::Failed => "failed",
    }
}
fn parse_state(value: &str) -> MetadataIndexState {
    match value {
        "queued" => MetadataIndexState::Queued,
        "running" => MetadataIndexState::Running,
        "paused" => MetadataIndexState::Paused,
        "cancelled" => MetadataIndexState::Cancelled,
        "complete" => MetadataIndexState::Complete,
        "quotaLimited" => MetadataIndexState::QuotaLimited,
        "unavailable" => MetadataIndexState::Unavailable,
        "failed" => MetadataIndexState::Failed,
        _ => MetadataIndexState::Idle,
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use commitscope_core::{CommitIdentity, CommitSummary};
    use std::sync::atomic::AtomicU64;

    static NEXT_TEST_DB: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn shutdown_invalidates_context_before_reaping_worker() {
        let manager = TaskManager::default();
        *manager.active_context.lock().unwrap() = Some(("repo".into(), "generation".into()));
        manager.shutdown();
        assert_eq!(*manager.active_context.lock().unwrap(), None);
    }

    fn temporary_db() -> PathBuf {
        std::env::temp_dir().join(format!(
            "commitscope-index-{}-{}.sqlite3",
            std::process::id(),
            NEXT_TEST_DB.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn initialized_index(path: PathBuf, quota: u64) -> IndexStore {
        let connection = Connection::open(&path).unwrap();
        let opened_identity = file_stamp(&path).unwrap();
        let index = IndexStore {
            path,
            quota,
            opened_identity,
            connection: Mutex::new(connection),
        };
        {
            let connection = index.connection.lock().unwrap();
            connection
                .pragma_update(None, "trusted_schema", "OFF")
                .unwrap();
            connection
                .pragma_update(None, "foreign_keys", "ON")
                .unwrap();
            index.configure(&connection).unwrap();
            index.initialize(&connection).unwrap();
        }
        index
    }

    #[test]
    fn schema_initializes_only_an_empty_database_and_rejects_unknown_versions() {
        let path = temporary_db();
        let connection = Connection::open(&path).unwrap();
        let opened_identity = file_stamp(&path).unwrap();
        let index = IndexStore {
            connection: Mutex::new(connection),
            path,
            quota: DEFAULT_QUOTA,
            opened_identity,
        };
        {
            let connection = index.connection.lock().unwrap();
            index.validate_existing(&connection).unwrap();
            index.configure(&connection).unwrap();
            index.initialize(&connection).unwrap();
            assert_eq!(
                connection
                    .pragma_query_value(None, "application_id", |row| row.get::<_, i32>(0))
                    .unwrap(),
                APPLICATION_ID
            );
            assert_eq!(
                connection
                    .pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))
                    .unwrap(),
                SCHEMA_VERSION
            );
        }
        let path = temporary_db();
        let connection = Connection::open(&path).unwrap();
        let opened_identity = file_stamp(&path).unwrap();
        let unknown = IndexStore {
            connection: Mutex::new(connection),
            path,
            quota: DEFAULT_QUOTA,
            opened_identity,
        };
        {
            let connection = unknown.connection.lock().unwrap();
            connection
                .execute_batch("CREATE TABLE caller_data(value TEXT)")
                .unwrap();
            assert_eq!(
                unknown.validate_existing(&connection).unwrap_err().code,
                ErrorCode::IndexVersionUnsupported
            );
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM caller_data", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn detects_database_replacement_while_connection_is_open() {
        let path = temporary_db();
        let index = initialized_index(path.clone(), DEFAULT_QUOTA);
        let replacement = path.with_extension("replacement.sqlite3");
        let backup = path.with_extension("old.sqlite3");
        {
            let replacement_connection = Connection::open(&replacement).unwrap();
            replacement_connection
                .execute_batch("PRAGMA application_id=1129531720; PRAGMA user_version=1;")
                .unwrap();
        }
        fs::rename(&path, &backup).unwrap();
        fs::rename(&replacement, &path).unwrap();
        let error = index.member_oid("snapshot", 0).unwrap_err();
        assert_eq!(error.code, ErrorCode::IndexCorrupt);
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(backup);
    }

    #[test]
    fn detects_database_removal_without_recreating_the_path() {
        let path = temporary_db();
        let index = initialized_index(path.clone(), DEFAULT_QUOTA);
        fs::remove_file(&path).unwrap();
        let error = index.member_oid("snapshot", 0).unwrap_err();
        assert!(error.message.contains("was replaced while open"));
        assert!(!path.exists());
    }

    #[test]
    fn quota_page_limit_rolls_back_metadata_and_membership_together() {
        let index = initialized_index(temporary_db(), 256 * 1024);
        {
            let connection = index.connection.lock().unwrap();
            connection.execute("INSERT INTO snapshots(snapshot_key,tips_json,graph_fingerprint,state,last_used_unix_ms) VALUES('snapshot','[]','fingerprint','running',0)", []).unwrap();
            let pages: i64 = connection
                .pragma_query_value(None, "page_count", |row| row.get(0))
                .unwrap();
            connection
                .pragma_update(None, "max_page_count", pages)
                .unwrap();
        }
        let identity = CommitIdentity {
            name: "Agent".into(),
            email: "agent@example.test".into(),
            timestamp: "1700000000".into(),
            offset: "+0800".into(),
        };
        let parsed = repository::ParsedCommitMetadata {
            summary: CommitSummary {
                oid: "a".repeat(40),
                parents: Vec::new(),
                summary: "large".into(),
                summary_truncated: false,
                author: identity.clone(),
                committer: identity,
                text_lossy: false,
            },
            message: "x".repeat(128 * 1024),
        };
        let error = index
            .insert_batch("snapshot", &[parsed], 256 * 1024)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceLimit);
        let connection = index.connection.lock().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT processed FROM snapshots WHERE snapshot_key='snapshot'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM snapshot_commits WHERE snapshot_key='snapshot'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM commits", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn empty_scope_has_a_complete_zero_coverage_status() {
        let status = MetadataIndexStatus {
            snapshot_key: Some("empty".into()),
            state: MetadataIndexState::Complete,
            coverage: MetadataIndexCoverage {
                processed: 0,
                complete: true,
            },
            disk_bytes: 0,
            quota_bytes: DEFAULT_QUOTA,
            error: None,
        };
        assert_eq!(status.coverage.processed, 0);
        assert!(status.coverage.complete);
    }
}
