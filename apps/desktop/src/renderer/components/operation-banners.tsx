import * as React from "react";
import { LoaderCircle, X } from "lucide-react";
import { Button } from "./ui/button.js";
import { momentLabel } from "../lib/format.js";

/** How long the "已 fetch" notice stays before it hides itself. */
export const FETCH_NOTICE_MS = 8000;

export interface FetchNoticeValue {
  remotes: string[];
  finishedAtUnixMs: number;
}

/** "已 fetch origin · 今天 14:31": a small status in the top bar after a fetch succeeded. */
export function FetchNotice({ notice, onDismiss, update }: {
  notice: FetchNoticeValue;
  onDismiss(): void;
  /** The window's branch can now be fast-forwarded: "更新 main". */
  update?: { branch: string; disabled: boolean; running: boolean; onUpdate(): void };
}): React.JSX.Element {
  const dismissRef = React.useRef(onDismiss);
  dismissRef.current = onDismiss;
  React.useEffect(() => {
    const timer = window.setTimeout(() => dismissRef.current(), FETCH_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const names = notice.remotes.length <= 3 ? notice.remotes.join("、") : `${notice.remotes.slice(0, 3).join("、")} 等 ${notice.remotes.length} 个远端`;
  const text = `已 fetch${names ? ` ${names}` : ""} · ${momentLabel(notice.finishedAtUnixMs)}`;
  return <div role="status" data-testid="fetch-notice"
    className="topbar-fetch-notice flex h-7 min-w-0 shrink items-center gap-1 rounded-full bg-ok-bg pr-1 pl-3 text-[12.5px] text-ok">
    <span className="min-w-0 truncate tabular-nums" title={notice.remotes.join("、")}>{text}</span>
    {update ? <button type="button" data-testid="fetch-notice-update" disabled={update.disabled} onClick={update.onUpdate}
      aria-label={`更新 ${update.branch}（快进到上游）`} title="快进到上游，工作区文件随之更新"
      className="flex h-5 max-w-[140px] shrink-0 items-center gap-1 rounded-full bg-ok px-2 text-[11.5px] font-medium text-panel hover:brightness-95 disabled:opacity-60">
      {update.running ? <LoaderCircle className="size-3 shrink-0 animate-spin motion-reduce:animate-none" strokeWidth={1.75} aria-hidden="true" /> : null}
      <span className="truncate">更新 {update.branch}</span>
    </button> : null}
    <button type="button" aria-label="关闭提示" onClick={onDismiss}
      className="flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-ok/10"><X className="size-3" strokeWidth={1.75} /></button>
  </div>;
}

/** fetch failed: nothing was changed. Git's own message is shown as plain text. */
export function FetchFailureBanner({ message, retrying, canOpenTerminal, onRetry, onHandoff, onClose }: {
  message: string;
  /** A fetch is running right now, so retry waits. */
  retrying: boolean;
  canOpenTerminal: boolean;
  onRetry(): void;
  onHandoff(): void;
  onClose(): void;
}): React.JSX.Element {
  const [terminalError, setTerminalError] = React.useState<string | null>(null);
  const openTerminal = () => {
    setTerminalError(null);
    window.commitScope.openWorkspaceIn("terminal").catch((reason: unknown) => {
      setTerminalError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/u, "") : "打开终端失败");
    });
  };
  return <div role="alert" data-testid="fetch-failure"
    className="flex items-start gap-4 border-b border-bad-line bg-bad-bg px-4 py-3">
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="text-[13px] font-semibold text-bad">fetch 没有完成，仓库未被改动</div>
      <pre data-testid="fetch-failure-output" className="m-0 max-h-32 overflow-auto font-mono text-xs leading-[1.5] whitespace-pre-wrap break-words text-fg2">{message}</pre>
      <div className="text-xs text-fg3">CherryPeek 不会弹出密码输入，只使用已有的凭据助手或 ssh-agent。</div>
      {terminalError ? <div className="text-xs text-bad" data-testid="fetch-failure-terminal-error">{terminalError}</div> : null}
    </div>
    <div className="flex shrink-0 items-center gap-2">
      <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry} data-testid="fetch-retry">重试</Button>
      {canOpenTerminal ? <Button variant="outline" size="sm" onClick={openTerminal} data-testid="fetch-open-terminal">在终端打开</Button> : null}
      <Button size="sm" onClick={onHandoff} data-testid="fetch-handoff">交给 Agent…</Button>
      <button type="button" aria-label="关闭" onClick={onClose}
        className="flex size-7 items-center justify-center rounded-[7px] text-fg3 hover:bg-bad/10"><X className="size-3.5" strokeWidth={1.75} /></button>
    </div>
  </div>;
}
