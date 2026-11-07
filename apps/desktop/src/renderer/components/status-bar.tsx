import * as React from "react";
import type { CoreStatus } from "../../../../../packages/protocol/src/core-status.js";
import type { RepositoryView } from "../lib/repository-session-store.js";
import { zoneLabel } from "../lib/format.js";
import { cn } from "../lib/utils.js";

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
  if (preview.repository?.headOid === null || preview.commits.length === 0) return "当前 HEAD 没有提交";
  const refsWarning = preview.refsTruncated ? " · 引用列表不完整" : "";
  if (preview.pageOffset !== null && preview.hasMore) return `已显示第 ${preview.pageOffset + 1}–${preview.pageOffset + preview.commits.length} 条，仍有更多${refsWarning}`;
  if (preview.pageOffset !== null) return `当前页第 ${preview.pageOffset + 1}–${preview.pageOffset + preview.commits.length} 条${refsWarning}`;
  if (preview.refsTruncated) return "首屏已加载 · 引用列表不完整";
  return "首屏已加载";
}

export function StatusBar({ status, preview }: { status: CoreStatus; preview: RepositoryView }): React.JSX.Element {
  return <footer className="flex min-h-7 shrink-0 flex-wrap items-center gap-[18px] border-t border-line px-4 text-xs text-fg3">
    <span className="flex items-center gap-1.5" title={status.state === "ready" ? `${status.core.coreVersion} · PID ${status.core.pid}` : undefined}>
      <span aria-hidden="true" className={cn("size-[7px] rounded-full", status.state === "ready" ? "bg-ok" : status.state === "error" ? "bg-bad" : "bg-line2")} />
      <span>{coreLabel(status)}</span>
    </span>
    <span>只读</span>
    <span data-testid="preview-state" data-state={preview.opening !== null ? "loading" : preview.state} aria-live="polite">{previewLabel(preview)}</span>
    <span className="flex-1" />
    <span>提交时间 · {zoneLabel()}</span>
  </footer>;
}
