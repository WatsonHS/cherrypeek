import * as React from "react";
import { X } from "lucide-react";
import type { CoreStatus } from "../../../../packages/protocol/src/core-status.js";
import type { ActivityStats, HandoffFacts, RefSnapshotDiff, RepositoryObservation, RepositorySessionInfo, SearchIdentity } from "../../../../packages/protocol/src/generated/server-message.js";
import type { RepositoryScope } from "../../../../packages/protocol/src/generated/server-message.js";
import type { GetHandoffFactsParams } from "../../../../packages/protocol/src/generated/client-message.js";
import type { RepositoryNavigation } from "../../../../packages/protocol/src/repository-session.js";
import type { HandoffTarget } from "./components/handoff-dialog.js";
import type { SearchQuery, SearchTimeField } from "../../../../packages/protocol/src/generated/client-message.js";
import { CommitDetail } from "./components/commit-detail.js";
import { CommitList } from "./components/commit-list.js";
import { SearchResultList } from "./components/search-result-list.js";
import { HistorySplitView } from "./components/history-split-view.js";
import { OpenScreen } from "./components/open-screen.js";
import type { RecentState } from "./components/recent-repositories.js";
import { StatusBar } from "./components/status-bar.js";
import { TopBar } from "./components/top-bar.js";
import { errorTitle } from "./lib/errors.js";
import { repositoryName } from "./lib/format.js";
import { RepositorySessionStore, settle, type RepositoryView } from "./lib/repository-session-store.js";
import { applySelectionIfCurrent, SelectionIntent, type SelectionIntentToken } from "./lib/selection-intent.js";
import { hasSearchCriteria, MetadataSearchStore } from "./lib/metadata-search-store.js";
import { DEFAULT_SEARCH_QUERY } from "./lib/metadata-search-store.js";
import { inputDateRange } from "./lib/search-date.js";
import { CommitDetailStore } from "./lib/commit-detail-store.js";
import { Button } from "./components/ui/button.js";
import { HandoffDialog } from "./components/handoff-dialog.js";

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

