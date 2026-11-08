import * as React from "react";
import { dayStartSeconds, localDay, relativeDay, windowSpanFor, type TimeTrackInputDay } from "../lib/time-track.js";
import { cn } from "../lib/utils.js";

export type HistoryTimeSliderDay = TimeTrackInputDay;

const PAD = 8;
const DAY = 86_400;
/** The window holds about this many commits per pixel, so busy stretches show fewer days. */
const COMMITS_PER_PIXEL = 4;
const MIN_SPAN = DAY / 4;
/** Dragging within this many pixels of the top or bottom moves the window, up to this many spans a second. */
const EDGE = 28;
const PAN_RATE = 0.8;
const DRAG_JUMP_INTERVAL = 120;
/** The moment being read sits this far down the window while it follows the list. */
const FOLLOW_AT = 0.3;
/** After the pointer leaves, the window waits this long before following the list again. */
const RESUME_FOLLOW = 1200;
const OPEN_WIDTH = 140;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * A time track along the right edge of the history list that shows a window of time around the
 * commit being read, two weeks at first, newest at the top and every day the same height. It
 * follows the list as you scroll and holds still under the pointer. Hovering names the moment;
 * dragging moves a marker and the list follows, and dragging into the top or bottom edge moves the
 * window to newer or older time. The wheel moves the window; ⌘/Ctrl + wheel zooms it.
 * Jumps land on the latest commit before the moment.
 */
