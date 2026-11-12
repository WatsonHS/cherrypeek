import * as React from "react";
import { LoaderCircle } from "lucide-react";
import type { GitPath } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { StatsSlot } from "../lib/stats-store.js";
import { cn } from "../lib/utils.js";
import { PlaceholderTag } from "./placeholder.js";
import { Button } from "./ui/button.js";

/*
 * Small building blocks of the statistics page. Charts are plain divs; every chart has a text alternative
 * (role="img" + aria-label, or real text). Repository-derived strings are only ever rendered as text nodes.
 */

/** Chart card. With `task` the card is a placeholder: dashed border and a visible "占位 · task" tag. */
export function StatsCard({ title, hint, task, label, className, coverage, children }: {
  title: string;
  hint?: React.ReactNode;
  task?: string;
  /** Index coverage of the numbers on the card; incomplete coverage shows the "部分" tag. */
  coverage?: { complete: boolean; processed: number };
  label?: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return <section aria-label={task ? `${label ?? title}（占位）` : label ?? title} data-placeholder={task}
    className={cn("flex min-w-0 flex-col gap-3 rounded-xl border bg-panel px-[18px] py-4", task ? "border-dashed border-line2" : "border-line", className)}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 className="m-0 flex items-center gap-2 text-xs font-semibold text-fg3">{title}{task ? <PlaceholderTag task={task} /> : null}{coverage ? <PartialTag coverage={coverage} /> : null}</h2>
      {hint ? <span className="min-w-0 text-xs text-fg3">{hint}</span> : null}
    </div>
    {children}
  </section>;
}

/** Big-number tile ("提交数 342"). */
export function StatTile({ title, value, unit, note, task }: { title: string; value: string; unit?: string; note: React.ReactNode; task?: string }): React.JSX.Element {
  return <section aria-label={task ? `${title}（占位）` : title} data-placeholder={task}
    className={cn("flex min-w-0 flex-col gap-1 rounded-xl border bg-panel px-[18px] py-4", task ? "border-dashed border-line2" : "border-line")}>
    <h2 className="m-0 flex items-center gap-2 text-xs font-semibold text-fg3">{title}{task ? <PlaceholderTag task={task} /> : null}</h2>
    <div className="text-4xl leading-[1.1] font-semibold tracking-[-0.02em] tabular-nums">
      {value}{unit ? <span className="ml-1.5 text-[15px] font-normal text-fg3">{unit}</span> : null}
    </div>
    <div className="text-xs text-fg3 tabular-nums">{note}</div>
  </section>;
}

export function Segmented<T extends string>({ label, value, options, onChange, small, disabled }: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange(value: T): void;
  small?: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  return <div role="group" aria-label={label} className="flex shrink-0 gap-0.5 rounded-lg bg-sunken p-0.5">
    {options.map(option => <button key={option.id} type="button" aria-pressed={value === option.id} disabled={disabled} onClick={() => onChange(option.id)}
      className={cn("rounded-md px-2.5 text-[12.5px] whitespace-nowrap text-fg2 hover:text-fg disabled:opacity-55 disabled:hover:text-fg2",
        small ? "h-[22px] text-xs" : "h-[26px]",
        "aria-pressed:bg-panel aria-pressed:font-medium aria-pressed:text-fg aria-pressed:shadow-[0_1px_2px_rgba(20,20,18,.08)]")}>{option.label}</button>)}
  </div>;
}

/** Label, proportional bar and count. */
export function BarRow({ label, value, max, display, mono, labelWidth = 112, valueWidth = 36 }: {
  label: string;
  value: number;
  max: number;
  display?: string;
  mono?: boolean;
  labelWidth?: number;
  valueWidth?: number;
}): React.JSX.Element {
  return <div className="grid items-center gap-2.5 text-[13px]" style={{ gridTemplateColumns: `${labelWidth}px minmax(0, 1fr) ${valueWidth}px` }}>
    <span title={label} className={cn("truncate", mono && "font-mono text-xs text-fg2")}>{label}</span>
    <div className="h-2.5 rounded-[5px] bg-sunken"><div className="h-2.5 rounded-[5px] bg-bar" style={{ width: `${max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round(value / max * 100)) : 0}%` }} /></div>
    <span className="text-right text-fg2 tabular-nums">{display ?? String(value)}</span>
  </div>;
}

/** Plain commit-count bar chart (no interaction). */
export function CountBars({ items, label, height = 150, highlightLast }: {
  items: { label: string; count: number }[];
  label: string;
  height?: number;
  highlightLast?: boolean;
}): React.JSX.Element {
  const max = Math.max(1, ...items.map(item => item.count));
  return <div role="img" aria-label={label} className="flex items-end gap-[3px] border-b border-line" style={{ height }}>
    {items.map((item, index) => <div key={index} title={`${item.label} · ${item.count} 个提交`}
      className={cn("min-w-0 flex-1 rounded-t", highlightLast && index === items.length - 1 ? "bg-accent" : "bg-bar")}
      style={{ height: item.count ? Math.max(3, Math.round(item.count / max * (height - 10))) : 0 }} />)}
  </div>;
}

/** Added lines upward, deleted lines downward, on one shared axis. */
export function SignedBars({ items, label, upHeight = 100, downHeight = 58 }: {
  items: { label: string; add: number; del: number }[];
  label: string;
  upHeight?: number;
  downHeight?: number;
}): React.JSX.Element {
  const maxAdd = Math.max(1, ...items.map(item => item.add));
  const maxDel = Math.max(1, ...items.map(item => item.del));
  return <div role="img" aria-label={label} className="flex gap-[3px]" style={{ height: upHeight + downHeight + 2 }}>
    {items.map((item, index) => <div key={index} title={`${item.label} · +${item.add} −${item.del}`} className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-end" style={{ height: upHeight }}><div className="w-full rounded-t bg-chart-add" style={{ height: Math.round(item.add / maxAdd * (upHeight - 4)) }} /></div>
      <div className="h-0.5 bg-line" />
      <div style={{ height: downHeight }}><div className="w-full rounded-b bg-chart-del" style={{ height: Math.round(item.del / maxDel * (downHeight - 4)) }} /></div>
    </div>)}
  </div>;
}

export function AddDelLegend(): React.JSX.Element {
  return <span className="flex items-center gap-3">
    <span className="flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-xs bg-chart-add" />增加（向上）</span>
    <span className="flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-xs bg-chart-del" />删除（向下）</span>
  </span>;
}

/** Cell background: the accent at a given strength, so the same code works in both themes. */
export function accentAlpha(alpha: number): React.CSSProperties {
  return { backgroundColor: `color-mix(in srgb, var(--accent) ${Math.round(alpha * 100)}%, transparent)` };
}

export function SegmentBar({ parts, label }: { parts: readonly { name: string; percent: number; tone: string }[]; label: string }): React.JSX.Element {
  return <div role="img" aria-label={label} className="flex gap-0.5">
    {parts.filter(part => part.percent > 0).map((part, index, list) => <div key={part.name} style={{ width: `${part.percent}%` }}
      className={cn("h-3", part.tone, index === 0 && "rounded-l", index === list.length - 1 && "rounded-r")} />)}
  </div>;
}

export function PathText({ path }: { path: string }): React.JSX.Element {
  return <span title={path} className="truncate text-left font-mono text-xs [direction:rtl]">{path}</span>;
}

export function TableHead({ columns, children }: { columns: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="grid gap-2.5 text-[11.5px] text-fg3" style={{ gridTemplateColumns: columns }}>{children}</div>;
}

export const formatCount = (value: number): string => value.toLocaleString("en-US");

const pad = (value: number) => String(value).padStart(2, "0");
export function formatDateTime(unix: number): string {
  const date = new Date(unix * 1_000);
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function formatClock(unix: number): string {
  const date = new Date(unix * 1_000);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function formatDate(unix: number): string {
  const date = new Date(unix * 1_000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Shown on a card whose numbers cover only part of the history: the processed count, never a percentage. */
export function PartialTag({ coverage }: { coverage: { complete: boolean; processed: number } }): React.JSX.Element | null {
  if (coverage.complete) return null;
  return <span data-testid="stats-partial" className="inline-flex h-[18px] items-center rounded-[5px] bg-warn-bg px-1.5 text-[11px] font-medium whitespace-nowrap text-warn">
    部分 · 已处理 {formatCount(coverage.processed)} 个提交
  </span>;
}

/** Path text; a path that is not valid UTF-8 is marked, its shown text being a lossy rendering. */
export function GitPathText({ path, className }: { path: GitPath; className?: string }): React.JSX.Element {
  const text = path.display === "" ? "（仓库根目录）" : path.display;
  return <span title={path.textLossy ? `${text}（路径含有非 UTF-8 字节）` : text} className={cn("min-w-0 truncate font-mono text-xs", className)}>
    {text}{path.textLossy ? <span className="ml-1 font-sans text-warn">非 UTF-8</span> : null}
  </span>;
}

export function truncationNote(truncated: boolean, shown: number): string | null {
  return truncated ? `只显示前 ${shown} 项，结果已截断。` : null;
}

export function errorText(error: { code: string; message: string }): string {
  if (error.code === "INDEX_UNAVAILABLE") return "文件统计仍在建立索引，完成后会自动可用；索引进度见底部状态栏。";
  if (error.code === "RESOURCE_LIMIT") return "这个范围太大，无法计算。缩小时间范围或加上筛选后再试，不显示不完整的排名。";
  if (error.code === "BUSY") return error.message;
  return `统计失败：${error.message}`;
}

/**
 * Loading, error and "updating" states of one section's request. Without a result the section shows the
 * state; with one, the result stays (dimmed while a newer read runs) and a status line says what happens.
 */
export function SlotGate<T>({ slot, onRetry, noun, children }: {
  slot: StatsSlot<T>;
  onRetry(): void;
  noun: string;
  children(value: T): React.ReactNode;
}): React.JSX.Element {
  const { value, loading, updating, error } = slot;
  const status = error
    ? <div role="alert" data-testid="stats-error" className="flex flex-wrap items-center gap-2 text-xs text-bad">
      <span className="min-w-0">{errorText(error)}</span>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={loading}>重试</Button>
    </div>
    : updating
      ? <span role="status" data-testid="stats-updating" className="inline-flex items-center gap-1 text-xs text-fg3">
        <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />更新中…（统计让位给正在进行的读取）
      </span>
      : loading
        ? <span role="status" className="inline-flex items-center gap-1 text-xs text-fg3">
          <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />{value ? `正在更新${noun}…` : `正在统计${noun}…`}
        </span>
        : null;
  if (!value) return <div className="flex min-h-[120px] items-center justify-center rounded-xl border border-dashed border-line2 px-4 py-8">{status ?? <span className="text-xs text-fg3">等待统计…</span>}</div>;
  return <div className="flex min-w-0 flex-col gap-4">
    {status}
    <div aria-busy={loading || updating} className={cn("flex min-w-0 flex-col gap-4", (loading || updating) && "opacity-70")}>{children(value)}</div>
  </div>;
}

/** Cell strength 0..1 of a value against the largest one. */
export function share(value: number, max: number): number {
  return max > 0 ? value / max : 0;
}

/** Bar chart of per-bucket values; buckets are buttons when `onPick` is given and there are few enough. */
export function BucketBars({ items, label, onPick, height = 150, empty }: {
  items: { key: number; label: string; value: number; title: string }[];
  label: string;
  onPick?(key: number): void;
  height?: number;
  empty: string;
}): React.JSX.Element {
  const max = Math.max(1, ...items.map(item => item.value));
  if (items.every(item => item.value === 0)) return <p className="m-0 text-xs text-fg3">{empty}</p>;
  const interactive = Boolean(onPick) && items.length <= 400;
  const axis = items.length <= 1 ? items : [items[0]!, items[Math.floor(items.length / 2)]!, items[items.length - 1]!];
  return <div className="flex flex-col gap-1.5">
    <div role="group" aria-label={label} className="flex items-end gap-[2px] border-b border-line" style={{ height }}>
      {items.map(item => {
        const bar = <span className={cn("block w-full rounded-t bg-bar", interactive && "group-enabled:group-hover:bg-accent")}
          style={{ height: item.value ? Math.max(3, Math.round(item.value / max * (height - 10))) : 0 }} />;
        return interactive
          ? <button key={item.key} type="button" disabled={item.value === 0} title={item.title} aria-label={`${item.title}，在提交页筛选`} onClick={() => onPick!(item.key)}
            className="group flex h-full min-w-0 flex-1 items-end rounded-t focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-default">{bar}</button>
          : <div key={item.key} title={item.title} className="flex h-full min-w-0 flex-1 items-end">{bar}</div>;
      })}
    </div>
    <div aria-hidden="true" className="flex justify-between text-xs text-fg3 tabular-nums">{axis.map((item, index) => <span key={index}>{item.label}</span>)}</div>
  </div>;
}

/** What a click on a chart element does on the commits page (the page maps these onto the shared search query). */
export interface StatsActions {
  filterTime(fromUnix: number, toUnix: number): void;
  filterAuthor(identity: { name: string; email: string }): void;
  filterPath(kind: "file" | "directory", rawHex: string): void;
  showCommit(oid: string): void;
  openEvolution(path: GitPath): void;
}
