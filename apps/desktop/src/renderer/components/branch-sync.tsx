import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { syncTooltip, type SyncRowModel } from "../lib/operations.js";

/** `↓N` / `↑N` against the upstream, or the diverged / no-upstream tag. Facts from local refs; the tooltip says so. */
export function SyncTags({ model, lastFetchUnixMs }: { model: SyncRowModel; lastFetchUnixMs: number | null }): React.JSX.Element | null {
  const tooltip = syncTooltip(model.upstream, lastFetchUnixMs);
  if (model.action === "noUpstream") return <Badge size="sm" title="这个本地分支没有设置上游" data-testid="sync-no-upstream">没有上游</Badge>;
  if (model.action === "diverged") {
    return <Badge size="sm" variant="warn" title={tooltip} data-testid="sync-diverged">已分叉 ↑{model.ahead ?? 0} ↓{model.behind ?? 0}</Badge>;
  }
  if (!model.behind && !model.ahead) return null;
  return <span className="flex shrink-0 items-center gap-1" data-testid="sync-tags" title={tooltip}>
    {model.behind ? <Badge size="sm" variant="browse" className="tabular-nums">↓{model.behind}</Badge> : null}
    {model.ahead ? <Badge size="sm" className="tabular-nums">↑{model.ahead}</Badge> : null}
  </span>;
}

/** The row-end action: 更新 when it can fast-forward, 交给 Agent when diverged. Nothing otherwise. */
export function SyncAction({ model, name, busy, running, onUpdate, onHandoff }: {
  model: SyncRowModel;
  name: string;
  /** Another operation is running: the control is disabled. */
  busy: boolean;
  /** This control's own operation is running. */
  running: boolean;
  onUpdate(): void;
  onHandoff(): void;
}): React.JSX.Element | null {
  if (model.action === "update") {
    return <Button variant="soft" size="sm" data-testid="branch-update" className="h-7 shrink-0 px-2 text-xs" disabled={busy}
      aria-label={`更新 ${name}（快进到上游）`} title="快进到上游；当前分支会先 fetch"
      onClick={onUpdate}>
      {running ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" strokeWidth={1.75} aria-hidden="true" /> : null}更新
    </Button>;
  }
  if (model.action === "diverged") {
    return <Button variant="ghost" size="sm" data-testid="branch-diverged-handoff" className="h-7 shrink-0 px-2 text-xs" disabled={busy}
      aria-label={`交给 Agent 同步已分叉的分支 ${name}`} title="已分叉，不能快进；交给 Agent 同步"
      onClick={onHandoff}>
      {running ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" strokeWidth={1.75} aria-hidden="true" /> : null}交给 Agent
    </Button>;
  }
  return null;
}
