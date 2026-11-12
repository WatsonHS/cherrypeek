//! Bounded, cancellable statistics over a fixed metadata-index watermark.
use crate::{metadata_index::IndexError, session::RepositorySession, session_store::SessionStore};
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use commitscope_core::*;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

/// Called only inside the four dedicated statistics request threads, never the
/// dispatcher, interactive workers, indexer or operation workers. Threads exit
/// with their request, so the priority cannot leak into a later interactive job.
pub(crate) fn prepare_worker(
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), crate::details::DetailError> {
    if let Err(error) = lower_thread_priority() {
        eprintln!("commitscope-daemon: could not lower statistics thread priority: {error}");
    }
    let check = || {
        active(cancelled, deadline)
            .map_err(|e| crate::details::detail_error(e.code, &e.message, false))
    };
    // Deterministic integration-test gate; absent from release builds. Statistics
    // read SQLite without a Git child, so the normal Git wrapper cannot hold them.
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("COMMITSCOPE_TEST_STATS_GATE") {
        let path = std::path::PathBuf::from(path);
        if path.exists() {
            let _ = std::fs::write(path.with_extension("started"), b"started");
            while path.exists() {
                check()?;
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }
    check()
}

#[cfg(target_os = "macos")]
fn lower_thread_priority() -> std::io::Result<()> {
    // Darwin's qos_class_t is an unsigned enum; libc does not expose this API.
    unsafe extern "C" {
        fn pthread_set_qos_class_self_np(class: libc::c_uint, relative: libc::c_int)
        -> libc::c_int;
    }
    const QOS_CLASS_UTILITY: libc::c_uint = 0x11;
    // SAFETY: changes only the calling pthread, with valid QoS and relative priority.
    let error = unsafe { pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0) };
    if error == 0 {
        Ok(())
    } else {
        Err(std::io::Error::from_raw_os_error(error))
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn lower_thread_priority() -> std::io::Result<()> {
    // Linux nice values are per-thread. who=0 selects the calling thread, not
    // the process leader. Never raise an already lower inherited priority.
    // SAFETY: these calls take scalar arguments and do not access Rust memory.
    let current = unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) };
    let result = unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, current.max(10)) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
fn lower_thread_priority() -> std::io::Result<()> {
    // No supported thread-local background priority API here (including other
    // Unix platforms). POSIX nice may affect the entire process: do not use it.
    // Leave normal priority rather than lowering interactive/index/operation work.
    Ok(())
}

#[cfg(all(
    test,
    any(target_os = "macos", target_os = "linux", target_os = "android")
))]
mod priority_tests {
    use super::*;

    fn current_priority() -> i32 {
        #[cfg(target_os = "macos")]
        {
            unsafe extern "C" {
                fn pthread_get_qos_class_np(
                    thread: libc::pthread_t,
                    class: *mut libc::c_uint,
                    relative: *mut libc::c_int,
                ) -> libc::c_int;
            }
            let mut class = 0;
            let mut relative = 0;
            assert_eq!(
                unsafe {
                    pthread_get_qos_class_np(libc::pthread_self(), &mut class, &mut relative)
                },
                0
            );
            class as i32
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        unsafe {
            libc::getpriority(libc::PRIO_PROCESS, 0)
        }
    }

    #[test]
    fn statistics_priority_is_thread_local() {
        let before = current_priority();
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                lower_thread_priority().unwrap();
                let priority = current_priority();
                barrier.wait();
                barrier.wait();
                priority
            });
            barrier.wait();
            let during = current_priority();
            barrier.wait();
            let lowered = worker.join().unwrap();
            assert_eq!(
                during, before,
                "dispatcher/other workers keep their priority"
            );
            #[cfg(target_os = "macos")]
            assert_eq!(lowered, 0x11);
            #[cfg(any(target_os = "linux", target_os = "android"))]
            assert_eq!(lowered, before.max(10));
        });
    }
}

