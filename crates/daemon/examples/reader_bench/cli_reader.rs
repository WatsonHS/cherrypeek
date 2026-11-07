use super::{BenchError, Outcome, check_active, elapsed_ms};
use crate::{
    Job, Operation,
    git_command::{CommandOutput, GitFailure, ReadOnlyGit},
};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::atomic::AtomicBool, time::Instant};

const MAX_OBJECT_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_OBJECT_BYTES: usize = 32 * 1024 * 1024;
const SCAN_ROUND_OIDS: usize = 100_001;
const SCAN_MAX_ROUNDS: u32 = 100;
const SCAN_STDOUT_LIMIT: usize = 8 * 1024 * 1024;

pub(super) fn execute(
    job: &Job,
    git: &ReadOnlyGit,
    cancelled: &AtomicBool,
    deadline: Instant,
    outcome: &mut Outcome,
) -> Result<(), BenchError> {
    match job.operation {
        Operation::Page => page(job, git, cancelled, deadline, outcome),
        Operation::Objects => objects(job, git, cancelled, deadline, outcome),
        Operation::Scan => scan(job, git, cancelled, deadline, outcome),
    }
}

fn page(
    job: &Job,
    git: &ReadOnlyGit,
    cancelled: &AtomicBool,
    deadline: Instant,
    outcome: &mut Outcome,
) -> Result<(), BenchError> {
    let walk_start = Instant::now();
    let args = [
        "rev-list".to_owned(),
        "--topo-order".to_owned(),
        format!("--skip={}", job.offset),
        format!("--max-count={}", usize::from(job.limit) + 1),
        job.head_oid.to_ascii_lowercase(),
        "--".to_owned(),
    ];
    let args = args.iter().map(|arg| arg.as_str()).collect::<Vec<_>>();
    let result = run_success(
        git,
        Path::new(&job.repository),
        &args,
        None,
        32 * 1024,
        cancelled,
        deadline,
    )
    .and_then(|output| parse_oid_lines(&output.stdout, job.head_oid.len()));
    outcome.walk_ms = elapsed_ms(walk_start);
    let mut oids = result?;
    check_active(cancelled, deadline)?;
    // Count only OIDs returned by this command, including the lookahead item.
    // Git does not expose how many graph nodes it visited internally.
    outcome.visited_count = oids.len() as u64;
    outcome.has_more = oids.len() > usize::from(job.limit);
    oids.truncate(usize::from(job.limit));
    outcome.oids = oids;

    let objects_start = Instant::now();
    let page_oids = outcome.oids.clone();
    let result = read_objects(
        git,
        &job.repository,
        &page_oids,
        cancelled,
        deadline,
        outcome,
    );
    outcome.objects_ms = elapsed_ms(objects_start);
    result
}

fn objects(
    job: &Job,
    git: &ReadOnlyGit,
    cancelled: &AtomicBool,
    deadline: Instant,
    outcome: &mut Outcome,
) -> Result<(), BenchError> {
    let start = Instant::now();
    let result = read_objects(
        git,
        &job.repository,
        &job.oids,
        cancelled,
        deadline,
        outcome,
    );
    outcome.objects_ms = elapsed_ms(start);
    outcome.oids.clone_from(&job.oids);
    result
}

fn scan(
    job: &Job,
    git: &ReadOnlyGit,
    cancelled: &AtomicBool,
    deadline: Instant,
    outcome: &mut Outcome,
) -> Result<(), BenchError> {
    let start = Instant::now();
    let result = (|| {
        for round in 0..SCAN_MAX_ROUNDS {
            check_active(cancelled, deadline)?;
            let args = [
                "rev-list".to_owned(),
                "--topo-order".to_owned(),
                format!("--max-count={SCAN_ROUND_OIDS}"),
                job.head_oid.to_ascii_lowercase(),
                "--".to_owned(),
            ];
            let args = args.iter().map(|arg| arg.as_str()).collect::<Vec<_>>();
            let result = run_success(
                git,
                Path::new(&job.repository),
                &args,
                None,
                SCAN_STDOUT_LIMIT,
                cancelled,
                deadline,
            )
            .and_then(|output| parse_oid_lines(&output.stdout, job.head_oid.len()));
            let oids = result?;
            check_active(cancelled, deadline)?;
            outcome.visited_count = outcome.visited_count.saturating_add(oids.len() as u64);
            outcome.completed_scans = Some(round + 1);
        }
        Ok(())
    })();
    outcome.walk_ms = elapsed_ms(start);
    outcome.oids.clear();
    outcome.has_more = false;
    result
}

fn read_objects(
    git: &ReadOnlyGit,
    repository: &str,
    oids: &[String],
    cancelled: &AtomicBool,
    deadline: Instant,
    outcome: &mut Outcome,
) -> Result<(), BenchError> {
    if oids.is_empty() {
        outcome.objects_digest = None;
        return Ok(());
    }
    let mut input = Vec::with_capacity(oids.len() * 65);
    for oid in oids {
        check_active(cancelled, deadline)?;
        input.extend_from_slice(oid.to_ascii_lowercase().as_bytes());
        input.push(b'\n');
    }
    let output_limit = MAX_TOTAL_OBJECT_BYTES + oids.len() * 80 + 1;
    let args = ["cat-file", "--batch"];
    let output = run_success(
        git,
        Path::new(repository),
        &args,
        Some(&input),
        output_limit,
        cancelled,
        deadline,
    )?;
    parse_object_frames(&output, oids, cancelled, deadline, outcome)
}

