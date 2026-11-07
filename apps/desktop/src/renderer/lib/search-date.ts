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

export function inputDateRange(from: string, to: string): SearchDateRange | null {
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);
  if (!start || !end || start.getTime() > end.getTime()) return null;
  return localCalendarRange(start, end);
}

export function localDateInput(date = new Date()): string {
  return `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
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
