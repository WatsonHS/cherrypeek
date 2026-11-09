import type { WorkspaceChange, WorkspaceDiff, WorkspaceEntry, WorkspaceFile, WorkspaceStatus } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositorySessionApi, RepositorySessionResult } from "../../../../../packages/protocol/src/repository-session.js";
import type { WorkspaceIndicator } from "./workspace-indicator.js";

/*
 * State of the workspace page and the top-bar badge (P4-09). The status is re-read when the
 * repository opens, the window gains focus, the main process hints that files changed, the page
 * is shown or the user refreshes. A change hint keeps the previous numbers but marks them stale
 * until the next read lands. Hints only lead to reads while the window is visible, and their reads
 * keep a gap of at least 3 s or ten times the last read's duration (up to 60 s); hint reads that
 * find nothing new double that gap, e.g. while a build writes to ignored directories.
 */

export type WorkspaceApi = Pick<RepositorySessionApi, "readWorkspaceStatus" | "readWorkspaceDiff" | "readWorkspaceFile" | "cancelWorkspace">;

export type WorkspaceGroup = "conflict" | "staged" | "unstaged" | "untracked";

export interface WorkspaceItem {
  group: WorkspaceGroup;
  entry: WorkspaceEntry;
  /** The change shown in this group; null for conflicts and untracked files. */
  change: WorkspaceChange | null;
  /** The same path also appears in the other of staged / unstaged. */
  alsoIn: "staged" | "unstaged" | null;
}

export interface WorkspaceSelection {
  group: WorkspaceGroup;
  pathHex: string;
}

export interface WorkspaceContent {
  key: string;
  state: "loading" | "ready" | "error";
  diff: WorkspaceDiff | null;
  file: WorkspaceFile | null;
  error: { code: string; message: string } | null;
  /** The file was over the whole-file limit, so `diff` holds only the changes. */
  fullFileLimited?: boolean;
}

export interface WorkspaceView {
  supported: boolean;
  bare: boolean;
  repoKey: string | null;
  status: WorkspaceStatus | null;
  loading: boolean;
  error: { code: string; message: string } | null;
  /** Files changed after the last read; the numbers shown may be out of date. */
  stale: boolean;
  selection: WorkspaceSelection | null;
  content: WorkspaceContent | null;
  previewLines: number;
}

export const MAX_ENTRIES = 2000;
export const PREVIEW_LINES = 200;
export const PREVIEW_STEP = 500;
const MIN_INTERVAL_MS = 3_000;
const MAX_INTERVAL_MS = 60_000;
const CHANGE_DEBOUNCE_MS = 1_000;
const BUSY_RETRY_MS = 1_500;

const GROUP_ORDER: WorkspaceGroup[] = ["conflict", "staged", "unstaged", "untracked"];

/** Splits the status into the four groups the page lists; a path with staged and unstaged changes appears in both. */
export function workspaceItems(status: WorkspaceStatus | null): WorkspaceItem[] {
  if (!status) return [];
  const items: WorkspaceItem[] = [];
  for (const group of GROUP_ORDER) {
    for (const entry of status.entries) {
      if (group === "conflict" && entry.conflict) items.push({ group, entry, change: null, alsoIn: null });
      else if (group === "staged" && !entry.conflict && entry.staged) items.push({ group, entry, change: entry.staged, alsoIn: entry.unstaged ? "unstaged" : null });
      else if (group === "unstaged" && !entry.conflict && entry.unstaged) items.push({ group, entry, change: entry.unstaged, alsoIn: entry.staged ? "staged" : null });
      else if (group === "untracked" && !entry.conflict && entry.untracked) items.push({ group, entry, change: null, alsoIn: null });
    }
  }
  return items;
}

/** What the top bar shows. Only a complete, current read with no entries counts as clean. */
export function workspaceIndicatorFor(view: WorkspaceView): WorkspaceIndicator {
  if (view.bare) return { state: "bare" };
  if (!view.supported) return { state: "unavailable", reason: "核心还不能读取工作区（占位 · P4-09）" };
  const status = view.status;
  if (view.error && (!status || !view.loading)) return { state: "error", message: view.error.message };
  if (!status) return { state: "loading" };
  if (status.complete && status.entries.length === 0) {
    return view.stale || view.loading ? { state: "loading" } : { state: "clean", observedAtUnixMs: status.observedAtUnixMs };
  }
  return { state: "changes", files: status.totalPaths, conflicts: status.conflictCount, complete: status.complete, stale: view.stale, observedAtUnixMs: status.observedAtUnixMs };
}

/**
 * Whether the page may say "工作区干净": the latest finished read was complete and empty, and it has not
 * failed or gone stale since. A re-read in progress (e.g. on focus) keeps the confirmed result on the page;
 * the badge shows the activity, so the page does not flash on every focus.
 */
