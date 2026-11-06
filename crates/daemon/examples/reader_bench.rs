#[path = "../src/git_command.rs"]
#[allow(dead_code)]
mod git_command;
#[path = "reader_bench/mod.rs"]
mod reader_bench;

use reader_bench::{BenchError, execute};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, BufRead, BufReader, Write},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

const MAX_INPUT_LINE: usize = 64 * 1024;
const RESULT_EXIT_GRACE: Duration = Duration::from_secs(2);
const JOB_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Backend {
    Cli,
    Gix,
}

impl Backend {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Gix => "gix",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Page,
    Objects,
    Scan,
}

impl Operation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Page => "page",
            Self::Objects => "objects",
            Self::Scan => "scan",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    backend: Backend,
    operation: Operation,
    repository: String,
    git_executable: String,
    head_oid: String,
    offset: u32,
    limit: u16,
    oids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Control {
    event: String,
}

#[derive(Debug)]
enum InputEvent {
    Job(Result<Job, BenchError>),
    Exit,
    Eof,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Ready {
    event: &'static str,
    protocol_version: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    event: &'static str,
    backend: &'static str,
    operation: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchResult {
    event: &'static str,
    backend: String,
    operation: String,
    status: &'static str,
    error_code: Option<String>,
    message: Option<String>,
    open_ms: f64,
    walk_ms: f64,
    objects_ms: f64,
    total_ms: f64,
    visited_count: u64,
    oids: Vec<String>,
    has_more: bool,
    raw_bytes: u64,
    objects_digest: Option<String>,
    completed_scans: Option<u32>,
    gix_object_cache_bytes: Option<u64>,
    gix_pack_cache_bytes: Option<u64>,
    gix_features: Option<&'static str>,
    cpu_self_ms: Option<f64>,
    cpu_children_ms: Option<f64>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("reader_bench: {}", bounded_message(&error.to_string()));
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let (input_tx, input_rx) = mpsc::sync_channel(4);
    start_input_reader(input_tx, Arc::clone(&cancelled));
    write_json_line(&Ready {
        event: "ready",
        protocol_version: 1,
    })?;

    let job = match input_rx.recv() {
        Ok(InputEvent::Job(Ok(job))) => job,
        Ok(InputEvent::Job(Err(error))) => {
            write_json_line(&invalid_job_result(error))?;
            wait_for_exit(&input_rx);
            return Ok(());
        }
        Ok(InputEvent::Eof) | Err(_) => return Ok(()),
        Ok(InputEvent::Exit) => return Ok(()),
    };

    write_json_line(&Started {
        event: "started",
        backend: job.backend.as_str(),
        operation: job.operation.as_str(),
    })?;

    let start = Instant::now();
    let deadline = start + JOB_TIMEOUT;
    let cpu_before = CpuSnapshot::read();
    let (outcome, error) = execute(&job, &cancelled, deadline);
    let total_ms = elapsed_ms(start);
    let cpu_after = CpuSnapshot::read();
    let (status, error_code, message) = match error {
        Some(error) if error.code == "CANCELLED" => {
            ("cancelled", Some(error.code), Some(error.message))
        }
        Some(error) => ("error", Some(error.code), Some(error.message)),
        None => ("ok", None, None),
    };
    let result = BenchResult {
        event: "result",
        backend: job.backend.as_str().to_owned(),
        operation: job.operation.as_str().to_owned(),
        status,
        error_code,
        message,
        open_ms: outcome.open_ms,
        walk_ms: outcome.walk_ms,
        objects_ms: outcome.objects_ms,
        total_ms,
        visited_count: outcome.visited_count,
        oids: outcome.oids,
        has_more: outcome.has_more,
        raw_bytes: outcome.raw_bytes,
        objects_digest: outcome.objects_digest,
        completed_scans: outcome.completed_scans,
        gix_object_cache_bytes: matches!(job.backend, Backend::Gix).then_some(8 * 1024 * 1024),
        gix_pack_cache_bytes: matches!(job.backend, Backend::Gix).then_some(8 * 1024 * 1024),
        gix_features: matches!(job.backend, Backend::Gix).then_some("sha1,sha256,max-performance"),
        cpu_self_ms: CpuSnapshot::difference(cpu_before.self_ms, cpu_after.self_ms),
        cpu_children_ms: CpuSnapshot::difference(cpu_before.children_ms, cpu_after.children_ms),
    };
    write_json_line(&result)?;
    wait_for_exit(&input_rx);
    Ok(())
}

fn start_input_reader(sender: SyncSender<InputEvent>, cancelled: Arc<AtomicBool>) {
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = BufReader::new(stdin.lock());
        let first = match read_bounded_line(&mut input, MAX_INPUT_LINE) {
            Ok(Some(line)) => line,
            Ok(None) => {
                let _ = sender.send(InputEvent::Eof);
                return;
            }
            Err(error) => {
                let _ = sender.send(InputEvent::Job(Err(error)));
                return;
            }
        };
        let parsed = serde_json::from_slice::<Job>(&first)
            .map_err(|error| BenchError::new("INVALID_JOB", format!("Invalid job JSON: {error}")))
            .and_then(validate_job);
        if sender.send(InputEvent::Job(parsed)).is_err() {
            return;
        }

        loop {
            match read_bounded_line(&mut input, MAX_INPUT_LINE) {
                Ok(Some(line)) => match parse_control(&line) {
                    Some(ControlEvent::Cancel) => cancelled.store(true, Ordering::Release),
                    Some(ControlEvent::Exit) => {
                        let _ = sender.try_send(InputEvent::Exit);
                        return;
                    }
                    None => {}
                },
                Ok(None) => {
                    cancelled.store(true, Ordering::Release);
                    let _ = sender.send(InputEvent::Eof);
                    return;
                }
                Err(_) => {
                    cancelled.store(true, Ordering::Release);
                    let _ = sender.send(InputEvent::Eof);
                    return;
                }
            }
        }
    });
}

