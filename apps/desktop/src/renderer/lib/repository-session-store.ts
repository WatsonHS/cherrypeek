import type {
  HistoryCommit,
  MergeStatus,
  MetadataIndexStatus,
  RepositoryScope,
  NewSinceLastSeenStatus,
  RefInfo,
  RepositoryInfo,
  RepositorySessionInfo,
  StoreStatus,
} from "../../../../../packages/protocol/src/generated/server-message.js";
import type { HistoryPage, RepositoryNavigation, RefMergeStatusResult, RepositorySessionApi, RepositorySessionResult } from "../../../../../packages/protocol/src/repository-session.js";
import type { MetadataIndexAction } from "../../../../../packages/protocol/src/generated/client-message.js";

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
  newSinceLastSeenStatus: NewSinceLastSeenStatus;
  lastSeenDividerOid: string | null;
  commits: HistoryCommit[];
  hasMore: boolean;
  pageOffset: number | null;
  pageSize: number;
  pageCursor: string | null;
  previousCursor: string | null;
  nextCursor: string | null;
  windowPreviousCursor: string | null;
  windowNextCursor: string | null;
  canNavigatePrevious: boolean;
  canNavigateNext: boolean;
  pageLoading: boolean;
  pageRequestDirection: "before" | "after" | null;
  pageRequestKind: "prefetch" | "navigation" | null;
  refreshing: boolean;
  pageError: ViewError | null;
  pageErrorKind: "read" | "refresh" | "location" | null;
  retryLocationOid: string | null;
  retryCursor: string | null;
  retryDirection: "before" | "after";
  oldSelectedCommit: HistoryCommit | null;
  oldSelectedObservedAtUnixMs: number | null;
  selectionMissingOnPage: boolean;
  anchorMissing: boolean;
  anchorRestorationSpace: number;
  pageRevision: number;
  windowRevision: number;
  windowPageCount: number;
  /** Error about what is shown: a failed read, or a failed open when nothing else is shown. */
  error: ViewError | null;
  /** Path being opened while the current repository stays on screen. */
  opening: string | null;
  /** A failed open that left the current repository in place. */
  notice: ViewError | null;
  /** Result of the latest "viewed" record for this session. */
  record: ViewRecord | null;
  navigation: RepositoryNavigation | null;
  navigationLoading: boolean;
  navigationError: ViewError | null;
  scopeSwitching: boolean;
  scopeError: ViewError | null;
  scopeErrorTarget: RepositoryScope | null;
  scopeErrorAction: "switch" | "refresh" | null;
  mergeStatuses: Record<string, MergeStatus>;
  mergeStatusLoading: boolean;
  mergeStatusError: ViewError | null;
  recordLoading: boolean;
  metadataIndex: MetadataIndexStatus | null;
  metadataIndexLoading: boolean;
  metadataIndexAction: MetadataIndexAction | null;
  metadataIndexError: ViewError | null;
}

export interface ScopeSwitchResult {
  selectedOid: string | undefined;
  anchor: { oid: string; offset: number } | undefined;
}

export type SessionApi = Pick<RepositorySessionApi,
  "openRepositorySession" | "getRepositorySession" | "readHistoryPage" | "locateCommit" | "cancelHistoryRead" |
  "refreshRepositorySession" | "recordRepositoryView" | "closeRepositorySession" |
  "getRepositoryNavigation" | "selectRepositoryScope" | "getRefMergeStatus" | "cancelRefMergeStatus" |
  "getMetadataIndexStatus" | "controlMetadataIndex">;

