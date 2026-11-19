export type SearchDateRange = { fromTimestamp: number | null; toTimestamp: number | null };

export function localDateStart(date: Date): number {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor(start.getTime() / 1_000);
}

export function localCalendarRange(startDate: Date, endDateInclusive: Date): SearchDateRange {
  const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const end = new Date(endDateInclusive.getFullYear(), endDateInclusive.getMonth(), endDateInclusive.getDate());
  end.setDate(end.getDate() + 1);
  return { fromTimestamp: Math.floor(start.getTime() / 1_000), toTimestamp: Math.floor(end.getTime() / 1_000) };
}

export function presetDateRange(preset: "today" | "7days" | "30days", now = new Date()): SearchDateRange {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === "7days") start.setDate(start.getDate() - 6);
  if (preset === "30days") start.setDate(start.getDate() - 29);
  return localCalendarRange(start, now);
}

export function presetRelativeHours(hours: number, now = new Date()): SearchDateRange {
  const end = Math.ceil(now.getTime() / 60_000) * 60;
  return { fromTimestamp: end - Math.round(hours * 3_600), toTimestamp: end };
}

export function inputDateRange(from: string, to: string): SearchDateRange | null {
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);
  if (!start || !end || start.getTime() > end.getTime()) return null;
  return localCalendarRange(start, end);
}

export function inputDateTimeRange(from: string, to: string): SearchDateRange | null {
  const start = parseLocalDateTime(from);
  const end = parseLocalDateTime(to);
  if (!start || !end || start.getTime() > end.getTime()) return null;
  return {
    fromTimestamp: Math.floor(start.getTime() / 1_000),
    toTimestamp: Math.floor(end.getTime() / 1_000) + 60,
  };
}

export function localDateInput(date = new Date()): string {
  return `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
}

export function localDateTimeInput(date = new Date()): string {
  return `${localDateInput(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function hasSubDayTime(fromTimestamp: number | null, toTimestamp: number | null): boolean {
  for (const ts of [fromTimestamp, toTimestamp]) {
    if (ts === null) continue;
    const date = new Date(ts * 1_000);
    if (date.getHours() !== 0 || date.getMinutes() !== 0 || date.getSeconds() !== 0) return true;
  }
  return false;
}

export function formatSearchTimeRange(fromTimestamp: number | null, toTimestamp: number | null): string {
  if (fromTimestamp !== null && toTimestamp !== null) {
    if (hasSubDayTime(fromTimestamp, toTimestamp)) {
      const start = localDateTimeInput(new Date(fromTimestamp * 1_000)).replace("T", " ");
      const end = localDateTimeInput(new Date((toTimestamp - 1) * 1_000)).replace("T", " ");
      return start === end ? start : `${start} 至 ${end}`;
    }
    const startDay = localDateInput(new Date(fromTimestamp * 1_000));
    const endDay = localDateInput(new Date((toTimestamp - 1) * 1_000));
    return startDay === endDay ? startDay : `${startDay} 至 ${endDay}`;
  }
  if (fromTimestamp !== null) {
    const start = hasSubDayTime(fromTimestamp, null)
      ? localDateTimeInput(new Date(fromTimestamp * 1_000)).replace("T", " ")
      : localDateInput(new Date(fromTimestamp * 1_000));
    return `${start} 起`;
  }
  if (toTimestamp !== null) {
    const end = hasSubDayTime(null, toTimestamp)
      ? localDateTimeInput(new Date((toTimestamp - 1) * 1_000)).replace("T", " ")
      : localDateInput(new Date((toTimestamp - 1) * 1_000));
    return `截至 ${end}`;
  }
  return "";
}

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function parseLocalDateTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day &&
    date.getHours() === hour && date.getMinutes() === minute
    ? date
    : null;
}
