import * as React from "react";
import { X } from "lucide-react";
import type { CoreStatus } from "../../../../packages/protocol/src/core-status.js";
import type { ActivityStats, HandoffFacts, RefSnapshotDiff, RepositoryObservation, RepositorySessionInfo, SearchIdentity } from "../../../../packages/protocol/src/generated/server-message.js";
import type { RepositoryScope } from "../../../../packages/protocol/src/generated/server-message.js";
import type { GetHandoffFactsParams } from "../../../../packages/protocol/src/generated/client-message.js";
import type { RepositoryNavigation } from "../../../../packages/protocol/src/repository-session.js";
import type { HandoffRequest } from "./components/handoff-dialog.js";
import { fetchFailedRequest, handoffFactsTarget } from "./lib/handoff-prompt.js";
import { CreateBranchDialog, type BranchStart } from "./components/create-branch-dialog.js";
import { FastForwardMergeDialog, type FastForwardMergeTarget } from "./components/fast-forward-merge-dialog.js";
import { FetchFailureBanner, type FetchNoticeValue } from "./components/operation-banners.js";
import { OperationFailureBanner, OperationNoticeBanner, OperationRefusal } from "./components/operation-outcomes.js";
import { OperationsStore } from "./lib/operations-store.js";
import { useOperations, type OperationsActions } from "./lib/use-operations.js";
import { refTip, webRemote } from "./lib/operations.js";
import type { SearchQuery, SearchTimeField } from "../../../../packages/protocol/src/generated/client-message.js";
import { COMMIT_DETAIL_SCROLL_EVENT, CommitDetail } from "./components/commit-detail.js";
import { CommitList } from "./components/commit-list.js";
import { SearchResultList } from "./components/search-result-list.js";
import { HistorySplitView, useNarrowHistoryLayout } from "./components/history-split-view.js";
import { OpenScreen } from "./components/open-screen.js";
import type { RecentState } from "./components/recent-repositories.js";
import { StatusBar } from "./components/status-bar.js";
import { FOCUS_SEARCH_EVENT, TopBar } from "./components/top-bar.js";
import type { AppPage } from "./components/page-switch.js";
import { PageSearchBox, SearchControls } from "./components/search-controls.js";
import { StatsPage } from "./components/stats-page.js";
import { WorkspacePage } from "./components/workspace-page.js";
import { DiffFullContext, useDiffDisplayShortcuts } from "./components/diff-view.js";
import { FilesPage, type FilesActions, type VersionOption } from "./components/files-page.js";
import { FilesStore, type FilesSelection, type FilesTab, type FilesView, type TreeVersion } from "./lib/files-store.js";
import { NavigationHistory } from "./lib/navigation-history.js";
import { diffDisplay } from "./lib/diff-display.js";
import type { ChangedFile, GitPath } from "../../../../packages/protocol/src/generated/server-message.js";
import { workspaceBadge, workspaceBranchLabel } from "./lib/workspace-indicator.js";
import { WorkspaceStore, workspaceIndicatorFor } from "./lib/workspace-store.js";
import { cn } from "./lib/utils.js";
import { errorTitle } from "./lib/errors.js";
import { repositoryName, shortOid, shortRefName } from "./lib/format.js";
import { RepositorySessionStore, settle, type RepositoryView } from "./lib/repository-session-store.js";
import { applySelectionIfCurrent, SelectionIntent, type SelectionIntentToken } from "./lib/selection-intent.js";
import { hasSearchCriteria, MetadataSearchStore } from "./lib/metadata-search-store.js";
import { DEFAULT_SEARCH_QUERY } from "./lib/metadata-search-store.js";
import { inputDateRange } from "./lib/search-date.js";
import { CommitDetailStore } from "./lib/commit-detail-store.js";
import { Button } from "./components/ui/button.js";
import { HandoffDialog } from "./components/handoff-dialog.js";
import { CommandPalette } from "./components/command-palette.js";
import type { PaletteAction } from "./lib/command-palette.js";

export interface RepositoryActions {
  path: string;
  setPath(path: string): void;
  open(path?: string): Promise<void>;
  choose(): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<void>;
  retryPage(): Promise<void>;
  cancelPage(): Promise<void>;
  previousPage(): Promise<string | undefined>;
  nextPage(): Promise<string | undefined>;
  refresh(): Promise<void>;
  switchScope(scope: RepositoryScope): Promise<void>;
  /** P5-01: null while the core cannot run operations. Fetches all remotes or a named remote, then refreshes. */
  fetch: { running: boolean; startedAt: number | null; start(prune?: boolean, remote?: string | null): Promise<void>; cancel(): void; notice: FetchNoticeValue | null; dismissNotice(): void } | null;
  /** M5: null while the core cannot run operations. Update, switch, create branch and the branch sync behind the tags. */
  operations: OperationsActions | null;
}

