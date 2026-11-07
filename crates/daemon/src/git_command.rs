use std::{
    env,
    ffi::{OsStr, OsString},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    thread,
    time::{Duration, Instant},
};

const STDERR_LIMIT: usize = 4 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(10);

pub struct ReadOnlyGit {
    executable: PathBuf,
}

pub struct CommandOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug)]
pub enum GitFailure {
    Cancelled,
    Timeout,
    ResourceLimit,
    Unavailable(String),
    CommandFailed(String),
}

struct ChildGuard(Child);

impl ChildGuard {
    fn kill_and_wait(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            self.kill_and_wait();
        }
    }
}

impl ReadOnlyGit {
    pub fn new(executable: PathBuf) -> Result<Self, GitFailure> {
        if !executable.is_absolute() {
            return Err(GitFailure::Unavailable(
                "Git executable path is not absolute".into(),
            ));
        }
        Ok(Self { executable })
    }

    pub fn run(
        &self,
        cwd: &Path,
        args: &[OsString],
        input: Option<&[u8]>,
        stdout_limit: usize,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<CommandOutput, GitFailure> {
        if cancelled.load(Ordering::Acquire) {
            return Err(GitFailure::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(GitFailure::Timeout);
        }

        let mut command = self.command(cwd, args, input.is_some());

        let child = command
            .spawn()
            .map_err(|error| GitFailure::Unavailable(format!("Could not start Git: {error}")))?;
        let mut child = ChildGuard(child);
        let stdout = child.0.stdout.take().expect("stdout was piped");
        let stderr = child.0.stderr.take().expect("stderr was piped");
        let overflow = Arc::new(AtomicBool::new(false));
        let io_failed = Arc::new(AtomicBool::new(false));
        let stdout_reader = {
            let overflow = Arc::clone(&overflow);
            let io_failed = Arc::clone(&io_failed);
            thread::spawn(move || read_bounded(stdout, stdout_limit, overflow, io_failed))
        };
        let stderr_reader = {
            let overflow = Arc::clone(&overflow);
            let io_failed = Arc::clone(&io_failed);
            thread::spawn(move || read_bounded(stderr, STDERR_LIMIT, overflow, io_failed))
        };
        let stdin_writer = input.map(|bytes| {
            let mut stdin = child.0.stdin.take().expect("stdin was piped");
            let bytes = bytes.to_vec();
            thread::spawn(move || stdin.write_all(&bytes))
        });

        enum Exit {
            Status(ExitStatus),
            Cancelled,
            Timeout,
            ResourceLimit,
            IoError,
        }
        let exit = loop {
            if cancelled.load(Ordering::Acquire) {
                child.kill_and_wait();
                break Exit::Cancelled;
            }
            if Instant::now() >= deadline {
                child.kill_and_wait();
                break Exit::Timeout;
            }
            if overflow.load(Ordering::Acquire) {
                child.kill_and_wait();
                break Exit::ResourceLimit;
            }
            if io_failed.load(Ordering::Acquire) {
                child.kill_and_wait();
                break Exit::IoError;
            }
            match child.0.try_wait() {
                Ok(Some(status)) => break Exit::Status(status),
                Ok(None) => thread::sleep(POLL_INTERVAL),
                Err(error) => {
                    child.kill_and_wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    if let Some(writer) = stdin_writer {
                        let _ = writer.join();
                    }
                    return Err(GitFailure::Unavailable(format!(
                        "Could not inspect Git process: {error}"
                    )));
                }
            }
        };

        let stdin_result = stdin_writer.map(|writer| writer.join());
        let stdout = stdout_reader
            .join()
            .map_err(|_| GitFailure::Unavailable("Git stdout reader panicked".into()))?
            .map_err(|error| {
                GitFailure::Unavailable(format!("Could not read Git stdout: {error}"))
            })?;
        let stderr = stderr_reader
            .join()
            .map_err(|_| GitFailure::Unavailable("Git stderr reader panicked".into()))?
            .map_err(|error| {
                GitFailure::Unavailable(format!("Could not read Git stderr: {error}"))
            })?;
        if cancelled.load(Ordering::Acquire) || matches!(exit, Exit::Cancelled) {
            return Err(GitFailure::Cancelled);
        }
        if matches!(exit, Exit::Timeout) {
            return Err(GitFailure::Timeout);
        }
        if matches!(exit, Exit::ResourceLimit) || overflow.load(Ordering::Acquire) {
            return Err(GitFailure::ResourceLimit);
        }
        if matches!(exit, Exit::IoError) || io_failed.load(Ordering::Acquire) {
            return Err(GitFailure::Unavailable("Git pipe I/O failed".into()));
        }
        match stdin_result {
            Some(Ok(Ok(()))) | None => {}
            Some(Ok(Err(error))) => {
                return Err(GitFailure::Unavailable(format!(
                    "Could not write Git input: {error}"
                )));
            }
            Some(Err(_)) => {
                return Err(GitFailure::Unavailable("Git stdin writer panicked".into()));
            }
        }
        let status = match exit {
            Exit::Status(status) => status,
            _ => unreachable!("all process stop conditions handled above"),
        };
        Ok(CommandOutput {
            status,
            stdout,
            stderr,
        })
    }

    pub fn stream_lines(
        &self,
        cwd: &Path,
        args: &[OsString],
        max_line_bytes: usize,
    ) -> Result<GitLineStream, GitFailure> {
        let mut command = self.command(cwd, args, false);
        let child = command
            .spawn()
            .map_err(|error| GitFailure::Unavailable(format!("Could not start Git: {error}")))?;
        let mut child = ChildGuard(child);
        let stdout = child.0.stdout.take().expect("stdout was piped");
        let stderr = child.0.stderr.take().expect("stderr was piped");
        let (sender, receiver) = mpsc::sync_channel(16);
        let stdout_reader = thread::spawn(move || {
            let mut reader = stdout;
            let mut buffer = [0u8; 4096];
            let mut line = Vec::with_capacity(max_line_bytes.min(256));
            loop {
                let count = match reader.read(&mut buffer) {
                    Ok(0) => {
                        let result = if line.is_empty() {
                            Ok(None)
                        } else {
                            Err(GitFailure::Unavailable(
                                "Git stdout ended with an unterminated line".into(),
                            ))
                        };
                        let _ = sender.send(result);
                        return;
                    }
                    Ok(count) => count,
                    Err(error) => {
                        let _ = sender.send(Err(GitFailure::Unavailable(format!(
                            "Could not read Git stdout: {error}"
                        ))));
                        return;
                    }
                };
                for byte in &buffer[..count] {
                    if *byte == b'\n' {
                        if sender.send(Ok(Some(std::mem::take(&mut line)))).is_err() {
                            return;
                        }
                    } else {
                        line.push(*byte);
                        if line.len() > max_line_bytes {
                            let _ = sender.send(Err(GitFailure::ResourceLimit));
                            return;
                        }
                    }
                }
            }
        });
        let stderr_bytes = Arc::new(Mutex::new(Vec::new()));
        let stderr_failed = Arc::new(AtomicBool::new(false));
        let stderr_reader = {
            let stderr_bytes = Arc::clone(&stderr_bytes);
            let stderr_failed = Arc::clone(&stderr_failed);
            thread::spawn(move || {
                let overflow = Arc::new(AtomicBool::new(false));
                let failed = Arc::new(AtomicBool::new(false));
                let result = read_bounded(stderr, STDERR_LIMIT, overflow, failed);
                if let Ok(bytes) = result {
                    *stderr_bytes.lock().expect("stderr mutex poisoned") = bytes;
                } else {
                    stderr_failed.store(true, Ordering::Release);
                }
            })
        };
        Ok(GitLineStream {
            child: Some(child),
            receiver: Some(receiver),
            stdout_reader: Some(stdout_reader),
            stderr_reader: Some(stderr_reader),
            stderr_bytes,
            stderr_failed,
            ended: false,
        })
    }

    fn command(&self, cwd: &Path, args: &[OsString], has_input: bool) -> Command {
        let mut command = Command::new(&self.executable);
        command
            .arg("--no-lazy-fetch")
            .arg("--no-pager")
            .arg("--no-replace-objects")
            .arg("--no-optional-locks")
            .arg("-c")
            .arg("protocol.allow=never")
            .arg("-c")
            .arg("gc.auto=0")
            .arg("-c")
            .arg("maintenance.auto=false")
            .arg("-c")
            .arg("core.fsmonitor=false")
            .arg("-c")
            .arg("diff.external=")
            .arg("-c")
            .arg(format!("core.hooksPath={}", disabled_hooks_path()))
            .arg("-c")
            .arg("fetch.writeCommitGraph=false")
            .arg("-C")
            .arg(cwd);
        for argument in args {
            command.arg(argument);
        }
        for (name, _) in
            env::vars_os().filter(|(name, _)| name.to_string_lossy().starts_with("GIT_"))
        {
            command.env_remove(name);
        }
        command
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", empty_global_config_path())
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .stdin(if has_input {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
}

pub struct GitLineStream {
    child: Option<ChildGuard>,
    receiver: Option<Receiver<Result<Option<Vec<u8>>, GitFailure>>>,
    stdout_reader: Option<thread::JoinHandle<()>>,
    stderr_reader: Option<thread::JoinHandle<()>>,
    stderr_bytes: Arc<Mutex<Vec<u8>>>,
    stderr_failed: Arc<AtomicBool>,
    ended: bool,
}

impl GitLineStream {
    pub fn next_line(
        &mut self,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<Option<Vec<u8>>, GitFailure> {
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err(GitFailure::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(GitFailure::Timeout);
            }
            if self.ended {
                return self.finish(cancelled, deadline);
            }
            match self
                .receiver
                .as_ref()
                .expect("stream receiver exists")
                .recv_timeout(POLL_INTERVAL)
            {
                Ok(Ok(Some(line))) => return Ok(Some(line)),
                Ok(Ok(None)) => {
                    self.ended = true;
                    return self.finish(cancelled, deadline);
                }
                Ok(Err(error)) => return Err(error),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.ended = true;
                    return self.finish(cancelled, deadline);
                }
            }
        }
    }

    fn finish(
        &mut self,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<Option<Vec<u8>>, GitFailure> {
        let child = self.child.as_mut().expect("stream child exists");
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err(GitFailure::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(GitFailure::Timeout);
            }
            match child.0.try_wait() {
                Ok(Some(status)) => {
                    if let Some(reader) = self.stdout_reader.take() {
                        let _ = reader.join();
                    }
                    if let Some(reader) = self.stderr_reader.take() {
                        let _ = reader.join();
                    }
                    if self.stderr_failed.load(Ordering::Acquire) {
                        return Err(GitFailure::Unavailable("Could not read Git stderr".into()));
                    }
                    if status.success() {
                        return Ok(None);
                    }
                    let stderr = String::from_utf8_lossy(
                        &self.stderr_bytes.lock().expect("stderr mutex poisoned"),
                    )
                    .into_owned();
                    return Err(GitFailure::CommandFailed(format!("{status}: {stderr}")));
                }
                Ok(None) => thread::sleep(POLL_INTERVAL),
                Err(error) => {
                    return Err(GitFailure::Unavailable(format!(
                        "Could not inspect Git process: {error}"
                    )));
                }
            }
        }
    }
}

impl Drop for GitLineStream {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            child.kill_and_wait();
        }
        self.receiver.take();
        if let Some(reader) = self.stdout_reader.take() {
            let _ = reader.join();
        }
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

fn read_bounded(
    mut reader: impl Read,
    limit: usize,
    overflow: Arc<AtomicBool>,
    io_failed: Arc<AtomicBool>,
) -> io::Result<Vec<u8>> {
    let mut retained = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(retained),
            Err(error) => {
                io_failed.store(true, Ordering::Release);
                return Err(error);
            }
            Ok(length) => {
                let remaining = limit.saturating_sub(retained.len());
                retained.extend_from_slice(&buffer[..length.min(remaining)]);
                if length > remaining {
                    overflow.store(true, Ordering::Release);
                }
            }
        }
    }
}

fn disabled_hooks_path() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}

fn empty_global_config_path() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}

pub fn string_arg(value: impl AsRef<OsStr>) -> OsString {
    value.as_ref().to_os_string()
}
