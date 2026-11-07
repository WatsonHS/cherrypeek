import * as React from "react";
import type { CommitSummary, HistoryCommit, RefInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositoryView } from "../lib/repository-session-store.js";
import { FoldHorizontal, LoaderCircle, TriangleAlert } from "lucide-react";
import { clock, dayKey, dayLabel, parseGitTime, refTarget } from "../lib/format.js";
import { errorTitle } from "../lib/errors.js";
import { graphAboveLanes, graphPaths, graphWidth as measureGraphWidth, graphWidthForMaxLane, hiddenThroughPaths, laneX, lanesInMask, maxGraphLane, MAX_VISIBLE_LANES, type GraphGeometry } from "../lib/graph.js";
import { refLabels, type OtherWorktreeHead } from "../lib/ref-labels.js";
import { cn } from "../lib/utils.js";
import { IdentityAvatar } from "./identity-avatar.js";
import { RefChips } from "./ref-label.js";
import { Button } from "./ui/button.js";
import { Skeleton } from "./ui/skeleton.js";
import { createVirtualLayout, type VirtualRange } from "../lib/virtual-window.js";
import type { SelectionIntentToken } from "../lib/selection-intent.js";

const ROW: GraphGeometry = { rowHeight: 60, mid: 22, laneGap: 9, x0: 7 };
const DAY_ROW_HEIGHT = 34;
/** Height of the full-graph bar (h-9). */
const GRAPH_BAR_HEIGHT = 36;

type ListEntry =
  | { kind: "day"; key: string; dayKey: string; label: string; graph: HistoryCommit["graph"]; height: number }
  | { kind: "divider"; key: string; graph: HistoryCommit["graph"]; height: number }
  | { kind: "commit"; key: string; commit: HistoryCommit; height: number };

