import type {
  CommitSummary,
  RefInfo,
  RepositoryInfo,
  RepositorySessionInfo,
  StoreStatus,
} from "../../../../../packages/protocol/src/generated/server-message.js";
import type { HistoryPage, RepositorySessionApi, RepositorySessionResult } from "../../../../../packages/protocol/src/repository-session.js";

export type RepositoryViewState = "idle" | "loading" | "ready" | "error" | "cancelled";

export interface ViewError {
  code: string;
  message: string;
  /** The path the user tried to open, when the error came from opening. */
  path?: string;
}

export interface ViewRecord {
  saved: boolean;
  status: StoreStatus | null;
  error: ViewError | null;
}

/** What the window shows. Only data from `session` is shown; a newer open replaces it as a whole. */
export interface RepositoryView {
  revision: number;
  state: RepositoryViewState;
  /** Session whose data is shown. Null when nothing is open or the core went away. */
  session: RepositorySessionInfo | null;
  repository: RepositoryInfo | null;
  refs: RefInfo[];
  refsTruncated: boolean;
  commits: CommitSummary[];
  hasMore: boolean;
  pageOffset: number | null;
  pageSize: number;
  pageCursor: string | null;
  previousCursor: string | null;
  nextCursor: string | null;
  pageLoading: boolean;
  refreshing: boolean;
  pageError: ViewError | null;
  pageErrorKind: "read" | "refresh" | null;
  retryCursor: string | null;
  oldSelectedCommit: CommitSummary | null;
  oldSelectedObservedAtUnixMs: number | null;
  selectionMissingOnPage: boolean;
  anchorMissing: boolean;
  anchorRestorationSpace: number;
  pageRevision: number;
  /** Error about what is shown: a failed read, or a failed open when nothing else is shown. */
  error: ViewError | null;
  /** Path being opened while the current repository stays on screen. */
  opening: string | null;
  /** A failed open that left the current repository in place. */
  notice: ViewError | null;
  /** Result of the latest "viewed" record for this session. */
  record: ViewRecord | null;
}

export type SessionApi = Pick<RepositorySessionApi,
  "openRepositorySession" | "getRepositorySession" | "readHistoryPage" | "cancelHistoryRead" |
  "refreshRepositorySession" | "recordRepositoryView" | "closeRepositorySession">;

function emptyView(revision: number, state: RepositoryViewState = "idle"): RepositoryView {
  return {
    revision, state, session: null, repository: null, refs: [], refsTruncated: false, commits: [], hasMore: false,
    pageOffset: null, pageSize: 200, pageCursor: null, previousCursor: null, nextCursor: null,
    pageLoading: false, refreshing: false, pageError: null, pageErrorKind: null, retryCursor: null,
    oldSelectedCommit: null, oldSelectedObservedAtUnixMs: null,
    selectionMissingOnPage: false, anchorMissing: false, anchorRestorationSpace: 0, pageRevision: 0,
    error: null, opening: null, notice: null, record: null,
  };
}

/**
 * Drives the repository session from the renderer. Every open bumps `operation`;
 * results that arrive for an older operation are dropped so they never overwrite the current view.
 */
export class RepositorySessionStore {
  private view = emptyView(0);
  private readonly listeners = new Set<() => void>();
  private operation = 0;
  private pageOperation = 0;
  private refreshIntent = 0;
  private refreshRpcStarted = false;
  private refreshingSession?: RepositorySessionInfo;
  private pageRequest?: { cursor: string | null; done: Promise<void> };
  private recording?: { session: RepositorySessionInfo; done: Promise<void> };
  private shownSession?: RepositorySessionInfo;

  constructor(private readonly api: SessionApi) {}

  getView = (): RepositoryView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async open(path: string): Promise<void> {
    const operation = ++this.operation;
    ++this.pageOperation;
    ++this.refreshIntent;
    if (this.refreshingSession && !this.refreshRpcStarted && sameSession(this.view.session, this.refreshingSession)) {
      this.update({ ...this.view, refreshing: false });
      this.refreshingSession = undefined;
    }
    const previous = this.view;
    const keep = previous.state === "ready" && previous.session !== null ? previous.session : null;
    this.update(keep ? { ...previous, opening: path, notice: null } : { ...emptyView(0, "loading"), opening: path });

    // The shown repository counts as viewed when the user switches away from it.
    if (keep) await this.recordView();
    if (operation !== this.operation) return;

    const opened = await settle(this.api.openRepositorySession(path));
    if (operation !== this.operation) return;
    if (!opened.ok) {
      await this.openFailed(operation, { ...opened.error, path }, keep);
      return;
    }
    const session = opened.value;
    this.update({ ...emptyView(0, "loading"), session, repository: session.repository });
    await this.readFirstPage(operation, session);
  }