export function App(): React.JSX.Element {
  const { status, readError } = useCoreStatus();
  const store = React.useMemo(() => new RepositorySessionStore(window.commitScope), []);
  const searchStore = React.useMemo(() => new MetadataSearchStore(window.commitScope), []);
  const detailStore = React.useMemo(() => new CommitDetailStore(window.commitScope), []);
  const selectionIntent = React.useMemo(() => new SelectionIntent(), []);
  const view = React.useSyncExternalStore(store.subscribe, store.getView);
  const searchView = React.useSyncExternalStore(searchStore.subscribe, searchStore.getView);
  const detailView = React.useSyncExternalStore(detailStore.subscribe, detailStore.getView);
  const ready = status.state === "ready";
  const metadataIndexSupported = ready && status.core.capabilities.includes("metadataIndex");
  const activityStatsSupported = ready && status.core.capabilities.includes("activityStats");
  const { recent, refresh: refreshRecent } = useRecentRepositories(ready, view.session);
  const [path, setPathState] = React.useState("");
  const [actionError, setActionError] = React.useState<string>();
  const [selectedOid, setSelectedOid] = React.useState<string>();
  const [historyLocation, setHistoryLocation] = React.useState<{ oid: string; sessionKey: string; loading: boolean; cancelled: boolean; error: string | null } | null>(null);
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
  const [handoffTarget, setHandoffTarget] = React.useState<HandoffTarget | null>(null);
  const [detailTab, setDetailTab] = React.useState("overview");
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
  const openHandoff = React.useCallback((target: HandoffTarget | null) => {
    setHandoffTarget(target);
    setHandoffOpen(true);
  }, []);
  const loadHandoffFacts = React.useCallback(async (target: HandoffTarget | null, _intent: number): Promise<HandoffFacts | null> => {
    if (!view.session) return null;
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
    if (found) setSelectedOid(oid);
    const pageError = store.getView().pageError;
    setHistoryLocation(current => current?.sessionKey === sessionKey ? {
      ...current, loading: false, error: found ? null : pageError?.code === "SCOPE_UNAVAILABLE"
        ? "提交不在当前快照范围内。" : pageError?.message ?? "历史定位未完成。",
    } : current);
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
  useLaunchRepository(ready, store);
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
    anchorBeforeRefresh.current = anchorRow ? {
      oid: anchorRow.dataset.oid ?? "",
      offset: anchorRow.getBoundingClientRect().top - containerTop,
    } : undefined;
    await store.refresh(selectedOid, anchorBeforeRefresh.current);
  });
  const actions: RepositoryActions = {
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

  const shortcutActions = React.useRef({ historyLocation, searchView, returnToSearch, locateSelectedInHistory, refresh, setDetailTab });
  shortcutActions.current = { historyLocation, searchView, returnToSearch, locateSelectedInHistory, refresh, setDetailTab };
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || !(event.metaKey || event.ctrlKey)) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const actions = shortcutActions.current;
      const key = event.key.toLowerCase();
      if (event.code === "KeyF" && !event.altKey) {
        event.preventDefault();
        const focus = () => requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="search-input"]')?.focus());
        if (actions.historyLocation) void actions.returnToSearch().then(focus);
        else focus();
      } else if (key === "[" && !event.altKey && actions.historyLocation) {
        event.preventDefault();
        void actions.returnToSearch();
      } else if (key === "]" && !event.altKey && actions.searchView.active && actions.searchView.selectedOid) {
        event.preventDefault();
        void actions.locateSelectedInHistory(actions.searchView.selectedOid);
      } else if (event.code === "Digit1" && !event.altKey) {
        event.preventDefault();
        actions.setDetailTab("overview");
      } else if (event.code === "Digit2" && !event.altKey) {
        event.preventDefault();
        actions.setDetailTab("changes");
      } else if (event.code === "KeyR" && event.altKey) {
        event.preventDefault();
        void actions.refresh();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const alerts = [
    status.state === "error" ? `核心不可用：${status.message}` : undefined,
    readError ? `核心状态读取失败：${readError}` : undefined,
    actionError ? `操作失败：${actionError}` : undefined,
  ].filter((message): message is string => Boolean(message));
  const notice = view.notice;
  const displayedOid = searchView.active ? searchView.selectedOid : selectedOid;
  const displayedCommit = searchView.active
    ? searchView.window?.commits.find(commit => commit.oid === displayedOid) ?? searchView.oldSelectedCommit
    : null;
  const detailSessionKey = view.session ? `${view.session.repoId}:${view.session.generation}:${JSON.stringify(view.session.scope)}` : null;
  const detailSelectionIsLoaded = searchView.active
    ? Boolean(displayedOid && searchView.window?.commits.some(commit => commit.oid === displayedOid))
    : Boolean(displayedOid && view.commits.some(commit => commit.oid === displayedOid));
  React.useEffect(() => detailStore.bind(detailSessionKey, displayedOid, detailSelectionIsLoaded), [detailStore, detailSessionKey, displayedOid, detailSelectionIsLoaded]);
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

  return <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
    {view.repository
      ? <TopBar preview={view} actions={actions} recent={recent} onRefreshRecent={refreshRecent} onSelectCommit={selectDisplayedCommit}
        onLoadNavigation={loadNavigation} onLoadMergeStatus={loadMergeStatus} onCancelMergeStatus={cancelMergeStatus} onRefresh={refresh}
        searchView={searchView} activityQuery={displayedQuery} onSearchQueryChange={updateSearchQuery} onSearchComposition={finishSearchComposition} onLoadSearchIdentities={loadSearchIdentities} onLoadSearchPaths={loadSearchPaths}
        observation={observation} refDiff={refDiff} refDiffLoading={refDiffLoading} refDiffError={refDiffError} onLoadRefDiff={loadRefDiff} onCancelRefDiff={cancelRefDiff} onObserve={observeNow}
        activityStats={activityStats?.key === activityKey ? activityStats.value : null} activityLoading={activityLoading} activityError={activityError}
        onLoadActivity={() => { activityLoadedSignature.current = null; setActivityError(null); scheduleActivity(0); }}
        onActivityAuthor={addActivityAuthor} onOpenHandoff={openHandoff} />
      : <div className="window-toolbar window-toolbar-empty" aria-hidden="true" />}
    {alerts.length || notice || view.scopeError ? <div role="alert" className="flex flex-col gap-1 border-b border-bad-line bg-bad-bg px-4 py-2 text-[13px] text-bad">
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
    {view.repository
      ? <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
        <HistorySplitView sidebar={searchView.active
            ? <SearchResultList view={searchView} onSelect={selectDisplayedCommit} onAnchor={setSearchAnchor}
              onNext={loadSearchNext} onPrevious={loadSearchPrevious} onRetry={retrySearch} />
            : <CommitList preview={view} selectedOid={selectedOid} onSelect={selectCommit}
            captureSelectionIntent={captureSelectionIntent} selectIfCurrent={selectIfCurrent} onCancel={actions.cancel}
            onRetry={actions.retry} onRetryPage={actions.retryPage} onCancelPage={actions.cancelPage}
            onLoadWindowEdge={direction => store.loadWindowEdge(direction)}
            onViewportAnchor={setViewportAnchor}
            activityDays={historyActivity?.days ?? null}
            activityDaysPartial={historyActivity ? !historyActivity.coverage.complete || historyActivity.daysTruncated : false}
            onLocateHistoryDate={locateHistoryDate} onCancelHistoryDate={cancelHistoryDate} onRetryHistoryDate={retryHistoryDate}
            onPrefetchPreviousPage={() => { const cursor = store.getView().windowPreviousCursor; if (cursor) void store.readPage(cursor); }}
            onPrefetchNextPage={() => { const cursor = store.getView().windowNextCursor; if (cursor) void store.readPage(cursor); }}
            restorationAnchor={anchorBeforeRefresh.current}
            onSetAnchorRestorationSpace={pixels => store.setAnchorRestorationSpace(pixels)} />}>
          <CommitDetail preview={view} detail={detailView} onRetryDetails={() => detailStore.retryDetails()}
            onRetryFiles={() => detailStore.retryFiles()} onLoadFiles={(parentIndex, offset) => detailStore.loadFiles(parentIndex, offset)}
            onRetryMerge={() => detailStore.retryMerge()} onLoadMerge={(parentIndex, offset) => detailStore.loadMerge(parentIndex, offset)}
            onToggleDiff={(file, parentIndex) => { void detailStore.toggleDiff(file, parentIndex); }}
            onLoadContaining={loadContainingBranches} onRetryContaining={() => detailStore.retryContaining()}
            onLocateInHistory={searchView.active && displayedOid ? () => { void locateSelectedInHistory(displayedOid); } : undefined}
            selectedOid={displayedOid} onSelect={selectDisplayedCommit}
            selectedTab={detailTab} onTabChange={setDetailTab} onOpenHandoff={openHandoff}
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
      : <OpenScreen preview={view} actions={actions} recent={recent} onOpenHandoff={() => openHandoff(null)} />}
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
    <HandoffDialog open={handoffOpen} onOpenChange={setHandoffOpen} target={handoffTarget} sessionKey={detailSessionKey}
      onLoadFacts={loadHandoffFacts} onCancelFacts={async () => { await window.commitScope.cancelHandoffFacts(); }}
      onCopyText={text => window.commitScope.copyText(text)} />
  </div>;
}

function describeScope(scope: RepositoryScope | null, navigation: RepositoryNavigation | null): string {
  if (!scope) return "旧范围";
  if (scope === "head") return "HEAD 历史";
  if (scope === "allBranches") return "全部分支";
  if ("ref" in scope) return scope.ref;
  const worktree = navigation?.worktrees.find(item => item.id === scope.worktree);
  return worktree ? `worktree ${repositoryName(worktree.path)}` : "选中的 worktree";
}
