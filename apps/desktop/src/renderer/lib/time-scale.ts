// Time scale for the history date rail: buckets over the whole commit span, and a
// fisheye that spreads the buckets near the pointer apart so single days can be picked.

export type TimeGranularity = "day" | "week" | "month" | "year";

export interface TimeScaleDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  count?: number;
}

export interface TimeBucket {
  key: string;
  startDay: string;
  endDay: string;
  /** Commits in the bucket; 0 means a gap with no commits. */
  count: number;
  /** Full label for the focused bucket, e.g. "2025 年 10 月 8 日 周三". */
  label: string;
  /** Compact label for neighbours, e.g. "10 月 8 日". */
  shortLabel: string;
  /** The day to jump to: the bucket's last day, never past the newest commit day. */
  jumpDay: string;
  /** First bucket (newest-first order) of a calendar year; drawn as a stronger tick. */
  yearStart: boolean;
}

export interface TimeScale {
  granularity: TimeGranularity;
  /** Newest first, contiguous from the newest to the oldest day. */
  buckets: TimeBucket[];
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/** Smallest spacing between buckets before magnification, in pixels. */
const MIN_BASE_GAP = 1.5;

function toOrdinal(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS);
}

function fromOrdinal(ordinal: number): string {
  return new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
}

function parts(ordinal: number): { year: number; month: number; date: number; weekday: number } {
  const value = new Date(ordinal * DAY_MS);
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, date: value.getUTCDate(), weekday: value.getUTCDay() };
}

function bucketStart(ordinal: number, granularity: TimeGranularity): number {
  if (granularity === "day") return ordinal;
  const { year, month, weekday } = parts(ordinal);
  if (granularity === "week") return ordinal - (weekday + 6) % 7; // weeks start on Monday
  if (granularity === "month") return Math.round(Date.UTC(year, month - 1, 1) / DAY_MS);
  return Math.round(Date.UTC(year, 0, 1) / DAY_MS);
}

function bucketEnd(start: number, granularity: TimeGranularity): number {
  if (granularity === "day") return start;
  if (granularity === "week") return start + 6;
  const { year, month } = parts(start);
  if (granularity === "month") return Math.round(Date.UTC(year, month, 1) / DAY_MS) - 1;
  return Math.round(Date.UTC(year + 1, 0, 1) / DAY_MS) - 1;
}

function labels(start: number, end: number, granularity: TimeGranularity, currentYear: number): { label: string; shortLabel: string } {
  const a = parts(start);
  const b = parts(end);
  const year = a.year === currentYear ? "" : `${a.year} 年 `;
  if (granularity === "day") return { label: `${year}${a.month} 月 ${a.date} 日 ${WEEKDAYS[a.weekday]}`, shortLabel: `${a.month} 月 ${a.date} 日` };
  if (granularity === "week") {
    const range = a.month === b.month ? `${a.month} 月 ${a.date}–${b.date} 日` : `${a.month} 月 ${a.date} 日–${b.month} 月 ${b.date} 日`;
    return { label: `${year}${range}`, shortLabel: `${a.month} 月 ${a.date} 日` };
  }
  if (granularity === "month") return { label: `${a.year} 年 ${a.month} 月`, shortLabel: `${a.month} 月` };
  return { label: `${a.year} 年`, shortLabel: `${a.year}` };
}

/** The coarsest-to-finest choice: the finest granularity whose buckets still fit the rail. */
export function chooseGranularity(spanDays: number, height: number): TimeGranularity {
  const fit = Math.max(8, Math.floor(height / MIN_BASE_GAP));
  if (spanDays <= fit) return "day";
  if (Math.ceil(spanDays / 7) + 1 <= fit) return "week";
  if (Math.ceil(spanDays / 30.4) + 1 <= fit) return "month";
  return "year";
}

