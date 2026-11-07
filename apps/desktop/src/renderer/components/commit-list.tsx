import * as React from "react";
import type { CommitSummary, HistoryCommit, RefInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositoryView } from "../lib/repository-session-store.js";
import { TriangleAlert } from "lucide-react";
import { clock, dayKey, dayLabel, parseGitTime, refTarget, repositoryName, shortRefName } from "../lib/format.js";
import { errorTitle } from "../lib/errors.js";
import { laneX, layoutGraph, MAX_VISIBLE_LANES, type GraphGeometry, type GraphRow } from "../lib/graph.js";
import { cn } from "../lib/utils.js";
import { IdentityAvatar } from "./identity-avatar.js";
import { ActivityPlaceholder } from "./placeholder-widgets.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Skeleton } from "./ui/skeleton.js";
import { createVirtualLayout, type VirtualRange } from "../lib/virtual-window.js";
import type { SelectionIntentToken } from "../lib/selection-intent.js";

const ROW: GraphGeometry = { rowHeight: 60, mid: 22, laneGap: 9, x0: 7 };
const DAY_ROW_HEIGHT = 34;

type ListEntry =
  | { kind: "day"; key: string; dayKey: string; label: string; count: number; lanes: number[]; height: number }
  | { kind: "divider"; key: string; height: number }
  | { kind: "commit"; key: string; commit: HistoryCommit; graph: GraphRow | undefined; height: number };

