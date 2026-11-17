use crate::{framing, repository, runtime, session, session_store};
use commitscope_core::{
    BranchesContainingParams, ClientMessage, ControlMetadataIndexParams, CoreReady, Coverage,
    EmptyParams, ErrorCode, GetActivityStatsParams, GetCommitParams, GetHandoffFactsParams,
    ListChangedFilesParams, ListPathChangesParams, ListSearchPathsParams, ListTreeParams,
    LocateCommitParams, LocateHistoryDateParams, MetadataIndexAction, OpenRepositoryParams,
    PROTOCOL_VERSION, ReadBlameParams, ReadDiffParams, ReadFileChangeParams, ReadFileContentParams,
    ReadFileHistoryParams, ReadHistoryPageParams, ReadMergeCommitsParams,
    ReadRepositoryPreviewParams, ReadWorkspaceDiffParams, ReadWorkspaceFileParams,
    ReadWorkspaceStatusParams, RefMergeStatusParams, RefreshRepositoryParams, RepositoryScope,
    ResponseData, SearchCommitsParams, SearchIdentitiesParams, SearchPage,
    SelectRepositoryScopeParams, ServerMessage,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{self, BufReader, Write},
    process,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const MAX_ACTIVE_REQUESTS: usize = 2;
const MAX_OPAQUE_ID_BYTES: usize = 256;
const OUTPUT_QUEUE_FRAMES: usize = 16;
const PREVIEW_TIMEOUT: Duration = Duration::from_secs(15);
const COMMIT_CHUNK_SIZE: usize = 25;
const RESPONSE_TARGET_BYTES: usize = 512 * 1024;

pub(crate) type ActiveRequests = Arc<Mutex<HashMap<String, ActiveRequest>>>;

pub(crate) struct ActiveRequest {
    cancelled: Arc<AtomicBool>,
    repo_id: Option<String>,
    pub(crate) blocks_background: bool,
    /// P5-01: an operation has a slot of its own, so a long fetch never uses up the two read slots.
    is_operation: bool,
    is_auxiliary: bool,
    /// Evolution has its own auxiliary slot; a long analysis cannot starve statistics.
    is_evolution: bool,
}

#[derive(Debug)]
enum RequestOperation {
    RuntimeInfo,
    RepositoryPreview(String),
    OpenRepository(String),
    GetRepositorySession,
    ReadSessionPreview,
    ReadHistoryPage(ReadHistoryPageParams),
    LocateCommit(LocateCommitParams),
    LocateHistoryDate(LocateHistoryDateParams),
    RefreshRepository(RefreshRepositoryParams),
    GetRepositoryNavigation,
    SelectRepositoryScope(SelectRepositoryScopeParams),
    RefMergeStatus(RefMergeStatusParams),
    GetMetadataIndexStatus,
    ControlMetadataIndex(MetadataIndexAction),
    SearchCommits(SearchCommitsParams),
    ListSearchIdentities(SearchIdentitiesParams),
    ListSearchPaths(ListSearchPathsParams),
    GetActivityStats(GetActivityStatsParams),
    GetActivityOverview(commitscope_core::GetActivityOverviewParams),
    EstimateEvolution(commitscope_core::EvolutionParams),
    AnalyzeEvolution(commitscope_core::EvolutionParams),
    SetStatsExclusions(commitscope_core::SetStatsExclusionsParams),
    GetStatsExclusions(commitscope_core::EmptyParams),
    GetStatsCommits(commitscope_core::GetStatsCommitsParams),
    GetNotableStats(commitscope_core::GetActivityOverviewParams),
    GetChangeStats(commitscope_core::GetChangeStatsParams),
    ObserveRepository,
    DiffRefSnapshots,
    GetHandoffFacts(GetHandoffFactsParams),
    GetCommit(GetCommitParams),
    ListChangedFiles(ListChangedFilesParams),
    ReadMergeCommits(ReadMergeCommitsParams),
    BranchesContaining(BranchesContainingParams),
    ReadDiff(ReadDiffParams),
    ReadWorkspaceStatus(ReadWorkspaceStatusParams),
    ReadWorkspaceDiff(ReadWorkspaceDiffParams),
    ReadWorkspaceFile(ReadWorkspaceFileParams),
    ListTree(ListTreeParams),
    ReadFileContent(ReadFileContentParams),
    ReadFileHistory(ReadFileHistoryParams),
    ReadFileChange(ReadFileChangeParams),
    ListPathChanges(ListPathChangesParams),
    ReadBlame(ReadBlameParams),
    FetchRepository(commitscope_core::FetchRepositoryParams),
    PushRepository(commitscope_core::PushRepositoryParams),
    GetBranchSync(commitscope_core::GetBranchSyncParams),
    CheckOperation(commitscope_core::OperationParams),
    RunOperation(commitscope_core::OperationParams),
    RecordRepositoryView,
    CloseRepository,
    ListRecentRepositories,
}

struct OpenCompletion {
    request_id: String,
    intent: u64,
    cancelled: Arc<AtomicBool>,
    payload: OpenCompletionPayload,
}

enum OpenCompletionPayload {
    Open(Result<repository::DiscoveredRepository, repository::PreviewError>),
    Refresh {
        expected_repo_id: String,
        expected_generation: String,
        scope: RepositoryScope,
        result: Result<PreparedRefresh, repository::PreviewError>,
    },
}

struct PreparedRefresh {
    discovered: Arc<repository::DiscoveredRepository>,
    history: Arc<crate::history::HistoryState>,
    baseline: crate::history::Baseline,
    page: crate::history::HistoryPage,
}

struct OutFrame {
    bytes: Vec<u8>,
    flushed: Option<SyncSender<bool>>,
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let shutdown = Arc::new(AtomicBool::new(false));
    let output_failed = Arc::new(AtomicBool::new(false));
    let (out_tx, out_rx) = mpsc::sync_channel::<OutFrame>(OUTPUT_QUEUE_FRAMES);
    let writer_failed = Arc::clone(&output_failed);
    thread::spawn(move || {
        let stdout = io::stdout();
        let mut output = stdout.lock();
        while let Ok(frame) = out_rx.recv() {
            let result = output.write_all(&frame.bytes).and_then(|()| output.flush());
            if let Some(flushed) = frame.flushed {
                let _ = flushed.send(result.is_ok());
            }
            if result.is_err() {
                writer_failed.store(true, Ordering::Release);
                break;
            }
        }
    });

    let (input_tx, input_rx) =
        mpsc::sync_channel::<Result<Option<Vec<u8>>, String>>(OUTPUT_QUEUE_FRAMES);
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = BufReader::new(stdin.lock());
        loop {
            let result = framing::read_frame(&mut input).map_err(|error| match error {
                framing::FrameError::TooLong => "protocol frame exceeds 1 MiB".to_owned(),
                framing::FrameError::Truncated => "stdin ended with a truncated frame".to_owned(),
                framing::FrameError::Io(error) => format!("stdin read failed: {error}"),
            });
            let done = matches!(result, Ok(None) | Err(_));
            if input_tx.send(result).is_err() || done {
                break;
            }
        }
    });

    let first = match input_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(Some(frame))) => frame,
        Ok(Ok(None)) => return Ok(()),
        Ok(Err(message)) => {
            send_terminal_error(
                &out_tx,
                &shutdown,
                None,
                None,
                None,
                ErrorCode::ProtocolError,
                message,
                false,
            );
            return Ok(());
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            send_terminal_error(
                &out_tx,
                &shutdown,
                None,
                None,
                None,
                ErrorCode::Timeout,
                "握手超时".into(),
                false,
            );
            return Ok(());
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
    };

    let hello = match decode_client_message(&first) {
        Ok(ClientMessage::Hello { protocol_version }) => protocol_version,
        Ok(_) => {
            send_terminal_error(
                &out_tx,
                &shutdown,
                None,
                None,
                None,
                ErrorCode::ProtocolError,
                "握手前只接受 hello".into(),
                false,
            );
            return Ok(());
        }
        Err(message) => {
            send_terminal_error(
                &out_tx,
                &shutdown,
                None,
                None,
                None,
                ErrorCode::ProtocolError,
                message,
                false,
            );
            return Ok(());
        }
    };
    if hello != PROTOCOL_VERSION {
        send_terminal_error(
            &out_tx,
            &shutdown,
            None,
            None,
            None,
            ErrorCode::ProtocolMismatch,
            format!("协议版本不匹配：客户端 {hello}，核心 {PROTOCOL_VERSION}"),
            false,
        );
        return Ok(());
    }

    let git_path = runtime::find_git();
    let git = match runtime::probe_git(git_path.as_deref(), None) {
        Ok(git) => git,
        Err(runtime::ProbeFailure::Timeout) => {
            send_terminal_error(
                &out_tx,
                &shutdown,
                None,
                None,
                None,
                ErrorCode::Timeout,
                "Git 版本探测超时".into(),
                true,
            );
            return Ok(());
        }
        Err(runtime::ProbeFailure::Cancelled) => unreachable!("handshake probe is not cancellable"),
    };
    let core = CoreReady::current_process(git);
    if !send_terminal_message(&out_tx, &shutdown, &ServerMessage::Hello { core }) {
        return Ok(());
    }

    let requests: ActiveRequests = Arc::default();
    let mut sessions = session::SessionManager::new(session_store::SessionStore::from_env());
    let metadata_tasks = Arc::new(crate::metadata_index::TaskManager::default());
    let (open_done_tx, open_done_rx) = mpsc::sync_channel::<OpenCompletion>(4);
    let mut workers: Vec<JoinHandle<()>> = Vec::new();
    let mut handshaken = true;

    while handshaken && !shutdown.load(Ordering::Acquire) {
        reap_finished_workers(&mut workers);
        if output_failed.load(Ordering::Acquire) {
            break;
        }
        let message = match input_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(Some(frame))) => frame,
            Ok(Ok(None)) => break,
            Ok(Err(message)) => {
                send_terminal_error(
                    &out_tx,
                    &shutdown,
                    None,
                    None,
                    None,
                    ErrorCode::ProtocolError,
                    message,
                    false,
                );
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                drain_open_completions(
                    &open_done_rx,
                    &mut sessions,
                    &requests,
                    &out_tx,
                    &shutdown,
                    &metadata_tasks,
                    git_path.as_deref(),
                    &mut workers,
                );
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        match decode_client_message(&message) {
            Ok(ClientMessage::Hello { .. }) => {
                send_terminal_error(
                    &out_tx,
                    &shutdown,
                    None,
                    None,
                    None,
                    ErrorCode::ProtocolError,
                    "重复 hello".into(),
                    false,
                );
                handshaken = false;
            }
            Ok(ClientMessage::Request {
                request_id,
                method,
                repo_id,
                generation,
                params,
            }) => {
                if request_id.chars().count() <= 128
                    && requests
                        .lock()
                        .expect("request map poisoned")
                        .contains_key(&request_id)
                {
                    send_terminal_error(
                        &out_tx,
                        &shutdown,
                        None,
                        None,
                        None,
                        ErrorCode::ProtocolError,
                        "requestId 已在执行中".into(),
                        false,
                    );
                    handshaken = false;
                    drain_open_completions(
                        &open_done_rx,
                        &mut sessions,
                        &requests,
                        &out_tx,
                        &shutdown,
                        &metadata_tasks,
                        git_path.as_deref(),
                        &mut workers,
                    );
                    continue;
                }
                match validate_request(
                    &request_id,
                    repo_id.as_deref(),
                    generation.as_deref(),
                    &method,
                    &params,
                ) {
                    Err((code, message)) => send_error(
                        &out_tx,
                        &shutdown,
                        bounded_request_id(&request_id),
                        bounded_opaque(repo_id),
                        bounded_opaque(generation),
                        code,
                        message,
                        false,
                    ),
                    Ok(operation) => {
                        let bound_session = if operation_requires_session(&operation) {
                            match (repo_id.as_deref(), generation.as_deref()) {
                                (Some(repo_id), Some(generation)) => {
                                    match sessions.require_current(repo_id, generation) {
                                        Ok(session) => Some(session),
                                        Err(error) => {
                                            send_error(
                                                &out_tx,
                                                &shutdown,
                                                Some(request_id),
                                                Some(repo_id.to_owned()),
                                                Some(generation.to_owned()),
                                                error.code,
                                                error.message,
                                                false,
                                            );
                                            continue;
                                        }
                                    }
                                }
                                _ => unreachable!("session methods require both context fields"),
                            }
                        } else {
                            None
                        };

                        let is_operation = matches!(
                            operation,
                            RequestOperation::FetchRepository(_)
                                | RequestOperation::PushRepository(_)
                                | RequestOperation::RunOperation(_)
                        );
                        let is_auxiliary = matches!(
                            operation,
                            RequestOperation::EstimateEvolution(_)
                                | RequestOperation::AnalyzeEvolution(_)
                                | RequestOperation::SetStatsExclusions(_)
                                | RequestOperation::GetStatsExclusions(_)
                                | RequestOperation::GetStatsCommits(_)
                                | RequestOperation::GetNotableStats(_)
                                | RequestOperation::GetActivityOverview(_)
                                | RequestOperation::GetChangeStats(_)
                        );
                        let is_evolution = matches!(
                            operation,
                            RequestOperation::EstimateEvolution(_)
                                | RequestOperation::AnalyzeEvolution(_)
                        );
                        let mut active = requests.lock().expect("request map poisoned");
                        let busy = if is_operation {
                            active.values().any(|request| request.is_operation)
                        } else if is_auxiliary {
                            active
                                .values()
                                .any(|r| r.is_auxiliary && r.is_evolution == is_evolution)
                        } else {
                            active
                                .values()
                                .filter(|request| !request.is_operation && !request.is_auxiliary)
                                .count()
                                >= MAX_ACTIVE_REQUESTS
                        };
                        if busy {
                            drop(active);
                            send_error(
                                &out_tx,
                                &shutdown,
                                Some(request_id),
                                repo_id,
                                generation,
                                ErrorCode::Busy,
                                "核心正在处理其他请求".into(),
                                true,
                            );
                            drain_open_completions(
                                &open_done_rx,
                                &mut sessions,
                                &requests,
                                &out_tx,
                                &shutdown,
                                &metadata_tasks,
                                git_path.as_deref(),
                                &mut workers,
                            );
                            continue;
                        }
                        let cancelled = Arc::new(AtomicBool::new(false));
                        active.insert(
                            request_id.clone(),
                            ActiveRequest {
                                cancelled: Arc::clone(&cancelled),
                                repo_id: repo_id.clone(),
                                is_operation,
                                is_auxiliary,
                                is_evolution,
                                blocks_background: !matches!(
                                    operation,
                                    RequestOperation::GetMetadataIndexStatus
                                ),
                            },
                        );
                        drop(active);
                        dispatch_request(
                            operation,
                            request_id,
                            repo_id,
                            generation,
                            bound_session,
                            cancelled,
                            &requests,
                            &shutdown,
                            &out_tx,
                            &open_done_tx,
                            &mut sessions,
                            &mut workers,
                            git_path.as_deref(),
                            &metadata_tasks,
                        );
                    }
                }
            }
            Ok(ClientMessage::Cancel { request_id }) => {
                if !request_id.is_empty() && request_id.chars().count() <= 128 {
                    if let Some(cancelled) = requests
                        .lock()
                        .expect("request map poisoned")
                        .get(&request_id)
                    {
                        cancelled.cancelled.store(true, Ordering::Release);
                    }
                } else {
                    send_terminal_error(
                        &out_tx,
                        &shutdown,
                        None,
                        None,
                        None,
                        ErrorCode::ProtocolError,
                        "requestId 超过长度上限".into(),
                        false,
                    );
                    handshaken = false;
                }
            }
            Err(message) => {
                send_terminal_error(
                    &out_tx,
                    &shutdown,
                    None,
                    None,
                    None,
                    ErrorCode::ProtocolError,
                    message,
                    false,
                );
                handshaken = false;
            }
        }
        drain_open_completions(
            &open_done_rx,
            &mut sessions,
            &requests,
            &out_tx,
            &shutdown,
            &metadata_tasks,
            git_path.as_deref(),
            &mut workers,
        );
    }

    shutdown.store(true, Ordering::Release);
    sessions.cancel_pending_opens();
    metadata_tasks.shutdown();
    for request in requests.lock().expect("request map poisoned").values() {
        request.cancelled.store(true, Ordering::Release);
    }
    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
}