/** Buckets covering every day from the newest to the oldest commit day, newest first. */
export function buildTimeScale(days: TimeScaleDay[], height: number, now = new Date()): TimeScale {
  const counts = new Map<number, number>();
  for (const entry of days) {
    const ordinal = toOrdinal(entry.day);
    if (ordinal === null) continue;
    counts.set(ordinal, (counts.get(ordinal) ?? 0) + Math.max(0, entry.count ?? 1));
  }
  if (!counts.size) return { granularity: "day", buckets: [] };
  const ordinals = [...counts.keys()];
  const newest = Math.max(...ordinals);
  const oldest = Math.min(...ordinals);
  const granularity = chooseGranularity(newest - oldest + 1, height);
  const buckets: TimeBucket[] = [];
  const currentYear = now.getFullYear();
  let previousYear: number | null = null;
  for (let start = bucketStart(newest, granularity); start >= bucketStart(oldest, granularity);) {
    const end = bucketEnd(start, granularity);
    let count = 0;
    for (let ordinal = Math.max(start, oldest); ordinal <= Math.min(end, newest); ordinal += 1) count += counts.get(ordinal) ?? 0;
    const year = parts(start).year;
    buckets.push({
      key: `${granularity}:${fromOrdinal(start)}`,
      startDay: fromOrdinal(start),
      endDay: fromOrdinal(end),
      count,
      ...labels(start, end, granularity, currentYear),
      jumpDay: fromOrdinal(Math.min(end, newest)),
      yearStart: previousYear !== null && year !== previousYear,
    });
    previousYear = year;
    start = bucketStart(start - 1, granularity);
  }
  return { granularity, buckets };
}

/** Index of the bucket that contains `day`, or -1. */
export function bucketIndexForDay(buckets: TimeBucket[], day: string | null): number {
  if (!day) return -1;
  return buckets.findIndex(bucket => bucket.startDay <= day && day <= bucket.endDay);
}

/**
 * Magnification for the fisheye so buckets right at the focus are about `targetGap` pixels apart.
 * 0 when the buckets are already that far apart.
 */
export function magnificationFor(height: number, bucketCount: number, targetGap = 20, max = 14): number {
  if (bucketCount <= 1 || height <= 0) return 0;
  return Math.min(max, Math.max(0, targetGap / (height / bucketCount) - 1));
}

/**
 * Sarkar–Brown fisheye on [0, 1]: the focus stays put, nearby positions spread out and both
 * ends stay fixed, so the order of buckets never changes.
 */
export function fisheye(position: number, focus: number, magnification: number): number {
  if (magnification <= 0) return position;
  const g = (x: number) => (magnification + 1) * x / (magnification * x + 1);
  if (position < focus) return focus <= 0 ? position : focus - focus * g((focus - position) / focus);
  return focus >= 1 ? position : focus + (1 - focus) * g((position - focus) / (1 - focus));
}

/** Resting position of bucket `index` on [0, 1]. */
export function basePosition(index: number, count: number): number {
  return count <= 0 ? 0 : (index + 0.5) / count;
}

/** The bucket with commits whose drawn position is closest to `position`; -1 when none has commits. */
export function nearestActiveBucket(buckets: TimeBucket[], positions: number[], position: number): number {
  let best = -1;
  let distance = Infinity;
  buckets.forEach((bucket, index) => {
    if (bucket.count <= 0) return;
    const next = Math.abs(positions[index]! - position);
    if (next < distance) {
      best = index;
      distance = next;
    }
  });
  return best;
}

/** Moves `steps` buckets with commits from `index` (positive is older); stays within the scale. */
export function stepActiveBucket(buckets: TimeBucket[], index: number, steps: number): number {
  const active = buckets.flatMap((bucket, position) => bucket.count > 0 ? [position] : []);
  if (!active.length) return -1;
  let base = active.indexOf(index);
  if (base === -1) {
    // `index` is a gap: one step older lands on the next older bucket, one step newer on the next newer one.
    const older = active.findIndex(position => position > index);
    const insertion = older === -1 ? active.length : older;
    base = steps > 0 ? insertion - 1 : insertion;
  }
  return active[Math.min(active.length - 1, Math.max(0, base + steps))]!;
}
