import * as React from "react";
import {
  basePosition, bucketIndexForDay, buildTimeScale, fisheye, magnificationFor, nearestActiveBucket, stepActiveBucket,
  type TimeBucket, type TimeScaleDay,
} from "../lib/time-scale.js";
import { cn } from "../lib/utils.js";

export type HistoryTimeRailDay = TimeScaleDay;

const PAD = 6;
/** Labels are shown for magnified buckets at least this far apart, within this distance of the focus. */
const LABEL_GAP = 13;
const LABEL_REACH = 120;

/**
 * Dense date ticks along the right edge of the history list, one per period with commits;
 * longer ticks mean more commits. Hovering spreads the ticks near the pointer apart and names
 * them; clicking (or dragging and releasing) jumps to the latest commit of that period.
 * Arrow keys, Page Up/Down, Home/End and Enter do the same from the keyboard.
 */
export function HistoryTimeRail({ days, partial, viewportDay, loading, sessionKey, onChooseDate }: {
  days: HistoryTimeRailDay[];
  /** The ticks only cover commits seen so far (statistics incomplete or not ready). */
  partial: boolean;
  viewportDay: string | null;
  loading: boolean;
  sessionKey: string | null;
  onChooseDate(day: string): Promise<boolean>;
}): React.JSX.Element {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState(0);
  const [pointerY, setPointerY] = React.useState<number | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [keyboardIndex, setKeyboardIndex] = React.useState<number | null>(null);
  const [pending, setPending] = React.useState<number | null>(null);
  const chooseIntent = React.useRef(0);

  React.useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const measure = () => setHeight(element.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    chooseIntent.current += 1;
    setPending(null);
    setPointerY(null);
    setKeyboardIndex(null);
  }, [sessionKey]);

  React.useEffect(() => { if (!loading) setPending(null); }, [loading]);

  const usable = Math.max(1, height - PAD * 2);
  const { buckets, granularity } = React.useMemo(() => buildTimeScale(days, usable), [days, usable]);
  const count = buckets.length;
  const magnification = magnificationFor(usable, count);
  const focus = pointerY !== null ? clamp01((pointerY - PAD) / usable)
    : keyboardIndex !== null ? basePosition(keyboardIndex, count) : null;
  const positions = React.useMemo(() => buckets.map((_, index) => {
    const base = basePosition(index, count);
    return focus === null ? base : fisheye(base, focus, magnification);
  }), [buckets, count, focus, magnification]);
  const target = pointerY !== null ? nearestActiveBucket(buckets, positions, focus!) : keyboardIndex;
  const current = bucketIndexForDay(buckets, viewportDay);
  const active = focus !== null && count > 0;
  const maxCount = Math.max(1, ...buckets.map(bucket => bucket.count));
  const y = (position: number) => PAD + position * usable;

  const choose = async (index: number | null) => {
    if (index === null || index < 0) return;
    const bucket = buckets[index];
    if (!bucket || bucket.count <= 0) return;
    const intent = ++chooseIntent.current;
    setPending(index);
    await onChooseDate(bucket.jumpDay);
    if (intent === chooseIntent.current) setPending(null);
  };

  const localY = (event: React.PointerEvent) => event.clientY - (rootRef.current?.getBoundingClientRect().top ?? 0);
  const firstActive = () => stepActiveBucket(buckets, current >= 0 ? current : 0, 0);
  const onKeyDown = (event: React.KeyboardEvent) => {
    const from = keyboardIndex ?? firstActive();
    const moves: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10, Home: -Infinity, End: Infinity };
    if (event.key in moves) {
      event.preventDefault();
      const steps = moves[event.key]!;
      setPointerY(null);
      setKeyboardIndex(keyboardIndex === null && Number.isFinite(steps) && Math.abs(steps) === 1 ? from
        : stepActiveBucket(buckets, from, Number.isFinite(steps) ? steps : steps > 0 ? count : -count));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void choose(from);
    } else if (event.key === "Escape" && keyboardIndex !== null) {
      event.preventDefault();
      setKeyboardIndex(null);
    }
  };

  const targetBucket = target !== null && target >= 0 ? buckets[target] : undefined;
  const valueBucket = targetBucket ?? (current >= 0 ? buckets[current] : undefined);
  const labelled = active ? labelledBuckets(buckets, positions, focus!, usable, target) : [];

  return <div ref={rootRef} data-testid="history-time-rail" data-granularity={granularity}
    className="relative z-20 h-full w-4 shrink-0 select-none">
    {active ? <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-full w-[180px] bg-gradient-to-l from-bg via-bg/95 to-transparent" /> : null}
    <div role="slider" tabIndex={count ? 0 : -1} aria-orientation="vertical" aria-label="按日期浏览历史"
      aria-valuemin={0} aria-valuemax={Math.max(0, count - 1)} aria-valuenow={Math.max(0, target ?? current)}
      aria-valuetext={valueBucket ? `${valueBucket.label}，${valueBucket.count} 个提交` : "没有可用日期"}
      aria-busy={pending !== null}
      data-testid="history-time-rail-slider"
      className={cn("absolute inset-y-0 right-0 cursor-pointer rounded-sm outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]",
        active ? "w-14" : "w-4")}
      onPointerMove={event => setPointerY(localY(event))}
      onPointerLeave={() => { if (!dragging) setPointerY(null); }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        setKeyboardIndex(null);
        setPointerY(localY(event));
      }}
      onPointerUp={event => {
        if (!dragging) return;
        setDragging(false);
        const hovered = nearestActiveBucket(buckets, positions, clamp01((localY(event) - PAD) / usable));
        void choose(hovered);
        const bounds = rootRef.current?.getBoundingClientRect();
        if (bounds && (event.clientX < bounds.left - 40 || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) setPointerY(null);
      }}
      onPointerCancel={() => { setDragging(false); setPointerY(null); }}
      onKeyDown={onKeyDown}
      onBlur={() => setKeyboardIndex(null)}>
      {buckets.map((bucket, index) => bucket.count > 0 || bucket.yearStart
        ? <span key={bucket.key} aria-hidden="true" data-testid="history-time-tick" data-day={bucket.jumpDay}
          className={cn("absolute right-0.5 top-0 h-px rounded-full transition-[transform,width] duration-75 ease-out motion-reduce:transition-none",
            index === target ? "bg-accent" : "bg-fg3")}
          style={{
            transform: `translateY(${y(positions[index]!)}px)`,
            width: tickWidth(bucket, maxCount, active ? proximity(positions[index]!, focus!, usable) : 0, index === target),
            opacity: index === target ? 1 : Math.max(active ? proximity(positions[index]!, focus!, usable) : 0,
              bucket.count > 0 ? 0.35 + 0.65 * Math.log1p(bucket.count) / Math.log1p(maxCount) : 0.5),
          }} />
        : null)}
      {current >= 0 ? <span aria-hidden="true" data-testid="history-time-current" className="absolute right-0 top-0 h-0.5 w-3 rounded-full bg-accent transition-transform duration-75 motion-reduce:transition-none"
        style={{ transform: `translateY(${y(positions[current]!)}px)` }} /> : null}
    </div>
    {active ? <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-full mr-1 w-[170px]">
      {labelled.map(index => {
        const bucket = buckets[index]!;
        const isTarget = index === target;
        return <span key={bucket.key} data-testid={isTarget ? "history-time-target" : "history-time-label"} data-day={bucket.jumpDay}
          className={cn("absolute right-0 top-0 -translate-y-1/2 whitespace-nowrap transition-transform duration-75 motion-reduce:transition-none",
            isTarget ? "z-10 rounded-md bg-panel px-2 py-1 text-xs text-fg shadow-pop" : "text-[11px] text-fg3")}
          style={{ transform: `translateY(calc(${y(positions[index]!)}px - 50%))` }}>
          {isTarget ? <><span className="font-semibold">{bucket.label}</span><span className="text-fg3"> · {bucket.count} 个提交{pending === index ? " · 正在跳转…" : ""}</span></> : bucket.shortLabel}
        </span>;
      })}
      {partial ? <span className="absolute right-0 bottom-1 rounded bg-panel px-1.5 py-0.5 text-[10.5px] whitespace-nowrap text-fg3 shadow-pop">统计未完成，刻度还不全</span> : null}
    </div> : null}
  </div>;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 1 at the focus, falling to 0 about 70px away. */
function proximity(position: number, focus: number, usable: number): number {
  return Math.max(0, 1 - Math.abs(position - focus) * usable / 70);
}

function tickWidth(bucket: TimeBucket, maxCount: number, near: number, isTarget: boolean): number {
  if (isTarget) return 14;
  const base = bucket.count > 0 ? 3 + 5 * Math.log1p(bucket.count) / Math.log1p(maxCount) : 0;
  const width = bucket.yearStart ? Math.max(base, 10) : base;
  return Math.round(width + near * 7);
}

/** Buckets that get a text label: the target, plus magnified neighbours with room for a line of text. */
function labelledBuckets(buckets: TimeBucket[], positions: number[], focus: number, usable: number, target: number | null): number[] {
  const shown: number[] = [];
  let lastY = -Infinity;
  buckets.forEach((bucket, index) => {
    if (bucket.count <= 0 && !bucket.yearStart) return;
    const at = positions[index]! * usable;
    if (index !== target && Math.abs(at - focus * usable) > LABEL_REACH) return;
    if (index !== target && at - lastY < LABEL_GAP) return;
    shown.push(index);
    lastY = at;
  });
  if (target !== null && target >= 0 && !shown.includes(target)) shown.push(target);
  // Neighbours too close to the target card would sit under it.
  const targetY = target !== null && target >= 0 ? positions[target]! * usable : null;
  return shown.filter(index => index === target || targetY === null || Math.abs(positions[index]! * usable - targetY) >= 16);
}
