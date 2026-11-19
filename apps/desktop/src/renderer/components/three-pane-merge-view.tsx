import * as React from "react";
import { ArrowDown, ArrowUp, Check, RotateCcw, X } from "lucide-react";
import type { MergePreviewResult, ResolvedMergeFile } from "../../../../../packages/protocol/src/repository-session.js";
import { changedSegments } from "../lib/diff-model.js";
import { shortRefName } from "../lib/format.js";
import { divergedUpdateRequest, type HandoffOperationRepository } from "../lib/handoff-prompt.js";
import type { DivergedSyncTarget } from "../lib/operations.js";
import {
  acceptChunkSide,
  buildThreeWayMergeModel,
  countUnresolvedConflicts,
  ignoreChunkSide,
  resetChunk,
  resolveAllConflictsWithSide,
  serializeMergedText,
  updateChunkCenterText,
  type ThreeWayChunk,
  type ThreeWayMergeModel,
} from "../lib/three-way-merge.js";
import type { HandoffRequest } from "./handoff-dialog.js";
import { Button } from "./ui/button.js";

export interface ThreePaneMergeSession {
  target: DivergedSyncTarget;
  preview: Extract<MergePreviewResult, { outcome: "conflicted" }>;
}

interface MeasuredBand {
  chunkId: string;
  kind: ThreeWayChunk["kind"];
  resolved: boolean;
  conflictIndex: number | null;
  acceptedLeft: boolean;
  acceptedRight: boolean;
  ignoredLeft: boolean;
  ignoredRight: boolean;
  leftTop: number;
  leftBottom: number;
  centerTop: number;
  centerBottom: number;
  rightTop: number;
  rightBottom: number;
}

const GUTTER_WIDTH = 48;

function bezierRibbon(leftTop: number, leftBottom: number, rightTop: number, rightBottom: number): string {
  const c1 = GUTTER_WIDTH * 0.45;
  const c2 = GUTTER_WIDTH * 0.55;
  const lt = leftTop;
  const lb = Math.max(lt + 4, leftBottom);
  const rt = rightTop;
  const rb = Math.max(rt + 4, rightBottom);
  return `M 0,${lt} C ${c1},${lt} ${c2},${rt} ${GUTTER_WIDTH},${rt} L ${GUTTER_WIDTH},${rb} C ${c2},${rb} ${c1},${lb} 0,${lb} Z`;
}

function bandColors(kind: ThreeWayChunk["kind"], resolved: boolean): { fill: string; stroke: string } {
  if (kind === "conflict") {
    return resolved
      ? { fill: "var(--add-bg)", stroke: "var(--ok)" }
      : { fill: "var(--warn-bg)", stroke: "var(--warn)" };
  }
  if (kind === "auto-left" || kind === "auto-right" || kind === "auto-both") {
    return { fill: "var(--accent-soft)", stroke: "var(--accent)" };
  }
  return { fill: "transparent", stroke: "transparent" };
}

function renderInlineHighlightedLine(line: string, counterpart: string | undefined): React.ReactNode {
  if (counterpart === undefined || line === counterpart) {
    return line || "\u00a0";
  }
  const pair = changedSegments(counterpart, line);
  if (!pair) return line || "\u00a0";
  return pair[1].map((seg, idx) =>
    seg.changed ? (
      <mark key={idx} className="rounded-[2px] bg-warn/25 px-px text-inherit">
        {seg.text}
      </mark>
    ) : (
      <React.Fragment key={idx}>{seg.text}</React.Fragment>
    ),
  );
}

function chunkSurfaceClass(kind: ThreeWayChunk["kind"], resolved: boolean, side: "left" | "right"): string {
  if (kind === "common") return "";
  if (kind === "conflict") {
    if (resolved) return "border-y border-ok/30 bg-add-bg/65";
    return side === "left"
      ? "border-y border-warn-line bg-warn-bg/85"
      : "border-y border-warn-line bg-warn-bg/85";
  }
  if (kind === "auto-left") return side === "left" ? "border-y border-accent/25 bg-accent-soft/50" : "border-y border-line/50 bg-sunken/40";
  if (kind === "auto-right") return side === "right" ? "border-y border-accent/25 bg-accent-soft/50" : "border-y border-line/50 bg-sunken/40";
  return "border-y border-ok/20 bg-add-bg/40";
}