fn operation_requires_session(operation: &RequestOperation) -> bool {
    matches!(
        operation,
        RequestOperation::GetRepositorySession
            | RequestOperation::ReadSessionPreview
            | RequestOperation::ReadHistoryPage(_)
            | RequestOperation::LocateCommit(_)
            | RequestOperation::LocateHistoryDate(_)
            | RequestOperation::RefreshRepository(_)
            | RequestOperation::GetRepositoryNavigation
            | RequestOperation::SelectRepositoryScope(_)
            | RequestOperation::RefMergeStatus(_)
            | RequestOperation::GetMetadataIndexStatus
            | RequestOperation::ControlMetadataIndex(_)
            | RequestOperation::SearchCommits(_)
            | RequestOperation::ListSearchIdentities(_)
            | RequestOperation::ListSearchPaths(_)
            | RequestOperation::GetActivityStats(_)
            | RequestOperation::GetActivityOverview(_)
            | RequestOperation::EstimateEvolution(_)
            | RequestOperation::AnalyzeEvolution(_)
            | RequestOperation::SetStatsExclusions(_)
            | RequestOperation::GetStatsExclusions(_)
            | RequestOperation::GetStatsCommits(_)
            | RequestOperation::GetNotableStats(_)
            | RequestOperation::GetChangeStats(_)
            | RequestOperation::ObserveRepository
            | RequestOperation::DiffRefSnapshots
            | RequestOperation::GetHandoffFacts(_)
            | RequestOperation::GetCommit(_)
            | RequestOperation::ListChangedFiles(_)
            | RequestOperation::ReadMergeCommits(_)
            | RequestOperation::BranchesContaining(_)
            | RequestOperation::ReadDiff(_)
            | RequestOperation::ReadWorkspaceStatus(_)
            | RequestOperation::ReadWorkspaceDiff(_)
            | RequestOperation::ReadWorkspaceFile(_)
            | RequestOperation::ListTree(_)
            | RequestOperation::ReadFileContent(_)
            | RequestOperation::ReadFileHistory(_)
            | RequestOperation::ReadFileChange(_)
            | RequestOperation::ListPathChanges(_)
            | RequestOperation::ReadBlame(_)
            | RequestOperation::FetchRepository(_)
            | RequestOperation::PushRepository(_)
            | RequestOperation::GetBranchSync(_)
            | RequestOperation::CheckOperation(_)
            | RequestOperation::RunOperation(_)
            | RequestOperation::RecordRepositoryView
            | RequestOperation::CloseRepository
    )
}

/// Blame streams several chunks: each is sent as soon as it is ready, the last one carries `done`.
#[allow(clippy::too_many_arguments)]
fn spawn_blame_worker(
    workers: &mut Vec<JoinHandle<()>>,
    sender: SyncSender<OutFrame>,
    shutdown: Arc<AtomicBool>,
    requests: ActiveRequests,
    request_id: String,
    repo_id: Option<String>,
    generation: Option<String>,
    cancelled: Arc<AtomicBool>,
    git_path: Option<std::path::PathBuf>,
    session: Arc<session::RepositorySession>,
    params: ReadBlameParams,
) {
    workers.push(thread::spawn(move || {
        let Some(git_path) = git_path else {
            send_terminal_error(
                &sender,
                &shutdown,
                Some(request_id.clone()),
                repo_id,
                generation,
                ErrorCode::GitUnavailable,
                "Git executable was not found".into(),
                false,
            );
            remove_request(&requests, &request_id, &cancelled);
            return;
        };
        let mut sequence = 0_u32;
        let mut processed = 0_u32;
        let mut oversized = false;
        let result = {
            let mut emit = |chunk: commitscope_core::BlameChunk, done: bool| {
                processed += chunk.blocks.len() as u32;
                let message = ServerMessage::Response {
                    request_id: request_id.clone(),
                    repo_id: repo_id.clone(),
                    generation: generation.clone(),
                    sequence,
                    done,
                    coverage: Coverage {
                        complete: done,
                        processed,
                    },
                    next_cursor: None,
                    data: ResponseData::BlameChunk { chunk },
                };
                if serde_json::to_vec(&message)
                    .map_or(true, |bytes| bytes.len() > RESPONSE_TARGET_BYTES)
                {
                    oversized = true;
                    return false;
                }
                sequence += 1;
                send_task_message(&sender, &shutdown, &cancelled, &message)
            };
            crate::blame::read_blame(
                &git_path,
                &session,
                &params,
                &cancelled,
                std::time::Instant::now() + crate::blame::BLAME_TIMEOUT,
                &mut emit,
            )
        };
        if let Err(error) = result {
            if oversized {
                send_terminal_error(
                    &sender,
                    &shutdown,
                    Some(request_id.clone()),
                    repo_id,
                    generation,
                    ErrorCode::ResourceLimit,
                    "Blame chunk exceeds the 512 KiB target".into(),
                    false,
                );
            } else if error.code == ErrorCode::Cancelled || cancelled.load(Ordering::Acquire) {
                finish_cancelled(&sender, &shutdown, &request_id, repo_id, generation);
            } else {
                send_terminal_error(
                    &sender,
                    &shutdown,
                    Some(request_id.clone()),
                    repo_id,
                    generation,
                    error.code,
                    error.message,
                    error.retryable,
                );
            }
        }
        remove_request(&requests, &request_id, &cancelled);
    }));
}

#[allow(clippy::too_many_arguments)]
fn spawn_evolution_worker(
    workers: &mut Vec<JoinHandle<()>>,
    sender: SyncSender<OutFrame>,
    shutdown: Arc<AtomicBool>,
    requests: ActiveRequests,
    request_id: String,
    repo_id: Option<String>,
    generation: Option<String>,
    cancelled: Arc<AtomicBool>,
    git_path: Option<std::path::PathBuf>,
    session: Arc<session::RepositorySession>,
    params: commitscope_core::EvolutionParams,
) {
    workers.push(thread::spawn(move || {
        let Some(git_path) = git_path else {
            send_terminal_error(
                &sender,
                &shutdown,
                Some(request_id.clone()),
                repo_id,
                generation,
                ErrorCode::GitUnavailable,
                "Git executable was not found".into(),
                false,
            );
            remove_request(&requests, &request_id, &cancelled);
            return;
        };
        let mut sequence = 0_u32;
        let mut processed = 0_u32;
        let mut oversized = false;
        let result = {
            let mut emit = |chunk: commitscope_core::EvolutionChunk, done: bool| {
                processed = chunk.progress.files_done;
                let message = ServerMessage::Response {
                    request_id: request_id.clone(),
                    repo_id: repo_id.clone(),
                    generation: generation.clone(),
                    sequence,
                    done,
                    coverage: Coverage {
                        complete: done,
                        processed,
                    },
                    next_cursor: None,
                    data: ResponseData::EvolutionChunk { chunk },
                };
                if serde_json::to_vec(&message)
                    .map_or(true, |bytes| bytes.len() > RESPONSE_TARGET_BYTES)
                {
                    oversized = true;
                    return false;
                }
                sequence += 1;
                send_task_message(&sender, &shutdown, &cancelled, &message)
            };
            crate::evolution::analyze(
                &git_path,
                &session,
                &params,
                &cancelled,
                std::time::Instant::now() + crate::evolution::TIMEOUT,
                &|| {
                    requests
                        .lock()
                        .expect("request map poisoned")
                        .values()
                        .any(|r| !r.is_auxiliary && !r.is_operation)
                },
                &mut emit,
            )
        };
        if let Err(error) = result {
            if oversized {
                send_terminal_error(
                    &sender,
                    &shutdown,
                    Some(request_id.clone()),
                    repo_id,
                    generation,
                    ErrorCode::ResourceLimit,
                    "Blame chunk exceeds the 512 KiB target".into(),
                    false,
                );
            } else if error.code == ErrorCode::Cancelled || cancelled.load(Ordering::Acquire) {
                finish_cancelled(&sender, &shutdown, &request_id, repo_id, generation);
            } else {
                send_terminal_error(
                    &sender,
                    &shutdown,
                    Some(request_id.clone()),
                    repo_id,
                    generation,
                    error.code,
                    error.message,
                    error.retryable,
                );
            }
        }
        remove_request(&requests, &request_id, &cancelled);
    }));
}

#[allow(clippy::too_many_arguments)]
fn spawn_commit_detail_worker<F>(
    workers: &mut Vec<JoinHandle<()>>,
    sender: SyncSender<OutFrame>,
    shutdown: Arc<AtomicBool>,
    requests: ActiveRequests,
    request_id: String,
    repo_id: Option<String>,
    generation: Option<String>,
    cancelled: Arc<AtomicBool>,
    git_path: Option<std::path::PathBuf>,
    session: Arc<session::RepositorySession>,
    operation: F,
) where
    F: FnOnce(
            &std::path::Path,
            &session::RepositorySession,
            &AtomicBool,
            std::time::Instant,
        ) -> Result<(ResponseData, u32), crate::details::DetailError>
        + Send
        + 'static,
{
    workers.push(thread::spawn(move || {
        let Some(git_path) = git_path else {
            send_terminal_error(
                &sender,
                &shutdown,
                Some(request_id.clone()),
                repo_id,
                generation,
                ErrorCode::GitUnavailable,
                "Git executable was not found".into(),
                false,
            );
            remove_request(&requests, &request_id, &cancelled);
            return;
        };
        let result = operation(
            &git_path,
            &session,
            &cancelled,
            std::time::Instant::now() + PREVIEW_TIMEOUT,
        );
        let (data, processed) = match result {
            Ok(result) => result,
            Err(error) => {
                if error.code == ErrorCode::Cancelled || cancelled.load(Ordering::Acquire) {
                    finish_cancelled(&sender, &shutdown, &request_id, repo_id, generation);
                } else {
                    send_terminal_error(
                        &sender,
                        &shutdown,
                        Some(request_id.clone()),
                        repo_id,
                        generation,
                        error.code,
                        error.message,
                        error.retryable,
                    );
                }
                remove_request(&requests, &request_id, &cancelled);
                return;
            }
        };
        let message = ServerMessage::Response {
            request_id: request_id.clone(),
            repo_id: repo_id.clone(),
            generation: generation.clone(),
            sequence: 0,
            done: true,
            coverage: Coverage {
                complete: true,
                processed,
            },
            next_cursor: None,
            data,
        };
        if serde_json::to_vec(&message).map_or(true, |bytes| bytes.len() > RESPONSE_TARGET_BYTES) {
            send_terminal_error(
                &sender,
                &shutdown,
                Some(request_id.clone()),
                repo_id,
                generation,
                ErrorCode::ResourceLimit,
                "Commit details response exceeds the 512 KiB target".into(),
                false,
            );
        } else if !send_task_message(&sender, &shutdown, &cancelled, &message) {
            finish_cancelled(&sender, &shutdown, &request_id, repo_id, generation);
        }
        remove_request(&requests, &request_id, &cancelled);
    }));
}

