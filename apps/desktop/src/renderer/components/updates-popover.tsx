import * as React from "react";
import { ChevronDown } from "lucide-react";
import type { RefSnapshotDiff, RepositoryObservation } from "../../../../../packages/protocol/src/generated/server-message.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

const changeLabel: Record<RefSnapshotDiff["changes"][number]["change"], string> = {
  fastForward: "快进", rewritten: "改写", created: "新建", deleted: "删除", unknown: "状态未知",
};

export function UpdatesPopover({ observation, diff, loading, error, onLoad, onObserve, onCancel, onRefresh }: {
  observation: RepositoryObservation | null;
  diff: RefSnapshotDiff | null;
  loading: boolean;
  error: string | null;
  onLoad(): void;
  onObserve(): void;
  onCancel(): void;
  onRefresh(): void;
}): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const previousGeneration = React.useRef<string | null>(observation?.generation ?? null);
  const count = observation?.changeCount ?? 0;
  React.useEffect(() => {
    const generation = observation?.generation ?? null;
    const changed = previousGeneration.current !== generation;
    previousGeneration.current = generation;
    if (open && changed && generation) onLoad();
  }, [observation?.generation, open, onLoad]);
  const incomplete = Boolean(observation?.refsTruncated || observation?.worktreesTruncated);
  if (!open && !count && !incomplete && !error) return null;
  const triggerLabel = error ? "检查更新失败"
    : count ? `有 ${count} 处更新`
      : incomplete ? "更新检查不完整" : "无引用变化";
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (next) observation ? onLoad() : onObserve(); else onCancel(); }}>
    <PopoverTrigger asChild><button type="button" title={error ? `检查更新失败：${error}` : observation ? count ? `仓库有 ${count} 处更新` : incomplete ? "更新检查不完整" : "最近检查：没有发现引用变化" : "检查更新"}
      data-testid="updates-trigger" aria-label={triggerLabel}
      className={count || incomplete
        ? "topbar-updates flex h-[30px] shrink-0 items-center gap-1.5 rounded-[15px] bg-warn-bg px-2.5 text-[12.5px] whitespace-nowrap text-warn hover:bg-warn-bg/80"
        : "topbar-updates flex h-8 shrink-0 items-center gap-1 rounded-xl px-1.5 text-xs text-fg2 hover:bg-hover"}>
      <span aria-hidden="true" className={`shrink-0 rounded-full ${count || incomplete ? "size-[7px] bg-warn" : error ? "size-1.5 bg-bad" : "size-1.5 bg-line2"}`} />
      <span className="topbar-updates-label">{triggerLabel}</span>
      {count || incomplete ? <ChevronDown className="size-3 shrink-0" strokeWidth={1.75} aria-hidden="true" /> : null}
    </button></PopoverTrigger>
    <PopoverContent align="end" className="flex w-[440px] flex-col p-0" data-testid="updates-popover">
      <div className="flex flex-col gap-1 border-b border-line px-4 py-3">
        <span className="font-semibold">仓库引用变化</span>
        <span className="text-xs text-fg3">{observation
          ? `最近检查 ${new Date(observation.observedAtUnixMs).toLocaleString()} · ${count} 处变化${incomplete ? " · 观察列表已截断" : ""}`
          : "尚未读取当前仓库的最新引用状态。"}</span>
      </div>
      {error ? <p role="alert" className="m-0 px-4 py-3 text-xs text-bad">{error}</p> : null}
      {loading ? <p role="status" className="m-0 px-4 py-3 text-xs text-fg3">正在比较引用快照…</p> : null}
      {diff ? <div className="max-h-[360px] overflow-auto">
        {diff.changes.map((change, index) => <div key={`${change.kind}:${change.name}:${index}`} data-testid="update-ref-row"
          className="flex items-start gap-2.5 border-b border-line px-4 py-3 last:border-b-0">
          <span className="inline-flex h-5 shrink-0 items-center rounded-md bg-sunken px-1.5 text-[11px] font-semibold text-fg2">{changeLabel[change.change]}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate font-semibold" title={change.name}>{change.name}</span>
            <span className="text-xs text-fg3">
              {change.change === "fastForward" ? `新增 ${change.addedCount ?? "未知"} 个提交${change.addedCommitsTruncated ? " · 摘要已截断" : ""}`
                : change.change === "rewritten" ? `替换 ${change.replacedCount ?? "未知"} 个提交 · ${change.oldOid?.slice(0, 10) ?? "无"} → ${change.newOid?.slice(0, 10) ?? "无"}`
                  : change.change === "deleted" ? change.deletedMergeStatus === "merged" ? "已合入浏览快照中的基准" : "未确认已合入；合入状态未知"
                    : change.change === "created" ? "新引用" : "无法确定变化关系"}
            </span>
            {change.addedCommits.length ? <span className="text-xs text-fg3">{change.addedCommits.map(commit => commit.summary).join(" · ")}</span> : null}
          </div>
        </div>)}
        {!diff.changes.length ? <p className="m-0 px-4 py-4 text-xs text-fg3">没有发现引用变化。</p> : null}
        {!diff.complete || diff.truncated ? <p className="m-0 px-4 py-2 text-xs text-warn">变化列表不完整或已截断。</p> : null}
        {diff.worktreesChanged ? <p className="m-0 px-4 py-2 text-xs text-fg3">worktree 状态也有变化。</p> : null}
      </div> : null}
      <div className="flex gap-2 border-t border-line bg-bg p-3">
        <Button variant="outline" size="sm" data-testid="updates-refresh" className="flex-1" onClick={onRefresh}>刷新到最新状态</Button>
        <Button variant="ghost" size="sm" disabled={loading || !observation} onClick={onLoad}>{loading ? "比较中…" : "重新比较"}</Button>
      </div>
    </PopoverContent>
  </Popover>;
}
