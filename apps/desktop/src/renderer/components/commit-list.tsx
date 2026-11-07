import * as React from "react";
import type { CommitSummary, RefInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositoryView } from "../lib/repository-session-store.js";
import { TriangleAlert } from "lucide-react";
import { clock, dayKey, dayLabel, parseGitTime, refTarget, shortRefName } from "../lib/format.js";
import { errorTitle } from "../lib/errors.js";
import { laneX, layoutGraph, MAX_VISIBLE_LANES, type GraphGeometry, type GraphRow } from "../lib/graph.js";
import { cn } from "../lib/utils.js";
import { IdentityAvatar } from "./identity-avatar.js";
import { ActivityPlaceholder } from "./placeholder-widgets.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Skeleton } from "./ui/skeleton.js";

const ROW: GraphGeometry = { rowHeight: 60, mid: 22, laneGap: 9, x0: 7 };
const DAY_ROW_HEIGHT = 34;

type ListEntry =
  | { kind: "day"; key: string; label: string; count: number; lanes: number[] }
  | { kind: "commit"; commit: CommitSummary; graph: GraphRow | undefined };

function buildEntries(commits: CommitSummary[], rows: Map<string, GraphRow>): ListEntry[] {
  const entries: ListEntry[] = [];
  const now = new Date();
  let current: Extract<ListEntry, { kind: "day" }> | undefined;
  let lanesAbove: number[] = [];
  for (const commit of commits) {
    const date = parseGitTime(commit.committer.timestamp);
    const key = date ? dayKey(date) : "unknown";
    if (!current || current.key !== key) {
      current = { kind: "day", key, label: date ? dayLabel(date, now) : "时间未知", count: 0, lanes: lanesAbove };
      entries.push(current);
    }
    current.count += 1;
    const graph = rows.get(commit.oid);
    entries.push({ kind: "commit", commit, graph });
    lanesAbove = graph?.activeBelow ?? [];
  }
  return entries;
}

export function refsByTarget(refs: RefInfo[]): Map<string, RefInfo[]> {
  const index = new Map<string, RefInfo[]>();
  for (const ref of refs) {
    const target = refTarget(ref);
    index.set(target, [...(index.get(target) ?? []), ref]);
  }
  return index;
}