function centerChunkSurfaceClass(kind: ThreeWayChunk["kind"], resolved: boolean): string {
  if (kind === "common") return "";
  if (kind === "conflict") {
    return resolved
      ? "border-y border-ok/40 bg-ok-bg/45"
      : "border-y border-warn-line bg-warn-bg/65";
  }
  return "border-y border-accent/30 bg-accent-soft/35";
}

function centerChunkBadgeText(chunk: ThreeWayChunk, conflictIndex: number | null): string {
  if (chunk.kind === "conflict") {
    const label = conflictIndex !== null ? `冲突 #${conflictIndex + 1}` : "冲突";
    if (!chunk.resolved) return `${label} · 待选择`;
    if (chunk.acceptedLeft && chunk.acceptedRight) return `${label} · 已顺序合并双边`;
    if (chunk.acceptedLeft) return `${label} · 已采用左侧`;
    if (chunk.acceptedRight) return `${label} · 已采用右侧`;
    if (chunk.manuallyEdited) return `${label} · 已手动编辑`;
    return `${label} · 已保留共同祖先`;
  }
  if (chunk.kind === "auto-left") return "已自动合入左侧改动";
  if (chunk.kind === "auto-right") return "已自动合入右侧改动";
  if (chunk.kind === "auto-both") return "双方相同改动 · 已自动合并";
  return "";
}

