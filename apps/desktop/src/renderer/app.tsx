import * as React from "react";
import { X } from "lucide-react";
import type { CoreStatus } from "../../../../packages/protocol/src/core-status.js";
import type { RepositorySessionInfo } from "../../../../packages/protocol/src/generated/server-message.js";
import type { RepositoryScope } from "../../../../packages/protocol/src/generated/server-message.js";
import type { RepositoryNavigation } from "../../../../packages/protocol/src/repository-session.js";
import { CommitDetail } from "./components/commit-detail.js";
import { CommitList } from "./components/commit-list.js";
import { OpenScreen } from "./components/open-screen.js";
import type { RecentState } from "./components/recent-repositories.js";
import { StatusBar } from "./components/status-bar.js";
import { TopBar } from "./components/top-bar.js";
import { errorTitle } from "./lib/errors.js";
import { repositoryName } from "./lib/format.js";
import { RepositorySessionStore, settle, type RepositoryView } from "./lib/repository-session-store.js";
import { applySelectionIfCurrent, SelectionIntent, type SelectionIntentToken } from "./lib/selection-intent.js";

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
  const selectionIntent = React.useMemo(() => new SelectionIntent(), []);
  const view = React.useSyncExternalStore(store.subscribe, store.getView);
  const ready = status.state === "ready";
  const { recent, refresh: refreshRecent } = useRecentRepositories(ready, view.session);
  const [path, setPathState] = React.useState("");
  const [actionError, setActionError] = React.useState<string>();
  const [selectedOid, setSelectedOid] = React.useState<string>();
  const anchorBeforeRefresh = React.useRef<{ oid: string; offset: number } | undefined>(undefined);
  const pathEdited = React.useRef(false);
  const setViewportAnchor = React.useCallback((oid: string | undefined) => store.setViewportAnchor(oid), [store]);
  const loadNavigation = React.useCallback(() => store.loadNavigation(), [store]);
  const loadMergeStatus = React.useCallback((names: string[]) => store.loadRefMergeStatus(names), [store]);
  const cancelMergeStatus = React.useCallback(() => store.cancelRefMergeStatus(), [store]);
  const selectCommit = React.useCallback((oid: string) => {
    selectionIntent.invalidate();
    setSelectedOid(oid);
  }, [selectionIntent]);
  const captureSelectionIntent = React.useCallback(() => selectionIntent.capture(store.getView().session), [selectionIntent, store]);
  const selectIfCurrent = React.useCallback((oid: string, token: SelectionIntentToken | null) => {
    applySelectionIfCurrent(selectionIntent, token, store.getView().session, oid, setSelectedOid);
  }, [selectionIntent, store]);

  useViewRecording(store, view);
  useLaunchRepository(ready, store);

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
    open: (target = path) => run(() => store.open(target)),
    choose: () => run(async () => {
      const chosen = await window.commitScope.chooseRepository();
      if (!chosen) return;
      pathEdited.current = true;
      setPathState(chosen);
      await store.open(chosen);
    }),
    cancel: () => run(() => store.cancel()),
    retry: () => run(() => store.retry()),
    retryPage: () => view.pageErrorKind === "refresh" ? refresh() : run(() => store.retryPage(selectedOid)),
    cancelPage: () => run(() => store.cancelPage()),
    previousPage: () => store.previousPage(),
    nextPage: () => store.nextPage(),
    refresh,
    switchScope: scope => run(async () => {
      const selectionToken = captureSelectionIntent();
      const container = document.querySelector<HTMLElement>('[aria-label="提交列表"] [role="listbox"]');
      const containerTop = container?.getBoundingClientRect().top ?? 0;
      const anchorRow = container ? [...container.querySelectorAll<HTMLElement>('[data-testid="commit-row"]')]
        .find(row => row.getBoundingClientRect().bottom > containerTop) : undefined;
      const anchor = anchorRow ? { oid: anchorRow.dataset.oid ?? "", offset: anchorRow.getBoundingClientRect().top - containerTop } : undefined;
      anchorBeforeRefresh.current = anchor;
      const result = await store.switchScope(scope, selectedOid, anchor);
      if (result) {
        anchorBeforeRefresh.current = result.anchor;
        if (selectionIntent.isRevisionCurrent(selectionToken)) {
          selectionIntent.invalidate();
          setSelectedOid(result.selectedOid);
        }
      }
    }),
  };

  const alerts = [
    status.state === "error" ? `核心不可用：${status.message}` : undefined,
    readError ? `核心状态读取失败：${readError}` : undefined,
    actionError ? `操作失败：${actionError}` : undefined,
  ].filter((message): message is string => Boolean(message));
  const notice = view.notice;

  return <div className="flex h-full min-h-0 flex-col">
    {view.repository
      ? <TopBar preview={view} actions={actions} recent={recent} onRefreshRecent={refreshRecent} onSelectCommit={selectCommit}
        onLoadNavigation={loadNavigation} onLoadMergeStatus={loadMergeStatus} onCancelMergeStatus={cancelMergeStatus} onRefresh={refresh} />
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
      ? <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <CommitList preview={view} selectedOid={selectedOid} onSelect={selectCommit}
            captureSelectionIntent={captureSelectionIntent} selectIfCurrent={selectIfCurrent} onCancel={actions.cancel}
            onRetry={actions.retry} onRetryPage={actions.retryPage} onCancelPage={actions.cancelPage}
            onPreviousPage={actions.previousPage} onNextPage={actions.nextPage}
            onLoadWindowEdge={direction => store.loadWindowEdge(direction)}
            onViewportAnchor={setViewportAnchor}
            onPrefetchPreviousPage={() => { const cursor = store.getView().windowPreviousCursor; if (cursor) void store.readPage(cursor); }}
            onPrefetchNextPage={() => { const cursor = store.getView().windowNextCursor; if (cursor) void store.readPage(cursor); }}
            restorationAnchor={anchorBeforeRefresh.current}
            onSetAnchorRestorationSpace={pixels => store.setAnchorRestorationSpace(pixels)} />
          <CommitDetail preview={view} selectedOid={selectedOid} onSelect={selectCommit}
            onMoveSelection={async delta => {
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
        </div>
      </div>
      : <OpenScreen preview={view} actions={actions} recent={recent} />}
    <StatusBar status={status} preview={view} />
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