function emptyView(revision: number, state: RepositoryViewState = "idle"): RepositoryView {
  return {
    revision, state, session: null, repository: null, refs: [], refsTruncated: false,
    newSinceLastSeenStatus: "unavailable", lastSeenDividerOid: null, commits: [], hasMore: false,
    pageOffset: null, pageSize: 200, pageCursor: null, previousCursor: null, nextCursor: null,
    windowPreviousCursor: null, windowNextCursor: null, canNavigatePrevious: false, canNavigateNext: false,
    pageLoading: false, pageRequestDirection: null, pageRequestKind: null,
    refreshing: false, pageError: null, pageErrorKind: null, retryLocationOid: null, retryCursor: null, retryDirection: "after",
    oldSelectedCommit: null, oldSelectedObservedAtUnixMs: null,
    selectionMissingOnPage: false, anchorMissing: false, anchorRestorationSpace: 0, pageRevision: 0,
    windowRevision: 0, windowPageCount: 0,
    error: null, opening: null, notice: null, record: null,
    navigation: null, navigationLoading: false, navigationError: null,
    scopeSwitching: false, scopeError: null, scopeErrorTarget: null, scopeErrorAction: null, mergeStatuses: {}, mergeStatusLoading: false, mergeStatusError: null,
    recordLoading: false, metadataIndex: null, metadataIndexLoading: false, metadataIndexAction: null, metadataIndexError: null,
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
  private openIntent = 0;
  private navigationOperation = 0;
  private mergeStatusOperation = 0;
  private metadataIndexStatusOperation = 0;
  private metadataIndexControlOperation = 0;
  private scopePending?: Promise<ScopeSwitchResult | undefined>;
  private pageOperation = 0;
  private refreshIntent = 0;
  private refreshRpcStarted = false;
  private refreshingSession?: RepositorySessionInfo;
  private pageRequest?: { cursor: string | null; done: Promise<void> };
  private pages: HistoryPage[] = [];
  private activePageCursor: string | null = null;
  private markerUnavailable = false;
  private viewportAnchorOid?: string;
  private recording?: { session: RepositorySessionInfo; done: Promise<void> };
  private shownSession?: RepositorySessionInfo;

  constructor(private readonly api: SessionApi) {}

  getView = (): RepositoryView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async open(path: string): Promise<void> {
    const openIntent = ++this.openIntent;
    const scopePending = this.scopePending;
    if (scopePending) {
      await scopePending.catch(() => undefined);
      if (openIntent !== this.openIntent) return;
    }
    const operation = ++this.operation;
    ++this.navigationOperation;
    ++this.mergeStatusOperation;
    this.invalidateMetadataIndexSession();
    const pendingPage = this.pageRequest;
    ++this.pageOperation;
    ++this.refreshIntent;
    if (this.refreshingSession && !this.refreshRpcStarted && sameSession(this.view.session, this.refreshingSession)) {
      this.update({ ...this.view, refreshing: false });
      this.refreshingSession = undefined;
    }
    const previous = this.view;
    const keep = previous.state === "ready" && previous.session !== null ? previous.session : null;
    this.update(keep
      ? { ...previous, opening: path, notice: null, pageLoading: false, pageRequestDirection: null, pageRequestKind: null,
        navigationLoading: false, mergeStatusLoading: false }
      : { ...emptyView(0, "loading"), opening: path });
    if (!keep) this.pages = [];

    if (pendingPage) {
      this.pageRequest = undefined;
      await settle(this.api.cancelHistoryRead());
      await pendingPage.done;
      if (operation !== this.operation) return;
    }

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
    this.pages = [];
    this.activePageCursor = null;
    this.markerUnavailable = false;
    this.viewportAnchorOid = undefined;
    this.update({ ...emptyView(0, "loading"), session, repository: session.repository });
    await this.readFirstPage(operation, session);
  }

  async loadNavigation(): Promise<void> {
    const session = this.view.session;
    if (!session || this.view.state !== "ready" || this.view.navigationLoading || this.view.opening !== null || this.view.refreshing || this.view.scopeSwitching) return;
    const operation = ++this.navigationOperation;
    this.update({ ...this.view, navigationLoading: true, navigationError: null });
    const result = await settle(this.api.getRepositoryNavigation());
    if (operation !== this.navigationOperation || !sameSession(this.view.session, session)) return;
    if (!result.ok) {
      this.update({ ...this.view, navigationLoading: false, navigationError: result.error });
      return;
    }
    this.update({ ...this.view, navigation: result.value, navigationLoading: false, navigationError: null });
  }

  async loadRefMergeStatus(refNames: string[]): Promise<void> {
    const session = this.view.session;
    const names = [...new Set(refNames)].slice(0, 50);
    if (!session || this.view.state !== "ready" || !names.length || this.view.mergeStatusLoading ||
      this.view.opening !== null || this.view.refreshing || this.view.scopeSwitching) return;
    const operation = ++this.mergeStatusOperation;
    this.update({ ...this.view, mergeStatusLoading: true, mergeStatusError: null });
    const result = await settle(this.api.getRefMergeStatus(names));
    if (operation !== this.mergeStatusOperation || !sameSession(this.view.session, session)) return;
    if (!result.ok) {
      this.update({ ...this.view, mergeStatusLoading: false, mergeStatusError: result.error });
      return;
    }
    const statuses = { ...this.view.mergeStatuses };
    for (const item of result.value.statuses) statuses[item.name] = item.status;
    this.update({ ...this.view, mergeStatuses: statuses, mergeStatusLoading: false, mergeStatusError: null });
  }

  async cancelRefMergeStatus(): Promise<void> {
    ++this.mergeStatusOperation;
    const { session } = this.view;
    const pending = settle(this.api.cancelRefMergeStatus());
    if (session) await pending;
    if (session && sameSession(this.view.session, session)) this.update({ ...this.view, mergeStatusLoading: false });
  }

  async loadMetadataIndexStatus(): Promise<"loaded" | "busy" | "failed" | "skipped"> {
    const session = this.view.session;
    if (!session || !isMetadataIndexRequestIdle(this.view) || this.view.metadataIndexLoading || this.view.metadataIndexAction) return "skipped";
    const operation = ++this.metadataIndexStatusOperation;
    this.update({ ...this.view, metadataIndexLoading: true, metadataIndexError: null });
    const result = await settle(this.api.getMetadataIndexStatus());
    if (operation !== this.metadataIndexStatusOperation || !sameSession(this.view.session, session)) return "skipped";
    if (!result.ok) {
      const busy = result.error.code === "BUSY";
      this.update({ ...this.view, metadataIndexLoading: false, metadataIndexError: busy ? this.view.metadataIndexError : result.error });
      return busy ? "busy" : "failed";
    }
    this.update({ ...this.view, metadataIndex: result.value, metadataIndexLoading: false, metadataIndexError: null });
    return "loaded";
  }

  async controlMetadataIndex(action: MetadataIndexAction): Promise<boolean> {
    const session = this.view.session;
    if (!session || !isMetadataIndexRequestIdle(this.view) || this.view.metadataIndexLoading || this.view.metadataIndexAction) return false;
    const operation = ++this.metadataIndexControlOperation;
    this.update({ ...this.view, metadataIndexLoading: false, metadataIndexAction: action, metadataIndexError: null });
    const result = await settle(this.api.controlMetadataIndex(action));
    if (operation !== this.metadataIndexControlOperation || !sameSession(this.view.session, session)) return false;
    if (!result.ok) {
      this.update({ ...this.view, metadataIndexAction: null, metadataIndexError: result.error });
      return false;
    }
    this.update({ ...this.view, metadataIndex: result.value, metadataIndexAction: null, metadataIndexError: null });
    return true;
  }

  invalidateMetadataIndexStatus(): void {
    ++this.metadataIndexStatusOperation;
    if (this.view.metadataIndexLoading) this.update({ ...this.view, metadataIndexLoading: false });
  }

  private invalidateMetadataIndexSession(): void {
    ++this.metadataIndexStatusOperation;
    ++this.metadataIndexControlOperation;
    if (this.view.metadataIndexLoading || this.view.metadataIndexAction !== null) {
      this.update({ ...this.view, metadataIndexLoading: false, metadataIndexAction: null });
    }
  }

  switchScope(scope: RepositoryScope, selectedOid?: string, anchor?: { oid: string; offset: number }): Promise<ScopeSwitchResult | undefined> {
    const session = this.view.session;
    if (!session || this.view.state !== "ready" || this.view.scopeSwitching || this.view.refreshing || sameScope(session.scope, scope)) {
      return Promise.resolve(undefined);
    }
    const pending = this.performScopeSwitch(scope, selectedOid, anchor);
    this.scopePending = pending;
    void pending.finally(() => { if (this.scopePending === pending) this.scopePending = undefined; }).catch(() => undefined);
    return pending;
  }

  private async performScopeSwitch(scope: RepositoryScope, selectedOid?: string, anchor?: { oid: string; offset: number }): Promise<ScopeSwitchResult | undefined> {
    const previous = this.view;
    const session = previous.session;
    if (!session || previous.state !== "ready" || previous.scopeSwitching || previous.refreshing || sameScope(session.scope, scope)) return undefined;
    const operation = ++this.operation;
    ++this.pageOperation;
    ++this.refreshIntent;
    ++this.navigationOperation;
    ++this.mergeStatusOperation;
    this.invalidateMetadataIndexSession();
    if (this.refreshingSession && sameSession(previous.session, this.refreshingSession)) {
      this.refreshingSession = undefined;
      this.refreshRpcStarted = false;
    }
    const pendingPage = this.pageRequest;
    this.update({ ...previous, scopeSwitching: true, refreshing: false, scopeError: null, scopeErrorTarget: null, scopeErrorAction: null, pageLoading: false,
      pageRequestDirection: null, pageRequestKind: null, navigationLoading: false,
      mergeStatusLoading: false, mergeStatusError: null });
    if (pendingPage) {
      this.pageRequest = undefined;
      await settle(this.api.cancelHistoryRead());
      await pendingPage.done;
      if (operation !== this.operation) return undefined;
    }
    await settle(this.api.cancelRefMergeStatus());
    if (operation !== this.operation || !sameSession(this.view.session, session)) return undefined;
    await this.recordView();
    if (operation !== this.operation || !sameSession(this.view.session, session)) return undefined;
    const result = await settle(this.api.selectRepositoryScope(scope, previous.pageSize));
    if (operation !== this.operation || !sameSession(this.view.session, session)) return undefined;
    if (!result.ok) {
      this.update({ ...this.view, scopeSwitching: false, scopeError: result.error, scopeErrorTarget: scope, scopeErrorAction: "switch" });
      return undefined;
    }
    const { session: nextSession, page } = result.value;
    if (!validHistoryPage(page, previous.pageSize) ||
      nextSession.repositoryKey !== session.repositoryKey || nextSession.worktreeId !== session.worktreeId ||
      nextSession.repository.path !== session.repository.path || !sameScope(nextSession.scope, scope) ||
      nextSession.repoId === session.repoId || nextSession.generation === session.generation) {
      this.update({ ...this.view, scopeSwitching: false, scopeError: { code: "PROTOCOL_ERROR", message: "范围切换返回的快照与窗口身份不匹配" }, scopeErrorTarget: scope, scopeErrorAction: "switch" });
      return undefined;
    }
    const activeSelectionOid = this.selectedOid ?? selectedOid;
    const selection = this.view.commits.find(commit => commit.oid === activeSelectionOid) ??
      (this.view.oldSelectedCommit?.oid === activeSelectionOid ? this.view.oldSelectedCommit : null);
    const oldSelectedObservedAtUnixMs = selection === this.view.oldSelectedCommit
      ? this.view.oldSelectedObservedAtUnixMs : session.observedAtUnixMs;
    const selectedStillLoaded = !selection || page.commits.some(commit => commit.oid === selection.oid);
    const anchorStillLoaded = !anchor || page.commits.some(commit => commit.oid === anchor.oid);
    this.shownSession = undefined;
    this.pageRequest = undefined;
    this.pages = [page];
    this.activePageCursor = page.cursor;
    this.markerUnavailable = page.newSinceLastSeenStatus === "unavailable";
    this.viewportAnchorOid = anchorStillLoaded ? anchor?.oid : undefined;
    this.update({
      ...this.view,
      state: "ready", session: nextSession, repository: page.repository, refs: page.refs, refsTruncated: page.refsTruncated,
      newSinceLastSeenStatus: page.newSinceLastSeenStatus,
      lastSeenDividerOid: page.newSinceLastSeenStatus === "ready" ? page.lastSeenDividerOid : null,
      commits: page.commits, hasMore: page.hasMore, pageOffset: page.offset, pageSize: page.pageSize,
      pageCursor: page.cursor, previousCursor: page.previousCursor, nextCursor: page.nextCursor,
      windowPreviousCursor: page.previousCursor, windowNextCursor: page.nextCursor,
      canNavigatePrevious: page.previousCursor !== null, canNavigateNext: page.nextCursor !== null,
      pageLoading: false, pageRequestDirection: null, pageRequestKind: null,
      pageError: null, pageErrorKind: null, retryCursor: null,
      oldSelectedCommit: selectedStillLoaded ? null : selection ?? null,
      oldSelectedObservedAtUnixMs: selectedStillLoaded ? null : oldSelectedObservedAtUnixMs,
      selectionMissingOnPage: Boolean(selection && !selectedStillLoaded),
      anchorMissing: Boolean(anchor && !anchorStillLoaded), anchorRestorationSpace: 0,
      pageRevision: previous.pageRevision + 1, windowRevision: previous.windowRevision + 1, windowPageCount: 1,
      navigation: null, navigationLoading: false, navigationError: null, mergeStatuses: {},
      mergeStatusLoading: false, mergeStatusError: null, scopeSwitching: false, scopeError: null, scopeErrorTarget: null, scopeErrorAction: null,
      record: null, recordLoading: false, metadataIndex: null, metadataIndexLoading: false, metadataIndexAction: null, metadataIndexError: null,
      error: null, notice: null,
    });
    return { selectedOid: selection?.oid, anchor: anchorStillLoaded ? anchor : undefined };
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
    if (cursor !== null) await this.readPageAndReturn(cursor, "prefetch");
  }

  async previousPage(): Promise<string | undefined> {
    if (this.view.pageLoading && this.view.pageRequestKind === "prefetch") await this.cancelPage();
    const index = this.pages.findIndex(page => page.cursor === this.activePageCursor);
    if (index > 0) {
      const page = this.pages[index - 1]!;
      this.setActivePage(page);
      return page.commits.at(-1)?.oid;
    }
    if (this.pages[0]?.previousCursor === null || !this.pages[0]?.previousCursor) return undefined;
    const cursor = this.pages[0]!.previousCursor!;
    const page = await this.readPageAndReturn(cursor, "navigation");
    return page?.commits.at(-1)?.oid;
  }

  async nextPage(): Promise<string | undefined> {
    if (this.view.pageLoading && this.view.pageRequestKind === "prefetch") await this.cancelPage();
    const index = this.pages.findIndex(page => page.cursor === this.activePageCursor);
    if (index >= 0 && index < this.pages.length - 1) {
      const page = this.pages[index + 1]!;
      this.setActivePage(page);
      return page.commits[0]?.oid;
    }
    if (this.pages.at(-1)?.nextCursor === null || !this.pages.at(-1)?.nextCursor) return undefined;
    const cursor = this.pages.at(-1)!.nextCursor!;
    const page = await this.readPageAndReturn(cursor, "navigation");
    return page?.commits[0]?.oid;
  }

  async loadWindowEdge(direction: "before" | "after"): Promise<string | undefined> {
    const cursor = direction === "before" ? this.view.windowPreviousCursor : this.view.windowNextCursor;
    if (!cursor) return undefined;
    const page = await this.readPageAndReturn(cursor, "navigation");
    return direction === "before" ? page?.commits.at(-1)?.oid : page?.commits[0]?.oid;
  }

  async readPageAndReturn(cursor: string, kind: "prefetch" | "navigation" = "navigation"): Promise<HistoryPage | undefined> {
    const { session, state } = this.view;
    if (!session || state !== "ready" || this.view.refreshing || this.view.scopeSwitching) return undefined;
    this.invalidateMetadataIndexStatus();
    const direction = cursor === this.view.windowPreviousCursor ? "before" : "after";
    if ((direction === "before" ? this.pages[0]?.previousCursor : this.pages.at(-1)?.nextCursor) !== cursor) return undefined;
    const token = ++this.pageOperation;
    const previous = this.pageRequest;
    if (previous) {
      await settle(this.api.cancelHistoryRead());
      await previous.done;
      if (token !== this.pageOperation || !sameSession(this.view.session, session)) return undefined;
    }
    this.update({ ...this.view, pageLoading: true, pageRequestDirection: direction, pageRequestKind: kind, pageError: null, pageErrorKind: null, anchorRestorationSpace: 0 });
    const done = this.loadPage(token, session, cursor, direction);
    const tracked = done.then(() => undefined);
    this.pageRequest = { cursor, done: tracked };
    const page = await done;
    if (page && kind === "navigation") this.activePageCursor = page.cursor;
    if (page && kind === "navigation") this.updateActivePageFields();
    if (this.pageRequest?.done === tracked) this.pageRequest = undefined;
    return page;
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
    this.update({ ...this.view, pageLoading: false, pageRequestDirection: null, pageRequestKind: null });
  }

  async locateCommit(oid: string): Promise<boolean> {
    const session = this.view.session;
    if (!session || this.view.state !== "ready" || this.view.opening !== null || this.view.refreshing || this.view.scopeSwitching) return false;
    if (this.pageRequest) await this.cancelPage();
    if (!sameSession(this.view.session, session) || this.view.state !== "ready" || this.view.refreshing || this.view.scopeSwitching) return false;
    const operation = ++this.pageOperation;
    this.update({ ...this.view, pageLoading: true, pageRequestDirection: null, pageRequestKind: "navigation", pageError: null, pageErrorKind: null, retryLocationOid: oid });
    const done = (async (): Promise<boolean> => {
      const result = await settle(this.api.locateCommit(oid, this.view.pageSize));
      if (operation !== this.pageOperation || !sameSession(this.view.session, session)) return false;
      if (!result.ok) {
        this.update({ ...this.view, pageLoading: false, pageRequestDirection: null, pageRequestKind: null, pageError: result.error, pageErrorKind: "location", retryLocationOid: oid });
        return false;
      }
      const page = result.value;
      if (!validHistoryPage(page, this.view.pageSize) || !page.commits.some(commit => commit.oid === oid)) {
        this.update({ ...this.view, pageLoading: false, pageRequestDirection: null, pageRequestKind: null,
          pageError: { code: "PROTOCOL_ERROR", message: "定位结果没有包含目标提交" }, pageErrorKind: "location", retryLocationOid: oid });
        return false;
      }
      this.pages = [page];
      this.activePageCursor = page.cursor;
      this.markerUnavailable = page.newSinceLastSeenStatus === "unavailable";
      this.selectedOid = oid;
      this.viewportAnchorOid = oid;
      this.applyWindow(session, this.pages, "ready", {
        pageRevision: this.view.pageRevision + 1,
        oldSelectedCommit: null,
        oldSelectedObservedAtUnixMs: null,
        selectionMissingOnPage: false,
        anchorMissing: false,
        retryCursor: null,
        pageErrorKind: null,
        retryLocationOid: null,
      });
      return true;
    })();
    const tracked = done.then(() => undefined);
    this.pageRequest = { cursor: null, done: tracked };
    const located = await done;
    if (this.pageRequest?.done === tracked) this.pageRequest = undefined;
    return located;
  }

  async retryPage(selectedOid = this.selectedOid): Promise<void> {
    if (this.view.pageErrorKind === "refresh") return this.refresh(selectedOid);
    if (this.view.pageErrorKind === "location" && this.view.retryLocationOid) { await this.locateCommit(this.view.retryLocationOid); return; }
    if (this.view.pageErrorKind === "read") return this.readPageAndReturn(this.view.retryCursor ?? "", "navigation").then(() => undefined);
    if (this.view.state === "error") return this.retry();
  }

  async refresh(selectedOid?: string, anchor?: { oid: string; offset: number }): Promise<void> {
    const session = this.view.session;
    if (!session || this.view.state !== "ready" || this.view.refreshing || this.view.scopeSwitching) return;
    const intent = ++this.refreshIntent;
    ++this.navigationOperation;
    ++this.mergeStatusOperation;
    this.invalidateMetadataIndexSession();
    const selected = this.view.commits.find(commit => commit.oid === selectedOid) ?? this.view.oldSelectedCommit;
    const oldSelectedObservedAtUnixMs = this.view.oldSelectedCommit && selected === this.view.oldSelectedCommit
      ? this.view.oldSelectedObservedAtUnixMs : session.observedAtUnixMs;
    const oldPageRequest = this.pageRequest;
    ++this.pageOperation;
    this.refreshingSession = session;
    this.refreshRpcStarted = false;
    this.update({ ...this.view, refreshing: true, pageLoading: false, pageRequestDirection: null, pageRequestKind: null, pageError: null, pageErrorKind: null, anchorMissing: false, anchorRestorationSpace: 0,
      navigationLoading: false, mergeStatusLoading: false });
    await settle(this.api.cancelRefMergeStatus());
    if (intent !== this.refreshIntent || !sameSession(this.view.session, session)) return;
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
      const unavailableScope = result.error.code === "SCOPE_UNAVAILABLE";
      this.update({ ...latest, refreshing: false, pageError: result.error, pageErrorKind: "refresh",
        scopeError: unavailableScope ? result.error : latest.scopeError,
        scopeErrorTarget: unavailableScope ? session.scope : latest.scopeErrorTarget,
        scopeErrorAction: unavailableScope ? "refresh" : latest.scopeErrorAction });
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
    this.pages = [page];
    this.activePageCursor = page.cursor;
    this.markerUnavailable = page.newSinceLastSeenStatus === "unavailable";
    this.update({
      ...current,
      state: "ready",
      session: refreshedSession,
      repository: page.repository,
      refs: page.refs,
      refsTruncated: page.refsTruncated,
      newSinceLastSeenStatus: page.newSinceLastSeenStatus,
      lastSeenDividerOid: page.newSinceLastSeenStatus === "ready" ? page.lastSeenDividerOid : null,
      commits: page.commits,
      hasMore: page.hasMore,
      pageOffset: page.offset,
      pageSize: page.pageSize,
      pageCursor: page.cursor,
      previousCursor: page.previousCursor,
      nextCursor: page.nextCursor,
      windowPreviousCursor: page.previousCursor,
      windowNextCursor: page.nextCursor,
      canNavigatePrevious: page.previousCursor !== null,
      canNavigateNext: page.nextCursor !== null,
      pageLoading: false,
      pageRequestDirection: null,
      pageRequestKind: null,
      refreshing: false,
      pageError: null,
      retryLocationOid: null,
      pageErrorKind: null,
      retryCursor: null,
      oldSelectedCommit: selectedStillLoaded ? null : selected ?? null,
      oldSelectedObservedAtUnixMs: selectedStillLoaded ? null : oldSelectedObservedAtUnixMs,
      selectionMissingOnPage: Boolean(selected && !selectedStillLoaded),
      anchorMissing: Boolean(anchor && !anchorLoaded),
      anchorRestorationSpace: 0,
      pageRevision: current.pageRevision + 1,
      windowRevision: current.windowRevision + 1,
      windowPageCount: 1,
      navigation: null, navigationLoading: false, navigationError: null, mergeStatuses: {},
      mergeStatusLoading: false, mergeStatusError: null, scopeError: null, scopeErrorTarget: null, scopeErrorAction: null,
      metadataIndex: null, metadataIndexLoading: false, metadataIndexAction: null, metadataIndexError: null, recordLoading: false,
      opening: current.opening,
      error: null,
    });
  }

  /** Stops opening or reading. The session API can only stop by closing, so this closes the repository. */
  async cancel(): Promise<void> {
    if (this.view.state !== "loading" && this.view.opening === null && !this.view.pageLoading &&
      !this.view.refreshing && !this.view.scopeSwitching) return;
    const operation = ++this.operation;
    ++this.refreshIntent;
    ++this.pageOperation;
    ++this.navigationOperation;
    ++this.mergeStatusOperation;
    this.refreshingSession = undefined;
    this.refreshRpcStarted = false;
    this.update(emptyView(0, "cancelled"));
    this.pages = [];
    this.viewportAnchorOid = undefined;
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
    this.update({ ...this.view, recordLoading: true });
    const done = (async () => {
      const result = await settle(this.api.recordRepositoryView(session.generation));
      if (this.view.session !== session) return;
      this.update({
        ...this.view,
        recordLoading: false,
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
    this.pages = [];
    this.viewportAnchorOid = undefined;
    this.refreshingSession = undefined;
    this.refreshRpcStarted = false;
    this.invalidateMetadataIndexSession();
    if (view.state === "ready") {
      this.update({ ...view, session: null, opening: null, pageLoading: false, pageRequestDirection: null, pageRequestKind: null, refreshing: false });
      return;
    }
    this.update({ ...view, session: null, opening: null, pageLoading: false, pageRequestDirection: null, pageRequestKind: null, refreshing: false, state: "error", error: { code: "CORE_EXITED", message: "核心已退出，仓库读取已停止" } });
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
    this.pages = [page.value];
    this.activePageCursor = page.value.cursor;
    this.markerUnavailable = false;
    this.applyWindow(session, this.pages, "ready", { retryCursor: null, retryDirection: "after", pageErrorKind: null });
  }

  private async loadPage(token: number, session: RepositorySessionInfo, cursor: string, direction: "before" | "after"): Promise<HistoryPage | undefined> {
    const requestDone = settle(this.api.readHistoryPage(cursor, this.view.pageSize)).then(result => {
      if (token !== this.pageOperation || !sameSession(this.view.session, session)) return undefined;
      if (!result.ok) {
        this.update({ ...this.view, pageLoading: false, pageRequestDirection: null, pageRequestKind: null, pageError: result.error, pageErrorKind: "read", retryCursor: cursor, retryDirection: direction });
        return undefined;
      }
      if (!validHistoryPage(result.value, this.view.pageSize)) {
        this.update({ ...this.view, pageLoading: false, pageRequestDirection: null, pageRequestKind: null, pageError: { code: "PROTOCOL_ERROR", message: "核心返回的历史页不完整" }, pageErrorKind: "read", retryCursor: cursor, retryDirection: direction });
        return undefined;
      }
      const current = this.view;
      const edge = direction === "before" ? this.pages[0] : this.pages.at(-1);
      const adjacent = direction === "before"
        ? result.value.offset + result.value.commits.length === edge?.offset && result.value.nextCursor === edge.cursor
        : result.value.offset === (edge?.offset ?? -1) + (edge?.commits.length ?? 0) && result.value.previousCursor === edge?.cursor;
      const duplicate = result.value.commits.some(commit => current.commits.some(existing => existing.oid === commit.oid));
      if (!adjacent || duplicate) {
        this.update({ ...current, pageLoading: false, pageRequestDirection: null, pageRequestKind: null, pageError: { code: "PROTOCOL_ERROR", message: "核心返回的历史页与当前窗口不连续" }, pageErrorKind: "read", retryCursor: cursor, retryDirection: direction });
        return undefined;
      }
      const nextPages = direction === "before" ? [result.value, ...this.pages] : [...this.pages, result.value];
      while (nextPages.reduce((total, item) => total + item.commits.length, 0) > 1_800) {
        const protectedIndex = this.viewportAnchorOid
          ? nextPages.findIndex(item => item.commits.some(commit => commit.oid === this.viewportAnchorOid))
          : -1;
        if (direction === "before") {
          if (protectedIndex === nextPages.length - 1) nextPages.shift();
          else nextPages.pop();
        } else if (protectedIndex === 0) nextPages.pop();
        else nextPages.shift();
      }
      this.pages = nextPages;
      const selectedInWindow = current.commits.find(commit => commit.oid === this.selectedOid);
      const selectedCommit = selectedInWindow ?? current.oldSelectedCommit;
      const selectedRetained = !selectedCommit || nextPages.some(item => item.commits.some(commit => commit.oid === selectedCommit.oid));
      const selectedLoaded = Boolean(selectedCommit && nextPages.some(item => item.commits.some(commit => commit.oid === selectedCommit.oid)));
      this.applyWindow(session, nextPages, "ready", {
        oldSelectedCommit: selectedLoaded ? null : selectedRetained ? current.oldSelectedCommit : selectedCommit ?? null,
        oldSelectedObservedAtUnixMs: selectedLoaded ? null : selectedRetained ? current.oldSelectedObservedAtUnixMs : selectedInWindow ? session.observedAtUnixMs : current.oldSelectedObservedAtUnixMs,
        selectionMissingOnPage: Boolean(this.selectedOid && !nextPages.some(item => item.commits.some(commit => commit.oid === this.selectedOid))),
        retryCursor: cursor,
        retryDirection: direction,
        pageErrorKind: null,
      });
      return result.value;
    });
    return await requestDone;
  }

  private selectedOid?: string;

  setSelectedOid(oid: string | undefined): void {
    this.selectedOid = oid;
    const selectedPage = oid ? this.pages.find(page => page.commits.some(commit => commit.oid === oid)) : undefined;
    if (selectedPage && selectedPage.cursor !== this.activePageCursor) {
      this.activePageCursor = selectedPage.cursor;
      this.updateActivePageFields();
    }
    if (this.view.selectionMissingOnPage && this.view.commits.some(commit => commit.oid === oid)) {
      this.update({ ...this.view, selectionMissingOnPage: false, oldSelectedCommit: null });
    }
  }

  suspendHistoryWindow(selectedOid: string | undefined, anchor: { oid: string; offset: number } | null): {
    cursor: string | null;
    selectedOid: string | undefined;
    selectedCommit: HistoryCommit | null;
    anchor: { oid: string; offset: number } | null;
  } {
    const anchorPage = anchor ? this.pages.find(page => page.commits.some(commit => commit.oid === anchor.oid)) : undefined;
    const selectedCommit = this.view.commits.find(commit => commit.oid === selectedOid) ??
      (this.view.oldSelectedCommit?.oid === selectedOid ? this.view.oldSelectedCommit : null);
    const point = { cursor: anchorPage?.cursor ?? this.activePageCursor, selectedOid, selectedCommit, anchor };
    const pending = this.pageRequest;
    ++this.pageOperation;
    this.pageRequest = undefined;
    if (pending) void this.api.cancelHistoryRead();
    this.pages = [];
    this.activePageCursor = null;
    this.viewportAnchorOid = undefined;
    this.update({ ...this.view, commits: [], pageOffset: null, pageCursor: null, previousCursor: null, nextCursor: null,
      windowPreviousCursor: null, windowNextCursor: null, hasMore: false, canNavigatePrevious: false, canNavigateNext: false,
      pageLoading: false, pageRequestDirection: null, pageRequestKind: null, pageError: null, pageErrorKind: null,
      oldSelectedCommit: null, oldSelectedObservedAtUnixMs: null, selectionMissingOnPage: false, anchorMissing: false,
      anchorRestorationSpace: 0, windowPageCount: 0 });
    return point;
  }

  async restoreHistoryWindow(point: {
    cursor: string | null;
    selectedOid: string | undefined;
    selectedCommit: HistoryCommit | null;
    anchor: { oid: string; offset: number } | null;
  }): Promise<boolean> {
    const session = this.view.session;
    if (!session || this.view.state !== "ready") return false;
    if (this.pageRequest) await this.cancelPage();
    const operation = ++this.pageOperation;
    this.update({ ...this.view, pageLoading: true, pageRequestDirection: null, pageRequestKind: null, pageError: null });
    const done = (async (): Promise<boolean> => {
      let result = await settle(this.api.readHistoryPage(point.cursor, this.view.pageSize));
      if (!result.ok && point.cursor !== null && ["INVALID_CURSOR", "SNAPSHOT_CHANGED"].includes(result.error.code)) {
        result = await settle(this.api.readHistoryPage(null, this.view.pageSize));
      }
      if (operation !== this.pageOperation || !sameSession(this.view.session, session)) return false;
      if (!result.ok || !validHistoryPage(result.value, this.view.pageSize)) {
        this.update({ ...this.view, pageLoading: false, pageError: result.ok
          ? { code: "PROTOCOL_ERROR", message: "恢复的历史页不完整" } : result.error, pageErrorKind: "read" });
        return false;
      }
      const page = result.value;
      this.pages = [page];
      this.activePageCursor = page.cursor;
      this.markerUnavailable = page.newSinceLastSeenStatus === "unavailable";
      this.selectedOid = point.selectedOid;
      const selectedStillLoaded = Boolean(point.selectedOid && page.commits.some(commit => commit.oid === point.selectedOid));
      const anchorOid = point.anchor?.oid;
      const anchorStillLoaded = Boolean(anchorOid && page.commits.some(commit => commit.oid === anchorOid));
      this.applyWindow(session, this.pages, "ready", {
        pageRevision: this.view.pageRevision + 1,
        oldSelectedCommit: selectedStillLoaded ? null : point.selectedCommit,
        oldSelectedObservedAtUnixMs: selectedStillLoaded || !point.selectedCommit ? null : session.observedAtUnixMs,
        selectionMissingOnPage: Boolean(point.selectedOid && !selectedStillLoaded),
        anchorMissing: Boolean(point.anchor && !anchorStillLoaded),
        anchorRestorationSpace: 0,
      });
      return true;
    })();
    const tracked = done.then(() => undefined);
    this.pageRequest = { cursor: point.cursor, done: tracked };
    const restored = await done;
    if (this.pageRequest?.done === tracked) this.pageRequest = undefined;
    return restored;
  }

  setViewportAnchor(oid: string | undefined): void {
    this.viewportAnchorOid = oid;
  }

  setAnchorRestorationSpace(pixels: number): void {
    const bounded = Number.isFinite(pixels) ? Math.max(0, Math.min(2_000, Math.floor(pixels))) : 0;
    if (bounded === this.view.anchorRestorationSpace) return;
    this.update({ ...this.view, anchorRestorationSpace: bounded });
  }

  private applyWindow(
    session: RepositorySessionInfo,
    pages: HistoryPage[],
    state: "ready" | "loading",
    extra: Partial<RepositoryView> = {},
  ): void {
    const first = pages[0];
    const last = pages.at(-1);
    if (!first || !last) return;
    const activePage = pages.find(page => page.cursor === this.activePageCursor) ?? first;
    this.activePageCursor = activePage.cursor;
    if (pages.some(page => page.newSinceLastSeenStatus === "unavailable")) this.markerUnavailable = true;
    const newSinceLastSeenStatus: NewSinceLastSeenStatus = this.markerUnavailable
      ? "unavailable"
      : pages.some(page => page.newSinceLastSeenStatus === "firstView") ? "firstView" : "ready";
    const commits = pages.flatMap(page => page.commits).map(commit =>
      newSinceLastSeenStatus === "ready" ? commit : { ...commit, isNewSinceLastSeen: false });
    const lastSeenDividerOid = newSinceLastSeenStatus === "ready"
      ? pages.find(page => page.lastSeenDividerOid !== null)?.lastSeenDividerOid ?? null
      : null;
    this.update({
      ...this.view,
      state,
      session,
      repository: first.repository,
      refs: first.refs,
      refsTruncated: first.refsTruncated,
      newSinceLastSeenStatus,
      lastSeenDividerOid,
      commits,
      hasMore: last.nextCursor !== null,
      pageOffset: first.offset,
      pageSize: first.pageSize,
      pageCursor: activePage.cursor,
      previousCursor: activePage.previousCursor,
      nextCursor: activePage.nextCursor,
      windowPreviousCursor: first.previousCursor,
      windowNextCursor: last.nextCursor,
      canNavigatePrevious: pages[0] !== activePage || activePage.previousCursor !== null,
      canNavigateNext: pages.at(-1) !== activePage || activePage.nextCursor !== null,
      pageLoading: false,
      pageRequestDirection: null,
      pageRequestKind: null,
      windowPageCount: pages.length,
      windowRevision: this.view.windowRevision + 1,
      anchorRestorationSpace: 0,
      pageError: null,
      retryLocationOid: null,
      error: null,
      ...extra,
    });
  }

  private setActivePage(page: HistoryPage): void {
    this.activePageCursor = page.cursor;
    this.updateActivePageFields();
  }

  private updateActivePageFields(): void {
    const index = this.pages.findIndex(page => page.cursor === this.activePageCursor);
    if (index < 0) return;
    const page = this.pages[index]!;
    this.update({
      ...this.view,
      pageCursor: page.cursor,
      previousCursor: page.previousCursor,
      nextCursor: page.nextCursor,
      canNavigatePrevious: index > 0 || page.previousCursor !== null,
      canNavigateNext: index < this.pages.length - 1 || page.nextCursor !== null,
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

function sameScope(left: RepositoryScope, right: RepositoryScope): boolean {
  return typeof left === "string" || typeof right === "string"
    ? left === right
    : "ref" in left && "ref" in right ? left.ref === right.ref
      : "worktree" in left && "worktree" in right ? left.worktree === right.worktree : false;
}

function sameRepository(left: RepositorySessionInfo, right: RepositorySessionInfo): boolean {
  return left.repositoryKey === right.repositoryKey && left.worktreeId === right.worktreeId;
}

export function isMetadataIndexRequestIdle(view: RepositoryView): boolean {
  return view.state === "ready" && view.opening === null && !view.refreshing && !view.scopeSwitching &&
    !view.pageLoading && !view.navigationLoading && !view.mergeStatusLoading && !view.recordLoading;
}

function validHistoryPage(page: HistoryPage, requestedPageSize: number): boolean {
  return Number.isInteger(page.offset) && page.offset >= 0 && page.pageSize === requestedPageSize && page.commits.length <= requestedPageSize &&
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
