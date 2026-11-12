import * as React from "react";
import { X } from "lucide-react";
import { Button } from "./ui/button.js";
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

/** Git failed after an operation started. Its own text is shown as plain text; nothing is retried or rolled back. */
export function OperationFailureBanner({ failure, canOpenTerminal, onHandoff, onClose }: {
  failure: PendingFailure;
  canOpenTerminal: boolean;
  onHandoff(): void;
  onClose(): void;
}): React.JSX.Element {
  const terminal = useTerminalOpener();
  const verb = failure.meta.step === "update" ? "更新" : failure.meta.step === "switch" ? "切换到" : "新建分支";
  return <div role="alert" data-testid="operation-failure" className="flex items-start gap-4 border-b border-bad-line bg-bad-bg px-4 py-3">
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="text-[13px] font-semibold text-bad" data-testid="operation-failure-title">{verb} {failure.meta.name} 时出错</div>
      <pre data-testid="operation-failure-output" className="m-0 max-h-32 overflow-auto font-mono text-xs leading-[1.5] whitespace-pre-wrap break-words text-fg2">{failure.message}</pre>
      <div className="text-xs text-fg3">仓库可能已被部分改动，界面已刷新到当前实际状态。CherryPeek 不会自动重试或回滚。</div>
      {terminal.error ? <div className="text-xs text-bad" data-testid="operation-failure-terminal-error">{terminal.error}</div> : null}
    </div>
    <div className="flex shrink-0 items-center gap-2">
      {canOpenTerminal ? <Button variant="outline" size="sm" onClick={terminal.open} data-testid="operation-failure-terminal">在终端打开</Button> : null}
      <Button size="sm" onClick={onHandoff} data-testid="operation-failure-handoff">交给 Agent…</Button>
      <button type="button" aria-label="关闭" onClick={onClose}
        className="flex size-7 items-center justify-center rounded-[7px] text-fg3 hover:bg-bad/10"><X className="size-3.5" strokeWidth={1.75} /></button>
    </div>
  </div>;
}

/** A short remark about an operation, e.g. that the branch changed in the meantime. Plain text. */
export function OperationNoticeBanner({ message, onClose }: { message: string; onClose(): void }): React.JSX.Element {
  return <div role="status" data-testid="operation-notice" className="flex items-center gap-3 border-b border-warn-line bg-warn-bg px-4 py-2 text-[13px] text-warn">
    <span className="min-w-0 flex-1 break-words">{message}</span>
    <button type="button" aria-label="关闭提示" onClick={onClose}
      className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-warn/10"><X className="size-3.5" strokeWidth={1.75} /></button>
  </div>;
}

/** The refusal of an operation, from the blockers the core reported. Nothing was changed. */
export function OperationRefusal({ refusal, canOpenTerminal, hasHandoff, onClose, onOpenWorkspace, onHandoff }: {
  refusal: PendingRefusal;
  /** The window has a working directory to open a terminal in. */
  canOpenTerminal: boolean;
  /** A hand-off request can be built for this refusal. */
  hasHandoff: boolean;
  onClose(): void;
  onOpenWorkspace(): void;
  onHandoff(): void;
}): React.JSX.Element {
  const terminal = useTerminalOpener();
  const model = React.useMemo(() => refusalModel(refusal.blockers, refusal.meta, refusal.preservedDirtyCount), [refusal]);
  return <RefusalDialog title={model.title} explanation={model.explanation} lists={model.lists}
    footnote={terminal.error ?? model.footnote} onClose={onClose}
    onOpenWorkspace={model.workspaceLink ? () => { onClose(); onOpenWorkspace(); } : undefined}
    onOpenTerminal={model.terminalAllowed && canOpenTerminal ? terminal.open : undefined}
    onHandoff={model.handoff && hasHandoff ? () => { onClose(); onHandoff(); } : undefined} />;
}
