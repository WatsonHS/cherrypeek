import * as React from "react";
import type { CommitSummary, HistoryCommit, RefInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositoryView } from "../lib/repository-session-store.js";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { clock, dayKey, dayLabel, parseGitTime, refTarget } from "../lib/format.js";
import { errorTitle } from "../lib/errors.js";
import { graphAboveLanes, graphPaths, graphWidthForMaxLane, hiddenThroughPaths, laneX, lanesInMask, maxGraphLane, MAX_VISIBLE_LANES, type GraphGeometry } from "../lib/graph.js";
import { refLabels, type OtherWorktreeHead } from "../lib/ref-labels.js";
import { cn } from "../lib/utils.js";
import { IdentityAvatar } from "./identity-avatar.js";
import { RefChips } from "./ref-label.js";
import { Button } from "./ui/button.js";
import { Skeleton } from "./ui/skeleton.js";
import { createVirtualLayout, type VirtualRange } from "../lib/virtual-window.js";
import type { SelectionIntentToken } from "../lib/selection-intent.js";
import { HistoryTimeSlider, type HistoryTimeSliderDay } from "./history-time-slider.js";
import { HistoryDayStrip, type DayMarker } from "./history-day-strip.js";
import type { HandoffRequest } from "../lib/handoff-prompt.js";
import { localDateInput } from "../lib/search-date.js";
import { historyPrefetchDistance } from "../lib/history-prefetch.js";

const ROW: GraphGeometry = { rowHeight: 60, mid: 22, laneGap: 9, x0: 7 };
const DAY_ROW_HEIGHT = 34;
/** Room after the six compact lanes for the hidden-node marker and the "+N" control. */
const HIDDEN_LANES_GUTTER = 32;
/** Inner left padding of a commit's text card; day labels use the same so the text lines up. */
const TEXT_INSET = 10;

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
    const bucket = index.get(target);
    if (bucket) bucket.push(ref);
    else index.set(target, [ref]);
  }
  return index;
}