/** Subscribes to core status, ignoring stale revisions. */
function useCoreStatus() {
  const [status, setStatus] = React.useState<CoreStatus>({ state: "starting", revision: -1 });
  const [readError, setReadError] = React.useState<string>();
  const revision = React.useRef(-1);

  React.useEffect(() => {
    let active = true;
    const accept = (next: CoreStatus) => {
      if (!active || next.revision <= revision.current) return;
      revision.current = next.revision;
      setReadError(undefined);
      setStatus(next);
    };
    const unsubscribe = window.commitScope.onCoreStatusChanged(accept);
    void window.commitScope.getCoreStatus().then(accept).catch(error => {
      if (active) setReadError(String(error));
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  return { status, readError };
}

/** Recent worktrees from the app data directory; refreshed when the core is ready and after each open. */
function useRecentRepositories(ready: boolean, session: RepositorySessionInfo | null) {
  const [recent, setRecent] = React.useState<RecentState>({ loaded: false, repositories: [], status: null, error: null });
  const request = React.useRef(0);
  const sessionIdentity = session ? `${session.repositoryKey}:${session.worktreeId}` : null;
  const refresh = React.useCallback(() => {
    const id = ++request.current;
    void settle(window.commitScope.listRecentRepositories()).then(result => {
      if (id !== request.current) return;
      setRecent(result.ok
        ? { loaded: true, repositories: result.value.repositories, status: result.value.status, error: null }
        : { loaded: true, repositories: [], status: null, error: result.error.message });
    });
  }, []);
  React.useEffect(() => { if (ready) refresh(); }, [ready, sessionIdentity, refresh]);
  return { recent, refresh };
}

function useMetadataIndexPolling(ready: boolean, supported: boolean, store: RepositorySessionStore, view: RepositoryView,
  searchBusy: boolean) {
  const sessionKey = view.session ? `${view.session.repoId}:${view.session.generation}` : null;
  const blocked = searchBusy || view.state !== "ready" || view.opening !== null || view.refreshing || view.scopeSwitching || view.pageLoading ||
    view.navigationLoading || view.mergeStatusLoading || view.recordLoading || view.metadataIndexAction !== null;
  React.useEffect(() => {
    if (!ready || !supported || !sessionKey || blocked) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      if (active && document.visibilityState === "visible") timer = setTimeout(() => { void poll(); }, delay);
    };
    const poll = async () => {
      if (!active || document.visibilityState !== "visible") return;
      const result = await store.loadMetadataIndexStatus();
      if (!active) return;
      const state = store.getView().metadataIndex?.state;
      schedule(result === "busy" ? 1_500 : state === "running" || state === "queued" ? 1_000 : 5_000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        if (timer) clearTimeout(timer);
        store.invalidateMetadataIndexStatus();
      } else {
        if (timer) clearTimeout(timer);
        schedule(100);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (document.visibilityState === "visible") schedule(250);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      store.invalidateMetadataIndexStatus();
    };
  }, [ready, supported, sessionKey, blocked, store]);
}

/**
 * Marks the shown HEAD as viewed: once when it first appears in a focused window,
 * and again when the window loses focus or is hidden (switching is handled by the store).
 */
function useViewRecording(store: RepositorySessionStore, view: RepositoryView) {
  React.useEffect(() => {
    if (document.visibilityState === "visible" && document.hasFocus()) void store.markShown();
  }, [store, view.state, view.session]);
  React.useEffect(() => {
    const onFocus = () => { if (document.visibilityState === "visible") void store.markShown(); };
    const onLeave = () => { void store.recordView(); };
    const onVisibility = () => { if (document.visibilityState === "hidden") onLeave(); else onFocus(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onLeave);
    window.addEventListener("pagehide", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("pagehide", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [store]);
}

/** Opens the repository given with `--repository=` once the core is ready. */
function useLaunchRepository(ready: boolean, store: RepositorySessionStore) {
  const handled = React.useRef(false);
  React.useEffect(() => {
    if (!ready || handled.current) return;
    handled.current = true;
    void window.commitScope.getLaunchRepository().then(path => {
      const view = store.getView();
      if (path && view.state === "idle" && view.opening === null) void store.open(path);
    }).catch(() => undefined);
  }, [ready, store]);
}

const FILES_HISTORY_OPEN_KEY = "commitscope.files.historyOpen";

/** A place back / forward can return to: the page, and where on it. Scroll offsets are not kept; the place is re-read. */
type AppPlace = { key: string; label: string; /** A few words for the back button right after a jump. */ short?: string } & (
  | { page: "commits"; oid: string | null }
  | { page: "workspace" }
  | { page: "stats" }
  | { page: "files"; version: TreeVersion | null; selection: FilesSelection | null; tab: FilesTab; selectedCommit: string | null });

function filesPlace(view: FilesView): AppPlace {
  const selection = view.selection;
  const showingChange = selection?.kind === "file" && view.tab === "history" && view.selectedCommit !== null;
  const name = selection ? selection.path.display.split("/").at(-1) || selection.path.display || "仓库" : "";
  const label = !selection ? "文件页" : selection.kind === "directory" ? `${name} 的历史`
    : showingChange ? `${name} 在 ${shortOid(view.selectedCommit!)} 的修改` : name;
  const key = JSON.stringify(["files", view.version?.commit ?? null, selection?.path.rawHex ?? null, selection?.kind ?? null, showingChange ? view.selectedCommit : null]);
  return { key, label, short: name || "文件页", page: "files", version: view.version, selection, tab: showingChange ? "history" : "content", selectedCommit: showingChange ? view.selectedCommit : null };
}

export function App(): React.JSX.Element {
  const { status, readError } = useCoreStatus();
  const store = React.useMemo(() => new RepositorySessionStore(window.commitScope), []);
  const searchStore = React.useMemo(() => new MetadataSearchStore(window.commitScope), []);
  const fullFileWanted = React.useRef(false);
  const detailStore = React.useMemo(() => new CommitDetailStore(window.commitScope, () => fullFileWanted.current && diffDisplay.getView().scope === "full"), []);
  const operationsStore = React.useMemo(() => new OperationsStore(window.commitScope), []);
  const workspaceStore = React.useMemo(() => new WorkspaceStore(window.commitScope, () => Date.now(), () => fullFileWanted.current && diffDisplay.getView().scope === "full"), []);
  const filesStore = React.useMemo(() => new FilesStore(window.commitScope, () => diffDisplay.getView().scope === "full"), []);
  // The history column stays as the user last left it.
  React.useEffect(() => {
    try { if (localStorage.getItem(FILES_HISTORY_OPEN_KEY) === "true") filesStore.setHistoryOpen(true); } catch { /* storage unavailable: start closed */ }
  }, [filesStore]);
  const selectionIntent = React.useMemo(() => new SelectionIntent(), []);
  const view = React.useSyncExternalStore(store.subscribe, store.getView);
  const searchView = React.useSyncExternalStore(searchStore.subscribe, searchStore.getView);
  const detailView = React.useSyncExternalStore(detailStore.subscribe, detailStore.getView);
  const workspaceView = React.useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getView);
  const filesView = React.useSyncExternalStore(filesStore.subscribe, filesStore.getView);
  const ready = status.state === "ready";
  const metadataIndexSupported = ready && status.core.capabilities.includes("metadataIndex");
  const operationsSupported = ready && status.core.capabilities.includes("repositoryOperations");
  const [fetchPhase, setFetchPhase] = React.useState<number | "refreshing" | null>(null);
  const fetching = fetchPhase !== null;
  const fetchRunning = React.useRef(false);
  const fetchCancelled = React.useRef(false);
  const [fetchNotice, setFetchNotice] = React.useState<(FetchNoticeValue & { repoId: string }) | null>(null);
  const [fetchFailure, setFetchFailure] = React.useState<{ message: string; prune: boolean; remote: string | null; atUnixMs: number; repoId: string } | null>(null);
  const [branchStart, setBranchStart] = React.useState<BranchStart | null>(null);
  const [ffMergeTarget, setFfMergeTarget] = React.useState<FastForwardMergeTarget | null>(null);
  const activityStatsSupported = ready && status.core.capabilities.includes("activityStats");
  const { recent, refresh: refreshRecent } = useRecentRepositories(ready, view.session);
  const [path, setPathState] = React.useState("");
  const [actionError, setActionError] = React.useState<string>();
  const [selectedOid, setSelectedOid] = React.useState<string>();
  const narrowHistory = useNarrowHistoryLayout();
  const [detailOpen, setDetailOpen] = React.useState(false);
  const closeDetail = React.useCallback(() => setDetailOpen(false), []);
  const [historyLocation, setHistoryLocation] = React.useState<{ oid: string; sessionKey: string; loading: boolean; cancelled: boolean; error: string | null } | null>(null);
  /** Where the last jump to another page left from; the top bar offers the way back to it until the user is on that page again. */
  const [jumpOrigin, setJumpOrigin] = React.useState<AppPlace | null>(null);
  /** A file opened from a commit, until its content shows whether the tree version still has it. */
  const openFallback = React.useRef<{ pathHex: string; oid: string } | null>(null);
  const [activityStats, setActivityStats] = React.useState<{ key: string; value: ActivityStats } | null>(null);
  const [activityError, setActivityError] = React.useState<string | null>(null);
  const [activityLoading, setActivityLoading] = React.useState(false);
  const activityBusy = React.useRef(false);
  const activityIntent = React.useRef(0);
  const activityTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityWanted = React.useRef<{ key: string; signature: string; query: SearchQuery } | null>(null);
  const activityLoadedSignature = React.useRef<string | null>(null);
  const activityScheduleRef = React.useRef<(delay?: number) => void>(() => undefined);
  const [observation, setObservation] = React.useState<RepositoryObservation | null>(null);
  const observationRef = React.useRef<RepositoryObservation | null>(null);
  const [refDiff, setRefDiff] = React.useState<RefSnapshotDiff | null>(null);
  const [refDiffLoading, setRefDiffLoading] = React.useState(false);
  const [refDiffError, setRefDiffError] = React.useState<string | null>(null);
  const refDiffIntent = React.useRef(0);
  const observationIntent = React.useRef(0);
  const [handoffOpen, setHandoffOpen] = React.useState(false);
  const [handoffRequest, setHandoffRequest] = React.useState<HandoffRequest | null>(null);
  const [page, setPage] = React.useState<AppPage>("commits");
  const pageRef = React.useRef(page);
  /** Shows or hides the files page's history column and remembers it (⌥H and the 历史 button). */
  const historyToggle = React.useRef((open: boolean) => {
    try { localStorage.setItem(FILES_HISTORY_OPEN_KEY, String(open)); } catch { /* storage unavailable: not remembered */ }
    filesStore.setHistoryOpen(open);
  });
  pageRef.current = page;
  const [workspaceFilter, setWorkspaceFilter] = React.useState("");
  const [filesVersionPinned, setFilesVersionPinned] = React.useState<TreeVersion | null>(null);
  const [filesFind, setFilesFind] = React.useState({ query: "", current: 0 });
  const [filesFindCount, setFilesFindCount] = React.useState(0);
  const [filesHistoryQuery, setFilesHistoryQuery] = React.useState("");
  const filesVisited = React.useRef(false);
  const workspaceVisited = React.useRef(false);
  const statsVisited = React.useRef(false);
  const [historyScrubbing, setHistoryScrubbing] = React.useState(false);
  const locationIntent = React.useRef(0);
  const anchorBeforeRefresh = React.useRef<{ oid: string; offset: number } | undefined>(undefined);
  const pathEdited = React.useRef(false);
  const setViewportAnchor = React.useCallback((oid: string | undefined) => store.setViewportAnchor(oid), [store]);
  const loadNavigation = React.useCallback(() => store.loadNavigation(), [store]);
  const loadMergeStatus = React.useCallback((names: string[]) => store.loadRefMergeStatus(names), [store]);
  const cancelMergeStatus = React.useCallback(() => store.cancelRefMergeStatus(), [store]);
  const loadSearchIdentities = React.useCallback((field: SearchTimeField, text: string) => { void searchStore.loadIdentities(field, text); }, [searchStore]);
  const loadSearchPaths = React.useCallback((text: string) => { void searchStore.loadPaths(text); }, [searchStore]);
  const loadContainingBranches = React.useCallback(() => { void detailStore.loadContaining(); }, [detailStore]);
  const currentSessionKey = view.session ? `${view.session.repoId}:${view.session.generation}` : null;
  React.useLayoutEffect(() => { setDetailOpen(false); }, [currentSessionKey, narrowHistory]);
  const displayedQuery = historyLocation ? DEFAULT_SEARCH_QUERY : searchView.query;
  const displayedQueryRef = React.useRef(displayedQuery);
  displayedQueryRef.current = displayedQuery;
  const activityKey = `${currentSessionKey ?? "offline"}:${JSON.stringify(displayedQuery)}`;
  const indexKey = (index: typeof view.metadataIndex) => index
    ? `${index.snapshotKey ?? ""}:${index.state}:${index.coverage.processed}:${index.coverage.complete}` : "no-index";
  const activityIndexKey = `${indexKey(view.metadataIndex)}:${searchView.active && searchView.window ? indexKey(searchView.window.index) : "no-search-index"}`;
  const loadActivity = React.useCallback(async () => {
    const wanted = activityWanted.current;
    const session = store.getView().session;
    if (!activityStatsSupported || !session || !wanted || document.visibilityState !== "visible" || !ready) return;
    if (activityBusy.current || activityLoadedSignature.current === wanted.signature) return;
    activityBusy.current = true;
    const intent = ++activityIntent.current;
    const requestKey = wanted.key;
    const requestSignature = wanted.signature;
    setActivityLoading(true);
    setActivityError(null);
    const result = await settle(window.commitScope.getActivityStats({ query: wanted.query }));
    const currentSession = store.getView().session;
    const currentKey = currentSession
      ? `${currentSession.repoId}:${currentSession.generation}:${JSON.stringify(displayedQueryRef.current)}` : null;
    const stillCurrent = intent === activityIntent.current && activityWanted.current?.key === requestKey
      && currentKey === requestKey && document.visibilityState === "visible";
    const temporaryWait = !result.ok && (result.error.code === "BUSY" || result.error.code === "CANCELLED");
    if (stillCurrent) {
      if (result.ok) {
        setActivityStats({ key: requestKey, value: result.value });
        activityLoadedSignature.current = requestSignature;
        setActivityLoading(false);
      } else if (temporaryWait) {
        setActivityLoading(true);
      } else {
        setActivityError(result.error.message);
        setActivityLoading(false);
      }
    }
    activityBusy.current = false;
    if (stillCurrent && temporaryWait) {
      activityScheduleRef.current(2_000);
    } else if (document.visibilityState === "visible" && (intent !== activityIntent.current || activityWanted.current?.signature !== requestSignature)) {
      activityScheduleRef.current(500);
    }
  }, [activityStatsSupported, ready, store]);
  const scheduleActivity = React.useCallback((delay = 0) => {
    if (activityTimer.current && delay > 0) return;
    if (activityTimer.current) clearTimeout(activityTimer.current);
    activityTimer.current = null;
    if (!activityStatsSupported || !store.getView().session || !activityWanted.current || !ready || document.visibilityState !== "visible") return;
    activityTimer.current = setTimeout(() => {
      activityTimer.current = null;
      void loadActivity();
    }, delay);
  }, [activityStatsSupported, loadActivity, ready, store]);
  activityScheduleRef.current = scheduleActivity;
  React.useEffect(() => {
    const session = store.getView().session;
    const key = session ? `${session.repoId}:${session.generation}:${JSON.stringify(displayedQuery)}` : activityKey;
    const signature = `${key}:${activityIndexKey}`;
    const previous = activityWanted.current;
    activityWanted.current = session ? { key, signature, query: displayedQuery } : null;
    if (!session) return;
    if (previous && previous.key !== key) {
      activityIntent.current += 1;
      activityLoadedSignature.current = null;
      setActivityError(null);
      if (activityBusy.current) {
        setActivityLoading(true);
        void window.commitScope.cancelActivityStats();
      }
      scheduleActivity(0);
    } else if (!previous || previous.signature !== signature || (ready && !activityBusy.current && activityLoadedSignature.current !== signature && !activityError)) {
      if (previous && activityBusy.current) return;
      setActivityError(null);
      scheduleActivity(previous ? 500 : 0);
    }
  }, [activityError, activityIndexKey, activityKey, currentSessionKey, displayedQuery, ready, scheduleActivity, store]);
  React.useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        activityIntent.current += 1;
        if (activityTimer.current) clearTimeout(activityTimer.current);
        activityTimer.current = null;
        void window.commitScope.cancelActivityStats();
        setActivityLoading(false);
      } else scheduleActivity(0);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [scheduleActivity]);
  React.useEffect(() => {
    activityIntent.current += 1;
    activityLoadedSignature.current = null;
    setActivityStats(null);
    setActivityError(null);
    setActivityLoading(false);
    void window.commitScope.cancelActivityStats();
    observationRef.current = null;
    setObservation(null);
    setRefDiff(null);
    setRefDiffError(null);
    setRefDiffLoading(false);
    refDiffIntent.current += 1;
    observationIntent.current += 1;
    void window.commitScope.cancelRefSnapshotDiff();
    void window.commitScope.cancelRepositoryObservation();
  }, [currentSessionKey]);
  React.useEffect(() => () => {
    if (activityTimer.current) clearTimeout(activityTimer.current);
    activityWanted.current = null;
    activityIntent.current += 1;
    void window.commitScope.cancelActivityStats();
  }, []);
  React.useEffect(() => window.commitScope.onRepositoryObservationChanged(event => {
    const session = store.getView().session;
    if (!session || event.repoId !== session.repoId || event.browsingGeneration !== session.generation) return;
    if (observationRef.current?.generation !== event.observation.generation) {
      refDiffIntent.current += 1;
      setRefDiff(null);
      setRefDiffError(null);
      setRefDiffLoading(false);
    }
    observationRef.current = event.observation;
    setObservation(event.observation);
  }), [store]);
  const loadRefDiff = React.useCallback(async () => {
    if (!view.session || !observation) return;
    const intent = ++refDiffIntent.current;
    setRefDiffLoading(true);
    setRefDiffError(null);
    const result = await settle(window.commitScope.diffRefSnapshots());
    if (intent !== refDiffIntent.current) return;
    if (result.ok && observationRef.current?.generation === result.value.toGeneration) setRefDiff(result.value);
    else if (result.ok) setRefDiffError("引用观察已更新，请重新比较。");
    else setRefDiffError(result.error.message);
    setRefDiffLoading(false);
  }, [view.session, observation]);
  const cancelRefDiff = React.useCallback(() => {
    refDiffIntent.current += 1;
    observationIntent.current += 1;
    setRefDiffLoading(false);
    void window.commitScope.cancelRefSnapshotDiff();
    void window.commitScope.cancelRepositoryObservation();
  }, []);
  const observeNow = React.useCallback(async () => {
    if (!view.session) return;
    const intent = ++observationIntent.current;
    setRefDiffError(null);
    setRefDiffLoading(true);
    const result = await settle(window.commitScope.observeRepository());
    if (intent !== observationIntent.current) return;
    if (!result.ok) setRefDiffError(result.error.message);
    else if (observationRef.current?.generation !== result.value.generation) {
      refDiffIntent.current += 1;
      void window.commitScope.cancelRefSnapshotDiff();
      observationRef.current = result.value;
      setObservation(result.value);
      setRefDiff(null);
      setRefDiffLoading(false);
    }
    setRefDiffLoading(false);
  }, [view.session]);
  const openHandoff = React.useCallback((request: HandoffRequest) => {
    setHandoffRequest(request);
    setHandoffOpen(true);
  }, []);
  const loadHandoffFacts = React.useCallback(async (request: HandoffRequest, _intent: number): Promise<HandoffFacts | null> => {
    if (!view.session) return null;
    const target = handoffFactsTarget(request.target);
    const params: GetHandoffFactsParams = {
      branchRef: target?.kind === "branch" ? target.ref : null,
      selectedOid: target?.kind === "commit" ? target.oid : null,
      operationWorktreeId: target?.kind === "worktree" && !target.stale ? target.id : null,
      staleWorktreeId: target?.kind === "worktree" && target.stale ? target.id : null,
    };
    const result = await settle(window.commitScope.getHandoffFacts(params));
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, [view.session]);
  const returnToSearch = React.useCallback(async (queryOverride?: SearchQuery): Promise<boolean> => {
    const location = historyLocation;
    const point = searchStore.getLocationReturn();
    if (!location || !point) return false;
    const intent = ++locationIntent.current;
    if (store.getView().pageLoading) await store.cancelPage();
    if (intent !== locationIntent.current) return false;
    const session = store.getView().session;
    const sessionKey = session ? `${session.repoId}:${session.generation}` : null;
    if (sessionKey !== location.sessionKey) {
      searchStore.clearLocationReturn();
      setHistoryLocation(null);
      return false;
    }
    store.suspendHistoryWindow(undefined, null);
    setHistoryLocation(null);
    setSelectedOid(point.selectedOid);
    return searchStore.resumeAfterHistoryLocation(sessionKey, queryOverride);
  }, [historyLocation, searchStore, store]);
  const cancelHistoryLocation = React.useCallback(async () => {
    const location = historyLocation;
    if (!location?.loading) return;
    const intent = ++locationIntent.current;
    await store.cancelPage();
    if (intent === locationIntent.current) setHistoryLocation(current => current?.sessionKey === location.sessionKey
      ? { ...current, loading: false, cancelled: true, error: null } : current);
  }, [historyLocation, store]);
  const abandonHistoryLocation = React.useCallback(async () => {
    if (!historyLocation) return;
    const intent = ++locationIntent.current;
    await store.cancelPage();
    if (intent !== locationIntent.current) return;
    searchStore.clearLocationReturn();
    searchStore.clearHistoryReturn();
    setHistoryLocation(null);
  }, [historyLocation, searchStore, store]);
  const locateSelectedInHistory = React.useCallback(async (oid: string) => {
    const sessionKey = currentSessionKey;
    if (!sessionKey || !searchStore.getView().active) return;
    const intent = ++locationIntent.current;
    setHistoryLocation({ oid, sessionKey, loading: true, cancelled: false, error: null });
    const point = await searchStore.suspendForHistoryLocation(sessionKey);
    const session = store.getView().session;
    const nowKey = session ? `${session.repoId}:${session.generation}` : null;
    if (intent !== locationIntent.current || !point || nowKey !== sessionKey || searchStore.getLocationReturn()?.sessionKey !== sessionKey) {
      if (intent === locationIntent.current) setHistoryLocation(null);
      return;
    }
    setSelectedOid(undefined);
    const found = await store.locateCommit(oid);
    if (intent !== locationIntent.current) return;
    if (found) setSelectedOid(store.getView().commits.find(commit => commit.oid.startsWith(oid.toLowerCase()))?.oid);
    const pageError = store.getView().pageError;
    setHistoryLocation(current => current?.sessionKey === sessionKey ? {
      ...current, loading: false, error: found ? null : pageError?.code === "SCOPE_UNAVAILABLE"
        ? "提交不在当前快照范围内。" : pageError?.message ?? "历史定位未完成。",
    } : current);
    return found;
  }, [currentSessionKey, searchStore, store]);
  const restoreHistoryAfterSearch = React.useCallback(async () => {
    const point = searchStore.getHistoryReturn();
    await searchStore.leave();
    if (!point || searchStore.getView().active) return;
    setSelectedOid(point.selectedOid);
    anchorBeforeRefresh.current = point.anchor ?? undefined;
    const restored = await store.restoreHistoryWindow(point);
    if (restored && !searchStore.getView().active) searchStore.clearHistoryReturn();
  }, [searchStore, store]);
  const updateSearchQuery = React.useCallback((query: SearchQuery, composing = false) => {
    if (historyLocation) {
      if (!hasSearchCriteria(query)) {
        searchStore.updateQuery(query, composing);
        return;
      }
      void returnToSearch(query);
      return;
    }
    const before = searchStore.getView();
    const nextActive = hasSearchCriteria(query);
    if (!before.active && nextActive && view.session) {
      const saved = searchStore.getHistoryReturn();
      if (saved) {
        if (store.getView().pageLoading) void store.cancelPage();
        else if (store.getView().commits.length) store.suspendHistoryWindow(selectedOid, saved.anchor);
      } else {
        const container = document.querySelector<HTMLElement>('[aria-label="提交列表"] [role="listbox"]');
        const containerTop = container?.getBoundingClientRect().top ?? 0;
        const row = container ? [...container.querySelectorAll<HTMLElement>('[data-testid="commit-row"]')]
          .find(item => item.getBoundingClientRect().bottom > containerTop) : undefined;
        const anchor = row ? { oid: row.dataset.oid ?? "", offset: row.getBoundingClientRect().top - containerTop } : null;
        const point = store.suspendHistoryWindow(selectedOid, anchor);
        searchStore.setHistoryReturn(point);
      }
    }
    const transition = searchStore.updateQuery(query, composing);
    if (transition.wasActive && !transition.active) void restoreHistoryAfterSearch();
  }, [historyLocation, returnToSearch, searchStore, view.session, store, selectedOid, restoreHistoryAfterSearch]);
  const addActivityAuthor = React.useCallback((identity: SearchIdentity) => {
    const query = searchStore.getView().query;
    const exists = query.authors.some(item => item.name === identity.name && item.email === identity.email);
    updateSearchQuery({ ...query, authors: exists ? query.authors.filter(item => item.name !== identity.name || item.email !== identity.email)
      : [...query.authors, { name: identity.name, email: identity.email }] });
  }, [searchStore, updateSearchQuery]);
  const finishSearchComposition = React.useCallback((composing: boolean) => {
    if (composing) searchStore.beginComposition();
    else searchStore.finishComposition();
  }, [searchStore]);
  const selectCommit = React.useCallback((oid: string) => {
    selectionIntent.invalidate();
    if (store.getView().pageRequestKind === "dateLocation") void store.cancelPage();
    setSelectedOid(oid);
  }, [selectionIntent, store]);
  const selectDisplayedCommit = React.useCallback((oid: string) => {
    if (searchStore.getView().active) searchStore.setSelectedOid(oid);
    else selectCommit(oid);
  }, [searchStore, selectCommit]);
  const activateDisplayedCommit = React.useCallback((oid: string) => {
    selectDisplayedCommit(oid);
    setDetailOpen(true);
  }, [selectDisplayedCommit]);
  const captureSelectionIntent = React.useCallback(() => selectionIntent.capture(store.getView().session), [selectionIntent, store]);
  const selectIfCurrent = React.useCallback((oid: string, token: SelectionIntentToken | null) => {
    applySelectionIfCurrent(selectionIntent, token, store.getView().session, oid, setSelectedOid);
  }, [selectionIntent, store]);

  const locateDateTimestamp = React.useCallback(async (beforeTimestamp: number): Promise<boolean> => {
    selectionIntent.invalidate();
    const intent = selectionIntent.capture(store.getView().session);
    anchorBeforeRefresh.current = undefined;
    const oid = await store.locateHistoryDate(beforeTimestamp);
    if (!oid || searchStore.getView().active) return false;
    return applySelectionIfCurrent(selectionIntent, intent, store.getView().session, oid, setSelectedOid);
  }, [selectionIntent, store, searchStore]);
  /** Brings back the newest page when the window has moved past it; the selection then falls on the newest commit. */
  const jumpToNewest = React.useCallback(async (): Promise<boolean> => {
    if (store.getView().windowPreviousCursor === null) return true;
    selectionIntent.invalidate();
    anchorBeforeRefresh.current = undefined;
    return store.restoreHistoryWindow({ cursor: null, selectedOid: undefined, selectedCommit: null, anchor: null });
  }, [selectionIntent, store]);
  const locateHistoryDate = React.useCallback(async (day: string): Promise<boolean> => {
    const beforeTimestamp = inputDateRange(day, day)?.toTimestamp;
    return beforeTimestamp === null || beforeTimestamp === undefined ? false : locateDateTimestamp(beforeTimestamp);
  }, [locateDateTimestamp]);
  const cancelHistoryDate = React.useCallback(async () => {
    selectionIntent.invalidate();
    await store.cancelPage();
  }, [selectionIntent, store]);
  const retryHistoryDate = React.useCallback(async () => {
    const beforeTimestamp = store.getView().retryDateTimestamp;
    if (beforeTimestamp !== null) await locateDateTimestamp(beforeTimestamp);
  }, [locateDateTimestamp, store]);
  const historyActivity = activityStats?.key === activityKey && activityStats.value.timeField === "committer"
    && !hasSearchCriteria(displayedQuery) ? activityStats.value : null;

  useViewRecording(store, view);
  // P4-09: the working tree of this window's directory, read whenever it may have changed.
  const workspaceSupported = ready && status.core.capabilities.includes("workspaceStatus");
  const workspaceRepo = view.session?.repoId ?? null;
  React.useEffect(() => {
    workspaceStore.bind(workspaceRepo, workspaceSupported, Boolean(view.repository?.isBare));
  }, [workspaceStore, workspaceRepo, workspaceSupported, view.repository?.isBare]);
  // The working tree does not depend on the browsing scope: read it when a repository opens, not on every scope switch.
  React.useEffect(() => { void workspaceStore.readStatus(); }, [workspaceStore, view.session?.repoId]);
  React.useEffect(() => window.commitScope.onWorkspaceChanged(change => {
    if (change.repoId === store.getView().session?.repoId) workspaceStore.markChanged();
  }), [store, workspaceStore]);
  React.useEffect(() => {
    const onFocus = () => { if (document.visibilityState === "visible") void workspaceStore.readStatus(); };
    const onVisibility = () => { if (document.visibilityState === "visible" && workspaceStore.getView().stale) void workspaceStore.readStatus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [workspaceStore]);
  React.useEffect(() => { if (page === "workspace") void workspaceStore.readStatus(); }, [page, workspaceStore]);
  React.useEffect(() => () => workspaceStore.dispose(), [workspaceStore]);
  // P4-10 to P4-12: the files page reads a tree version; until visited it reads nothing.
  const coreCapabilities = ready ? status.core.capabilities : [];
  const filesCapabilities = { files: coreCapabilities.includes("fileBrowsing"), blame: coreCapabilities.includes("blame"), fullFile: coreCapabilities.includes("diffFullContext") };
  fullFileWanted.current = filesCapabilities.fullFile;
  React.useEffect(() => {
    filesStore.bind(workspaceRepo, filesCapabilities);
  }, [filesStore, workspaceRepo, filesCapabilities.files, filesCapabilities.blame, filesCapabilities.fullFile]);
  React.useEffect(() => {
    filesVisited.current = false;
    workspaceVisited.current = false;
    statsVisited.current = false;
    setFilesVersionPinned(null);
    setFilesFind({ query: "", current: 0 });
    setFilesHistoryQuery("");
  }, [workspaceRepo]);
  // Declared after the reset above so a repository switch on this page keeps the page mounted.
  React.useEffect(() => { if (page === "workspace") workspaceVisited.current = true; }, [page, workspaceRepo]);
  React.useEffect(() => { if (page === "stats") statsVisited.current = true; }, [page, workspaceRepo]);
  const scopeTreeVersion = React.useMemo(() => treeVersionForScope(view), [view.session, view.repository, view.refs, view.navigation]);
  const filesVersion = filesVersionPinned ?? scopeTreeVersion;
  React.useEffect(() => {
    if (page === "files") filesVisited.current = true;
    if (filesVisited.current) filesStore.setVersion(filesVersion);
  }, [filesStore, page, filesVersion?.commit, filesVersion?.label]);
  // The store starts each path's history unfiltered; the filter box follows.
  const filesPathHex = filesView.selection?.path.rawHex;
  React.useEffect(() => setFilesHistoryQuery(""), [filesPathHex]);
  React.useEffect(() => {
    const timer = setTimeout(() => filesStore.setHistoryMessage(filesHistoryQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [filesStore, filesHistoryQuery]);
  React.useEffect(() => {
    let scope = diffDisplay.getView().scope;
    return diffDisplay.subscribe(() => {
      const next = diffDisplay.getView().scope;
      if (next === scope) return;
      scope = next;
      if (!fullFileWanted.current) return;
      filesStore.reloadChange();
      void detailStore.reloadDiff();
      workspaceStore.retryContent();
    });
  }, [filesStore, detailStore, workspaceStore]);
  React.useEffect(() => () => filesStore.dispose(), [filesStore]);
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ⌥ + a letter toggles a display option of the files page: ⌥B blame, ⌥H the history column (⌥D / ⌥F / ⌥Z: diffs).
      if (event.code !== "KeyB" && event.code !== "KeyH" || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))) return;
      const files = filesStore.getView();
      if (pageRef.current !== "files") return;
      if (event.code === "KeyH") {
        if (!files.selection) return;
        event.preventDefault();
        historyToggle.current(!files.historyOpen);
        return;
      }
      if (files.tab !== "content" || files.selection?.kind !== "file" || !files.blameSupported) return;
      event.preventDefault();
      filesStore.setBlame(!files.blameEnabled);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [filesStore]);
  useDiffDisplayShortcuts(ready && status.core.capabilities.includes("diffFullContext"));
  useLaunchRepository(ready, store);

  // Restarting the core drops the repository session; reopen what was on screen once it is back.
  const reopenAfterRestart = React.useRef<string | null>(null);
  const restartCore = React.useCallback(() => {
    reopenAfterRestart.current = store.getView().repository?.path ?? null;
    void window.commitScope.restartCore().catch(error => setActionError(error instanceof Error ? error.message : String(error)));
  }, [store]);
  React.useEffect(() => {
    const path = reopenAfterRestart.current;
    if (!ready || !path) return;
    reopenAfterRestart.current = null;
    const shown = store.getView();
    if (!shown.session && shown.opening === null) void store.open(path);
  }, [ready, store]);
  const searchIdentityBusy = searchView.authorIdentities.loading || searchView.committerIdentities.loading || searchView.pathSuggestions.loading;
  const searchRequestBusy = searchView.loading || searchView.pageLoading || searchIdentityBusy;
  const advancingPartialSearch = searchView.active && Boolean(searchView.window && !searchView.window.coverage.complete &&
    !searchView.error && (searchView.window.index.state === "running" || searchView.window.index.state === "queued"));
  const searchPartialBusy = searchView.active && (searchRequestBusy || advancingPartialSearch);
  useMetadataIndexPolling(ready, metadataIndexSupported, store, view, searchPartialBusy);

  const sessionKey = currentSessionKey;
  const boundSearchSession = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (historyLocation && historyLocation.sessionKey !== sessionKey) {
      ++locationIntent.current;
      searchStore.clearLocationReturn();
      searchStore.clearHistoryReturn();
      setHistoryLocation(null);
    }
  }, [historyLocation?.sessionKey, sessionKey, searchStore]);
  React.useEffect(() => {
    if (searchView.active && view.state === "ready" && view.session &&
      (!searchStore.getHistoryReturn() || boundSearchSession.current !== sessionKey)) {
      const point = store.suspendHistoryWindow(selectedOid, anchorBeforeRefresh.current ?? null);
      searchStore.setHistoryReturn(point);
    }
    searchStore.bindSession(sessionKey, ready && view.state === "ready");
    boundSearchSession.current = sessionKey;
  }, [searchStore, sessionKey, ready, view.state, selectedOid, store]);

  React.useEffect(() => {
    if (!ready || !view.session || !searchView.active || view.state !== "ready" || view.refreshing || view.scopeSwitching) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const nextDelay = () => {
      const current = searchStore.getView();
      if (current.error?.code === "BUSY") return 1_500;
      if (current.error) return null;
      if (!current.window) return 1_000;
      if (current.window.coverage.complete) return null;
      return current.window.index.state === "running" || current.window.index.state === "queued" ? 1_000 : null;
    };
    const schedule = (delay: number | null) => {
      if (delay === null) return;
      if (timer) clearTimeout(timer);
      if (active && document.visibilityState === "visible") timer = setTimeout(() => { void poll(); }, delay);
    };
    const poll = async () => {
      if (!active || document.visibilityState !== "visible") return;
      const repositoryView = store.getView();
      if (repositoryView.refreshing || repositoryView.scopeSwitching || repositoryView.metadataIndexLoading || repositoryView.metadataIndexAction) {
        schedule(500);
        return;
      }
      const current = searchStore.getView();
      if (current.loading || current.pageLoading || current.authorIdentities.loading || current.committerIdentities.loading || current.pathSuggestions.loading) {
        schedule(500);
        return;
      }
      if (current.window && !current.window.coverage.complete && (!current.error || current.error.code === "BUSY")) await searchStore.refreshPartial();
      else if (!current.window && (!current.error || current.error.code === "BUSY")) await searchStore.retry();
      else return;
      if (active && searchStore.getView().active) schedule(nextDelay());
    };
    const onVisibility = () => {
      if (timer) clearTimeout(timer);
      if (document.visibilityState === "hidden") void searchStore.cancelPending();
      else schedule(100);
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") schedule(nextDelay());
    return () => { active = false; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [ready, sessionKey, searchView.active, searchView.window?.coverage.complete, searchView.error?.code,
    searchView.window?.index.state, view.state, view.refreshing, view.scopeSwitching, store, searchStore]);

  React.useEffect(() => () => searchStore.dispose(), [searchStore]);

  const navigationAttempt = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (!ready || view.state !== "ready" || !view.session) return;
    const key = `${view.session.repoId}:${view.session.generation}`;
    if (navigationAttempt.current === key) return;
    navigationAttempt.current = key;
    void store.loadNavigation();
  }, [ready, view.state, view.session, store]);

  React.useEffect(() => {
    if (status.state === "error" || status.state === "stopped") store.coreUnavailable();
  }, [status.state, store]);

  // Keep the path field and the selection in step with what is shown.
  React.useEffect(() => {
    if (view.repository && !pathEdited.current) setPathState(view.repository.path);
    setSelectedOid(current => {
      if (current && (view.commits.some(commit => commit.oid === current) || view.selectionMissingOnPage)) return current;
      return view.commits[0]?.oid;
    });
  }, [view.repository, view.commits]);

  React.useEffect(() => {
    store.setSelectedOid(selectedOid);
  }, [selectedOid, store]);

  const run = async (action: () => Promise<void>) => {
    setActionError(undefined);
    try { await action(); } catch (error) { setActionError(String(error)); }
  };
  const refresh = () => run(async () => {
    await abandonHistoryLocation();
    const activeSearch = searchStore.getView();
    if (activeSearch.active) {
      const anchor = activeSearch.anchorOid ? { oid: activeSearch.anchorOid, offset: activeSearch.anchorOffset } : undefined;
      anchorBeforeRefresh.current = anchor;
      await store.refresh(activeSearch.selectedOid, anchor);
      return;
    }
    const container = document.querySelector<HTMLElement>('[aria-label="提交列表"] [role="listbox"]');
    const containerTop = container?.getBoundingClientRect().top ?? 0;
    const anchorRow = container ? [...container.querySelectorAll<HTMLElement>('[data-testid="commit-row"]')]
      .find(row => row.getBoundingClientRect().bottom > containerTop) : undefined;
    // At the very top of the newest page the reader is following the tip: keeping the old first commit in
    // place would push whatever the refresh brought (after a fetch or an update) out of sight above it.
    const followingTip = Boolean(container) && container!.scrollTop <= 4 && store.getView().windowPreviousCursor === null;
    anchorBeforeRefresh.current = anchorRow && !followingTip ? {
      oid: anchorRow.dataset.oid ?? "",
      offset: anchorRow.getBoundingClientRect().top - containerTop,
    } : undefined;
    await store.refresh(selectedOid, anchorBeforeRefresh.current);
  });
  // P5-01. A fetch only moves remote-tracking refs; the view changes when the refresh after it lands.
  const startFetch = async (prune = false, remote: string | null = null): Promise<boolean> => {
    if (fetchRunning.current) return false;
    fetchRunning.current = true;
    fetchCancelled.current = false;
    setFetchPhase(performance.now());
    setActionError(undefined);
    setFetchNotice(null);
    setFetchFailure(null);
    // A refresh gives the session a new repoId, so what a fetch reports is tied to the directory instead.
    const repoId = view.repository?.path ?? "";
    try {
      const result = await window.commitScope.fetchRepository({ remote, prune });
      if (store.getView().repository?.path !== repoId) return false;
      if (!result.ok) {
        if (result.error.code !== "CANCELLED") setFetchFailure({ message: result.error.message, prune, remote, atUnixMs: Date.now(), repoId });
        return false;
      }
      setFetchPhase("refreshing");
      setFetchNotice({ remotes: result.value.remotes, finishedAtUnixMs: result.value.finishedAtUnixMs, repoId });
      const beforeRefresh = store.getView().session;
      await refresh();
      const refreshed = store.getView();
      if (!refreshed.session || refreshed.session === beforeRefresh || refreshed.scopeError) {
        setActionError("Fetch 已完成，但刷新失败；没有继续更新本地分支，请刷新后重试。");
        return false;
      }
      return !fetchCancelled.current && refreshed.repository?.path === repoId;
    } catch (error) {
      setActionError(String(error));
      return false;
    } finally {
      fetchRunning.current = false;
      setFetchPhase(null);
    }
  };
  const { actions: operations, view: operationsView } = useOperations({
    store: operationsStore, sessionStore: store, view, supported: operationsSupported && !view.repository?.isBare,
    remotes: view.navigation?.remotes ?? [],
    pushRepository: window.commitScope.pushRepository,
    fetchAll: () => startFetch(false), fetching, refresh,
    afterChange: () => { void workspaceStore.readStatus(true); },
    dismissFetchNotice: () => setFetchNotice(null), openHandoff,
  });
  const actions: RepositoryActions = {
    operations,
    fetch: operationsSupported && view.session ? {
      running: fetching,
      startedAt: typeof fetchPhase === "number" ? fetchPhase : null,
      start: async (prune, remote) => { if (!operationsStore.getView().running) await startFetch(prune, remote); },
      cancel: () => { fetchCancelled.current = true; void window.commitScope.cancelRepositoryOperation(); },
      notice: fetchNotice && fetchNotice.repoId === view.repository?.path ? fetchNotice : null,
      dismissNotice: () => setFetchNotice(null),
    } : null,
    path,
    setPath(next) { pathEdited.current = true; setPathState(next); },
    open: (target = path) => run(async () => { await abandonHistoryLocation(); await store.open(target); }),
    choose: () => run(async () => {
      const chosen = await window.commitScope.chooseRepository();
      if (!chosen) return;
      pathEdited.current = true;
      setPathState(chosen);
      await abandonHistoryLocation();
      await store.open(chosen);
    }),
    cancel: () => run(() => store.cancel()),
    retry: () => run(() => store.retry()),
    retryPage: () => view.pageErrorKind === "refresh" ? refresh() : view.pageErrorKind === "dateLocation"
      ? run(retryHistoryDate) : run(() => store.retryPage(selectedOid)),
    cancelPage: () => run(() => store.getView().pageRequestKind === "dateLocation" ? cancelHistoryDate() : store.cancelPage()),
    previousPage: () => store.previousPage(),
    nextPage: () => store.nextPage(),
    refresh,
    switchScope: scope => run(async () => {
      await abandonHistoryLocation();
      const selectionToken = captureSelectionIntent();
      const container = document.querySelector<HTMLElement>('[aria-label="提交列表"] [role="listbox"]');
      const containerTop = container?.getBoundingClientRect().top ?? 0;
      const anchorRow = container ? [...container.querySelectorAll<HTMLElement>('[data-testid="commit-row"]')]
        .find(row => row.getBoundingClientRect().bottom > containerTop) : undefined;
      const anchor = searchView.active
        ? searchView.anchorOid ? { oid: searchView.anchorOid, offset: searchView.anchorOffset } : undefined
        : anchorRow ? { oid: anchorRow.dataset.oid ?? "", offset: anchorRow.getBoundingClientRect().top - containerTop } : undefined;
      anchorBeforeRefresh.current = anchor;
      const result = await store.switchScope(scope, searchView.active ? searchView.selectedOid : selectedOid, anchor);
      if (result) {
        anchorBeforeRefresh.current = result.anchor;
        if (!searchView.active && selectionIntent.isRevisionCurrent(selectionToken)) {
          selectionIntent.invalidate();
          setSelectedOid(result.selectedOid);
        }
      }
    }),
  };

  const workspaceUnavailable = !view.repository || view.repository.isBare;
  const filesAvailable = Boolean(view.repository?.headOid);
  const workspaceBranch = view.repository ? workspaceBranchLabel(view.session?.scope, view.repository, view.navigation) : null;
  const navigation = React.useMemo(() => new NavigationHistory<AppPlace>(), []);
  const navigationView = React.useSyncExternalStore(navigation.subscribe, navigation.getView);
  const placeState = React.useRef({ page, selectedOid });
  placeState.current = { page, selectedOid };
  const currentPlace = React.useCallback((): AppPlace => {
    const { page: current, selectedOid: oid } = placeState.current;
    if (current === "files") return filesPlace(filesStore.getView());
    if (current === "workspace") return { key: "workspace", label: "工作区", page: "workspace" };
    if (current === "stats") return { key: "stats", label: "统计页", page: "stats" };
    return { key: JSON.stringify(["commits", oid ?? null]), label: oid ? `提交 ${shortOid(oid)}` : "提交页", page: "commits", oid: oid ?? null };
  }, [filesStore]);
  /** Called before every jump, so back returns to where the jump left from. */
  const recordJump = React.useCallback((): AppPlace => {
    const place = currentPlace();
    navigation.record(place);
    return place;
  }, [navigation, currentPlace]);
  const pageAllowed = React.useCallback((next: AppPage) => !(next === "workspace" && workspaceUnavailable) && !(next === "files" && !filesAvailable), [filesAvailable, workspaceUnavailable]);
  const changePage = React.useCallback((next: AppPage) => {
    if (!pageAllowed(next)) return;
    if (next !== placeState.current.page) recordJump();
    setPage(next);
  }, [pageAllowed, recordJump]);
  React.useEffect(() => {
    if (page === "workspace" && workspaceUnavailable || page === "files" && !filesAvailable) setPage("commits");
  }, [page, workspaceUnavailable, filesAvailable]);
  const openFileHistory = React.useCallback((path: GitPath, oid: string) => {
    setJumpOrigin(recordJump());
    filesVisited.current = true;
    filesStore.setVersion(filesVersion);
    setPage("files");
    filesStore.select({ path, kind: "file" }, { tab: "history", commit: oid });
  }, [filesStore, filesVersion, recordJump]);
  /**
   * "在文件页打开" on the workspace page. The workspace's changes are against this window's HEAD, so the file opens at
   * HEAD whatever the browsing scope shows; the tree version is pinned only when HEAD is not already the scope's.
   */
  const workspaceHead = React.useMemo(() => {
    const repository = view.repository;
    return repository?.headOid ? { commit: repository.headOid, label: repository.headReference ? shortRefName(repository.headReference) : "HEAD" } : null;
  }, [view.repository]);
  const openFileFromWorkspace = React.useCallback((path: GitPath) => {
    if (!workspaceHead) return;
    setJumpOrigin(recordJump());
    filesVisited.current = true;
    setFilesVersionPinned(workspaceHead.commit === scopeTreeVersion?.commit && workspaceHead.label === scopeTreeVersion.label ? null : workspaceHead);
    filesStore.setVersion(workspaceHead);
    setPage("files");
    filesStore.select({ path, kind: "file" });
  }, [filesStore, recordJump, scopeTreeVersion, workspaceHead]);
  /** "在文件页打开" on a commit's changed file: the file at the tree version, or its history at this commit if the commit deleted it. */
  const openFileFromCommit = React.useCallback((file: ChangedFile, oid: string) => {
    if (!file.newPath) {
      if (file.oldPath) openFileHistory(file.oldPath, oid);
      return;
    }
    setJumpOrigin(recordJump());
    openFallback.current = { pathHex: file.newPath.rawHex, oid };
    filesVisited.current = true;
    filesStore.setVersion(filesVersion);
    setPage("files");
    filesStore.select({ path: file.newPath, kind: "file" });
  }, [filesStore, filesVersion, openFileHistory, recordJump]);
  // A file renamed or deleted after that commit is not in the tree version. Rather than moving the whole files page
  // to the old commit, show that file as it was in the commit, picked in its history; the tree version stays.
  React.useEffect(() => {
    const pending = openFallback.current;
    if (!pending) return;
    if (filesView.selection?.path.rawHex !== pending.pathHex) { openFallback.current = null; return; }
    const content = filesView.content;
    if (!content || content.state === "loading") return;
    openFallback.current = null;
    const value = content.value;
    if (!value || value.kind !== "missing" || value.path.rawHex !== pending.pathHex || value.commit === pending.oid) return;
    filesStore.select({ path: value.path, kind: "file" }, { tab: "history", commit: pending.oid });
    filesStore.setChangeView("file");
  }, [filesView.content, filesView.selection, filesStore]);
  /** Shows a commit on the commits page: located in the history, or in the search results when searching. */
  const showCommit = React.useCallback(async (oid: string) => {
    if (searchStore.getView().active) {
      if (await locateSelectedInHistory(oid)) setDetailOpen(true);
      return;
    }
    selectionIntent.invalidate();
    const found = await store.locateCommit(oid);
    if (found) {
      setSelectedOid(store.getView().commits.find(commit => commit.oid.startsWith(oid.toLowerCase()))?.oid);
      setDetailOpen(true);
    }
  }, [locateSelectedInHistory, searchStore, selectionIntent, store]);
  const openCommitFromFiles = React.useCallback(async (oid: string) => {
    setJumpOrigin(recordJump());
    setPage("commits");
    await showCommit(oid);
  }, [filesStore, recordJump, showCommit]);
  /** Back / forward put a recorded place back on screen; they do not record a step themselves. */
  const restorePlace = React.useCallback((place: AppPlace) => {
    if (place.page === "commits") {
      setPage("commits");
      if (place.oid && place.oid !== placeState.current.selectedOid) void showCommit(place.oid);
      return;
    }
    if (place.page === "workspace") {
      if (pageAllowed("workspace")) setPage("workspace");
      return;
    }
    if (place.page === "stats") {
      setPage("stats");
      return;
    }
    if (!pageAllowed("files")) return;
    filesVisited.current = true;
    if (place.version) {
      setFilesVersionPinned(place.version.commit === scopeTreeVersion?.commit && place.version.label === scopeTreeVersion.label ? null : place.version);
      filesStore.setVersion(place.version);
    }
    setPage("files");
    if (!place.selection) return;
    if (place.tab === "history" && place.selectedCommit) filesStore.select(place.selection, { tab: "history", commit: place.selectedCommit });
    else {
      filesStore.select(place.selection);
      if (place.selection.kind === "file") filesStore.closeChange();
    }
  }, [filesStore, pageAllowed, scopeTreeVersion, showCommit]);
  const navigateBack = React.useCallback(() => {
    const target = navigation.back(currentPlace());
    if (target) restorePlace(target);
  }, [currentPlace, navigation, restorePlace]);
  const navigateForward = React.useCallback(() => {
    const target = navigation.forward(currentPlace());
    if (target) restorePlace(target);
  }, [currentPlace, navigation, restorePlace]);
  // Mouse side buttons go back and forward too.
  React.useEffect(() => {
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.button === 3) navigateBack();
      else navigateForward();
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, [navigateBack, navigateForward]);
  React.useEffect(() => { setJumpOrigin(null); navigation.clear(); }, [workspaceRepo, navigation]);
  // Back on the page the jump came from, by any route, the way back is no longer needed.
  React.useEffect(() => { setJumpOrigin(current => current?.page === page ? null : current); }, [page]);
  // "← 提交 92aa8c23" in the top bar: the back button itself while one step back is that place, otherwise a separate
  // button beside it, so ← always means one step and the named button always means "back to where the jump came from".
  const backTarget = navigation.peekBack();
  const returnHint = jumpOrigin && jumpOrigin.page !== page
    ? { label: jumpOrigin.short ?? jumpOrigin.label, title: jumpOrigin.label, merged: backTarget?.key === jumpOrigin.key } : null;
  const returnToOrigin = React.useCallback(() => {
    if (!jumpOrigin) return;
    if (navigation.peekBack()?.key === jumpOrigin.key) { navigateBack(); return; }
    recordJump();
    restorePlace(jumpOrigin);
  }, [jumpOrigin, navigation, navigateBack, recordJump, restorePlace]);
  const filesActions = React.useMemo<FilesActions>(() => ({
    toggleDirectory: pathHex => filesStore.toggleDirectory(pathHex),
    revealDirectory: path => filesStore.revealDirectory(path),
    closeChange: () => {
      const files = filesStore.getView();
      if (files.selection?.kind === "file" && files.tab === "history") recordJump();
      return filesStore.closeChange();
    },
    togglePathFile: file => filesStore.togglePathFile(file),
    loadMorePathChanges: () => filesStore.loadMorePathChanges(),
    retryPathChanges: () => filesStore.retryPathChanges(),
    openOriginalHistory: () => { recordJump(); filesStore.openOriginalHistory(); },
    setChangeView: next => filesStore.setChangeView(next),
    toggleCommitInfo: () => filesStore.toggleCommitInfo(),
    retryCommitInfo: () => filesStore.retryCommitInfo(),
    // Another file is a step back / forward returns to; moving between commits of one file is browsing.
    openCommitFile: file => { recordJump(); filesStore.openCommitFile(file); },
    stepCommitFile: delta => { recordJump(); void filesStore.stepCommitFile(delta); },
    loadMoreCommitFiles: () => filesStore.loadMoreCommitFiles(),
    retryCommitFiles: () => filesStore.retryCommitFiles(),
    setHistoryOpen: open => historyToggle.current(open),
    loadMoreEntries: pathHex => filesStore.loadMoreEntries(pathHex),
    retryDirectory: pathHex => filesStore.retryDirectory(pathHex),
    select: selection => {
      const current = filesStore.getView().selection;
      if (current?.path.rawHex !== selection.path.rawHex || current.kind !== selection.kind) recordJump();
      filesStore.select(selection);
    },
    setTab: tab => filesStore.setTab(tab),
    setBlame: enabled => filesStore.setBlame(enabled),
    locateFromBlame: line => { recordJump(); filesStore.locateFromBlame(line); },
    returnToLine: () => filesStore.returnToLine(),
    selectCommit: oid => {
      // Opening a change from the file is a step; moving between commits while a change is shown is browsing.
      const files = filesStore.getView();
      if (files.selection?.kind === "file" && files.tab === "content") recordJump();
      filesStore.selectCommit(oid, files.history?.entries.find(entry => entry.commit.oid === oid)?.commit.parents.length === 0 ? null : 0);
    },
    setParentIndex: parentIndex => filesStore.setParentIndex(parentIndex),
    loadMoreHistory: () => filesStore.loadMoreHistory(),
    retryHistory: () => filesStore.retryHistory(),
    retryContent: () => filesStore.retryContent(),
    setVersion: version => setFilesVersionPinned(version.commit === scopeTreeVersion?.commit && version.label === scopeTreeVersion.label ? null : version),
    openCommit: oid => { void openCommitFromFiles(oid); },
  }), [filesStore, openCommitFromFiles, recordJump, scopeTreeVersion]);
  const versionOptions = React.useMemo(() => treeVersionOptions(view, scopeTreeVersion), [view.navigation, view.refs, scopeTreeVersion]);
  let pageSearch: React.JSX.Element | null = null;
  if (page === "commits" && sessionKey && coreCapabilities.includes("metadataSearch")) {
    pageSearch = <SearchControls view={searchView} sessionKey={sessionKey} onQueryChange={updateSearchQuery}
      onComposition={finishSearchComposition} onLoadIdentities={loadSearchIdentities} onLoadPaths={loadSearchPaths} />;
  } else if (page === "workspace" && workspaceView.supported) {
    pageSearch = <PageSearchBox scope="改动的文件" label="按路径过滤改动的文件" placeholder="按路径过滤" value={workspaceFilter}
      onChange={setWorkspaceFilter} title="按路径过滤左栏，不重新读取工作区（⌘F）" />;
  } else if (page === "files") {
    pageSearch = filesSearchBox(filesView, filesFind, filesFindCount, setFilesFind, filesHistoryQuery, setFilesHistoryQuery);
  }
  const hasPageSearch = pageSearch !== null;
  const shortcutActions = React.useRef({ hasPageSearch, historyLocation, searchView, returnToSearch, locateSelectedInHistory, refresh, page, changePage, filesActions, filesStore, navigateBack, navigateForward, recordJump });
  shortcutActions.current = { hasPageSearch, historyLocation, searchView, returnToSearch, locateSelectedInHistory, refresh, page, changePage, filesActions, filesStore, navigateBack, navigateForward, recordJump };
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || !(event.metaKey || event.ctrlKey)) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const actions = shortcutActions.current;
      const key = event.key.toLowerCase();
      if (event.code === "KeyF" && !event.altKey && actions.hasPageSearch) {
        event.preventDefault();
        const focus = () => window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT));
        if (actions.page === "commits" && actions.historyLocation) void actions.returnToSearch().then(focus);
        else focus();
      } else if (event.code === "KeyL" && !event.altKey && !event.shiftKey && actions.page === "commits" && actions.searchView.active && actions.searchView.selectedOid) {
        // ⌘L: the selected search result in the full history.
        event.preventDefault();
        void actions.locateSelectedInHistory(actions.searchView.selectedOid);
      } else if (key === "[" && !event.altKey && actions.historyLocation) {
        // Back from a located result is back to the search results.
        event.preventDefault();
        void actions.returnToSearch();
      } else if ((key === "[" || key === "]") && !event.altKey && !event.shiftKey) {
        // ⌘[ / ⌘] always go back and forward between recorded places.
        event.preventDefault();
        if (key === "[") actions.navigateBack();
        else actions.navigateForward();
      } else if (/^Digit[1234]$/u.test(event.code) && !event.altKey && !event.shiftKey) {
        // ⌘1 / ⌘2 / ⌘3 / ⌘4 switch pages; with ⌥ they pick the first or second view on the right of the page.
        event.preventDefault();
        actions.changePage(event.code === "Digit1" ? "commits" : event.code === "Digit2" ? "files" : event.code === "Digit3" ? "workspace" : "stats");
      } else if (/^Digit[12]$/u.test(event.code) && event.altKey && actions.page === "commits") {
        event.preventDefault();
        // One page of details: ⌥⌘1 scrolls to the overview at the top, ⌥⌘2 to the changed files below it.
        window.dispatchEvent(new CustomEvent(COMMIT_DETAIL_SCROLL_EVENT, { detail: event.code === "Digit1" ? "overview" : "changes" }));
      } else if (/^Digit[12]$/u.test(event.code) && event.altKey && actions.page === "files") {
        // ⌥⌘1 the file, ⌥⌘2 its change (the picked commit, or the newest in its history).
        event.preventDefault();
        const files = actions.filesStore.getView();
        if (files.selection?.kind !== "file") return;
        if (event.code === "Digit1") actions.filesActions.closeChange();
        else if (files.tab === "content") {
          actions.recordJump();
          actions.filesStore.setTab("history");
        }
      } else if (event.code === "KeyR" && event.altKey) {
        event.preventDefault();
        void actions.refresh();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const alerts = [
    readError ? `核心状态读取失败：${readError}` : undefined,
    actionError ? `操作失败：${actionError}` : undefined,
  ].filter((message): message is string => Boolean(message));
  const notice = view.notice;
  const displayedOid = searchView.active ? searchView.selectedOid : selectedOid;
  const paletteSelectedOid = page === "files"
    ? filesView.tab === "history" ? filesView.selectedCommit : filesView.version?.commit ?? null
    : page === "commits" ? displayedOid ?? null : null;
  // The commit page knows the full message once the details are read; elsewhere only the summary is at hand.
  const paletteSelectedMessage = !paletteSelectedOid ? null
    : page === "commits" && detailView.details.value?.commit.oid === paletteSelectedOid ? detailView.details.value.message
    : (searchView.active ? searchView.window?.commits : view.commits)?.find(commit => commit.oid === paletteSelectedOid)?.summary ?? null;
  const headMergeTarget = React.useMemo<FastForwardMergeTarget | null>(() => {
    const repo = view.repository;
    const nav = view.navigation;
    if (!operations || !repo || repo.isBare || !repo.headReference?.startsWith("refs/heads/") || !repo.headOid || !nav) return null;
    const localRefs = nav.refs.filter(ref => ref.kind === "localBranch");
    const defaultBaseName = nav.defaultBase?.name ?? "";
    const defaultBaseLocal = defaultBaseName.startsWith("refs/heads/")
      ? localRefs.find(ref => ref.name === defaultBaseName) ?? null
      : defaultBaseName.startsWith("refs/remotes/")
        ? localRefs.find(ref => ref.name === `refs/heads/${defaultBaseName.replace(/^refs\/remotes\/[^/]+\//u, "")}`) ?? null
        : null;
    if (!defaultBaseLocal || defaultBaseLocal.name === repo.headReference) return null;
    const targetOid = refTip(defaultBaseLocal);
    if (targetOid === repo.headOid) return null;
    return {
      sourceRef: repo.headReference,
      sourceOid: repo.headOid,
      targetRef: defaultBaseLocal.name,
      targetOid,
      targetIsHead: false,
      isBare: false,
    };
  }, [operations, view.repository, view.navigation]);
  const palettePushLabel = operations?.headPush
    ? operations.headPush.setUpstream
      ? `发布分支 ${operations.headPush.branch} 到 ${operations.headPush.remote}`
      : `推送 ${operations.headPush.branch} 到 ${operations.headPush.upstream}（↑${operations.headPush.ahead}）`
    : null;
  const paletteMergeBaseLabel = headMergeTarget
    ? `把 ${shortRefName(headMergeTarget.sourceRef)} 快进合入 ${shortRefName(headMergeTarget.targetRef)}…`
    : null;
  const executePalette = (action: PaletteAction) => {
    if (action.kind === "commit") {
      setJumpOrigin(recordJump());
      setPage("commits");
      void showCommit(action.oid);
    } else if (action.kind === "scope") {
      if (page === "workspace") changePage("commits");
      void actions.switchScope(action.scope);
    } else if (action.command === "openRepository") {
      void actions.choose();
    } else if (action.command === "copyCommit") {
      if (paletteSelectedOid) void run(() => window.commitScope.copyText(paletteSelectedOid));
    } else if (action.command === "copyMessage") {
      if (paletteSelectedMessage) void run(() => window.commitScope.copyText(paletteSelectedMessage));
    } else if (action.command === "copyBranch") {
      const branch = view.repository?.headReference;
      if (branch) void run(() => window.commitScope.copyText(shortRefName(branch)));
    } else if (action.command === "openFinder" || action.command === "openTerminal" || action.command === "openEditor") {
      const target = action.command === "openFinder" ? "finder" : action.command === "openTerminal" ? "terminal" : "editor";
      void run(async () => { await window.commitScope.openWorkspaceIn(target); });
    } else if (action.command === "fetch" || action.command === "fetchPrune") {
      void actions.fetch?.start(action.command === "fetchPrune");
    } else if (action.command === "push") {
      if (operations?.headPush) {
        void operations.pushBranch(operations.headPush.refName, {
          remote: operations.headPush.remote,
          setUpstream: operations.headPush.setUpstream,
        });
      }
    } else if (action.command === "mergeIntoBase") {
      if (headMergeTarget) setFfMergeTarget(headMergeTarget);
    } else changePage(action.command);
  };
  const displayedCommit = searchView.active
    ? searchView.window?.commits.find(commit => commit.oid === displayedOid) ?? searchView.oldSelectedCommit
    : null;
  const detailSessionKey = view.session ? `${view.session.repoId}:${view.session.generation}:${JSON.stringify(view.session.scope)}` : null;
  const detailSelectionIsLoaded = searchView.active
    ? Boolean(displayedOid && searchView.window?.commits.some(commit => commit.oid === displayedOid))
    : Boolean(displayedOid && view.commits.some(commit => commit.oid === displayedOid));
  // While the time slider is dragged the selection changes several times a second; details load once it settles.
  React.useEffect(() => {
    if (!historyScrubbing) detailStore.bind(detailSessionKey, displayedOid, detailSelectionIsLoaded);
  }, [detailStore, detailSessionKey, displayedOid, detailSelectionIsLoaded, historyScrubbing]);
  React.useEffect(() => {
    const refreshDetailHint = () => { void detailStore.refreshUpdate(); };
    window.addEventListener("focus", refreshDetailHint);
    return () => window.removeEventListener("focus", refreshDetailHint);
  }, [detailStore]);
  React.useEffect(() => () => { void detailStore.cancel(); }, [detailStore]);
  const locationReturn = searchStore.getLocationReturn();
  const pausedFilterLabels = locationReturn ? [
    locationReturn.query.message ? "消息" : null,
    locationReturn.query.authors.length ? "Author" : null,
    locationReturn.query.committers.length ? "Committer" : null,
    locationReturn.query.fromTimestamp !== null || locationReturn.query.toTimestamp !== null ? "日期" : null,
    locationReturn.query.oidPrefix ? "OID" : null,
    locationReturn.query.path ? "路径" : null,
  ].filter((label): label is string => Boolean(label)) : [];
  const statusView = searchView.active && searchPartialBusy && searchView.window
    ? { ...view, metadataIndex: searchView.window.index, metadataIndexLoading: false } : view;
  const moveSearchSelection = async (delta: -1 | 1) => {
    const current = searchStore.getView();
    const commits = current.window?.commits ?? [];
    const index = commits.findIndex(commit => commit.oid === current.selectedOid);
    const next = index + delta;
    if (next >= 0 && next < commits.length) { searchStore.setSelectedOid(commits[next]!.oid); return; }
    if (delta < 0 && current.window?.previousCursor) await searchStore.loadPrevious();
    else if (delta > 0 && current.window?.nextCursor) await searchStore.loadNext();
    const updated = searchStore.getView().window?.commits ?? [];
    const currentIndex = updated.findIndex(commit => commit.oid === current.selectedOid);
    const target = updated[currentIndex + delta];
    if (target) searchStore.setSelectedOid(target.oid);
  };
  const setSearchAnchor = React.useCallback((anchor: { oid: string; offset: number } | null) => searchStore.setHistoryAnchor(anchor), [searchStore]);
  const loadSearchNext = React.useCallback(() => { void searchStore.loadNext(); }, [searchStore]);
  const loadSearchPrevious = React.useCallback(() => { void searchStore.loadPrevious(); }, [searchStore]);
  const retrySearch = React.useCallback(() => { void searchStore.retry(); }, [searchStore]);

  const [dropActive, setDropActive] = React.useState(false);
  const readyRef = React.useRef(ready);
  readyRef.current = ready;
  const actionsRef = React.useRef<RepositoryActions | null>(null);
  actionsRef.current = actions;
  const pendingExternalOpenRef = React.useRef<string | null>(null);
  React.useEffect(() => window.commitScope.onOpenRepositoryRequested(requestedPath => {
    if (!readyRef.current) {
      pendingExternalOpenRef.current = requestedPath;
      return;
    }
    pathEdited.current = true;
    setPathState(requestedPath);
    void actionsRef.current?.open(requestedPath);
  }), []);
  React.useEffect(() => {
    if (!ready || !pendingExternalOpenRef.current) return;
    const requestedPath = pendingExternalOpenRef.current;
    pendingExternalOpenRef.current = null;
    pathEdited.current = true;
    setPathState(requestedPath);
    void actionsRef.current?.open(requestedPath);
  }, [ready]);
  const hasDroppedFiles = (event: React.DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const handleDragEnter = (event: React.DragEvent) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    setDropActive(true);
  };
  const handleDragOver = (event: React.DragEvent) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dropActive) setDropActive(true);
  };
  const handleDragLeave = (event: React.DragEvent) => {
    if (!dropActive) return;
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDropActive(false);
  };
  const handleDrop = (event: React.DragEvent) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    setDropActive(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    const droppedPath = window.commitScope.getPathForFile(file);
    if (!droppedPath) return;
    if (!readyRef.current) {
      pendingExternalOpenRef.current = droppedPath;
      return;
    }
    pathEdited.current = true;
    setPathState(droppedPath);
    void actionsRef.current?.open(droppedPath);
  };

  return <DiffFullContext.Provider value={filesCapabilities.fullFile}><div
    className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
    {dropActive ? <div data-testid="drop-overlay" aria-live="polite"
      className="pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-panel/85 backdrop-blur-[2px]">
      <div className="rounded-xl border border-line bg-panel px-5 py-3 text-sm font-medium text-fg shadow-lg">松开以打开仓库目录</div>
    </div> : null}
    {view.repository
      ? <TopBar preview={view} actions={actions} recent={recent} onRefreshRecent={refreshRecent} onSelectCommit={activateDisplayedCommit}
        history={{ view: navigationView, hint: returnHint, onBack: navigateBack, onForward: navigateForward, onReturn: returnToOrigin }}
        onLoadNavigation={loadNavigation} onLoadMergeStatus={loadMergeStatus} onCancelMergeStatus={cancelMergeStatus} onRefresh={refresh}
        activityQuery={displayedQuery} onSearchQueryChange={updateSearchQuery}
        observation={observation} refDiff={refDiff} refDiffLoading={refDiffLoading} refDiffError={refDiffError} onLoadRefDiff={loadRefDiff} onCancelRefDiff={cancelRefDiff} onObserve={observeNow}
        activityStats={activityStats?.key === activityKey ? activityStats.value : null} activityLoading={activityLoading} activityError={activityError}
        onLoadActivity={() => { activityLoadedSignature.current = null; setActivityError(null); scheduleActivity(0); }}
        onActivityAuthor={addActivityAuthor} onOpenHandoff={openHandoff} onCreateBranch={setBranchStart} onFastForwardMerge={operations ? setFfMergeTarget : undefined}
        page={page} onPageChange={changePage} workspace={workspaceBadge(workspaceIndicatorFor(workspaceView), view.repository, workspaceBranch)}
        workspaceBranch={workspaceBranch} filesAvailable={filesAvailable} pageSearch={pageSearch} />
      : <div className="window-toolbar window-toolbar-empty" aria-hidden="true" />}
    {status.state === "error" || alerts.length || notice || view.scopeError ? <div role="alert" className="flex flex-col gap-1 border-b border-bad-line bg-bad-bg px-4 py-2 text-[13px] text-bad">
      {status.state === "error" ? <div className="flex items-center gap-2">
        <p className="m-0 min-w-0 flex-1 break-words">核心不可用：{status.message}</p>
        <Button type="button" variant="outline" size="sm" className="shrink-0" data-testid="core-restart" onClick={restartCore}>重试</Button>
      </div> : null}
      {alerts.map(message => <p key={message} className="m-0">{message}</p>)}
      {view.scopeError ? <p className="m-0" data-testid="scope-error">
        {view.scopeErrorAction === "refresh" ? "刷新/读取范围失败" : `切换到${describeScope(view.scopeErrorTarget, view.navigation)}失败`}：{errorTitle(view.scopeError.code)}：{view.scopeError.message}。仍在查看{describeScope(view.session?.scope ?? null, view.navigation)}。
      </p> : null}
      {notice ? <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="m-0 break-words">
            没能打开 <code className="font-mono text-xs">{notice.path}</code>：{errorTitle(notice.code)}（<code className="font-mono text-xs">{notice.code}</code>）。仍在查看原来的仓库。
          </p>
          <p className="m-0 break-words text-fg2">{notice.message}</p>
        </div>
        <button type="button" aria-label="关闭提示" className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg3 hover:bg-bad/10"
          onClick={() => store.dismissNotice()}><X className="size-3.5" strokeWidth={1.75} /></button>
      </div> : null}
    </div> : null}
    {fetchFailure && view.repository && fetchFailure.repoId === view.repository?.path ? <FetchFailureBanner message={fetchFailure.message} retrying={fetching || Boolean(operationsView.running)} canOpenTerminal={!view.repository.isBare}
      onRetry={() => { void startFetch(fetchFailure.prune, fetchFailure.remote); }} onClose={() => setFetchFailure(null)}
      onHandoff={() => { if (view.repository) openHandoff(fetchFailedRequest(view.repository, fetchFailure.message, fetchFailure.atUnixMs)); }} /> : null}
    {operationsView.failure && view.repository && operationsView.sessionKey?.startsWith(`${view.session?.repoId}:`) ? <OperationFailureBanner failure={operationsView.failure} canOpenTerminal={!view.repository.isBare}
      onRetry={operationsView.failure.meta.step === "push" && operations ? () => {
        const meta = operationsView.failure!.meta;
        void operations.pushBranch(meta.refName, { remote: meta.remote ?? null, setUpstream: meta.upstream === null });
      } : undefined}
      onHandoff={() => { const request = operations?.failureHandoff(); if (request) openHandoff(request); }} onClose={() => operationsStore.dismissFailure()} /> : null}
    {operationsView.notice ? <OperationNoticeBanner message={operationsView.notice} onClose={() => operationsStore.dismissNotice()} /> : null}
    {view.repository
      ? <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Pages stay mounted while hidden so each keeps its own selection, filters and scroll position. */}
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", page !== "commits" && "invisible absolute inset-0")}
        inert={page !== "commits"} data-testid="commits-page">
        {historyLocation ? <div role="status" data-testid="history-location-banner" className="flex flex-wrap items-center gap-2 border-b border-line bg-bg px-4 py-2 text-xs text-fg2">
          <span className="min-w-0 flex-1" aria-live="polite">
            {historyLocation.loading ? "正在当前历史快照中定位…" : historyLocation.error ? `定位失败：${historyLocation.error}` : historyLocation.cancelled
              ? "定位已取消；仍保留当前范围和快照。" : "已在当前历史快照中定位。"}
            <span className="ml-1 text-fg3">{pausedFilterLabels.length
              ? `暂时移除了${pausedFilterLabels.join("、")}筛选；范围和快照保持不变。`
              : "暂时离开搜索；范围和快照保持不变。"}</span>
          </span>
          {historyLocation.loading ? <Button variant="outline" size="sm" data-testid="cancel-history-location" onClick={() => { void cancelHistoryLocation(); }}>取消定位</Button> : null}
          <Button variant="outline" size="sm" data-testid="return-to-search" onClick={() => { void returnToSearch(); }}>
            {locationReturn?.partial ? `返回已发现 ${locationReturn.matchedCount} 个结果` : `返回 ${locationReturn?.matchedCount ?? 0} 个结果`}
          </Button>
        </div> : null}
        <HistorySplitView narrow={narrowHistory} detailOpen={detailOpen} active={page === "commits"} onCloseDetail={closeDetail} sidebar={searchView.active
            ? <SearchResultList view={searchView} onSelect={activateDisplayedCommit} onAnchor={setSearchAnchor}
              onNext={loadSearchNext} onPrevious={loadSearchPrevious} onRetry={retrySearch} />
            : <CommitList preview={view} selectedOid={selectedOid} onSelect={selectCommit} onActivate={activateDisplayedCommit}
            captureSelectionIntent={captureSelectionIntent} selectIfCurrent={selectIfCurrent} onCancel={actions.cancel}
            onRetry={actions.retry} onRetryPage={actions.retryPage} onCancelPage={actions.cancelPage}
            onLoadWindowEdge={direction => store.loadWindowEdge(direction)}
            onViewportAnchor={setViewportAnchor}
            activityDays={historyActivity?.days ?? null}
            activityDaysPartial={historyActivity ? !historyActivity.coverage.complete : false}
            activityDaysTruncated={historyActivity?.daysTruncated ?? false}
            onLocateHistoryDate={locateHistoryDate} onLocateHistoryTime={locateDateTimestamp} onScrubbingChange={setHistoryScrubbing} onJumpToNewest={jumpToNewest} onOpenHandoff={openHandoff} onCancelHistoryDate={cancelHistoryDate} onRetryHistoryDate={retryHistoryDate}
            onPrefetchPreviousPage={() => { const cursor = store.getView().windowPreviousCursor; if (cursor) void store.readPage(cursor); }}
            onPrefetchNextPage={() => { const cursor = store.getView().windowNextCursor; if (cursor) void store.readPage(cursor); }}
            restorationAnchor={anchorBeforeRefresh.current}
            onSetAnchorRestorationSpace={pixels => store.setAnchorRestorationSpace(pixels)} />}>
          <CommitDetail preview={view} detail={detailView} onClose={narrowHistory ? closeDetail : undefined} onRetryDetails={() => detailStore.retryDetails()}
            onRetryFiles={() => detailStore.retryFiles()} onLoadFiles={(parentIndex, offset) => detailStore.loadFiles(parentIndex, offset)}
            onRetryMerge={() => detailStore.retryMerge()} onLoadMerge={(parentIndex, offset) => detailStore.loadMerge(parentIndex, offset)}
            onToggleDiff={(file, parentIndex) => { void detailStore.toggleDiff(file, parentIndex); }}
            onLoadContaining={loadContainingBranches} onRetryContaining={() => detailStore.retryContaining()}
            onLocateInHistory={searchView.active && displayedOid ? () => { void locateSelectedInHistory(displayedOid); } : undefined}
            selectedOid={displayedOid} onSelect={activateDisplayedCommit}
            onOpenHandoff={openHandoff} onCreateBranch={operations ? setBranchStart : undefined}
            onOpenRemote={operations && webRemote(view.navigation?.remotes) ? oid => { void operations.openRemote({ commit: oid }); } : undefined}
            onOpenFile={filesView.supported ? openFileFromCommit : undefined}
            commitsOverride={searchView.active ? searchView.window?.commits : undefined}
            selectedCommitOverride={searchView.active ? displayedCommit : undefined}
            timeField={searchView.active ? searchView.query.timeField : undefined}
            canMovePrevious={searchView.active ? Boolean(searchView.window?.previousCursor) || (searchView.window?.commits.findIndex(item => item.oid === displayedOid) ?? -1) > 0 : undefined}
            canMoveNext={searchView.active ? Boolean(searchView.window?.nextCursor) || (searchView.window?.commits.findIndex(item => item.oid === displayedOid) ?? -1) < (searchView.window?.commits.length ?? 0) - 1 : undefined}
            onMoveSelection={async delta => {
              if (searchView.active) { await moveSearchSelection(delta); return; }
              const current = store.getView();
              const index = current.commits.findIndex(commit => commit.oid === selectedOid);
              const next = index + delta;
              if (index >= 0 && next >= 0 && next < current.commits.length) {
                selectCommit(current.commits[next]!.oid);
                return;
              }
              if (index === 0 && delta < 0 || index === current.commits.length - 1 && delta > 0) {
                const intent = captureSelectionIntent();
                const oid = await store.loadWindowEdge(delta < 0 ? "before" : "after");
                if (oid) selectIfCurrent(oid, intent);
              }
            }} />
        </HistorySplitView>
      </div>
      {/* The files and workspace pages mount on first visit and then stay, hidden, like the commits page. */}
      {filesAvailable && (page === "files" || filesVisited.current) ? <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", page !== "files" && "invisible absolute inset-0")}
        inert={page !== "files"} data-testid="files-page-slot">
        <FilesPage view={filesView} actions={filesActions} versionOptions={versionOptions} find={filesFind} onFindCount={setFilesFindCount}
          historyQuery={filesHistoryQuery} onHistoryQuery={setFilesHistoryQuery} />
      </div> : null}
      {!workspaceUnavailable && (page === "workspace" || workspaceVisited.current) ? <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", page !== "workspace" && "invisible absolute inset-0")}
        inert={page !== "workspace"} data-testid="workspace-page-slot">
        <WorkspacePage repository={view.repository} view={workspaceView} filter={workspaceFilter}
          onSelect={item => workspaceStore.select({ group: item.group, pathHex: item.entry.path.rawHex })}
          onRefresh={() => { void workspaceStore.readStatus(true); }} onLoadMore={() => workspaceStore.loadMorePreview()}
          onRetryContent={() => workspaceStore.retryContent()} onOpenFile={filesView.supported && workspaceHead ? openFileFromWorkspace : undefined}
          operations={operations} onOpenHandoff={openHandoff} />
      </div> : null}
      {page === "stats" || statsVisited.current ? <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", page !== "stats" && "invisible absolute inset-0")}
        inert={page !== "stats"} data-testid="stats-page-slot">
        <StatsPage api={window.commitScope} sessionKey={currentSessionKey ? `${currentSessionKey}:${JSON.stringify(view.session?.scope ?? null)}` : null} query={displayedQuery}
          capabilities={{ activity: coreCapabilities.includes("activityOverview"), changes: coreCapabilities.includes("changeStats"), notable: coreCapabilities.includes("notableStats"), evolution: coreCapabilities.includes("evolution") }}
          active={page === "stats"} indexKey={activityIndexKey} evolutionVersion={scopeTreeVersion} allBranches={view.session?.scope === "allBranches"}
          onQueryChange={updateSearchQuery} onAuthor={addActivityAuthor} onShowCommits={() => changePage("commits")}
          onShowCommit={oid => { changePage("commits"); void showCommit(oid); }} />
      </div> : null}
      </div>
      : <OpenScreen preview={view} actions={actions} recent={recent} />}
    <StatusBar status={status} preview={statusView}
      previewStatus={searchView.active ? searchView.window
        ? searchView.window.coverage.complete ? `搜索最终结果 · ${searchView.window.matchedCount} 条` : `搜索部分结果 · ${searchView.window.matchedCount} 条`
        : searchView.loading ? "正在搜索当前历史范围…" : "搜索尚未读取到结果" : undefined}
      searchBusy={searchRequestBusy}
      onIndexAction={async action => {
        const applied = await store.controlMetadataIndex(action);
        const index = store.getView().metadataIndex;
        if (applied && index && searchStore.getView().active) {
          searchStore.setIndexStatus(index);
          await searchStore.retry();
        }
      }} />
    <CommandPalette sessionKey={currentSessionKey} loading={view.navigationLoading} error={view.navigationError?.message}
      context={{ refs: view.navigation?.refs ?? view.refs, worktrees: view.navigation?.worktrees ?? [],
        repositoryReady: view.state === "ready" && !view.opening && !view.refreshing && !view.scopeSwitching,
        coreReady: ready, filesAvailable, workspaceAvailable: !workspaceUnavailable,
        selectedOid: paletteSelectedOid, oidLength: view.repository?.objectFormat === "sha256" ? 64 : 40,
        selectedMessage: paletteSelectedMessage, headReference: view.repository?.headReference ?? null,
        hasWorkingDirectory: Boolean(view.repository && !view.repository.isBare),
        fetchAvailable: Boolean(actions.fetch && !actions.fetch.running && !operationsView.running),
        pushLabel: palettePushLabel,
        mergeBaseLabel: paletteMergeBaseLabel }}
      onLoadNavigation={() => { if (!store.getView().navigation) void loadNavigation(); }} onExecute={executePalette} />
    {operationsView.refusal && view.repository ? <OperationRefusal key={operationsView.refusal.id} refusal={operationsView.refusal} canOpenTerminal={!view.repository.isBare}
      hasHandoff={Boolean(operations?.refusalHandoff())} onClose={() => operationsStore.dismissRefusal()} onOpenWorkspace={() => changePage("workspace")}
      onReplaceUntracked={operations ? choice => { void operations.replaceUntrackedAndUpdate(choice); } : undefined}
      onFetch={actions.fetch ? () => { void actions.fetch?.start(false); } : undefined}
      onHandoff={() => { const request = operations?.refusalHandoff(); if (request) openHandoff(request); }} /> : null}
    <CreateBranchDialog start={operations ? branchStart : null} onClose={() => setBranchStart(null)}
      busy={Boolean(operations?.busy)} onCreate={(name, startOid, switchAfter) => operations ? operations.createBranch(name, startOid, switchAfter) : Promise.resolve({ close: true })}
      existingBranches={(view.navigation?.refs ?? view.refs).filter(ref => ref.kind === "localBranch").map(ref => shortRefName(ref.name))} />
    <FastForwardMergeDialog target={operations ? ffMergeTarget : null} busy={Boolean(operations?.busy)} onClose={() => setFfMergeTarget(null)}
      onConfirm={(target, switchToTarget) => operations
        ? operations.fastForwardMerge(target.targetRef, target.targetOid, target.sourceRef, target.sourceOid, switchToTarget)
        : Promise.resolve(false)} />
    <HandoffDialog open={handoffOpen} onOpenChange={setHandoffOpen} request={handoffRequest} sessionKey={detailSessionKey}
      onLoadFacts={loadHandoffFacts} onCancelFacts={async () => { await window.commitScope.cancelHandoffFacts(); }}
      onCopyText={text => window.commitScope.copyText(text)} />
  </div></DiffFullContext.Provider>;
}

/** The tree the files page shows by default: the newest commit of the browsing scope. */
function treeVersionForScope(view: RepositoryView): TreeVersion | null {
  const session = view.session;
  const repository = view.repository;
  if (!session || !repository) return null;
  const head = repository.headOid ? { commit: repository.headOid, label: repository.headReference ? shortRefName(repository.headReference) : "HEAD" } : null;
  const scope = session.scope;
  if (scope === "head") return head;
  if (scope === "allBranches") return head;
  if ("ref" in scope) {
    const ref = view.refs.find(item => item.name === scope.ref);
    const commit = ref ? ref.peeledOid ?? ref.oid : session.tips[0];
    return commit ? { commit, label: shortRefName(scope.ref) } : head;
  }
  const worktree = view.navigation?.worktrees.find(item => item.id === scope.worktree);
  const commit = worktree?.headOid ?? session.tips[0];
  return commit ? { commit, label: worktree?.headReference ? shortRefName(worktree.headReference) : `worktree ${repositoryName(worktree?.path ?? "")}` } : head;
}

/** Versions offered by the tree-version picker: the scope's default, then local branches, tags and remote branches. */
function treeVersionOptions(view: RepositoryView, scopeVersion: TreeVersion | null): VersionOption[] {
  const options: VersionOption[] = scopeVersion ? [{ id: "scope", version: scopeVersion, group: "浏览范围", hint: "默认" }] : [];
  const refs = view.navigation?.refs ?? view.refs;
  const group = { localBranch: "本地分支", tag: "标签", remoteBranch: "远端跟踪" } as const;
  for (const kind of ["localBranch", "tag", "remoteBranch"] as const) {
    for (const ref of refs.filter(item => item.kind === kind).slice(0, 200)) {
      options.push({ id: `${kind}:${ref.name}`, version: { commit: ref.peeledOid ?? ref.oid, label: shortRefName(ref.name) }, group: group[kind] });
    }
  }
  return options;
}

/** The top-bar search on the files page: find in the loaded content, or search the path's history by message. */
function filesSearchBox(files: ReturnType<FilesStore["getView"]>, find: { query: string; current: number }, count: number,
  setFind: React.Dispatch<React.SetStateAction<{ query: string; current: number }>>, historyQuery: string, setHistoryQuery: (value: string) => void): React.JSX.Element | null {
  const selection = files.selection;
  if (!files.supported || !selection) return null;
  if (selection.kind === "file") {
    const content = files.content?.value;
    if (content?.kind !== "text" || (files.tab === "history" && files.selectedCommit !== null)) return null;
    const { truncated, lines } = content;
    const position = count ? ((find.current % count) + count) % count + 1 : 0;
    const trailing = find.query
      ? <span className="shrink-0 font-mono text-[11.5px] whitespace-nowrap text-fg3 tabular-nums" data-testid="find-count">
        {count ? `${position} / ${count}${truncated ? ` · 前 ${lines.toLocaleString()} 行` : ""}` : truncated ? `前 ${lines.toLocaleString()} 行中没有` : "0 / 0"}</span>
      : undefined;
    // The file's name is in the breadcrumb; a long one here would leave no room to type.
    return <PageSearchBox scope="当前文件" label="在文件内容中查找" placeholder="查找" value={find.query}
      onChange={query => setFind({ query, current: 0 })} trailing={trailing}
      title={truncated ? `只在已加载的前 ${lines.toLocaleString()} 行里查找；Enter / ⇧Enter 跳到下一处 / 上一处` : "在文件里查找；Enter / ⇧Enter 跳到下一处 / 上一处（⌘F）"}
      onKeyDown={event => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        setFind(current => ({ ...current, current: current.current + (event.shiftKey ? -1 : 1) }));
      }} />;
  }
  return <PageSearchBox scope="目录历史" label="按提交消息搜索这个路径的历史" placeholder="搜索提交消息"
    value={historyQuery} onChange={setHistoryQuery} title="按提交消息搜索，路径条件固定为当前文件或目录（⌘F）" />;
}

function describeScope(scope: RepositoryScope | null, navigation: RepositoryNavigation | null): string {
  if (!scope) return "旧范围";
  if (scope === "head") return "HEAD 历史";
  if (scope === "allBranches") return "全部分支";
  if ("ref" in scope) return scope.ref;
  const worktree = navigation?.worktrees.find(item => item.id === scope.worktree);
  return worktree ? `worktree ${repositoryName(worktree.path)}` : "选中的 worktree";
}