export function CommitList({ preview, selectedOid, onSelect, onCancel, onRetry }: {
  preview: RepositoryView;
  selectedOid: string | undefined;
  onSelect(oid: string): void;
  onCancel(): Promise<void>;
  onRetry(): Promise<void>;
}): React.JSX.Element {
  const listRef = React.useRef<HTMLDivElement>(null);
  const layout = React.useMemo(() => layoutGraph(preview.commits, ROW), [preview.commits]);
  const entries = React.useMemo(() => buildEntries(preview.commits, layout.rows), [preview.commits, layout]);
  const refIndex = React.useMemo(() => refsByTarget(preview.refs), [preview.refs]);
  const visibleLanes = Math.min(Math.max(layout.laneCount, 1), MAX_VISIBLE_LANES);
  const graphWidth = laneX(visibleLanes - 1, ROW) + ROW.x0;
  const hiddenLanes = Math.max(0, layout.laneCount - MAX_VISIBLE_LANES);
  const headReference = preview.repository?.headReference ?? null;
  const headOid = preview.repository?.headOid ?? null;

  // Keep the selected row visible, whether it changed by keyboard, click or the refs picker.
  React.useEffect(() => {
    if (!selectedOid) return;
    document.getElementById(rowId(selectedOid))?.scrollIntoView({ block: "nearest" });
  }, [selectedOid]);

  const move = (delta: number | "first" | "last") => {
    const commits = preview.commits;
    if (!commits.length) return;
    const index = commits.findIndex(commit => commit.oid === selectedOid);
    const next = delta === "first" ? 0 : delta === "last" ? commits.length - 1 : Math.min(commits.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta));
    const oid = commits[next]!.oid;
    onSelect(oid);
    requestAnimationFrame(() => document.getElementById(rowId(oid))?.focus());
  };

  const loadingEmpty = preview.state === "loading" && preview.commits.length === 0;
  const finishedEmpty = preview.state === "ready" && preview.commits.length === 0;
  const interrupted = (preview.state === "error" || preview.state === "cancelled") && preview.commits.length > 0;

  return <nav aria-label="提交列表" className="flex min-h-0 min-w-[320px] flex-[0_1_400px] flex-col border-r border-line">
    <div className="flex h-[46px] shrink-0 items-center justify-between gap-2 pr-3.5 pl-1.5 text-xs text-fg3">
      <ActivityPlaceholder />
      <span className="flex items-center gap-2">
        {hiddenLanes ? <span title={`另有 ${hiddenLanes} 条分支线未画出`} className="rounded-full bg-sunken px-1.5 font-mono text-[11px] text-fg2">+{hiddenLanes}</span> : null}
        <span>HEAD 可达 · 拓扑顺序 · 已加载 {preview.commits.length}</span>
      </span>
    </div>

    {preview.error && preview.repository ? <div role="alert" className="mx-2 mb-2 flex items-start gap-2 rounded-[10px] border border-bad-line bg-bad-bg px-3 py-2.5 text-[13px]">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-bad" strokeWidth={1.75} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col"><span className="font-semibold text-bad">{errorTitle(preview.error.code)}</span><span className="break-words text-fg2">{preview.error.message} <code className="font-mono text-xs text-fg3">{preview.error.code}</code></span></span>
      {preview.session ? <Button variant="outline" size="sm" className="shrink-0" onClick={() => { void onRetry(); }}>重试</Button> : null}
    </div> : null}

    <div ref={listRef} role="listbox" aria-label="提交" className="min-h-0 flex-1 overflow-auto px-2 pb-6 outline-none"
      onKeyDown={event => {
        const keys: Record<string, number | "first" | "last"> = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8, Home: "first", End: "last" };
        const delta = keys[event.key];
        if (delta === undefined) return;
        event.preventDefault();
        move(delta);
      }}>
      {loadingEmpty ? <LoadingRows onCancel={onCancel} /> : null}
      {finishedEmpty ? <p className="m-0 px-3 py-10 text-center text-[13px] text-fg3">当前 HEAD 尚无提交。</p> : null}
      {entries.map((entry, position) => entry.kind === "day"
        ? <DayRow key={`day-${position}`} entry={entry} width={graphWidth} />
        : <CommitRow key={entry.commit.oid} commit={entry.commit} graph={entry.graph} graphWidth={graphWidth}
          refs={refIndex.get(entry.commit.oid) ?? []} headReference={headReference} headOid={headOid}
          selected={entry.commit.oid === selectedOid} onSelect={() => onSelect(entry.commit.oid)} />)}
      {preview.hasMore ? <p className="m-0 px-3 pt-4 text-center text-xs text-fg3">只读取了前 {preview.commits.length} 个提交，更早的提交暂不加载。</p> : null}
      {interrupted ? <p className="m-0 px-3 pt-4 text-center text-xs text-warn">读取没有完成，以上结果不完整。</p> : null}
    </div>
  </nav>;
}

function rowId(oid: string): string {
  return `commit-${oid}`;
}

function GraphLanes({ graph, width, height, lanes }: { graph?: GraphRow; width: number; height: number; lanes?: number[] }): React.JSX.Element {
  const visible = (lane: number) => lane < MAX_VISIBLE_LANES;
  return <svg width={width} height={height} aria-hidden="true" className="shrink-0">
    {lanes?.filter(visible).map(lane => <path key={lane} d={`M${laneX(lane, ROW)} 0V${height}`} style={{ stroke: `var(--l${lane % 6})`, strokeWidth: 1.5, fill: "none" }} />)}
    {graph?.paths.filter(path => visible(path.lane)).map((path, index) => <path key={index} d={path.d} style={{ stroke: `var(--l${path.lane % 6})`, strokeWidth: 1.5, fill: "none", strokeLinecap: "round" }} />)}
    {graph && visible(graph.lane) ? <circle cx={laneX(graph.lane, ROW)} cy={ROW.mid} r={graph.isMerge ? 3.5 : 3.5}
      style={graph.isMerge
        ? { fill: "var(--bg)", stroke: `var(--l${graph.lane % 6})`, strokeWidth: 1.5 }
        : { fill: `var(--l${graph.lane % 6})` }} /> : null}
  </svg>;
}

