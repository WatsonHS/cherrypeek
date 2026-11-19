import * as React from "react";
import { X } from "lucide-react";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import { divergedSyncTargetFromRefusal, type DivergedSyncTarget, type OperationStep, type UntrackedChoice, type UpdateNotice } from "../lib/operations.js";
import type { UpdateBatchRecord } from "../lib/update-batch.js";
import { RefusalDialog } from "./refusal-dialog.js";
import { refusalModel } from "../lib/operation-refusal.js";
import type { PendingFailure, PendingRefusal } from "../lib/operations-store.js";

function useTerminalOpener(): { error: string | null; open(): void } {
  const [error, setError] = React.useState<string | null>(null);
  const open = React.useCallback(() => {
    setError(null);
    window.commitScope.openWorkspaceIn("terminal").catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/u, "") : "打开终端失败");
    });
  }, []);
  return { error, open };
}

const FAILURE_VERB: Record<OperationStep, string> = {
  update: "更新",
  switch: "切换到",
  createBranch: "新建分支",
  push: "推送",
  deleteBranch: "删除分支",
  mergeInto: "快进合入",
  workspaceStage: "暂存",
  workspaceUnstage: "取消暂存",
  workspaceDiscard: "丢弃",
  workspaceCommit: "提交",
  completeMerge: "同步分支",
};

/** Git failed after an operation started. Its own text is shown as plain text; nothing is retried or rolled back. */
export function OperationFailureBanner({ failure, canOpenTerminal, onRetry, onHandoff, onClose }: {
  failure: PendingFailure;
  canOpenTerminal: boolean;
  onRetry?(): void;
  onHandoff(): void;
  onClose(): void;
}): React.JSX.Element {
  const terminal = useTerminalOpener();
  const verb = FAILURE_VERB[failure.meta.step];
  const note = failure.meta.step === "push"
    ? "远端推送未完成（本地分支与工作区未执行强推），界面已刷新到当前实际状态。"
    : failure.meta.step === "workspaceCommit"
      ? "提交尚未创建（例如未通过 Git hook），已暂存的改动和提交说明已保留。"
      : "仓库可能已被部分改动，界面已刷新到当前实际状态。CherryPeek 不会自动重试或回滚。";
  return <div role="alert" data-testid="operation-failure" className="flex items-start gap-4 border-b border-bad-line bg-bad-bg px-4 py-3">
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="text-[13px] font-semibold text-bad" data-testid="operation-failure-title">{verb}{failure.meta.name ? ` ${failure.meta.name}` : ""} 时出错</div>
      <pre data-testid="operation-failure-output" className="m-0 max-h-32 overflow-auto font-mono text-xs leading-[1.5] whitespace-pre-wrap break-words text-fg2">{failure.message}</pre>
      <div className="text-xs text-fg3">{note}</div>
      {terminal.error ? <div className="text-xs text-bad" data-testid="operation-failure-terminal-error">{terminal.error}</div> : null}
    </div>
    <div className="flex shrink-0 items-center gap-2">
      {failure.meta.step === "push" && onRetry ? <Button variant="outline" size="sm" onClick={onRetry} data-testid="operation-failure-retry">重试</Button> : null}
      {canOpenTerminal ? <Button variant="outline" size="sm" onClick={terminal.open} data-testid="operation-failure-terminal">在终端打开</Button> : null}
      <Button size="sm" onClick={onHandoff} data-testid="operation-failure-handoff">交给 Agent…</Button>
      <button type="button" aria-label="关闭" onClick={onClose}
        className="flex size-7 items-center justify-center rounded-[7px] text-fg3 hover:bg-bad/10"><X className="size-3.5" strokeWidth={1.75} /></button>
    </div>
  </div>;
}