export function HistoryTimeSlider({ days, partial, viewportSeconds, loading, sessionKey, onChooseTime, onScrubbingChange }: {
  days: HistoryTimeSliderDay[];
  /** The days miss older history: statistics are incomplete, or kept only the newest days. */
  partial: false | "counting" | "truncated";
  /** Committer time of the commit at the top of the list, Unix seconds. */
  viewportSeconds: number | null;
  loading: boolean;
  sessionKey: string | null;
  onChooseTime(beforeSeconds: number): Promise<boolean>;
  onScrubbingChange?(scrubbing: boolean): void;
}): React.JSX.Element | null {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState(0);
  /** Window length set with ⌘ + wheel or +/−; null to choose it from the commit count. */
  const [manualSpan, setManualSpan] = React.useState<number | null>(null);
  /** Window length frozen while the pointer is on the slider, so the scale holds still under it. */
  const [heldSpan, setHeldSpan] = React.useState<number | null>(null);
  /** Top of the window in Unix seconds while it holds still; null while it follows the list. */
  const [heldEnd, setHeldEnd] = React.useState<number | null>(null);
  const [pointerY, setPointerY] = React.useState<number | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [keyboard, setKeyboard] = React.useState<number | null>(null);
  const [pending, setPending] = React.useState(false);
  const resumeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragJumpTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDragSeconds = React.useRef<number | null>(null);
  const lastDragJumpAt = React.useRef(0);
  const panFrame = React.useRef(0);
  const inFlight = React.useRef(false);
  const queued = React.useRef<number | null>(null);
  const lastJump = React.useRef(Number.NaN);
  const chooseIntent = React.useRef(0);
  const moveFrame = React.useRef(0);
  const pendingPointerY = React.useRef<number | null>(null);
  /** Released while a jump was still running: scrubbing ends when the last jump lands. */
  const endScrubWhenIdle = React.useRef(false);
  const scrubbingCallback = React.useRef(onScrubbingChange);
  scrubbingCallback.current = onScrubbingChange;
  const finishScrub = () => {
    endScrubWhenIdle.current = false;
    scrubbingCallback.current?.(false);
  };
  const clearDragJump = React.useCallback(() => {
    if (dragJumpTimer.current) clearTimeout(dragJumpTimer.current);
    dragJumpTimer.current = null;
    latestDragSeconds.current = null;
  }, []);

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
    clearDragJump();
    queued.current = null;
    if (endScrubWhenIdle.current) finishScrub();
    lastJump.current = Number.NaN;
    setHeldEnd(null);
    setHeldSpan(null);
    setManualSpan(null);
    setPointerY(null);
    setDragging(false);
    setKeyboard(null);
    setPending(false);
  }, [clearDragJump, sessionKey]);
  React.useEffect(() => () => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    clearDragJump();
    queued.current = null;
    chooseIntent.current += 1;
    cancelAnimationFrame(panFrame.current);
    cancelAnimationFrame(moveFrame.current);
  }, [clearDragJump]);

  const counts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of days) if (/^\d{4}-\d{2}-\d{2}$/.test(entry.day)) map.set(entry.day, (map.get(entry.day) ?? 0) + Math.max(0, entry.count ?? 1));
    return map;
  }, [days]);
  const bounds = React.useMemo(() => {
    const sorted = [...counts.keys()].filter(day => counts.get(day)! > 0).sort();
    if (!sorted.length) return null;
    const newestStart = dayStartSeconds(sorted.at(-1)!);
    const now = Math.floor(Date.now() / 1000);
    return { oldest: dayStartSeconds(sorted[0]!), top: Math.min(newestStart + DAY, Math.max(now, newestStart + 3600)) };
  }, [counts]);
  const dayList = React.useMemo(() => [...counts.entries()].filter(([, count]) => count > 0)
    .map(([day, count]) => ({ start: dayStartSeconds(day), count })).sort((a, b) => a.start - b.start), [counts]);

  const usable = Math.max(1, height - PAD * 2);
  const history = bounds ? bounds.top - bounds.oldest : DAY;
  const anchor = viewportSeconds ?? bounds?.top ?? 0;
  const anchorHour = Math.floor(anchor / 3600);
  const target = usable * COMMITS_PER_PIXEL;
  const automaticSpan = React.useMemo(() => windowSpanFor(dayList, anchorHour * 3600, target), [dayList, anchorHour, target]);
  const chosenSpan = heldSpan ?? manualSpan ?? automaticSpan;
  const effectiveSpan = Math.min(Math.max(chosenSpan, MIN_SPAN), Math.max(MIN_SPAN, history));
  const clampEnd = (end: number) => bounds ? Math.min(bounds.top, Math.max(bounds.oldest + effectiveSpan, end)) : end;
  const followEnd = viewportSeconds === null ? bounds?.top ?? 0 : viewportSeconds + effectiveSpan * FOLLOW_AT;
  const end = clampEnd(heldEnd ?? followEnd);
  const start = end - effectiveSpan;
  const timeAt = (y: number) => Math.min(end, Math.max(start, end - (y - PAD) / usable * effectiveSpan));
  const yAt = (seconds: number) => PAD + (end - seconds) / effectiveSpan * usable;

  // One jump at a time: while one runs, only the newest wanted moment waits. Locating can take
  // longer than the pointer takes to move, so cancelling the running jump would never land.
  const run = (seconds: number) => {
    if (Math.abs(seconds - lastJump.current) < 60) return;
    if (inFlight.current) {
      queued.current = seconds;
      return;
    }
    inFlight.current = true;
    lastJump.current = seconds;
    setPending(true);
    const intent = chooseIntent.current;
    // Whole seconds only; +1 so commits made in that very second still count as before it.
    void onChooseTime(Math.floor(seconds) + 1).finally(() => {
      inFlight.current = false;
      if (intent !== chooseIntent.current) return;
      const next = queued.current;
      queued.current = null;
      if (next !== null) run(next);
      else {
        setPending(false);
        if (endScrubWhenIdle.current) finishScrub();
      }
    });
  };
  const scheduleDragJump = (seconds: number, immediate = false) => {
    latestDragSeconds.current = seconds;
    if (immediate) {
      clearDragJump();
      lastDragJumpAt.current = performance.now();
      run(seconds);
      return;
    }
    if (dragJumpTimer.current) return;
    const flush = () => {
      dragJumpTimer.current = null;
      const latest = latestDragSeconds.current;
      latestDragSeconds.current = null;
      if (latest === null) return;
      lastDragJumpAt.current = performance.now();
      run(latest);
    };
    const delay = Math.max(0, DRAG_JUMP_INTERVAL - (performance.now() - lastDragJumpAt.current));
    if (delay === 0) flush();
    else dragJumpTimer.current = setTimeout(flush, delay);
  };
  React.useEffect(() => { if (!loading && !inFlight.current) setPending(false); }, [loading]);

  const hold = () => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = null;
    setHeldEnd(current => current ?? end);
    setHeldSpan(current => current ?? effectiveSpan);
  };
  const releaseLater = () => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => {
      resumeTimer.current = null;
      setHeldEnd(null);
      setHeldSpan(null);
      setManualSpan(null);
    }, RESUME_FOLLOW);
  };
  const localY = (clientY: number) => Math.min(height, Math.max(0, clientY - (rootRef.current?.getBoundingClientRect().top ?? 0)));

  // Dragging into an edge moves the window while the pointer stays there.
  const latest = React.useRef({ pointerY, dragging, end, effectiveSpan, height, usable, history, clampEnd });
  latest.current = { ...latest.current, dragging, end, effectiveSpan, height, usable, history, clampEnd };
  if (!dragging) latest.current.pointerY = pointerY;
  const pan = React.useCallback((previous: number) => {
    panFrame.current = requestAnimationFrame(now => {
      const { pointerY: y, dragging: active, end: currentEnd, effectiveSpan: windowSpan, height: total } = latest.current;
      if (!active || y === null) return;
      const into = y < PAD + EDGE ? (PAD + EDGE - y) / EDGE : y > total - PAD - EDGE ? -(y - (total - PAD - EDGE)) / EDGE : 0;
      if (into !== 0) {
        const dt = Math.min(0.05, (now - previous) / 1000);
        const nextEnd = clampEnd(currentEnd + Math.sign(into) * Math.min(1, Math.abs(into)) * PAN_RATE * windowSpan * dt);
        setHeldEnd(nextEnd);
        scheduleDragJump(Math.min(nextEnd, Math.max(nextEnd - windowSpan, nextEnd - (y - PAD) / usable * windowSpan)));
      }
      pan(now);
    });
  }, [usable, bounds]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    // Native and non-passive so ⌘/Ctrl + wheel zooms the window instead of the page.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const model = latest.current;
      const y = Math.min(model.height, Math.max(0, event.clientY - element.getBoundingClientRect().top));
      if (event.ctrlKey || event.metaKey) {
        const pivot = model.end - (y - PAD) / model.usable * model.effectiveSpan;
        const nextSpan = Math.min(Math.max(MIN_SPAN, model.history), Math.max(MIN_SPAN, model.effectiveSpan * Math.exp(event.deltaY * 0.0025)));
        setManualSpan(nextSpan);
        setHeldSpan(nextSpan);
        setHeldEnd(pivot + (y - PAD) / model.usable * nextSpan);
      } else {
        setHeldEnd(model.clampEnd(model.end - event.deltaY / model.usable * model.effectiveSpan));
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [Boolean(bounds)]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (event: React.KeyboardEvent) => {
    const from = keyboard ?? viewportSeconds ?? end;
    const steps: Record<string, number> = { ArrowUp: 3600, ArrowDown: -3600, PageUp: DAY, PageDown: -DAY };
    let next: number | null = null;
    if (event.key in steps) next = from + steps[event.key]!;
    else if (event.key === "Home" && bounds) next = bounds.top;
    else if (event.key === "End" && bounds) next = bounds.oldest;
    else if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      const nextSpan = Math.max(MIN_SPAN, effectiveSpan * (event.key === "-" ? 2 : 0.5));
      setManualSpan(nextSpan);
      setHeldSpan(nextSpan);
      return;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      lastJump.current = Number.NaN;
      run(from);
      return;
    } else if (event.key === "Escape" && keyboard !== null) {
      event.preventDefault();
      setKeyboard(null);
      setHeldEnd(null);
      setHeldSpan(null);
      setManualSpan(null);
      return;
    }
    if (next === null || !bounds) return;
    event.preventDefault();
    const moment = Math.min(bounds.top, Math.max(bounds.oldest, next));
    setKeyboard(moment);
    // Keep the keyboard moment inside the window.
    if (moment > end - effectiveSpan * 0.1 || moment < start + effectiveSpan * 0.1) setHeldEnd(clampEnd(moment + effectiveSpan * FOLLOW_AT));
    else hold();
  };

  const today = localDay(Date.now() / 1000);
  const dayHeight = DAY / effectiveSpan * usable;
  const rows = React.useMemo(() => dayRows(start, end, counts, today, dayHeight), [start, end, counts, today, dayHeight]);

  if (!bounds) return null;

  const open = pointerY !== null || dragging || keyboard !== null;
  const activeMoment = keyboard ?? (pointerY !== null ? timeAt(pointerY) : null);
  const activeY = activeMoment === null ? null : yAt(activeMoment);
  const currentY = viewportSeconds === null ? null : yAt(Math.min(end, Math.max(start, viewportSeconds)));
  const currentOutside = viewportSeconds !== null && (viewportSeconds > end || viewportSeconds < start);
  const nearEdge = dragging && pointerY !== null && (pointerY < PAD + EDGE || pointerY > height - PAD - EDGE);
  const [when, where] = activeMoment === null ? ["", ""] : describe(activeMoment, counts, today, dayHeight >= 90);

  return <div ref={rootRef} data-testid="history-time-slider" data-partial={partial || undefined}
    data-window-start={Math.round(start)} data-window-end={Math.round(end)}
    className="relative z-20 h-full w-4 shrink-0 select-none">
    {open ? <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 bg-gradient-to-l from-bg via-bg/95 to-transparent"
      style={{ width: OPEN_WIDTH + 40 }} /> : null}
    <div role="slider" tabIndex={0} aria-orientation="vertical" aria-label="按时间浏览历史"
      aria-valuemin={Math.round(bounds.oldest)} aria-valuemax={Math.round(bounds.top)} aria-valuenow={Math.round(activeMoment ?? viewportSeconds ?? end)}
      aria-valuetext={activeMoment === null ? "按时间浏览历史" : `${when}，${where}`} aria-busy={pending}
      data-testid="history-time-slider-track"
      className="absolute inset-y-0 right-0 cursor-ns-resize rounded-sm outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]"
      style={{ width: open ? OPEN_WIDTH : 16 }}
      onPointerEnter={hold}
      onPointerMove={event => {
        const y = localY(event.clientY);
        latest.current.pointerY = y;
        pendingPointerY.current = y;
        if (!moveFrame.current) moveFrame.current = requestAnimationFrame(() => {
          moveFrame.current = 0;
          setPointerY(pendingPointerY.current);
        });
      }}
      onPointerLeave={() => {
        if (dragging) return;
        cancelAnimationFrame(moveFrame.current);
        moveFrame.current = 0;
        latest.current.pointerY = null;
        setPointerY(null);
        if (keyboard === null) releaseLater();
      }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        clearDragJump();
        event.currentTarget.setPointerCapture(event.pointerId);
        hold();
        setKeyboard(null);
        setDragging(true);
        endScrubWhenIdle.current = false;
        onScrubbingChange?.(true);
        const y = localY(event.clientY);
        setPointerY(y);
        latest.current = { ...latest.current, pointerY: y, dragging: true };
        scheduleDragJump(timeAt(y), true);
        cancelAnimationFrame(panFrame.current);
        pan(performance.now());
      }}
      onPointerMoveCapture={event => {
        if (!dragging) return;
        const y = localY(event.clientY);
        scheduleDragJump(timeAt(y));
      }}
      onPointerUp={event => {
        if (!dragging) return;
        cancelAnimationFrame(panFrame.current);
        setDragging(false);
        const y = localY(event.clientY);
        clearDragJump();
        lastJump.current = Number.NaN;
        endScrubWhenIdle.current = true;
        run(timeAt(y));
        if (!inFlight.current) finishScrub();
        const box = rootRef.current?.getBoundingClientRect();
        const inside = box && event.clientX >= box.right - OPEN_WIDTH && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
        if (!inside) {
          setPointerY(null);
          releaseLater();
        }
      }}
      onPointerCancel={() => {
        cancelAnimationFrame(panFrame.current);
        clearDragJump();
        queued.current = null;
        setDragging(false);
        finishScrub();
      }}
      onKeyDown={onKeyDown}
      onBlur={() => { if (keyboard !== null) { setKeyboard(null); releaseLater(); } }}>
      <span aria-hidden="true" className="absolute right-[7px] w-px bg-line2" style={{ top: PAD, bottom: PAD }} />
      <SliderMarks rows={rows} open={open} dayHeight={dayHeight} />
      {currentY !== null ? <span aria-hidden="true" data-testid="history-time-current"
        className={cn("absolute right-[4px] h-4 w-[7px] -translate-y-1/2 rounded-full transition-[top] duration-100 motion-reduce:transition-none",
          currentOutside ? "bg-accent/35" : "bg-accent/80")}
        style={{ top: currentY }} /> : null}
      {activeY !== null ? <span aria-hidden="true" className="absolute right-[3px] size-[9px] -translate-y-1/2 rounded-full border-2 border-accent bg-panel"
        style={{ top: activeY }} /> : null}
      {nearEdge ? <span aria-hidden="true" className="absolute right-1 text-[10px] text-accent-fg"
        style={pointerY! < height / 2 ? { top: 0 } : { bottom: 0 }}>{pointerY! < height / 2 ? "▲ 更新" : "▼ 更早"}</span> : null}
    </div>
    {activeMoment !== null && activeY !== null ? <div aria-hidden="true" data-testid="history-time-bubble" data-seconds={Math.round(activeMoment)}
      className="pointer-events-none absolute w-max max-w-[260px] -translate-y-1/2 rounded-lg bg-panel px-2.5 py-1.5 text-xs shadow-pop"
      style={{ top: Math.min(Math.max(activeY, 36), height - 36), right: 22 }}>
      <div className="font-semibold text-fg">{when}</div>
      <div className="text-fg3">{where}{pending ? " · 正在跳转…" : ""}</div>
      {!dragging && keyboard === null ? <div className="text-fg3">拖动跳转 · 滚轮前后移动 · ⌘ 滚轮缩放</div> : null}
      {dragging ? <div className="text-fg3">拖到上下边缘会继续滚动</div> : null}
      {partial ? <div className="text-fg3">{partial === "truncated" ? "只统计了最近的活动日期" : "统计未完成，只覆盖已统计部分"}</div> : null}
    </div> : null}
  </div>;
}

