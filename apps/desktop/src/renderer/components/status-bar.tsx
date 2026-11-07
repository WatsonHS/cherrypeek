import * as React from "react";
import type { CoreStatus } from "../../../../../packages/protocol/src/core-status.js";
import type { RepositoryPreviewState } from "../../../../../packages/protocol/src/repository-preview.js";
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

export function previewLabel(preview: RepositoryPreviewState): string {
  if (preview.state === "loading") return "正在读取仓库…";
  if (preview.state === "error") return preview.commits.length ? "读取失败 · 结果不完整" : "读取失败";
  if (preview.state === "cancelled") return preview.commits.length ? "已取消 · 结果不完整" : "已取消";
  if (preview.state === "idle") return "未打开仓库";
  if (preview.repository?.headOid === null || preview.commits.length === 0) return "当前 HEAD 没有提交";
  if (preview.hasMore) return `已显示前 ${preview.commits.length} 个提交`;
  if (preview.refsTruncated) return "首屏已加载 · 引用列表不完整";
  return "首屏已加载";
}

export function StatusBar({ status, preview }: { status: CoreStatus; preview: RepositoryPreviewState }): React.JSX.Element {
  return <footer className="flex min-h-7 shrink-0 flex-wrap items-center gap-[18px] border-t border-line px-4 text-xs text-fg3">
    <span className="flex items-center gap-1.5" title={status.state === "ready" ? `${status.core.coreVersion} · PID ${status.core.pid}` : undefined}>
      <span aria-hidden="true" className={cn("size-[7px] rounded-full", status.state === "ready" ? "bg-ok" : status.state === "error" ? "bg-bad" : "bg-line2")} />
      <span>{coreLabel(status)}</span>
    </span>
    <span>只读</span>
    <span data-testid="preview-state" data-state={preview.state} aria-live="polite">{previewLabel(preview)}</span>
    <span className="flex-1" />
    <span>提交时间 · {zoneLabel()}</span>
  </footer>;
}