export function OperationNoticeBanner({ message, onClose, onFilterBatch, onStatsBatch, onHandoffBatch }: {
  message: string | UpdateNotice;
  onClose(): void;
  onFilterBatch?(batch: UpdateBatchRecord): void;
  onStatsBatch?(batch: UpdateBatchRecord): void;
  onHandoffBatch?(batch: UpdateBatchRecord): void;
}): React.JSX.Element {
  const success = typeof message !== "string";
  const summary = success ? message.summary : message;
  const files = success ? message.untracked : null;
  const batch = success ? message.batch ?? null : null;
  const color = success ? "border-line bg-ok-bg text-ok" : "border-warn-line bg-warn-bg text-warn";
  return <div data-testid="operation-notice" className={`flex flex-wrap items-center gap-3 border-b px-4 py-1.5 text-[13px] ${color}`}>
    <span role="status" className={success ? "min-w-0 truncate" : "min-w-0 break-words"} title={summary}>{summary}</span>
    {files ? <Popover>
      <PopoverTrigger asChild><Button variant="link" size="sm" className="h-6 px-0" aria-label="更新详情">详情</Button></PopoverTrigger>
      <PopoverContent className="flex w-80 max-w-[90vw] flex-col gap-2 p-3" aria-label="更新详情">
        {files.identicalCount > 0 && <p>{files.identicalCount} 个同名文件与上游相同，已纳入跟踪。</p>}
        {files.backedUpCount > 0 && <p>{files.backedUpCount} 个本地副本已备份，工作区已采用上游版本。</p>}
        {Boolean(files.discardedCount) && <p>{files.discardedCount} 个本地副本已丢弃，工作区已采用上游版本。</p>}
        {files.backupDir && <div><div className="mb-1 text-xs text-fg3">备份目录</div>
          <code data-testid="update-backup-dir" className="select-text break-all text-xs">{files.backupDir}</code></div>}
      </PopoverContent>
    </Popover> : null}
    {batch && batch.addedCount !== 0 ? <div data-testid="update-batch-actions" className="flex shrink-0 items-center gap-1.5 text-xs">
      {batch.addedCount !== null ? <span className="rounded bg-panel/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums">+{batch.addedCount} 个提交</span> : null}
      {onFilterBatch ? <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" data-testid="update-batch-filter" onClick={() => onFilterBatch(batch)}>筛选</Button> : null}
      {onStatsBatch ? <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" data-testid="update-batch-stats" onClick={() => onStatsBatch(batch)}>查看统计</Button> : null}
      {onHandoffBatch ? <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" data-testid="update-batch-handoff" onClick={() => onHandoffBatch(batch)}>交给 Agent…</Button> : null}
    </div> : null}
    <button type="button" aria-label="关闭提示" onClick={onClose}
      className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-warn/10"><X className="size-3.5" strokeWidth={1.75} /></button>
  </div>;
}

/** The refusal of an operation, from the blockers the core reported. Nothing was changed. */
export function OperationRefusal({ refusal, canOpenTerminal, hasHandoff, onClose, onOpenWorkspace, onReplaceUntracked, onFetch, onResolveDiverged, onHandoff }: {
  refusal: PendingRefusal;
  /** The window has a working directory to open a terminal in. */
  canOpenTerminal: boolean;
  /** A hand-off request can be built for this refusal. */
  hasHandoff: boolean;
  onClose(): void;
  onOpenWorkspace(): void;
  onReplaceUntracked?(choice: UntrackedChoice): void;
  onFetch?(): void;
  onResolveDiverged?(target: DivergedSyncTarget): void;
  onHandoff(): void;
}): React.JSX.Element {
  const terminal = useTerminalOpener();
  const model = React.useMemo(() => refusalModel(refusal.blockers, refusal.meta, refusal.preservedDirtyCount), [refusal]);
  const divergedTarget = React.useMemo(
    () => divergedSyncTargetFromRefusal(refusal.meta, refusal.blockers, refusal.operation),
    [refusal],
  );
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const replace = model.replace && refusal.operation && onReplaceUntracked ? model.replace : null;
  if (confirmDiscard && replace && onReplaceUntracked) {
    return <RefusalDialog key="confirm-discard" title={`丢弃 ${replace.count} 个本地副本？`} lists={model.lists}
      explanation="更新成功后，这些文件会采用上游版本，CherryPeek 不会保留本地副本。"
      safeLine="尚未丢弃任何文件" closeLabel="返回" focusClose onClose={() => setConfirmDiscard(false)}
      discard={{ label: "确认丢弃并更新", onSelect: () => onReplaceUntracked("discard") }} />;
  }
  const alternative = replace && onReplaceUntracked
    ? { label: "备份并更新", onSelect: () => onReplaceUntracked("backup") }
    : model.fetchBeforeRetry && onFetch
      ? { label: "Fetch 远端", onSelect: () => { onClose(); onFetch(); } }
      : undefined;
  return <RefusalDialog title={model.title} explanation={model.explanation} lists={model.lists}
    safeLine={refusal.meta.fetched ? "Fetch 已完成；本地分支和工作区未更新" : undefined}
    footnote={terminal.error ?? model.footnote} onClose={onClose}
    onOpenWorkspace={model.workspaceLink ? () => { onClose(); onOpenWorkspace(); } : undefined}
    onOpenTerminal={model.terminalAllowed && canOpenTerminal ? terminal.open : undefined}
    alternative={alternative}
    discard={replace ? { label: "丢弃并更新…", onSelect: () => setConfirmDiscard(true) } : undefined}
    resolveDiverged={divergedTarget && onResolveDiverged
      ? { label: "同步 / 解决冲突…", onSelect: () => { onClose(); onResolveDiverged(divergedTarget); } }
      : undefined}
    onHandoff={model.handoff && hasHandoff ? () => { onHandoff(); onClose(); } : undefined} />;
}