enum ControlEvent {
    Cancel,
    Exit,
}

fn parse_control(line: &[u8]) -> Option<ControlEvent> {
    match line {
        b"cancel" => return Some(ControlEvent::Cancel),
        b"exit" => return Some(ControlEvent::Exit),
        _ => {}
    }
    let event = serde_json::from_slice::<Control>(line).ok()?.event;
    match event.as_str() {
        "cancel" => Some(ControlEvent::Cancel),
        "exit" => Some(ControlEvent::Exit),
        _ => None,
    }
}

fn read_bounded_line(
    reader: &mut impl BufRead,
    limit: usize,
) -> Result<Option<Vec<u8>>, BenchError> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|error| {
            BenchError::new("INPUT_ERROR", format!("stdin read failed: {error}"))
        })?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            return Err(BenchError::new(
                "INVALID_JOB",
                "Input line ended without newline",
            ));
        }
        let length = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |i| i + 1);
        if line.len().saturating_add(length) > limit + 1 {
            return Err(BenchError::new("INVALID_JOB", "Input line exceeds 64 KiB"));
        }
        let terminated = available.get(length - 1) == Some(&b'\n');
        let payload_length = length - usize::from(terminated);
        line.extend_from_slice(&available[..payload_length]);
        reader.consume(length);
        if terminated {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

fn validate_job(job: Job) -> Result<Job, BenchError> {
    let repository = PathBuf::from(&job.repository);
    let executable = PathBuf::from(&job.git_executable);
    if job.repository.contains('\0') || job.git_executable.contains('\0') {
        return Err(BenchError::new(
            "INVALID_JOB",
            "Paths must not contain NUL bytes",
        ));
    }
    if !repository.is_absolute() || !executable.is_absolute() {
        return Err(BenchError::new(
            "INVALID_JOB",
            "Repository and Git executable paths must be absolute",
        ));
    }
    if job.offset > 100_000 || !(1..=200).contains(&job.limit) {
        return Err(BenchError::new(
            "INVALID_JOB",
            "offset or limit is outside the allowed range",
        ));
    }
    validate_oid(&job.head_oid)?;
    if job.oids.len() > 200 {
        return Err(BenchError::new(
            "INVALID_JOB",
            "At most 200 object IDs are accepted",
        ));
    }
    for oid in &job.oids {
        validate_oid(oid)?;
        if oid.len() != job.head_oid.len() {
            return Err(BenchError::new(
                "INVALID_JOB",
                "All object IDs must use the same hash format",
            ));
        }
    }
    match job.operation {
        Operation::Objects if job.oids.is_empty() => {
            return Err(BenchError::new(
                "INVALID_JOB",
                "objects requires at least one OID",
            ));
        }
        Operation::Page | Operation::Scan if !job.oids.is_empty() => {
            return Err(BenchError::new(
                "INVALID_JOB",
                "oids must be empty for page and scan",
            ));
        }
        _ => {}
    }
    Ok(job)
}

fn validate_oid(oid: &str) -> Result<(), BenchError> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(BenchError::new(
            "INVALID_JOB",
            "Object IDs must be full SHA-1 or SHA-256 hex",
        ));
    }
    Ok(())
}

fn invalid_job_result(error: BenchError) -> BenchResult {
    BenchResult {
        event: "result",
        backend: "unknown".into(),
        operation: "unknown".into(),
        status: "error",
        error_code: Some(error.code),
        message: Some(bounded_message(&error.message)),
        open_ms: 0.0,
        walk_ms: 0.0,
        objects_ms: 0.0,
        total_ms: 0.0,
        visited_count: 0,
        oids: Vec::new(),
        has_more: false,
        raw_bytes: 0,
        objects_digest: None,
        completed_scans: None,
        gix_object_cache_bytes: None,
        gix_pack_cache_bytes: None,
        gix_features: None,
        cpu_self_ms: None,
        cpu_children_ms: None,
    }
}

fn wait_for_exit(receiver: &Receiver<InputEvent>) {
    let deadline = Instant::now() + RESULT_EXIT_GRACE;
    while Instant::now() < deadline {
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(InputEvent::Exit | InputEvent::Eof)
            | Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => return,
            Ok(InputEvent::Job(_)) => {}
        }
    }
}

fn write_json_line(value: &impl Serialize) -> Result<(), Box<dyn std::error::Error>> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

fn bounded_message(message: &str) -> String {
    message.chars().take(512).collect()
}

#[derive(Clone, Copy)]
struct CpuSnapshot {
    self_ms: Option<f64>,
    children_ms: Option<f64>,
}

impl CpuSnapshot {
    fn read() -> Self {
        Self {
            self_ms: read_rusage(libc::RUSAGE_SELF),
            children_ms: read_rusage(libc::RUSAGE_CHILDREN),
        }
    }

    fn difference(before: Option<f64>, after: Option<f64>) -> Option<f64> {
        Some((after? - before?).max(0.0))
    }
}

#[cfg(unix)]
fn read_rusage(who: libc::c_int) -> Option<f64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage initializes the provided struct for a supported `who` selector.
    if unsafe { libc::getrusage(who, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: the successful getrusage call initialized the struct.
    let usage = unsafe { usage.assume_init() };
    let millis = |time: libc::timeval| time.tv_sec as f64 * 1000.0 + time.tv_usec as f64 / 1000.0;
    Some(millis(usage.ru_utime) + millis(usage.ru_stime))
}

#[cfg(not(unix))]
fn read_rusage(_who: libc::c_int) -> Option<f64> {
    None
}