/** Day, hour and label marks; redrawn only when the window or its open state changes. */
const SliderMarks = React.memo(function SliderMarks({ rows, open, dayHeight }: { rows: DayRow[]; open: boolean; dayHeight: number }): React.JSX.Element {
  return <>
    {rows.map(row => <React.Fragment key={row.day}>
      {row.top >= PAD - 0.5 && (row.labelled || dayHeight >= 4) ? <span aria-hidden="true" data-testid="history-time-day" data-day={row.day}
        className={cn("absolute right-[4px] h-px", row.labelled ? "w-[7px] bg-fg3/70" : "w-[5px] bg-fg3/35")} style={{ top: row.top }} /> : null}
      {open && row.labelled ? <span aria-hidden="true" data-testid="history-time-label"
        className={cn("absolute right-4 whitespace-nowrap text-[11px] leading-4", row.count ? "text-fg2" : "text-fg3/60")}
        style={{ top: Math.max(2, row.top + 1) }}>
        <span className={row.isToday ? "font-semibold text-accent-fg" : "font-medium"}>{row.label}</span>
        {row.count ? <span className="text-fg3"> · {row.count.toLocaleString("zh-CN")}</span> : null}
      </span> : null}
      {row.hours.map(hour => <span key={hour.seconds} aria-hidden="true" className="absolute right-[6px] h-px w-[3px] bg-fg3/30" style={{ top: hour.top }}>
        {open && hour.label ? <span className="absolute right-3 -translate-y-1/2 text-[10px] text-fg3/70">{hour.label}</span> : null}
      </span>)}
    </React.Fragment>)}
  </>;
});