#[allow(clippy::too_many_arguments)]
fn dispatch_request(
    operation: RequestOperation,
    request_id: String,
    repo_id: Option<String>,
    generation: Option<String>,
    bound_session: Option<Arc<session::RepositorySession>>,
    cancelled: Arc<AtomicBool>,
    requests: &ActiveRequests,
    shutdown: &Arc<AtomicBool>,
    sender: &SyncSender<OutFrame>,
    open_done: &mpsc::SyncSender<OpenCompletion>,
    sessions: &mut session::SessionManager,
    workers: &mut Vec<JoinHandle<()>>,
    git_path: Option<&std::path::Path>,
    metadata_tasks: &Arc<crate::metadata_index::TaskManager>,
) {
    match operation {
        RequestOperation::RuntimeInfo => {
            let request_map = Arc::clone(requests);
            let sender = sender.clone();
            let stopping = Arc::clone(shutdown);
            let cancelled_for_worker = Arc::clone(&cancelled);
            let git_path = git_path.map(std::path::Path::to_path_buf);
            workers.push(thread::spawn(move || {
                execute_runtime_info(
                    &sender,
                    &stopping,
                    &request_map,
                    &request_id,
                    repo_id,
                    generation,
                    git_path.as_deref(),
                    cancelled_for_worker,
                )
            }));
        }
        RequestOperation::RepositoryPreview(path) => {
            let request_map = Arc::clone(requests);
            let sender = sender.clone();
            let stopping = Arc::clone(shutdown);
            let cancelled_for_worker = Arc::clone(&cancelled);
            let git_path = git_path.map(std::path::Path::to_path_buf);
            workers.push(thread::spawn(move || {
                execute_repository_preview(
                    &sender,
                    &stopping,
                    &request_map,
                    &request_id,
                    repo_id,
                    generation,
                    git_path.as_deref(),
                    &path,
                    cancelled_for_worker,
                )
            }));
        }
        RequestOperation::OpenRepository(path) => {
            let Some(git_path) = git_path.map(std::path::Path::to_path_buf) else {
                send_error(
                    sender,
                    shutdown,
                    Some(request_id.clone()),
                    None,
                    None,
                    ErrorCode::GitUnavailable,
                    "Git executable was not found".into(),
                    false,
                );
                remove_request(requests, &request_id, &cancelled);
                return;
            };
            let intent = sessions.begin_open(Arc::clone(&cancelled));
            let open_done = open_done.clone();
            let cancelled_for_worker = Arc::clone(&cancelled);
            workers.push(thread::spawn(move || {
                let result = repository::discover_repository(
                    &git_path,
                    &path,
                    &cancelled_for_worker,
                    std::time::Instant::now() + PREVIEW_TIMEOUT,
                );
                let _ = open_done.send(OpenCompletion {
                    request_id,
                    intent,
                    cancelled: cancelled_for_worker,
                    payload: OpenCompletionPayload::Open(result),
                });
            }));
        }
        RequestOperation::GetRepositorySession => {
            let session = bound_session.expect("session context was checked before dispatch");
            let message = session_response(
                &request_id,
                repo_id,
                generation,
                ResponseData::RepositorySession {
                    session: session.info.clone(),
                },
                1,
            );
            send_main_message(sender, shutdown, &message);
            remove_request(requests, &request_id, &cancelled);
        }
        RequestOperation::ReadSessionPreview => {
            let session = bound_session.expect("session context was checked before dispatch");
            let request_map = Arc::clone(requests);
            let sender = sender.clone();
            let stopping = Arc::clone(shutdown);
            let cancelled_for_worker = Arc::clone(&cancelled);
            let git_path = git_path.map(std::path::Path::to_path_buf);
            workers.push(thread::spawn(move || {
                execute_session_preview(
                    &sender,
                    &stopping,
                    &request_map,
                    &request_id,
                    repo_id,
                    generation,
                    git_path.as_deref(),
                    session,
                    cancelled_for_worker,
                )
            }));
        }
        RequestOperation::ReadHistoryPage(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            let request_map = Arc::clone(requests);
            let sender = sender.clone();
            let stopping = Arc::clone(shutdown);
            let cancelled_for_worker = Arc::clone(&cancelled);
            let git_path = git_path.map(std::path::Path::to_path_buf);
            let metadata_tasks_worker = Arc::clone(metadata_tasks);
            workers.push(thread::spawn(move || {
                execute_history_page(
                    &sender,
                    &stopping,
                    &request_map,
                    &request_id,
                    repo_id,
                    generation,
                    git_path.as_deref(),
                    session,
                    params,
                    cancelled_for_worker,
                    metadata_tasks_worker,
                )
            }));
        }
        RequestOperation::LocateCommit(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            let request_map = Arc::clone(requests);
            let sender = sender.clone();
            let stopping = Arc::clone(shutdown);
            let cancelled_for_worker = Arc::clone(&cancelled);
            let git_path = git_path.map(std::path::Path::to_path_buf);
            let metadata_tasks_worker = Arc::clone(metadata_tasks);
            workers.push(thread::spawn(move || {
                execute_locate_commit(
                    &sender,
                    &stopping,
                    &request_map,
                    &request_id,
                    repo_id,
                    generation,
                    git_path.as_deref(),
                    session,
                    params,
                    cancelled_for_worker,
                    metadata_tasks_worker,
                )
            }));
        }
        RequestOperation::LocateHistoryDate(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            let request_map = Arc::clone(requests);
            let sender = sender.clone();
            let stopping = Arc::clone(shutdown);
            let cancelled_for_worker = Arc::clone(&cancelled);
            let git_path = git_path.map(std::path::Path::to_path_buf);
            let metadata_tasks_worker = Arc::clone(metadata_tasks);
            workers.push(thread::spawn(move || {
                execute_locate_history_date(
                    &sender,
                    &stopping,
                    &request_map,
                    &request_id,
                    repo_id,
                    generation,
                    git_path.as_deref(),
                    session,
                    params,
                    cancelled_for_worker,
                    metadata_tasks_worker,
                )
            }));
        }
        RequestOperation::SearchCommits(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            let request_map = Arc::clone(requests);
            let sender = sender.clone();
            let stopping = Arc::clone(shutdown);
            let cancelled = Arc::clone(&cancelled);
            let metadata_tasks = Arc::clone(metadata_tasks);
            let request_id = request_id.clone();
            let git_path = git_path.map(std::path::Path::to_path_buf);
            workers.push(thread::spawn(move || {
                execute_search_commits(
                    &sender,
                    &stopping,
                    &request_map,
                    &request_id,
                    repo_id,
                    generation,
                    git_path.as_deref(),
                    session,
                    params,
                    metadata_tasks,
                    cancelled,
                );
            }));
        }
        RequestOperation::ListSearchIdentities(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            let request_map = Arc::clone(requests);
            let sender = sender.clone();
            let stopping = Arc::clone(shutdown);
            let cancelled = Arc::clone(&cancelled);
            let metadata_tasks = Arc::clone(metadata_tasks);
            let request_id = request_id.clone();
            workers.push(thread::spawn(move || {
                execute_search_identities(
                    &sender,
                    &stopping,
                    &request_map,
                    &request_id,
                    repo_id,
                    generation,
                    session,
                    params,
                    metadata_tasks,
                    cancelled,
                );
            }));
        }
        RequestOperation::ListSearchPaths(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let paths = crate::search::list_search_paths(
                        git, session, &params, cancelled, deadline,
                    )
                    .map_err(|error| crate::details::DetailError {
                        retryable: matches!(error.code, ErrorCode::Busy | ErrorCode::Timeout),
                        code: error.code,
                        message: error.message,
                    })?;
                    let processed = paths.entries.len() as u32;
                    Ok((ResponseData::SearchPaths { paths }, processed))
                },
            );
        }
        RequestOperation::GetChangeStats(params) => {
            let session = bound_session.expect("checked session");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |_, session, cancelled, deadline| {
                    crate::stats::prepare_worker(cancelled, deadline)?;
                    let _ = (&params, cancelled, deadline);
                    let stats =
                        crate::change_stats::change_stats(session, &params, cancelled, deadline)
                            .map_err(|e| crate::details::DetailError {
                                code: e.code,
                                message: e.message,
                                retryable: false,
                            })?;
                    Ok((ResponseData::ChangeStats { stats }, 1))
                },
            );
        }
        RequestOperation::GetNotableStats(params) => {
            let session = bound_session.expect("checked session");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |_, session, cancelled, deadline| {
                    crate::stats::prepare_worker(cancelled, deadline)?;
                    let _ = (&params, cancelled, deadline);
                    let stats =
                        crate::change_stats::notable_stats(session, &params, cancelled, deadline)
                            .map_err(|e| crate::details::DetailError {
                            code: e.code,
                            message: e.message,
                            retryable: false,
                        })?;
                    Ok((ResponseData::NotableStats { stats }, 1))
                },
            );
        }
        RequestOperation::GetStatsCommits(params) => {
            let session = bound_session.expect("checked session");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |_, session, cancelled, deadline| {
                    crate::stats::prepare_worker(cancelled, deadline)?;
                    let _ = (&params, cancelled, deadline);
                    let page =
                        crate::change_stats::stats_commits(session, &params, cancelled, deadline)
                            .map_err(|e| crate::details::DetailError {
                            code: e.code,
                            message: e.message,
                            retryable: false,
                        })?;
                    Ok((ResponseData::StatsCommitPage { page }, 1))
                },
            );
        }
        RequestOperation::GetStatsExclusions(params) => {
            let session = bound_session.expect("checked session");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |_, session, cancelled, deadline| {
                    let _ = (&params, cancelled, deadline);
                    let result = crate::change_stats::exclusions(session).map_err(|e| {
                        crate::details::DetailError {
                            code: e.code,
                            message: e.message,
                            retryable: false,
                        }
                    })?;
                    Ok((ResponseData::StatsExclusions { result }, 1))
                },
            );
        }
        RequestOperation::SetStatsExclusions(params) => {
            let session = bound_session.expect("checked session");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |_, session, cancelled, deadline| {
                    let _ = (&params, cancelled, deadline);
                    let result =
                        crate::change_stats::set_exclusions(session, &params).map_err(|e| {
                            crate::details::DetailError {
                                code: e.code,
                                message: e.message,
                                retryable: false,
                            }
                        })?;
                    Ok((ResponseData::StatsExclusions { result }, 1))
                },
            );
        }
        RequestOperation::EstimateEvolution(params) => {
            let session = bound_session.expect("checked session");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, _| {
                    let estimate = crate::evolution::estimate(
                        git,
                        session,
                        &params,
                        cancelled,
                        std::time::Instant::now() + crate::evolution::TIMEOUT,
                    )?;
                    Ok((ResponseData::EvolutionEstimate { estimate }, 1))
                },
            );
        }
        RequestOperation::AnalyzeEvolution(params) => {
            let session = bound_session.expect("checked session");
            spawn_evolution_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                params,
            );
        }
        RequestOperation::GetActivityOverview(params) => {
            let session = bound_session.expect("checked session");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |_, session, cancelled, deadline| {
                    crate::stats::prepare_worker(cancelled, deadline)?;
                    let stats =
                        crate::stats::activity_overview(session, &params, cancelled, deadline)
                            .map_err(|e| crate::details::DetailError {
                                code: e.code,
                                message: e.message,
                                retryable: false,
                            })?;
                    Ok((ResponseData::ActivityOverview { stats }, 1))
                },
            );
        }
        RequestOperation::GetActivityStats(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            let request_map = Arc::clone(requests);
            let sender = sender.clone();
            let stopping = Arc::clone(shutdown);
            let cancelled = Arc::clone(&cancelled);
            let metadata_tasks = Arc::clone(metadata_tasks);
            let request_id = request_id.clone();
            let git_path = git_path.map(std::path::Path::to_path_buf);
            workers.push(thread::spawn(move || {
                execute_activity_stats(
                    &sender,
                    &stopping,
                    &request_map,
                    &request_id,
                    repo_id,
                    generation,
                    git_path.as_deref(),
                    session,
                    params,
                    metadata_tasks,
                    cancelled,
                );
            }));
        }
        RequestOperation::ObserveRepository => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let observation =
                        crate::updates::observe_repository(git, session, cancelled, deadline)
                            .map_err(crate::updates::to_detail_error)?;
                    let processed = observation.change_count;
                    Ok((
                        ResponseData::RepositoryObservation { observation },
                        processed,
                    ))
                },
            );
        }
        RequestOperation::DiffRefSnapshots => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let diff =
                        crate::updates::diff_ref_snapshots(git, session, cancelled, deadline)
                            .map_err(crate::updates::to_detail_error)?;
                    let processed = diff.changes.len() as u32;
                    Ok((ResponseData::RefSnapshotDiff { diff }, processed))
                },
            );
        }
        RequestOperation::GetHandoffFacts(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let facts = crate::handoff::get_handoff_facts(
                        git, session, &params, cancelled, deadline,
                    )?;
                    Ok((
                        ResponseData::HandoffFacts {
                            facts: Box::new(facts),
                        },
                        1,
                    ))
                },
            );
        }
        RequestOperation::GetCommit(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let details =
                        crate::details::get_commit(git, session, &params, cancelled, deadline)?;
                    Ok((ResponseData::CommitDetails { details }, 1))
                },
            );
        }
        RequestOperation::ListChangedFiles(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let page = crate::details::list_changed_files(
                        git, session, &params, cancelled, deadline,
                    )?;
                    let processed = page.files.len() as u32;
                    Ok((ResponseData::ChangedFiles { page }, processed))
                },
            );
        }
        RequestOperation::ReadMergeCommits(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let page = crate::details::read_merge_commits(
                        git, session, &params, cancelled, deadline,
                    )?;
                    let processed = page.commits.len() as u32;
                    Ok((ResponseData::MergeCommits { page }, processed))
                },
            );
        }
        RequestOperation::BranchesContaining(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let result = crate::details::branches_containing(
                        git, session, &params, cancelled, deadline,
                    )?;
                    let processed = result.branches.len() as u32;
                    Ok((ResponseData::BranchesContaining { result }, processed))
                },
            );
        }
        RequestOperation::ReadDiff(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let diff =
                        crate::details::read_file_diff(git, session, &params, cancelled, deadline)?;
                    Ok((ResponseData::FileDiff { diff }, 1))
                },
            );
        }
        RequestOperation::ReadWorkspaceStatus(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let status =
                        crate::workspace::read_status(git, session, &params, cancelled, deadline)?;
                    Ok((ResponseData::WorkspaceStatus { status }, 1))
                },
            );
        }
        RequestOperation::ReadWorkspaceDiff(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let diff =
                        crate::workspace::read_diff(git, session, &params, cancelled, deadline)?;
                    Ok((ResponseData::WorkspaceDiff { diff }, 1))
                },
            );
        }
        RequestOperation::ReadWorkspaceFile(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let _ = (git, cancelled, deadline);
                    let file = crate::workspace::read_file(session, &params)?;
                    Ok((ResponseData::WorkspaceFile { file }, 1))
                },
            );
        }
        RequestOperation::ListTree(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let page = crate::files::list_tree(git, session, &params, cancelled, deadline)?;
                    Ok((ResponseData::TreePage { page }, 1))
                },
            );
        }
        RequestOperation::ReadFileContent(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let content = crate::files::read_file_content(
                        git, session, &params, cancelled, deadline,
                    )?;
                    Ok((ResponseData::FileContent { content }, 1))
                },
            );
        }
        RequestOperation::ReadFileHistory(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let page = crate::files::read_file_history(
                        git, session, &params, cancelled, deadline,
                    )?;
                    Ok((ResponseData::FileHistory { page }, 1))
                },
            );
        }
        RequestOperation::ReadFileChange(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let diff =
                        crate::files::read_file_change(git, session, &params, cancelled, deadline)?;
                    Ok((ResponseData::FileDiff { diff }, 1))
                },
            );
        }
        RequestOperation::ListPathChanges(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let page = crate::files::list_path_changes(
                        git, session, &params, cancelled, deadline,
                    )?;
                    // One bounded page in one section, like the other files-page reads.
                    Ok((ResponseData::ChangedFiles { page }, 1))
                },
            );
        }
        RequestOperation::ReadBlame(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_blame_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                params,
            );
        }
        RequestOperation::GetBranchSync(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let result = crate::operations::get_branch_sync(
                        git, session, &params, cancelled, deadline,
                    )?;
                    Ok((ResponseData::BranchSync { result }, 1))
                },
            );
        }
        RequestOperation::CheckOperation(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let result = crate::operations::check_operation(
                        git, session, &params, cancelled, deadline,
                    )?;
                    Ok((ResponseData::OperationCheck { result }, 1))
                },
            );
        }
        RequestOperation::RunOperation(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, deadline| {
                    let result = crate::operations::run_operation(
                        git, session, &params, cancelled, deadline,
                    )?;
                    Ok((ResponseData::OperationRun { result }, 1))
                },
            );
        }
        RequestOperation::FetchRepository(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                // The worker's read deadline is far too short for a network transfer; a fetch has its own.
                move |git, session, cancelled, _read_deadline| {
                    let result = crate::operations::fetch_repository(
                        git,
                        session,
                        &params,
                        cancelled,
                        std::time::Instant::now() + crate::operations::FETCH_TIMEOUT,
                    )?;
                    let processed = u32::try_from(result.remotes.len()).unwrap_or(u32::MAX);
                    Ok((ResponseData::RepositoryFetched { result }, processed))
                },
            );
        }
        RequestOperation::PushRepository(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            spawn_commit_detail_worker(
                workers,
                sender.clone(),
                Arc::clone(shutdown),
                Arc::clone(requests),
                request_id,
                repo_id,
                generation,
                cancelled,
                git_path.map(std::path::Path::to_path_buf),
                session,
                move |git, session, cancelled, _read_deadline| {
                    let result = crate::operations::push_repository(
                        git,
                        session,
                        &params,
                        cancelled,
                        std::time::Instant::now() + crate::operations::PUSH_TIMEOUT,
                    )?;
                    Ok((ResponseData::RepositoryPushed { result }, 1))
                },
            );
        }
        RequestOperation::RefreshRepository(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            let Some(git_path) = git_path.map(std::path::Path::to_path_buf) else {
                send_terminal_error(
                    sender,
                    shutdown,
                    Some(request_id.clone()),
                    repo_id,
                    generation,
                    ErrorCode::GitUnavailable,
                    "Git executable was not found".into(),
                    false,
                );
                remove_request(requests, &request_id, &cancelled);
                return;
            };
            let baseline = match sessions.capture_previous_view(
                repo_id.as_deref().expect("session context checked"),
                generation.as_deref().expect("session context checked"),
                &session.info.scope,
            ) {
                Ok(baseline) => baseline,
                Err(error) => {
                    send_terminal_error(
                        sender,
                        shutdown,
                        Some(request_id.clone()),
                        repo_id,
                        generation,
                        error.code,
                        error.message,
                        false,
                    );
                    remove_request(requests, &request_id, &cancelled);
                    return;
                }
            };
            let intent = sessions.begin_open(Arc::clone(&cancelled));
            let scope = session.info.scope.clone();
            spawn_scope_transition(
                workers,
                open_done,
                request_id,
                intent,
                cancelled,
                session.info.repo_id.clone(),
                session.info.generation.clone(),
                scope,
                session.info.repository.path.clone(),
                git_path,
                baseline,
                params.page_size,
            );
        }
        RequestOperation::SelectRepositoryScope(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            let Some(git_path) = git_path.map(std::path::Path::to_path_buf) else {
                send_terminal_error(
                    sender,
                    shutdown,
                    Some(request_id.clone()),
                    repo_id,
                    generation,
                    ErrorCode::GitUnavailable,
                    "Git executable was not found".into(),
                    false,
                );
                remove_request(requests, &request_id, &cancelled);
                return;
            };
            let baseline = match sessions.capture_previous_view(
                repo_id.as_deref().expect("session context checked"),
                generation.as_deref().expect("session context checked"),
                &params.scope,
            ) {
                Ok(baseline) => baseline,
                Err(error) => {
                    send_terminal_error(
                        sender,
                        shutdown,
                        Some(request_id.clone()),
                        repo_id,
                        generation,
                        error.code,
                        error.message,
                        false,
                    );
                    remove_request(requests, &request_id, &cancelled);
                    return;
                }
            };
            let intent = sessions.begin_open(Arc::clone(&cancelled));
            spawn_scope_transition(
                workers,
                open_done,
                request_id,
                intent,
                cancelled,
                session.info.repo_id.clone(),
                session.info.generation.clone(),
                params.scope,
                session.info.repository.path.clone(),
                git_path,
                baseline,
                params.page_size,
            );
        }
        RequestOperation::GetRepositoryNavigation => {
            let session = bound_session.expect("session context was checked before dispatch");
            let request_map = Arc::clone(requests);
            let sender = sender.clone();
            let stopping = Arc::clone(shutdown);
            let request_id = request_id.clone();
            let cancelled = Arc::clone(&cancelled);
            workers.push(thread::spawn(move || {
                execute_repository_navigation(
                    &sender,
                    &stopping,
                    &request_map,
                    &request_id,
                    repo_id,
                    generation,
                    session,
                    cancelled,
                );
            }));
        }
        RequestOperation::RefMergeStatus(params) => {
            let session = bound_session.expect("session context was checked before dispatch");
            let request_map = Arc::clone(requests);
            let sender = sender.clone();
            let stopping = Arc::clone(shutdown);
            let request_id = request_id.clone();
            let cancelled = Arc::clone(&cancelled);
            let git_path = git_path.map(std::path::Path::to_path_buf);
            workers.push(thread::spawn(move || {
                execute_ref_merge_status(
                    &sender,
                    &stopping,
                    &request_map,
                    &request_id,
                    repo_id,
                    generation,
                    git_path.as_deref(),
                    session,
                    params,
                    cancelled,
                );
            }));
        }
        RequestOperation::GetMetadataIndexStatus => {
            let session = bound_session.expect("session context was checked before dispatch");
            let quota = match crate::metadata_index::configured_quota() {
                Ok(quota) => quota,
                Err(error) => {
                    let status = crate::metadata_index::idle_status(0, Some(error));
                    send_main_message(
                        sender,
                        shutdown,
                        &session_response(
                            &request_id,
                            repo_id,
                            generation,
                            ResponseData::MetadataIndex { status },
                            1,
                        ),
                    );
                    remove_request(requests, &request_id, &cancelled);
                    return;
                }
            };
            let store = session_store::SessionStore::from_env();
            let status = metadata_tasks.status(&store, &session, quota);
            send_main_message(
                sender,
                shutdown,
                &session_response(
                    &request_id,
                    repo_id,
                    generation,
                    ResponseData::MetadataIndex { status },
                    1,
                ),
            );
            remove_request(requests, &request_id, &cancelled);
        }
        RequestOperation::ControlMetadataIndex(action) => {
            let session = bound_session.expect("session context was checked before dispatch");
            let quota = crate::metadata_index::configured_quota();
            let task_manager = Arc::clone(metadata_tasks);
            let store = session_store::SessionStore::from_env();
            let executable = git_path.map(std::path::Path::to_path_buf);
            let requests = Arc::clone(requests);
            let sender = sender.clone();
            let shutdown = Arc::clone(shutdown);
            let request_id_worker = request_id.clone();
            let repo_id_worker = repo_id.clone();
            let generation_worker = generation.clone();
            let cancelled_worker = Arc::clone(&cancelled);
            workers.push(thread::spawn(move || {
                let status = match quota {
                    Ok(quota) => task_manager.control(
                        action,
                        store,
                        Arc::clone(&session),
                        executable,
                        quota,
                        Arc::clone(&requests),
                    ),
                    Err(error) => crate::metadata_index::idle_status(0, Some(error)),
                };
                let message = session_response(
                    &request_id_worker,
                    repo_id_worker,
                    generation_worker,
                    ResponseData::MetadataIndex { status },
                    1,
                );
                send_task_message(&sender, &shutdown, &cancelled_worker, &message);
                remove_request(&requests, &request_id_worker, &cancelled_worker);
            }));
        }
        RequestOperation::RecordRepositoryView => {
            let result = sessions.record_view(
                repo_id.as_deref().expect("session context checked"),
                generation.as_deref().expect("session context checked"),
            );
            match result {
                Ok((saved, status)) => {
                    let message = session_response(
                        &request_id,
                        repo_id,
                        generation,
                        ResponseData::RepositoryViewRecorded { saved, status },
                        1,
                    );
                    send_main_message(sender, shutdown, &message);
                }
                Err(error) => send_error(
                    sender,
                    shutdown,
                    Some(request_id.clone()),
                    repo_id,
                    generation,
                    error.code,
                    error.message,
                    false,
                ),
            }
            remove_request(requests, &request_id, &cancelled);
        }
        RequestOperation::CloseRepository => {
            let result = sessions.close(
                repo_id.as_deref().expect("session context checked"),
                generation.as_deref().expect("session context checked"),
            );
            match result {
                Ok(closed_repo_id) => {
                    if let (Some(repo_id), Some(generation)) =
                        (repo_id.as_deref(), generation.as_deref())
                    {
                        metadata_tasks.deactivate(repo_id, generation);
                    }
                    cancel_repository_requests(requests, &closed_repo_id);
                    let message = session_response(
                        &request_id,
                        repo_id,
                        generation,
                        ResponseData::RepositoryClosed { closed: true },
                        1,
                    );
                    send_main_message(sender, shutdown, &message);
                }
                Err(error) => send_error(
                    sender,
                    shutdown,
                    Some(request_id.clone()),
                    repo_id,
                    generation,
                    error.code,
                    error.message,
                    false,
                ),
            }
            remove_request(requests, &request_id, &cancelled);
        }
        RequestOperation::ListRecentRepositories => {
            let (repositories, status) = sessions.recent();
            let processed = repositories.len() as u32;
            let message = session_response(
                &request_id,
                None,
                None,
                ResponseData::RecentRepositories {
                    repositories,
                    status,
                },
                processed,
            );
            send_main_message(sender, shutdown, &message);
            remove_request(requests, &request_id, &cancelled);
        }
    }
}