  /** Re-reads the first page of the current session after a failed read. */
  async retry(): Promise<void> {
    const { session, state } = this.view;
    if (!session || state !== "error") return;
    const operation = ++this.operation;
    this.update({ ...this.view, state: "loading", error: null });
    await this.readFirstPage(operation, session);
  }

  async readPage(cursor: string | null): Promise<void> {
    const { session, state } = this.view;
    if (!session || state !== "ready" || this.view.refreshing) return;
    const token = ++this.pageOperation;
    const previous = this.pageRequest;
    if (previous) {
      await settle(this.api.cancelHistoryRead());
      await previous.done;
      if (token !== this.pageOperation || !sameSession(this.view.session, session)) return;
    }
    this.update({ ...this.view, pageLoading: true, pageError: null, pageErrorKind: null, anchorRestorationSpace: 0 });
    const done = this.loadPage(token, session, cursor);
    this.pageRequest = { cursor, done };
    await done;
    if (this.pageRequest?.done === done) this.pageRequest = undefined;
  }

  async previousPage(): Promise<void> {
    if (this.view.previousCursor !== null) await this.readPage(this.view.previousCursor);
  }

  async nextPage(): Promise<void> {
    if (this.view.nextCursor !== null) await this.readPage(this.view.nextCursor);
  }

  async cancelPage(): Promise<void> {
    const active = this.pageRequest;
    const session = this.view.session;
    if (!active || !session) return;
    const token = ++this.pageOperation;
    await settle(this.api.cancelHistoryRead());
    await active.done;
    if (token !== this.pageOperation || !sameSession(this.view.session, session)) return;
    if (this.pageRequest === active) this.pageRequest = undefined;
    this.update({ ...this.view, pageLoading: false });
  }

  async retryPage(selectedOid = this.selectedOid): Promise<void> {
    if (this.view.pageErrorKind === "refresh") return this.refresh(selectedOid);
    if (this.view.pageErrorKind === "read") return this.readPage(this.view.retryCursor);
    if (this.view.state === "error") return this.retry();
  }

  async refresh(selectedOid?: string, anchor?: { oid: string; offset: number }): Promise<void> {
    const session = this.view.session;
    if (!session || this.view.state !== "ready" || this.view.refreshing) return;
    const intent = ++this.refreshIntent;
    const selected = this.view.commits.find(commit => commit.oid === selectedOid) ?? this.view.oldSelectedCommit;
    const oldSelectedObservedAtUnixMs = this.view.oldSelectedCommit && selected === this.view.oldSelectedCommit
      ? this.view.oldSelectedObservedAtUnixMs : session.observedAtUnixMs;
    const oldPageRequest = this.pageRequest;
    ++this.pageOperation;
    this.refreshingSession = session;
    this.refreshRpcStarted = false;
    this.update({ ...this.view, refreshing: true, pageLoading: false, pageError: null, pageErrorKind: null, anchorMissing: false, anchorRestorationSpace: 0 });
    await this.recordView();
    if (intent !== this.refreshIntent || !sameSession(this.view.session, session)) {
      if (sameSession(this.view.session, session) && this.refreshingSession === session) {
        this.refreshingSession = undefined;
        this.update({ ...this.view, refreshing: false });
      }
      return;
    }
    if (!sameSession(this.view.session, session)) return;
    this.refreshRpcStarted = true;
    const result = await settle(this.api.refreshRepositorySession(this.view.pageSize));
    this.refreshingSession = undefined;
    this.refreshRpcStarted = false;
    const current = this.view;
    if (!sameSession(current.session, session)) return;
    if (!result.ok) {
      if (oldPageRequest) await oldPageRequest.done;
      const latest = this.view;
      if (!sameSession(latest.session, session)) return;
      this.update({ ...latest, refreshing: false, pageError: result.error, pageErrorKind: "refresh" });
      return;
    }
    const { session: refreshedSession, page } = result.value;
    if (!validHistoryPage(page, current.pageSize)) {
      this.update({ ...current, refreshing: false, pageError: { code: "PROTOCOL_ERROR", message: "刷新返回的第一页不完整" }, pageErrorKind: "refresh" });
      return;
    }
    const selectedStillLoaded = !selected || page.commits.some(commit => commit.oid === selected.oid);
    const anchorLoaded = !anchor || page.commits.some(commit => commit.oid === anchor.oid);
    this.shownSession = undefined;
    this.pageRequest = undefined;
    this.update({
      ...current,
      state: "ready",
      session: refreshedSession,
      repository: page.repository,
      refs: page.refs,
      refsTruncated: page.refsTruncated,
      commits: page.commits,
      hasMore: page.hasMore,
      pageOffset: page.offset,
      pageSize: page.pageSize,
      pageCursor: page.cursor,
      previousCursor: page.previousCursor,
      nextCursor: page.nextCursor,
      pageLoading: false,
      refreshing: false,
      pageError: null,
      pageErrorKind: null,
      retryCursor: null,
      oldSelectedCommit: selectedStillLoaded ? null : selected ?? null,
      oldSelectedObservedAtUnixMs: selectedStillLoaded ? null : oldSelectedObservedAtUnixMs,
      selectionMissingOnPage: Boolean(selected && !selectedStillLoaded),
      anchorMissing: Boolean(anchor && !anchorLoaded),
      anchorRestorationSpace: 0,
      pageRevision: current.pageRevision + 1,
      opening: current.opening,
      error: null,
    });
  }

