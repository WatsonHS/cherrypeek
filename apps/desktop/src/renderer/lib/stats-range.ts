import type { StatsBucket } from "../../../../../packages/protocol/src/generated/client-message.js";
import { parseLocalDateTime } from "./search-date.js";

/*
 * Time range and bucket rules of the statistics page. All day arithmetic goes through local calendar
 * fields (new Date(y, m, d + n)), never "+ 86400 s", so a day with a daylight-saving shift still starts at
 * local midnight. Ranges are half-open [startUnix, endUnix) in Unix seconds.
 */

export type RangePreset = "1h" | "3h" | "6h" | "12h" | "today" | "7d" | "30d" | "90d" | "custom";
export type BucketChoice = "auto" | StatsBucket;

export interface UnixRange { startUnix: number; endUnix: number }
export interface CustomDays {
  from: string;
  to: string;
  precise?: boolean;
  fromDateTime?: string;
  toDateTime?: string;
}

export const MAX_RANGE_DAYS = 3660;
export const MAX_BUCKETS = 3660;

const unix = (date: Date): number => Math.floor(date.getTime() / 1_000);
const localMidnight = (date: Date, dayOffset = 0): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset);

export function parseDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/** The range of a preset at `now`, or null for an invalid custom range. Day-based presets end at the next local midnight. */
export function presetRange(preset: RangePreset, now: Date, custom?: CustomDays): UnixRange | null {
  if (preset === "1h" || preset === "3h" || preset === "6h" || preset === "12h") {
    // Rounded up to the minute so repeated reads inside a minute ask for the same range.
    const hours = preset === "1h" ? 1 : preset === "3h" ? 3 : preset === "6h" ? 6 : 12;
    const end = Math.ceil(now.getTime() / 60_000) * 60;
    return { startUnix: end - hours * 3_600, endUnix: end };
  }
  if (preset === "custom") {
    if (custom?.precise) {
      const from = custom.fromDateTime ? parseLocalDateTime(custom.fromDateTime) : null;
      const to = custom.toDateTime ? parseLocalDateTime(custom.toDateTime) : null;
      if (!from || !to || from.getTime() > to.getTime()) return null;
      const range = { startUnix: unix(from), endUnix: unix(to) + 60 };
      return rangeDays(range) > MAX_RANGE_DAYS ? null : range;
    }
    const from = custom ? parseDay(custom.from) : null;
    const to = custom ? parseDay(custom.to) : null;
    if (!from || !to || from.getTime() > to.getTime()) return null;
    const range = { startUnix: unix(from), endUnix: unix(localMidnight(to, 1)) };
    return rangeDays(range) > MAX_RANGE_DAYS ? null : range;
  }
  const back = preset === "today" ? 0 : preset === "7d" ? 6 : preset === "30d" ? 29 : 89;
  return { startUnix: unix(localMidnight(now, -back)), endUnix: unix(localMidnight(now, 1)) };
}

export function rangeSeconds(range: UnixRange): number { return Math.max(0, range.endUnix - range.startUnix); }
export function rangeDays(range: UnixRange): number { return rangeSeconds(range) / 86_400; }

/** "Auto" bucket: <= 6 h ten minutes, <= 2 days hours, <= 120 days days, <= 2 years weeks, otherwise months. */
export function autoBucket(range: UnixRange): StatsBucket {
  const seconds = rangeSeconds(range);
  // Day-based ranges across a DST change differ from n * 24 h by an hour, so compare with a small tolerance.
  const tolerance = 3_600;
  if (seconds <= 6 * 3_600) return "tenMinutes";
  if (seconds <= 2 * 86_400 + tolerance) return "hour";
  if (seconds <= 120 * 86_400 + tolerance) return "day";
  if (seconds <= 730 * 86_400 + tolerance) return "week";
  return "month";
}

const BUCKET_SECONDS: Record<StatsBucket, number> = { tenMinutes: 600, hour: 3_600, day: 86_400, week: 7 * 86_400, month: 30 * 86_400 };