fn session_response(
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    data: ResponseData,
    processed: u32,
) -> ServerMessage {
    ServerMessage::Response {
        request_id: request_id.to_owned(),
        repo_id,
        generation,
        sequence: 0,
        done: true,
        coverage: Coverage {
            complete: true,
            processed,
        },
        next_cursor: None,
        data,
    }
}

fn navigation_preview_error(
    error: &crate::navigation::NavigationError,
) -> repository::PreviewError {
    repository::PreviewError {
        code: error.code,
        message: error.message.clone(),
        retryable: matches!(
            error.code,
            ErrorCode::Timeout | ErrorCode::RepositoryUnavailable
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_scope_transition(
    workers: &mut Vec<JoinHandle<()>>,
    open_done: &mpsc::SyncSender<OpenCompletion>,
    request_id: String,
    intent: u64,
    cancelled: Arc<AtomicBool>,
    expected_repo_id: String,
    expected_generation: String,
    scope: RepositoryScope,
    path: String,
    git_path: std::path::PathBuf,
    baseline: crate::history::Baseline,
    page_size: u16,
) {
    let open_done = open_done.clone();
    let cancelled_for_worker = Arc::clone(&cancelled);
    let request_id_for_worker = request_id.clone();
    let scope_for_worker = scope.clone();
    workers.push(thread::spawn(move || {
        let deadline = std::time::Instant::now() + PREVIEW_TIMEOUT;
        let result =
            repository::discover_repository(&git_path, &path, &cancelled_for_worker, deadline)
                .and_then(|mut discovered| {
                    discovered.scope_tips = if scope_for_worker == RepositoryScope::Head {
                        discovered.info.head_oid.iter().cloned().collect()
                    } else {
                        let navigation = discovered
                            .navigation
                            .as_ref()
                            .map_err(navigation_preview_error)?;
                        crate::navigation::scope_tips(
                            &git_path,
                            &path,
                            navigation,
                            discovered.refs_truncated,
                            &scope_for_worker,
                            discovered.info.head_oid.as_deref(),
                            discovered.oid_length,
                            &cancelled_for_worker,
                            deadline,
                        )
                        .map_err(|error| navigation_preview_error(&error))?
                    };
                    let discovered = Arc::new(discovered);
                    let history = Arc::new(crate::history::HistoryState::new());
                    history.set_baseline(baseline.clone());
                    let page = history.read_page(
                        &git_path,
                        &discovered,
                        None,
                        page_size,
                        &cancelled_for_worker,
                        deadline,
                    )?;
                    bounded_repository_response(
                        &request_id_for_worker,
                        Some(&expected_repo_id),
                        Some(&expected_generation),
                        1,
                        discovered.info.clone(),
                        discovered.refs.clone(),
                        discovered.refs_truncated,
                    )?;
                    pack_history_chunks(
                        &request_id_for_worker,
                        Some(&expected_repo_id),
                        Some(&expected_generation),
                        &page,
                    )
                    .map_err(|()| {
                        repository::resource_limit("History page response exceeds the size limit")
                    })?;
                    Ok(PreparedRefresh {
                        discovered,
                        history,
                        baseline,
                        page,
                    })
                });
        let _ = open_done.send(OpenCompletion {
            request_id,
            intent,
            cancelled,
            payload: OpenCompletionPayload::Refresh {
                expected_repo_id,
                expected_generation,
                scope,
                result,
            },
        });
    }));
}

fn cancel_repository_requests(requests: &ActiveRequests, repo_id: &str) {
    for request in requests.lock().expect("request map poisoned").values() {
        if request.repo_id.as_deref() == Some(repo_id) {
            request.cancelled.store(true, Ordering::Release);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn drain_open_completions(
    receiver: &Receiver<OpenCompletion>,
    sessions: &mut session::SessionManager,
    requests: &ActiveRequests,
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    metadata_tasks: &Arc<crate::metadata_index::TaskManager>,
    git_path: Option<&std::path::Path>,
    workers: &mut Vec<JoinHandle<()>>,
) {
    while let Ok(completion) = receiver.try_recv() {
        let OpenCompletion {
            request_id,
            intent,
            cancelled,
            payload,
        } = completion;
        match payload {
            OpenCompletionPayload::Open(Ok(discovered)) => {
                match sessions.commit_open(intent, &cancelled, Arc::new(discovered)) {
                    Ok(commit) => {
                        metadata_tasks.activate(&commit.session);
                        if let Some(old_repo_id) = commit.replaced_repo_id.as_deref() {
                            cancel_repository_requests(requests, old_repo_id);
                        }
                        let message = session_response(
                            &request_id,
                            None,
                            None,
                            ResponseData::RepositorySession {
                                session: commit.session.info.clone(),
                            },
                            1,
                        );
                        send_main_message(sender, shutdown, &message);
                    }
                    Err(error) => send_open_completion_error(
                        request_id.as_str(),
                        intent,
                        None,
                        None,
                        error.code,
                        error.message,
                        sessions,
                        sender,
                        shutdown,
                    ),
                }
            }
            OpenCompletionPayload::Open(Err(error)) => {
                let was_cancelled =
                    cancelled.load(Ordering::Acquire) || error.code == ErrorCode::Cancelled;
                let code = if was_cancelled {
                    ErrorCode::Cancelled
                } else {
                    error.code
                };
                let message = if was_cancelled {
                    "Repository open was cancelled or superseded".into()
                } else {
                    error.message
                };
                send_open_completion_error(
                    request_id.as_str(),
                    intent,
                    None,
                    None,
                    code,
                    message,
                    sessions,
                    sender,
                    shutdown,
                );
            }
            OpenCompletionPayload::Refresh {
                expected_repo_id,
                expected_generation,
                scope,
                result: Ok(prepared),
            } => {
                let commit = sessions.commit_scope(
                    intent,
                    &expected_repo_id,
                    &expected_generation,
                    &cancelled,
                    scope,
                    Arc::clone(&prepared.discovered),
                    Arc::clone(&prepared.history),
                    prepared.baseline.clone(),
                );
                match commit {
                    Ok(commit) => {
                        metadata_tasks.activate(&commit.session);
                        if let Some(old_repo_id) = commit.replaced_repo_id.as_deref() {
                            cancel_repository_requests(requests, old_repo_id);
                        }
                        emit_refresh_result(
                            request_id.as_str(),
                            Some(&expected_repo_id),
                            Some(&expected_generation),
                            sender,
                            shutdown,
                            &commit.session,
                            prepared.page,
                        );
                        if let Some(git_path) = git_path {
                            let manager = Arc::clone(metadata_tasks);
                            let session = Arc::clone(&commit.session);
                            let git_path = git_path.to_path_buf();
                            let requests = Arc::clone(requests);
                            workers.push(thread::spawn(move || {
                                ensure_metadata_index(&manager, session, &git_path, &requests)
                            }));
                        }
                    }
                    Err(error) => send_open_completion_error(
                        request_id.as_str(),
                        intent,
                        Some(expected_repo_id),
                        Some(expected_generation),
                        error.code,
                        error.message,
                        sessions,
                        sender,
                        shutdown,
                    ),
                }
            }
            OpenCompletionPayload::Refresh {
                expected_repo_id,
                expected_generation,
                scope: _,
                result: Err(error),
            } => {
                let was_cancelled =
                    cancelled.load(Ordering::Acquire) || error.code == ErrorCode::Cancelled;
                let code = if was_cancelled {
                    ErrorCode::Cancelled
                } else {
                    error.code
                };
                let message = if was_cancelled {
                    "Repository refresh was cancelled or superseded".into()
                } else {
                    error.message
                };
                send_open_completion_error(
                    request_id.as_str(),
                    intent,
                    Some(expected_repo_id),
                    Some(expected_generation),
                    code,
                    message,
                    sessions,
                    sender,
                    shutdown,
                );
            }
        }
        remove_request(requests, &request_id, &cancelled);
    }
}

#[allow(clippy::too_many_arguments)]
fn send_open_completion_error(
    request_id: &str,
    intent: u64,
    repo_id: Option<String>,
    generation: Option<String>,
    code: ErrorCode,
    message: String,
    sessions: &mut session::SessionManager,
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
) {
    sessions.finish_open_failure(intent);
    send_error(
        sender,
        shutdown,
        Some(request_id.to_owned()),
        repo_id,
        generation,
        code,
        message,
        false,
    );
}

fn emit_refresh_result(
    request_id: &str,
    request_repo_id: Option<&str>,
    request_generation: Option<&str>,
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    session: &session::RepositorySession,
    page: crate::history::HistoryPage,
) {
    let repo_id = request_repo_id.map(str::to_owned);
    let generation = request_generation.map(str::to_owned);
    let session_message = ServerMessage::Response {
        request_id: request_id.to_owned(),
        repo_id: repo_id.clone(),
        generation: generation.clone(),
        sequence: 0,
        done: false,
        coverage: Coverage {
            complete: false,
            processed: 0,
        },
        next_cursor: None,
        data: ResponseData::RepositorySession {
            session: session.info.clone(),
        },
    };
    if !send_queued_message(sender, shutdown, &session_message) {
        return;
    }
    let repository_message = match bounded_repository_response(
        request_id,
        repo_id.as_deref(),
        generation.as_deref(),
        1,
        session.info.repository.clone(),
        session.discovered.refs.clone(),
        session.discovered.refs_truncated,
    ) {
        Ok(message) => message,
        Err(_) => {
            shutdown.store(true, Ordering::Release);
            return;
        }
    };
    if !send_queued_message(sender, shutdown, &repository_message) {
        return;
    }
    let chunks =
        match pack_history_chunks(request_id, repo_id.as_deref(), generation.as_deref(), &page) {
            Ok(chunks) => chunks,
            Err(()) => {
                shutdown.store(true, Ordering::Release);
                return;
            }
        };
    let total = page.commits.len() as u32;
    let mut processed = 0_u32;
    for (index, commits) in chunks.iter().enumerate() {
        processed = processed.saturating_add(commits.len() as u32);
        let done = index + 1 == chunks.len();
        let message = ServerMessage::Response {
            request_id: request_id.to_owned(),
            repo_id: repo_id.clone(),
            generation: generation.clone(),
            sequence: index as u32 + 2,
            done,
            coverage: Coverage {
                complete: done,
                processed: if done { total } else { processed },
            },
            next_cursor: if done { page.next_cursor.clone() } else { None },
            data: ResponseData::HistoryPage {
                commits: commits.clone(),
                offset: page.offset,
                page_size: page.page_size,
                cursor: page.cursor.clone(),
                previous_cursor: page.previous_cursor.clone(),
                has_more: page.has_more,
                new_since_last_seen_status: page.new_since_last_seen_status,
                last_seen_divider_oid: page.last_seen_divider_oid.clone(),
            },
        };
        if !send_queued_message(sender, shutdown, &message) {
            return;
        }
    }
}

fn send_queued_message(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    message: &ServerMessage,
) -> bool {
    let Ok(mut bytes) = serde_json::to_vec(message) else {
        shutdown.store(true, Ordering::Release);
        return false;
    };
    bytes.push(b'\n');
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if shutdown.load(Ordering::Acquire) {
            return false;
        }
        if std::time::Instant::now() >= deadline {
            shutdown.store(true, Ordering::Release);
            return false;
        }
        match sender.try_send(OutFrame {
            bytes,
            flushed: None,
        }) {
            Ok(()) => return true,
            Err(TrySendError::Disconnected(_)) => {
                shutdown.store(true, Ordering::Release);
                return false;
            }
            Err(TrySendError::Full(frame)) => {
                bytes = frame.bytes;
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

fn decode_client_message(frame: &[u8]) -> Result<ClientMessage, String> {
    let text = std::str::from_utf8(frame).map_err(|_| "协议帧不是有效 UTF-8".to_owned())?;
    serde_json::from_str(text).map_err(|_| "协议帧不是有效的客户端消息 JSON".to_owned())
}

fn validate_request(
    request_id: &str,
    repo_id: Option<&str>,
    generation: Option<&str>,
    method: &str,
    params: &Value,
) -> Result<RequestOperation, (ErrorCode, String)> {
    if request_id.is_empty() || request_id.chars().count() > 128 {
        return Err((
            ErrorCode::InvalidRequest,
            "requestId 必须为 1 至 128 字符".into(),
        ));
    }
    let valid_id = |id: &str| !id.is_empty() && id.chars().count() <= MAX_OPAQUE_ID_BYTES;
    if repo_id.is_some_and(|id| !valid_id(id)) || generation.is_some_and(|id| !valid_id(id)) {
        return Err((ErrorCode::InvalidRequest, "仓库上下文标识长度无效".into()));
    }
    let null_context = repo_id.is_none() && generation.is_none();
    let session_context = repo_id.is_some() && generation.is_some();
    match method {
        "getRuntimeInfo" if null_context => serde_json::from_value::<EmptyParams>(params.clone())
            .map(|_| RequestOperation::RuntimeInfo)
            .map_err(|_| {
                (
                    ErrorCode::InvalidRequest,
                    "getRuntimeInfo params 必须为空对象".into(),
                )
            }),
        "readRepositoryPreview" if null_context => {
            serde_json::from_value::<ReadRepositoryPreviewParams>(params.clone())
                .map(|params| RequestOperation::RepositoryPreview(params.path))
                .map_err(|_| {
                    (
                        ErrorCode::InvalidRequest,
                        "readRepositoryPreview params 必须包含绝对目录 path".into(),
                    )
                })
        }
        "openRepository" | "listRecentRepositories" if null_context => {
            if method == "openRepository" {
                serde_json::from_value::<OpenRepositoryParams>(params.clone())
                    .and_then(|params| {
                        if params.path.len() <= 16 * 1024
                            && !params.path.contains('\0')
                            && std::path::Path::new(&params.path).is_absolute()
                        {
                            Ok(params)
                        } else {
                            Err(serde::de::Error::custom("invalid repository path"))
                        }
                    })
                    .map(|params| RequestOperation::OpenRepository(params.path))
                    .map_err(|_| {
                        (
                            ErrorCode::InvalidRequest,
                            "openRepository params 必须包含绝对目录 path".into(),
                        )
                    })
            } else {
                serde_json::from_value::<EmptyParams>(params.clone())
                    .map(|_| RequestOperation::ListRecentRepositories)
                    .map_err(|_| {
                        (
                            ErrorCode::InvalidRequest,
                            "listRecentRepositories params 必须为空对象".into(),
                        )
                    })
            }
        }
        "getRepositorySession"
        | "readSessionPreview"
        | "readHistoryPage"
        | "locateCommit"
        | "locateHistoryDate"
        | "refreshRepository"
        | "getRepositoryNavigation"
        | "selectRepositoryScope"
        | "refMergeStatus"
        | "getMetadataIndexStatus"
        | "controlMetadataIndex"
        | "searchCommits"
        | "listSearchIdentities"
        | "listSearchPaths"
        | "getActivityStats"
        | "getActivityOverview"
        | "estimateEvolution"
        | "analyzeEvolution"
        | "setStatsExclusions"
        | "getStatsExclusions"
        | "getStatsCommits"
        | "getNotableStats"
        | "getChangeStats"
        | "observeRepository"
        | "diffRefSnapshots"
        | "getHandoffFacts"
        | "getCommit"
        | "listChangedFiles"
        | "readMergeCommits"
        | "branchesContaining"
        | "readDiff"
        | "readWorkspaceStatus"
        | "readWorkspaceDiff"
        | "readWorkspaceFile"
        | "listTree"
        | "readFileContent"
        | "readFileHistory"
        | "readFileChange"
        | "listPathChanges"
        | "readBlame"
        | "fetchRepository"
        | "pushRepository"
        | "getBranchSync"
        | "checkOperation"
        | "runOperation"
        | "recordRepositoryView"
        | "closeRepository"
            if session_context =>
        {
            match method {
                "readHistoryPage" => {
                    serde_json::from_value::<ReadHistoryPageParams>(params.clone())
                        .map(RequestOperation::ReadHistoryPage)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "readHistoryPage params 无效".into(),
                            )
                        })
                }
                "locateCommit" => serde_json::from_value::<LocateCommitParams>(params.clone())
                    .and_then(|params| {
                        if (1..=500).contains(&params.page_size) {
                            Ok(params)
                        } else {
                            Err(serde::de::Error::custom("pageSize must be 1..=500"))
                        }
                    })
                    .map(RequestOperation::LocateCommit)
                    .map_err(|_| (ErrorCode::InvalidRequest, "locateCommit params 无效".into())),
                "locateHistoryDate" => {
                    serde_json::from_value::<LocateHistoryDateParams>(params.clone())
                        .and_then(|params| {
                            if (1..=500).contains(&params.page_size) {
                                Ok(params)
                            } else {
                                Err(serde::de::Error::custom("pageSize must be 1..=500"))
                            }
                        })
                        .map(RequestOperation::LocateHistoryDate)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "locateHistoryDate params 无效".into(),
                            )
                        })
                }
                "refreshRepository" => {
                    serde_json::from_value::<RefreshRepositoryParams>(params.clone())
                        .map(RequestOperation::RefreshRepository)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "refreshRepository params 无效".into(),
                            )
                        })
                }
                "selectRepositoryScope" => {
                    serde_json::from_value::<SelectRepositoryScopeParams>(params.clone())
                        .map(RequestOperation::SelectRepositoryScope)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "selectRepositoryScope params 无效".into(),
                            )
                        })
                }
                "refMergeStatus" => serde_json::from_value::<RefMergeStatusParams>(params.clone())
                    .map(RequestOperation::RefMergeStatus)
                    .map_err(|_| {
                        (
                            ErrorCode::InvalidRequest,
                            "refMergeStatus params 无效".into(),
                        )
                    }),
                "controlMetadataIndex" => {
                    serde_json::from_value::<ControlMetadataIndexParams>(params.clone())
                        .map(|params| RequestOperation::ControlMetadataIndex(params.action))
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "controlMetadataIndex params 无效".into(),
                            )
                        })
                }
                "searchCommits" => serde_json::from_value::<SearchCommitsParams>(params.clone())
                    .map(RequestOperation::SearchCommits)
                    .map_err(|_| {
                        (
                            ErrorCode::InvalidRequest,
                            "searchCommits params 无效".into(),
                        )
                    }),
                "listSearchIdentities" => {
                    serde_json::from_value::<SearchIdentitiesParams>(params.clone())
                        .map(RequestOperation::ListSearchIdentities)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "listSearchIdentities params 无效".into(),
                            )
                        })
                }
                "listSearchPaths" => {
                    serde_json::from_value::<ListSearchPathsParams>(params.clone())
                        .map(RequestOperation::ListSearchPaths)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "listSearchPaths params 无效".into(),
                            )
                        })
                }
                "getChangeStats" => {
                    serde_json::from_value::<commitscope_core::GetChangeStatsParams>(params.clone())
                        .map(RequestOperation::GetChangeStats)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "getChangeStats params 无效".into(),
                            )
                        })
                }
                "getNotableStats" => serde_json::from_value::<
                    commitscope_core::GetActivityOverviewParams,
                >(params.clone())
                .map(RequestOperation::GetNotableStats)
                .map_err(|_| {
                    (
                        ErrorCode::InvalidRequest,
                        "getNotableStats params 无效".into(),
                    )
                }),
                "getStatsCommits" => serde_json::from_value::<
                    commitscope_core::GetStatsCommitsParams,
                >(params.clone())
                .map(RequestOperation::GetStatsCommits)
                .map_err(|_| {
                    (
                        ErrorCode::InvalidRequest,
                        "getStatsCommits params 无效".into(),
                    )
                }),
                "getStatsExclusions" => {
                    serde_json::from_value::<commitscope_core::EmptyParams>(params.clone())
                        .map(RequestOperation::GetStatsExclusions)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "getStatsExclusions params 无效".into(),
                            )
                        })
                }
                "setStatsExclusions" => serde_json::from_value::<
                    commitscope_core::SetStatsExclusionsParams,
                >(params.clone())
                .map(RequestOperation::SetStatsExclusions)
                .map_err(|_| {
                    (
                        ErrorCode::InvalidRequest,
                        "setStatsExclusions params 无效".into(),
                    )
                }),
                "estimateEvolution" => {
                    serde_json::from_value::<commitscope_core::EvolutionParams>(params.clone())
                        .map(RequestOperation::EstimateEvolution)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "estimateEvolution params 无效".into(),
                            )
                        })
                }
                "analyzeEvolution" => {
                    serde_json::from_value::<commitscope_core::EvolutionParams>(params.clone())
                        .map(RequestOperation::AnalyzeEvolution)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "analyzeEvolution params 无效".into(),
                            )
                        })
                }
                "getActivityOverview" => serde_json::from_value::<
                    commitscope_core::GetActivityOverviewParams,
                >(params.clone())
                .map(RequestOperation::GetActivityOverview)
                .map_err(|_| {
                    (
                        ErrorCode::InvalidRequest,
                        "getActivityOverview params 无效".into(),
                    )
                }),
                "getActivityStats" => {
                    serde_json::from_value::<GetActivityStatsParams>(params.clone())
                        .map(RequestOperation::GetActivityStats)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "getActivityStats params 无效".into(),
                            )
                        })
                }
                "getHandoffFacts" => {
                    serde_json::from_value::<GetHandoffFactsParams>(params.clone())
                        .map(RequestOperation::GetHandoffFacts)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "getHandoffFacts params 无效".into(),
                            )
                        })
                }
                "getCommit" => serde_json::from_value::<GetCommitParams>(params.clone())
                    .map(RequestOperation::GetCommit)
                    .map_err(|_| (ErrorCode::InvalidRequest, "getCommit params 无效".into())),
                "listChangedFiles" => {
                    serde_json::from_value::<ListChangedFilesParams>(params.clone())
                        .and_then(|params| {
                            if (1..=200).contains(&params.page_size)
                                && params.parent_index.is_none_or(|index| index <= 127)
                            {
                                Ok(params)
                            } else {
                                Err(serde::de::Error::custom("pageSize must be 1..=200"))
                            }
                        })
                        .map(RequestOperation::ListChangedFiles)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "listChangedFiles params 无效".into(),
                            )
                        })
                }
                "readMergeCommits" => {
                    serde_json::from_value::<ReadMergeCommitsParams>(params.clone())
                        .and_then(|params| {
                            if (1..=200).contains(&params.page_size)
                                && params.parent_index > 0
                                && params.parent_index <= 127
                            {
                                Ok(params)
                            } else {
                                Err(serde::de::Error::custom(
                                    "parentIndex/pageSize out of range",
                                ))
                            }
                        })
                        .map(RequestOperation::ReadMergeCommits)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "readMergeCommits params 无效".into(),
                            )
                        })
                }
                "branchesContaining" => {
                    serde_json::from_value::<BranchesContainingParams>(params.clone())
                        .map(RequestOperation::BranchesContaining)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "branchesContaining params 无效".into(),
                            )
                        })
                }
                "readDiff" => serde_json::from_value::<ReadDiffParams>(params.clone())
                    .map(RequestOperation::ReadDiff)
                    .map_err(|_| (ErrorCode::InvalidRequest, "readDiff params 无效".into())),
                "readWorkspaceStatus" => {
                    serde_json::from_value::<ReadWorkspaceStatusParams>(params.clone())
                        .ok()
                        .filter(|params| (1..=2000).contains(&params.max_entries))
                        .map(RequestOperation::ReadWorkspaceStatus)
                        .ok_or_else(|| {
                            (
                                ErrorCode::InvalidRequest,
                                "readWorkspaceStatus params 无效".into(),
                            )
                        })
                }
                "readWorkspaceDiff" => {
                    serde_json::from_value::<ReadWorkspaceDiffParams>(params.clone())
                        .map(RequestOperation::ReadWorkspaceDiff)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "readWorkspaceDiff params 无效".into(),
                            )
                        })
                }
                "readWorkspaceFile" => {
                    serde_json::from_value::<ReadWorkspaceFileParams>(params.clone())
                        .ok()
                        .filter(|params| (1..=5000).contains(&params.max_lines))
                        .map(RequestOperation::ReadWorkspaceFile)
                        .ok_or_else(|| {
                            (
                                ErrorCode::InvalidRequest,
                                "readWorkspaceFile params 无效".into(),
                            )
                        })
                }
                "listTree" => serde_json::from_value::<ListTreeParams>(params.clone())
                    .ok()
                    .filter(|params| (1..=500).contains(&params.limit))
                    .map(RequestOperation::ListTree)
                    .ok_or_else(|| (ErrorCode::InvalidRequest, "listTree params 无效".into())),
                "readFileContent" => {
                    serde_json::from_value::<ReadFileContentParams>(params.clone())
                        .ok()
                        .filter(|params| (1..=5000).contains(&params.max_lines))
                        .map(RequestOperation::ReadFileContent)
                        .ok_or_else(|| {
                            (
                                ErrorCode::InvalidRequest,
                                "readFileContent params 无效".into(),
                            )
                        })
                }
                "readFileHistory" => {
                    serde_json::from_value::<ReadFileHistoryParams>(params.clone())
                        .ok()
                        .filter(|params| {
                            (1..=200).contains(&params.page_size)
                                && params.message.chars().count() <= 4096
                                && params
                                    .cursor
                                    .as_ref()
                                    .is_none_or(|cursor| cursor.len() <= 512)
                        })
                        .map(RequestOperation::ReadFileHistory)
                        .ok_or_else(|| {
                            (
                                ErrorCode::InvalidRequest,
                                "readFileHistory params 无效".into(),
                            )
                        })
                }
                "readFileChange" => serde_json::from_value::<ReadFileChangeParams>(params.clone())
                    .map(RequestOperation::ReadFileChange)
                    .map_err(|_| {
                        (
                            ErrorCode::InvalidRequest,
                            "readFileChange params 无效".into(),
                        )
                    }),
                "listPathChanges" => {
                    serde_json::from_value::<ListPathChangesParams>(params.clone())
                        .ok()
                        .filter(|params| (1..=200).contains(&params.page_size))
                        .map(RequestOperation::ListPathChanges)
                        .ok_or_else(|| {
                            (
                                ErrorCode::InvalidRequest,
                                "listPathChanges params 无效".into(),
                            )
                        })
                }
                "readBlame" => serde_json::from_value::<ReadBlameParams>(params.clone())
                    .map(RequestOperation::ReadBlame)
                    .map_err(|_| (ErrorCode::InvalidRequest, "readBlame params 无效".into())),
                "getBranchSync" => {
                    serde_json::from_value::<commitscope_core::GetBranchSyncParams>(params.clone())
                        .map(RequestOperation::GetBranchSync)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "getBranchSync params 无效".into(),
                            )
                        })
                }
                "checkOperation" => {
                    serde_json::from_value::<commitscope_core::OperationParams>(params.clone())
                        .map(RequestOperation::CheckOperation)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "checkOperation params 无效".into(),
                            )
                        })
                }
                "runOperation" => {
                    serde_json::from_value::<commitscope_core::OperationParams>(params.clone())
                        .map(RequestOperation::RunOperation)
                        .map_err(|_| (ErrorCode::InvalidRequest, "runOperation params 无效".into()))
                }
                "fetchRepository" => serde_json::from_value::<
                    commitscope_core::FetchRepositoryParams,
                >(params.clone())
                .map(RequestOperation::FetchRepository)
                .map_err(|_| {
                    (
                        ErrorCode::InvalidRequest,
                        "fetchRepository params 无效".into(),
                    )
                }),
                "pushRepository" => {
                    serde_json::from_value::<commitscope_core::PushRepositoryParams>(params.clone())
                        .map(RequestOperation::PushRepository)
                        .map_err(|_| {
                            (
                                ErrorCode::InvalidRequest,
                                "pushRepository params 无效".into(),
                            )
                        })
                }
                _ => serde_json::from_value::<EmptyParams>(params.clone())
                    .map(|_| match method {
                        "getRepositorySession" => RequestOperation::GetRepositorySession,
                        "getMetadataIndexStatus" => RequestOperation::GetMetadataIndexStatus,
                        "getRepositoryNavigation" => RequestOperation::GetRepositoryNavigation,
                        "observeRepository" => RequestOperation::ObserveRepository,
                        "diffRefSnapshots" => RequestOperation::DiffRefSnapshots,
                        "readSessionPreview" => RequestOperation::ReadSessionPreview,
                        "recordRepositoryView" => RequestOperation::RecordRepositoryView,
                        _ => RequestOperation::CloseRepository,
                    })
                    .map_err(|_| {
                        (
                            ErrorCode::InvalidRequest,
                            format!("{method} params 必须为空对象"),
                        )
                    }),
            }
        }
        "getRepositorySession"
        | "readSessionPreview"
        | "readHistoryPage"
        | "locateCommit"
        | "locateHistoryDate"
        | "refreshRepository"
        | "getRepositoryNavigation"
        | "selectRepositoryScope"
        | "refMergeStatus"
        | "getMetadataIndexStatus"
        | "controlMetadataIndex"
        | "searchCommits"
        | "listSearchIdentities"
        | "listSearchPaths"
        | "getActivityStats"
        | "getActivityOverview"
        | "estimateEvolution"
        | "analyzeEvolution"
        | "setStatsExclusions"
        | "getStatsExclusions"
        | "getStatsCommits"
        | "getNotableStats"
        | "getChangeStats"
        | "observeRepository"
        | "diffRefSnapshots"
        | "getHandoffFacts"
        | "getCommit"
        | "listChangedFiles"
        | "readMergeCommits"
        | "branchesContaining"
        | "readDiff"
        | "readWorkspaceStatus"
        | "readWorkspaceDiff"
        | "readWorkspaceFile"
        | "listTree"
        | "readFileContent"
        | "readFileHistory"
        | "readFileChange"
        | "listPathChanges"
        | "readBlame"
        | "fetchRepository"
        | "pushRepository"
        | "getBranchSync"
        | "checkOperation"
        | "runOperation"
        | "recordRepositoryView"
        | "closeRepository" => Err((ErrorCode::StaleContext, "仓库会话上下文缺失或无效".into())),
        "getRuntimeInfo"
        | "readRepositoryPreview"
        | "openRepository"
        | "listRecentRepositories" => Err((
            ErrorCode::InvalidRequest,
            "该方法不接受仓库会话上下文".into(),
        )),
        _ => Err((ErrorCode::UnknownMethod, "未知方法".into())),
    }
}

