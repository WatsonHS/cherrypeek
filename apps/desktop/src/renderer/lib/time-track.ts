// Calendar helpers for the history time slider: local days, their midnights and relative names.

export interface TimeTrackInputDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  count?: number;
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