fn parse_object_frames(
    output: &CommandOutput,
    expected_oids: &[String],
    cancelled: &AtomicBool,
    deadline: Instant,
    outcome: &mut Outcome,
) -> Result<(), BenchError> {
    let mut cursor = 0usize;
    let mut total_bytes = 0usize;
    let mut digest = Sha256::new();
    for expected in expected_oids {
        check_active(cancelled, deadline)?;
        let header = take_line(&output.stdout, &mut cursor)?;
        let header = std::str::from_utf8(header)
            .map_err(|_| BenchError::new("GIT_ERROR", "cat-file returned a non-UTF-8 header"))?;
        let fields = header.split_ascii_whitespace().collect::<Vec<_>>();
        if fields.len() != 3 {
            if fields.len() == 2 && fields[1] == "missing" {
                return Err(BenchError::new(
                    "MISSING_OBJECT",
                    "Git could not find a requested object",
                ));
            }
            return Err(BenchError::new(
                "GIT_ERROR",
                "cat-file returned a malformed object header",
            ));
        }
        let expected = expected.to_ascii_lowercase();
        if fields[0] != expected {
            return Err(BenchError::new(
                "GIT_ERROR",
                "cat-file returned an unexpected object ID",
            ));
        }
        if fields[1] != "commit" {
            return Err(BenchError::new(
                "UNSUPPORTED_OBJECT",
                "Requested OID is not a commit",
            ));
        }
        let size = fields[2].parse::<usize>().map_err(|_| {
            BenchError::new("GIT_ERROR", "cat-file returned an invalid object size")
        })?;
        if size > MAX_OBJECT_BYTES {
            return Err(BenchError::new(
                "RESOURCE_LIMIT",
                "Commit object exceeds 1 MiB",
            ));
        }
        total_bytes = total_bytes
            .checked_add(size)
            .filter(|sum| *sum <= MAX_TOTAL_OBJECT_BYTES)
            .ok_or_else(|| BenchError::new("RESOURCE_LIMIT", "Object reads exceed 32 MiB"))?;
        let end = cursor
            .checked_add(size)
            .filter(|end| *end <= output.stdout.len())
            .ok_or_else(|| BenchError::new("GIT_ERROR", "cat-file ended inside an object"))?;
        let bytes = &output.stdout[cursor..end];
        cursor = end;
        if output.stdout.get(cursor) != Some(&b'\n') {
            return Err(BenchError::new(
                "GIT_ERROR",
                "cat-file object delimiter is missing",
            ));
        }
        cursor += 1;
        digest.update(expected.as_bytes());
        digest.update([0]);
        digest.update(size.to_string().as_bytes());
        digest.update([0]);
        digest.update(bytes);
        outcome.raw_bytes += size as u64;
    }
    if cursor != output.stdout.len() {
        return Err(BenchError::new(
            "GIT_ERROR",
            "cat-file returned trailing bytes",
        ));
    }
    outcome.objects_digest = Some(hex_digest(digest.finalize().as_slice()));
    Ok(())
}

fn parse_oid_lines(bytes: &[u8], oid_len: usize) -> Result<Vec<String>, BenchError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| BenchError::new("GIT_ERROR", "rev-list returned non-UTF-8 output"))?;
    let mut oids = Vec::new();
    for line in text.lines() {
        if line.len() != oid_len || !line.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(BenchError::new(
                "GIT_ERROR",
                "rev-list returned an invalid object ID",
            ));
        }
        oids.push(line.to_ascii_lowercase());
    }
    Ok(oids)
}

fn take_line<'a>(bytes: &'a [u8], cursor: &mut usize) -> Result<&'a [u8], BenchError> {
    let remaining = bytes
        .get(*cursor..)
        .ok_or_else(|| BenchError::new("GIT_ERROR", "cat-file output cursor overflow"))?;
    let end = remaining
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| BenchError::new("GIT_ERROR", "cat-file output has an incomplete header"))?;
    let line = &remaining[..end];
    *cursor += end + 1;
    Ok(line)
}

fn run_success(
    git: &ReadOnlyGit,
    repository: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    output_limit: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<CommandOutput, BenchError> {
    check_active(cancelled, deadline)?;
    let arguments = args.iter().map(|arg| (*arg).into()).collect::<Vec<_>>();
    let output = git
        .run(
            repository,
            &arguments,
            input,
            output_limit,
            cancelled,
            deadline,
        )
        .map_err(map_git_failure)?;
    if !output.status.success() {
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        let lower = diagnostic.to_ascii_lowercase();
        let code = if lower.contains("could not read")
            || lower.contains("bad object")
            || lower.contains("missing object")
            || lower.contains("promisor remote")
        {
            "MISSING_OBJECT"
        } else if lower.contains("not a git repository") {
            "NOT_A_REPOSITORY"
        } else {
            "GIT_ERROR"
        };
        return Err(BenchError::new(
            code,
            format!("Git exited {}: {}", output.status, diagnostic),
        ));
    }
    Ok(output)
}

pub(super) fn map_git_failure(error: GitFailure) -> BenchError {
    match error {
        GitFailure::Cancelled => BenchError::new("CANCELLED", "Git command was cancelled"),
        GitFailure::Timeout => {
            BenchError::new("TIMEOUT", "Git command exceeded the 30-second deadline")
        }
        GitFailure::ResourceLimit => {
            BenchError::new("RESOURCE_LIMIT", "Git output exceeded the limit")
        }
        GitFailure::CommandFailed(message) => BenchError::new("GIT_ERROR", message),
        GitFailure::Unavailable(message) => BenchError::new("GIT_UNAVAILABLE", message),
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}
