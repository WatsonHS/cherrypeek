use std::{
    env,
    ffi::{OsStr, OsString},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

const STDERR_LIMIT: usize = 4 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(10);
// Buffered streams bound queued stdout bytes by block count; one producer block is additional.
const STREAM_BLOCK_BYTES: usize = 64 * 1024;

pub struct ReadOnlyGit {
    executable: PathBuf,
    /// Working-tree reads (P4-09) honour the user's global and system Git configuration so filters such
    /// as Git LFS behave as in a terminal. Everything else ignores it.
    user_config: bool,
    /// P5-01: the one place a command may write to the repository or reach the network. Only
    /// `crate::operations` builds a runner in this mode; every read keeps the isolation below.
    operation: bool,
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

/// The second field is true when the child leads its own process group (operations), so that
/// stopping it also stops the transport helpers it started (ssh, git-remote-https).
struct ChildGuard(Child, bool);

impl ChildGuard {
    fn kill_and_wait(&mut self) {
        #[cfg(unix)]
        if self.1
            && let Ok(pid) = libc::pid_t::try_from(self.0.id())
        {
            // SAFETY: killpg only sends a signal; the group id is this child's own pid, set at spawn.
            unsafe {
                libc::killpg(pid, libc::SIGKILL);
            }
        }
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
        Ok(Self {
            executable,
            user_config: false,
            operation: false,
        })
    }

    /// The same executable, reading the user's global and system configuration. fsmonitor, external
    /// diff, hooks, lazy fetch and network transports stay disabled by the fixed arguments below.
    #[must_use]
    pub fn with_user_config(&self) -> Self {
        Self {
            executable: self.executable.clone(),
            user_config: true,
            operation: false,
        }
    }

    /// P5-01. The same executable for a user-triggered operation (fetch, fast-forward, switch): it reads
    /// the user's configuration, may use the network and runs hooks, as the command would in a terminal.
    /// It still never prompts, never pages and never starts background maintenance.
    #[must_use]
    pub fn for_operation(&self) -> Self {
        Self {
            executable: self.executable.clone(),
            user_config: true,
            operation: true,
        }
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
        let mut child = ChildGuard(child, self.operation);
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
        self.stream_lines_inner(cwd, args, max_line_bytes, false, 16)
    }

    pub fn stream_lines_buffered(
        &self,
        cwd: &Path,
        args: &[OsString],
        max_line_bytes: usize,
        buffer_bytes: usize,
    ) -> Result<GitLineStream, GitFailure> {
        let block_count = buffer_bytes / STREAM_BLOCK_BYTES;
        if block_count == 0 {
            return Err(GitFailure::ResourceLimit);
        }
        self.stream_lines_inner(cwd, args, max_line_bytes, true, block_count)
    }

    fn stream_lines_inner(
        &self,
        cwd: &Path,
        args: &[OsString],
        max_line_bytes: usize,
        buffered: bool,
        channel_capacity: usize,
    ) -> Result<GitLineStream, GitFailure> {
        let mut command = self.command(cwd, args, false);
        let child = command
            .spawn()
            .map_err(|error| GitFailure::Unavailable(format!("Could not start Git: {error}")))?;
        let mut child = ChildGuard(child, self.operation);
        let stdout = child.0.stdout.take().expect("stdout was piped");
        let stderr = child.0.stderr.take().expect("stderr was piped");
        let (sender, receiver) = mpsc::sync_channel(channel_capacity);
        let stdout_reader = thread::spawn(move || {
            if buffered {
                send_buffered_chunks(stdout, &sender);
            } else {
                send_lines(stdout, max_line_bytes, &sender);
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
            buffered,
            chunk: Vec::new(),
            chunk_offset: 0,
            line_buffer: Vec::new(),
            max_line_bytes,
        })
    }

    fn command(&self, cwd: &Path, args: &[OsString], has_input: bool) -> Command {
        if self.operation {
            return self.operation_command(cwd, args, has_input);
        }
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
            .env("GIT_TERMINAL_PROMPT", "0");
        if !self.user_config {
            command
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", empty_global_config_path())
                .env("GIT_ATTR_NOSYSTEM", "1");
        }
        command
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

impl ReadOnlyGit {
    /// The command line of an operation: none of the read isolation (network, hooks, optional locks,
    /// lazy fetch), but no pager, no prompt and no automatic maintenance.
    fn operation_command(&self, cwd: &Path, args: &[OsString], has_input: bool) -> Command {
        let mut command = Command::new(&self.executable);
        command
            .arg("--no-pager")
            .arg("-c")
            .arg("gc.auto=0")
            .arg("-c")
            .arg("maintenance.auto=false")
            .arg("-C")
            .arg(cwd);
        for argument in args {
            command.arg(argument);
        }
        // SSH settings the user exported are part of how their remotes work; everything else that
        // could redirect Git (GIT_DIR, GIT_WORK_TREE, GIT_ASKPASS, …) is dropped.
        for (name, _) in env::vars_os().filter(|(name, _)| {
            let name = name.to_string_lossy();
            name.starts_with("GIT_") && name != "GIT_SSH" && name != "GIT_SSH_COMMAND"
        }) {
            command.env_remove(name);
        }
        command
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .stdin(if has_input {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command
    }
}

type StreamSender = SyncSender<Result<Option<Vec<u8>>, GitFailure>>;

fn send_lines(mut reader: impl Read, max_line_bytes: usize, sender: &StreamSender) {
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
}

fn send_buffered_chunks(mut reader: impl Read, sender: &StreamSender) {
    loop {
        let mut buffer = vec![0u8; STREAM_BLOCK_BYTES];
        let mut filled = 0;
        let mut eof = false;
        let mut read_error = None;
        while filled < buffer.len() {
            match reader.read(&mut buffer[filled..]) {
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(count) => filled += count,
                Err(error) => {
                    read_error = Some(error);
                    break;
                }
            }
        }
        if filled > 0 {
            buffer.truncate(filled);
            if sender.send(Ok(Some(buffer))).is_err() {
                return;
            }
        }
        if let Some(error) = read_error {
            let _ = sender.send(Err(GitFailure::Unavailable(format!(
                "Could not read Git stdout: {error}"
            ))));
            return;
        }
        if eof {
            let _ = sender.send(Ok(None));
            return;
        }
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
    buffered: bool,
    chunk: Vec<u8>,
    chunk_offset: usize,
    line_buffer: Vec<u8>,
    max_line_bytes: usize,
}

impl GitLineStream {
    pub fn next_line(
        &mut self,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<Option<Vec<u8>>, GitFailure> {
        if self.buffered {
            return self.next_buffered_line(cancelled, deadline);
        }
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

    fn next_buffered_line(
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
            if self.chunk_offset < self.chunk.len() {
                let start = self.chunk_offset;
                if let Some(newline) = self.chunk[start..].iter().position(|byte| *byte == b'\n') {
                    let end = start + newline;
                    if self.line_buffer.len().saturating_add(newline) > self.max_line_bytes {
                        return Err(GitFailure::ResourceLimit);
                    }
                    self.line_buffer.extend_from_slice(&self.chunk[start..end]);
                    self.chunk_offset += newline + 1;
                    return Ok(Some(std::mem::take(&mut self.line_buffer)));
                }
                let remaining = self.chunk.len() - start;
                if self.line_buffer.len().saturating_add(remaining) > self.max_line_bytes {
                    return Err(GitFailure::ResourceLimit);
                }
                self.line_buffer.extend_from_slice(&self.chunk[start..]);
                self.chunk_offset = self.chunk.len();
            }
            self.chunk.clear();
            self.chunk_offset = 0;
            match self
                .receiver
                .as_ref()
                .expect("stream receiver exists")
                .recv_timeout(POLL_INTERVAL)
            {
                Ok(Ok(Some(chunk))) => self.chunk = chunk,
                Ok(Ok(None)) => {
                    if !self.line_buffer.is_empty() {
                        return Err(GitFailure::Unavailable(
                            "Git stdout ended with an unterminated line".into(),
                        ));
                    }
                    self.ended = true;
                    return self.finish(cancelled, deadline);
                }
                Ok(Err(error)) => return Err(error),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    if !self.line_buffer.is_empty() {
                        return Err(GitFailure::Unavailable(
                            "Git stdout ended with an unterminated line".into(),
                        ));
                    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::Write,
        sync::atomic::{AtomicUsize, Ordering as AtomicOrdering},
    };

    static NEXT_REPO: AtomicUsize = AtomicUsize::new(1);

    struct TestRepo(PathBuf);

    impl TestRepo {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "commitscope-buffered-git-{}-{}",
                std::process::id(),
                NEXT_REPO.fetch_add(1, AtomicOrdering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            git(&path, &["init", "-q"]);
            git(&path, &["config", "user.name", "Buffered Test"]);
            git(&path, &["config", "user.email", "buffered@example.test"]);
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn fast_import(&self, commit_count: usize) {
            let mut input = String::new();
            for index in 1..=commit_count {
                input.push_str("commit refs/heads/main\n");
                input.push_str(&format!("mark :{index}\n"));
                input.push_str("committer Buffered Test <buffered@example.test> 1 +0000\n");
                input.push_str("data 1\nx\n");
                if index > 1 {
                    input.push_str(&format!("from :{}\n", index - 1));
                }
            }
            input.push_str("done\n");
            let mut child = Command::new(git_executable())
                .arg("-C")
                .arg(self.path())
                .arg("fast-import")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let write_result = child.stdin.take().unwrap().write_all(input.as_bytes());
            let output = child.wait_with_output().unwrap();
            assert!(
                write_result.is_ok(),
                "fast-import input failed: {}; stderr: {}",
                write_result.unwrap_err(),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                output.status.success(),
                "fast-import failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git_executable() -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|directory| directory.join("git"))
            .find(|candidate| candidate.is_file())
            .unwrap()
    }

    fn git(path: &Path, args: &[&str]) -> Vec<u8> {
        let output = Command::new(git_executable())
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn stream(
        repo: &TestRepo,
        args: &[&str],
        max_line_bytes: usize,
        buffer_bytes: usize,
    ) -> GitLineStream {
        let args = args.iter().map(string_arg).collect::<Vec<_>>();
        ReadOnlyGit::new(git_executable())
            .unwrap()
            .stream_lines_buffered(repo.path(), &args, max_line_bytes, buffer_bytes)
            .unwrap()
    }

    #[test]
    fn buffered_stream_crosses_chunk_boundary_and_drains_after_child_exit() {
        let repo = TestRepo::new();
        repo.fast_import(2_000);
        let mut stream = stream(&repo, &["rev-list", "--all"], 80, STREAM_BLOCK_BYTES * 2);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if stream
                .child
                .as_mut()
                .unwrap()
                .0
                .try_wait()
                .unwrap()
                .is_some()
            {
                break;
            }
            assert!(Instant::now() < deadline, "buffer did not drain Git output");
            thread::sleep(POLL_INTERVAL);
        }

        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut count = 0;
        while let Some(line) = stream.next_line(&cancelled, deadline).unwrap() {
            assert_eq!(line.len(), 40);
            count += 1;
        }
        assert_eq!(count, 2_000);
    }

    #[test]
    fn buffered_stream_preserves_line_limit_and_unterminated_output_errors() {
        let repo = TestRepo::new();
        git(
            repo.path(),
            &["config", "--local", "probe.long", &"x".repeat(100)],
        );
        let mut overlong = stream(
            &repo,
            &["config", "--local", "--get", "probe.long"],
            32,
            STREAM_BLOCK_BYTES,
        );
        assert!(matches!(
            overlong.next_line(
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(5)
            ),
            Err(GitFailure::ResourceLimit)
        ));

        fs::write(repo.path().join("plain"), b"unterminated").unwrap();
        git(repo.path(), &["add", "plain"]);
        git(repo.path(), &["commit", "-q", "-m", "plain"]);
        let oid = String::from_utf8(git(repo.path(), &["rev-parse", "HEAD:plain"]))
            .unwrap()
            .trim()
            .to_owned();
        let mut unterminated = stream(&repo, &["cat-file", "blob", &oid], 32, STREAM_BLOCK_BYTES);
        assert!(matches!(
            unterminated.next_line(
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(5)
            ),
            Err(GitFailure::Unavailable(message)) if message.contains("unterminated line")
        ));
    }

    #[test]
    fn dropping_buffered_stream_at_capacity_reaps_blocked_reader() {
        let repo = TestRepo::new();
        fs::write(repo.path().join("large"), vec![b'x'; 2 * 1024 * 1024]).unwrap();
        git(repo.path(), &["add", "large"]);
        git(repo.path(), &["commit", "-q", "-m", "large"]);
        let mut stream = stream(
            &repo,
            &["cat-file", "blob", "HEAD:large"],
            3 * 1024 * 1024,
            STREAM_BLOCK_BYTES,
        );
        thread::sleep(Duration::from_millis(50));
        assert!(
            stream
                .child
                .as_mut()
                .unwrap()
                .0
                .try_wait()
                .unwrap()
                .is_none()
        );

        let started = Instant::now();
        drop(stream);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
