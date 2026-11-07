import * as React from "react";
import { LoaderCircle } from "lucide-react";
import type { CoreStatus } from "../../../../../packages/protocol/src/core-status.js";
import type { MetadataIndexAction } from "../../../../../packages/protocol/src/generated/client-message.js";
import type { MetadataIndexStatus } from "../../../../../packages/protocol/src/generated/server-message.js";
import { isMetadataIndexRequestIdle, type RepositoryView } from "../lib/repository-session-store.js";
import { errorTitle } from "../lib/errors.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

function coreLabel(status: CoreStatus): string {
  switch (status.state) {
    case "ready": return "核心已就绪";
    case "starting": return "核心启动中";
    case "error": return "核心不可用";
    case "stopped": return "核心已停止";
  }
}

export function previewLabel(preview: RepositoryView): string {
  if (preview.opening !== null) return "正在打开仓库…";
  if (preview.state === "loading") return "正在读取首屏…";
  if (preview.refreshing) return "正在刷新快照…";
  if (preview.pageLoading) return "正在读取其他页…";
  if (preview.pageError) return `读取失败 · 保留当前页`;
  if (preview.state === "error") return preview.commits.length ? "读取失败 · 保留当前页" : "读取失败";
  if (preview.state === "cancelled") return "已取消";
  if (preview.state === "idle") return "未打开仓库";
  if (preview.commits.length === 0) return "当前范围没有提交";
  if (preview.refsTruncated) return "引用列表不完整";
  return "";
}

export function StatusBar({ status, preview, onIndexAction, previewStatus, searchBusy }: {
  status: CoreStatus;
  preview: RepositoryView;
  onIndexAction(action: MetadataIndexAction): void;
  previewStatus?: string;
  searchBusy?: boolean;
}): React.JSX.Element {
  const indexSupported = status.state === "ready" && status.core.capabilities.includes("metadataIndex");
  const previewText = previewStatus ?? previewLabel(preview);
  return <footer className="flex min-h-7 shrink-0 flex-wrap items-center gap-[18px] border-t border-line px-4 text-xs text-fg3">
    <span className="flex items-center gap-1.5" title={status.state === "ready" ? `${status.core.coreVersion} · PID ${status.core.pid}` : undefined}>
      <span aria-hidden="true" className={cn("size-[7px] rounded-full", status.state === "ready" ? "bg-ok" : status.state === "error" ? "bg-bad" : "bg-line2")} />
      <span>{coreLabel(status)}</span>
    </span>
    <span>只读</span>
      <span data-testid="preview-state" data-state={preview.opening !== null ? "loading" : preview.state} aria-live="polite" className={previewText ? undefined : "hidden"}>{previewText}</span>
    {preview.session ? <MetadataIndexStatusControl view={preview} supported={indexSupported} onAction={onIndexAction} interactionBusy={Boolean(searchBusy)} /> : null}
  </footer>;
}

function metadataIndexLabel(status: MetadataIndexStatus | null, loading: boolean, supported: boolean): string {
  if (!supported) return "索引不可用";
  if (!status) return loading ? "正在读取索引状态…" : "索引状态未知";
  const processed = status.coverage.processed;
  switch (status.state) {
    case "idle": return "索引等待中";
    case "queued": return `索引排队中 · 已处理 ${processed} 条`;
    case "running": return `索引中 · 已处理 ${processed} 条`;
    case "paused": return `索引已暂停 · 已处理 ${processed} 条`;
    case "cancelled": return `索引已取消 · 已处理 ${processed} 条`;
    case "complete": return `当前范围已完成 · ${processed} 条`;
    case "quotaLimited": return `已到缓存上限 · 已处理 ${processed} 条`;
    case "unavailable": return "索引不可用 · 历史仍可浏览";
    case "failed": return "索引失败 · 历史仍可浏览";
  }
}

function MetadataIndexStatusControl({ view, supported, onAction, interactionBusy }: {
  view: RepositoryView;
  supported: boolean;
  onAction(action: MetadataIndexAction): void;
  interactionBusy: boolean;
}): React.JSX.Element {
  const status = view.metadataIndex;
  const actionLoading = view.metadataIndexAction !== null;
  const busy = interactionBusy || !isMetadataIndexRequestIdle(view) || view.metadataIndexLoading || actionLoading;
  const label = metadataIndexLabel(status, view.metadataIndexLoading, supported);
  const button = (action: MetadataIndexAction, text: string) => <Button key={action} type="button" variant="ghost" size="sm"
    className="h-7 justify-start px-2 text-xs" data-testid={`index-action-${action}`} disabled={!supported || busy}
    onClick={() => onAction(action)}>{text}</Button>;
  const error = view.metadataIndexError ?? (status?.error ? { code: status.error.code, message: status.error.message } : null);
  return <Popover>
    <PopoverTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-fg3" data-testid="index-status-trigger"
        aria-label={`元数据索引：${label}`} title={status ? `磁盘 ${status.diskBytes} 字节 · 配额 ${status.quotaBytes} 字节` : undefined}>
        {busy ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
        <span>{label}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-64 p-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-fg">元数据索引</span>
        <span data-testid="index-status-label" className="text-xs text-fg2">{label}</span>
        {status ? <span className="text-[11px] text-fg3">已提交 {status.coverage.processed} 条 · 磁盘 {status.diskBytes} / {status.quotaBytes} 字节</span> : null}
        {error ? <p data-testid="index-error" className="m-0 text-xs text-bad">{errorTitle(error.code)}：{error.message}。历史仍可浏览。</p> : null}
        {!supported ? <p className="m-0 text-xs text-bad">当前核心不支持元数据索引。历史仍可浏览。</p> : null}
        <div className="mt-1 flex flex-col gap-0.5">
          {status?.state === "running" || status?.state === "queued" ? button("pause", "暂停索引") : null}
          {status?.state === "paused" || status?.state === "cancelled" || status?.state === "idle" ? button("resume", "继续索引") : null}
          {status && ["queued", "running", "paused"].includes(status.state) ? button("cancel", "取消索引") : null}
          {button("rebuild", "重建此仓库索引")}
        </div>
      </div>
    </PopoverContent>
  </Popover>;
}
