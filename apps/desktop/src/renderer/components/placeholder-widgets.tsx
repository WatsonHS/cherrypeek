import * as React from "react";
import { ChevronDown, ListFilter, Search } from "lucide-react";
import { PlaceholderTag } from "./placeholder.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

/* Top-bar and list-header widgets whose backends are not implemented yet. All content is sample data. */

export function SearchPlaceholder(): React.JSX.Element {
  return <div className="flex min-w-[200px] flex-[0_1_280px] items-center gap-2">
    <label className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-lg bg-sunken px-2.5 text-fg3" title="元数据搜索尚未接入（P1-06）">
      <Search className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <span className="sr-only">搜索提交消息</span>
      <input disabled placeholder="搜索提交消息" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg3" />
      <PlaceholderTag task="P1-06" />
    </label>
    <Button variant="ghost" size="icon" aria-label="筛选（尚未接入）" disabled><ListFilter className="size-4" strokeWidth={1.75} /></Button>
  </div>;
}

const SAMPLE_UPDATES = [
  { type: "快进", tone: "bg-ok-bg text-ok", ref: "main", detail: "新增 3 个提交" },
  { type: "改写", tone: "bg-warn text-panel", ref: "agent/p0-04-reader", detail: "amend：1 个提交被替换" },
  { type: "新建", tone: "text-accent-fg shadow-[inset_0_0_0_1px_var(--accent)]", ref: "agent/fix-index-quota", detail: "2 个提交" },
  { type: "删除", tone: "bg-sunken text-fg2", ref: "agent/fix-graph-lanes", detail: "内容已在 origin/main" },
];

export function UpdatesPlaceholder(): React.JSX.Element {
  return <div role="status" className="flex h-8 items-center gap-1 rounded-2xl bg-warn-bg pr-1.5 pl-1 text-[13px] text-warn">
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex h-7 items-center gap-1.5 rounded-xl px-2 hover:bg-warn/10">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warn" />有 4 处更新<PlaceholderTag task="P3-03" /><ChevronDown className="size-3.5" strokeWidth={1.75} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-[440px] flex-col p-0">
        <div className="flex flex-col gap-1 border-b border-line px-4 py-3">
          <span className="flex items-center gap-2 font-semibold">仓库有 4 处更新 <PlaceholderTag task="P3-03" /></span>
          <span className="text-xs text-fg3">示例数据。更新检测接入后，这里按引用列出快进、改写、新建和删除。</span>
        </div>
        <div className="flex flex-col">
          {SAMPLE_UPDATES.map(item => <div key={item.ref} className="flex items-center gap-2.5 border-b border-line px-4 py-3 last:border-b-0">
            <span className={`inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-semibold ${item.tone}`}>{item.type}</span>
            <span className="min-w-0 truncate font-semibold">{item.ref}</span>
            <span className="ml-auto shrink-0 text-xs text-fg3">{item.detail}</span>
          </div>)}
        </div>
        <div className="border-t border-line bg-bg p-3"><Button className="w-full" disabled>刷新到最新状态</Button></div>
      </PopoverContent>
    </Popover>
  </div>;
}

const SAMPLE_DAYS = [2, 11, 14, 16, 25, 9, 9];

export function ActivityPlaceholder(): React.JSX.Element {
  const max = Math.max(...SAMPLE_DAYS);
  return <Popover>
    <PopoverTrigger asChild>
      <button type="button" aria-label="近期活动（占位）" className="flex h-8 items-center gap-2 rounded-lg px-2 text-xs text-fg2 hover:bg-hover">
        <span aria-hidden="true" className="flex h-3.5 items-end gap-0.5">
          {SAMPLE_DAYS.map((value, index) => <span key={index} className={index === SAMPLE_DAYS.length - 1 ? "w-1 rounded-[1px] bg-accent" : "w-1 rounded-[1px] bg-line2"}
            style={{ height: `${Math.max(2, (value / max) * 14)}px` }} />)}
        </span>
        <span>近期活动</span>
      </button>
    </PopoverTrigger>
    <PopoverContent className="flex w-[400px] flex-col gap-4 p-4">
      <div className="flex items-center gap-2"><span className="font-semibold">近期活动</span><PlaceholderTag task="P3-02" /></div>
      <p className="m-0 text-xs text-fg3">示例数据。统计接入后，按当前浏览范围和筛选条件计算，按完整 OID 去重。</p>
      <div className="flex items-baseline gap-2"><span className="text-4xl leading-none font-semibold tracking-[-0.02em] tabular-nums">86</span><span className="text-[12.5px] text-fg2">个提交 · 近 7 天</span></div>
      <div className="flex h-32 items-end gap-1 border-b border-line2">
        {SAMPLE_DAYS.map((value, index) => <div key={index} className="flex flex-1 flex-col items-center justify-end gap-1">
          <span className="text-[11px] text-fg2 tabular-nums">{value}</span>
          <span className={index === SAMPLE_DAYS.length - 1 ? "w-3/5 rounded-t bg-accent" : "w-3/5 rounded-t bg-(--l0)/60"} style={{ height: `${(value / max) * 96}px` }} />
        </div>)}
      </div>
      <div className="flex gap-1.5"><Badge size="sm">今天</Badge><Badge size="sm" variant="browse">近 7 天</Badge><Badge size="sm">自定义…</Badge></div>
    </PopoverContent>
  </Popover>;
}
