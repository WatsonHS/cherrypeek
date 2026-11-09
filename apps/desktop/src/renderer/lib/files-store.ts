import type { BlameBlock, BlameChunk, BlameCommit, FileContent, FileDiff, FileHistoryEntry, GitPath, TreeEntry } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { BlameChunkEvent, RepositorySessionApi, RepositorySessionResult } from "../../../../../packages/protocol/src/repository-session.js";

/*
 * State of the files page (P4-10 to P4-12): a tree at one commit, the selected file or directory,
 * its content (with optional blame) or its history, and one change of that history. Every read
 * is tied to the tree version and path it was made for; answers for anything else are dropped.
 */

export type FilesApi = Pick<RepositorySessionApi, "listTree" | "readFileContent" | "readFileHistory" | "readFileChange" | "readBlame" | "onBlameChunk" | "cancelFiles">;

export type FilesTab = "content" | "history";

export interface TreeVersion {
  commit: string;
  /** Branch, tag or "HEAD"; shown before the short OID. */
  label: string;
}

export interface DirectoryState {
  state: "loading" | "ready" | "error";
  entries: TreeEntry[];
  total: number;
  hasMore: boolean;
  error: string | null;
}

export interface FilesSelection {
  path: GitPath;
  kind: "file" | "directory";
}

export interface Load<T> {
  key: string;
  state: "loading" | "ready" | "error";
  value: T | null;
  error: { code: string; message: string } | null;
}

export interface HistoryState {
  key: string;
  state: "loading" | "ready" | "error";
  entries: FileHistoryEntry[];
  nextCursor: string | null;
  loadingMore: boolean;
  error: { code: string; message: string } | null;
}

export interface BlameState {
  key: string;
  state: "loading" | "ready" | "error";
  totalLines: number;
  blocks: BlameBlock[];
  commits: Record<string, BlameCommit>;
  error: { code: string; message: string } | null;
}

/** Where a blame click came from, so the history view can mark the line and offer a way back. */
export interface BlameFocus {
  line: number;
  oid: string;
  /** Line number in that commit's version of the file. */
  originalLine: number;
  /** Path in that commit, when it differs from the selected path. */
  originalPath: GitPath | null;
  /** The file the blame was shown for; "回到第 N 行" returns there. */
  from: FilesSelection;
}

export interface FilesView {
  supported: boolean;
  blameSupported: boolean;
  fullFileSupported: boolean;
  repoKey: string | null;
  version: TreeVersion | null;
  directories: Record<string, DirectoryState>;
  expanded: Record<string, true>;
  selection: FilesSelection | null;
  tab: FilesTab;
  content: Load<FileContent> | null;
  contentLines: number;
  historyMessage: string;
  history: HistoryState | null;
  selectedCommit: string | null;
  parentIndex: number | null;
  /** `fullFileLimited`: the file was over the whole-file limit, so `value` holds only the changes. */
  change: (Load<FileDiff> & { fullFileLimited?: boolean }) | null;
  blameEnabled: boolean;
  blame: BlameState | null;
  focus: BlameFocus | null;
}

export const TREE_PAGE = 500;
export const CONTENT_LINES = 5_000;
export const HISTORY_PAGE = 200;
const BUSY_RETRY_MS = 400;
const BUSY_RETRIES = 12;

const ROOT = "";

const initialView = (): FilesView => ({
  supported: false, blameSupported: false, fullFileSupported: false, repoKey: null, version: null, directories: {}, expanded: {},
  selection: null, tab: "content", content: null, contentLines: CONTENT_LINES, historyMessage: "", history: null,
  selectedCommit: null, parentIndex: 0, change: null, blameEnabled: false, blame: null, focus: null,
});

/** For each line (1-based index), the blame block that covers it; undefined while the stream has not reached it. */
export function blameLineIndex(blocks: BlameBlock[], totalLines: number): (BlameBlock | undefined)[] {
  const lines: (BlameBlock | undefined)[] = new Array(totalLines + 1);
  for (const block of blocks) {
    for (let line = block.startLine; line < block.startLine + block.lineCount && line <= totalLines; line += 1) lines[line] = block;
  }
  return lines;
}