export function CommitList({ preview, selectedOid, onSelect, captureSelectionIntent, selectIfCurrent, onCancel, onRetry, onRetryPage, onCancelPage, onLoadWindowEdge, onPrefetchPreviousPage, onPrefetchNextPage, onViewportAnchor, restorationAnchor, onSetAnchorRestorationSpace, activityDays, activityDaysPartial, activityDaysTruncated, onLocateHistoryDate, onLocateHistoryTime, onScrubbingChange, onJumpToNewest, onOpenHandoff, onCancelHistoryDate, onRetryHistoryDate }: {
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
  activityDays?: HistoryTimeSliderDay[] | null;
  activityDaysPartial?: boolean;
  /** Statistics kept only the newest days; older history is outside the rail. */
  activityDaysTruncated?: boolean;
  onLocateHistoryDate(day: string): Promise<boolean>;
  /** Jumps to the latest commit before `beforeSeconds` (Unix seconds, exclusive). */
  onLocateHistoryTime(beforeSeconds: number): Promise<boolean>;
  /** The time slider is being dragged; selections change rapidly until it reports false. */
  onScrubbingChange?(scrubbing: boolean): void;
  /** Loads the newest page when it is no longer in the window; resolves true once it is. */
  onJumpToNewest(): Promise<boolean>;
  /** Hands the commits new since the last visit to an agent for review. */
  onOpenHandoff?(request: HandoffRequest): void;
  onCancelHistoryDate(): Promise<void>;
  onRetryHistoryDate(): Promise<void>;
}): React.JSX.Element {
  const listRef = React.useRef<HTMLDivElement>(null);
  const frameRef = React.useRef(0);
  const lastScrollTop = React.useRef(0);
  const latestScrollDirection = React.useRef<"up" | "down" | null>(null);
  const scrollSample = React.useRef<{ top: number; at: number; direction: "up" | "down" } | null>(null);
  const scrollVelocity = React.useRef(0);
  const programmaticScrollTop = React.useRef<number | null>(null);
  const cancelingPrefetch = React.useRef(false);
  const pendingAnchor = React.useRef<{ oid: string; offset: number; repoId: string; generation: string } | undefined>(undefined);
  const pendingPrefetchCompletion = React.useRef<{ sessionKey: string; direction: "up" | "down"; pageRevision: number } | null>(null);
  const resetScrollSpeed = React.useCallback(() => {
    scrollSample.current = null;
    scrollVelocity.current = 0;
  }, []);
  const entries = React.useMemo(() => buildEntries(preview.commits,
    preview.newSinceLastSeenStatus === "ready" ? preview.lastSeenDividerOid : null),
  [preview.commits, preview.lastSeenDividerOid, preview.newSinceLastSeenStatus]);
  const virtual = React.useMemo(() => createVirtualLayout(entries), [entries]);
  const newSinceLastVisit = React.useMemo(() => {
    const divider = entries.find(entry => entry.kind === "divider");
    if (!divider) return null;
    const index = preview.commits.findIndex(commit => `last-seen-${commit.oid}` === divider.key);
    return index > 0 ? preview.commits.slice(0, index).map(commit => ({ oid: commit.oid, summary: commit.summary })) : null;
  }, [entries, preview.commits]);
  const dayMarkers = React.useMemo<DayMarker[]>(() => entries.flatMap(entry =>
    entry.kind === "day" ? [{ offset: virtual.offset(entry.key) ?? 0, label: entry.label, day: entry.dayKey }] : []), [entries, virtual]);
  const latestSelectedOid = React.useRef(selectedOid);
  latestSelectedOid.current = selectedOid;
  const latestScrollModel = React.useRef({ preview, entries, virtual, onCancelPage, onPrefetchPreviousPage, onPrefetchNextPage, onViewportAnchor });
  latestScrollModel.current = { preview, entries, virtual, onCancelPage, onPrefetchPreviousPage, onPrefetchNextPage, onViewportAnchor };
  const [range, setRange] = React.useState<VirtualRange>(() => virtual.range(0, 600, 12));
  const [graphExpanded, setGraphExpanded] = React.useState(false);
  const [viewportDay, setViewportDay] = React.useState<string | null>(null);
  const [viewportSeconds, setViewportSeconds] = React.useState<number | null>(null);
  /** The time slider is being dragged; the list follows it without the locating notice. */
  const [scrubbing, setScrubbing] = React.useState(false);
  const viewportSessionKey = preview.session ? `${preview.session.repoId}:${preview.session.generation}` : null;
  const previousPageLoading = React.useRef(preview.pageLoading);
  const previousPageRequestKind = React.useRef(preview.pageRequestKind);
  const viewportSessionRef = React.useRef<string | null>(null);
  const lastRestoredPageRevision = React.useRef(0);
  const refIndex = React.useMemo(() => refsByTarget(preview.refs), [preview.refs]);
  const commitByOid = React.useMemo(() => new Map(preview.commits.map(commit => [commit.oid, commit])), [preview.commits]);
  const maxLaneInWindow = preview.commits.reduce((maxLane, commit) => Math.max(maxLane, maxGraphLane(commit.graph)), -1);
  const visibleLaneCount = graphExpanded ? Math.max(MAX_VISIBLE_LANES, maxLaneInWindow + 1) : MAX_VISIBLE_LANES;
  // Compact mode is only as wide as the lanes this window uses (up to six), plus room for
  // the "+N" control when some lanes are hidden.
  const hasHiddenLanes = maxLaneInWindow >= MAX_VISIBLE_LANES || preview.commits.some(commit => commit.graph.hiddenLaneCount > 0);
  const graphColumnWidth = graphExpanded
    ? graphWidthForMaxLane(ROW, visibleLaneCount - 1)
    : hasHiddenLanes ? graphColumnX() + HIDDEN_LANES_GUTTER : graphWidthForMaxLane(ROW, Math.max(0, maxLaneInWindow));
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
  const useActivityDays = Boolean(activityDays?.length);
  const loadedDateDays = React.useMemo(() => {
    if (useActivityDays) return [];
    const counts = new Map<string, number>();
    for (const commit of preview.commits) {
      const date = parseGitTime(commit.committer.timestamp);
      if (!date) continue;
      const day = localDateInput(date);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return [...counts].map(([day, count]) => ({ day, count })).sort((a, b) => b.day.localeCompare(a.day));
  }, [preview.commits, useActivityDays]);
  const timeRailDays = useActivityDays ? activityDays! : loadedDateDays;
  const timeRailLoading = preview.pageLoading && preview.pageRequestKind === "dateLocation";
  React.useEffect(() => {
    const firstDate = preview.commits[0] ? parseGitTime(preview.commits[0].committer.timestamp) : null;
    if (viewportSessionRef.current !== viewportSessionKey) {
      viewportSessionRef.current = viewportSessionKey;
      setViewportDay(firstDate ? localDateInput(firstDate) : null);
      setViewportSeconds(firstDate ? Math.floor(firstDate.getTime() / 1000) : null);
    } else if (viewportDay === null && firstDate) {
      setViewportDay(localDateInput(firstDate));
      setViewportSeconds(Math.floor(firstDate.getTime() / 1000));
    }
  }, [preview.commits, viewportDay, viewportSessionKey]);
  const visibleEntries = entries.slice(range.start, range.end);
  const activeDescendant = selectedOid && visibleEntries.some(entry => entry.kind === "commit" && entry.commit.oid === selectedOid)
    ? rowId(selectedOid) : undefined;

  const updateRange = React.useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    setRange(virtual.range(element.scrollTop, element.clientHeight, 12));
  }, [virtual]);

  const maybePrefetch = React.useCallback((element: HTMLDivElement, direction: "up" | "down") => {
    const model = latestScrollModel.current;
    const session = model.preview.session;
    if (!session || model.preview.state !== "ready" || model.preview.opening !== null || model.preview.scopeSwitching ||
      model.preview.pageLoading || model.preview.refreshing) return;
    const threshold = historyPrefetchDistance(element.clientHeight, scrollVelocity.current);
    const nearEdge = direction === "up"
      ? element.scrollTop <= threshold
      : element.scrollHeight - element.clientHeight - element.scrollTop <= threshold;
    const cursor = direction === "up" ? model.preview.windowPreviousCursor : model.preview.windowNextCursor;
    if (!nearEdge || !cursor) return;
    pendingAnchor.current = captureWindowAnchor(element, session, model.entries, model.virtual);
    pendingPrefetchCompletion.current = {
      sessionKey: `${session.repoId}:${session.generation}`,
      direction,
      pageRevision: model.preview.pageRevision,
    };
    if (direction === "up") model.onPrefetchPreviousPage();
    else model.onPrefetchNextPage();
  }, []);

  React.useLayoutEffect(() => {
    scrollSample.current = null;
    scrollVelocity.current = 0;
    latestScrollDirection.current = null;
    lastScrollTop.current = listRef.current?.scrollTop ?? 0;
    programmaticScrollTop.current = null;
    pendingAnchor.current = undefined;
    pendingPrefetchCompletion.current = null;
    previousPageLoading.current = preview.pageLoading;
    previousPageRequestKind.current = preview.pageRequestKind;
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }, [viewportSessionKey]);

  React.useEffect(() => {
    const wasLoading = previousPageLoading.current;
    const completedKind = previousPageRequestKind.current;
    previousPageLoading.current = preview.pageLoading;
    previousPageRequestKind.current = preview.pageRequestKind;
    if (preview.pageLoading && preview.pageRequestKind !== "prefetch") {
      pendingPrefetchCompletion.current = null;
      return;
    }
    if (!wasLoading || preview.pageLoading) return;
    const pending = pendingPrefetchCompletion.current;
    if (!pending) return;
    pendingPrefetchCompletion.current = null;
    if (completedKind !== "prefetch" || preview.pageRevision <= pending.pageRevision || preview.pageError ||
      viewportSessionKey !== pending.sessionKey || latestScrollDirection.current !== pending.direction) return;
    const frame = requestAnimationFrame(() => {
      const element = listRef.current;
      const session = latestScrollModel.current.preview.session;
      const currentSessionKey = session ? `${session.repoId}:${session.generation}` : null;
      if (element && currentSessionKey === pending.sessionKey && latestScrollDirection.current === pending.direction) {
        maybePrefetch(element, pending.direction);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [maybePrefetch, preview.pageError, preview.pageLoading, preview.pageRequestKind, preview.pageRevision, viewportSessionKey]);

  // High-frequency scroll position lives in refs; one frame computes the visible window.
  const handleScroll = () => {
    const element = listRef.current;
    if (!element) return;
    const nextTop = element.scrollTop;
    const expectedTop = programmaticScrollTop.current;
    const isProgrammatic = expectedTop !== null && Math.abs(expectedTop - nextTop) < 1;
    programmaticScrollTop.current = null;
    const direction = isProgrammatic ? null : nextTop > lastScrollTop.current ? "down" : nextTop < lastScrollTop.current ? "up" : null;
    const now = performance.now();
    const sample = scrollSample.current;
    if (isProgrammatic || !direction || !sample || sample.direction !== direction) {
      scrollVelocity.current = 0;
    } else {
      const elapsed = now - sample.at;
      if (elapsed > 0 && elapsed <= 250) {
        const instantaneous = Math.abs(nextTop - sample.top) * 1000 / elapsed;
        scrollVelocity.current = scrollVelocity.current * 0.65 + instantaneous * 0.35;
      } else {
        scrollVelocity.current = 0;
      }
    }
    scrollSample.current = direction ? { top: nextTop, at: now, direction } : null;
    if (!isProgrammatic) latestScrollDirection.current = direction;
    lastScrollTop.current = nextTop;
    if (preview.session) {
      const anchor = captureWindowAnchor(element, preview.session, entries, virtual);
      if (anchor) {
        pendingAnchor.current = anchor;
        onViewportAnchor(anchor.oid);
        const commit = commitByOid.get(anchor.oid);
        const date = commit ? parseGitTime(commit.committer.timestamp) : null;
        const day = date ? localDateInput(date) : null;
        setViewportDay(current => current === day ? current : day);
        const seconds = date ? Math.floor(date.getTime() / 1000) : null;
        setViewportSeconds(current => current === seconds ? current : seconds);
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
            maybePrefetch(latest, direction);
          });
        }
        return;
      }
      maybePrefetch(current, direction);
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
    resetScrollSpeed();
    programmaticScrollTop.current = target;
    element.scrollTop = target;
    lastScrollTop.current = element.scrollTop;
    onViewportAnchor(anchor.oid);
    setRange(virtual.range(element.scrollTop, element.clientHeight, 12));
  }, [preview.windowRevision, preview.session, onViewportAnchor, virtual, resetScrollSpeed]);

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
    resetScrollSpeed();
    programmaticScrollTop.current = target;
    element.scrollTop = target;
    lastScrollTop.current = target;
    onViewportAnchor(anchor.oid);
    setRange(virtual.range(target, element.clientHeight, 12));
    lastRestoredPageRevision.current = preview.pageRevision;
  }, [preview.pageRevision, preview.anchorMissing, preview.anchorRestorationSpace, restorationAnchor, onSetAnchorRestorationSpace, onViewportAnchor, virtual, resetScrollSpeed]);

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
      resetScrollSpeed();
      programmaticScrollTop.current = target;
      element.scrollTop = target;
      lastScrollTop.current = target;
      onViewportAnchor(selectedOid);
      setRange(virtual.range(target, element.clientHeight, 12));
    }
  }, [selectedOid, resetScrollSpeed]);

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

  // A date jump puts the selected commit at the top of the list, right under the pinned date.
  // It runs once the new selection has rendered (or on the next frames if the selection did not change).
  const pendingDateJump = React.useRef(false);
  const placeDateJump = React.useCallback(() => {
    if (!pendingDateJump.current) return;
    const element = listRef.current;
    const oid = latestSelectedOid.current;
    const offset = oid ? latestScrollModel.current.virtual.offset(oid) : undefined;
    if (!element || offset === undefined) return;
    pendingDateJump.current = false;
    resetScrollSpeed();
    element.scrollTop = Math.max(0, offset - DAY_ROW_HEIGHT);
    programmaticScrollTop.current = element.scrollTop;
    lastScrollTop.current = element.scrollTop;
    setRange(latestScrollModel.current.virtual.range(element.scrollTop, element.clientHeight, 12));
  }, [resetScrollSpeed]);
  const jumpToDate = React.useCallback(async (day: string): Promise<boolean> => {
    pendingDateJump.current = false;
    const found = await onLocateHistoryDate(day);
    if (found) {
      pendingDateJump.current = true;
      requestAnimationFrame(() => requestAnimationFrame(placeDateJump));
    }
    return found;
  }, [onLocateHistoryDate, placeDateJump]);
  const jumpToTime = React.useCallback(async (beforeSeconds: number): Promise<boolean> => {
    pendingDateJump.current = false;
    const found = await onLocateHistoryTime(beforeSeconds);
    if (found) {
      pendingDateJump.current = true;
      requestAnimationFrame(() => requestAnimationFrame(placeDateJump));
    }
    return found;
  }, [onLocateHistoryTime, placeDateJump]);
  // Back to the newest commit: scroll up when it is still loaded, otherwise load its page first.
  const atNewest = preview.windowPreviousCursor === null;
  const goNewest = React.useCallback(async () => {
    const element = listRef.current;
    if (!element) return;
    if (atNewest) {
      resetScrollSpeed();
      latestScrollDirection.current = null;
      element.scrollTo({ top: 0, behavior: element.scrollTop > element.clientHeight * 6 ? "auto" : "smooth" });
      return;
    }
    pendingDateJump.current = false;
    if (!await onJumpToNewest()) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      resetScrollSpeed();
      latestScrollDirection.current = null;
      list.scrollTop = 0;
      programmaticScrollTop.current = 0;
      lastScrollTop.current = 0;
      setRange(latestScrollModel.current.virtual.range(0, list.clientHeight, 12));
    }));
  }, [atNewest, onJumpToNewest, resetScrollSpeed]);
  // Declared after the keep-selected-visible effect so the jump placement wins.
  React.useLayoutEffect(() => { placeDateJump(); }, [selectedOid, virtual, placeDateJump]);

  const collapseGraph = () => {
    if (listRef.current) {
      listRef.current.scrollLeft = 0;
      listRef.current.focus({ preventScroll: true });
    }
    setGraphExpanded(false);
  };


  const loadingEmpty = preview.state === "loading" && preview.commits.length === 0;
  const finishedEmpty = preview.state === "ready" && preview.commits.length === 0;
  const interrupted = (preview.state === "error" || preview.state === "cancelled") && preview.commits.length > 0;
  const reachedEnd = preview.commits.length > 0 && preview.windowNextCursor === null && preview.state === "ready"
    && preview.opening === null && !preview.pageLoading && !preview.refreshing && !preview.scopeSwitching
    && !preview.pageError;

  return <nav aria-label="提交列表" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    {preview.error && preview.repository ? <div role="alert" className="mx-2 mb-2 flex items-start gap-2 rounded-[10px] border border-bad-line bg-bad-bg px-3 py-2.5 text-[13px]">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-bad" strokeWidth={1.75} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col"><span className="font-semibold text-bad">{errorTitle(preview.error.code)}</span><span className="break-words text-fg2">{preview.error.message} <code className="font-mono text-xs text-fg3">{preview.error.code}</code></span></span>
      {preview.session ? <Button variant="outline" size="sm" className="shrink-0" onClick={() => { void onRetry(); }}>重试</Button> : null}
    </div> : null}

    {preview.pageError ? <div role="alert" data-testid={preview.pageErrorKind === "dateLocation" ? "history-date-location-error" : undefined}
      className="mx-2 mb-2 flex items-start gap-2 rounded-[10px] border border-bad-line bg-bad-bg px-3 py-2.5 text-[13px]">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-bad" strokeWidth={1.75} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col"><span className="font-semibold text-bad">{preview.pageErrorKind === "refresh" ? "刷新失败" : preview.pageErrorKind === "dateLocation" ? "日期定位失败" : preview.pageErrorKind === "location" ? "历史定位失败" : "历史页读取失败"}</span><span className="break-words text-fg2">{preview.pageErrorKind === "dateLocation" && preview.pageError.code === "SCOPE_UNAVAILABLE" ? "该日期及之前没有提交。" : preview.pageErrorKind === "location" && preview.pageError.code === "SCOPE_UNAVAILABLE" ? "提交不在当前快照范围内。" : preview.pageError.message} <code className="font-mono text-xs text-fg3">{preview.pageError.code}</code></span></span>
      {!preview.refreshing ? <Button variant="outline" size="sm" className="shrink-0" onClick={() => { void (preview.pageErrorKind === "dateLocation" ? onRetryHistoryDate() : onRetryPage()); }}>{preview.pageErrorKind === "location" || preview.pageErrorKind === "dateLocation" ? "重试定位" : "重试"}</Button> : null}
    </div> : null}

    {preview.pageLoading && preview.commits.length > 0 && !(timeRailLoading && scrubbing) ? <div role="status" className="absolute inset-x-2 bottom-2 z-10 flex items-center gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-xs text-fg3 shadow-pop">
      <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <span className="flex-1">{timeRailLoading ? "正在定位日期…" : "正在加载更多提交…"}</span>
      <Button variant="outline" size="sm" onClick={() => { void (timeRailLoading ? onCancelHistoryDate() : onCancelPage()); }}>{timeRailLoading ? "取消定位" : "取消"}</Button>
    </div> : null}


    <div className="relative flex min-h-0 flex-1">
    <div className="relative flex min-h-0 min-w-0 flex-1">
    <HistoryDayStrip listRef={listRef} markers={dayMarkers} days={timeRailDays} atNewest={atNewest} onJumpToNewest={() => void goNewest()} rowHeight={DAY_ROW_HEIGHT} textLeft={graphColumnWidth + 24 + TEXT_INSET}
      graphLaneCount={graphExpanded ? visibleLaneCount : null} onCollapseGraph={collapseGraph} onChooseDate={jumpToDate} />
    <div ref={listRef} role="listbox" aria-label="提交" tabIndex={0} aria-activedescendant={activeDescendant} aria-busy={preview.pageLoading}
      data-graph-expanded={graphExpanded ? "true" : "false"} data-visible-graph-lanes={visibleLaneCount}
      data-page-loading={preview.pageLoading ? "true" : "false"} data-loaded-offset={preview.pageOffset ?? 0}
      data-loaded-count={preview.commits.length} data-window-pages={preview.windowPageCount}
      className={cn("min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain px-2 pb-6 outline-none",
        // The time slider marks the position; keep only the horizontal scrollbar for the expanded graph.
        "[&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-line2")}
      style={{ overflowAnchor: "none" }} onScroll={handleScroll}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Escape" && graphExpanded) {
          event.preventDefault();
          collapseGraph();
          return;
        }
        // Home and ⌘↑ go to the newest commit even when its page is no longer loaded.
        if ((event.key === "Home" && !atNewest) || (event.metaKey && event.key === "ArrowUp")) {
          event.preventDefault();
          void goNewest();
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
        : entry.kind === "divider" ? <LastSeenDivider key={entry.key} graph={entry.graph} width={graphColumnWidth} expanded={graphExpanded} visibleLaneCount={visibleLaneCount} contentMinWidth={expandedContentMinWidth}
          newCount={newSinceLastVisit?.length ?? 0}
          onReview={onOpenHandoff && newSinceLastVisit ? () => onOpenHandoff({ scenario: "review-range", target: {
            kind: "commits", commits: newSinceLastVisit, complete: preview.windowPreviousCursor === null, reason: "new",
          } }) : undefined} />
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
    {preview.commits.length ? <HistoryTimeSlider days={timeRailDays}
      partial={!useActivityDays || activityDaysPartial ? "counting" : activityDaysTruncated ? "truncated" : false}
      sessionKey={viewportSessionKey} viewportSeconds={viewportSeconds} loading={timeRailLoading} onChooseTime={jumpToTime}
      onScrubbingChange={value => { setScrubbing(value); onScrubbingChange?.(value); }} /> : null}
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
  const drawnWidth = expanded ? width : Math.min(overflowX, width);
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
    <span className="flex flex-1 items-end justify-between pb-1.5 text-xs" style={{ paddingLeft: TEXT_INSET }}>
      <span className="font-semibold text-fg2">{entry.label}</span>
    </span>
  </div>;
}

