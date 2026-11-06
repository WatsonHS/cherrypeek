use super::{BenchError, Outcome, check_active, elapsed_ms, map_gix_error};
use crate::{Job, Operation};
use gix::{
    ObjectId,
    objs::{Find, Kind},
    traverse::commit::topo::{Builder, Sorting},
};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::atomic::AtomicBool, time::Instant};

const MAX_OBJECT_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_OBJECT_BYTES: usize = 32 * 1024 * 1024;
const SCAN_ROUND_OIDS: usize = 100_001;
const SCAN_MAX_ROUNDS: u32 = 100;
pub(super) fn execute(
    job: &Job,
    cancelled: &AtomicBool,
    deadline: Instant,
    outcome: &mut Outcome,
    object_cache_bytes: usize,
    pack_cache_bytes: usize,
) -> Result<(), BenchError> {
    let open_start = Instant::now();
    let overrides = [
        "core.useReplaceRefs=false".to_owned(),
        format!("gitoxide.objects.allocLimit={MAX_OBJECT_BYTES}"),
        format!("core.deltaBaseCacheLimit={pack_cache_bytes}"),
        format!("gitoxide.core.deltaBaseCacheLimit={pack_cache_bytes}"),
    ];
    let options = gix::open::Options::isolated().cli_overrides(overrides);
    let opened = gix::open_opts(Path::new(&job.repository), options).map_err(map_open_error)?;
    let mut repo = opened;
    repo.object_cache_size(Some(object_cache_bytes));
    outcome.open_ms = elapsed_ms(open_start);
    check_active(cancelled, deadline)?;

    let oid_kind = repo.object_hash();
    if oid_kind.len_in_hex() != job.head_oid.len() {
        return Err(BenchError::new(
            "UNSUPPORTED_REPOSITORY",
            "The supplied HEAD OID does not match the repository object format",
        ));
    }
    if super::is_history_operation(job.operation) && repo.is_shallow().map_err(map_gix_error)? {
        return Err(BenchError::new(
            "UNSUPPORTED_SHALLOW",
            "The low-level topo iterator does not apply the repository shallow boundary",
        ));
    }

    match job.operation {
        Operation::Page => page(job, &repo, cancelled, deadline, outcome),
        Operation::Objects => objects(job, &repo, cancelled, deadline, outcome),
        Operation::Scan => scan(job, &repo, cancelled, deadline, outcome),
    }
}

fn page(
    job: &Job,
    repo: &gix::Repository,
    cancelled: &AtomicBool,
    deadline: Instant,
    outcome: &mut Outcome,
) -> Result<(), BenchError> {
    let tip = parse_oid(&job.head_oid)?;
    let walk_start = Instant::now();
    let result = walk_page(
        repo,
        tip,
        job.offset as usize,
        usize::from(job.limit),
        cancelled,
        deadline,
    );
    outcome.walk_ms = elapsed_ms(walk_start);
    let (page_oids, visited_count, has_more) = result?;
    outcome.visited_count = visited_count;
    outcome.has_more = has_more;
    outcome.oids = page_oids;

    let object_start = Instant::now();
    let returned_oids = outcome.oids.clone();
    let result = read_objects(repo, &returned_oids, cancelled, deadline, outcome);
    outcome.objects_ms = elapsed_ms(object_start);
    result
}

