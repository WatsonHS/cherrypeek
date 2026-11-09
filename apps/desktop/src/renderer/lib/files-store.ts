import type { BlameBlock, BlameChunk, BlameCommit, ChangedFile, FileContent, FileDiff, FileHistoryEntry, GitPath, TreeEntry } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { BlameChunkEvent, RepositorySessionApi, RepositorySessionResult } from "../../../../../packages/protocol/src/repository-session.js";

/*
 * State of the files page (P4-10 to P4-12): a tree at one commit, the selected file or directory,
 * its content (with optional blame) or its history, and one change of that history. Every read
 * is tied to the tree version and path it was made for; answers for anything else are dropped.
 */

export type FilesApi = Pick<RepositorySessionApi, "listTree" | "readFileContent" | "readFileHistory" | "readFileChange" | "listPathChanges" | "readBlame" | "onBlameChunk" | "cancelFiles">;

/** For a directory and a picked commit: the files it changed under the directory, a page at a time. */
export interface PathChangesState {
  key: string;
  state: "loading" | "ready" | "error";
  files: ChangedFile[];
  totalFiles: number;
  additions: number;
  deletions: number;
  hasMore: boolean;
  loadingMore: boolean;
  error: { code: string; message: string } | null;
}

/** One of those files opened to show its diff. */
export interface PathFileChange {
  key: string;
  state: "loading" | "ready" | "error";
  value: FileDiff | null;
  error: { code: string; message: string } | null;
}

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
  /** "history" while a picked commit's change is open below the file (for a directory, always: it has no content). */
  tab: FilesTab;
  /** The history column beside the tree; its top row is the current version, the rest are commits. */
  historyOpen: boolean;
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
  pathChanges: PathChangesState | null;
  /** Key of the directory's changed file whose diff is open (its new path, or old path when deleted). */
  pathOpen: string | null;
  pathChange: PathFileChange | null;
}

export const TREE_PAGE = 500;
export const CONTENT_LINES = 5_000;
export const HISTORY_PAGE = 200;
export const PATH_CHANGES_PAGE = 200;
const BUSY_RETRY_MS = 400;
const BUSY_RETRIES = 12;

const ROOT = "";