fn bounded_request_id(request_id: &str) -> Option<String> {
    (!request_id.is_empty() && request_id.chars().count() <= 128).then(|| request_id.to_owned())
}

fn bounded_opaque(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty() && value.chars().count() <= MAX_OPAQUE_ID_BYTES)
}

#[allow(clippy::too_many_arguments)]
fn execute_runtime_info(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    requests: &ActiveRequests,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    git_path: Option<&std::path::Path>,
    cancelled: Arc<AtomicBool>,
) {
    let response = ServerMessage::Response {
        request_id: request_id.to_owned(),
        repo_id: repo_id.clone(),
        generation: generation.clone(),
        sequence: 0,
        done: false,
        coverage: Coverage {
            complete: false,
            processed: 1,
        },
        next_cursor: None,
        data: ResponseData::Core {
            core_version: env!("CARGO_PKG_VERSION").to_owned(),
            pid: process::id(),
        },
    };
    if !send_task_message(sender, shutdown, &cancelled, &response) {
        finish_cancelled(
            sender,
            shutdown,
            request_id,
            repo_id.clone(),
            generation.clone(),
        );
        remove_request(requests, request_id, &cancelled);
        return;
    }

    let git = match runtime::probe_git(git_path, Some(&cancelled)) {
        Ok(git) => git,
        Err(runtime::ProbeFailure::Cancelled) => {
            finish_cancelled(
                sender,
                shutdown,
                request_id,
                repo_id.clone(),
                generation.clone(),
            );
            remove_request(requests, request_id, &cancelled);
            return;
        }
        Err(runtime::ProbeFailure::Timeout) => {
            send_terminal_error(
                sender,
                shutdown,
                Some(request_id.to_owned()),
                repo_id,
                generation,
                ErrorCode::Timeout,
                "Git 版本探测超时".into(),
                true,
            );
            remove_request(requests, request_id, &cancelled);
            return;
        }
    };
    if cancelled.load(Ordering::Acquire) {
        finish_cancelled(sender, shutdown, request_id, repo_id, generation);
    } else {
        let response = ServerMessage::Response {
            request_id: request_id.to_owned(),
            repo_id: repo_id.clone(),
            generation: generation.clone(),
            sequence: 1,
            done: true,
            coverage: Coverage {
                complete: true,
                processed: 2,
            },
            next_cursor: None,
            data: ResponseData::Git { git },
        };
        if !send_task_message(sender, shutdown, &cancelled, &response)
            && cancelled.load(Ordering::Acquire)
        {
            finish_cancelled(
                sender,
                shutdown,
                request_id,
                repo_id.clone(),
                generation.clone(),
            );
        }
    }
    remove_request(requests, request_id, &cancelled);
}