function buildEntries(commits: HistoryCommit[], dividerOid: string | null): ListEntry[] {
  const entries: ListEntry[] = [];
  const dividerIndex = dividerOid ? commits.findIndex(commit => commit.oid === dividerOid) : -1;
  const hasProvenPrefix = dividerIndex > 0 && !commits[dividerIndex]!.isNewSinceLastSeen &&
    commits.slice(0, dividerIndex).every(commit => commit.isNewSinceLastSeen);
  const visibleDividerOid = hasProvenPrefix ? dividerOid : null;
  const now = new Date();
  let current: Extract<ListEntry, { kind: "day" }> | undefined;
  for (const commit of commits) {
    const date = parseGitTime(commit.committer.timestamp);
    const key = date ? dayKey(date) : "unknown";
    if (!current || current.dayKey !== key) {
      current = { kind: "day", key: `day-${commit.oid}`, dayKey: key, label: date ? dayLabel(date, now) : "时间未知", graph: commit.graph, height: DAY_ROW_HEIGHT };
      entries.push(current);
    }
    if (commit.oid === visibleDividerOid) entries.push({ kind: "divider", key: `last-seen-${commit.oid}`, graph: commit.graph, height: DAY_ROW_HEIGHT });
    entries.push({ kind: "commit", key: commit.oid, commit, height: ROW.rowHeight });
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

export function CommitList({ preview, selectedOid, onSelect, captureSelectionIntent, selectIfCurrent, onCancel, onRetry, onRetryPage, onCancelPage, onLoadWindowEdge, onPrefetchPreviousPage, onPrefetchNextPage, onViewportAnchor, restorationAnchor, onSetAnchorRestorationSpace }: {
  preview: RepositoryView;
  selectedOid: string | undefined;
  onSelect(oid: string): void;
  captureSelectionIntent(): SelectionIntentToken | null;
  selectIfCurrent(oid: string, token: SelectionIntentToken | null): void;
  onCancel(): Promise<void>;
  onRetry(): Promise<void>;
  onRetryPage(): Promise<void>;
  onCancelPage(): Promise<void>;
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
  const entries = React.useMemo(() => buildEntries(preview.commits,
    preview.newSinceLastSeenStatus === "ready" ? preview.lastSeenDividerOid : null),
  [preview.commits, preview.lastSeenDividerOid, preview.newSinceLastSeenStatus]);
  const virtual = React.useMemo(() => createVirtualLayout(entries), [entries]);
  const latestScrollModel = React.useRef({ preview, entries, virtual, onCancelPage, onPrefetchPreviousPage, onPrefetchNextPage, onViewportAnchor });
  latestScrollModel.current = { preview, entries, virtual, onCancelPage, onPrefetchPreviousPage, onPrefetchNextPage, onViewportAnchor };
  const [range, setRange] = React.useState<VirtualRange>(() => virtual.range(0, 600, 12));
  const [graphExpanded, setGraphExpanded] = React.useState(false);
  const lastRestoredPageRevision = React.useRef(0);
  const refIndex = React.useMemo(() => refsByTarget(preview.refs), [preview.refs]);
  const maxLaneInWindow = preview.commits.reduce((maxLane, commit) => Math.max(maxLane, maxGraphLane(commit.graph)), -1);
  const visibleLaneCount = graphExpanded ? Math.max(MAX_VISIBLE_LANES, maxLaneInWindow + 1) : MAX_VISIBLE_LANES;
  const graphColumnWidth = graphExpanded
    ? graphWidthForMaxLane(ROW, visibleLaneCount - 1)
    : measureGraphWidth(ROW);
  const expandedContentMinWidth = graphExpanded ? graphColumnWidth + 280 : undefined;
  const headReference = preview.repository?.headReference ?? null;
  const headOid = preview.repository?.headOid ?? null;
  const otherWorktreesByHead = React.useMemo(() => {
    const index = new Map<string, OtherWorktreeHead[]>();
    for (const worktree of preview.navigation?.worktrees ?? []) {
      if (!worktree.headOid || worktree.isCurrent) continue;
      index.set(worktree.headOid, [...(index.get(worktree.headOid) ?? []),
        { path: worktree.path, isMain: worktree.isMain, headReference: worktree.isDetached ? null : worktree.headReference }]);
    }
    return index;
  }, [preview.navigation]);
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

  const collapseGraph = () => {
    if (listRef.current) {
      listRef.current.scrollLeft = 0;
      listRef.current.focus({ preventScroll: true });
    }
    setGraphExpanded(false);
  };

  // The full-graph bar sits above the list. Scroll by its height when it appears or goes,
  // so the rows stay where they were on screen.
  const graphBarShown = React.useRef(false);
  React.useLayoutEffect(() => {
    if (graphBarShown.current === graphExpanded) return;
    graphBarShown.current = graphExpanded;
    const element = listRef.current;
    if (!element) return;
    element.scrollTop = Math.max(0, element.scrollTop + (graphExpanded ? GRAPH_BAR_HEIGHT : -GRAPH_BAR_HEIGHT));
    programmaticScrollTop.current = element.scrollTop;
    lastScrollTop.current = element.scrollTop;
    setRange(virtual.range(element.scrollTop, element.clientHeight, 12));
  }, [graphExpanded, virtual]);

  const loadingEmpty = preview.state === "loading" && preview.commits.length === 0;
  const finishedEmpty = preview.state === "ready" && preview.commits.length === 0;
  const interrupted = (preview.state === "error" || preview.state === "cancelled") && preview.commits.length > 0;
  const reachedEnd = preview.commits.length > 0 && preview.windowNextCursor === null && preview.state === "ready"
    && preview.opening === null && !preview.pageLoading && !preview.refreshing && !preview.scopeSwitching
    && !preview.pageError;

  return <nav aria-label="提交列表" className="relative flex min-h-0 min-w-[320px] flex-[0_1_400px] flex-col overflow-hidden border-r border-line">
    {preview.error && preview.repository ? <div role="alert" className="mx-2 mb-2 flex items-start gap-2 rounded-[10px] border border-bad-line bg-bad-bg px-3 py-2.5 text-[13px]">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-bad" strokeWidth={1.75} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col"><span className="font-semibold text-bad">{errorTitle(preview.error.code)}</span><span className="break-words text-fg2">{preview.error.message} <code className="font-mono text-xs text-fg3">{preview.error.code}</code></span></span>
      {preview.session ? <Button variant="outline" size="sm" className="shrink-0" onClick={() => { void onRetry(); }}>重试</Button> : null}
    </div> : null}

    {preview.pageError ? <div role="alert" className="mx-2 mb-2 flex items-start gap-2 rounded-[10px] border border-bad-line bg-bad-bg px-3 py-2.5 text-[13px]">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-bad" strokeWidth={1.75} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col"><span className="font-semibold text-bad">{preview.pageErrorKind === "refresh" ? "刷新失败" : preview.pageErrorKind === "location" ? "历史定位失败" : "历史页读取失败"}</span><span className="break-words text-fg2">{preview.pageError.code === "SCOPE_UNAVAILABLE" ? "提交不在当前快照范围内。" : preview.pageError.message} <code className="font-mono text-xs text-fg3">{preview.pageError.code}</code></span></span>
      {!preview.refreshing ? <Button variant="outline" size="sm" className="shrink-0" onClick={() => { void onRetryPage(); }}>{preview.pageErrorKind === "location" ? "重试定位" : "重试"}</Button> : null}
    </div> : null}

    {preview.pageLoading && preview.commits.length > 0 ? <div role="status" className="absolute inset-x-2 bottom-2 z-10 flex items-center gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-xs text-fg3 shadow-pop">
      <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <span className="flex-1">正在加载更多提交…</span>
      <Button variant="outline" size="sm" onClick={() => { void onCancelPage(); }}>取消</Button>
    </div> : null}

    {graphExpanded ? <div data-testid="graph-mode-bar" className="flex h-9 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4 text-xs">
      <span className="min-w-0 flex-1 truncate"><span className="font-semibold text-fg2">全部图线</span><span className="text-fg3"> · {visibleLaneCount} 列</span></span>
      <Button data-testid="graph-collapse" variant="ghost" size="sm" className="shrink-0 gap-1 px-2"
        aria-label="收起完整提交图" title="收起完整提交图，回到前 6 列（Esc）" onClick={event => {
          event.stopPropagation();
          collapseGraph();
        }}><FoldHorizontal className="size-3.5" strokeWidth={1.75} aria-hidden="true" />收起</Button>
    </div> : null}

    <div className="relative flex min-h-0 flex-1">
    <div ref={listRef} role="listbox" aria-label="提交" tabIndex={0} aria-activedescendant={activeDescendant} aria-busy={preview.pageLoading}
      data-graph-expanded={graphExpanded ? "true" : "false"} data-visible-graph-lanes={visibleLaneCount}
      data-page-loading={preview.pageLoading ? "true" : "false"} data-loaded-offset={preview.pageOffset ?? 0}
      data-loaded-count={preview.commits.length} data-window-pages={preview.windowPageCount}
      className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain px-2 pb-6 outline-none" style={{ overflowAnchor: "none" }} onScroll={handleScroll}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Escape" && graphExpanded) {
          event.preventDefault();
          collapseGraph();
          return;
        }
        const keys: Record<string, number | "first" | "last"> = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8, Home: "first", End: "last" };
        const delta = keys[event.key];
        if (delta === undefined) return;
        event.preventDefault();
        move(delta);
      }}>
      <div style={expandedContentMinWidth === undefined ? undefined : { minWidth: expandedContentMinWidth }}>
      {loadingEmpty ? <LoadingRows onCancel={onCancel} /> : null}
      {finishedEmpty ? <p className="m-0 px-3 py-10 text-center text-[13px] text-fg3">当前 HEAD 尚无提交。</p> : null}
      <div aria-hidden="true" style={{ height: range.top }} />
      {visibleEntries.map(entry => entry.kind === "day"
        ? <DayRow key={entry.key} entry={entry} width={graphColumnWidth} expanded={graphExpanded} visibleLaneCount={visibleLaneCount} contentMinWidth={expandedContentMinWidth} />
        : entry.kind === "divider" ? <LastSeenDivider key={entry.key} graph={entry.graph} width={graphColumnWidth} expanded={graphExpanded} visibleLaneCount={visibleLaneCount} contentMinWidth={expandedContentMinWidth} />
        : <CommitRow key={entry.commit.oid} commit={entry.commit} graphWidth={graphColumnWidth} expanded={graphExpanded} visibleLaneCount={visibleLaneCount}
          contentMinWidth={expandedContentMinWidth} onExpandGraph={() => setGraphExpanded(true)}
          refs={refIndex.get(entry.commit.oid) ?? []} headReference={headReference} headOid={headOid}
          otherWorktrees={otherWorktreesByHead.get(entry.commit.oid) ?? []}
          selected={entry.commit.oid === selectedOid} onSelect={() => { onSelect(entry.commit.oid); listRef.current?.focus(); }} />)}
      <div aria-hidden="true" style={{ height: range.bottom }} />
      {preview.newSinceLastSeenStatus === "unavailable" ? <p role="status" className="m-0 px-3 pt-3 text-center text-xs text-fg3">无法比较上次查看记录，未显示新增标记。</p> : null}
      {preview.selectionMissingOnPage && !preview.oldSelectedCommit ? <p className="m-0 px-3 pt-4 text-center text-xs text-fg3">当前窗口未载入所选提交；这不表示它已不可达。</p> : null}
      {preview.anchorMissing ? <p className="m-0 px-3 pt-2 text-center text-xs text-fg3">刷新后，原列表位置不在当前窗口。</p> : null}
      {reachedEnd ? <p className="m-0 px-3 pt-4 text-center text-xs text-fg3">没有更多提交了。</p> : null}
      {interrupted ? <p className="m-0 px-3 pt-4 text-center text-xs text-warn">读取没有完成，以上结果不完整。</p> : null}
      {preview.anchorRestorationSpace > 0 ? <div aria-hidden="true" style={{ height: preview.anchorRestorationSpace }} /> : null}
      </div>
    </div>
    </div>
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