/** Why a manual bucket cannot be used for the range, or null. Too coarse: week needs 7 days, month 30; too fine: more than 3660 buckets. */
export function bucketDisabledReason(bucket: StatsBucket, range: UnixRange): "tooShort" | "tooLong" | null {
  const seconds = rangeSeconds(range);
  const tolerance = 3_600;
  if (bucket === "week" && seconds + tolerance < 7 * 86_400) return "tooShort";
  if (bucket === "month" && seconds + tolerance < 30 * 86_400) return "tooShort";
  if (seconds / BUCKET_SECONDS[bucket] > MAX_BUCKETS) return "tooLong";
  return null;
}

export function resolveBucket(choice: BucketChoice, range: UnixRange): StatsBucket {
  if (choice === "auto") return autoBucket(range);
  return bucketDisabledReason(choice, range) ? autoBucket(range) : choice;
}

/** The start of the bucket after the one starting at `startUnix`, on local calendar boundaries. */
export function bucketEnd(startUnix: number, bucket: StatsBucket): number {
  if (bucket === "tenMinutes") return startUnix + 600;
  if (bucket === "hour") return startUnix + 3_600;
  const start = new Date(startUnix * 1_000);
  if (bucket === "day") return unix(localMidnight(start, 1));
  if (bucket === "week") return unix(localMidnight(start, 7));
  return unix(new Date(start.getFullYear(), start.getMonth() + 1, 1));
}

/** A bucket clipped to the page range (the first bucket may start before it). */
export function clipToRange(startUnix: number, endUnix: number, range: UnixRange): UnixRange {
  return { startUnix: Math.max(startUnix, range.startUnix), endUnix: Math.min(endUnix, range.endUnix) };
}

export function bucketChartTitle(bucket: StatsBucket): string {
  switch (bucket) {
    case "tenMinutes": return "提交数 · 每 10 分钟";
    case "hour": return "每小时提交";
    case "day": return "每日提交";
    case "week": return "每周提交";
    case "month": return "每月提交";
  }
}

export function bucketUnitLabel(bucket: StatsBucket): string {
  return { tenMinutes: "10 分钟", hour: "小时", day: "天", week: "周", month: "月" }[bucket];
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Short label of a bucket start for tooltips and axes. */
export function bucketLabel(startUnix: number, bucket: StatsBucket): string {
  const date = new Date(startUnix * 1_000);
  const day = `${date.getMonth() + 1}/${date.getDate()}`;
  switch (bucket) {
    case "tenMinutes": return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    case "hour": return `${day} ${pad(date.getHours())}:00`;
    case "day": return day;
    case "week": return `${day} 起的一周`;
    case "month": return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  }
}

/** The wording after "比上一个": "6 小时", "30 天"; a single day reads "昨天". */
export function previousPeriodName(range: UnixRange): string {
  const seconds = rangeSeconds(range);
  if (seconds < 86_400 - 3_600) {
    const hours = Math.max(1, Math.round(seconds / 3_600));
    return `上一个 ${hours} 小时`;
  }
  const days = Math.max(1, Math.round(rangeDays(range)));
  return days === 1 ? "昨天" : `上一个 ${days} 天`;
}

/** "比上一个 7 天多 12" / "少 3" / "与上一个 7 天持平". */
export function compareText(current: number, previous: number, range: UnixRange): string {
  const name = previousPeriodName(range);
  if (current === previous) return `与${name}持平`;
  const diff = Math.abs(current - previous);
  return `比${name}${current > previous ? "多" : "少"} ${diff.toLocaleString("en-US")}`;
}

export type EvolutionRangeChoice = "all" | "90d" | "1y";

/** The optional survival range of the evolution analysis; null analyses the whole history. */
export function evolutionRange(choice: EvolutionRangeChoice, now: Date): UnixRange | null {
  if (choice === "all") return null;
  if (choice === "90d") return presetRange("90d", now);
  return { startUnix: unix(localMidnight(now, -364)), endUnix: unix(localMidnight(now, 1)) };
}

/** Hex of the UTF-8 bytes of a typed repository path; "" is the root. Leading and trailing slashes are dropped. */
export function pathToHex(text: string): string {
  const trimmed = text.trim().replace(/^\/+|\/+$/gu, "");
  let hex = "";
  for (const byte of new TextEncoder().encode(trimmed)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
