/*
 * Renderer side of syntax highlighting. One shared worker, created on first use, runs one
 * request at a time; queued requests can be cancelled, and a request that runs past the
 * timeout or crashes the worker resolves null (callers show plain text). Recent results
 * are kept in a small bounded cache so returning to a file does not flash plain text.
 */
import * as React from "react";
import { isSyntaxLanguage, type SyntaxLanguage } from "./languages.js";
import {
  HIGHLIGHT_TIMEOUT_MS, decodeTokenLines, exceedsHighlightLimits,
  type HighlightRequest, type HighlightResponse, type SyntaxToken,
} from "./tokens.js";

/** After this many worker crashes highlighting stays off for the session. */
const MAX_WORKER_FAILURES = 3;
const CACHE_MAX_ENTRIES = 24;
const CACHE_MAX_CHARS = 2 * 1024 * 1024;

interface Job {
  id: number;
  key: string;
  lines: readonly string[];
  language: SyntaxLanguage;
  settled: boolean;
  settle(tokens: SyntaxToken[][] | null): void;
}

let worker: Worker | null = null;
let workerFailures = 0;
let nextId = 1;
const queue: Job[] = [];
let running: { job: Job; timer: ReturnType<typeof setTimeout> } | null = null;

// Insertion order is recency order; keys hold the language and the full text.
const cache = new Map<string, SyntaxToken[][]>();
let cacheChars = 0;

function cacheKey(lines: readonly string[], language: SyntaxLanguage): string {
  return `${language}\n${lines.join("\n")}`;
}

function readCache(key: string): SyntaxToken[][] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function writeCache(key: string, tokens: SyntaxToken[][]): void {
  if (cache.has(key) || key.length > CACHE_MAX_CHARS) return;
  cache.set(key, tokens);
  cacheChars += key.length;
  for (const oldest of cache.keys()) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheChars <= CACHE_MAX_CHARS) break;
    cache.delete(oldest);
    cacheChars -= oldest.length;
  }
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (workerFailures >= MAX_WORKER_FAILURES) return null;
  try {
    worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module", name: "syntax-highlight" });
  } catch {
    workerFailures = MAX_WORKER_FAILURES;
    return null;
  }
  worker.onmessage = onWorkerMessage;
  worker.onerror = onWorkerFailure;
  worker.onmessageerror = onWorkerFailure;
  return worker;
}

function stopWorker(): void {
  worker?.terminate();
  worker = null;
}

function finishRunning(): Job | null {
  const current = running;
  running = null;
  if (!current) return null;
  clearTimeout(current.timer);
  return current.job;
}

function pump(): void {
  while (!running) {
    const job = queue.shift();
    if (!job) return;
    // A duplicate of a request that just finished (e.g. a remount) is answered from the cache.
    const cached = readCache(job.key);
    if (cached) { job.settle(cached); continue; }
    const target = ensureWorker();
    if (!target) {
      job.settle(null);
      continue;
    }
    running = { job, timer: setTimeout(onTimeout, HIGHLIGHT_TIMEOUT_MS) };
    const request: HighlightRequest = { id: job.id, lines: job.lines as string[], language: job.language };
    try {
      target.postMessage(request);
    } catch {
      finishRunning();
      job.settle(null);
    }
  }
}

function onWorkerMessage(event: MessageEvent<HighlightResponse>): void {
  if (!running || event.data.id !== running.job.id) return;
  const job = finishRunning()!;
  const tokens = event.data.tokens ? decodeTokenLines(job.lines, event.data.tokens) : null;
  // Kept even when the caller has gone, so coming back to the same content is instant.
  if (tokens) writeCache(job.key, tokens);
  job.settle(tokens);
  pump();
}

function onTimeout(): void {
  // The worker cannot be interrupted mid-tokenize; replace it so later requests are not stuck.
  const job = finishRunning();
  stopWorker();
  job?.settle(null);
  pump();
}

function onWorkerFailure(): void {
  workerFailures += 1;
  const job = finishRunning();
  stopWorker();
  job?.settle(null);
  if (workerFailures >= MAX_WORKER_FAILURES) for (const queued of queue.splice(0)) queued.settle(null);
  else pump();
}

function usable(lines: readonly string[], language: string | null): language is SyntaxLanguage {
  return !!language && isSyntaxLanguage(language) && workerFailures < MAX_WORKER_FAILURES && !exceedsHighlightLimits(lines);
}

/**
 * Highlights `lines` as one document in `language` (an id from `languageForPath`).
 * Resolves one token list per line, whose texts concatenate to that line, or null when
 * the content should be shown as plain text: unknown language, over the size limits,
 * worker failure or timeout, or `signal` aborted. Never rejects.
 */
export function highlightLines(lines: readonly string[], language: string | null, signal?: AbortSignal): Promise<SyntaxToken[][] | null> {
  if (signal?.aborted || !usable(lines, language)) return Promise.resolve(null);
  const key = cacheKey(lines, language);
  const cached = readCache(key);
  if (cached) return Promise.resolve(cached);
  return new Promise(resolve => {
    const onAbort = (): void => {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      job.settle(null);
    };
    const job: Job = {
      id: nextId++,
      key,
      lines,
      language,
      settled: false,
      settle(tokens) {
        if (job.settled) return;
        job.settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(tokens);
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    queue.push(job);
    pump();
  });
}

/** Cached tokens for exactly this content, without starting any work. */
function peekHighlight(lines: readonly string[], language: string | null): SyntaxToken[][] | null {
  return usable(lines, language) ? readCache(cacheKey(lines, language)) : null;
}

/**
 * Token lines for `lines`, or null while highlighting runs or when the content stays
 * plain. Re-runs when `lines` (by identity) or `language` changes, so memoize `lines`;
 * a result for previous inputs is never returned.
 */
export function useSyntaxLines(lines: readonly string[] | null, language: string | null): SyntaxToken[][] | null {
  const cached = React.useMemo(() => (lines ? peekHighlight(lines, language) : null), [lines, language]);
  const [result, setResult] = React.useState<{ lines: readonly string[]; language: string; tokens: SyntaxToken[][] | null } | null>(null);
  React.useEffect(() => {
    if (!lines || !language || cached) return;
    const controller = new AbortController();
    void highlightLines(lines, language, controller.signal).then(tokens => {
      if (!controller.signal.aborted) setResult({ lines, language, tokens });
    });
    return () => controller.abort();
  }, [lines, language, cached]);
  if (cached) return cached;
  return result && result.lines === lines && result.language === language ? result.tokens : null;
}