function GraphLanes({ graph, width, height, lanes, expanded, visibleLaneCount, onExpand, isHead = false, testId = "commit-graph" }: {
  graph?: HistoryCommit["graph"];
  width: number;
  height: number;
  lanes?: number[];
  expanded: boolean;
  visibleLaneCount: number;
  onExpand?: () => void;
  /** Rings the node when the window's HEAD points at this commit. */
  isHead?: boolean;
  testId?: string;
}): React.JSX.Element {
  const paths = React.useMemo(() => graph ? graphPaths(graph, ROW, expanded ? undefined : MAX_VISIBLE_LANES - 1) : [], [graph, expanded]);
  const hiddenPaths = React.useMemo(() => graph && expanded ? hiddenThroughPaths(graph, ROW) : [], [graph, expanded]);
  const hiddenNode = graph ? graph.lane >= visibleLaneCount : false;
  const hiddenCount = expanded ? 0 : graph?.hiddenLaneCount ?? 0;
  const overflowX = graphColumnX();
  const aboveMask = graph?.above ?? (lanes ?? []).filter(lane => lane < MAX_VISIBLE_LANES).reduce((mask, lane) => mask | (1 << lane), 0);
  const belowMask = graph?.below ?? 0;
  const aboveLanes = lanes ?? (graph ? (expanded ? graphAboveLanes(graph) : lanesInMask(graph.above)) : []);
  const hiddenRanges = graph?.hiddenThroughRanges ?? [];
  const drawnWidth = expanded ? width : overflowX;
  const signature = graph
    ? `${graph.lane}/${graph.color}/${graph.above}/${graph.below}/${graph.hiddenLaneCount}/${graph.boundary ? 1 : 0}/${graph.segments.map(segment => `${segment.kind}:${segment.fromLane}-${segment.toLane}:${segment.color}`).join(",")}/${hiddenRanges.map(range => `${range.startLane}-${range.endLane}`).join(",")}`
    : `above:${aboveMask}`;
  return <span className="relative block shrink-0" style={{ width, height }}>
    <svg width={width} height={height} aria-hidden="true" className="shrink-0"
      data-testid={testId} data-graph-signature={signature} data-graph-lane={graph?.lane}
      data-graph-expanded={expanded ? "true" : "false"} data-graph-width={width} data-graph-visible-lanes={visibleLaneCount} data-graph-hidden-count={hiddenCount}
      data-graph-boundary={graph?.boundary ? "true" : "false"} data-graph-above-mask={aboveMask} data-graph-below-mask={belowMask}
      data-graph-above-lanes={aboveLanes.join(",")} data-graph-hidden-through-ranges={hiddenRanges.map(item => `${item.startLane}-${item.endLane}`).join(",")}>
      <svg x={0} y={0} width={drawnWidth} height={height} viewBox={`0 0 ${drawnWidth} ${height}`} className="overflow-hidden">
        {lanes?.filter(lane => expanded || lane < MAX_VISIBLE_LANES).map(lane => <path key={lane} d={`M${laneX(lane, ROW)} 0V${height}`} style={{ stroke: `var(--l${lane % 6})`, strokeWidth: 1.5, fill: "none" }} />)}
        {paths.map((path, index) => <path key={index} d={path.d} style={{ stroke: `var(--l${path.color})`, strokeWidth: 1.5, fill: "none", strokeLinecap: "round" }} />)}
        {hiddenPaths.map(path => <path key={path.color} data-testid="graph-hidden-through" data-graph-color={path.color} d={path.d}
          style={{ stroke: `var(--l${path.color})`, strokeWidth: 1.5, fill: "none" }} />)}
        {graph && isHead && (!hiddenNode || expanded) ? <circle data-testid="graph-head-ring" cx={laneX(graph.lane, ROW)} cy={ROW.mid} r={6.5}
          style={{ fill: "none", stroke: `var(--l${graph.color})`, strokeWidth: 1.5 }} /> : null}
        {graph && (!hiddenNode || expanded) ? <circle cx={laneX(graph.lane, ROW)} cy={ROW.mid} r={3.5}
          style={graph.boundary
            ? { fill: "var(--bg)", stroke: "var(--warn)", strokeWidth: 1.8 }
            : graph.parents.length > 1
              ? { fill: "var(--bg)", stroke: `var(--l${graph.color})`, strokeWidth: 1.5 }
              : { fill: `var(--l${graph.color})` }} /> : null}
      </svg>
      {hiddenCount > 0 && hiddenNode ? <circle cx={overflowX + 3} cy={ROW.mid} r={2.5} className="fill-fg3" /> : null}
    </svg>
    {hiddenCount > 0 ? <button type="button" data-testid="graph-expand" aria-label={`展开完整提交图，显示另外 ${hiddenCount} 条隐藏图线`}
      title={`展开完整提交图；另有 ${hiddenCount} 条隐藏图线`} className="absolute z-[1] rounded px-0.5 font-mono text-[9px] leading-3 text-fg3 hover:bg-hover hover:text-fg"
      style={{ left: overflowX + (hiddenNode ? 8 : 2), top: ROW.mid - 7 }} onClick={event => {
        event.stopPropagation();
        onExpand?.();
      }}>+{hiddenCount}</button> : null}
  </span>;
}

