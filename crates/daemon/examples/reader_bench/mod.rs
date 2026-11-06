mod cli_reader;
mod gix_reader;

use crate::{Backend, Job, Operation};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

const OBJECT_CACHE_BYTES: usize = 8 * 1024 * 1024;
const PACK_CACHE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub struct BenchError {
    pub code: String,
    pub message: String,
}

impl BenchError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into().chars().take(512).collect(),
        }
    }
}

#[derive(Default)]
pub struct Outcome {
    pub open_ms: f64,
    pub walk_ms: f64,
    pub objects_ms: f64,
    pub visited_count: u64,
    pub oids: Vec<String>,
    pub has_more: bool,
    pub raw_bytes: u64,
    pub objects_digest: Option<String>,
    pub completed_scans: Option<u32>,
}

pub fn execute(
    job: &Job,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> (Outcome, Option<BenchError>) {
    let mut outcome = Outcome::default();
    if matches!(job.operation, Operation::Scan) {
        outcome.completed_scans = Some(0);
    }
    let result = match job.backend {
        Backend::Cli => {
            let executable = Path::new(&job.git_executable).to_path_buf();
            match crate::git_command::ReadOnlyGit::new(executable) {
                Ok(git) => cli_reader::execute(job, &git, cancelled, deadline, &mut outcome),
                Err(error) => Err(cli_reader::map_git_failure(error)),
            }
        }
        Backend::Gix => gix_reader::execute(
            job,
            cancelled,
            deadline,
            &mut outcome,
            OBJECT_CACHE_BYTES,
            PACK_CACHE_BYTES,
        ),
    };
    (outcome, result.err())
}

pub(super) fn check_active(cancelled: &AtomicBool, deadline: Instant) -> Result<(), BenchError> {
    if cancelled.load(Ordering::Acquire) {
        Err(BenchError::new("CANCELLED", "Job was cancelled"))
    } else if Instant::now() >= deadline {
        Err(BenchError::new(
            "TIMEOUT",
            "Job exceeded the 30-second deadline",
        ))
    } else {
        Ok(())
    }
}

pub(super) fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

pub(super) fn map_gix_error(error: impl std::fmt::Display) -> BenchError {
    let message = error.to_string();
    let lower = message.to_ascii_lowercase();
    let code = if lower.contains("cancelled") {
        "CANCELLED"
    } else if lower.contains("timeout") {
        "TIMEOUT"
    } else if lower.contains("resource_limit") {
        "RESOURCE_LIMIT"
    } else if lower.contains("not found")
        || lower.contains("could not be found")
        || lower.contains("missing object")
        || lower.contains("object does not exist")
    {
        "MISSING_OBJECT"
    } else {
        "GIX_ERROR"
    };
    BenchError::new(code, message)
}

pub(super) fn is_history_operation(operation: Operation) -> bool {
    matches!(operation, Operation::Page | Operation::Scan)
}
