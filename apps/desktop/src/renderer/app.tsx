import * as React from "react";
import { X } from "lucide-react";
import type { CoreStatus } from "../../../../packages/protocol/src/core-status.js";
import type { RepositorySessionInfo } from "../../../../packages/protocol/src/generated/server-message.js";
import { CommitDetail } from "./components/commit-detail.js";
import { CommitList } from "./components/commit-list.js";
import { OpenScreen } from "./components/open-screen.js";
import type { RecentState } from "./components/recent-repositories.js";
import { StatusBar } from "./components/status-bar.js";
import { TopBar } from "./components/top-bar.js";
import { errorTitle } from "./lib/errors.js";
import { RepositorySessionStore, settle, type RepositoryView } from "./lib/repository-session-store.js";

export interface RepositoryActions {
  path: string;
  setPath(path: string): void;
  open(path?: string): Promise<void>;
  choose(): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<void>;
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
  const refresh = React.useCallback(() => {
    const id = ++request.current;
    void settle(window.commitScope.listRecentRepositories()).then(result => {
      if (id !== request.current) return;
      setRecent(result.ok
        ? { loaded: true, repositories: result.value.repositories, status: result.value.status, error: null }
        : { loaded: true, repositories: [], status: null, error: result.error.message });
    });
  }, []);
  React.useEffect(() => { if (ready) refresh(); }, [ready, session, refresh]);
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
  const view = React.useSyncExternalStore(store.subscribe, store.getView);
  const ready = status.state === "ready";
  const { recent, refresh: refreshRecent } = useRecentRepositories(ready, view.session);
  const [path, setPathState] = React.useState("");
  const [actionError, setActionError] = React.useState<string>();
  const [selectedOid, setSelectedOid] = React.useState<string>();
  const pathEdited = React.useRef(false);

  useViewRecording(store, view);
  useLaunchRepository(ready, store);

  React.useEffect(() => {
    if (status.state === "error" || status.state === "stopped") store.coreUnavailable();
  }, [status.state, store]);

  // Keep the path field and the selection in step with what is shown.
  React.useEffect(() => {
    if (view.repository && !pathEdited.current) setPathState(view.repository.path);
    setSelectedOid(current => view.commits.some(commit => commit.oid === current) ? current : view.commits[0]?.oid);
  }, [view.repository, view.commits]);

  const run = async (action: () => Promise<void>) => {
    setActionError(undefined);
    try { await action(); } catch (error) { setActionError(String(error)); }
  };
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
  };

  const alerts = [
    status.state === "error" ? `核心不可用：${status.message}` : undefined,
    readError ? `核心状态读取失败：${readError}` : undefined,
    actionError ? `操作失败：${actionError}` : undefined,
  ].filter((message): message is string => Boolean(message));
  const notice = view.notice;

  return <div className="flex h-full min-h-0 flex-col">
    {alerts.length || notice ? <div role="alert" className="flex flex-col gap-1 border-b border-bad-line bg-bad-bg px-4 py-2 text-[13px] text-bad">
      {alerts.map(message => <p key={message} className="m-0">{message}</p>)}
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
        <TopBar preview={view} actions={actions} recent={recent} onRefreshRecent={refreshRecent} onSelectCommit={setSelectedOid} />
        <div className="flex min-h-0 flex-1">
          <CommitList preview={view} selectedOid={selectedOid} onSelect={setSelectedOid} onCancel={actions.cancel} onRetry={actions.retry} />
          <CommitDetail preview={view} selectedOid={selectedOid} onSelect={setSelectedOid} />
        </div>
      </div>
      : <OpenScreen preview={view} actions={actions} recent={recent} />}
    <StatusBar status={status} preview={view} />
  </div>;
}