  /** Stops opening or reading. The session API can only stop by closing, so this closes the repository. */
  async cancel(): Promise<void> {
    if (this.view.state !== "loading" && this.view.opening === null) return;
    const operation = ++this.operation;
    this.update(emptyView(0, "cancelled"));
    const closed = await settle(this.api.closeRepositorySession());
    if (operation !== this.operation || closed.ok) return;
    this.update({ ...this.view, error: closed.error });
  }

  dismissNotice(): void {
    if (this.view.notice) this.update({ ...this.view, notice: null });
  }

  /** Records the first time a session's content is on screen while the window has focus. */
  async markShown(): Promise<void> {
    const { session, state } = this.view;
    if (!session || state !== "ready" || this.shownSession === session) return;
    this.shownSession = session;
    await this.recordView();
  }

  /** Saves the shown session's HEAD as viewed. Only content that reached the screen is recorded. */
  async recordView(): Promise<void> {
    const { session, state } = this.view;
    if (!session || state !== "ready") return;
    if (this.recording?.session === session) return this.recording.done;
    const done = (async () => {
      const result = await settle(this.api.recordRepositoryView(session.generation));
      if (this.view.session !== session) return;
      this.update({
        ...this.view,
        record: result.ok
          ? { saved: result.value.saved, status: result.value.status, error: null }
          : { saved: false, status: null, error: result.error },
      });
    })();
    this.recording = { session, done };
    try { await done; } finally { if (this.recording?.done === done) this.recording = undefined; }
  }

  /** The core stopped: its sessions are gone. Keep shown data, stop anything in flight. */
  coreUnavailable(): void {
    const view = this.view;
    if (!view.session && view.opening === null && view.state !== "loading") return;
    this.operation += 1;
    this.pageOperation += 1;
    this.refreshIntent += 1;
    this.pageRequest = undefined;
    this.refreshingSession = undefined;
    this.refreshRpcStarted = false;
    if (view.state === "ready") {
      this.update({ ...view, session: null, opening: null, pageLoading: false, refreshing: false });
      return;
    }
    this.update({ ...view, session: null, opening: null, pageLoading: false, refreshing: false, state: "error", error: { code: "CORE_EXITED", message: "核心已退出，仓库读取已停止" } });
  }

  private async readFirstPage(operation: number, session: RepositorySessionInfo): Promise<void> {
    const page = await settle(this.api.readHistoryPage(null, this.view.pageSize));
    if (operation !== this.operation) return;
    if (!page.ok) {
      this.update({ ...this.view, state: "error", error: page.error });
      return;
    }
    if (!validHistoryPage(page.value, this.view.pageSize)) {
      this.update({ ...this.view, state: "error", error: { code: "PROTOCOL_ERROR", message: "核心返回的历史页不完整" } });
      return;
    }
    this.applyPage(session, page.value, "ready", { retryCursor: null, pageErrorKind: null });
  }