interface DayRow {
  day: string;
  top: number;
  count: number;
  label: string;
  labelled: boolean;
  isToday: boolean;
  hours: { seconds: number; top: number; label: string | null }[];
}

/** The days inside the window with where their tops sit, labelled as far as they have room. */
function dayRows(start: number, end: number, counts: Map<string, number>, today: string, dayHeight: number): DayRow[] {
  const rows: DayRow[] = [];
  const span = end - start;
  const usable = dayHeight * span / DAY;
  const yAt = (seconds: number) => PAD + (end - seconds) / span * usable;
  // Which days are written out: every day when there is room, else Mondays, else the 1st of each month.
  const every = dayHeight >= 18 ? "day" : dayHeight * 7 >= 22 ? "week" : "month";
  for (let day = localDay(end - 1); ; day = localDay(dayStartSeconds(day) - DAY / 2)) {
    const startOfDay = dayStartSeconds(day);
    if (startOfDay + DAY <= start) break;
    const top = yAt(startOfDay + DAY);
    const weekday = new Date(`${day}T12:00:00`).getDay();
    const labelled = every === "day" || (every === "week" && weekday === 1) || (every === "month" && day.endsWith("-01"));
    const hours = dayHeight >= 36 ? [18, 12, 6].map(hour => {
      const seconds = startOfDay + hour * 3600;
      return { seconds, top: yAt(seconds), label: dayHeight >= 90 ? `${hour}:00` : null };
    }).filter(hour => hour.seconds > start && hour.seconds < end) : [];
    // A labelled Monday or 1st stands for its week or month, so it shows that period's commits.
    const periodDays = every === "day" ? 1 : every === "week" ? 7 : new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0).getDate();
    let count = 0;
    for (let offset = 0; offset < (labelled ? periodDays : 1); offset += 1) count += counts.get(localDay(startOfDay + offset * DAY + DAY / 2)) ?? 0;
    rows.push({ day, top, count, label: dayLabel(day, today, every), labelled, isToday: day === today, hours });
    if (rows.length > 400) break;
  }
  return rows;
}