function buildEntries(commits: HistoryCommit[], rows: Map<string, GraphRow>, dividerOid: string | null): ListEntry[] {
  const entries: ListEntry[] = [];
  const dividerIndex = dividerOid ? commits.findIndex(commit => commit.oid === dividerOid) : -1;
  const hasProvenPrefix = dividerIndex > 0 && !commits[dividerIndex]!.isNewSinceLastSeen &&
    commits.slice(0, dividerIndex).every(commit => commit.isNewSinceLastSeen);
  const visibleDividerOid = hasProvenPrefix ? dividerOid : null;
  const now = new Date();
  let current: Extract<ListEntry, { kind: "day" }> | undefined;
  let lanesAbove: number[] = [];
  for (const commit of commits) {
    const date = parseGitTime(commit.committer.timestamp);
    const key = date ? dayKey(date) : "unknown";
    if (!current || current.dayKey !== key) {
      current = { kind: "day", key: `day-${commit.oid}`, dayKey: key, label: date ? dayLabel(date, now) : "时间未知", count: 0, lanes: lanesAbove, height: DAY_ROW_HEIGHT };
      entries.push(current);
    }
    current.count += 1;
    if (commit.oid === visibleDividerOid) entries.push({ kind: "divider", key: `last-seen-${commit.oid}`, height: DAY_ROW_HEIGHT });
    const graph = rows.get(commit.oid);
    entries.push({ kind: "commit", key: commit.oid, commit, graph, height: ROW.rowHeight });
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

export function CommitList({ preview, selectedOid, onSelect, captureSelectionIntent, selectIfCurrent, onCancel, onRetry, onRetryPage, onCancelPage, onPreviousPage, onNextPage, onLoadWindowEdge, onPrefetchPreviousPage, onPrefetchNextPage, onViewportAnchor, restorationAnchor, onSetAnchorRestorationSpace }: {
  preview: RepositoryView;
  selectedOid: string | undefined;
  onSelect(oid: string): void;
  captureSelectionIntent(): SelectionIntentToken | null;
  selectIfCurrent(oid: string, token: SelectionIntentToken | null): void;
  onCancel(): Promise<void>;
  onRetry(): Promise<void>;
  onRetryPage(): Promise<void>;
  onCancelPage(): Promise<void>;
  onPreviousPage(): Promise<string | undefined>;
  onNextPage(): Promise<string | undefined>;
  onLoadWindowEdge(direction: "before" | "after"): Promise<string | undefined>;
  onPrefetchPreviousPage(): void;
  onPrefetchNextPage(): void;
  onViewportAnchor(oid: string | undefined): void;
  restorationAnchor?: { oid: string; offset: number };
  onSetAnchorRestorationSpace(pixels: number): void;
}): React.JSX.Element {
  const listRef = React.useRef<HTMLDivElement>(null);
  const frameRef = React.useRef(0);
  const lastScrollTop = React.useRef(0);
  const latestScrollDirection = React.useRef<"up" | "down" | null>(null);
  const programmaticScrollTop = React.useRef<number | null>(null);
  const cancelingPrefetch = React.useRef(false);
  const pendingAnchor = React.useRef<{ oid: string; offset: number; repoId: string; generation: string } | undefined>(undefined);
  const layout = React.useMemo(() => layoutGraph(preview.commits, ROW), [preview.commits]);
  const entries = React.useMemo(() => buildEntries(preview.commits, layout.rows,
    preview.newSinceLastSeenStatus === "ready" ? preview.lastSeenDividerOid : null),
  [preview.commits, preview.lastSeenDividerOid, preview.newSinceLastSeenStatus, layout]);
  const virtual = React.useMemo(() => createVirtualLayout(entries), [entries]);
  const latestScrollModel = React.useRef({ preview, entries, virtual, onCancelPage, onPrefetchPreviousPage, onPrefetchNextPage, onViewportAnchor });
  latestScrollModel.current = { preview, entries, virtual, onCancelPage, onPrefetchPreviousPage, onPrefetchNextPage, onViewportAnchor };
  const [range, setRange] = React.useState<VirtualRange>(() => virtual.range(0, 600, 12));
  const lastRestoredPageRevision = React.useRef(0);
  const refIndex = React.useMemo(() => refsByTarget(preview.refs), [preview.refs]);
  const visibleLanes = Math.min(Math.max(layout.laneCount, 1), MAX_VISIBLE_LANES);
  const graphWidth = laneX(visibleLanes - 1, ROW) + ROW.x0;
  const hiddenLanes = Math.max(0, layout.laneCount - MAX_VISIBLE_LANES);
  const headReference = preview.repository?.headReference ?? null;
  const headOid = preview.repository?.headOid ?? null;
  const otherWorktreesByHead = React.useMemo(() => {
    const index = new Map<string, { path: string; isMain: boolean }[]>();
    for (const worktree of preview.navigation?.worktrees ?? []) {
      if (!worktree.headOid || worktree.isCurrent) continue;
      index.set(worktree.headOid, [...(index.get(worktree.headOid) ?? []), { path: worktree.path, isMain: worktree.isMain }]);
    }
    return index;
  }, [preview.navigation]);
  const scope = preview.session?.scope;
  const scopeDescription = scope === "allBranches" ? "全部分支" : scope && typeof scope === "object"
    ? "ref" in scope ? shortRefName(scope.ref) : "worktree 历史"
    : "HEAD 可达";
  const visibleEntries = entries.slice(range.start, range.end);
  const activeDescendant = selectedOid && visibleEntries.some(entry => entry.kind === "commit" && entry.commit.oid === selectedOid)
    ? rowId(selectedOid) : undefined;

  const updateRange = React.useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    setRange(virtual.range(element.scrollTop, element.clientHeight, 12));
  }, [virtual]);

  // High-frequency scroll position lives in refs; one frame computes the visible window.
  const handleScroll = () => {
    const element = listRef.current;
    if (!element) return;
    const nextTop = element.scrollTop;
    const expectedTop = programmaticScrollTop.current;
    const isProgrammatic = expectedTop !== null && Math.abs(expectedTop - nextTop) < 1;
    programmaticScrollTop.current = null;
    latestScrollDirection.current = isProgrammatic ? null : nextTop > lastScrollTop.current ? "down" : nextTop < lastScrollTop.current ? "up" : null;
    lastScrollTop.current = nextTop;
    if (preview.session) {
      const anchor = captureWindowAnchor(element, preview.session, entries, virtual);
      if (anchor) {
        pendingAnchor.current = anchor;
        onViewportAnchor(anchor.oid);
      }
    }
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const model = latestScrollModel.current;
      const current = listRef.current;
      if (!current) return;
      setRange(model.virtual.range(current.scrollTop, current.clientHeight, 12));
      if (pendingAnchor.current) {
        if (model.preview.session) pendingAnchor.current = captureWindowAnchor(current, model.preview.session, model.entries, model.virtual);
      }
      const direction = latestScrollDirection.current;
      if (!direction || model.preview.refreshing) return;
      if (model.preview.pageLoading) {
        const requestedDirection = direction === "up" ? "before" : "after";
        if (model.preview.pageRequestKind === "prefetch" && model.preview.pageRequestDirection !== requestedDirection && !cancelingPrefetch.current) {
          if (model.preview.session) pendingAnchor.current = captureWindowAnchor(current, model.preview.session, model.entries, model.virtual);
          const requestRepoId = model.preview.session?.repoId;
          const requestGeneration = model.preview.session?.generation;
          cancelingPrefetch.current = true;
          void model.onCancelPage().catch(() => undefined).then(() => {
            cancelingPrefetch.current = false;
            const latest = listRef.current;
            const latestModel = latestScrollModel.current;
            const currentPreview = latestModel.preview;
            if (!latest || latestScrollDirection.current !== direction || !requestRepoId ||
              currentPreview.session?.repoId !== requestRepoId || currentPreview.session.generation !== requestGeneration ||
              currentPreview.pageLoading || currentPreview.refreshing) return;
            const threshold = Math.max(latest.clientHeight, 100);
            if (direction === "up" && latest.scrollTop <= threshold && currentPreview.windowPreviousCursor) latestModel.onPrefetchPreviousPage();
            else if (direction === "down" && latest.scrollHeight - latest.clientHeight - latest.scrollTop <= threshold && currentPreview.windowNextCursor) latestModel.onPrefetchNextPage();
          });
        }
        return;
      }
      const threshold = Math.max(current.clientHeight, 100);
      if (direction === "down" && current.scrollHeight - current.clientHeight - current.scrollTop <= threshold && model.preview.windowNextCursor) {
        if (model.preview.session) pendingAnchor.current = captureWindowAnchor(current, model.preview.session, model.entries, model.virtual);
        model.onPrefetchNextPage();
      } else if (direction === "up" && current.scrollTop <= threshold && model.preview.windowPreviousCursor) {
        if (model.preview.session) pendingAnchor.current = captureWindowAnchor(current, model.preview.session, model.entries, model.virtual);
        model.onPrefetchPreviousPage();
      }
    });
  };

  React.useEffect(() => {
    updateRange();
    const element = listRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateRange);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateRange]);

  React.useLayoutEffect(() => {
    if (preview.windowRevision === 0) return;
    const anchor = pendingAnchor.current;
    pendingAnchor.current = undefined;
    if (!anchor) return;
    if (!preview.session || anchor.repoId !== preview.session.repoId || anchor.generation !== preview.session.generation) return;
    const offset = virtual.offset(anchor.oid);
    const element = listRef.current;
    if (offset === undefined || !element) return;
    const target = Math.max(0, offset - anchor.offset);
    programmaticScrollTop.current = target;
    element.scrollTop = target;
    lastScrollTop.current = element.scrollTop;
    onViewportAnchor(anchor.oid);
    setRange(virtual.range(element.scrollTop, element.clientHeight, 12));
  }, [preview.windowRevision, preview.session, onViewportAnchor, virtual]);

  React.useLayoutEffect(() => {
    if (preview.pageRevision === 0 || preview.pageRevision === lastRestoredPageRevision.current) return;
    const anchor = restorationAnchor;
    const element = listRef.current;
    if (!anchor || preview.anchorMissing || !element) {
      lastRestoredPageRevision.current = preview.pageRevision;
      return;
    }
    const offset = virtual.offset(anchor.oid);
    if (offset === undefined) {
      lastRestoredPageRevision.current = preview.pageRevision;
      return;
    }
    const target = Math.max(0, offset - anchor.offset);
    const total = virtual.offsets.at(-1) ?? 0;
    const maxScroll = total + preview.anchorRestorationSpace - element.clientHeight;
    const extra = Math.ceil(Math.max(0, target - maxScroll));
    if (extra > 0) {
      onSetAnchorRestorationSpace(Math.min(element.clientHeight, preview.anchorRestorationSpace + extra));
      return;
    }
    programmaticScrollTop.current = target;
    element.scrollTop = target;
    lastScrollTop.current = target;
    onViewportAnchor(anchor.oid);
    setRange(virtual.range(target, element.clientHeight, 12));
    lastRestoredPageRevision.current = preview.pageRevision;
  }, [preview.pageRevision, preview.anchorMissing, preview.anchorRestorationSpace, restorationAnchor, onSetAnchorRestorationSpace, onViewportAnchor, virtual]);

  // Keep a selected row visible even when it is outside the currently mounted DOM slice.
  React.useLayoutEffect(() => {
    if (!selectedOid) return;
    const offset = virtual.offset(selectedOid);
    const element = listRef.current;
    if (offset === undefined || !element) return;
    const rowHeight = ROW.rowHeight;
    const rowBottom = offset + rowHeight;
    let target = element.scrollTop;
    if (offset < target) target = offset;
    else if (rowBottom > target + element.clientHeight) target = rowBottom - element.clientHeight;
    if (target !== element.scrollTop) {
      programmaticScrollTop.current = target;
      element.scrollTop = target;
      lastScrollTop.current = target;
      onViewportAnchor(selectedOid);
      setRange(virtual.range(target, element.clientHeight, 12));
    }
  }, [selectedOid]);

  const move = (delta: number | "first" | "last") => {
    const commits = preview.commits;
    if (!commits.length) return;
    const index = commits.findIndex(commit => commit.oid === selectedOid);
    const requested = delta === "first" ? 0 : delta === "last" ? commits.length - 1 : (index === -1 ? (delta === 1 ? -1 : 0) : index) + delta;
    if (requested < 0) {
      if (preview.windowPreviousCursor) {
        if (preview.session && listRef.current) pendingAnchor.current = captureWindowAnchor(listRef.current, preview.session, entries, virtual);
        const intent = captureSelectionIntent();
        void onLoadWindowEdge("before").then(oid => { if (oid) selectIfCurrent(oid, intent); });
      }
      return;
    }
    if (requested >= commits.length) {
      if (preview.windowNextCursor) {
        if (preview.session && listRef.current) pendingAnchor.current = captureWindowAnchor(listRef.current, preview.session, entries, virtual);
        const intent = captureSelectionIntent();
        void onLoadWindowEdge("after").then(oid => { if (oid) selectIfCurrent(oid, intent); });
      }
      return;
    }
    const oid = commits[requested]!.oid;
    onSelect(oid);
    requestAnimationFrame(() => listRef.current?.focus());
  };

  const loadingEmpty = preview.state === "loading" && preview.commits.length === 0;
  const finishedEmpty = preview.state === "ready" && preview.commits.length === 0;
  const interrupted = (preview.state === "error" || preview.state === "cancelled") && preview.commits.length > 0;

  return <nav aria-label="提交列表" className="flex min-h-0 min-w-[320px] flex-[0_1_400px] flex-col border-r border-line">
    <div className="flex h-[46px] shrink-0 items-center justify-between gap-2 pr-3.5 pl-1.5 text-xs text-fg3">
      <ActivityPlaceholder />
      <span className="flex items-center gap-2">
        {hiddenLanes ? <span title={`另有 ${hiddenLanes} 条分支线未画出`} className="rounded-full bg-sunken px-1.5 font-mono text-[11px] text-fg2">+{hiddenLanes}</span> : null}
      <span>{preview.scopeSwitching ? "正在准备范围…" : preview.pageLoading ? "正在读取历史页…" : preview.refreshing ? "正在刷新快照…" : `${scopeDescription} · 固定快照 · 已载入 ${preview.commits.length} 条`}</span>
      </span>
    </div>

    {preview.error && preview.repository ? <div role="alert" className="mx-2 mb-2 flex items-start gap-2 rounded-[10px] border border-bad-line bg-bad-bg px-3 py-2.5 text-[13px]">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-bad" strokeWidth={1.75} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col"><span className="font-semibold text-bad">{errorTitle(preview.error.code)}</span><span className="break-words text-fg2">{preview.error.message} <code className="font-mono text-xs text-fg3">{preview.error.code}</code></span></span>
      {preview.session ? <Button variant="outline" size="sm" className="shrink-0" onClick={() => { void onRetry(); }}>重试</Button> : null}
    </div> : null}

    {preview.pageError ? <div role="alert" className="mx-2 mb-2 flex items-start gap-2 rounded-[10px] border border-bad-line bg-bad-bg px-3 py-2.5 text-[13px]">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-bad" strokeWidth={1.75} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col"><span className="font-semibold text-bad">{preview.pageErrorKind === "refresh" ? "刷新失败" : "历史页读取失败"}</span><span className="break-words text-fg2">{preview.pageError.message} <code className="font-mono text-xs text-fg3">{preview.pageError.code}</code></span></span>
      {!preview.refreshing ? <Button variant="outline" size="sm" className="shrink-0" onClick={() => { void onRetryPage(); }}>重试</Button> : null}
    </div> : null}

    <div ref={listRef} role="listbox" aria-label="提交" tabIndex={0} aria-activedescendant={activeDescendant} aria-busy={preview.pageLoading}
      data-page-loading={preview.pageLoading ? "true" : "false"} data-loaded-offset={preview.pageOffset ?? 0}
      data-loaded-count={preview.commits.length} data-window-pages={preview.windowPageCount}
      className="min-h-0 flex-1 overflow-auto px-2 pb-6 outline-none" style={{ overflowAnchor: "none" }} onScroll={handleScroll}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        const keys: Record<string, number | "first" | "last"> = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8, Home: "first", End: "last" };
        const delta = keys[event.key];
        if (delta === undefined) return;
        event.preventDefault();
        move(delta);
      }}>
      {loadingEmpty ? <LoadingRows onCancel={onCancel} /> : null}
      {finishedEmpty ? <p className="m-0 px-3 py-10 text-center text-[13px] text-fg3">当前 HEAD 尚无提交。</p> : null}
      <div aria-hidden="true" style={{ height: range.top }} />
      {visibleEntries.map(entry => entry.kind === "day"
        ? <DayRow key={entry.key} entry={entry} width={graphWidth} />
        : entry.kind === "divider" ? <LastSeenDivider key={entry.key} />
        : <CommitRow key={entry.commit.oid} commit={entry.commit} graph={entry.graph} graphWidth={graphWidth}
          refs={refIndex.get(entry.commit.oid) ?? []} headReference={headReference} headOid={headOid}
          otherWorktrees={otherWorktreesByHead.get(entry.commit.oid) ?? []}
          selected={entry.commit.oid === selectedOid} onSelect={() => { onSelect(entry.commit.oid); listRef.current?.focus(); }} />)}
      <div aria-hidden="true" style={{ height: range.bottom }} />
      {preview.newSinceLastSeenStatus === "unavailable" ? <p role="status" className="m-0 px-3 pt-3 text-center text-xs text-fg3">无法比较上次查看记录，未显示新增标记。</p> : null}
      {preview.selectionMissingOnPage && !preview.oldSelectedCommit ? <p className="m-0 px-3 pt-4 text-center text-xs text-fg3">当前窗口未载入所选提交；这不表示它已不可达。</p> : null}
      {preview.anchorMissing ? <p className="m-0 px-3 pt-2 text-center text-xs text-fg3">刷新后，原列表位置不在当前窗口。</p> : null}
      {preview.hasMore ? <p className="m-0 px-3 pt-4 text-center text-xs text-fg3">还有更早的提交，可继续翻页。</p> : null}
      {interrupted ? <p className="m-0 px-3 pt-4 text-center text-xs text-warn">读取没有完成，以上结果不完整。</p> : null}
      {preview.anchorRestorationSpace > 0 ? <div aria-hidden="true" style={{ height: preview.anchorRestorationSpace }} /> : null}
    </div>
    {preview.pageOffset !== null ? <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-fg3">
      <Button variant="outline" size="sm" disabled={!preview.canNavigatePrevious || preview.pageLoading || preview.refreshing}
        onClick={() => { if (preview.session && listRef.current) pendingAnchor.current = captureWindowAnchor(listRef.current, preview.session, entries, virtual); const intent = captureSelectionIntent(); void onPreviousPage().then(oid => { if (oid) selectIfCurrent(oid, intent); }); }}>上一页</Button>
      <span>{preview.commits.length ? `${preview.pageOffset + 1}–${preview.pageOffset + preview.commits.length} 条` : "当前页 0 条"}</span>
      <span className="flex items-center gap-2">
        {preview.pageLoading && !preview.refreshing ? <Button variant="outline" size="sm" onClick={() => { void onCancelPage(); }}>取消</Button> : null}
        <Button variant="outline" size="sm" disabled={!preview.canNavigateNext || preview.pageLoading || preview.refreshing}
          onClick={() => { if (preview.session && listRef.current) pendingAnchor.current = captureWindowAnchor(listRef.current, preview.session, entries, virtual); const intent = captureSelectionIntent(); void onNextPage().then(oid => { if (oid) selectIfCurrent(oid, intent); }); }}>下一页</Button>
      </span>
    </div> : null}
  </nav>;
}