export function ThreePaneMergeView({
  session,
  headOid,
  repository,
  busy,
  onSubmit,
  onHandoff,
  onCancel,
}: {
  session: ThreePaneMergeSession;
  headOid: string | null;
  repository: HandoffOperationRepository;
  busy: boolean;
  onSubmit(params: {
    targetRef: string;
    expectedTargetOid: string;
    sourceRef: string;
    expectedSourceOid: string;
    expectedHeadOid: string | null;
    mode: "mergeCommit";
    message: string;
    resolvedFiles: ResolvedMergeFile[];
    switchToTarget: boolean;
    pushAfter: boolean;
    pushRemote: string | null;
  }): Promise<boolean>;
  onHandoff(request: HandoffRequest): void;
  onCancel(): void;
}): React.JSX.Element {
  const [models, setModels] = React.useState<ThreeWayMergeModel[]>(() =>
    session.preview.files.map(file => buildThreeWayMergeModel(file)),
  );
  const [activeFileIndex, setActiveFileIndex] = React.useState(0);
  const [message, setMessage] = React.useState(session.preview.defaultMessage);
  const [pushAfter, setPushAfter] = React.useState(session.target.defaultPushAfter);
  const [submitting, setSubmitting] = React.useState(false);
  const [activeConflictCursor, setActiveConflictCursor] = React.useState(0);
  const [bands, setBands] = React.useState<MeasuredBand[]>([]);
  const [gutterHeight, setGutterHeight] = React.useState(0);

  const leftPaneRef = React.useRef<HTMLDivElement>(null);
  const centerPaneRef = React.useRef<HTMLDivElement>(null);
  const rightPaneRef = React.useRef<HTMLDivElement>(null);
  const leftGutterRef = React.useRef<HTMLDivElement>(null);
  const rightGutterRef = React.useRef<HTMLDivElement>(null);
  const syncingScrollRef = React.useRef<"left" | "center" | "right" | null>(null);
  const measureRafRef = React.useRef<number | null>(null);

  const sessionKey = `${session.target.targetRef}:${session.target.expectedTargetOid}:${session.target.sourceRef}:${session.target.expectedSourceOid}`;
  React.useEffect(() => {
    setModels(session.preview.files.map(file => buildThreeWayMergeModel(file)));
    setActiveFileIndex(0);
    setMessage(session.preview.defaultMessage);
    setPushAfter(session.target.defaultPushAfter);
    setSubmitting(false);
    setActiveConflictCursor(0);
  }, [session, sessionKey]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || submitting) return;
      const target = event.target;
      if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName)) {
        target.blur();
        return;
      }
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, submitting]);

  const activeModel = models[activeFileIndex] ?? models[0]!;
  const perFileUnresolved = React.useMemo(() => models.map(countUnresolvedConflicts), [models]);
  const totalUnresolved = React.useMemo(
    () => perFileUnresolved.reduce((sum, count) => sum + count, 0),
    [perFileUnresolved],
  );

  const allConflictLocations = React.useMemo(() => {
    const list: Array<{ fileIndex: number; chunkId: string; resolved: boolean }> = [];
    models.forEach((model, fileIndex) => {
      for (const chunk of model.chunks) {
        if (chunk.kind === "conflict") {
          list.push({ fileIndex, chunkId: chunk.id, resolved: chunk.resolved });
        }
      }
    });
    return list;
  }, [models]);

  const conflictIndexByChunkId = React.useMemo(() => {
    const map = new Map<string, number>();
    let idx = 0;
    for (const chunk of activeModel.chunks) {
      if (chunk.kind === "conflict") {
        map.set(chunk.id, idx++);
      }
    }
    return map;
  }, [activeModel]);

  const updateActiveModel = React.useCallback(
    (updater: (current: ThreeWayMergeModel) => ThreeWayMergeModel) => {
      setModels(prev => prev.map((item, idx) => (idx === activeFileIndex ? updater(item) : item)));
    },
    [activeFileIndex],
  );

  const measureLayout = React.useCallback(() => {
    const leftPane = leftPaneRef.current;
    const centerPane = centerPaneRef.current;
    const rightPane = rightPaneRef.current;
    const leftGutter = leftGutterRef.current;
    if (!leftPane || !centerPane || !rightPane || !leftGutter) return;

    const gutterRect = leftGutter.getBoundingClientRect();
    setGutterHeight(gutterRect.height);

    const nextBands: MeasuredBand[] = [];
    for (const chunk of activeModel.chunks) {
      if (chunk.kind === "common") continue;
      const lEl = leftPane.querySelector<HTMLElement>(`[data-merge-chunk="${chunk.id}"]`);
      const cEl = centerPane.querySelector<HTMLElement>(`[data-merge-chunk="${chunk.id}"]`);
      const rEl = rightPane.querySelector<HTMLElement>(`[data-merge-chunk="${chunk.id}"]`);
      if (!lEl || !cEl || !rEl) continue;
      const lRect = lEl.getBoundingClientRect();
      const cRect = cEl.getBoundingClientRect();
      const rRect = rEl.getBoundingClientRect();
      nextBands.push({
        chunkId: chunk.id,
        kind: chunk.kind,
        resolved: chunk.resolved,
        conflictIndex: conflictIndexByChunkId.get(chunk.id) ?? null,
        acceptedLeft: chunk.acceptedLeft,
        acceptedRight: chunk.acceptedRight,
        ignoredLeft: chunk.ignoredLeft,
        ignoredRight: chunk.ignoredRight,
        leftTop: lRect.top - gutterRect.top,
        leftBottom: lRect.bottom - gutterRect.top,
        centerTop: cRect.top - gutterRect.top,
        centerBottom: cRect.bottom - gutterRect.top,
        rightTop: rRect.top - gutterRect.top,
        rightBottom: rRect.bottom - gutterRect.top,
      });
    }
    setBands(prev => {
      if (
        prev.length === nextBands.length &&
        prev.every((b, idx) => {
          const n = nextBands[idx]!;
          return (
            b.chunkId === n.chunkId &&
            b.resolved === n.resolved &&
            b.acceptedLeft === n.acceptedLeft &&
            b.acceptedRight === n.acceptedRight &&
            b.ignoredLeft === n.ignoredLeft &&
            b.ignoredRight === n.ignoredRight &&
            Math.abs(b.leftTop - n.leftTop) < 0.5 &&
            Math.abs(b.leftBottom - n.leftBottom) < 0.5 &&
            Math.abs(b.centerTop - n.centerTop) < 0.5 &&
            Math.abs(b.centerBottom - n.centerBottom) < 0.5 &&
            Math.abs(b.rightTop - n.rightTop) < 0.5 &&
            Math.abs(b.rightBottom - n.rightBottom) < 0.5
          );
        })
      ) {
        return prev;
      }
      return nextBands;
    });
  }, [activeModel, conflictIndexByChunkId]);

  const scheduleMeasure = React.useCallback(() => {
    if (measureRafRef.current !== null) return;
    measureRafRef.current = requestAnimationFrame(() => {
      measureRafRef.current = null;
      measureLayout();
    });
  }, [measureLayout]);

  React.useLayoutEffect(() => {
    measureLayout();
  }, [measureLayout]);

  React.useEffect(() => {
    const leftPane = leftPaneRef.current;
    const centerPane = centerPaneRef.current;
    const rightPane = rightPaneRef.current;
    if (!leftPane || !centerPane || !rightPane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => scheduleMeasure());
    observer.observe(leftPane);
    observer.observe(centerPane);
    observer.observe(rightPane);
    return () => observer.disconnect();
  }, [scheduleMeasure]);

  React.useEffect(() => {
    return () => {
      if (measureRafRef.current !== null) cancelAnimationFrame(measureRafRef.current);
    };
  }, []);

  const handlePaneScroll = (source: "left" | "center" | "right") => {
    if (syncingScrollRef.current && syncingScrollRef.current !== source) return;
    const panes = {
      left: leftPaneRef.current,
      center: centerPaneRef.current,
      right: rightPaneRef.current,
    };
    const active = panes[source];
    if (!active) return;
    const maxScroll = active.scrollHeight - active.clientHeight;
    const ratio = maxScroll > 0 ? active.scrollTop / maxScroll : 0;

    syncingScrollRef.current = source;
    for (const key of ["left", "center", "right"] as const) {
      if (key === source) continue;
      const other = panes[key];
      if (!other) continue;
      const otherMax = other.scrollHeight - other.clientHeight;
      if (otherMax > 0) other.scrollTop = ratio * otherMax;
    }
    requestAnimationFrame(() => {
      if (syncingScrollRef.current === source) syncingScrollRef.current = null;
      measureLayout();
    });
  };

  const scrollChunkIntoView = React.useCallback((chunkId: string) => {
    requestAnimationFrame(() => {
      const centerEl = centerPaneRef.current?.querySelector<HTMLElement>(`[data-merge-chunk="${chunkId}"]`);
      centerEl?.scrollIntoView({ block: "center" });
      scheduleMeasure();
    });
  }, [scheduleMeasure]);

  const jumpConflict = (delta: 1 | -1) => {
    if (allConflictLocations.length === 0) return;
    const unresolvedOnly = allConflictLocations.filter(item => !item.resolved);
    const pool = unresolvedOnly.length > 0 ? unresolvedOnly : allConflictLocations;
    const nextIdx = (activeConflictCursor + delta + pool.length) % pool.length;
    setActiveConflictCursor(nextIdx);
    const target = pool[nextIdx]!;
    if (target.fileIndex !== activeFileIndex) setActiveFileIndex(target.fileIndex);
    scrollChunkIntoView(target.chunkId);
  };

  const handleSubmit = async () => {
    if (busy || submitting || totalUnresolved > 0 || message.trim().length === 0) return;
    setSubmitting(true);
    try {
      const resolvedFiles: ResolvedMergeFile[] = models.map(model => ({
        pathHex: model.pathHex,
        mode: model.mode,
        contents: serializeMergedText(model),
      }));
      const ok = await onSubmit({
        targetRef: session.target.targetRef,
        expectedTargetOid: session.target.expectedTargetOid,
        sourceRef: session.target.sourceRef,
        expectedSourceOid: session.target.expectedSourceOid,
        expectedHeadOid: headOid,
        mode: "mergeCommit",
        message: message.trim(),
        resolvedFiles,
        switchToTarget: session.target.switchToTarget,
        pushAfter: session.target.canPushAfter && pushAfter,
        pushRemote: session.target.pushRemote,
      });
      if (ok) onCancel();
    } finally {
      setSubmitting(false);
    }
  };

  const handleHandoff = () => {
    const req = divergedUpdateRequest(
      repository,
      {
        step: "completeMerge",
        branch: { refName: session.target.targetRef, oid: session.target.expectedTargetOid },
        upstream: { refName: session.target.sourceRef, oid: session.target.expectedSourceOid },
        remote: session.target.pushRemote,
        checkedOutBy: repository.headReference === session.target.targetRef && repository.worktreePath
          ? [repository.worktreePath]
          : [],
      },
      {
        kind: "diverged",
        ahead: 1,
        behind: 1,
        localCommits: [],
        upstreamCommits: [],
        localCommitsTruncated: false,
        upstreamCommitsTruncated: false,
        overlapPaths: session.preview.files.map(file => file.path),
        overlapPathsTruncated: false,
      },
      Date.now(),
    );
    onCancel();
    onHandoff(req);
  };

  const targetShort = shortRefName(session.target.targetRef);
  const sourceShort = shortRefName(session.target.sourceRef);

  return (
    <section
      data-testid="three-pane-merge-view"
      aria-label="三栏冲突合并"
      className="absolute inset-0 z-40 flex min-h-0 flex-col bg-panel text-fg"
    >
      <header className="flex flex-col gap-2 border-b border-line bg-bg px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-[14px] font-semibold">
            三栏冲突合并 · {targetShort} ← {sourceShort}
          </strong>
          <span className="inline-flex items-center gap-1 rounded-md bg-ok-bg px-2 py-0.5 text-[11.5px] font-medium text-ok">
            <Check className="size-3" strokeWidth={2} aria-hidden="true" />
            仅内存编辑，提交前不改写仓库
          </span>
          <span
            data-testid="merge-unresolved-count"
            className={`rounded-md px-2 py-0.5 text-[12px] font-medium tabular-nums ${
              totalUnresolved > 0 ? "bg-warn-bg text-warn" : "bg-ok-bg text-ok"
            }`}
          >
            {totalUnresolved > 0 ? `剩余 ${totalUnresolved} 处冲突` : "全部冲突已解决"}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              data-testid="merge-prev-conflict"
              disabled={allConflictLocations.length === 0}
              onClick={() => jumpConflict(-1)}
            >
              <ArrowUp className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              上一处
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              data-testid="merge-next-conflict"
              disabled={allConflictLocations.length === 0}
              onClick={() => jumpConflict(1)}
            >
              <ArrowDown className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              下一处
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={countUnresolvedConflicts(activeModel) === 0 || submitting}
            onClick={() => updateActiveModel(model => resolveAllConflictsWithSide(model, "left"))}
          >
            本文件全部采用左侧
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={countUnresolvedConflicts(activeModel) === 0 || submitting}
            onClick={() => updateActiveModel(model => resolveAllConflictsWithSide(model, "right"))}
          >
            本文件全部采用右侧
          </Button>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="merge-handoff"
              disabled={submitting}
              onClick={handleHandoff}
            >
              交给 Agent…
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="merge-cancel"
              disabled={submitting}
              onClick={onCancel}
            >
              取消
            </Button>
            <Button
              size="sm"
              data-testid="merge-complete-submit"
              disabled={busy || submitting || totalUnresolved > 0 || message.trim().length === 0}
              onClick={() => { void handleSubmit(); }}
            >
              {session.target.canPushAfter && pushAfter ? "完成合并并推送" : "完成合并并提交"}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="tablist" aria-label="冲突文件">
            {models.map((model, idx) => {
              const unresolved = perFileUnresolved[idx] ?? 0;
              const selected = idx === activeFileIndex;
              return (
                <button
                  key={model.pathHex}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  data-testid={`merge-file-tab-${idx}`}
                  onClick={() => setActiveFileIndex(idx)}
                  className={`flex max-w-[260px] items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
                    selected
                      ? "border-accent bg-accent-soft font-medium text-fg"
                      : "border-line bg-panel text-fg2 hover:bg-hover"
                  }`}
                >
                  <span className="truncate font-mono">{model.pathDisplay}</span>
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-px text-[10.5px] tabular-nums ${
                      unresolved > 0 ? "bg-warn-bg text-warn" : "bg-ok-bg text-ok"
                    }`}
                  >
                    {unresolved > 0 ? `${unresolved}` : "✓"}
                  </span>
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            <span className="shrink-0">提交说明</span>
            <input
              type="text"
              data-testid="merge-commit-message"
              value={message}
              disabled={submitting}
              onChange={event => setMessage(event.target.value)}
              className="h-7 w-[280px] rounded-md border border-line2 bg-panel px-2 font-mono text-xs text-fg focus:border-accent focus:outline-none"
            />
          </label>
          {session.target.canPushAfter ? (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-fg select-none">
              <input
                type="checkbox"
                data-testid="merge-push-after"
                checked={pushAfter}
                disabled={busy || submitting}
                onChange={event => setPushAfter(event.target.checked)}
                className="size-3.5 rounded border-line2 accent-[var(--accent)]"
              />
              <span>提交后立即推送</span>
            </label>
          ) : null}
        </div>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)_48px_minmax(0,1.1fr)_48px_minmax(0,1fr)] border-b border-line bg-sunken text-[11.5px] font-medium text-fg2">
        <div className="truncate px-3 py-1.5">本分支 · {targetShort}（只读）</div>
        <div className="border-x border-line px-1 py-1.5 text-center text-fg3" title="从左侧采用（顺序追加）">»</div>
        <div className="truncate px-3 py-1.5 font-mono text-fg">{activeModel.pathDisplay} · 合并结果（可编辑）</div>
        <div className="border-x border-line px-1 py-1.5 text-center text-fg3" title="从右侧采用（顺序追加）">«</div>
        <div className="truncate px-3 py-1.5">合入源 · {sourceShort}（只读）</div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_48px_minmax(0,1.1fr)_48px_minmax(0,1fr)] overflow-hidden">
        {/* Left Readonly Pane */}
        <div
          ref={leftPaneRef}
          data-testid="merge-pane-left"
          onScroll={() => handlePaneScroll("left")}
          className="min-h-0 overflow-auto bg-bg font-mono text-[12px] leading-[1.55]"
        >
          {activeModel.chunks.map(chunk => (
            <div
              key={chunk.id}
              data-merge-chunk={chunk.id}
              className={chunkSurfaceClass(chunk.kind, chunk.resolved, "left")}
            >
              {chunk.leftLines.length === 0 ? (
                chunk.kind !== "common" ? (
                  <div className="flex min-h-[26px] items-center px-3 text-[11px] italic text-fg3">
                    （本分支未新增 / 已删除）
                  </div>
                ) : null
              ) : (
                chunk.leftLines.map((line, i) => (
                  <div key={i} className="flex min-h-[20px] items-start hover:bg-hover/40">
                    <span className="w-11 shrink-0 select-none border-r border-line/60 pr-2 text-right text-[11px] text-fg3 tabular-nums">
                      {chunk.leftRange.start + i + 1}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre px-2.5">
                      {chunk.kind === "conflict"
                        ? renderInlineHighlightedLine(line, chunk.baseLines[i])
                        : (line || "\u00a0")}
                    </span>
                  </div>
                ))
              )}
            </div>
          ))}
        </div>

        {/* Left SVG + Action Gutter */}
        <div
          ref={leftGutterRef}
          data-testid="merge-gutter-left"
          className="relative overflow-hidden border-x border-line bg-sunken"
        >
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
            {bands.map(band => {
              const { fill, stroke } = bandColors(band.kind, band.resolved);
              return (
                <path
                  key={band.chunkId}
                  d={bezierRibbon(band.leftTop, band.leftBottom, band.centerTop, band.centerBottom)}
                  fill={fill}
                  stroke={stroke}
                  strokeOpacity={0.45}
                  strokeWidth={1}
                />
              );
            })}
          </svg>
          {bands.map(band => {
            if (
              band.kind !== "conflict" ||
              band.conflictIndex === null ||
              band.acceptedLeft ||
              band.ignoredLeft ||
              band.leftBottom < -4 ||
              band.leftTop > gutterHeight + 4
            ) {
              return null;
            }
            const top = Math.max(2, Math.min(band.leftTop + 2, Math.max(2, gutterHeight - 24)));
            return (
              <div
                key={band.chunkId}
                style={{ top }}
                className="pointer-events-auto absolute inset-x-0.5 z-10 flex items-center justify-center gap-0.5"
              >
                <button
                  type="button"
                  data-testid={`merge-accept-left-${band.conflictIndex}`}
                  title="采用左侧改动（若已采用右侧则顺序追加）"
                  aria-label={`采用冲突 #${band.conflictIndex + 1} 左侧改动`}
                  onClick={() => updateActiveModel(model => acceptChunkSide(model, band.chunkId, "left"))}
                  className="flex h-5 w-5 items-center justify-center rounded border border-line2 bg-panel text-[11px] font-bold text-fg hover:border-accent hover:bg-accent-soft"
                >
                  »
                </button>
                <button
                  type="button"
                  data-testid={`merge-ignore-left-${band.conflictIndex}`}
                  title="忽略左侧改动"
                  aria-label={`忽略冲突 #${band.conflictIndex + 1} 左侧改动`}
                  onClick={() => updateActiveModel(model => ignoreChunkSide(model, band.chunkId, "left"))}
                  className="flex h-5 w-4 items-center justify-center rounded border border-line2 bg-panel text-[11px] text-fg3 hover:border-bad hover:text-bad"
                >
                  <X className="size-2.5" strokeWidth={2} />
                </button>
              </div>
            );
          })}
        </div>

        {/* Center Editable Result Pane */}
        <div
          ref={centerPaneRef}
          data-testid="merge-pane-center"
          onScroll={() => handlePaneScroll("center")}
          className="min-h-0 overflow-auto bg-panel font-mono text-[12px] leading-[1.55]"
        >
          {activeModel.chunks.map(chunk => {
            const conflictIdx = conflictIndexByChunkId.get(chunk.id) ?? null;
            if (chunk.kind === "common") {
              return (
                <div key={chunk.id} data-merge-chunk={chunk.id}>
                  {chunk.centerLines.map((line, i) => (
                    <div key={i} className="flex min-h-[20px] items-start hover:bg-hover/30">
                      <span className="w-11 shrink-0 select-none border-r border-line/60 pr-2 text-right text-[11px] text-fg3 tabular-nums">
                        {chunk.centerRange.start + i + 1}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre px-2.5">{line || "\u00a0"}</span>
                    </div>
                  ))}
                </div>
              );
            }
            const showReset =
              chunk.kind === "conflict" &&
              (chunk.resolved || chunk.ignoredLeft || chunk.ignoredRight || chunk.manuallyEdited);
            return (
              <div
                key={chunk.id}
                data-merge-chunk={chunk.id}
                className={centerChunkSurfaceClass(chunk.kind, chunk.resolved)}
              >
                <div className="flex items-center justify-between gap-2 border-b border-line/50 px-2.5 py-0.5 font-sans text-[11px] text-fg2">
                  <span>{centerChunkBadgeText(chunk, conflictIdx)}</span>
                  {showReset && conflictIdx !== null ? (
                    <button
                      type="button"
                      data-testid={`merge-reset-chunk-${conflictIdx}`}
                      title="重置此冲突块到未解决状态"
                      aria-label={`重置冲突 #${conflictIdx + 1}`}
                      onClick={() => updateActiveModel(model => resetChunk(model, chunk.id))}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] text-fg3 hover:bg-hover hover:text-fg"
                    >
                      <RotateCcw className="size-3" strokeWidth={1.75} aria-hidden="true" />
                      重置
                    </button>
                  ) : null}
                </div>
                {chunk.kind === "conflict" && conflictIdx !== null ? (
                  <div className="flex items-stretch">
                    <div className="flex w-11 shrink-0 select-none flex-col border-r border-line/60 py-1 pr-2 text-right text-[11px] leading-[1.55] text-fg3 tabular-nums">
                      {Math.max(1, chunk.centerLines.length) > 0
                        ? Array.from({ length: Math.max(1, chunk.centerLines.length) }, (_, i) => (
                            <span key={i}>{chunk.centerRange.start + i + 1}</span>
                          ))
                        : null}
                    </div>
                    <textarea
                      data-testid={`merge-center-editor-${conflictIdx}`}
                      aria-label={`冲突 #${conflictIdx + 1} 合并结果编辑器`}
                      rows={Math.max(1, chunk.centerLines.length)}
                      value={chunk.centerLines.join("\n")}
                      disabled={submitting}
                      onChange={event => {
                        const text = event.target.value;
                        updateActiveModel(model => updateChunkCenterText(model, chunk.id, text));
                      }}
                      className="min-w-0 flex-1 resize-none border-0 bg-transparent px-2.5 py-1 font-mono text-[12px] leading-[1.55] text-fg focus:outline-none"
                    />
                  </div>
                ) : chunk.centerLines.length === 0 ? (
                  <div className="flex min-h-[22px] items-center px-3 text-[11px] italic text-fg3">
                    （已删除此段）
                  </div>
                ) : (
                  chunk.centerLines.map((line, i) => (
                    <div key={i} className="flex min-h-[20px] items-start">
                      <span className="w-11 shrink-0 select-none border-r border-line/60 pr-2 text-right text-[11px] text-fg3 tabular-nums">
                        {chunk.centerRange.start + i + 1}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre px-2.5">{line || "\u00a0"}</span>
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>

        {/* Right SVG + Action Gutter */}
        <div
          ref={rightGutterRef}
          data-testid="merge-gutter-right"
          className="relative overflow-hidden border-x border-line bg-sunken"
        >
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
            {bands.map(band => {
              const { fill, stroke } = bandColors(band.kind, band.resolved);
              return (
                <path
                  key={band.chunkId}
                  d={bezierRibbon(band.centerTop, band.centerBottom, band.rightTop, band.rightBottom)}
                  fill={fill}
                  stroke={stroke}
                  strokeOpacity={0.45}
                  strokeWidth={1}
                />
              );
            })}
          </svg>
          {bands.map(band => {
            if (
              band.kind !== "conflict" ||
              band.conflictIndex === null ||
              band.acceptedRight ||
              band.ignoredRight ||
              band.rightBottom < -4 ||
              band.rightTop > gutterHeight + 4
            ) {
              return null;
            }
            const top = Math.max(2, Math.min(band.rightTop + 2, Math.max(2, gutterHeight - 24)));
            return (
              <div
                key={band.chunkId}
                style={{ top }}
                className="pointer-events-auto absolute inset-x-0.5 z-10 flex items-center justify-center gap-0.5"
              >
                <button
                  type="button"
                  data-testid={`merge-accept-right-${band.conflictIndex}`}
                  title="采用右侧改动（若已采用左侧则顺序追加）"
                  aria-label={`采用冲突 #${band.conflictIndex + 1} 右侧改动`}
                  onClick={() => updateActiveModel(model => acceptChunkSide(model, band.chunkId, "right"))}
                  className="flex h-5 w-5 items-center justify-center rounded border border-line2 bg-panel text-[11px] font-bold text-fg hover:border-accent hover:bg-accent-soft"
                >
                  «
                </button>
                <button
                  type="button"
                  data-testid={`merge-ignore-right-${band.conflictIndex}`}
                  title="忽略右侧改动"
                  aria-label={`忽略冲突 #${band.conflictIndex + 1} 右侧改动`}
                  onClick={() => updateActiveModel(model => ignoreChunkSide(model, band.chunkId, "right"))}
                  className="flex h-5 w-4 items-center justify-center rounded border border-line2 bg-panel text-[11px] text-fg3 hover:border-bad hover:text-bad"
                >
                  <X className="size-2.5" strokeWidth={2} />
                </button>
              </div>
            );
          })}
        </div>

        {/* Right Readonly Pane */}
        <div
          ref={rightPaneRef}
          data-testid="merge-pane-right"
          onScroll={() => handlePaneScroll("right")}
          className="min-h-0 overflow-auto bg-bg font-mono text-[12px] leading-[1.55]"
        >
          {activeModel.chunks.map(chunk => (
            <div
              key={chunk.id}
              data-merge-chunk={chunk.id}
              className={chunkSurfaceClass(chunk.kind, chunk.resolved, "right")}
            >
              {chunk.rightLines.length === 0 ? (
                chunk.kind !== "common" ? (
                  <div className="flex min-h-[26px] items-center px-3 text-[11px] italic text-fg3">
                    （来源分支未新增 / 已删除）
                  </div>
                ) : null
              ) : (
                chunk.rightLines.map((line, i) => (
                  <div key={i} className="flex min-h-[20px] items-start hover:bg-hover/40">
                    <span className="w-11 shrink-0 select-none border-r border-line/60 pr-2 text-right text-[11px] text-fg3 tabular-nums">
                      {chunk.rightRange.start + i + 1}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre px-2.5">
                      {chunk.kind === "conflict"
                        ? renderInlineHighlightedLine(line, chunk.baseLines[i])
                        : (line || "\u00a0")}
                    </span>
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