export function workspaceIsClean(view: WorkspaceView): boolean {
  const status = view.status;
  return !view.bare && view.supported && !view.error && !view.stale && status !== null && status.complete && status.entries.length === 0;
}

const selectionKey = (selection: WorkspaceSelection, previewLines: number) => `${selection.group}:${selection.pathHex}:${previewLines}`;

const initialView = (): WorkspaceView => ({
  supported: false, bare: false, repoKey: null, status: null, loading: false, error: null, stale: false,
  selection: null, content: null, previewLines: PREVIEW_LINES,
});

export class WorkspaceStore {
  private view = initialView();
  private readonly listeners = new Set<() => void>();
  private statusIntent = 0;
  private contentIntent = 0;
  private lastReadAt = Number.NEGATIVE_INFINITY;
  private timer?: ReturnType<typeof setTimeout>;
  /** Minimum gap between reads, from how long the last read took. */
  private interval = MIN_INTERVAL_MS;
  /** Extra gap after hint reads that found the same status. */
  private hintBackoff = 0;
  private lastSignature: string | null = null;

  constructor(private readonly api: WorkspaceApi, private readonly now: () => number = () => Date.now(), private readonly fullFile: () => boolean = () => false,
    private readonly visible: () => boolean = () => typeof document === "undefined" || document.visibilityState === "visible") {}

  /** The current gap before a hint may trigger another read; exposed for tests and diagnostics. */
  get readGap(): number { return this.interval + this.hintBackoff; }

  get hasScheduledRead(): boolean { return this.timer !== undefined; }

  getView = (): WorkspaceView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Follows the open repository; a different repository starts from scratch. */
  bind(repoKey: string | null, supported: boolean, bare: boolean): void {
    if (repoKey === this.view.repoKey && supported === this.view.supported && bare === this.view.bare) return;
    const sameRepository = repoKey === this.view.repoKey;
    this.statusIntent += 1;
    this.contentIntent += 1;
    this.clearTimer();
    this.lastReadAt = Number.NEGATIVE_INFINITY;
    this.interval = MIN_INTERVAL_MS;
    this.hintBackoff = 0;
    this.lastSignature = null;
    this.update(sameRepository ? { ...this.view, supported, bare } : { ...initialView(), repoKey, supported, bare });
    if (repoKey && supported && !bare) void this.readStatus(true);
  }

  /** A hint from the file watcher: keep the numbers, mark them stale and re-read soon. */
  markChanged(): void {
    if (!this.canRead()) return;
    if (!this.view.stale) this.update({ ...this.view, stale: true });
    // A hidden window reads again when it is shown or focused.
    if (!this.visible()) return;
    if (this.timer) return;
    this.schedule(Math.max(CHANGE_DEBOUNCE_MS, this.lastReadAt + this.readGap - this.now()), "hint");
  }

