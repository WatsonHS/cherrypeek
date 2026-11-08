/*
 * Turns a unified patch from the core into rows for the unified and the side-by-side views.
 * Both views come from the same parse, so line numbers and +/- counts always agree.
 */

export type DiffLineKind = "meta" | "hunk" | "context" | "add" | "del" | "notice";

export interface DiffLine {
  kind: DiffLineKind;
  oldNumber: number | null;
  newNumber: number | null;
  /** Line text without the leading +, - or space. */
  text: string;
  /** Index of the hunk the line belongs to; -1 for header lines before the first hunk. */
  hunk: number;
}

export interface ParsedDiff {
  lines: DiffLine[];
  hunkCount: number;
  additions: number;
  deletions: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

export function parseUnifiedPatch(patch: string): ParsedDiff {
  const raw = patch.split("\n");
  if (raw.at(-1) === "") raw.pop();
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let hunk = -1;
  let additions = 0;
  let deletions = 0;
  for (const text of raw) {
    const header = text.match(HUNK_HEADER);
    if (header) {
      hunk += 1;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      lines.push({ kind: "hunk", oldNumber: null, newNumber: null, text, hunk });
      continue;
    }
    if (hunk < 0) {
      lines.push({ kind: "meta", oldNumber: null, newNumber: null, text, hunk });
      continue;
    }
    if (text.startsWith("\\")) {
      lines.push({ kind: "notice", oldNumber: null, newNumber: null, text, hunk });
    } else if (text.startsWith("+")) {
      additions += 1;
      lines.push({ kind: "add", oldNumber: null, newNumber: newLine++, text: text.slice(1), hunk });
    } else if (text.startsWith("-")) {
      deletions += 1;
      lines.push({ kind: "del", oldNumber: oldLine++, newNumber: null, text: text.slice(1), hunk });
    } else {
      lines.push({ kind: "context", oldNumber: oldLine++, newNumber: newLine++, text: text.startsWith(" ") ? text.slice(1) : text, hunk });
    }
  }
  return { lines, hunkCount: hunk + 1, additions, deletions };
}

export interface Segment {
  text: string;
  changed: boolean;
}

export interface SplitSide {
  kind: "context" | "add" | "del" | "empty";
  number: number | null;
  text: string;
  /** Present on paired changed lines: the part that differs is marked. */
  segments: Segment[] | null;
}

export type SplitRow =
  | { kind: "meta" | "hunk" | "notice"; text: string; hunk: number }
  | { kind: "pair"; left: SplitSide; right: SplitSide; hunk: number };

const EMPTY: SplitSide = { kind: "empty", number: null, text: "", segments: null };

/**
 * Marks what changed between a removed line and the line that replaced it by trimming the
 * common start and end. Lines that share almost nothing are left unmarked as a whole.
 */
export function changedSegments(before: string, after: string): [Segment[], Segment[]] | null {
  const a = Array.from(before);
  const b = Array.from(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const common = start + (a.length - endA);
  if (common === 0 || common < Math.min(a.length, b.length) * 0.3) return null;
  const pieces = (chars: string[], end: number): Segment[] => [
    { text: chars.slice(0, start).join(""), changed: false },
    { text: chars.slice(start, end).join(""), changed: true },
    { text: chars.slice(end).join(""), changed: false },
  ].filter(segment => segment.text !== "");
  return [pieces(a, endA), pieces(b, endB)];
}

/** Pairs each run of removed lines with the added lines that follow it; the shorter side gets empty rows. */
export function splitRows(parsed: ParsedDiff): SplitRow[] {
  const rows: SplitRow[] = [];
  const { lines } = parsed;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === "meta" || line.kind === "hunk" || line.kind === "notice") {
      rows.push({ kind: line.kind, text: line.text, hunk: line.hunk });
      index += 1;
      continue;
    }
    if (line.kind === "context") {
      rows.push({
        kind: "pair", hunk: line.hunk,
        left: { kind: "context", number: line.oldNumber, text: line.text, segments: null },
        right: { kind: "context", number: line.newNumber, text: line.text, segments: null },
      });
      index += 1;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (index < lines.length && lines[index]!.kind === "del") removed.push(lines[index++]!);
    while (index < lines.length && lines[index]!.kind === "add") added.push(lines[index++]!);
    for (let pair = 0; pair < Math.max(removed.length, added.length); pair += 1) {
      const before = removed[pair];
      const after = added[pair];
      const marks = before && after ? changedSegments(before.text, after.text) : null;
      rows.push({
        kind: "pair", hunk: (before ?? after)!.hunk,
        left: before ? { kind: "del", number: before.oldNumber, text: before.text, segments: marks?.[0] ?? null } : EMPTY,
        right: after ? { kind: "add", number: after.newNumber, text: after.text, segments: marks?.[1] ?? null } : EMPTY,
      });
    }
  }
  return rows;
}
