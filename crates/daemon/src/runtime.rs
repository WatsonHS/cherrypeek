use commitscope_core::GitInfo;
use std::{
    env,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: usize = 4 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeFailure {
    Cancelled,
    Timeout,
}

struct ChildGuard(Child);

impl ChildGuard {
    fn terminate(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            self.terminate();
        }
    }
}

pub fn find_git() -> Option<PathBuf> {
    find_git_in_paths(env::var_os("PATH"))
}

fn find_git_in_paths(path: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["git.exe", "git"]
    } else {
        &["git"]
    };
    if let Some(path) = path {
        for directory in env::split_paths(&path).filter(|directory| directory.is_absolute()) {
            for name in names {
                let candidate = directory.join(name);
                if candidate.is_file() && is_executable(&candidate) {
                    return candidate
                        .canonicalize()
                        .ok()
                        .filter(|path| path.is_absolute());
                }
            }
        }
    }
    let fallback = Path::new("/usr/bin/git");
    fallback.is_file().then(|| fallback.to_path_buf())
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

pub fn probe_git(
    path: Option<&Path>,
    cancelled: Option<&AtomicBool>,
) -> Result<GitInfo, ProbeFailure> {
    let Some(path) = path else {
        return Ok(GitInfo::unavailable("Git executable was not found in PATH"));
    };

    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(ProbeFailure::Cancelled);
    }

    let child = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let child = match child {
        Ok(child) => child,
        Err(error) => return Ok(GitInfo::unavailable(format!("Could not run Git: {error}"))),
    };
    let mut child = ChildGuard(child);
    let stdout = child.0.stdout.take().expect("stdout was piped");
    let stderr = child.0.stderr.take().expect("stderr was piped");
    let stdout_reader = thread::spawn(|| read_bounded(stdout));
    let stderr_reader = thread::spawn(|| read_bounded(stderr));
    let deadline = Instant::now() + PROBE_TIMEOUT;

    let status = loop {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            child.terminate();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(ProbeFailure::Cancelled);
        }
        match child.0.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                child.terminate();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(ProbeFailure::Timeout);
            }
            Err(_) => {
                child.terminate();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Ok(GitInfo::unavailable("Could not inspect Git process status"));
            }
        }
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_owned();
        return Ok(GitInfo::unavailable(if detail.is_empty() {
            format!("git --version exited with {status}")
        } else {
            format!("git --version exited with {status}: {detail}")
        }));
    }
    let version = String::from_utf8_lossy(&stdout).trim().to_owned();
    if version.is_empty() {
        return Ok(GitInfo::unavailable("git --version returned no version"));
    }
    Ok(GitInfo {
        available: true,
        version: Some(version),
        error: None,
    })
}

fn read_bounded(mut reader: impl Read) -> Vec<u8> {
    let mut captured = Vec::with_capacity(OUTPUT_LIMIT);
    let mut buffer = [0; 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(length) => {
                let remaining = OUTPUT_LIMIT.saturating_sub(captured.len());
                captured.extend_from_slice(&buffer[..length.min(remaining)]);
            }
        }
    }
    captured
}

#[cfg(test)]
mod tests {
    use super::{find_git, find_git_in_paths, probe_git};
    use std::fs;

    #[test]
    fn git_path_is_absolute_when_available() {
        if let Some(path) = find_git() {
            assert!(path.is_absolute());
        }
    }

    #[test]
    #[cfg(unix)]
    fn skips_non_executable_git_candidates() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("commitscope-git-path-{}", std::process::id()));
        let first = root.join("first");
        let second = root.join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let blocked = first.join("git");
        fs::write(&blocked, "not executable").unwrap();
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o644)).unwrap();
        let executable = second.join("git");
        fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths([&first, &second]).unwrap();
        let found = find_git_in_paths(Some(path)).unwrap();
        assert_eq!(found, executable.canonicalize().unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_git_is_reported_without_failing_the_probe() {
        let info = probe_git(None, None).unwrap();
        assert!(!info.available);
        assert_eq!(info.version, None);
        assert!(info.error.is_some());
    }
}