fn walk_page(
    repo: &gix::Repository,
    tip: ObjectId,
    offset: usize,
    limit: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(Vec<String>, u64, bool), BenchError> {
    check_active(cancelled, deadline)?;
    let mut walker = Builder::from_iters(
        BoundedFinder {
            repo,
            cancelled,
            deadline,
        },
        [tip],
        None::<Vec<ObjectId>>,
    )
    .sorting(Sorting::TopoOrder)
    .build()
    .map_err(|error| map_walk_error(error, cancelled, deadline))?;
    check_active(cancelled, deadline)?;

    let mut visited = 0u64;
    for _ in 0..offset {
        check_active(cancelled, deadline)?;
        if walker
            .next()
            .transpose()
            .map_err(|error| map_walk_error(error, cancelled, deadline))?
            .is_none()
        {
            return Ok((Vec::new(), visited, false));
        }
        visited += 1;
    }
    let mut result = Vec::with_capacity(limit + 1);
    for _ in 0..=limit {
        check_active(cancelled, deadline)?;
        let Some(info) = walker
            .next()
            .transpose()
            .map_err(|error| map_walk_error(error, cancelled, deadline))?
        else {
            break;
        };
        visited += 1;
        result.push(info.id.to_string());
    }
    let has_more = result.len() > limit;
    result.truncate(limit);
    Ok((result, visited, has_more))
}

fn scan(
    job: &Job,
    repo: &gix::Repository,
    cancelled: &AtomicBool,
    deadline: Instant,
    outcome: &mut Outcome,
) -> Result<(), BenchError> {
    let tip = parse_oid(&job.head_oid)?;
    let walk_start = Instant::now();
    let result = (|| {
        for round in 0..SCAN_MAX_ROUNDS {
            check_active(cancelled, deadline)?;
            let mut walker = Builder::from_iters(
                BoundedFinder {
                    repo,
                    cancelled,
                    deadline,
                },
                [tip],
                None::<Vec<ObjectId>>,
            )
            .sorting(Sorting::TopoOrder)
            .build()
            .map_err(|error| map_walk_error(error, cancelled, deadline))?;
            check_active(cancelled, deadline)?;
            let mut visited = 0usize;
            while visited < SCAN_ROUND_OIDS {
                check_active(cancelled, deadline)?;
                match walker
                    .next()
                    .transpose()
                    .map_err(|error| map_walk_error(error, cancelled, deadline))?
                {
                    Some(_info) => {
                        visited += 1;
                        outcome.visited_count = outcome.visited_count.saturating_add(1);
                    }
                    None => break,
                }
            }
            check_active(cancelled, deadline)?;
            outcome.completed_scans = Some(round + 1);
        }
        Ok(())
    })();
    outcome.walk_ms = elapsed_ms(walk_start);
    outcome.oids.clear();
    outcome.has_more = false;
    result
}

fn objects(
    job: &Job,
    repo: &gix::Repository,
    cancelled: &AtomicBool,
    deadline: Instant,
    outcome: &mut Outcome,
) -> Result<(), BenchError> {
    for oid in &job.oids {
        parse_oid(oid)?;
    }
    outcome.oids.clone_from(&job.oids);
    outcome.visited_count = job.oids.len() as u64;
    let start = Instant::now();
    let result = read_objects(repo, &job.oids, cancelled, deadline, outcome);
    outcome.objects_ms = elapsed_ms(start);
    result
}

fn read_objects(
    repo: &gix::Repository,
    oids: &[String],
    cancelled: &AtomicBool,
    deadline: Instant,
    outcome: &mut Outcome,
) -> Result<(), BenchError> {
    let mut total_bytes = 0usize;
    let mut digest = Sha256::new();
    for oid_text in oids {
        check_active(cancelled, deadline)?;
        let oid = parse_oid(oid_text)?;
        let header = repo
            .try_find_header(oid)
            .map_err(map_gix_error)?
            .ok_or_else(|| {
                BenchError::new("MISSING_OBJECT", format!("Object {oid_text} is missing"))
            })?;
        if header.kind() != Kind::Commit {
            return Err(BenchError::new(
                "UNSUPPORTED_OBJECT",
                format!("Object {oid_text} is not a commit"),
            ));
        }
        let object_size = header.size() as usize;
        if object_size > MAX_OBJECT_BYTES {
            return Err(BenchError::new(
                "RESOURCE_LIMIT",
                "Commit object exceeds 1 MiB",
            ));
        }
        total_bytes = total_bytes
            .checked_add(object_size)
            .filter(|sum| *sum <= MAX_TOTAL_OBJECT_BYTES)
            .ok_or_else(|| BenchError::new("RESOURCE_LIMIT", "Object reads exceed 32 MiB"))?;
        let object = repo.find_object(oid).map_err(map_gix_error)?;
        if object.kind != Kind::Commit || object.data.len() != object_size {
            return Err(BenchError::new(
                "GIX_ERROR",
                "Object header and raw object disagree",
            ));
        }
        let canonical_oid = oid.to_string();
        digest.update(canonical_oid.as_bytes());
        digest.update([0]);
        digest.update(object_size.to_string().as_bytes());
        digest.update([0]);
        digest.update(&object.data);
        outcome.raw_bytes = outcome.raw_bytes.saturating_add(object.data.len() as u64);
    }
    if !oids.is_empty() {
        outcome.objects_digest = Some(hex_digest(digest.finalize().as_slice()));
    }
    Ok(())
}

struct BoundedFinder<'repo> {
    repo: &'repo gix::Repository,
    cancelled: &'repo AtomicBool,
    deadline: Instant,
}

impl Find for BoundedFinder<'_> {
    fn try_find<'a>(
        &self,
        id: &gix::oid,
        buffer: &'a mut Vec<u8>,
    ) -> gix::Result<Option<gix::objs::Data<'a>>> {
        check_active(self.cancelled, self.deadline).map_err(as_gix_error)?;
        let Some(header) = self.repo.try_find_header(id.to_owned())? else {
            return Ok(None);
        };
        check_active(self.cancelled, self.deadline).map_err(as_gix_error)?;
        if header.size() as usize > MAX_OBJECT_BYTES {
            return Err(as_gix_error(BenchError::new(
                "RESOURCE_LIMIT",
                "Commit object exceeds 1 MiB",
            )));
        }
        let found = Find::try_find(self.repo, id, buffer)?;
        check_active(self.cancelled, self.deadline).map_err(as_gix_error)?;
        Ok(found)
    }
}

fn as_gix_error(error: BenchError) -> gix::Error {
    gix::Error::from_error(std::io::Error::other(format!(
        "{}: {}",
        error.code, error.message
    )))
}

fn map_walk_error(
    error: impl std::fmt::Display,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> BenchError {
    if let Err(error) = check_active(cancelled, deadline) {
        return error;
    }
    map_gix_error(error)
}

fn parse_oid(value: &str) -> Result<ObjectId, BenchError> {
    ObjectId::from_hex(value.as_bytes())
        .map_err(|error| BenchError::new("INVALID_JOB", format!("Invalid object ID: {error}")))
}

fn map_open_error(error: gix::Error) -> BenchError {
    let message = error.to_string();
    let lower = message.to_ascii_lowercase();
    let code = if lower.contains("does not appear to be a git repository")
        || lower.contains("not a git repository")
    {
        "NOT_A_REPOSITORY"
    } else {
        "GIX_ERROR"
    };
    BenchError::new(code, message)
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