pub(crate) fn error(code: ErrorCode, message: &str) -> IndexError {
    IndexError {
        code,
        message: message.into(),
    }
}
pub(crate) fn active(cancelled: &AtomicBool, deadline: Instant) -> Result<(), IndexError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(error(ErrorCode::Cancelled, "统计已取消"));
    }
    if Instant::now() >= deadline {
        return Err(error(ErrorCode::Timeout, "统计超时，请缩小范围"));
    }
    Ok(())
}
pub(crate) fn local(t: i64, tz: Tz) -> Result<DateTime<Tz>, IndexError> {
    Utc.timestamp_opt(t, 0)
        .single()
        .map(|d| d.with_timezone(&tz))
        .ok_or_else(|| error(ErrorCode::InvalidRequest, "时间超出范围"))
}
fn midnight(date: NaiveDate, tz: Tz) -> Result<i64, IndexError> {
    let start = date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| error(ErrorCode::InvalidRequest, "日期无效"))?;
    // Some zones advance at midnight; locate the first valid local minute of that date.
    for minute in 0..1440 {
        if let Some(t) = tz
            .from_local_datetime(&(start + Duration::minutes(minute)))
            .earliest()
        {
            return Ok(t.timestamp());
        }
    }
    Err(error(ErrorCode::InvalidRequest, "该本地日期不存在"))
}
pub(crate) fn bucket_start(t: i64, tz: Tz, bucket: StatsBucket) -> Result<i64, IndexError> {
    let d = local(t, tz)?;
    match bucket {
        StatsBucket::TenMinutes => Ok(t - i64::from(d.minute() % 10) * 60 - i64::from(d.second())),
        StatsBucket::Hour => Ok(t - i64::from(d.minute()) * 60 - i64::from(d.second())),
        StatsBucket::Day => midnight(d.date_naive(), tz),
        StatsBucket::Week => midnight(
            d.date_naive() - Duration::days(i64::from(d.weekday().num_days_from_monday())),
            tz,
        ),
        StatsBucket::Month => midnight(d.date_naive().with_day(1).unwrap(), tz),
    }
}
pub(crate) fn bucket_grid(
    range: &StatsRange,
    tz: Tz,
    bucket: StatsBucket,
) -> Result<Vec<i64>, IndexError> {
    if range.start_unix >= range.end_unix
        || range
            .end_unix
            .checked_sub(range.start_unix)
            .is_none_or(|n| n > 3660 * 86400)
    {
        return Err(error(
            ErrorCode::InvalidRequest,
            "统计时间范围须大于零且不超过十年",
        ));
    }
    let mut start = bucket_start(range.start_unix, tz, bucket)?;
    let mut out = Vec::new();
    while start < range.end_unix {
        if out.len() >= 3660 {
            return Err(error(
                ErrorCode::ResourceLimit,
                "时间桶超过 3660，请增大粒度",
            ));
        }
        out.push(start);
        start = match bucket {
            StatsBucket::TenMinutes => start + 600,
            StatsBucket::Hour => start + 3600,
            StatsBucket::Day | StatsBucket::Week => midnight(
                local(start, tz)?.date_naive()
                    + Duration::days(if bucket == StatsBucket::Day { 1 } else { 7 }),
                tz,
            )?,
            StatsBucket::Month => {
                let d = local(start, tz)?;
                midnight(
                    NaiveDate::from_ymd_opt(
                        if d.month() == 12 {
                            d.year() + 1
                        } else {
                            d.year()
                        },
                        if d.month() == 12 { 1 } else { d.month() + 1 },
                        1,
                    )
                    .ok_or_else(|| error(ErrorCode::InvalidRequest, "日期超限"))?,
                    tz,
                )?
            }
        };
    }
    Ok(out)
}
fn commit_type(summary: &str) -> String {
    let Some((left, right)) = summary.split_once(':') else {
        return "other".into();
    };
    if !right.starts_with(' ') {
        return "other".into();
    }
    let prefix = left.split(['(', '!']).next().unwrap_or("");
    let suffix = &left[prefix.len()..];
    let valid_suffix = suffix.is_empty()
        || suffix == "!"
        || (suffix.starts_with('(') && (suffix.ends_with(')') || suffix.ends_with(")!")));
    if prefix.is_empty()
        || prefix.len() > 32
        || !prefix.bytes().all(|b| b.is_ascii_lowercase())
        || !valid_suffix
    {
        "other".into()
    } else {
        prefix.into()
    }
}
pub fn activity_overview(
    session: &RepositorySession,
    params: &GetActivityOverviewParams,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<ActivityOverview, IndexError> {
    let tz = params
        .query
        .time_zone
        .parse::<Tz>()
        .map_err(|_| error(ErrorCode::InvalidRequest, "时区无效"))?;
    let grid = bucket_grid(&params.range, tz, params.bucket)?;
    crate::search::with_stats_rows(
        &SessionStore::from_env(),
        session,
        &params.query,
        cancelled,
        deadline,
        |_, snapshot, rows| {
            let mut buckets: BTreeMap<i64, u64> = grid.into_iter().map(|t| (t, 0)).collect();
            let mut days = BTreeMap::<NaiveDate, u64>::new();
            let mut authors = BTreeMap::<(String, String), u64>::new();
            let mut previous_days = BTreeSet::new();
            let mut previous_authors = BTreeSet::new();
            let mut previous_count = 0;
            let mut week_hour = vec![vec![0; 24]; 7];
            let mut types = BTreeMap::<String, u64>::new();
            let (mut merge_count, mut revert_count, mut fixup_count) = (0, 0, 0);
            let mut selected = HashMap::new();
            let mut events = Vec::new();
            let previous_start = params
                .range
                .start_unix
                .checked_sub(params.range.end_unix - params.range.start_unix)
                .ok_or_else(|| error(ErrorCode::InvalidRequest, "上周期超出范围"))?;
            for (c, t, matched) in &rows {
                active(cancelled, deadline)?;
                if !matched {
                    continue;
                }
                let date = local(*t, tz)?;
                if *t >= previous_start && *t < params.range.start_unix {
                    previous_count += 1;
                    previous_days.insert(date.date_naive());
                    previous_authors.insert((c.author.name.clone(), c.author.email.clone()));
                }
                if *t < params.range.start_unix || *t >= params.range.end_unix {
                    continue;
                }
                selected.insert(c.oid.as_str(), *t);
                events.push((*t, format!("{} <{}>", c.author.name, c.author.email)));
                *days.entry(date.date_naive()).or_default() += 1;
                *authors
                    .entry((c.author.name.clone(), c.author.email.clone()))
                    .or_default() += 1;
                week_hour[date.weekday().num_days_from_monday() as usize][date.hour() as usize] +=
                    1;
                if let Some(count) = buckets.get_mut(&bucket_start(*t, tz, params.bucket)?) {
                    *count += 1;
                }
                if c.parents.len() > 1 {
                    merge_count += 1;
                } else {
                    *types.entry(commit_type(&c.summary)).or_default() += 1;
                }
                if c.summary.starts_with("Revert") {
                    revert_count += 1;
                }
                if c.summary.starts_with("fixup!") || c.summary.starts_with("squash!") {
                    fixup_count += 1;
                }
            }
            let totals = ActivityTotals {
                commits: selected.len() as u64,
                active_days: days.len() as u64,
                authors: authors.len() as u64,
            };
            let mut longest_streak = 0;
            let mut longest_gap = 0;
            let mut streak = 0;
            let mut previous: Option<NaiveDate> = None;
            for day in days.keys() {
                if let Some(last) = previous {
                    let gap = (*day - last).num_days();
                    if gap == 1 {
                        streak += 1;
                    } else {
                        streak = 1;
                    }
                    longest_gap = longest_gap.max((gap - 1).max(0) as u64);
                } else {
                    streak = 1;
                }
                longest_streak = longest_streak.max(streak);
                previous = Some(*day);
            }
            let busiest_day = days
                .iter()
                .max_by_key(|(day, count)| (**count, std::cmp::Reverse(**day)))
                .map(|(d, n)| ActivityDay {
                    day: d.to_string(),
                    count: *n,
                });
            let mut authors: Vec<_> = authors
                .into_iter()
                .map(|((name, email), count)| ActivityAuthor { name, email, count })
                .collect();
            authors.sort_by(|a, b| {
                b.count
                    .cmp(&a.count)
                    .then(a.email.cmp(&b.email))
                    .then(a.name.cmp(&b.name))
            });
            let authors_truncated = authors.len() > 500;
            authors.truncate(500);
            let matching_times: HashMap<&str, i64> = rows
                .iter()
                .filter(|(_, _, matched)| *matched)
                .map(|(c, t, _)| (c.oid.as_str(), *t))
                .collect();
            let parents: HashMap<&str, &[String]> = rows
                .iter()
                .map(|(c, _, _)| (c.oid.as_str(), c.parents.as_slice()))
                .collect();
            let refs: Vec<_> = session
                .discovered
                .refs
                .iter()
                .filter(|r| r.kind == RefKind::LocalBranch)
                .collect();
            let branches_truncated = refs.len() > 200;
            let mut branches = Vec::new();
            let mut visits = 0usize;
            for r in refs.into_iter().take(200) {
                let mut pending = vec![r.oid.as_str()];
                let mut seen = HashSet::new();
                let mut count = 0;
                let mut last = None;
                let mut complete =
                    !crate::repository::history_boundary_limited(&session.discovered);
                while let Some(oid) = pending.pop() {
                    active(cancelled, deadline)?;
                    if !seen.insert(oid) {
                        continue;
                    }
                    visits += 1;
                    if visits > 5_000_000 {
                        return Err(error(
                            ErrorCode::ResourceLimit,
                            "分支可达性计算超过上限，请缩小范围",
                        ));
                    }
                    if selected.contains_key(oid) {
                        count += 1;
                    }
                    if let Some(t) = matching_times.get(oid) {
                        last = Some(last.map_or(*t, |v: i64| v.max(*t)));
                    }
                    if let Some(ps) = parents.get(oid) {
                        pending.extend(ps.iter().map(String::as_str));
                    } else {
                        complete = false;
                    }
                }
                branches.push(BranchActivity {
                    ref_name: r.name.clone(),
                    count,
                    last_commit_unix: last,
                    complete,
                });
            }
            events.sort();
            let mut sessions: Vec<ActivitySession> = Vec::new();
            if params.range.end_unix - params.range.start_unix <= 86400 {
                for (t, author) in events {
                    if let Some(s) = sessions.last_mut().filter(|s| t - (s.end_unix - 1) <= 600) {
                        s.end_unix = t + 1;
                        s.count += 1;
                        if !s.authors.contains(&author) {
                            s.authors.push(author);
                        }
                    } else {
                        sessions.push(ActivitySession {
                            start_unix: t,
                            end_unix: t + 1,
                            count: 1,
                            authors: vec![author],
                        });
                    }
                }
            }
            let sessions_truncated = sessions.len() > 50;
            sessions.truncate(50);
            Ok(ActivityOverview {
                coverage: MetadataIndexCoverage {
                    processed: snapshot.watermark,
                    complete: snapshot.complete,
                },
                buckets: buckets
                    .into_iter()
                    .map(|(start_unix, count)| ActivityBucket { start_unix, count })
                    .collect(),
                totals,
                previous_totals: ActivityTotals {
                    commits: previous_count,
                    active_days: previous_days.len() as u64,
                    authors: previous_authors.len() as u64,
                },
                rhythm: ActivityRhythm {
                    longest_streak_days: longest_streak,
                    longest_gap_days: longest_gap,
                    busiest_day,
                },
                week_hour,
                types: types
                    .into_iter()
                    .map(|(prefix, count)| CommitTypeCount { prefix, count })
                    .collect(),
                merge_count,
                revert_count,
                fixup_count,
                authors,
                authors_truncated,
                branches,
                branches_truncated,
                sessions,
                sessions_truncated,
            })
        },
    )
}
