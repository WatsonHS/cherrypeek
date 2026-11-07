import * as React from "react";
import { LoaderCircle } from "lucide-react";
import type { ActivityStats, SearchIdentity } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { SearchQuery, SearchTimeField } from "../../../../../packages/protocol/src/generated/client-message.js";
import { localCalendarRange } from "../lib/search-date.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

export function ActivityStatsPopover({ query, stats, loading, error, onLoad, onQueryChange, onAddAuthor }: {
  query: SearchQuery;
  stats: ActivityStats | null;
  loading: boolean;
  error: string | null;
  onLoad(): void;
  onQueryChange(query: SearchQuery): void;
  onAddAuthor(identity: SearchIdentity): void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const days = stats?.days.slice(-14) ?? [];
  const max = Math.max(1, ...days.map(day => day.count));
  const total = stats ? `${stats.coverage.complete ? "" : "~"}${stats.matchedCount}` : null;
  const loadingLabel = stats ? "正在更新活动统计" : "正在统计活动";
  const countLabel = stats
    ? `${stats.coverage.complete ? "当前筛选匹配提交" : "当前筛选部分统计，已找到提交"}：${total}`
    : "当前范围活动统计";
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><button type="button" aria-busy={loading}
      title={`${loading ? `${loadingLabel}；` : ""}${countLabel}`}
      aria-label={`${countLabel}${loading ? `；${loadingLabel}` : ""}`} data-testid="activity-trigger"
      className="topbar-activity flex h-8 shrink-0 items-center gap-1 rounded-lg px-1.5 text-xs text-fg2 hover:bg-hover">
      <span className="text-[11px]">活动</span>
      {stats || !loading ? <span data-testid="activity-total" className="font-mono tabular-nums">{total ?? "—"}</span> : null}
      {loading ? <span role="status" className="inline-flex shrink-0 items-center gap-1 text-[10px] text-fg3">
        <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />{stats ? "更新中…" : "统计中…"}
      </span> : null}
    </button></PopoverTrigger>
    <PopoverContent align="start" className="flex w-[400px] flex-col gap-3 p-4" data-testid="activity-popover">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">当前筛选活动</span>
        <select aria-label="活动时间口径" data-testid="activity-time-field" value={query.timeField}
          onChange={event => onQueryChange({ ...query, timeField: event.currentTarget.value as SearchTimeField })}
          className="h-7 rounded-md border border-line bg-bg px-2 text-xs text-fg">
          <option value="author">Author 时间</option><option value="committer">Committer 时间</option>
        </select>
      </div>
      <p className="m-0 text-xs text-fg3">统计遵循当前浏览范围和全部筛选条件；日期按 {stats?.timeZone ?? query.timeZone} 分桶。</p>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl leading-none font-semibold tabular-nums">{stats?.matchedCount ?? "—"}</span>
        <span className="text-xs text-fg2">{stats?.coverage.complete ? "匹配提交" : stats ? `已找到 · 部分统计（已扫描 ${stats.coverage.processed} 条）` : "匹配提交"}</span>
        {loading ? <span role="status" className="ml-auto text-xs text-fg3">正在统计…</span> : null}
      </div>
      {error ? <p role="alert" className="m-0 text-xs text-bad">{error}</p> : null}
      {stats && days.length ? <div className="flex flex-col gap-1">
        <span className="text-[11px] text-fg3">最近 {days.length} 个活动日期</span>
        <div className="flex h-28 items-end gap-1 border-b border-line2" aria-label="最近活动日期">
        {days.map(item => {
          const date = new Date(`${item.day}T00:00:00`);
          return <button key={item.day} type="button" data-testid={`activity-day-${item.day}`} title={`${item.day} · ${item.count} 个提交`}
            aria-label={`${item.day}，${item.count} 个提交，筛选此日`} onClick={() => {
              const range = localCalendarRange(date, date);
              onQueryChange({ ...query, fromTimestamp: range.fromTimestamp, toTimestamp: range.toTimestamp });
            }} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1 text-[10px] text-fg3 hover:text-fg">
            <span className="tabular-nums">{item.count}</span>
            <span className="w-3/5 min-h-0.5 rounded-t bg-accent" style={{ height: `${Math.max(2, item.count / max * 64)}px` }} />
            <span>{item.day.slice(5)}</span>
          </button>;
        })}
        </div></div> : null}
      {stats?.daysTruncated ? <p className="m-0 text-[11px] text-fg3">日期分布已截断。</p> : null}
      {stats ? <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-fg2">前 {Math.min(8, stats.authors.length)} 个 Author 身份</span>
        {stats.authors.slice(0, 8).map(author => <Button key={`${author.name}\0${author.email}`} variant="ghost" size="sm" data-testid="activity-author"
          className="h-7 justify-between px-1.5 text-xs" onClick={() => onAddAuthor(author)}>
          <span className="min-w-0 truncate">{author.name || author.email || "（未知身份）"}{author.email && author.name ? ` · ${author.email}` : ""}</span>
          <span className="ml-2 tabular-nums text-fg3">{author.count}</span>
        </Button>)}
        {stats.authorsTruncated ? <span className="text-[11px] text-fg3">身份分布已截断。</span> : null}
      </div> : null}
      <Button variant="outline" size="sm" className="self-start" disabled={loading} onClick={onLoad}>{loading ? "统计中…" : "重新统计"}</Button>
    </PopoverContent>
  </Popover>;
}