function LastSeenDivider({ graph, width, expanded, visibleLaneCount, contentMinWidth, newCount, onReview }: {
  graph: HistoryCommit["graph"]; width: number; expanded: boolean; visibleLaneCount: number; contentMinWidth?: number;
  newCount: number;
  onReview?(): void;
}): React.JSX.Element {
  const lanes = expanded ? graphAboveLanes(graph) : lanesInMask(graph.above);
  // A group rather than a separator: it holds the review action.
  return <div role="group" aria-label="上次看到这里" data-testid="history-divider" data-marker-kind="last-seen"
    className="flex items-center gap-2 pr-3 pl-2 text-[11px] text-fg3" style={{ height: DAY_ROW_HEIGHT, minWidth: contentMinWidth }}>
    <GraphLanes width={width} height={DAY_ROW_HEIGHT} lanes={lanes} expanded={expanded} visibleLaneCount={visibleLaneCount} testId="graph-last-seen-bridge" />
    <span className="h-px flex-1 bg-line" />
    <span>上次看到这里</span>
    {onReview && newCount > 0 ? <button type="button" data-testid="handoff-new-commits"
      className="rounded-md px-1.5 py-0.5 text-[11px] text-accent-fg hover:bg-hover"
      title={`把上面 ${newCount} 个新提交交给 Agent 审阅`} onClick={onReview}>交给 Agent 审阅这 {newCount} 个</button> : null}
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
    data-testid="commit-row" data-oid={commit.oid} data-commit-day={date ? dayKey(date) : undefined}
    title={[
      commit.graph.boundary ? "历史边界（浅克隆或父关系调整）" : undefined,
      !expanded && commit.graph.lane >= MAX_VISIBLE_LANES ? "此提交位于未显示的图线中" : undefined,
      !expanded && commit.graph.hiddenLaneCount > 0 ? `另有 ${commit.graph.hiddenLaneCount} 条图线未显示` : undefined,
    ].filter(Boolean).join("；") || undefined}
    onClick={onSelect}
    style={{ minWidth: contentMinWidth }}
    className={cn(
      // Hover and selection colour only the text card, so graph lines run on uninterrupted.
      "group flex h-[60px] cursor-default items-stretch gap-2 pr-1 pl-2 outline-none",
    )}>
    <GraphLanes graph={commit.graph} width={graphWidth} height={ROW.rowHeight} expanded={expanded} visibleLaneCount={visibleLaneCount} onExpand={onExpandGraph} isHead={isHead} />
    <span className={cn("flex min-w-0 flex-1 flex-col justify-center gap-1 rounded-[10px] pr-2.5",
      "group-hover:bg-hover group-focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]",
      selected && "bg-panel shadow-selected group-hover:bg-panel")} style={{ paddingLeft: TEXT_INSET }}>
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
