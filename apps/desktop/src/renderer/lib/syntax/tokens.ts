/*
 * Syntax token model shared by the highlighting worker and the renderer. Tokens carry one
 * of six colour kinds (DESIGN section 11) or "plain"; the colours themselves live in CSS
 * (`--syn-*`). This module is loaded on the renderer's main thread, so it holds no Shiki
 * code and no tokenizer theme (see theme.ts).
 */
import type { SyntaxLanguage } from "./languages.js";

export type SyntaxTokenKind = "keyword" | "string" | "number" | "function" | "type" | "comment" | "plain";

export interface SyntaxToken {
  text: string;
  kind: SyntaxTokenKind;
}

/** Content above either limit is shown as plain text (DESIGN section 11 / ARCHITECTURE). */
export const MAX_HIGHLIGHT_BYTES = 256 * 1024;
export const MAX_HIGHLIGHT_LINES = 5_000;
/** Lines at least this long are left plain; the tokenizer's cost grows with line length. */
export const MAX_TOKENIZE_LINE_LENGTH = 2_000;
/** A request that has not finished in this time falls back to plain text. */
export const HIGHLIGHT_TIMEOUT_MS = 3_000;

/** Index order used by the compact worker encoding; do not reorder without both sides. */
export const SYNTAX_TOKEN_KINDS: readonly SyntaxTokenKind[] = ["plain", "keyword", "string", "number", "function", "type", "comment"];

/** UTF-8 size of the lines joined with "\n", stopping early once it passes `limit`. */
function utf8LengthAtMost(lines: readonly string[], limit: number): number {
  let bytes = Math.max(0, lines.length - 1);
  for (const line of lines) {
    for (let index = 0; index < line.length; index++) {
      const code = line.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < line.length) {
        const next = line.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; } else bytes += 3;
      } else bytes += 3;
    }
    if (bytes > limit) return bytes;
  }
  return bytes;
}

/** True when the content is too large to highlight and should stay plain. */
export function exceedsHighlightLimits(lines: readonly string[]): boolean {
  if (lines.length > MAX_HIGHLIGHT_LINES) return true;
  return utf8LengthAtMost(lines, MAX_HIGHLIGHT_BYTES) > MAX_HIGHLIGHT_BYTES;
}

// ---- Worker messages -----------------------------------------------------------------------

export interface HighlightRequest {
  id: number;
  lines: string[];
  language: SyntaxLanguage;
}

/**
 * Token lines in a transferable form: per line its token count, per token its kind index
 * (into SYNTAX_TOKEN_KINDS) and UTF-16 length. Texts are rebuilt from the caller's lines,
 * so no text crosses the worker boundary twice.
 */
export interface EncodedTokenLines {
  counts: Uint32Array;
  kinds: Uint8Array;
  lengths: Uint32Array;
}

export type HighlightResponse = { id: number; tokens: EncodedTokenLines } | { id: number; tokens: null };

export function encodeTokenLines(tokenLines: readonly (readonly SyntaxToken[])[]): EncodedTokenLines {
  let total = 0;
  for (const line of tokenLines) total += line.length;
  const counts = new Uint32Array(tokenLines.length);
  const kinds = new Uint8Array(total);
  const lengths = new Uint32Array(total);
  let at = 0;
  tokenLines.forEach((line, index) => {
    counts[index] = line.length;
    for (const token of line) {
      kinds[at] = SYNTAX_TOKEN_KINDS.indexOf(token.kind);
      lengths[at] = token.text.length;
      at++;
    }
  });
  return { counts, kinds, lengths };
}

/** Rebuilds token lines over `lines`; a line whose lengths do not add up stays plain. Null if the shape is wrong. */
export function decodeTokenLines(lines: readonly string[], encoded: EncodedTokenLines): SyntaxToken[][] | null {
  const { counts, kinds, lengths } = encoded;
  if (counts.length !== lines.length || kinds.length !== lengths.length) return null;
  const result: SyntaxToken[][] = [];
  let at = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const count = counts[index]!;
    if (at + count > kinds.length) return null;
    const tokens: SyntaxToken[] = [];
    let offset = 0;
    for (let end = at + count; at < end; at++) {
      const length = lengths[at]!;
      tokens.push({ text: line.slice(offset, offset + length), kind: SYNTAX_TOKEN_KINDS[kinds[at]!] ?? "plain" });
      offset += length;
    }
    result.push(offset === line.length ? tokens : line ? [{ text: line, kind: "plain" }] : []);
  }
  return at === kinds.length ? result : null;
}