const initialView = (): FilesView => ({
  supported: false, blameSupported: false, fullFileSupported: false, repoKey: null, version: null, directories: {}, expanded: {},
  selection: null, tab: "content", historyOpen: false, content: null, contentLines: CONTENT_LINES, historyMessage: "", history: null,
  selectedCommit: null, parentIndex: 0, change: null, blameEnabled: false, blame: null, focus: null, pathChanges: null, pathOpen: null, pathChange: null,
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
  private readonly intents = { content: 0, history: 0, change: 0, blame: 0, pathChanges: 0, pathChange: 0 };
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
    this.update({ ...this.view, selection, tab, historyOpen: tab === "history" || this.view.historyOpen, selectedCommit: options.commit ?? (samePath ? this.view.selectedCommit : null),
      change: samePath ? this.view.change : null, content: samePath ? this.view.content : null, history: samePath ? this.view.history : null,
      blame: samePath ? this.view.blame : null, focus: null, contentLines: samePath ? this.view.contentLines : CONTENT_LINES, historyMessage: samePath ? this.view.historyMessage : "" });
    this.expandParents(selection.path);
    this.loadForTab();
  }

  setTab(tab: FilesTab): void {
    if (!this.view.selection || tab === this.view.tab || tab === "content" && this.view.selection.kind === "directory") return;
    // Showing a change with none chosen yet starts on the newest one already listed.
    const newest = tab === "history" && !this.view.selectedCommit ? this.view.history?.entries[0]?.commit.oid ?? null : null;
    this.update({ ...this.view, tab, historyOpen: tab === "history" || this.view.historyOpen, ...(newest ? { selectedCommit: newest } : {}) });
    this.loadForTab();
  }

  /** Shows or hides the history column; a change open below the file stays open. */
  setHistoryOpen(open: boolean): void {
    if (open === this.view.historyOpen) return;
    this.update({ ...this.view, historyOpen: open });
    if (open && this.view.selection) void this.loadHistory(false);
  }

  setHistoryMessage(message: string): void {
    if (message === this.view.historyMessage) return;
    this.update({ ...this.view, historyMessage: message });
    if (this.view.tab === "history" || this.view.historyOpen) void this.loadHistory(false);
  }

  loadMoreHistory(): void { if (this.view.history?.nextCursor && !this.view.history.loadingMore) void this.loadHistory(true); }
  retryHistory(): void { void this.loadHistory(false); }
  retryContent(): void { void this.loadContent(); }

  /** Picks a commit in the history column; its change opens below the file. */
  selectCommit(oid: string, parentIndex: number | null = 0): void {
    // After a blame jump the way back stays while other commits are browsed; only the line's own commit is marked.
    this.update({ ...this.view, tab: "history", selectedCommit: oid, parentIndex });
    if (this.view.selection?.kind === "directory") void this.loadPathChanges(false);
    else void this.loadChange();
  }

  loadMorePathChanges(): void { if (this.view.pathChanges?.hasMore && !this.view.pathChanges.loadingMore) void this.loadPathChanges(true); }
  retryPathChanges(): void { void this.loadPathChanges(false); }

  /** Opens or closes one changed file's diff in a directory's change list. */
  togglePathFile(file: ChangedFile): void {
    const key = (file.newPath ?? file.oldPath)!.rawHex;
    this.intents.pathChange += 1;
    const open = this.view.pathOpen === key ? null : key;
    this.update({ ...this.view, pathOpen: open, pathChange: null });
    if (open) void this.loadPathFile(file);
  }

  /** From a blame line that came from before a whole-file rename, to the old path's history at that commit. */
  openOriginalHistory(): void {
    const focus = this.view.focus;
    if (!focus?.originalPath || this.view.selection?.path.rawHex === focus.originalPath.rawHex) return;
    this.update({ ...this.view, selection: { path: focus.originalPath, kind: "file" }, tab: "history", historyOpen: true, selectedCommit: focus.oid,
      history: null, content: null, blame: null });
    this.loadForTab();
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

  /**
   * Opens the change of the commit that last changed a blame line, with the history column shown and that commit
   * picked in it. A line from before a whole-file rename reads its change under the old path; that commit is not in
   * this path's literal history, so nothing is picked in the column then.
   */
  locateFromBlame(line: number): void {
    const blame = this.view.blame;
    const block = blame ? blameLineIndex(blame.blocks, blame.totalLines)[line] : undefined;
    const from = this.view.selection;
    if (!block || !from) return;
    const focus: BlameFocus = { line, oid: block.oid, originalLine: block.originalStartLine + (line - block.startLine), originalPath: block.originalPath, from };
    this.update({ ...this.view, tab: "history", historyOpen: true, focus, selectedCommit: block.oid, parentIndex: 0, change: null });
    void this.loadChange();
    void this.loadHistory(false);
  }

  /** Closes the change and shows the file again (the file the blame jump came from); returns that blame line, if any. */
  closeChange(): number | null {
    if (this.view.selection?.kind !== "file" || this.view.tab === "content") return null;
    const focus = this.view.focus;
    const elsewhere = focus && focus.from.path.rawHex !== this.view.selection.path.rawHex;
    this.update({ ...this.view, tab: "content", focus: null,
      ...(elsewhere ? { selection: focus.from, history: null, content: null, change: null } : {}) });
    if (elsewhere) this.loadForTab();
    return focus?.line ?? null;
  }

  /** Kept for callers from before the change opened below the file. */
  returnToLine(): number | null { return this.closeChange(); }

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
    const selection = this.view.selection;
    if (!selection || !this.view.supported) return;
    if (selection.kind === "file") {
      // The file is always shown; a picked commit's change opens below it.
      void this.loadContent();
      if (this.view.blameEnabled) void this.loadBlame();
      if (this.view.tab === "history" && this.view.selectedCommit) void this.loadChange();
    }
    if (this.view.historyOpen || selection.kind === "directory") void this.loadHistory(false);
    if (selection.kind === "directory" && this.view.selectedCommit) void this.loadPathChanges(false);
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
    // Showing changes starts on the newest one; while the file itself is shown, no commit is picked for the user.
    // A located commit stays selected even if it is on a later page.
    const showingChange = this.view.tab === "history";
    const selectedCommit = this.view.selectedCommit ?? (showingChange ? entries[0]?.commit.oid ?? null : null);
    this.update({ ...this.view, history: { key, state: "ready", entries, nextCursor: result.value.nextCursor, loadingMore: false, error: null }, selectedCommit });
    if (showingChange && selectedCommit && selection.kind === "file" && this.view.change === null) void this.loadChange();
    if (selectedCommit && selection.kind === "directory" && this.view.pathChanges?.key !== pathChangesKey(selectedCommit, selection.path.rawHex)) void this.loadPathChanges(false);
  }

  private async loadPathChanges(more: boolean): Promise<void> {
    const { selection, selectedCommit } = this.view;
    if (!selection || selection.kind !== "directory" || !selectedCommit) return;
    const key = pathChangesKey(selectedCommit, selection.path.rawHex);
    const current = this.view.pathChanges?.key === key ? this.view.pathChanges : null;
    if (!more && current && current.state !== "error") return;
    const entry = this.view.history?.entries.find(item => item.commit.oid === selectedCommit);
    // Like the history entry, a directory's change is against the first parent; a root commit against the empty tree.
    const parentIndex = entry && entry.commit.parents.length === 0 ? null : 0;
    const offset = more && current ? current.files.length : 0;
    const intent = ++this.intents.pathChanges;
    this.intents.pathChange += 1;
    this.update({ ...this.view, pathChanges: more && current ? { ...current, loadingMore: true }
      : { key, state: "loading", files: [], totalFiles: 0, additions: 0, deletions: 0, hasMore: false, loadingMore: false, error: null },
      ...(more ? {} : { pathOpen: null, pathChange: null }) });
    const result = await this.retrying(() => this.api.listPathChanges({ oid: selectedCommit, parentIndex, pathHex: selection.path.rawHex, offset, pageSize: PATH_CHANGES_PAGE }),
      () => intent === this.intents.pathChanges);
    if (!result || intent !== this.intents.pathChanges || this.view.pathChanges?.key !== key) return;
    if (!result.ok) {
      this.update({ ...this.view, pathChanges: { ...this.view.pathChanges, state: "error", loadingMore: false, error: errorOf(result) } });
      return;
    }
    const page = result.value;
    this.update({ ...this.view, pathChanges: { key, state: "ready", files: [...(more ? this.view.pathChanges.files : []), ...page.files], totalFiles: page.totalFiles,
      additions: page.overview.additions, deletions: page.overview.deletions, hasMore: page.hasMore, loadingMore: false, error: null } });
  }

  private async loadPathFile(file: ChangedFile): Promise<void> {
    const { selectedCommit } = this.view;
    const path = file.newPath ?? file.oldPath;
    if (!selectedCommit || !path) return;
    const entry = this.view.history?.entries.find(item => item.commit.oid === selectedCommit);
    const parentIndex = entry && entry.commit.parents.length === 0 ? null : 0;
    const key = `${selectedCommit}:${path.rawHex}`;
    const intent = ++this.intents.pathChange;
    this.update({ ...this.view, pathChange: { key, state: "loading", value: null, error: null } });
    const result = await this.retrying(() => this.api.readFileChange({ oid: selectedCommit, parentIndex, pathHex: path.rawHex,
      oldPathHex: file.newPath && file.oldPath && file.oldPath.rawHex !== file.newPath.rawHex ? file.oldPath.rawHex : null }), () => intent === this.intents.pathChange);
    if (!result || intent !== this.intents.pathChange || this.view.pathChange?.key !== key) return;
    this.update({ ...this.view, pathChange: result.ok ? { key, state: "ready", value: result.value, error: null } : { key, state: "error", value: null, error: errorOf(result) } });
  }

  private async loadChange(): Promise<void> {
    const { selection, selectedCommit } = this.view;
    if (!selection || selection.kind !== "file" || !selectedCommit) return;
    const entry = this.view.history?.entries.find(item => item.commit.oid === selectedCommit);
    const focus = this.view.focus?.oid === selectedCommit ? this.view.focus : null;
    // A blame line from before a whole-file rename reads its change under the path it had then.
    const pathHex = focus?.originalPath?.rawHex ?? selection.path.rawHex;
    const parentIndex = entry && entry.commit.parents.length === 0 ? null : this.view.parentIndex;
    const full = this.view.fullFileSupported && this.fullFileWanted();
    const key = changeKey(selectedCommit, parentIndex, pathHex, full);
    if (this.view.change?.key === key && this.view.change.state !== "error") return;
    const intent = ++this.intents.change;
    this.update({ ...this.view, change: { key, state: "loading", value: this.view.change?.key.startsWith(`${selectedCommit}:`) ? this.view.change.value : null, error: null } });
    const oldPathHex = entry?.change.oldPath ? entry.change.oldPath.rawHex : null;
    const read = (parent: number | null, withFull: boolean) => this.retrying(() => this.api.readFileChange({ oid: selectedCommit, parentIndex: parent, pathHex, oldPathHex,
      ...(withFull ? { fullFile: true } : {}) }), () => intent === this.intents.change);
    let parent = parentIndex;
    let result = await read(parent, full);
    // Opened from blame without the history loaded, the parents are unknown: a root commit refuses parent 0.
    if (!entry && parent === 0 && result && !result.ok && result.error.code === "INVALID_REQUEST") {
      parent = null;
      result = await read(parent, full);
    }
    // Files over the whole-file limit fall back to the changes only, and the view says so.
    const limited = Boolean(full && result && !result.ok && result.error.code === "RESOURCE_LIMIT");
    if (limited) result = await read(parent, false);
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
    this.intents.pathChanges += 1;
    this.intents.pathChange += 1;
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

function pathChangesKey(oid: string, pathHex: string): string { return `${oid}:${pathHex}`; }

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
