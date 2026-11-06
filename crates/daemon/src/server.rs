use crate::{framing, repository, runtime};
use commitscope_core::{
    ClientMessage, CoreReady, Coverage, EmptyParams, ErrorCode, PROTOCOL_VERSION,
    ReadRepositoryPreviewParams, ResponseData, ServerMessage,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{self, BufReader, Write},
    process,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender, TrySendError},
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

type ActiveRequests = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

#[derive(Debug)]
enum RequestOperation {
    RuntimeInfo,
    RepositoryPreview(String),
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
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
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
                            continue;
                        }
                        let cancelled = Arc::new(AtomicBool::new(false));
                        active.insert(request_id.clone(), Arc::clone(&cancelled));
                        drop(active);

                        let request_map = Arc::clone(&requests);
                        let sender = out_tx.clone();
                        let stopping = Arc::clone(&shutdown);
                        let git_path = git_path.clone();
                        workers.push(thread::spawn(move || match operation {
                            RequestOperation::RuntimeInfo => execute_runtime_info(
                                &sender,
                                &stopping,
                                &request_map,
                                &request_id,
                                repo_id,
                                generation,
                                git_path.as_deref(),
                                cancelled,
                            ),
                            RequestOperation::RepositoryPreview(path) => {
                                execute_repository_preview(
                                    &sender,
                                    &stopping,
                                    &request_map,
                                    &request_id,
                                    repo_id,
                                    generation,
                                    git_path.as_deref(),
                                    &path,
                                    cancelled,
                                )
                            }
                        }));
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
                        cancelled.store(true, Ordering::Release);
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
    }

    shutdown.store(true, Ordering::Release);
    for cancelled in requests.lock().expect("request map poisoned").values() {
        cancelled.store(true, Ordering::Release);
    }
    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
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
    if repo_id.is_some_and(|id| id.is_empty() || id.chars().count() > MAX_OPAQUE_ID_BYTES)
        || generation.is_some_and(|id| id.is_empty() || id.chars().count() > MAX_OPAQUE_ID_BYTES)
    {
        return Err((ErrorCode::InvalidRequest, "仓库上下文标识长度无效".into()));
    }
    if repo_id.is_some() || generation.is_some() {
        return Err((ErrorCode::InvalidRequest, "本项请求不接受仓库上下文".into()));
    }
    match method {
        "getRuntimeInfo" => serde_json::from_value::<EmptyParams>(params.clone())
            .map(|_| RequestOperation::RuntimeInfo)
            .map_err(|_| {
                (
                    ErrorCode::InvalidRequest,
                    "getRuntimeInfo params 必须为空对象".into(),
                )
            }),
        "readRepositoryPreview" => {
            serde_json::from_value::<ReadRepositoryPreviewParams>(params.clone())
                .map(|params| RequestOperation::RepositoryPreview(params.path))
                .map_err(|_| {
                    (
                        ErrorCode::InvalidRequest,
                        "readRepositoryPreview params 必须包含绝对目录 path".into(),
                    )
                })
        }
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
            let mut selected_refs = Vec::with_capacity(refs.len());
            let base = repository_response(
                request_id,
                repo_id.clone(),
                generation.clone(),
                sequence,
                repository.clone(),
                Vec::new(),
                false,
            );
            let base_size = serde_json::to_vec(&base)
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
                repo_id.clone(),
                generation.clone(),
                sequence,
                repository,
                selected_refs,
                output_refs_truncated,
            );
            if serde_json::to_vec(&message)
                .map_or(true, |bytes| bytes.len() > RESPONSE_TARGET_BYTES)
            {
                return Err(repository::PreviewError {
                    code: ErrorCode::ResourceLimit,
                    message: "仓库元数据响应超过大小限制".into(),
                    retryable: false,
                });
            }
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
            repo_id,
            generation,
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
            finish_cancelled(sender, shutdown, request_id, None, None);
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
        .is_some_and(|current| Arc::ptr_eq(current, cancelled))
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