function graphColumnX(): number {
  return laneX(MAX_VISIBLE_LANES - 1, ROW) + ROW.x0;
}

function DayRow({ entry, width, expanded, visibleLaneCount, contentMinWidth }: { entry: Extract<ListEntry, { kind: "day" }>; width: number; expanded: boolean; visibleLaneCount: number; contentMinWidth?: number }): React.JSX.Element {
  const lanes = expanded ? graphAboveLanes(entry.graph) : lanesInMask(entry.graph.above);
  return <div role="presentation" className="flex items-stretch gap-2 pr-3 pl-2" style={{ height: DAY_ROW_HEIGHT, minWidth: contentMinWidth }}>
    <GraphLanes width={width} height={DAY_ROW_HEIGHT} lanes={lanes} expanded={expanded} visibleLaneCount={visibleLaneCount} testId="graph-day-bridge" />
    <span className="flex flex-1 items-end justify-between pb-1.5 text-xs">
      <span className="font-semibold text-fg2">{entry.label}</span>
    </span>
  </div>;
}

function LastSeenDivider({ graph, width, expanded, visibleLaneCount, contentMinWidth }: { graph: HistoryCommit["graph"]; width: number; expanded: boolean; visibleLaneCount: number; contentMinWidth?: number }): React.JSX.Element {
  const lanes = expanded ? graphAboveLanes(graph) : lanesInMask(graph.above);
  return <div role="separator" aria-label="上次看到这里" data-testid="history-divider" data-marker-kind="last-seen"
    className="flex items-center gap-2 pr-3 pl-2 text-[11px] text-fg3" style={{ height: DAY_ROW_HEIGHT, minWidth: contentMinWidth }}>
    <GraphLanes width={width} height={DAY_ROW_HEIGHT} lanes={lanes} expanded={expanded} visibleLaneCount={visibleLaneCount} testId="graph-last-seen-bridge" />
    <span className="h-px flex-1 bg-line" />
    <span>上次看到这里</span>
    <span className="h-px flex-1 bg-line" />
  </div>;
}