  /** Re-reads unless the last read is recent; `force` is for explicit refreshes and repository changes. */
  async readStatus(force = false, reason: "hint" | "request" = "request"): Promise<void> {
    if (!this.canRead()) return;
    // Explicit reads (open, focus, page, refresh) drop the backoff that quiet hint reads built up.
    if (reason === "request") this.hintBackoff = 0;
    const wait = this.lastReadAt + this.interval - this.now();
    if (!force && wait > 0) {
      if (this.view.stale) this.schedule(wait, "request");
      return;
    }
    this.clearTimer();
    const intent = ++this.statusIntent;
    const repoKey = this.view.repoKey;
    const started = this.now();
    this.lastReadAt = started;
    this.update({ ...this.view, loading: true });
    const result = await settle(this.api.readWorkspaceStatus({ maxEntries: MAX_ENTRIES }));
    if (intent !== this.statusIntent || repoKey !== this.view.repoKey) return;
    this.interval = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, (this.now() - started) * 10));
    if (!result.ok) {
      if (result.error.code === "BUSY" || result.error.code === "CANCELLED" || result.error.code === "STALE_CONTEXT") {
        this.update({ ...this.view, loading: false });
        this.schedule(BUSY_RETRY_MS, reason);
        return;
      }
      if (result.error.code === "UNKNOWN_METHOD") {
        this.update({ ...this.view, loading: false, supported: false });
        return;
      }
      this.update({ ...this.view, loading: false, error: { code: result.error.code, message: result.error.message } });
      return;
    }
    const status = result.value;
    const signature = statusSignature(status);
    this.hintBackoff = reason === "hint" && signature === this.lastSignature ? Math.min(MAX_INTERVAL_MS - this.interval, Math.max(this.hintBackoff * 2, this.interval)) : 0;
    this.lastSignature = signature;
    const items = workspaceItems(status);
    const kept = this.view.selection && items.some(item => item.group === this.view.selection!.group && item.entry.path.rawHex === this.view.selection!.pathHex);
    const first = items[0];
    const selection = kept ? this.view.selection : first ? { group: first.group, pathHex: first.entry.path.rawHex } : null;
    this.update({ ...this.view, status, loading: false, error: null, stale: false, selection, content: kept ? this.view.content : null,
      previewLines: kept ? this.view.previewLines : PREVIEW_LINES });
    // The shown file may have changed along with the status.
    if (selection) void this.loadContent(true);
  }

  select(selection: WorkspaceSelection): void {
    if (this.view.selection?.group === selection.group && this.view.selection.pathHex === selection.pathHex) return;
    this.update({ ...this.view, selection, previewLines: PREVIEW_LINES });
    void this.loadContent(false);
  }

  /** Untracked previews grow by PREVIEW_STEP lines at a time, up to the 5,000-line limit. */
  loadMorePreview(): void {
    if (!this.view.selection) return;
    this.update({ ...this.view, previewLines: Math.min(5_000, this.view.previewLines + PREVIEW_STEP) });
    void this.loadContent(true);
  }

  retryContent(): void { void this.loadContent(true); }

  async cancel(): Promise<void> {
    this.statusIntent += 1;
    this.contentIntent += 1;
    this.clearTimer();
    this.update({ ...this.view, loading: false, content: this.view.content?.state === "loading" ? null : this.view.content });
    await settle(this.api.cancelWorkspace());
  }

  dispose(): void { this.clearTimer(); }

  private async loadContent(force: boolean): Promise<void> {
    const selection = this.view.selection;
    const status = this.view.status;
    if (!selection || !status) return;
    const key = selectionKey(selection, this.view.previewLines);
    if (!force && this.view.content?.key === key && this.view.content.state !== "error") return;
    const entry = status.entries.find(item => item.path.rawHex === selection.pathHex);
    if (!entry) return;
    const intent = ++this.contentIntent;
    const keepShown = this.view.content?.key.startsWith(`${selection.group}:${selection.pathHex}:`) ? this.view.content : null;
    this.update({ ...this.view, content: { key, state: "loading", diff: keepShown?.diff ?? null, file: keepShown?.file ?? null, error: null } });
    const full = this.fullFile();
    const readDiff = (side: "staged" | "unstaged", withFull: boolean) => settle(this.api.readWorkspaceDiff({ side, pathHex: entry.path.rawHex,
      oldPathHex: side === "staged" ? entry.originalPath?.rawHex ?? null : null, ...(withFull ? { fullFile: true } : {}) }));
    let result: RepositorySessionResult<WorkspaceDiff | WorkspaceFile>;
    let limited = false;
    if (selection.group === "staged" || selection.group === "unstaged") {
      result = await readDiff(selection.group, full);
      // Files over the whole-file limit fall back to the changes only, and the view says so.
      limited = full && !result.ok && result.error.code === "RESOURCE_LIMIT";
      if (limited) result = await readDiff(selection.group, false);
    } else {
      result = await settle(this.api.readWorkspaceFile({ pathHex: entry.path.rawHex, maxLines: this.view.previewLines }));
    }
    if (intent !== this.contentIntent || this.view.content?.key !== key) return;
    if (!result.ok) {
      this.update({ ...this.view, content: { key, state: "error", diff: null, file: null, error: { code: result.error.code, message: result.error.message } } });
      return;
    }
    const value = result.value;
    this.update({ ...this.view, content: "side" in value
      ? { key, state: "ready", diff: value, file: null, error: null, fullFileLimited: limited }
      : { key, state: "ready", diff: null, file: value, error: null } });
  }

  private canRead(): boolean {
    return Boolean(this.view.repoKey && this.view.supported && !this.view.bare);
  }

  private schedule(delay: number, reason: "hint" | "request"): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.readStatus(true, reason);
    }, Math.max(0, delay));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private update(next: WorkspaceView): void {
    this.view = next;
    for (const listener of this.listeners) listener();
  }
}

/** What the badge and list show, so a re-read that finds the same can be told apart cheaply. */
function statusSignature(status: WorkspaceStatus): string {
  const change = (value: WorkspaceChange | null) => value ? `${value.status}:${value.additions ?? "-"}:${value.deletions ?? "-"}` : "";
  return [status.headOid, status.operation, status.complete, status.totalPaths,
    ...status.entries.map(entry => `${entry.path.rawHex}|${change(entry.staged)}|${change(entry.unstaged)}|${entry.untracked ? entry.untrackedSize : ""}|${entry.conflict ?? ""}`)].join("\n");
}

async function settle<T>(promise: Promise<RepositorySessionResult<T>>): Promise<RepositorySessionResult<T>> {
  try {
    return await promise;
  } catch (error) {
    return { ok: false, error: { code: "PROTOCOL_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false } };
  }
}
