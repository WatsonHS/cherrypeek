use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver},
    },
    thread,
    time::{Duration, Instant},
};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
const WAIT: Duration = Duration::from_secs(7);

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

struct Daemon {
    child: ChildGuard,
    input: Option<ChildStdin>,
    output: Receiver<Result<Value, String>>,
}

impl Daemon {
    fn spawn(path: Option<&Path>) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_commitscope-daemon"));
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(path) = path {
            command.env("PATH", path);
        }
        let mut child = ChildGuard(command.spawn().expect("spawn daemon"));
        let stdout = child.0.stdout.take().expect("daemon stdout");
        let (sender, output) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match read_bounded_line(&mut reader, &mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let result =
                            serde_json::from_slice(&line).map_err(|error| error.to_string());
                        if sender.send(result).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        break;
                    }
                }
            }
        });
        let input = child.0.stdin.take().expect("daemon stdin");
        Self {
            child,
            input: Some(input),
            output,
        }
    }

    fn send(&mut self, message: &Value) {
        let input = self.input.as_mut().expect("stdin still open");
        serde_json::to_writer(&mut *input, message).expect("write client message");
        input.write_all(b"\n").expect("write client frame newline");
        input.flush().expect("flush client message");
    }

    fn send_raw(&mut self, bytes: &[u8]) {
        let input = self.input.as_mut().expect("stdin still open");
        input.write_all(bytes).expect("write raw client bytes");
        input.flush().expect("flush raw client bytes");
    }

    fn recv(&self) -> Value {
        self.output
            .recv_timeout(WAIT)
            .expect("daemon output deadline")
            .expect("daemon emitted valid JSON")
    }

    fn close_stdin(&mut self) {
        self.input.take();
    }

    fn wait_exit(&mut self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.0.try_wait().expect("poll daemon") {
                assert!(status.success(), "daemon exited with {status}");
                return;
            }
            assert!(
                Instant::now() < deadline,
                "daemon did not exit before deadline"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn read_bounded_line(reader: &mut impl BufRead, line: &mut Vec<u8>) -> Result<usize, String> {
    let mut byte = [0];
    loop {
        match reader.read(&mut byte) {
            Ok(0) => return Ok(line.len()),
            Ok(_) if byte[0] == b'\n' => return Ok(line.len()),
            Ok(_) => {
                if line.len() >= 1024 * 1024 {
                    return Err("test peer frame exceeded 1 MiB".into());
                }
                line.push(byte[0]);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn hello() -> Value {
    json!({"type":"hello", "protocolVersion":1})
}

fn request(request_id: &str) -> Value {
    json!({
        "type":"request",
        "requestId":request_id,
        "method":"getRuntimeInfo",
        "repoId":null,
        "generation":null,
        "params":{}
    })
}

fn preview_request(request_id: &str, path: &Path) -> Value {
    json!({
        "type":"request",
        "requestId":request_id,
        "method":"readRepositoryPreview",
        "repoId":null,
        "generation":null,
        "params":{"path":path.to_string_lossy()}
    })
}

fn git(path: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Test Author")
        .env("GIT_AUTHOR_EMAIL", "author@example.test")
        .env("GIT_COMMITTER_NAME", "Test Committer")
        .env("GIT_COMMITTER_EMAIL", "committer@example.test")
        .env("GIT_AUTHOR_DATE", "@1700000000 +0530")
        .env("GIT_COMMITTER_DATE", "@1700000300 -0700")
        .output()
        .expect("run fixture git")
}

fn git_with_input(path: &Path, args: &[&str], input: &[u8]) -> std::process::Output {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn fixture git");
    child
        .stdin
        .take()
        .expect("fixture stdin")
        .write_all(input)
        .expect("write fixture git input");
    child.wait_with_output().expect("wait for fixture git")
}

fn init_committed_repo() -> PathBuf {
    let path = temp_dir();
    assert!(git(&path, &["init", "-b", "main"]).status.success());
    fs::write(path.join("file.txt"), "content\n").expect("write fixture file");
    assert!(git(&path, &["add", "file.txt"]).status.success());
    assert!(
        git(&path, &["commit", "-m", "first summary"])
            .status
            .success()
    );
    path
}

fn temp_dir() -> PathBuf {
    let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
    let path =
        std::env::temp_dir().join(format!("commitscope-protocol-{}-{id}", std::process::id()));
    fs::create_dir_all(&path).expect("create test directory");
    path
}

fn controlled_git_dir() -> (PathBuf, PathBuf) {
    let directory = temp_dir();
    let marker = directory.join("handshake-complete");
    let pids = directory.join("git-pids");
    let script = directory.join("git");
    let body = format!(
        "#!/bin/sh\nif [ ! -f '{}' ]; then : > '{}'; printf 'git version controlled\\n'; exit 0; fi\nprintf '%s\\n' \"$$\" >> '{}'\nexec /bin/sleep 30\n",
        marker.display(),
        marker.display(),
        pids.display()
    );
    fs::write(&script, body).expect("write controlled Git script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755))
            .expect("make Git executable");
    }
    (directory, pids)
}

fn await_pids(path: &Path, expected: usize) -> Vec<u32> {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Ok(contents) = fs::read_to_string(path) {
            let pids: Vec<_> = contents
                .lines()
                .filter_map(|line| line.parse().ok())
                .collect();
            if pids.len() >= expected {
                return pids;
            }
        }
        assert!(Instant::now() < deadline, "controlled Git did not start");
        thread::sleep(Duration::from_millis(10));
    }
}

fn assert_process_gone(pid: u32) {
    let deadline = Instant::now() + WAIT;
    loop {
        let status = Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("run kill -0");
        if !status.success() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "Git PID {pid} survived cancellation"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn handshake_and_runtime_info_are_real_two_chunk_response() {
    let mut daemon = Daemon::spawn(None);
    daemon.send(&hello());
    let handshake = daemon.recv();
    assert_eq!(handshake["type"], "hello");
    assert_eq!(handshake["core"]["protocolVersion"], 1);
    assert_eq!(handshake["core"]["coreVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(handshake["core"]["pid"], daemon.child.0.id());
    assert_eq!(
        handshake["core"]["capabilities"],
        json!([
            "getRuntimeInfo",
            "readRepositoryPreview",
            "repositorySessions",
            "historyPagination"
        ])
    );
    assert_eq!(handshake["core"]["git"]["available"], true);
    assert!(
        handshake["core"]["git"]["version"]
            .as_str()
            .unwrap()
            .starts_with("git version ")
    );

    daemon.send(&request("request-1"));
    let first = daemon.recv();
    let second = daemon.recv();
    assert_eq!(first["type"], "response");
    assert_eq!(first["requestId"], "request-1");
    assert_eq!(first["sequence"], 0);
    assert_eq!(first["done"], false);
    assert_eq!(first["data"]["section"], "core");
    assert_eq!(first["data"]["pid"], daemon.child.0.id());
    assert_eq!(second["type"], "response");
    assert_eq!(second["sequence"], 1);
    assert_eq!(second["done"], true);
    assert_eq!(second["data"]["section"], "git");
    assert_eq!(second["data"]["git"]["available"], true);

    daemon.close_stdin();
    daemon.wait_exit(WAIT);
}

#[test]
fn repository_preview_reads_fixed_head_and_separate_raw_identities() {
    let path = init_committed_repo();
    let nested = path.join("nested");
    fs::create_dir(&nested).expect("create nested directory");
    let head = String::from_utf8(git(&path, &["rev-parse", "HEAD"]).stdout)
        .expect("HEAD utf8")
        .trim()
        .to_owned();

    let mut daemon = Daemon::spawn(None);
    daemon.send(&hello());
    assert!(
        daemon.recv()["core"]["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("readRepositoryPreview"))
    );
    daemon.send(&preview_request("preview-1", &nested));
    let repository = daemon.recv();
    let commits = daemon.recv();
    assert_eq!(repository["type"], "response");
    assert_eq!(repository["data"]["section"], "repository");
    assert_eq!(
        repository["data"]["repository"]["path"],
        fs::canonicalize(&path).unwrap().to_string_lossy().as_ref()
    );
    assert_eq!(repository["data"]["repository"]["headOid"], head);
    assert_eq!(
        repository["data"]["repository"]["headReference"],
        "refs/heads/main"
    );
    assert_eq!(commits["data"]["section"], "commits");
    assert_eq!(commits["done"], true);
    assert_eq!(commits["data"]["commits"].as_array().unwrap().len(), 1);
    let commit = &commits["data"]["commits"][0];
    assert_eq!(commit["summary"], "first summary");
    assert_eq!(commit["author"]["timestamp"], "1700000000");
    assert_eq!(commit["author"]["offset"], "+0530");
    assert_eq!(commit["committer"]["timestamp"], "1700000300");
    assert_eq!(commit["committer"]["offset"], "-0700");
    daemon.close_stdin();
    daemon.wait_exit(WAIT);
}

#[test]
fn repository_refs_are_truncated_before_the_serialized_size_target() {
    let path = init_committed_repo();
    let oid = String::from_utf8(git(&path, &["rev-parse", "HEAD"]).stdout)
        .expect("HEAD utf8")
        .trim()
        .to_owned();
    let mut updates = String::new();
    for index in 0..1_800 {
        updates.push_str(&format!(
            "create refs/heads/r{index:04}-{} {oid}\n",
            "x".repeat(220)
        ));
    }
    let result = git_with_input(&path, &["update-ref", "--stdin"], updates.as_bytes());
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let mut daemon = Daemon::spawn(None);
    daemon.send(&hello());
    let _ = daemon.recv();
    daemon.send(&preview_request("large-refs", &path));
    let repository = daemon.recv();
    let encoded = serde_json::to_vec(&repository).expect("serialize response");
    assert!(
        encoded.len() <= 512 * 1024,
        "response was {} bytes",
        encoded.len()
    );
    assert_eq!(repository["data"]["section"], "repository");
    assert_eq!(repository["data"]["refsTruncated"], true);
    assert!(repository["data"]["refs"].as_array().unwrap().len() < 1_800);
    let commits = daemon.recv();
    assert_eq!(commits["data"]["section"], "commits");
    daemon.close_stdin();
    daemon.wait_exit(WAIT);
}

#[test]
fn preview_distinguishes_unborn_detached_missing_object_and_non_repository() {
    let empty = temp_dir();
    assert!(git(&empty, &["init", "-b", "main"]).status.success());
    let mut daemon = Daemon::spawn(None);
    daemon.send(&hello());
    let _ = daemon.recv();
    daemon.send(&preview_request("empty", &empty));
    let repository = daemon.recv();
    let commits = daemon.recv();
    assert_eq!(repository["data"]["repository"]["headOid"], Value::Null);
    assert_eq!(commits["done"], true);
    assert_eq!(commits["data"]["commits"], json!([]));

    let repo = init_committed_repo();
    let oid = String::from_utf8(git(&repo, &["rev-parse", "HEAD"]).stdout)
        .expect("HEAD utf8")
        .trim()
        .to_owned();
    assert!(
        git(&repo, &["checkout", "--detach", "HEAD"])
            .status
            .success()
    );
    daemon.send(&preview_request("detached", &repo));
    let detached = daemon.recv();
    let _ = daemon.recv();
    assert_eq!(detached["data"]["repository"]["headReference"], Value::Null);
    assert_eq!(detached["data"]["repository"]["headOid"], oid);

    let object = repo.join(".git/objects").join(&oid[..2]).join(&oid[2..]);
    fs::remove_file(object).expect("remove fixture commit object");
    assert!(
        git(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"])
            .status
            .success()
    );
    daemon.send(&preview_request("missing", &repo));
    let missing = daemon.recv();
    assert_eq!(missing["code"], "MISSING_OBJECT", "{missing}");

    let non_repo = temp_dir();
    daemon.send(&preview_request("non-repo", &non_repo));
    assert_eq!(daemon.recv()["code"], "NOT_A_REPOSITORY");
    daemon.close_stdin();
    daemon.wait_exit(WAIT);
}

#[test]
fn missing_parent_object_is_reported_as_missing_object() {
    let repo = init_committed_repo();
    fs::write(repo.join("second.txt"), "second\n").expect("write second fixture file");
    assert!(git(&repo, &["add", "second.txt"]).status.success());
    assert!(
        git(&repo, &["commit", "-m", "second summary"])
            .status
            .success()
    );
    let parent = String::from_utf8(git(&repo, &["rev-parse", "HEAD^"]).stdout)
        .expect("parent OID utf8")
        .trim()
        .to_owned();
    fs::remove_file(
        repo.join(".git/objects")
            .join(&parent[..2])
            .join(&parent[2..]),
    )
    .expect("remove parent commit object");

    let mut daemon = Daemon::spawn(None);
    daemon.send(&hello());
    let _ = daemon.recv();
    daemon.send(&preview_request("missing-parent", &repo));
    let _repository = daemon.recv();
    let missing = daemon.recv();
    assert_eq!(missing["type"], "error", "{missing}");
    assert_eq!(missing["code"], "MISSING_OBJECT", "{missing}");
    daemon.close_stdin();
    daemon.wait_exit(WAIT);
}

#[test]
fn mismatch_unhandshaken_request_and_repeated_hello_are_rejected() {
    let mut mismatch = Daemon::spawn(None);
    mismatch.send(&json!({"type":"hello", "protocolVersion":2}));
    assert_eq!(mismatch.recv()["code"], "PROTOCOL_MISMATCH");
    mismatch.wait_exit(WAIT);

    let mut no_hello = Daemon::spawn(None);
    no_hello.send(&request("request-1"));
    assert_eq!(no_hello.recv()["code"], "PROTOCOL_ERROR");
    no_hello.wait_exit(WAIT);

    let mut repeated = Daemon::spawn(None);
    repeated.send(&hello());
    assert_eq!(repeated.recv()["type"], "hello");
    repeated.send(&hello());
    assert_eq!(repeated.recv()["code"], "PROTOCOL_ERROR");
    repeated.wait_exit(WAIT);
}

#[test]
fn missing_hello_times_out_and_duplicate_active_request_id_is_fatal() {
    let mut timed_out = Daemon::spawn(None);
    assert_eq!(timed_out.recv()["code"], "TIMEOUT");
    timed_out.wait_exit(WAIT);

    let (directory, pids_file) = controlled_git_dir();
    let mut daemon = Daemon::spawn(Some(&directory));
    daemon.send(&hello());
    daemon.recv();
    daemon.send(&request("duplicate"));
    assert_eq!(daemon.recv()["sequence"], 0);
    let pids = await_pids(&pids_file, 1);
    daemon.send(&json!({
        "type":"request", "requestId":"duplicate", "method":"unknown",
        "repoId":null,"generation":null,"params":{"invalid":true}
    }));
    let error = daemon.recv();
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "PROTOCOL_ERROR");
    assert_eq!(error["requestId"], Value::Null);
    daemon.wait_exit(WAIT);
    assert_process_gone(pids[0]);
    fs::remove_dir_all(directory).expect("remove controlled Git fixture");
}

#[test]
fn request_errors_are_scoped_and_do_not_close_the_connection() {
    let mut daemon = Daemon::spawn(None);
    daemon.send(&hello());
    daemon.recv();
    daemon.send(&json!({
        "type":"request", "requestId":"bad-method", "method":"anything",
        "repoId":null,"generation":null,"params":{}
    }));
    let unknown = daemon.recv();
    assert_eq!(unknown["code"], "UNKNOWN_METHOD");
    assert_eq!(unknown["requestId"], "bad-method");
    daemon.send(&json!({
        "type":"request", "requestId":"bad-params", "method":"getRuntimeInfo",
        "repoId":null,"generation":null,"params":{"unexpected":true}
    }));
    assert_eq!(daemon.recv()["code"], "INVALID_REQUEST");
    daemon.send(&json!({
        "type":"request", "requestId":"large-context", "method":"getRuntimeInfo",
        "repoId":"x".repeat(300),"generation":"g".repeat(300),"params":{}
    }));
    let invalid_context = daemon.recv();
    assert_eq!(invalid_context["code"], "INVALID_REQUEST");
    assert_eq!(invalid_context["repoId"], Value::Null);
    assert_eq!(invalid_context["generation"], Value::Null);
    assert!(serde_json::to_vec(&invalid_context).unwrap().len() < 1024);
    daemon.send(&request("good"));
    assert_eq!(daemon.recv()["sequence"], 0);
    assert_eq!(daemon.recv()["sequence"], 1);
    daemon.close_stdin();
    daemon.wait_exit(WAIT);
}

#[test]
fn cancellation_kills_actual_git_and_busy_is_bounded_to_two_requests() {
    let (directory, pids_file) = controlled_git_dir();
    let mut daemon = Daemon::spawn(Some(&directory));
    daemon.send(&hello());
    daemon.recv();

    daemon.send(&request("slow-1"));
    daemon.send(&request("slow-2"));
    let mut first_chunks = Vec::new();
    for _ in 0..2 {
        let frame = daemon.recv();
        assert_eq!(frame["type"], "response");
        assert_eq!(frame["sequence"], 0);
        first_chunks.push(frame["requestId"].as_str().unwrap().to_owned());
    }
    assert_eq!(first_chunks.len(), 2);
    daemon.send(&request("busy"));
    let busy = daemon.recv();
    assert_eq!(busy["type"], "error");
    assert_eq!(busy["code"], "BUSY");

    let pids = await_pids(&pids_file, 2);
    daemon.send(&json!({"type":"cancel", "requestId":"slow-1"}));
    daemon.send(&json!({"type":"cancel", "requestId":"slow-1"}));
    daemon.send(&json!({"type":"cancel", "requestId":"slow-2"}));
    let mut cancelled = Vec::new();
    for _ in 0..2 {
        let frame = daemon.recv();
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["code"], "CANCELLED");
        cancelled.push(frame["requestId"].as_str().unwrap().to_owned());
    }
    cancelled.sort();
    assert_eq!(cancelled, ["slow-1", "slow-2"]);
    for pid in pids.into_iter().take(2) {
        assert_process_gone(pid);
    }
    daemon.close_stdin();
    daemon.wait_exit(WAIT);
    fs::remove_dir_all(directory).expect("remove controlled Git fixture");
}

#[test]
fn git_probe_timeout_is_reported_and_child_is_reaped() {
    let (directory, pids_file) = controlled_git_dir();
    let mut daemon = Daemon::spawn(Some(&directory));
    daemon.send(&hello());
    daemon.recv();
    daemon.send(&request("timeout"));
    assert_eq!(daemon.recv()["sequence"], 0);
    let pids = await_pids(&pids_file, 1);
    let error = daemon.recv();
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "TIMEOUT");
    assert_eq!(error["requestId"], "timeout");
    assert_process_gone(pids[0]);
    daemon.close_stdin();
    daemon.wait_exit(WAIT);
    fs::remove_dir_all(directory).expect("remove controlled Git fixture");
}

#[test]
fn malformed_utf8_oversize_and_truncated_frames_close_the_session() {
    for frame in [
        vec![0xff, b'\n'],
        b"{not-json}\n".to_vec(),
        vec![b' '; 1024 * 1024 + 1],
    ] {
        let mut daemon = Daemon::spawn(None);
        daemon.send(&hello());
        daemon.recv();
        let mut frame = frame;
        if frame.last() != Some(&b'\n') {
            frame.push(b'\n');
        }
        daemon.send_raw(&frame);
        assert_eq!(daemon.recv()["code"], "PROTOCOL_ERROR");
        daemon.wait_exit(WAIT);
    }

    let mut truncated = Daemon::spawn(None);
    truncated.send(&hello());
    truncated.recv();
    truncated.send_raw(b"{\"type\":");
    truncated.close_stdin();
    assert_eq!(truncated.recv()["code"], "PROTOCOL_ERROR");
    truncated.wait_exit(WAIT);
}

#[test]
fn stdin_eof_while_git_is_running_cancels_and_reaps_git() {
    let (directory, pids_file) = controlled_git_dir();
    let mut daemon = Daemon::spawn(Some(&directory));
    daemon.send(&hello());
    daemon.recv();
    daemon.send(&request("shutdown-slow"));
    assert_eq!(daemon.recv()["sequence"], 0);
    let pids = await_pids(&pids_file, 1);
    daemon.close_stdin();
    daemon.wait_exit(WAIT);
    assert_process_gone(pids[0]);
    fs::remove_dir_all(directory).expect("remove controlled Git fixture");
}
