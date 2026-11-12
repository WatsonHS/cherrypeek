//! P5-01: operations the user triggers that write to the repository or use the network.
//!
//! This is the only module that builds a Git runner in operation mode. Each operation is a fixed
//! argument template; the caller supplies only validated names, never Git arguments.

use std::{
    ffi::OsString,
    path::Path,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

use commitscope_core::{ErrorCode, FetchRepositoryParams, FetchResult};

use crate::{
    details::{DetailError, now_unix_ms},
    git_command::{GitFailure, ReadOnlyGit, string_arg},
    session,
};

/// A fetch of a large repository over a slow link can take minutes; the user can cancel it.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(600);
const REMOTE_LIST_LIMIT: usize = 64 * 1024;
const MAX_REMOTES: usize = 64;
const MAX_REMOTE_NAME_BYTES: usize = 256;
const MAX_ERROR_CHARS: usize = 2000;

type OperationResult<T> = Result<T, DetailError>;

pub fn fetch_repository(
    executable: &Path,
    session: &session::RepositorySession,
    params: &FetchRepositoryParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> OperationResult<FetchResult> {
    fetch_at(
        executable,
        Path::new(&session.discovered.info.path),
        params,
        cancelled,
        deadline,
    )
}

fn fetch_at(
    executable: &Path,
    directory: &Path,
    params: &FetchRepositoryParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> OperationResult<FetchResult> {
    let reader = ReadOnlyGit::new(executable.to_path_buf()).map_err(from_git)?;
    let configured = list_remotes(&reader, directory, cancelled, deadline)?;
    if configured.is_empty() {
        return Err(operation_error(
            ErrorCode::InvalidRequest,
            "这个仓库没有配置远端，无法 fetch",
        ));
    }
    let remotes = match &params.remote {
        None => configured,
        Some(name) => {
            if !configured.contains(name) {
                return Err(operation_error(
                    ErrorCode::InvalidRequest,
                    "指定的远端不在这个仓库的远端列表里",
                ));
            }
            vec![name.clone()]
        }
    };

    let mut args: Vec<OsString> = ["fetch", "--quiet", "--no-recurse-submodules"]
        .into_iter()
        .map(string_arg)
        .collect();
    if params.prune {
        args.push(string_arg("--prune"));
    }
    match &params.remote {
        None => args.push(string_arg("--all")),
        Some(name) => {
            args.push(string_arg("--"));
            args.push(string_arg(name));
        }
    }
    let output = reader
        .for_operation()
        .run(directory, &args, None, 64 * 1024, cancelled, deadline)
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(operation_error(
            ErrorCode::GitError,
            &git_message(&output.stderr, "git fetch 失败"),
        ));
    }
    Ok(FetchResult {
        remotes,
        finished_at_unix_ms: now_unix_ms(),
    })
}

/// Remote names from the repository's configuration, read with the isolated read-only runner.
fn list_remotes(
    git: &ReadOnlyGit,
    directory: &Path,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> OperationResult<Vec<String>> {
    let output = git
        .run(
            directory,
            &[string_arg("remote")],
            None,
            REMOTE_LIST_LIMIT,
            cancelled,
            deadline,
        )
        .map_err(from_git)?;
    if !output.status.success() {
        return Err(operation_error(
            ErrorCode::GitError,
            &git_message(&output.stderr, "无法读取远端列表"),
        ));
    }
    let names: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|name| {
            // A name that could be read as an option never reaches a command line.
            !name.is_empty() && !name.starts_with('-') && name.len() <= MAX_REMOTE_NAME_BYTES
        })
        .map(str::to_owned)
        .collect();
    if names.len() > MAX_REMOTES {
        return Err(operation_error(
            ErrorCode::ResourceLimit,
            "远端数量超过上限，无法在这里 fetch",
        ));
    }
    Ok(names)
}

/// Git's own words, bounded; they are shown as untrusted text.
fn git_message(stderr: &[u8], fallback: &str) -> String {
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim();
    if text.is_empty() {
        return fallback.to_owned();
    }
    let mut message: String = text.chars().take(MAX_ERROR_CHARS).collect();
    if text.chars().count() > MAX_ERROR_CHARS {
        message.push('…');
    }
    message
}

fn operation_error(code: ErrorCode, message: &str) -> DetailError {
    DetailError {
        code,
        message: message.to_owned(),
        retryable: false,
    }
}

fn from_git(error: GitFailure) -> DetailError {
    match error {
        GitFailure::Cancelled => operation_error(ErrorCode::Cancelled, "操作已取消"),
        GitFailure::Timeout => operation_error(ErrorCode::Timeout, "操作超时，已停止"),
        GitFailure::ResourceLimit => {
            operation_error(ErrorCode::ResourceLimit, "Git 的输出超过上限，已停止")
        }
        GitFailure::Unavailable(message) => operation_error(ErrorCode::GitUnavailable, &message),
        GitFailure::CommandFailed(message) => operation_error(ErrorCode::GitError, &message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TestDir(PathBuf);

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn git_bin() -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|entry| entry.join(if cfg!(windows) { "git.exe" } else { "git" }))
            .find(|candidate| candidate.is_file())
            .expect("Git is available for the operation unit tests")
    }

    fn run(repository: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new(git_bin())
            .arg("-C")
            .arg(repository)
            .args([
                "-c",
                "user.name=Operation Test",
                "-c",
                "user.email=operation@example.invalid",
                "-c",
                "protocol.file.allow=always",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "commitscope-operations-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    fn commit(repository: &Path, file: &str, text: &str) {
        std::fs::write(repository.join(file), text).unwrap();
        run(repository, &["add", "."]);
        run(repository, &["commit", "--quiet", "-m", file]);
    }

    /// `upstream` with one commit on main and a `topic` branch, and a clone of it in `local`.
    fn fixture(label: &str) -> (PathBuf, PathBuf, TestDir) {
        let root = temp_root(label);
        let upstream = root.join("upstream");
        let local = root.join("local");
        std::fs::create_dir_all(&upstream).unwrap();
        run(&upstream, &["init", "--quiet", "-b", "main"]);
        commit(&upstream, "a.txt", "one\n");
        run(&upstream, &["branch", "topic"]);
        run(
            &root,
            &[
                "clone",
                "--quiet",
                upstream.to_str().unwrap(),
                local.to_str().unwrap(),
            ],
        );
        (upstream, local, TestDir(root))
    }

    fn fetch(local: &Path, remote: Option<&str>, prune: bool) -> OperationResult<FetchResult> {
        fetch_at(
            &git_bin(),
            local,
            &FetchRepositoryParams {
                remote: remote.map(str::to_owned),
                prune,
            },
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(30),
        )
    }

    /// Everything a fetch must leave alone: HEAD, local branches, the index and the working tree.
    fn local_state(local: &Path) -> (String, String, String, Vec<u8>) {
        (
            run(local, &["rev-parse", "HEAD"]),
            run(
                local,
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads",
                ],
            ),
            run(local, &["status", "--porcelain=v2", "--branch"]),
            std::fs::read(local.join(".git/index")).unwrap(),
        )
    }

    #[test]
    fn fetch_updates_remote_tracking_refs_and_nothing_local() {
        let (upstream, local, _guard) = fixture("fetch");
        commit(&upstream, "b.txt", "two\n");
        let new_tip = run(&upstream, &["rev-parse", "main"]);
        std::fs::write(local.join("dirty.txt"), "uncommitted").unwrap();
        let before = local_state(&local);
        assert_ne!(run(&local, &["rev-parse", "origin/main"]), new_tip);

        let result = fetch(&local, None, false).unwrap();

        assert_eq!(result.remotes, ["origin"]);
        assert_eq!(run(&local, &["rev-parse", "origin/main"]), new_tip);
        // `status --branch` reports the new behind count, so compare it without the branch header.
        let after = local_state(&local);
        assert_eq!(
            (&before.0, &before.1, &before.3),
            (&after.0, &after.1, &after.3)
        );
        assert!(after.2.contains("? dirty.txt"));
        assert_eq!(
            std::fs::read_to_string(local.join("dirty.txt")).unwrap(),
            "uncommitted"
        );
    }

    #[test]
    fn prune_is_opt_in() {
        let (upstream, local, _guard) = fixture("prune");
        run(&upstream, &["branch", "-D", "topic"]);
        fetch(&local, Some("origin"), false).unwrap();
        assert!(!run(&local, &["branch", "-r", "--list", "origin/topic"]).is_empty());
        fetch(&local, Some("origin"), true).unwrap();
        assert!(run(&local, &["branch", "-r", "--list", "origin/topic"]).is_empty());
    }

    #[test]
    fn a_repository_without_remotes_and_an_unknown_remote_are_refused_before_git_runs() {
        let (upstream, local, _guard) = fixture("refuse");
        assert_eq!(
            fetch(&upstream, None, false).unwrap_err().code,
            ErrorCode::InvalidRequest
        );
        for name in ["elsewhere", "--upload-pack=touch /tmp/x"] {
            assert_eq!(
                fetch(&local, Some(name), false).unwrap_err().code,
                ErrorCode::InvalidRequest
            );
        }
    }

    #[test]
    fn an_unreachable_remote_reports_git_s_words_and_leaves_the_repository_usable() {
        let (upstream, local, _guard) = fixture("unreachable");
        let moved = upstream.with_file_name("moved");
        std::fs::rename(&upstream, &moved).unwrap();
        let before = local_state(&local);
        let error = fetch(&local, None, false).unwrap_err();
        assert_eq!(error.code, ErrorCode::GitError);
        assert!(!error.message.is_empty());
        assert_eq!(before, local_state(&local));
        std::fs::rename(&moved, &upstream).unwrap();
        fetch(&local, None, false).unwrap();
    }

    #[test]
    fn a_cancelled_fetch_stops_without_running() {
        let (_upstream, local, _guard) = fixture("cancel");
        let error = fetch_at(
            &git_bin(),
            &local,
            &FetchRepositoryParams {
                remote: None,
                prune: false,
            },
            &AtomicBool::new(true),
            Instant::now() + Duration::from_secs(30),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
    }
}