function CommitRow({ commit, graphWidth, expanded, visibleLaneCount, contentMinWidth, onExpandGraph, refs, headReference, headOid, otherWorktrees, selected, onSelect }: {
  commit: HistoryCommit;
  graphWidth: number;
  expanded: boolean;
  visibleLaneCount: number;
  contentMinWidth?: number;
  onExpandGraph(): void;
  refs: RefInfo[];
  headReference: string | null;
  headOid: string | null;
  otherWorktrees: OtherWorktreeHead[];
  selected: boolean;
  onSelect(): void;
}): React.JSX.Element {
  const isMerge = commit.parents.length > 1;
  const date = parseGitTime(commit.committer.timestamp);
  const isHead = headOid === commit.oid;
  const labels = refLabels({ refs, headReference, isHeadCommit: isHead, otherWorktrees, foldRemotes: true });
  return <div id={rowId(commit.oid)} role="option" aria-selected={selected} tabIndex={-1}
    data-testid="commit-row" data-oid={commit.oid}
    title={[
      commit.graph.boundary ? "历史边界（浅克隆或父关系调整）" : undefined,
      !expanded && commit.graph.lane >= MAX_VISIBLE_LANES ? "此提交位于未显示的图线中" : undefined,
      !expanded && commit.graph.hiddenLaneCount > 0 ? `另有 ${commit.graph.hiddenLaneCount} 条图线未显示` : undefined,
    ].filter(Boolean).join("；") || undefined}
    onClick={onSelect}
    style={{ minWidth: contentMinWidth }}
    className={cn(
      "flex h-[60px] cursor-default items-stretch gap-2 rounded-[10px] pr-3 pl-2 outline-none",
      "hover:bg-hover focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]",
      selected && "bg-panel shadow-selected hover:bg-panel",
    )}>
    <GraphLanes graph={commit.graph} width={graphWidth} height={ROW.rowHeight} expanded={expanded} visibleLaneCount={visibleLaneCount} onExpand={onExpandGraph} isHead={isHead} />
    <span className="flex min-w-0 flex-1 flex-col justify-center gap-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {commit.isNewSinceLastSeen ? <span aria-label="上次查看后新增" data-testid="history-marker" data-marker-kind="new"
          title="上次查看后新增" className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
        {commit.graph.boundary ? <span title="历史边界（浅克隆或父关系调整）" className="shrink-0 rounded bg-sunken px-1 text-[10px] text-warn">边界</span> : null}
        {commit.graph.boundary ? <span className="sr-only">历史边界（浅克隆或父关系调整）。</span> : null}
        {!expanded && commit.graph.lane >= MAX_VISIBLE_LANES ? <span className="sr-only">此提交位于未显示的图线中。</span> : null}
        {!expanded && commit.graph.hiddenLaneCount > 0 ? <span className="sr-only">另有 {commit.graph.hiddenLaneCount} 条图线未显示。</span> : null}
        <span className={cn("min-w-0 flex-1 truncate text-sm", isMerge ? "font-normal text-fg3" : "font-medium text-fg")}>{commit.summary}</span>
        <span className="shrink-0 text-xs whitespace-nowrap text-fg3 tabular-nums">{date ? clock(date) : commit.committer.timestamp}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg3">
        <IdentityAvatar identity={commit.author} />
        <span className="min-w-0 flex-1 truncate">{commit.author.name}</span>
        {labels.length ? <span data-testid="commit-ref-tags" className="flex max-w-[65%] min-w-0 shrink-0 items-center justify-end gap-1">
          <RefChips labels={labels} limit={1} wholeGroup chipClassName={() => "max-w-[150px] shrink"} />
        </span> : null}
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
  return <RefChips labels={refLabels({ refs, headReference, isHeadCommit: Boolean(isHeadCommit) })} size={size} limit={limit}
    chipClassName={() => "max-w-[320px]"} />;
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
