// Calendar helpers for the history time slider: local days, their midnights and relative names.

export interface TimeTrackInputDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  count?: number;
}

export interface TimeTrackBounds {
  oldest: number;
  top: number;
}

export interface CommitScrollSample {
  top: number;
  bottom: number;
  seconds: number;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_SECONDS = 86_400;

/** Local midnight of `day` in Unix seconds. */
export function dayStartSeconds(day: string): number {
  const match = DAY.exec(day)!;
  return Math.round(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() / 1000);
}

/** Local calendar day of Unix `seconds`. */
export function localDay(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** "今天", "昨天", "10 天前", "约 3 个月前", "约 2 年前"; `today` is a local YYYY-MM-DD day. */
export function relativeDay(day: string, today: string): string {
  const days = Math.round((dayStartSeconds(today) - dayStartSeconds(day)) / DAY_SECONDS);
  if (days <= 0) return days === 0 ? "今天" : "以后";
  if (days === 1) return "昨天";
  if (days < 100) return `${days} 天前`;
  if (days < 730) return `约 ${Math.round(days / 30.4)} 个月前`;
  return `约 ${Math.round(days / 365.25)} 年前`;
}

/** Window lengths the automatic choice rounds up to, so scrolling does not keep changing the scale. */
const SPAN_STEPS = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 180, 270, 365, 547, 730, 1095, 1826, 3652]
  .map(days => days * DAY_SECONDS);

/**
 * How long a time window around `anchor` (Unix seconds) must be to hold about `target` commits.
 * Days are added nearest first on either side; a single busy day shortens it below a day.
 * `days` holds each day's local midnight and commit count, oldest first.
 */
export function windowSpanFor(days: { start: number; count: number }[], anchor: number, target: number): number {
  if (!days.length) return DAY_SECONDS;
  let older = days.findIndex(day => day.start > anchor) - 1;
  if (older === -2) older = days.length - 1;
  let newer = older + 1;
  let total = 0;
  let from = anchor;
  let to = anchor;
  while (total < target && (older >= 0 || newer < days.length)) {
    const olderGap = older >= 0 ? anchor - days[older]!.start : Infinity;
    const newerGap = newer < days.length ? days[newer]!.start + DAY_SECONDS - anchor : Infinity;
    const index = olderGap <= newerGap ? older : newer;
    total += days[index]!.count;
    from = Math.min(from, days[index]!.start);
    to = Math.max(to, days[index]!.start + DAY_SECONDS);
    if (index === older) older -= 1;
    else newer += 1;
  }
  const needed = Math.max(SPAN_STEPS[0]!, (to - from) * Math.min(1, total > 0 ? target / total : 1));
  return SPAN_STEPS.find(step => step >= needed) ?? needed;
}

/** Computes exact newest/oldest bounds for the slider without adding future midnight padding. */
export function timeTrackBounds(
  days: { start: number; count: number }[],
  options: {
    newestSeconds?: number | null;
    oldestSeconds?: number | null;
    nowSeconds?: number;
  } = {},
): TimeTrackBounds | null {
  if (!days.length) {
    if (options.newestSeconds != null) {
      const oldest = options.oldestSeconds ?? options.newestSeconds;
      return {
        oldest: Math.min(options.newestSeconds, oldest),
        top: Math.max(options.newestSeconds, oldest),
      };
    }
    return null;
  }
  const oldestDayStart = days[0]!.start;
  const newestDayStart = days.at(-1)!.start;
  let top: number;
  if (options.newestSeconds != null) {
    top = newestDayStart > options.newestSeconds ? newestDayStart + DAY_SECONDS : options.newestSeconds;
  } else {
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    top = Math.min(newestDayStart + DAY_SECONDS, Math.max(now, newestDayStart + 3600));
  }
  let oldest: number;
  if (options.oldestSeconds != null) {
    oldest = oldestDayStart + DAY_SECONDS <= options.oldestSeconds
      ? oldestDayStart
      : Math.min(top, options.oldestSeconds);
  } else {
    oldest = Math.min(top, oldestDayStart);
  }
  return { oldest, top: Math.max(oldest, top) };
}

/** Global progress in [0, 1] from newest (0) to oldest (1), driving where the thumb sits in the track. */
export function followProgressFor(
  days: { start: number; count: number }[],
  bounds: TimeTrackBounds,
  seconds: number,
  options: {
    fullWindowScrollRatio?: number | null;
    atTop?: boolean;
    atBottom?: boolean;
  } = {},
): number {
  if (options.atTop) return 0;
  if (options.atBottom) return 1;
  if (options.fullWindowScrollRatio != null) {
    return Math.min(1, Math.max(0, options.fullWindowScrollRatio));
  }
  if (bounds.top <= bounds.oldest || !days.length) return 0;
  const clamped = Math.min(bounds.top, Math.max(bounds.oldest, seconds));
  let total = 0;
  let newer = 0;
  for (const day of days) {
    total += day.count;
    const lo = Math.max(bounds.oldest, day.start);
    const hi = Math.min(bounds.top, day.start + DAY_SECONDS);
    if (hi <= lo) {
      if (clamped < lo) newer += day.count;
    } else if (clamped <= lo) {
      newer += day.count;
    } else if (clamped < hi) {
      newer += ((hi - clamped) / (hi - lo)) * day.count;
    }
  }
  return total > 0 ? Math.min(1, Math.max(0, newer / total)) : 0;
}

/** Maps the list's scroll offset to a continuous reading timestamp, smoothly reaching newest/oldest at the edges. */
export function viewportReadingSeconds(
  samples: readonly CommitScrollSample[],
  options: {
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
    readingOffsetPx: number;
    atNewest: boolean;
    atOldest: boolean;
    newestSeconds?: number | null;
    oldestSeconds?: number | null;
  },
): number | null {
  if (!samples.length) return options.newestSeconds ?? null;
  const maxScroll = Math.max(0, options.scrollHeight - options.clientHeight);
  const clampedTop = Math.min(Math.max(0, options.scrollTop), maxScroll);
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const topTarget = options.newestSeconds ?? first.seconds;
  const bottomTarget = options.oldestSeconds ?? last.seconds;

  if (options.atNewest && clampedTop <= 0.5) return topTarget;
  if (options.atOldest && maxScroll > 0 && clampedTop >= maxScroll - 0.5) return bottomTarget;

  const topProbe = clampedTop + Math.max(0, options.readingOffsetPx);
  let bottomT = 0;
  if (options.atOldest && maxScroll > 0) {
    const bottomRamp = Math.min(Math.max(1, options.clientHeight), maxScroll);
    bottomT = clampedTop <= maxScroll - bottomRamp ? 0 : (clampedTop - (maxScroll - bottomRamp)) / bottomRamp;
  }
  const probeY = topProbe + bottomT * Math.max(0, last.bottom - topProbe);

  let raw: number;
  if (probeY <= first.top) {
    raw = first.seconds;
  } else if (probeY >= last.top) {
    raw = last.seconds;
  } else {
    let low = 0;
    let high = samples.length - 2;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (samples[middle]!.top <= probeY) low = middle;
      else high = middle - 1;
    }
    const current = samples[low]!;
    const next = samples[low + 1]!;
    const span = Math.max(1, next.top - current.top);
    const frac = Math.min(1, Math.max(0, (probeY - current.top) / span));
    raw = current.seconds + frac * (next.seconds - current.seconds);
  }

  if (options.atNewest && first.seconds < topTarget && maxScroll > 0) {
    const topRamp = Math.min(180, maxScroll);
    if (clampedTop < topRamp) {
      raw = topTarget + (clampedTop / topRamp) * (raw - topTarget);
    }
  }
  if (options.atOldest && last.seconds > bottomTarget && bottomT > 0) {
    raw = raw + bottomT * (bottomTarget - raw);
  }
  return raw;
}