#[allow(clippy::too_many_arguments)]
fn execute_repository_preview(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    requests: &ActiveRequests,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    git_path: Option<&std::path::Path>,
    path: &str,
    cancelled: Arc<AtomicBool>,
) {
    let Some(git_path) = git_path else {
        send_terminal_error(
            sender,
            shutdown,
            Some(request_id.to_owned()),
            repo_id,
            generation,
            ErrorCode::GitUnavailable,
            "Git executable was not found".into(),
            false,
        );
        remove_request(requests, request_id, &cancelled);
        return;
    };

    let deadline = std::time::Instant::now() + PREVIEW_TIMEOUT;
    let mut sequence = 0_u32;
    let result = repository::read_repository_preview(
        git_path,
        path,
        &cancelled,
        deadline,
        |repository, refs, refs_truncated| {
            let message = bounded_repository_response(
                request_id,
                repo_id.as_deref(),
                generation.as_deref(),
                sequence,
                repository,
                refs,
                refs_truncated,
            )?;
            if !send_task_message(sender, shutdown, &cancelled, &message) {
                return Err(repository::PreviewError {
                    code: ErrorCode::Cancelled,
                    message: "请求已取消".into(),
                    retryable: false,
                });
            }
            sequence += 1;
            Ok(())
        },
    );

    finish_preview_tail(
        sender, shutdown, requests, request_id, repo_id, generation, sequence, cancelled, result,
    );
}

#[allow(clippy::too_many_arguments)]
fn execute_repository_navigation(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    requests: &ActiveRequests,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    session: Arc<session::RepositorySession>,
    cancelled: Arc<AtomicBool>,
) {
    let deadline = std::time::Instant::now() + PREVIEW_TIMEOUT;
    let result = repository::verify_graph_fingerprint(&session.discovered, &cancelled, deadline)
        .and_then(|()| {
            session
                .discovered
                .navigation
                .as_ref()
                .map_err(navigation_preview_error)
                .cloned()
        })
        .and_then(|navigation| {
            repository::verify_graph_fingerprint(&session.discovered, &cancelled, deadline)?;
            Ok(navigation)
        });
    if cancelled.load(Ordering::Acquire) {
        finish_cancelled(sender, shutdown, request_id, repo_id, generation);
    } else {
        match result {
            Ok(navigation)
                if serde_json::to_vec(&navigation)
                    .map_or(true, |value| value.len() > RESPONSE_TARGET_BYTES) =>
            {
                send_error(
                    sender,
                    shutdown,
                    Some(request_id.to_owned()),
                    repo_id,
                    generation,
                    ErrorCode::ResourceLimit,
                    "Repository navigation response exceeds the size limit".into(),
                    false,
                );
            }
            Ok(navigation) => {
                let cancel_repo_id = repo_id.clone();
                let cancel_generation = generation.clone();
                let processed = navigation
                    .refs
                    .len()
                    .saturating_add(navigation.worktrees.len())
                    as u32;
                let message = session_response(
                    request_id,
                    repo_id,
                    generation,
                    ResponseData::RepositoryNavigation { navigation },
                    processed,
                );
                if !send_task_message(sender, shutdown, &cancelled, &message)
                    && cancelled.load(Ordering::Acquire)
                {
                    finish_cancelled(
                        sender,
                        shutdown,
                        request_id,
                        cancel_repo_id,
                        cancel_generation,
                    );
                }
            }
            Err(error) => send_error(
                sender,
                shutdown,
                Some(request_id.to_owned()),
                repo_id,
                generation,
                error.code,
                error.message,
                error.retryable,
            ),
        }
    }
    remove_request(requests, request_id, &cancelled);
}

#[allow(clippy::too_many_arguments)]
fn execute_ref_merge_status(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    requests: &ActiveRequests,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    git_path: Option<&std::path::Path>,
    session: Arc<session::RepositorySession>,
    params: RefMergeStatusParams,
    cancelled: Arc<AtomicBool>,
) {
    let Some(git_path) = git_path else {
        send_error(
            sender,
            shutdown,
            Some(request_id.to_owned()),
            repo_id,
            generation,
            ErrorCode::GitUnavailable,
            "Git executable was not found".into(),
            false,
        );
        remove_request(requests, request_id, &cancelled);
        return;
    };
    let deadline = std::time::Instant::now() + PREVIEW_TIMEOUT;
    let result = repository::verify_graph_fingerprint(&session.discovered, &cancelled, deadline)
        .and_then(|()| {
            let navigation = session
                .discovered
                .navigation
                .as_ref()
                .map_err(navigation_preview_error)?;
            let result = crate::navigation::ref_merge_status(
                git_path,
                &session.info.repository.path,
                navigation,
                &params.ref_names,
                session.discovered.oid_length,
                repository::history_boundary_limited(&session.discovered),
                &cancelled,
                deadline,
            )
            .map_err(|error| navigation_preview_error(&error))?;
            repository::verify_graph_fingerprint(&session.discovered, &cancelled, deadline)?;
            Ok(result)
        });
    if cancelled.load(Ordering::Acquire) {
        finish_cancelled(sender, shutdown, request_id, repo_id, generation);
    } else {
        match result {
            Ok(result)
                if serde_json::to_vec(&result)
                    .map_or(true, |value| value.len() > RESPONSE_TARGET_BYTES) =>
            {
                send_error(
                    sender,
                    shutdown,
                    Some(request_id.to_owned()),
                    repo_id,
                    generation,
                    ErrorCode::ResourceLimit,
                    "Reference status response exceeds the size limit".into(),
                    false,
                );
            }
            Ok(result) => {
                let cancel_repo_id = repo_id.clone();
                let cancel_generation = generation.clone();
                let processed = result.statuses.len() as u32;
                let message = session_response(
                    request_id,
                    repo_id,
                    generation,
                    ResponseData::RefMergeStatus { result },
                    processed,
                );
                if !send_task_message(sender, shutdown, &cancelled, &message)
                    && cancelled.load(Ordering::Acquire)
                {
                    finish_cancelled(
                        sender,
                        shutdown,
                        request_id,
                        cancel_repo_id,
                        cancel_generation,
                    );
                }
            }
            Err(error) => send_error(
                sender,
                shutdown,
                Some(request_id.to_owned()),
                repo_id,
                generation,
                error.code,
                error.message,
                error.retryable,
            ),
        }
    }
    remove_request(requests, request_id, &cancelled);
}

#[allow(clippy::too_many_arguments)]
fn execute_session_preview(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    requests: &ActiveRequests,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    git_path: Option<&std::path::Path>,
    session: Arc<session::RepositorySession>,
    cancelled: Arc<AtomicBool>,
) {
    let Some(git_path) = git_path else {
        send_terminal_error(
            sender,
            shutdown,
            Some(request_id.to_owned()),
            repo_id,
            generation,
            ErrorCode::GitUnavailable,
            "Git executable was not found".into(),
            false,
        );
        remove_request(requests, request_id, &cancelled);
        return;
    };
    let deadline = std::time::Instant::now() + PREVIEW_TIMEOUT;
    let repository_message = match bounded_repository_response(
        request_id,
        repo_id.as_deref(),
        generation.as_deref(),
        0,
        session.info.repository.clone(),
        session.discovered.refs.clone(),
        session.discovered.refs_truncated,
    ) {
        Ok(message) => message,
        Err(error) => {
            send_terminal_error(
                sender,
                shutdown,
                Some(request_id.to_owned()),
                repo_id,
                generation,
                error.code,
                error.message,
                error.retryable,
            );
            remove_request(requests, request_id, &cancelled);
            return;
        }
    };
    if !send_task_message(sender, shutdown, &cancelled, &repository_message) {
        finish_cancelled(sender, shutdown, request_id, repo_id, generation);
        remove_request(requests, request_id, &cancelled);
        return;
    }
    let result =
        repository::read_discovered_preview(git_path, &session.discovered, &cancelled, deadline);
    finish_preview_tail(
        sender, shutdown, requests, request_id, repo_id, generation, 1, cancelled, result,
    );
}

#[allow(clippy::too_many_arguments)]
fn execute_history_page(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    requests: &ActiveRequests,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    git_path: Option<&std::path::Path>,
    session: Arc<session::RepositorySession>,
    params: ReadHistoryPageParams,
    cancelled: Arc<AtomicBool>,
    metadata_tasks: Arc<crate::metadata_index::TaskManager>,
) {
    execute_history_request(
        sender,
        shutdown,
        requests,
        request_id,
        repo_id,
        generation,
        git_path,
        session,
        params.page_size,
        params.cursor,
        None,
        None,
        None,
        cancelled,
        metadata_tasks,
    );
}

#[allow(clippy::too_many_arguments)]
fn execute_locate_commit(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    requests: &ActiveRequests,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    git_path: Option<&std::path::Path>,
    session: Arc<session::RepositorySession>,
    params: LocateCommitParams,
    cancelled: Arc<AtomicBool>,
    metadata_tasks: Arc<crate::metadata_index::TaskManager>,
) {
    execute_history_request(
        sender,
        shutdown,
        requests,
        request_id,
        repo_id,
        generation,
        git_path,
        session,
        params.page_size,
        None,
        Some(params.oid),
        None,
        None,
        cancelled,
        metadata_tasks,
    );
}

#[allow(clippy::too_many_arguments)]
fn execute_locate_history_date(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    requests: &ActiveRequests,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    git_path: Option<&std::path::Path>,
    session: Arc<session::RepositorySession>,
    params: LocateHistoryDateParams,
    cancelled: Arc<AtomicBool>,
    metadata_tasks: Arc<crate::metadata_index::TaskManager>,
) {
    execute_history_request(
        sender,
        shutdown,
        requests,
        request_id,
        repo_id,
        generation,
        git_path,
        session,
        params.page_size,
        None,
        None,
        Some(params.before_timestamp),
        params.known_cursors,
        cancelled,
        metadata_tasks,
    );
}

#[allow(clippy::too_many_arguments)]
fn execute_history_request(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    requests: &ActiveRequests,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    git_path: Option<&std::path::Path>,
    session: Arc<session::RepositorySession>,
    page_size: u16,
    cursor: Option<String>,
    locate_oid: Option<String>,
    locate_before_timestamp: Option<i64>,
    date_known_cursors: Option<Vec<String>>,
    cancelled: Arc<AtomicBool>,
    metadata_tasks: Arc<crate::metadata_index::TaskManager>,
) {
    let Some(git_path) = git_path else {
        send_terminal_error(
            sender,
            shutdown,
            Some(request_id.to_owned()),
            repo_id,
            generation,
            ErrorCode::GitUnavailable,
            "Git executable was not found".into(),
            false,
        );
        remove_request(requests, request_id, &cancelled);
        return;
    };
    let deadline = std::time::Instant::now() + PREVIEW_TIMEOUT;
    let compact_date = locate_before_timestamp.is_some() && date_known_cursors.is_some();
    if !compact_date {
        let repository = match bounded_repository_response(
            request_id,
            repo_id.as_deref(),
            generation.as_deref(),
            0,
            session.info.repository.clone(),
            session.discovered.refs.clone(),
            session.discovered.refs_truncated,
        ) {
            Ok(message) => message,
            Err(error) => {
                send_terminal_error(
                    sender,
                    shutdown,
                    Some(request_id.to_owned()),
                    repo_id,
                    generation,
                    error.code,
                    error.message,
                    error.retryable,
                );
                remove_request(requests, request_id, &cancelled);
                return;
            }
        };
        if !send_task_message(sender, shutdown, &cancelled, &repository) {
            finish_cancelled(sender, shutdown, request_id, repo_id, generation);
            remove_request(requests, request_id, &cancelled);
            return;
        }
    }
    let result = if let Some(oid) = locate_oid {
        session.history.with_located_page(
            git_path,
            &session.discovered,
            &LocateCommitParams { oid, page_size },
            &cancelled,
            deadline,
            |page| {
                send_history_page_chunks(
                    sender,
                    shutdown,
                    &cancelled,
                    request_id,
                    &repo_id,
                    &generation,
                    page,
                )
            },
        )
    } else if let Some(before_timestamp) = locate_before_timestamp {
        session
            .history
            .with_located_date_page_and_location(
                git_path,
                &session.discovered,
                &LocateHistoryDateParams {
                    before_timestamp,
                    page_size,
                    known_cursors: date_known_cursors.clone(),
                },
                (&cancelled, deadline),
                |location, reused| {
                    let message = ServerMessage::Response {
                        request_id: request_id.to_owned(),
                        repo_id: repo_id.clone(),
                        generation: generation.clone(),
                        sequence: 0,
                        done: reused,
                        coverage: Coverage {
                            complete: reused,
                            processed: 0,
                        },
                        next_cursor: None,
                        data: ResponseData::HistoryDateLocation {
                            location: location.clone(),
                        },
                    };
                    if send_task_message(sender, shutdown, &cancelled, &message) {
                        Ok(())
                    } else {
                        Err(repository::cancelled_error())
                    }
                },
                |page| {
                    send_history_page_chunks(
                        sender,
                        shutdown,
                        &cancelled,
                        request_id,
                        &repo_id,
                        &generation,
                        page,
                    )
                },
            )
            .map(|page| page.unwrap_or(()))
    } else {
        session.history.with_page(
            git_path,
            &session.discovered,
            cursor.as_deref(),
            page_size,
            &cancelled,
            deadline,
            |page| {
                send_history_page_chunks(
                    sender,
                    shutdown,
                    &cancelled,
                    request_id,
                    &repo_id,
                    &generation,
                    page,
                )
            },
        )
    };
    match result {
        Ok(()) => {}
        Err(error) => {
            if error.code == ErrorCode::Cancelled || cancelled.load(Ordering::Acquire) {
                finish_cancelled(sender, shutdown, request_id, repo_id, generation);
            } else {
                send_terminal_error(
                    sender,
                    shutdown,
                    Some(request_id.to_owned()),
                    repo_id,
                    generation,
                    error.code,
                    error.message,
                    error.retryable,
                );
            }
            remove_request(requests, request_id, &cancelled);
            return;
        }
    }
    remove_request(requests, request_id, &cancelled);
    ensure_metadata_index(&metadata_tasks, session, git_path, requests);
}

