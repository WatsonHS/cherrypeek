use crate::{framing, repository, runtime, session, session_store};
use commitscope_core::{
    ClientMessage, CoreReady, Coverage, EmptyParams, ErrorCode, OpenRepositoryParams,
    PROTOCOL_VERSION, ReadHistoryPageParams, ReadRepositoryPreviewParams, RefreshRepositoryParams,
    ResponseData, ServerMessage,
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

type ActiveRequests = Arc<Mutex<HashMap<String, ActiveRequest>>>;

struct ActiveRequest {
    cancelled: Arc<AtomicBool>,
    repo_id: Option<String>,
}

#[derive(Debug)]
enum RequestOperation {
    RuntimeInfo,
    RepositoryPreview(String),
    OpenRepository(String),
    GetRepositorySession,
    ReadSessionPreview,
    ReadHistoryPage(ReadHistoryPageParams),
    RefreshRepository(RefreshRepositoryParams),
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
        result: Result<PreparedRefresh, repository::PreviewError>,
    },
}

struct PreparedRefresh {
    discovered: Arc<repository::DiscoveredRepository>,
    history: Arc<crate::history::HistoryState>,
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
                drain_open_completions(&open_done_rx, &mut sessions, &requests, &out_tx, &shutdown);
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

                        let mut active = requests.lock().expect("request map poisoned");
                        if active.len() >= MAX_ACTIVE_REQUESTS {
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
                            );
                            continue;
                        }
                        let cancelled = Arc::new(AtomicBool::new(false));
                        active.insert(
                            request_id.clone(),
                            ActiveRequest {
                                cancelled: Arc::clone(&cancelled),
                                repo_id: repo_id.clone(),
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
        drain_open_completions(&open_done_rx, &mut sessions, &requests, &out_tx, &shutdown);
    }

    shutdown.store(true, Ordering::Release);
    sessions.cancel_pending_opens();
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
            | RequestOperation::RefreshRepository(_)
            | RequestOperation::RecordRepositoryView
            | RequestOperation::CloseRepository
    )
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
                )
            }));
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
            let intent = sessions.begin_open(Arc::clone(&cancelled));
            let open_done = open_done.clone();
            let request_id_for_worker = request_id.clone();
            let cancelled_for_worker = Arc::clone(&cancelled);
            let expected_repo_id = session.info.repo_id.clone();
            let expected_generation = session.info.generation.clone();
            let path = session.info.repository.path.clone();
            workers.push(thread::spawn(move || {
                let deadline = std::time::Instant::now() + PREVIEW_TIMEOUT;
                let result = repository::discover_repository(
                    &git_path,
                    &path,
                    &cancelled_for_worker,
                    deadline,
                )
                .and_then(|discovered| {
                    let discovered = Arc::new(discovered);
                    let history = Arc::new(crate::history::HistoryState::new());
                    let page = history.read_page(
                        &git_path,
                        &discovered,
                        None,
                        params.page_size,
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
                        page,
                    })
                });
                let _ = open_done.send(OpenCompletion {
                    request_id: request_id_for_worker,
                    intent,
                    cancelled: cancelled_for_worker,
                    payload: OpenCompletionPayload::Refresh {
                        expected_repo_id,
                        expected_generation,
                        result,
                    },
                });
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

fn cancel_repository_requests(requests: &ActiveRequests, repo_id: &str) {
    for request in requests.lock().expect("request map poisoned").values() {
        if request.repo_id.as_deref() == Some(repo_id) {
            request.cancelled.store(true, Ordering::Release);
        }
    }
}

fn drain_open_completions(
    receiver: &Receiver<OpenCompletion>,
    sessions: &mut session::SessionManager,
    requests: &ActiveRequests,
    sender: &SyncSender<OutFrame>,
    shutdown: &AtomicBool,
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
                result: Ok(prepared),
            } => {
                let commit = sessions.commit_refresh(
                    intent,
                    &expected_repo_id,
                    &expected_generation,
                    &cancelled,
                    Arc::clone(&prepared.discovered),
                    Arc::clone(&prepared.history),
                );
                match commit {
                    Ok(commit) => {
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
        | "refreshRepository"
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
                _ => serde_json::from_value::<EmptyParams>(params.clone())
                    .map(|_| match method {
                        "getRepositorySession" => RequestOperation::GetRepositorySession,
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
        | "refreshRepository"
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
    let result = session.history.with_page(
        git_path,
        &session.discovered,
        params.cursor.as_deref(),
        params.page_size,
        &cancelled,
        deadline,
        |page| {
            let chunks =
                pack_history_chunks(request_id, repo_id.as_deref(), generation.as_deref(), page)
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
                    },
                };
                if !send_task_message(sender, shutdown, &cancelled, &message) {
                    return Err(repository::cancelled_error());
                }
            }
            Ok(())
        },
    );
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
}

fn pack_history_chunks(
    request_id: &str,
    repo_id: Option<&str>,
    generation: Option<&str>,
    page: &crate::history::HistoryPage,
) -> Result<Vec<Vec<commitscope_core::CommitSummary>>, ()> {
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