function rowId(oid: string): string {
  return `commit-${oid}`;
}

function captureWindowAnchor(
  container: HTMLElement,
  session: NonNullable<RepositoryView["session"]>,
  entries: ListEntry[],
  virtual: ReturnType<typeof createVirtualLayout>,
) {
  const top = container.getBoundingClientRect().top;
  const scrollTop = container.scrollTop;
  const range = virtual.range(scrollTop, container.clientHeight, 0);
  for (let index = range.start; index < range.end; index += 1) {
    const entry = entries[index];
    if (entry?.kind !== "commit") continue;
    const offset = virtual.offset(entry.key);
    if (offset === undefined || offset + entry.height <= scrollTop) continue;
    return { oid: entry.commit.oid, offset: offset - scrollTop, repoId: session.repoId, generation: session.generation };
  }
  const lastCommit = [...entries].reverse().find((entry): entry is Extract<ListEntry, { kind: "commit" }> => entry.kind === "commit");
  if (!lastCommit) return undefined;
  const offset = virtual.offset(lastCommit.key);
  if (offset === undefined) return undefined;
  return { oid: lastCommit.commit.oid, offset: offset - scrollTop, repoId: session.repoId, generation: session.generation };
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
      <span className="text-fg3">窗口内本组 {entry.count} 条</span>
    </span>
  </div>;
}