fn send_history_page_chunks(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    cancelled: &AtomicBool,
    request_id: &str,
    repo_id: &Option<String>,
    generation: &Option<String>,
    page: &crate::history::HistoryPage,
) -> Result<(), repository::PreviewError> {
    let chunks = pack_history_chunks(request_id, repo_id.as_deref(), generation.as_deref(), page)
        .map_err(|()| {
        repository::resource_limit("History page response exceeds the size limit")
    })?;
    let total = page.commits.len() as u32;
    let mut processed = 0_u32;
    for (index, commits) in chunks.iter().enumerate() {
        processed = processed.saturating_add(commits.len() as u32);
        let done = index + 1 == chunks.len();
        let message = ServerMessage::Response {
            request_id: request_id.to_owned(),
            repo_id: repo_id.clone(),
            generation: generation.clone(),
            sequence: index as u32 + 1,
            done,
            coverage: Coverage {
                complete: done,
                processed: if done { total } else { processed },
            },
            next_cursor: if done { page.next_cursor.clone() } else { None },
            data: ResponseData::HistoryPage {
                commits: commits.clone(),
                offset: page.offset,
                page_size: page.page_size,
                cursor: page.cursor.clone(),
                previous_cursor: page.previous_cursor.clone(),
                has_more: page.has_more,
                new_since_last_seen_status: page.new_since_last_seen_status,
                last_seen_divider_oid: page.last_seen_divider_oid.clone(),
            },
        };
        if !send_task_message(sender, shutdown, cancelled, &message) {
            return Err(repository::cancelled_error());
        }
    }
    Ok(())
}

fn ensure_metadata_index(
    manager: &crate::metadata_index::TaskManager,
    session: Arc<session::RepositorySession>,
    git_path: &std::path::Path,
    requests: &ActiveRequests,
) {
    let Ok(quota) = crate::metadata_index::configured_quota() else {
        return;
    };
    manager.ensure(
        session_store::SessionStore::from_env(),
        session,
        git_path.to_path_buf(),
        quota,
        Arc::clone(requests),
    );
}

#[allow(clippy::too_many_arguments)]
fn execute_search_commits(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    requests: &ActiveRequests,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    git_path: Option<&std::path::Path>,
    session: Arc<session::RepositorySession>,
    params: SearchCommitsParams,
    metadata_tasks: Arc<crate::metadata_index::TaskManager>,
    cancelled: Arc<AtomicBool>,
) {
    let cache_epoch = metadata_tasks.search_cache_epoch(&session);
    let result = crate::search::search_commits(
        git_path,
        &session_store::SessionStore::from_env(),
        &session,
        &params,
        cache_epoch,
        &cancelled,
        std::time::Instant::now() + PREVIEW_TIMEOUT,
    );
    let mut page = match result {
        Ok(page) => page,
        Err(error) => {
            send_search_failure(
                sender, shutdown, request_id, repo_id, generation, error, &cancelled,
            );
            remove_request(requests, request_id, &cancelled);
            return;
        }
    };
    if metadata_tasks.search_cache_epoch(&session) != cache_epoch {
        send_terminal_error(
            sender,
            shutdown,
            Some(request_id.to_owned()),
            repo_id,
            generation,
            ErrorCode::SnapshotChanged,
            "搜索缓存正在重建，请刷新搜索结果".into(),
            true,
        );
        remove_request(requests, request_id, &cancelled);
        return;
    }
    let current_index = metadata_tasks.status(
        &session_store::SessionStore::from_env(),
        &session,
        page.index.quota_bytes,
    );
    if let Some(error) = current_index.error.as_ref().filter(|error| {
        matches!(
            error.code,
            ErrorCode::IndexCorrupt
                | ErrorCode::IndexVersionUnsupported
                | ErrorCode::IndexUnavailable
        )
    }) {
        send_search_failure(
            sender,
            shutdown,
            request_id,
            repo_id,
            generation,
            crate::metadata_index::IndexError {
                code: error.code,
                message: error.message.clone(),
            },
            &cancelled,
        );
        remove_request(requests, request_id, &cancelled);
        return;
    }
    page.index = current_index;
    let chunks =
        match pack_search_page_chunks(request_id, repo_id.as_deref(), generation.as_deref(), &page)
        {
            Ok(chunks) => chunks,
            Err(()) => {
                send_terminal_error(
                    sender,
                    shutdown,
                    Some(request_id.to_owned()),
                    repo_id,
                    generation,
                    ErrorCode::ResourceLimit,
                    "搜索结果页超过单帧大小限制".into(),
                    false,
                );
                remove_request(requests, request_id, &cancelled);
                return;
            }
        };
    let total = page.commits.len() as u32;
    let mut processed = 0_u32;
    for (index, commits) in chunks.iter().enumerate() {
        if metadata_tasks.search_cache_epoch(&session) != cache_epoch {
            send_terminal_error(
                sender,
                shutdown,
                Some(request_id.to_owned()),
                repo_id,
                generation,
                ErrorCode::SnapshotChanged,
                "搜索缓存正在重建，请刷新搜索结果".into(),
                true,
            );
            remove_request(requests, request_id, &cancelled);
            return;
        }
        processed = processed.saturating_add(commits.len() as u32);
        let done = index + 1 == chunks.len();
        let message = search_page_response(
            request_id,
            repo_id.clone(),
            generation.clone(),
            index as u32,
            done,
            if done { total } else { processed },
            if done { page.next_cursor.clone() } else { None },
            &page,
            commits.clone(),
        );
        if !send_task_message(sender, shutdown, &cancelled, &message) {
            finish_cancelled(sender, shutdown, request_id, repo_id, generation);
            remove_request(requests, request_id, &cancelled);
            return;
        }
    }
    remove_request(requests, request_id, &cancelled);
}

#[allow(clippy::too_many_arguments)]
fn execute_search_identities(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    requests: &ActiveRequests,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    session: Arc<session::RepositorySession>,
    params: SearchIdentitiesParams,
    metadata_tasks: Arc<crate::metadata_index::TaskManager>,
    cancelled: Arc<AtomicBool>,
) {
    let cache_epoch = metadata_tasks.search_cache_epoch(&session);
    let result = crate::search::list_search_identities(
        &session_store::SessionStore::from_env(),
        &session,
        &params,
        cache_epoch,
        &cancelled,
        std::time::Instant::now() + PREVIEW_TIMEOUT,
    );
    let mut result = match result {
        Ok(result) => result,
        Err(error) => {
            send_search_failure(
                sender, shutdown, request_id, repo_id, generation, error, &cancelled,
            );
            remove_request(requests, request_id, &cancelled);
            return;
        }
    };
    if metadata_tasks.search_cache_epoch(&session) != cache_epoch {
        send_terminal_error(
            sender,
            shutdown,
            Some(request_id.to_owned()),
            repo_id,
            generation,
            ErrorCode::SnapshotChanged,
            "搜索缓存正在重建，请重试身份建议".into(),
            true,
        );
        remove_request(requests, request_id, &cancelled);
        return;
    }
    let current_index = metadata_tasks.status(
        &session_store::SessionStore::from_env(),
        &session,
        result.index.quota_bytes,
    );
    if let Some(error) = current_index.error.as_ref().filter(|error| {
        matches!(
            error.code,
            ErrorCode::IndexCorrupt
                | ErrorCode::IndexVersionUnsupported
                | ErrorCode::IndexUnavailable
        )
    }) {
        send_search_failure(
            sender,
            shutdown,
            request_id,
            repo_id,
            generation,
            crate::metadata_index::IndexError {
                code: error.code,
                message: error.message.clone(),
            },
            &cancelled,
        );
        remove_request(requests, request_id, &cancelled);
        return;
    }
    result.index = current_index;
    let message = ServerMessage::Response {
        request_id: request_id.to_owned(),
        repo_id: repo_id.clone(),
        generation: generation.clone(),
        sequence: 0,
        done: true,
        coverage: Coverage {
            complete: true,
            processed: result.identities.len() as u32,
        },
        next_cursor: None,
        data: ResponseData::SearchIdentities { result },
    };
    if serde_json::to_vec(&message).map_or(true, |bytes| bytes.len() > RESPONSE_TARGET_BYTES) {
        send_terminal_error(
            sender,
            shutdown,
            Some(request_id.to_owned()),
            repo_id,
            generation,
            ErrorCode::ResourceLimit,
            "身份建议响应超过大小限制".into(),
            false,
        );
    } else {
        if !send_task_message(sender, shutdown, &cancelled, &message) {
            finish_cancelled(sender, shutdown, request_id, repo_id, generation);
        }
    }
    remove_request(requests, request_id, &cancelled);
}

#[allow(clippy::too_many_arguments)]
fn execute_activity_stats(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    requests: &ActiveRequests,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    git_path: Option<&std::path::Path>,
    session: Arc<session::RepositorySession>,
    params: GetActivityStatsParams,
    metadata_tasks: Arc<crate::metadata_index::TaskManager>,
    cancelled: Arc<AtomicBool>,
) {
    let cache_epoch = metadata_tasks.search_cache_epoch(&session);
    let result = crate::search::activity_stats(
        git_path,
        &session_store::SessionStore::from_env(),
        &session,
        &params,
        cache_epoch,
        &cancelled,
        std::time::Instant::now() + PREVIEW_TIMEOUT,
    );
    let mut stats = match result {
        Ok(stats) => stats,
        Err(error) => {
            send_search_failure(
                sender, shutdown, request_id, repo_id, generation, error, &cancelled,
            );
            remove_request(requests, request_id, &cancelled);
            return;
        }
    };
    if metadata_tasks.search_cache_epoch(&session) != cache_epoch {
        send_terminal_error(
            sender,
            shutdown,
            Some(request_id.to_owned()),
            repo_id,
            generation,
            ErrorCode::SnapshotChanged,
            "元数据索引已重建，请重试活动统计".into(),
            true,
        );
        remove_request(requests, request_id, &cancelled);
        return;
    }
    let current_index = metadata_tasks.status(
        &session_store::SessionStore::from_env(),
        &session,
        stats.index.quota_bytes,
    );
    if let Some(error) = current_index.error.as_ref().filter(|error| {
        matches!(
            error.code,
            ErrorCode::IndexCorrupt
                | ErrorCode::IndexVersionUnsupported
                | ErrorCode::IndexUnavailable
        )
    }) {
        send_search_failure(
            sender,
            shutdown,
            request_id,
            repo_id,
            generation,
            crate::metadata_index::IndexError {
                code: error.code,
                message: error.message.clone(),
            },
            &cancelled,
        );
        remove_request(requests, request_id, &cancelled);
        return;
    }
    stats.index = current_index;
    let complete = stats.coverage.complete;
    let processed = stats.matched_count.min(u32::MAX as u64) as u32;
    let message = ServerMessage::Response {
        request_id: request_id.to_owned(),
        repo_id: repo_id.clone(),
        generation: generation.clone(),
        sequence: 0,
        done: true,
        coverage: Coverage {
            complete,
            processed,
        },
        next_cursor: None,
        data: ResponseData::ActivityStats { stats },
    };
    if serde_json::to_vec(&message).map_or(true, |bytes| bytes.len() > RESPONSE_TARGET_BYTES) {
        send_terminal_error(
            sender,
            shutdown,
            Some(request_id.to_owned()),
            repo_id,
            generation,
            ErrorCode::ResourceLimit,
            "活动统计响应超过大小限制".into(),
            false,
        );
    } else if !send_task_message(sender, shutdown, &cancelled, &message) {
        finish_cancelled(sender, shutdown, request_id, repo_id, generation);
    }
    remove_request(requests, request_id, &cancelled);
}

fn send_search_failure(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    error: crate::metadata_index::IndexError,
    cancelled: &AtomicBool,
) {
    if error.code == ErrorCode::Cancelled || cancelled.load(Ordering::Acquire) {
        finish_cancelled(sender, shutdown, request_id, repo_id, generation);
    } else {
        let retryable = matches!(error.code, ErrorCode::Busy | ErrorCode::Timeout);
        send_terminal_error(
            sender,
            shutdown,
            Some(request_id.to_owned()),
            repo_id,
            generation,
            error.code,
            error.message,
            retryable,
        );
    }
}

