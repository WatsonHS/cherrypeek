import type { CommitIdentity, RefInfo } from "../../../../../packages/protocol/src/generated/server-message.js";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (value: number): string => String(value).padStart(2, "0");

export function parseGitTime(timestamp: string): Date | undefined {
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}

export function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fullTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock(date)}:${pad(date.getSeconds())}`;
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function calendarDayDiff(date: Date, now: Date): number {
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).valueOf();
  return Math.round((start(now) - start(date)) / 86_400_000);
}

export function dayLabel(date: Date, now: Date): string {
  const monthDay = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  const diff = calendarDayDiff(date, now);
  if (diff === 0) return `今天 · ${monthDay}`;
  if (diff === 1) return `昨天 · ${monthDay}`;
  const year = date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()} 年 `;
  return `${year}${monthDay} ${WEEKDAYS[date.getDay()]}`;
}

/** Compact age for lists: 刚刚, 5 分钟前, 3 小时前, 昨天, 11-02, 2025-11-02. */
export function relativeTime(unixMs: number, now = new Date()): string {
  const date = new Date(unixMs);
  if (Number.isNaN(date.valueOf())) return "";
  const elapsed = now.valueOf() - unixMs;
  const days = calendarDayDiff(date, now);
  if (elapsed >= 0 && days === 0) {
    if (elapsed < 60_000) return "刚刚";
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
    return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  }
  if (days === 1) return "昨天";
  if (date.getFullYear() === now.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return dayKey(date);
}

/** A point in time for sentences: 今天 14:30, 昨天 14:30, 11 月 2 日 14:30, 2025 年 11 月 2 日 14:30. */
export function momentLabel(unixMs: number, now = new Date()): string {
  const date = new Date(unixMs);
  if (Number.isNaN(date.valueOf())) return "";
  const days = calendarDayDiff(date, now);
  if (days === 0) return `今天 ${clock(date)}`;
  if (days === 1) return `昨天 ${clock(date)}`;
  const year = date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()} 年 `;
  return `${year}${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clock(date)}`;
}

/** Display-only path with the home directory shortened to ~. Never use the result as an operation target. */
export function homeAbbreviated(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** Local time plus the raw Git offset, which is kept verbatim. */
export function identityTime(identity: CommitIdentity): string {
  const date = parseGitTime(identity.timestamp);
  return `${date ? fullTime(date) : identity.timestamp} · Git 原始偏移 ${identity.offset}`;
}

export function zoneLabel(now = new Date()): string {
  const minutes = -now.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function repositoryName(path: string): string {
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return name || path;
}

export function shortOid(oid: string): string {
  return oid.slice(0, 8);
}

export function shortRefName(name: string): string {
  return name.replace(/^refs\/(heads|remotes|tags)\//, "");
}

/** The commit a ref points at; annotated tags resolve through peeledOid. */
export function refTarget(ref: RefInfo): string {
  return ref.peeledOid ?? ref.oid;
}

export function sameIdentity(a: CommitIdentity, b: CommitIdentity): boolean {
  return a.name === b.name && a.email === b.email && a.timestamp === b.timestamp && a.offset === b.offset;
}

/** Avatar initials, see docs/DESIGN.md section 7. */
export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = Array.from(trimmed)[0] ?? "?";
  if (/\p{Script=Han}/u.test(first)) return first;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${Array.from(words[0]!)[0]}${Array.from(words[1]!)[0]}`.toUpperCase();
  return Array.from(words[0] ?? trimmed).slice(0, 2).join("").toUpperCase();
}

/** Stable FNV-1a hash of the lowercased email (or name) mapped onto the 8-colour palette. */
export function paletteIndex(identity: Pick<CommitIdentity, "name" | "email">): number {
  const key = (identity.email || identity.name).toLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 8;
}