  private async loadPage(token: number, session: RepositorySessionInfo, cursor: string | null): Promise<void> {
    const requestDone = settle(this.api.readHistoryPage(cursor, this.view.pageSize)).then(result => {
      if (token !== this.pageOperation || !sameSession(this.view.session, session)) return;
      if (!result.ok) {
        this.update({ ...this.view, pageLoading: false, pageError: result.error, pageErrorKind: "read", retryCursor: cursor });
        return;
      }
      if (!validHistoryPage(result.value, this.view.pageSize)) {
        this.update({ ...this.view, pageLoading: false, pageError: { code: "PROTOCOL_ERROR", message: "核心返回的历史页不完整" }, pageErrorKind: "read", retryCursor: cursor });
        return;
      }
      const selectedPresent = this.view.commits.some(commit => commit.oid === this.selectedOid);
      this.applyPage(session, result.value, "ready", {
        selectionMissingOnPage: Boolean(this.selectedOid && !result.value.commits.some(commit => commit.oid === this.selectedOid)),
        oldSelectedCommit: selectedPresent ? null : this.view.oldSelectedCommit,
        oldSelectedObservedAtUnixMs: selectedPresent ? null : this.view.oldSelectedObservedAtUnixMs,
        retryCursor: cursor,
        pageErrorKind: null,
      });
    });
    await requestDone;
  }

  private selectedOid?: string;

  setSelectedOid(oid: string | undefined): void {
    this.selectedOid = oid;
    if (this.view.selectionMissingOnPage && this.view.commits.some(commit => commit.oid === oid)) {
      this.update({ ...this.view, selectionMissingOnPage: false, oldSelectedCommit: null });
    }
  }

  setAnchorRestorationSpace(pixels: number): void {
    const bounded = Number.isFinite(pixels) ? Math.max(0, Math.min(2_000, Math.floor(pixels))) : 0;
    if (bounded === this.view.anchorRestorationSpace) return;
    this.update({ ...this.view, anchorRestorationSpace: bounded });
  }

  private applyPage(
    session: RepositorySessionInfo,
    page: HistoryPage,
    state: "ready" | "loading",
    extra: Partial<RepositoryView> = {},
  ): void {
    this.update({
      ...this.view,
      state,
      session,
      repository: page.repository,
      refs: page.refs,
      refsTruncated: page.refsTruncated,
      commits: page.commits,
      hasMore: page.hasMore,
      pageOffset: page.offset,
      pageSize: page.pageSize,
      pageCursor: page.cursor,
      previousCursor: page.previousCursor,
      nextCursor: page.nextCursor,
      pageLoading: false,
      anchorRestorationSpace: 0,
      pageError: null,
      error: null,
      ...extra,
    });
  }

  private async openFailed(operation: number, error: ViewError, kept: RepositorySessionInfo | null): Promise<void> {
    // A failed open leaves the previous session in place; confirm before keeping it on screen.
    const shown = kept && this.view.session && sameRepository(this.view.session, kept) ? this.view.session : kept;
    if (shown) {
      const current = await settle(this.api.getRepositorySession());
      if (operation !== this.operation) return;
      if (current.ok && current.value.repoId === shown.repoId && current.value.generation === shown.generation &&
        this.view.session?.repoId === shown.repoId && this.view.session.generation === shown.generation) {
        this.update({ ...this.view, opening: null, notice: error });
        return;
      }
    }
    this.update({ ...emptyView(0, "error"), error });
  }

  private update(next: RepositoryView): void {
    this.view = { ...next, revision: this.view.revision + 1 };
    for (const listener of this.listeners) listener();
  }
}

function sameSession(left: RepositorySessionInfo | null, right: RepositorySessionInfo): boolean {
  return left?.repoId === right.repoId && left.generation === right.generation;
}

function sameRepository(left: RepositorySessionInfo, right: RepositorySessionInfo): boolean {
  return left.repositoryKey === right.repositoryKey && left.worktreeId === right.worktreeId;
}

function validHistoryPage(page: HistoryPage, requestedPageSize: number): boolean {
  return page.pageSize === requestedPageSize && page.commits.length <= requestedPageSize &&
    page.hasMore === (page.nextCursor !== null);
}

/** Turns IPC rejections into the same result shape the session API uses. */
export async function settle<T>(promise: Promise<RepositorySessionResult<T>>): Promise<RepositorySessionResult<T>> {
  try {
    return await promise;
  } catch (error) {
    return { ok: false, error: { code: "PROTOCOL_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false } };
  }
}