function DayRow({ entry, width }: { entry: Extract<ListEntry, { kind: "day" }>; width: number }): React.JSX.Element {
  return <div role="presentation" className="flex items-stretch gap-2 pr-3 pl-2" style={{ height: DAY_ROW_HEIGHT }}>
    <GraphLanes width={width} height={DAY_ROW_HEIGHT} lanes={entry.lanes} />
    <span className="flex flex-1 items-end justify-between pb-1.5 text-xs">
      <span className="font-semibold text-fg2">{entry.label}</span>
      <span className="text-fg3">{entry.count} 个</span>
    </span>
  </div>;
}

function CommitRow({ commit, graph, graphWidth, refs, headReference, headOid, selected, onSelect }: {
  commit: CommitSummary;
  graph: GraphRow | undefined;
  graphWidth: number;
  refs: RefInfo[];
  headReference: string | null;
  headOid: string | null;
  selected: boolean;
  onSelect(): void;
}): React.JSX.Element {
  const isMerge = commit.parents.length > 1;
  const date = parseGitTime(commit.committer.timestamp);
  return <div id={rowId(commit.oid)} role="option" aria-selected={selected} tabIndex={selected ? 0 : -1}
    data-testid="commit-row" data-oid={commit.oid}
    onClick={onSelect}
    className={cn(
      "flex h-[60px] cursor-default items-stretch gap-2 rounded-[10px] pr-3 pl-2 outline-none",
      "hover:bg-hover focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]",
      selected && "bg-panel shadow-selected hover:bg-panel",
    )}>
    <GraphLanes graph={graph} width={graphWidth} height={ROW.rowHeight} />
    <span className="flex min-w-0 flex-1 flex-col justify-center gap-1">
      <span className={cn("truncate text-sm", isMerge ? "font-normal text-fg3" : "font-medium text-fg")}>{commit.summary}</span>
      <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-fg3">
        <IdentityAvatar identity={commit.author} />
        <span className="shrink-0 whitespace-nowrap">{commit.author.name} · {date ? clock(date) : commit.committer.timestamp}</span>
        <RefTags refs={refs} headReference={headReference} isHeadCommit={headReference === null && headOid === commit.oid} limit={2} />
      </span>
    </span>
  </div>;
}

export function RefTags({ refs, headReference, isHeadCommit, size = "sm", limit = 3 }: {
  refs: RefInfo[];
  headReference: string | null;
  isHeadCommit?: boolean;
  size?: "sm" | "default";
  limit?: number;
}): React.JSX.Element | null {
  const ordered = [...refs].sort((a, b) => rank(a, headReference) - rank(b, headReference));
  const shown = ordered.slice(0, limit);
  if (!shown.length && !isHeadCommit) return null;
  return <>
    {isHeadCommit ? <Badge size={size} variant="head" className="shrink-0">HEAD</Badge> : null}
    {shown.map(ref => {
      const isHead = ref.name === headReference;
      return <Badge key={ref.name} size={size} variant={isHead ? "head" : ref.kind === "tag" ? "outline" : "default"} className="min-w-0 shrink" title={ref.name}>
        <span className="truncate">{shortRefName(ref.name)}{isHead ? " · HEAD" : ""}</span>
      </Badge>;
    })}
    {ordered.length > shown.length ? <span className="shrink-0 text-[11px] text-fg3">+{ordered.length - shown.length}</span> : null}
  </>;
}

function rank(ref: RefInfo, headReference: string | null): number {
  if (ref.name === headReference) return 0;
  return ref.kind === "localBranch" ? 1 : ref.kind === "remoteBranch" ? 2 : 3;
}

function LoadingRows({ onCancel }: { onCancel(): Promise<void> }): React.JSX.Element {
  return <div className="flex flex-col gap-3 px-3 py-3">
    <div className="flex items-center justify-between gap-2 text-xs text-fg2">
      <span>正在读取首批提交…</span>
      <Button variant="outline" size="sm" onClick={() => { void onCancel(); }}>取消</Button>
    </div>
    {[72, 58, 80, 64, 70, 52].map(width => <div key={width} className="flex items-center gap-3 py-2">
      <Skeleton className="size-2 rounded-full" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-2.5" style={{ width: `${width}%` }} />
        <Skeleton className="h-2 w-24" />
      </div>
    </div>)}
  </div>;
}