function dayLabel(day: string, today: string, every: "day" | "week" | "month"): string {
  const relative = relativeDay(day, today);
  if (relative === "今天" || relative === "昨天") return relative;
  const [year, month, date] = day.split("-").map(Number);
  const prefix = day.slice(0, 4) === today.slice(0, 4) ? "" : `${year} 年 `;
  if (every === "month") return `${prefix}${month} 月`;
  return `${prefix}${month} 月 ${date} 日 ${WEEKDAYS[new Date(`${day}T12:00:00`).getDay()]}`;
}

/** "10 月 29 日 周三 15:00 前后" and "10 天前 · 当天 312 个提交". */
function describe(seconds: number, counts: Map<string, number>, today: string, minutes: boolean): [string, string] {
  const date = new Date(seconds * 1000);
  const day = localDay(seconds);
  const step = minutes ? 10 : 60;
  const total = Math.min(23 * 60 + 59, Math.round((date.getHours() * 60 + date.getMinutes()) / step) * step);
  const time = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  const year = day.slice(0, 4) === today.slice(0, 4) ? "" : `${day.slice(0, 4)} 年 `;
  const count = counts.get(day) ?? 0;
  return [`${year}${date.getMonth() + 1} 月 ${date.getDate()} 日 ${WEEKDAYS[date.getDay()]} ${time} 前后`,
    `${relativeDay(day, today)} · ${count ? `当天 ${count.toLocaleString("zh-CN")} 个提交` : "当天没有提交"}`];
}