/** Five age levels, oldest 0 to newest 4, spread over the distinct commit times in this file. */
export function blameHeat(commits: Record<string, BlameCommit>): Record<string, number> {
  const times = [...new Set(Object.values(commits).map(commit => commit.authorTime))].sort((a, b) => a - b);
  const levels: Record<string, number> = {};
  for (const [oid, commit] of Object.entries(commits)) {
    const rank = times.length <= 1 ? times.length : times.indexOf(commit.authorTime) / (times.length - 1);
    levels[oid] = Math.min(4, Math.floor(rank * 5));
  }
  return levels;
}

const contentKey = (version: TreeVersion, path: GitPath, lines: number) => `${version.commit}:${path.rawHex}:${lines}`;
const historyKey = (version: TreeVersion, selection: FilesSelection, message: string) => `${version.commit}:${selection.kind}:${selection.path.rawHex}:${message}`;
const changeKey = (oid: string, parentIndex: number | null, pathHex: string, full: boolean) => `${oid}:${parentIndex ?? "root"}:${pathHex}:${full ? "full" : "changes"}`;

export class FilesStore {
  private view = initialView();
  private readonly listeners = new Set<() => void>();
  private readonly intents = { content: 0, history: 0, change: 0, blame: 0 };
  private treeIntents: Record<string, number> = {};
  /** Directory reads share one channel in main; they run one after another so a parent never cancels a child. */
  private treeQueue: Promise<void> = Promise.resolve();
  private blameStream: string | null = null;
  /** Chunk events and the final reply travel separately; the stream stays open until this many blocks arrived. */
  private blameExpected: number | null = null;
  private streamCounter = 0;
  private readonly unsubscribeBlame: () => void;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly api: FilesApi, private readonly fullFileWanted: () => boolean = () => false) {
    this.unsubscribeBlame = api.onBlameChunk(event => this.acceptBlameChunk(event));
  }

  getView = (): FilesView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  bind(repoKey: string | null, capabilities: { files: boolean; blame: boolean; fullFile: boolean }): void {
    const same = repoKey === this.view.repoKey;
    if (same && capabilities.files === this.view.supported && capabilities.blame === this.view.blameSupported && capabilities.fullFile === this.view.fullFileSupported) return;
    if (!same) this.resetAll();
    this.update({ ...(same ? this.view : initialView()), repoKey, supported: capabilities.files, blameSupported: capabilities.blame, fullFileSupported: capabilities.fullFile });
    if (same && this.view.version && capabilities.files) this.reloadVersion();
  }

  /** The tree version: the newest commit of the browsing scope unless the user picked another. */
  setVersion(version: TreeVersion | null): void {
    if (version?.commit === this.view.version?.commit && version?.label === this.view.version?.label) return;
    const sameCommit = version?.commit === this.view.version?.commit;
    if (sameCommit) { this.update({ ...this.view, version }); return; }
    this.resetAll();
    this.update({ ...this.view, version, directories: {}, expanded: {}, content: null, history: null, change: null, blame: null, selectedCommit: null, focus: null });
    this.reloadVersion();
  }

  /** Expands or collapses a directory; children load the first time. */
  toggleDirectory(pathHex: string): void {
    const expanded = { ...this.view.expanded };
    if (expanded[pathHex]) delete expanded[pathHex];
    else expanded[pathHex] = true;
    this.update({ ...this.view, expanded });
    if (expanded[pathHex] && !this.view.directories[pathHex]) void this.loadDirectory(pathHex, 0);
  }

  /** Shows a directory in the tree, expanded with its parents, without changing what the right side shows. */
  revealDirectory(path: GitPath): void {
    this.expandParents(path);
    if (this.view.expanded[path.rawHex]) return;
    this.update({ ...this.view, expanded: { ...this.view.expanded, [path.rawHex]: true } });
    if (!this.view.directories[path.rawHex]) void this.loadDirectory(path.rawHex, 0);
  }

  loadMoreEntries(pathHex: string): void {
    const directory = this.view.directories[pathHex];
    if (directory?.state === "ready" && directory.hasMore) void this.loadDirectory(pathHex, directory.entries.length);
  }

  retryDirectory(pathHex: string): void { void this.loadDirectory(pathHex, 0); }

  /** Opens a path: files start on the content tab, directories on history. Parent directories are expanded. */
  select(selection: FilesSelection, options: { tab?: FilesTab; commit?: string } = {}): void {
    const tab = selection.kind === "directory" ? "history" : options.tab ?? "content";
    const samePath = this.view.selection?.path.rawHex === selection.path.rawHex && this.view.selection.kind === selection.kind;
    this.update({ ...this.view, selection, tab, selectedCommit: options.commit ?? (samePath ? this.view.selectedCommit : null),
      change: samePath ? this.view.change : null, content: samePath ? this.view.content : null, history: samePath ? this.view.history : null,
      blame: samePath ? this.view.blame : null, focus: null, contentLines: samePath ? this.view.contentLines : CONTENT_LINES, historyMessage: samePath ? this.view.historyMessage : "" });
    this.expandParents(selection.path);
    this.loadForTab();
  }

  setTab(tab: FilesTab): void {
    if (!this.view.selection || tab === this.view.tab || tab === "content" && this.view.selection.kind === "directory") return;
    this.update({ ...this.view, tab });
    this.loadForTab();
  }

  setHistoryMessage(message: string): void {
    if (message === this.view.historyMessage) return;
    this.update({ ...this.view, historyMessage: message });
    if (this.view.tab === "history") void this.loadHistory(false);
  }

  loadMoreHistory(): void { if (this.view.history?.nextCursor && !this.view.history.loadingMore) void this.loadHistory(true); }
  retryHistory(): void { void this.loadHistory(false); }
  retryContent(): void { void this.loadContent(); }

  selectCommit(oid: string, parentIndex: number | null = 0): void {
    this.update({ ...this.view, selectedCommit: oid, parentIndex, focus: this.view.focus?.oid === oid ? this.view.focus : null });
    void this.loadChange();
  }

  setParentIndex(parentIndex: number | null): void {
    if (parentIndex === this.view.parentIndex) return;
    this.update({ ...this.view, parentIndex });
    void this.loadChange();
  }

  /** Re-reads the shown change, e.g. after the display switched between changes-only and the whole file. */
  reloadChange(): void { void this.loadChange(); }

  setBlame(enabled: boolean): void {
    if (enabled === this.view.blameEnabled) return;
    this.update({ ...this.view, blameEnabled: enabled });
    if (enabled) void this.loadBlame();
    else this.stopBlame();
  }

  /** Jumps from a blame line to the commit that last changed it, on the history tab. */
  locateFromBlame(line: number): void {
    const blame = this.view.blame;
    const block = blame ? blameLineIndex(blame.blocks, blame.totalLines)[line] : undefined;
    const from = this.view.selection;
    if (!block || !from) return;
    const focus: BlameFocus = { line, oid: block.oid, originalLine: block.originalStartLine + (line - block.startLine), originalPath: block.originalPath, from };
    // Blame follows whole-file renames while history is per literal path: lines from before a rename open the old path's history.
    const target: FilesSelection = block.originalPath ? { path: block.originalPath, kind: "file" } : from;
    const samePath = target.path.rawHex === from.path.rawHex;
    this.update({ ...this.view, selection: target, tab: "history", focus, selectedCommit: block.oid, parentIndex: 0,
      history: samePath ? this.view.history : null, change: null });
    // The change is read once the history says whether the commit has a parent (a root compares with the empty tree).
    void this.loadHistory(false).then(() => { if (this.view.change === null) void this.loadChange(); });
  }

  /** Back from a located commit to the content tab, at the line that was clicked. */
  returnToLine(): number | null {
    const focus = this.view.focus;
    if (!focus) return null;
    const samePath = focus.from.path.rawHex === this.view.selection?.path.rawHex;
    this.update({ ...this.view, selection: focus.from, tab: "content", focus: null,
      history: samePath ? this.view.history : null, selectedCommit: samePath ? this.view.selectedCommit : null, change: samePath ? this.view.change : null });
    this.loadForTab();
    return focus.line;
  }

  async cancel(): Promise<void> {
    this.resetAll();
    await settle(this.api.cancelFiles());
  }

  dispose(): void {
    this.unsubscribeBlame();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private reloadVersion(): void {
    if (!this.view.version || !this.view.supported) return;
    void this.loadDirectory(ROOT, 0);
    for (const pathHex of Object.keys(this.view.expanded)) void this.loadDirectory(pathHex, 0);
    if (this.view.selection) this.loadForTab();
  }

  private loadForTab(): void {
    if (!this.view.selection || !this.view.supported) return;
    if (this.view.tab === "content") {
      void this.loadContent();
      if (this.view.blameEnabled) void this.loadBlame();
    } else {
      void this.loadHistory(false);
      if (this.view.selectedCommit) void this.loadChange();
    }
  }

  private expandParents(path: GitPath): void {
    const bytes = path.rawHex;
    const expanded = { ...this.view.expanded };
    let changed = false;
    // Raw paths are hex of bytes; "/" is 2f. Each prefix ending before a 2f byte is a parent directory.
    for (let index = 0; index < bytes.length; index += 2) {
      if (bytes.slice(index, index + 2).toLowerCase() === "2f") {
        const parent = bytes.slice(0, index);
        if (!expanded[parent]) { expanded[parent] = true; changed = true; }
      }
    }
    if (!changed) return;
    this.update({ ...this.view, expanded });
    for (const parent of Object.keys(expanded)) if (!this.view.directories[parent]) void this.loadDirectory(parent, 0);
  }

  private loadDirectory(pathHex: string, offset: number): Promise<void> {
    const version = this.view.version;
    if (!version || !this.view.supported) return Promise.resolve();
    const intent = (this.treeIntents[pathHex] ?? 0) + 1;
    this.treeIntents[pathHex] = intent;
    const previous = this.view.directories[pathHex];
    this.setDirectory(pathHex, { state: "loading", entries: offset ? previous?.entries ?? [] : [], total: previous?.total ?? 0, hasMore: false, error: null });
    const run = this.treeQueue.then(() => this.readDirectory(pathHex, offset, version, intent, previous));
    this.treeQueue = run.catch(() => undefined);
    return run;
  }

  private async readDirectory(pathHex: string, offset: number, version: TreeVersion, intent: number, previous: DirectoryState | undefined): Promise<void> {
    if (this.treeIntents[pathHex] !== intent || this.view.version?.commit !== version.commit) return;
    const result = await this.retrying(() => this.api.listTree({ commit: version.commit, pathHex: pathHex || null, offset, limit: TREE_PAGE }),
      () => this.treeIntents[pathHex] === intent && this.view.version?.commit === version.commit);
    if (!result || this.treeIntents[pathHex] !== intent || this.view.version?.commit !== version.commit) return;
    if (!result.ok) {
      this.setDirectory(pathHex, { state: "error", entries: previous?.entries ?? [], total: previous?.total ?? 0, hasMore: false, error: result.error.message });
      return;
    }
    const page = result.value;
    const entries = offset ? [...(this.view.directories[pathHex]?.entries ?? []), ...page.entries] : page.entries;
    this.setDirectory(pathHex, { state: "ready", entries, total: page.total, hasMore: page.hasMore, error: null });
  }

  private setDirectory(pathHex: string, state: DirectoryState): void {
    this.update({ ...this.view, directories: { ...this.view.directories, [pathHex]: state } });
  }

  private async loadContent(): Promise<void> {
    const { version, selection } = this.view;
    if (!version || !selection || selection.kind !== "file") return;
    const key = contentKey(version, selection.path, this.view.contentLines);
    if (this.view.content?.key === key && this.view.content.state !== "error") return;
    const intent = ++this.intents.content;
    this.update({ ...this.view, content: { key, state: "loading", value: null, error: null } });
    const result = await this.retrying(() => this.api.readFileContent({ commit: version.commit, pathHex: selection.path.rawHex, maxLines: this.view.contentLines }),
      () => intent === this.intents.content);
    if (!result || intent !== this.intents.content || this.view.content?.key !== key) return;
    this.update({ ...this.view, content: result.ok ? { key, state: "ready", value: result.value, error: null } : { key, state: "error", value: null, error: errorOf(result) } });
  }

  private async loadHistory(more: boolean): Promise<void> {
    const { version, selection } = this.view;
    if (!version || !selection) return;
    const key = historyKey(version, selection, this.view.historyMessage);
    const current = this.view.history;
    if (!more && current?.key === key && current.state !== "error") return;
    const cursor = more ? current?.nextCursor ?? null : null;
    const intent = ++this.intents.history;
    this.update({ ...this.view, history: more && current
      ? { ...current, loadingMore: true }
      : { key, state: "loading", entries: [], nextCursor: null, loadingMore: false, error: null } });
    const result = await this.retrying(() => this.api.readFileHistory({ commit: version.commit, pathHex: selection.path.rawHex, kind: selection.kind,
      message: this.view.historyMessage, cursor, pageSize: HISTORY_PAGE }), () => intent === this.intents.history);
    if (!result || intent !== this.intents.history || this.view.history?.key !== key) return;
    if (!result.ok) {
      this.update({ ...this.view, history: { ...(this.view.history ?? { key, entries: [], nextCursor: null }), key, state: "error", loadingMore: false, error: errorOf(result) } });
      return;
    }
    const entries = more ? [...(this.view.history?.entries ?? []), ...result.value.entries] : result.value.entries;
    // A file opens on its newest change; a located commit stays selected even if it is on a later page.
    const selectedCommit = this.view.selectedCommit ?? entries[0]?.commit.oid ?? null;
    this.update({ ...this.view, history: { key, state: "ready", entries, nextCursor: result.value.nextCursor, loadingMore: false, error: null }, selectedCommit });
    if (selectedCommit && selection.kind === "file" && this.view.change === null) void this.loadChange();
  }

  private async loadChange(): Promise<void> {
    const { selection, selectedCommit } = this.view;
    if (!selection || selection.kind !== "file" || !selectedCommit) return;
    const entry = this.view.history?.entries.find(item => item.commit.oid === selectedCommit);
    const pathHex = selection.path.rawHex;
    const parentIndex = entry && entry.commit.parents.length === 0 ? null : this.view.parentIndex;
    const full = this.view.fullFileSupported && this.fullFileWanted();
    const key = changeKey(selectedCommit, parentIndex, pathHex, full);
    if (this.view.change?.key === key && this.view.change.state !== "error") return;
    const intent = ++this.intents.change;
    this.update({ ...this.view, change: { key, state: "loading", value: this.view.change?.key.startsWith(`${selectedCommit}:`) ? this.view.change.value : null, error: null } });
    const oldPathHex = entry?.change.oldPath ? entry.change.oldPath.rawHex : null;
    let result = await this.retrying(() => this.api.readFileChange({ oid: selectedCommit, parentIndex, pathHex, oldPathHex, ...(full ? { fullFile: true } : {}) }),
      () => intent === this.intents.change);
    // Files over the whole-file limit fall back to the changes only, and the view says so.
    const limited = Boolean(full && result && !result.ok && result.error.code === "RESOURCE_LIMIT");
    if (limited) {
      result = await this.retrying(() => this.api.readFileChange({ oid: selectedCommit, parentIndex, pathHex, oldPathHex }), () => intent === this.intents.change);
    }
    if (!result || intent !== this.intents.change || this.view.change?.key !== key) return;
    this.update({ ...this.view, change: result.ok ? { key, state: "ready", value: result.value, error: null, fullFileLimited: limited } : { key, state: "error", value: null, error: errorOf(result) } });
  }

  private async loadBlame(): Promise<void> {
    const { version, selection } = this.view;
    if (!version || !selection || selection.kind !== "file" || !this.view.blameSupported) return;
    const key = `${version.commit}:${selection.path.rawHex}`;
    if (this.view.blame?.key === key && this.view.blame.state !== "error") return;
    const intent = ++this.intents.blame;
    const streamId = `blame-${++this.streamCounter}`;
    this.blameStream = streamId;
    this.blameExpected = null;
    this.update({ ...this.view, blame: { key, state: "loading", totalLines: 0, blocks: [], commits: {}, error: null } });
    const result = await this.retrying(() => this.api.readBlame({ commit: version.commit, pathHex: selection.path.rawHex }, streamId),
      () => intent === this.intents.blame);
    if (!result || intent !== this.intents.blame || this.view.blame?.key !== key) return;
    if (!result.ok) {
      this.blameStream = null;
      this.update({ ...this.view, blame: { ...this.view.blame, state: "error", error: errorOf(result) } });
      return;
    }
    this.blameExpected = result.value.blocks;
    this.update({ ...this.view, blame: { ...this.view.blame, totalLines: result.value.totalLines } });
    this.finishBlameIfComplete();
  }

  private finishBlameIfComplete(): void {
    const blame = this.view.blame;
    if (!blame || this.blameExpected === null || blame.blocks.length < this.blameExpected) return;
    this.blameStream = null;
    this.blameExpected = null;
    this.update({ ...this.view, blame: { ...blame, state: "ready" } });
  }

  private acceptBlameChunk(event: BlameChunkEvent): void {
    if (!this.blameStream || event.streamId !== this.blameStream || !this.view.blame) return;
    const chunk: BlameChunk = event.chunk;
    const commits = { ...this.view.blame.commits };
    for (const commit of chunk.commits) commits[commit.oid] = commit;
    this.update({ ...this.view, blame: { ...this.view.blame, totalLines: chunk.totalLines, blocks: [...this.view.blame.blocks, ...chunk.blocks], commits } });
    this.finishBlameIfComplete();
  }

  private stopBlame(): void {
    this.intents.blame += 1;
    this.blameStream = null;
    this.blameExpected = null;
    this.update({ ...this.view, blame: null });
  }

  private resetAll(): void {
    this.intents.content += 1;
    this.intents.history += 1;
    this.intents.change += 1;
    this.intents.blame += 1;
    this.treeIntents = {};
    this.blameStream = null;
    this.blameExpected = null;
  }

  /** The core handles two requests at a time; BUSY answers are retried briefly while the request is still wanted. */
  private async retrying<T>(request: () => Promise<RepositorySessionResult<T>>, current: () => boolean): Promise<RepositorySessionResult<T> | null> {
    for (let attempt = 0; ; attempt += 1) {
      const result = await settle(request());
      if (!current()) return null;
      if (result.ok || (result.error.code !== "BUSY" && !(result.error.code === "CANCELLED" && attempt === 0)) || attempt >= BUSY_RETRIES) return result;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.timers.delete(timer); resolve(); }, BUSY_RETRY_MS);
        this.timers.add(timer);
      });
      if (!current()) return null;
    }
  }

  private update(next: FilesView): void {
    this.view = next;
    for (const listener of this.listeners) listener();
  }
}

function errorOf(result: { ok: false; error: { code: string; message: string } }): { code: string; message: string } {
  return { code: result.error.code, message: result.error.message };
}

async function settle<T>(promise: Promise<RepositorySessionResult<T>>): Promise<RepositorySessionResult<T>> {
  try {
    return await promise;
  } catch (error) {
    return { ok: false, error: { code: "PROTOCOL_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false } };
  }
}