fn pack_search_page_chunks(
    request_id: &str,
    repo_id: Option<&str>,
    generation: Option<&str>,
    page: &SearchPage,
) -> Result<Vec<Vec<commitscope_core::CommitSummary>>, ()> {
    if page.commits.is_empty() {
        let candidate = search_page_response(
            request_id,
            repo_id.map(str::to_owned),
            generation.map(str::to_owned),
            1,
            true,
            0,
            page.next_cursor.clone(),
            page,
            Vec::new(),
        );
        return (serde_json::to_vec(&candidate).map_err(|_| ())?.len() <= RESPONSE_TARGET_BYTES)
            .then_some(vec![Vec::new()])
            .ok_or(());
    }
    let mut chunks = Vec::<Vec<commitscope_core::CommitSummary>>::new();
    let mut current = Vec::new();
    for commit in &page.commits {
        current.push(commit.clone());
        let candidate = search_page_response(
            request_id,
            repo_id.map(str::to_owned),
            generation.map(str::to_owned),
            1,
            true,
            page.commits.len() as u32,
            page.next_cursor.clone(),
            page,
            current.clone(),
        );
        if serde_json::to_vec(&candidate).map_err(|_| ())?.len() > RESPONSE_TARGET_BYTES {
            let last = current.pop().ok_or(())?;
            if current.is_empty() {
                return Err(());
            }
            chunks.push(std::mem::take(&mut current));
            current.push(last);
            let single = search_page_response(
                request_id,
                repo_id.map(str::to_owned),
                generation.map(str::to_owned),
                1,
                true,
                page.commits.len() as u32,
                page.next_cursor.clone(),
                page,
                current.clone(),
            );
            if serde_json::to_vec(&single).map_err(|_| ())?.len() > RESPONSE_TARGET_BYTES {
                return Err(());
            }
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    Ok(chunks)
}

#[allow(clippy::too_many_arguments)]
fn search_page_response(
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    sequence: u32,
    done: bool,
    processed: u32,
    next_cursor: Option<String>,
    page: &SearchPage,
    commits: Vec<commitscope_core::CommitSummary>,
) -> ServerMessage {
    let mut page = page.clone();
    let chunk_oids = commits
        .iter()
        .map(|commit| commit.oid.as_str())
        .collect::<std::collections::HashSet<_>>();
    page.path_matches
        .retain(|path_match| chunk_oids.contains(path_match.oid.as_str()));
    page.commits = commits;
    ServerMessage::Response {
        request_id: request_id.to_owned(),
        repo_id,
        generation,
        sequence,
        done,
        coverage: Coverage {
            complete: done,
            processed,
        },
        next_cursor,
        data: ResponseData::SearchPage { page },
    }
}

fn pack_history_chunks(
    request_id: &str,
    repo_id: Option<&str>,
    generation: Option<&str>,
    page: &crate::history::HistoryPage,
) -> Result<Vec<Vec<commitscope_core::HistoryCommit>>, ()> {
    if page.commits.is_empty() {
        return Ok(vec![Vec::new()]);
    }
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    for commit in &page.commits {
        current.push(commit.clone());
        let candidate = ServerMessage::Response {
            request_id: request_id.to_owned(),
            repo_id: repo_id.map(str::to_owned),
            generation: generation.map(str::to_owned),
            sequence: u32::MAX,
            done: true,
            coverage: Coverage {
                complete: true,
                processed: page.commits.len() as u32,
            },
            next_cursor: page.next_cursor.clone(),
            data: ResponseData::HistoryPage {
                commits: current.clone(),
                offset: page.offset,
                page_size: page.page_size,
                cursor: page.cursor.clone(),
                previous_cursor: page.previous_cursor.clone(),
                has_more: page.has_more,
                new_since_last_seen_status: page.new_since_last_seen_status,
                last_seen_divider_oid: page.last_seen_divider_oid.clone(),
            },
        };
        if current.len() > COMMIT_CHUNK_SIZE
            || serde_json::to_vec(&candidate).map_err(|_| ())?.len() > RESPONSE_TARGET_BYTES
        {
            let last = current.pop().ok_or(())?;
            if current.is_empty() {
                return Err(());
            }
            chunks.push(std::mem::take(&mut current));
            current.push(last);
        }
        if current.len() == 1 {
            let single = ServerMessage::Response {
                request_id: request_id.to_owned(),
                repo_id: repo_id.map(str::to_owned),
                generation: generation.map(str::to_owned),
                sequence: u32::MAX,
                done: true,
                coverage: Coverage {
                    complete: true,
                    processed: page.commits.len() as u32,
                },
                next_cursor: page.next_cursor.clone(),
                data: ResponseData::HistoryPage {
                    commits: current.clone(),
                    offset: page.offset,
                    page_size: page.page_size,
                    cursor: page.cursor.clone(),
                    previous_cursor: page.previous_cursor.clone(),
                    has_more: page.has_more,
                    new_since_last_seen_status: page.new_since_last_seen_status,
                    last_seen_divider_oid: page.last_seen_divider_oid.clone(),
                },
            };
            if serde_json::to_vec(&single).map_err(|_| ())?.len() > RESPONSE_TARGET_BYTES {
                return Err(());
            }
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    Ok(chunks)
}

#[allow(clippy::too_many_arguments)]
fn finish_preview_tail(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    requests: &ActiveRequests,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    mut sequence: u32,
    cancelled: Arc<AtomicBool>,
    result: Result<repository::PreviewTail, repository::PreviewError>,
) {
    let tail = match result {
        Ok(tail) => tail,
        Err(error) => {
            if error.code == ErrorCode::Cancelled || cancelled.load(Ordering::Acquire) {
                finish_cancelled(sender, shutdown, request_id, repo_id, generation);
            } else {
                send_terminal_error(
                    sender,
                    shutdown,
                    Some(request_id.to_owned()),
                    repo_id,
                    generation,
                    error.code,
                    error.message,
                    error.retryable,
                );
            }
            remove_request(requests, request_id, &cancelled);
            return;
        }
    };

    let total = tail.commits.len();
    let has_more = tail.has_more;
    if total == 0 {
        let message = ServerMessage::Response {
            request_id: request_id.to_owned(),
            repo_id: repo_id.clone(),
            generation: generation.clone(),
            sequence,
            done: true,
            coverage: Coverage {
                complete: true,
                processed: 0,
            },
            next_cursor: None,
            data: ResponseData::Commits {
                commits: Vec::new(),
                has_more,
            },
        };
        if !send_task_message(sender, shutdown, &cancelled, &message)
            && cancelled.load(Ordering::Acquire)
        {
            finish_cancelled(sender, shutdown, request_id, repo_id, generation);
        }
        remove_request(requests, request_id, &cancelled);
        return;
    }

    let chunks = match pack_commit_chunks(
        request_id,
        repo_id.as_deref(),
        generation.as_deref(),
        sequence,
        &tail.commits,
        has_more,
    ) {
        Ok(chunks) => chunks,
        Err(()) => {
            send_terminal_error(
                sender,
                shutdown,
                Some(request_id.to_owned()),
                repo_id,
                generation,
                ErrorCode::ResourceLimit,
                "单条提交记录超过响应大小限制".into(),
                false,
            );
            remove_request(requests, request_id, &cancelled);
            return;
        }
    };
    let chunk_count = chunks.len();
    let mut processed = 0_u32;
    for (index, commits) in chunks.iter().enumerate() {
        if cancelled.load(Ordering::Acquire) {
            finish_cancelled(
                sender,
                shutdown,
                request_id,
                repo_id.clone(),
                generation.clone(),
            );
            remove_request(requests, request_id, &cancelled);
            return;
        }
        processed += commits.len() as u32;
        let done = index + 1 == chunk_count;
        let message = ServerMessage::Response {
            request_id: request_id.to_owned(),
            repo_id: repo_id.clone(),
            generation: generation.clone(),
            sequence,
            done,
            coverage: Coverage {
                complete: done,
                processed,
            },
            next_cursor: None,
            data: ResponseData::Commits {
                commits: commits.clone(),
                has_more,
            },
        };
        if !send_task_message(sender, shutdown, &cancelled, &message) {
            if cancelled.load(Ordering::Acquire) {
                finish_cancelled(
                    sender,
                    shutdown,
                    request_id,
                    repo_id.clone(),
                    generation.clone(),
                );
            }
            remove_request(requests, request_id, &cancelled);
            return;
        }
        sequence += 1;
    }
    remove_request(requests, request_id, &cancelled);
}

fn repository_response(
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
    sequence: u32,
    repository: commitscope_core::RepositoryInfo,
    refs: Vec<commitscope_core::RefInfo>,
    refs_truncated: bool,
) -> ServerMessage {
    ServerMessage::Response {
        request_id: request_id.to_owned(),
        repo_id,
        generation,
        sequence,
        done: false,
        coverage: Coverage {
            complete: false,
            processed: 0,
        },
        next_cursor: None,
        data: ResponseData::Repository {
            repository,
            refs,
            refs_truncated,
        },
    }
}

fn bounded_repository_response(
    request_id: &str,
    repo_id: Option<&str>,
    generation: Option<&str>,
    sequence: u32,
    repository: commitscope_core::RepositoryInfo,
    refs: Vec<commitscope_core::RefInfo>,
    refs_truncated: bool,
) -> Result<ServerMessage, repository::PreviewError> {
    let mut selected_refs = Vec::with_capacity(refs.len());
    let empty = repository_response(
        request_id,
        repo_id.map(str::to_owned),
        generation.map(str::to_owned),
        sequence,
        repository.clone(),
        Vec::new(),
        false,
    );
    let base_size = serde_json::to_vec(&empty)
        .map_err(|_| repository::PreviewError {
            code: ErrorCode::GitError,
            message: "无法编码仓库预览响应".into(),
            retryable: false,
        })?
        .len();
    let mut ref_bytes = 0usize;
    let mut output_refs_truncated = refs_truncated;
    for reference in refs {
        let item_size = serde_json::to_vec(&reference)
            .map_err(|_| repository::PreviewError {
                code: ErrorCode::GitError,
                message: "无法编码仓库引用".into(),
                retryable: false,
            })?
            .len();
        let candidate = base_size
            .saturating_add(ref_bytes)
            .saturating_add(item_size)
            .saturating_add(selected_refs.len());
        if candidate > RESPONSE_TARGET_BYTES {
            output_refs_truncated = true;
            break;
        }
        ref_bytes += item_size;
        selected_refs.push(reference);
    }
    let message = repository_response(
        request_id,
        repo_id.map(str::to_owned),
        generation.map(str::to_owned),
        sequence,
        repository,
        selected_refs,
        output_refs_truncated,
    );
    if serde_json::to_vec(&message).map_or(true, |bytes| bytes.len() > RESPONSE_TARGET_BYTES) {
        return Err(repository::PreviewError {
            code: ErrorCode::ResourceLimit,
            message: "仓库元数据响应超过大小限制".into(),
            retryable: false,
        });
    }
    Ok(message)
}

fn pack_commit_chunks(
    request_id: &str,
    repo_id: Option<&str>,
    generation: Option<&str>,
    sequence: u32,
    commits: &[commitscope_core::CommitSummary],
    has_more: bool,
) -> Result<Vec<Vec<commitscope_core::CommitSummary>>, ()> {
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    for commit in commits {
        current.push(commit.clone());
        let message = ServerMessage::Response {
            request_id: request_id.to_owned(),
            repo_id: repo_id.map(str::to_owned),
            generation: generation.map(str::to_owned),
            sequence,
            done: false,
            coverage: Coverage {
                complete: false,
                processed: 0,
            },
            next_cursor: None,
            data: ResponseData::Commits {
                commits: current.clone(),
                has_more,
            },
        };
        let size = serde_json::to_vec(&message).map_err(|_| ())?.len();
        if current.len() > COMMIT_CHUNK_SIZE || size > RESPONSE_TARGET_BYTES {
            let last = current.pop().ok_or(())?;
            if current.is_empty() {
                return Err(());
            }
            chunks.push(std::mem::take(&mut current));
            current.push(last);
            let single = ServerMessage::Response {
                request_id: request_id.to_owned(),
                repo_id: repo_id.map(str::to_owned),
                generation: generation.map(str::to_owned),
                sequence,
                done: false,
                coverage: Coverage {
                    complete: false,
                    processed: 0,
                },
                next_cursor: None,
                data: ResponseData::Commits {
                    commits: current.clone(),
                    has_more,
                },
            };
            if serde_json::to_vec(&single).map_err(|_| ())?.len() > RESPONSE_TARGET_BYTES {
                return Err(());
            }
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    Ok(chunks)
}

fn finish_cancelled(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    request_id: &str,
    repo_id: Option<String>,
    generation: Option<String>,
) {
    send_terminal_error(
        sender,
        shutdown,
        Some(request_id.to_owned()),
        repo_id,
        generation,
        ErrorCode::Cancelled,
        "请求已取消".into(),
        false,
    );
}

fn remove_request(requests: &ActiveRequests, request_id: &str, cancelled: &Arc<AtomicBool>) {
    let mut requests = requests.lock().expect("request map poisoned");
    if requests
        .get(request_id)
        .is_some_and(|current| Arc::ptr_eq(&current.cancelled, cancelled))
    {
        requests.remove(request_id);
    }
}

fn send_task_message(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    cancelled: &AtomicBool,
    message: &ServerMessage,
) -> bool {
    let Ok(mut bytes) = serde_json::to_vec(message) else {
        return false;
    };
    bytes.push(b'\n');
    loop {
        if shutdown.load(Ordering::Acquire) || cancelled.load(Ordering::Acquire) {
            return false;
        }
        match sender.try_send(OutFrame {
            bytes,
            flushed: None,
        }) {
            Ok(()) => return true,
            Err(TrySendError::Disconnected(_)) => return false,
            Err(TrySendError::Full(returned)) => {
                bytes = returned.bytes;
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

fn send_message(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    message: &ServerMessage,
) -> bool {
    let Ok(mut bytes) = serde_json::to_vec(message) else {
        return false;
    };
    bytes.push(b'\n');
    if shutdown.load(Ordering::Acquire) {
        return false;
    }
    // Main-thread writes never wait on a full queue: a saturated client connection is closed.
    sender
        .try_send(OutFrame {
            bytes,
            flushed: None,
        })
        .is_ok()
}

fn send_main_message(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    message: &ServerMessage,
) {
    if !send_message(sender, shutdown, message) {
        shutdown.store(true, Ordering::Release);
    }
}

#[allow(clippy::too_many_arguments)]
fn send_error(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    request_id: Option<String>,
    repo_id: Option<String>,
    generation: Option<String>,
    code: ErrorCode,
    message: String,
    retryable: bool,
) {
    if !send_message(
        sender,
        shutdown,
        &ServerMessage::Error {
            request_id,
            repo_id,
            generation,
            code,
            message,
            retryable,
        },
    ) {
        shutdown.store(true, Ordering::Release);
    }
}

#[allow(clippy::too_many_arguments)]
fn send_terminal_error(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    request_id: Option<String>,
    repo_id: Option<String>,
    generation: Option<String>,
    code: ErrorCode,
    message: String,
    retryable: bool,
) {
    let _ = send_terminal_message(
        sender,
        shutdown,
        &ServerMessage::Error {
            request_id,
            repo_id,
            generation,
            code,
            message,
            retryable,
        },
    );
}

fn send_terminal_message(
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
    message: &ServerMessage,
) -> bool {
    let Ok(mut bytes) = serde_json::to_vec(message) else {
        return false;
    };
    bytes.push(b'\n');
    let (ack_tx, ack_rx) = mpsc::sync_channel(1);
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    loop {
        if shutdown.load(Ordering::Acquire) || std::time::Instant::now() >= deadline {
            return false;
        }
        match sender.try_send(OutFrame {
            bytes,
            flushed: Some(ack_tx.clone()),
        }) {
            Ok(()) => return matches!(ack_rx.recv_timeout(Duration::from_secs(1)), Ok(true)),
            Err(TrySendError::Disconnected(_)) => return false,
            Err(TrySendError::Full(returned)) => {
                bytes = returned.bytes;
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

fn reap_finished_workers(workers: &mut Vec<JoinHandle<()>>) {
    let mut index = 0;
    while index < workers.len() {
        if workers[index].is_finished() {
            let worker = workers.swap_remove(index);
            let _ = worker.join();
        } else {
            index += 1;
        }
    }
}

#[cfg(test)]
mod search_response_tests {
    use super::*;
    use commitscope_core::{
        CommitIdentity, CommitSummary, MetadataIndexCoverage, MetadataIndexState,
        MetadataIndexStatus,
    };

    #[test]
    fn search_page_chunks_preserve_metadata_and_cumulative_envelope_coverage() {
        let page = SearchPage {
            query_key: "q".repeat(64),
            snapshot_key: "s".repeat(64),
            result_version: "v".repeat(64),
            commits: (0..40)
                .map(|index| CommitSummary {
                    oid: format!("{index:040x}"),
                    parents: Vec::new(),
                    summary: "x".repeat(20 * 1024),
                    summary_truncated: false,
                    author: CommitIdentity {
                        name: "Author".into(),
                        email: "author@example.test".into(),
                        timestamp: "1".into(),
                        offset: "+0000".into(),
                    },
                    committer: CommitIdentity {
                        name: "Committer".into(),
                        email: "committer@example.test".into(),
                        timestamp: "2".into(),
                        offset: "+0000".into(),
                    },
                    text_lossy: false,
                })
                .collect(),
            page_offset: 10,
            previous_cursor: Some("previous".into()),
            next_cursor: Some("next".into()),
            matched_count: 100,
            coverage: MetadataIndexCoverage {
                processed: 200,
                complete: false,
            },
            anchor_found: None,
            index: MetadataIndexStatus {
                snapshot_key: Some("s".repeat(64)),
                state: MetadataIndexState::Running,
                coverage: MetadataIndexCoverage {
                    processed: 200,
                    complete: false,
                },
                disk_bytes: 1024,
                quota_bytes: 4096,
                error: None,
            },
            path_matches: Vec::new(),
        };
        let chunks =
            pack_search_page_chunks("request", Some("repo"), Some("generation"), &page).unwrap();
        assert!(chunks.len() > 1);

        let mut processed = 0_u32;
        for (index, commits) in chunks.iter().enumerate() {
            processed += commits.len() as u32;
            let done = index + 1 == chunks.len();
            let message = search_page_response(
                "request",
                Some("repo".into()),
                Some("generation".into()),
                index as u32,
                done,
                processed,
                if done { page.next_cursor.clone() } else { None },
                &page,
                commits.clone(),
            );
            let encoded = serde_json::to_vec(&message).unwrap();
            assert!(encoded.len() <= RESPONSE_TARGET_BYTES);
            let ServerMessage::Response {
                sequence,
                coverage,
                next_cursor,
                done: actual_done,
                data: ResponseData::SearchPage { page: actual_page },
                ..
            } = message
            else {
                panic!("unexpected response variant");
            };
            assert_eq!(actual_done, done);
            assert_eq!(sequence, index as u32);
            assert_eq!(coverage.complete, done);
            assert_eq!(coverage.processed, processed);
            assert_eq!(
                next_cursor,
                if done { page.next_cursor.clone() } else { None }
            );
            assert_eq!(actual_page.query_key, page.query_key);
            assert_eq!(actual_page.result_version, page.result_version);
            assert_eq!(actual_page.page_offset, page.page_offset);
            assert_eq!(actual_page.matched_count, page.matched_count);
            assert_eq!(actual_page.coverage, page.coverage);
            assert_eq!(actual_page.next_cursor, page.next_cursor);
            assert_eq!(actual_page.commits.len(), commits.len());
        }
        assert_eq!(processed, page.commits.len() as u32);
    }
}
