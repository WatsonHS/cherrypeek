import * as React from "react";
import type { CoreStatus } from "../../../../packages/protocol/src/core-status.js";
import { emptyRepositoryPreview, type RepositoryPreviewState } from "../../../../packages/protocol/src/repository-preview.js";
import { CommitDetail } from "./components/commit-detail.js";
import { CommitList } from "./components/commit-list.js";
import { OpenScreen } from "./components/open-screen.js";
import { StatusBar } from "./components/status-bar.js";
import { TopBar } from "./components/top-bar.js";

export interface RepositoryActions {
  path: string;
  setPath(path: string): void;
  open(path?: string): Promise<void>;
  choose(): Promise<void>;
  cancel(): Promise<void>;
}

/** Subscribes to core status and repository preview, ignoring stale revisions. */
function useAppState() {
  const [status, setStatus] = React.useState<CoreStatus>({ state: "starting", revision: -1 });
  const [preview, setPreview] = React.useState<RepositoryPreviewState>(emptyRepositoryPreview(-1));
  const [readErrors, setReadErrors] = React.useState<{ status?: string; preview?: string }>({});
  const coreRevision = React.useRef(-1);
  const previewRevision = React.useRef(-1);

  React.useEffect(() => {
    let active = true;
    const acceptCore = (next: CoreStatus) => {
      if (!active || next.revision <= coreRevision.current) return;
      coreRevision.current = next.revision;
      setReadErrors(current => ({ ...current, status: undefined }));
      setStatus(next);
    };
    const acceptPreview = (next: RepositoryPreviewState) => {
      if (!active || next.revision <= previewRevision.current) return;
      previewRevision.current = next.revision;
      setReadErrors(current => ({ ...current, preview: undefined }));
      setPreview(next);
    };
    const unsubscribeCore = window.commitScope.onCoreStatusChanged(acceptCore);
    const unsubscribePreview = window.commitScope.onRepositoryPreviewChanged(acceptPreview);
    void window.commitScope.getCoreStatus().then(acceptCore).catch(error => {
      if (active) setReadErrors(current => ({ ...current, status: String(error) }));
    });
    void window.commitScope.getRepositoryPreview().then(acceptPreview).catch(error => {
      if (active) setReadErrors(current => ({ ...current, preview: String(error) }));
    });
    return () => { active = false; unsubscribeCore(); unsubscribePreview(); };
  }, []);

  return { status, preview, readErrors };
}

export function App(): React.JSX.Element {
  const { status, preview, readErrors } = useAppState();
  const [path, setPathState] = React.useState("");
  const [actionError, setActionError] = React.useState<string>();
  const [selectedOid, setSelectedOid] = React.useState<string>();
  const pathEdited = React.useRef(false);

  // Keep the path field and the selection in step with the latest preview.
  React.useEffect(() => {
    if (preview.repository && !pathEdited.current) setPathState(preview.repository.path);
    setSelectedOid(current => preview.commits.some(commit => commit.oid === current) ? current : preview.commits[0]?.oid);
  }, [preview]);

  const run = async (action: () => Promise<void>) => {
    setActionError(undefined);
    try { await action(); } catch (error) { setActionError(String(error)); }
  };
  const actions: RepositoryActions = {
    path,
    setPath(next) { pathEdited.current = true; setPathState(next); },
    open: (target = path) => run(() => window.commitScope.openRepositoryPreview(target)),
    choose: () => run(async () => {
      const chosen = await window.commitScope.chooseRepository();
      if (!chosen) return;
      pathEdited.current = true;
      setPathState(chosen);
      await window.commitScope.openRepositoryPreview(chosen);
    }),
    cancel: () => run(() => window.commitScope.cancelRepositoryPreview()),
  };

  const alerts = [
    status.state === "error" ? `核心不可用：${status.message}` : undefined,
    readErrors.status ? `核心状态读取失败：${readErrors.status}` : undefined,
    readErrors.preview ? `仓库状态读取失败：${readErrors.preview}` : undefined,
    actionError ? `操作失败：${actionError}` : undefined,
  ].filter((message): message is string => Boolean(message));

  return <div className="flex h-full min-h-0 flex-col">
    {alerts.length ? <div role="alert" className="flex flex-col gap-1 border-b border-bad-line bg-bad-bg px-4 py-2 text-[13px] text-bad">
      {alerts.map(message => <p key={message} className="m-0">{message}</p>)}
    </div> : null}
    {preview.repository
      ? <div className="flex min-h-0 flex-1 flex-col">
        <TopBar preview={preview} actions={actions} onSelectCommit={setSelectedOid} />
        <div className="flex min-h-0 flex-1">
          <CommitList preview={preview} selectedOid={selectedOid} onSelect={setSelectedOid} onCancel={actions.cancel} />
          <CommitDetail preview={preview} selectedOid={selectedOid} onSelect={setSelectedOid} />
        </div>
      </div>
      : <OpenScreen preview={preview} actions={actions} />}
    <StatusBar status={status} preview={preview} />
  </div>;
}