function LastSeenDivider(): React.JSX.Element {
  return <div role="separator" aria-label="上次看到这里" data-testid="history-divider" data-marker-kind="last-seen"
    className="flex items-center gap-2 px-3 text-[11px] text-fg3" style={{ height: DAY_ROW_HEIGHT }}>
    <span className="h-px flex-1 bg-line" />
    <span>上次看到这里</span>
    <span className="h-px flex-1 bg-line" />
  </div>;
}

function CommitRow({ commit, graph, graphWidth, refs, headReference, headOid, otherWorktrees, selected, onSelect }: {
  commit: HistoryCommit;
  graph: GraphRow | undefined;
  graphWidth: number;
  refs: RefInfo[];
  headReference: string | null;
  headOid: string | null;
  otherWorktrees: { path: string; isMain: boolean }[];
  selected: boolean;
  onSelect(): void;
}): React.JSX.Element {
  const isMerge = commit.parents.length > 1;
  const date = parseGitTime(commit.committer.timestamp);
  return <div id={rowId(commit.oid)} role="option" aria-selected={selected} tabIndex={-1}
    data-testid="commit-row" data-oid={commit.oid}
    onClick={onSelect}
    className={cn(
      "flex h-[60px] cursor-default items-stretch gap-2 rounded-[10px] pr-3 pl-2 outline-none",
      "hover:bg-hover focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]",
      selected && "bg-panel shadow-selected hover:bg-panel",
    )}>
    <GraphLanes graph={graph} width={graphWidth} height={ROW.rowHeight} />
    <span className="flex min-w-0 flex-1 flex-col justify-center gap-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {commit.isNewSinceLastSeen ? <span aria-label="上次查看后新增" data-testid="history-marker" data-marker-kind="new"
          title="上次查看后新增" className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
        <span className={cn("truncate text-sm", isMerge ? "font-normal text-fg3" : "font-medium text-fg")}>{commit.summary}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-fg3">
        <IdentityAvatar identity={commit.author} />
        <span className="shrink-0 whitespace-nowrap">{commit.author.name} · {date ? clock(date) : commit.committer.timestamp}</span>
        <RefTags refs={refs} headReference={headReference} isHeadCommit={headReference === null && headOid === commit.oid} limit={2} />
        {otherWorktrees.slice(0, 2).map(worktree => <Badge key={worktree.path} variant="outline" size="sm" title={worktree.path}>
          worktree HEAD · {repositoryName(worktree.path)}{worktree.isMain ? " · 主" : " · linked"}
        </Badge>)}
        {otherWorktrees.length > 2 ? <Badge variant="outline" size="sm">+{otherWorktrees.length - 2} worktree</Badge> : null}
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
