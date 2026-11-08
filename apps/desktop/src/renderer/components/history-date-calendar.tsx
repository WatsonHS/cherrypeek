import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { localDay, relativeDay } from "../lib/time-track.js";
import { cn } from "../lib/utils.js";

export interface CalendarDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  count?: number;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function monthKey(year: number, month: number): string {
  return `${year}-${pad(month)}`;
}

function shiftMonth(key: string, by: number): string {
  const index = Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1 + by;
  return monthKey(Math.floor(index / 12), index % 12 + 1);
}

/** Strength of a heat cell: 0 for no commits, then 0.18 to 0.8 on a log scale. */
function heat(count: number, max: number): number {
  return count > 0 ? 0.18 + 0.62 * Math.log1p(count) / Math.log1p(Math.max(1, max)) : 0;
}

/**
 * A month calendar for jumping to a day: each day is shaded by its commits, today is ringed and
 * the day being read is outlined. The title switches to the twelve months of the year. Clicking
 * a day jumps to its latest commit, or the latest one before it when it has none.
 */
export function HistoryDateCalendar({ days, selectedDay, onChoose }: {
  days: CalendarDay[];
  /** The day being read, shown first. */
  selectedDay: string;
  onChoose(day: string): Promise<boolean>;
}): React.JSX.Element {
  const today = localDay(Date.now() / 1000);
  const counts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of days) if (/^\d{4}-\d{2}-\d{2}$/.test(entry.day)) map.set(entry.day, (map.get(entry.day) ?? 0) + Math.max(0, entry.count ?? 1));
    return map;
  }, [days]);
  const monthTotals = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const [day, count] of counts) map.set(day.slice(0, 7), (map.get(day.slice(0, 7)) ?? 0) + count);
    return map;
  }, [counts]);
  const [month, setMonth] = React.useState(selectedDay.slice(0, 7));
  const [mode, setMode] = React.useState<"days" | "months">("days");
  const [pending, setPending] = React.useState<string | null>(null);
  const [hovered, setHovered] = React.useState<string | null>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);
  // Commits may be dated after today (a skewed clock); those days stay reachable.
  const newestDay = React.useMemo(() => [...counts.keys()].reduce((newest, day) => day > newest ? day : newest, ""), [counts]);
  const latestDay = newestDay > today ? newestDay : today;
  const latestMonth = latestDay.slice(0, 7);
  const year = Number(month.slice(0, 4));

  const choose = async (day: string) => {
    setPending(day);
    await onChoose(day);
    setPending(null);
  };

  const first = new Date(year, Number(month.slice(5, 7)) - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const length = new Date(year, Number(month.slice(5, 7)), 0).getDate();
  const monthDays = Array.from({ length }, (_, index) => `${month}-${pad(index + 1)}`);
  const maxDay = Math.max(1, ...monthDays.map(day => counts.get(day) ?? 0));
  const maxMonth = Math.max(1, ...Array.from({ length: 12 }, (_, index) => monthTotals.get(monthKey(year, index + 1)) ?? 0));
  const hoveredCount = hovered ? counts.get(hovered) ?? 0 : null;

  const onGridKeyDown = (event: React.KeyboardEvent) => {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (!(event.key in moves)) return;
    const buttons = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-day]") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const target = index + moves[event.key]!;
    if (target < 0) setMonth(current => shiftMonth(current, -1));
    else if (target >= buttons.length) { if (month < latestMonth) setMonth(current => shiftMonth(current, 1)); }
    else if (!buttons[target]!.disabled) buttons[target]!.focus();
  };

  return <div data-testid="history-calendar" className="flex flex-col gap-2 text-xs">
    <div className="flex items-center gap-1">
      <button type="button" data-testid="history-calendar-prev" aria-label={mode === "days" ? "上个月" : "上一年"}
        className="flex size-7 items-center justify-center rounded-md text-fg3 hover:bg-hover hover:text-fg"
        onClick={() => setMonth(current => shiftMonth(current, mode === "days" ? -1 : -12))}><ChevronLeft className="size-4" /></button>
      <button type="button" data-testid="history-calendar-title" aria-label={mode === "days" ? "选择月份" : "返回日历"}
        className="flex-1 rounded-md py-1 text-[13px] font-semibold text-fg hover:bg-hover"
        onClick={() => setMode(current => current === "days" ? "months" : "days")}>
        {mode === "days" ? `${year} 年 ${Number(month.slice(5, 7))} 月` : `${year} 年`}
      </button>
      <button type="button" data-testid="history-calendar-next" aria-label={mode === "days" ? "下个月" : "下一年"}
        disabled={mode === "days" ? month >= latestMonth : year >= Number(latestMonth.slice(0, 4))}
        className="flex size-7 items-center justify-center rounded-md text-fg3 hover:bg-hover hover:text-fg disabled:opacity-30"
        onClick={() => setMonth(current => {
          const next = shiftMonth(current, mode === "days" ? 1 : 12);
          return next > latestMonth ? latestMonth : next;
        })}><ChevronRight className="size-4" /></button>
    </div>
    {mode === "days" ? <>
      <div ref={gridRef} role="grid" aria-label={`${year} 年 ${Number(month.slice(5, 7))} 月`} className="grid grid-cols-7 gap-0.5 text-center" onKeyDown={onGridKeyDown}>
        {WEEKDAYS.map(name => <span key={name} role="columnheader" className="py-0.5 text-[11px] text-fg3">{name}</span>)}
        {Array.from({ length: lead }, (_, index) => <span key={`lead:${index}`} aria-hidden="true" />)}
        {monthDays.map(day => {
          const count = counts.get(day) ?? 0;
          const future = day > latestDay;
          const strength = heat(count, maxDay);
          return <button key={day} type="button" role="gridcell" data-testid="history-calendar-day" data-day={day} disabled={future}
            aria-label={`${day}，${count} 个提交`} aria-selected={day === selectedDay}
            tabIndex={day === selectedDay || (!monthDays.includes(selectedDay) && day === monthDays[0]) ? 0 : -1}
            className={cn("relative h-7 rounded-md text-[12px] tabular-nums outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]",
              future ? "text-fg3/30" : count ? "text-fg hover:ring-1 hover:ring-accent" : "text-fg3 hover:bg-hover",
              day === selectedDay && "ring-2 ring-accent", day === today && "font-semibold")}
            onPointerEnter={() => setHovered(day)} onPointerLeave={() => setHovered(current => current === day ? null : current)}
            onFocus={() => setHovered(day)}
            onClick={() => void choose(day)}>
            {strength ? <span aria-hidden="true" className="absolute inset-0 rounded-md bg-accent" style={{ opacity: strength }} /> : null}
            {day === today ? <span aria-hidden="true" className="absolute inset-x-2 bottom-0.5 h-0.5 rounded-full bg-accent-fg" /> : null}
            <span className="relative">{pending === day ? "…" : Number(day.slice(8))}</span>
          </button>;
        })}
      </div>
      <div className="flex min-h-4 items-center justify-between gap-2 text-[11.5px] text-fg3">
        <span data-testid="history-calendar-hint">{hovered
          ? `${Number(hovered.slice(5, 7))} 月 ${Number(hovered.slice(8))} 日 · ${relativeDay(hovered, today)} · ${hoveredCount ? `${hoveredCount.toLocaleString("zh-CN")} 个提交` : "没有提交，跳到之前最近的一次"}`
          : `本月 ${(monthTotals.get(month) ?? 0).toLocaleString("zh-CN")} 个提交`}</span>
        {month !== latestMonth ? <button type="button" className="shrink-0 rounded px-1 text-accent-fg hover:bg-hover" onClick={() => setMonth(latestMonth)}>回到本月</button> : null}
      </div>
    </> : <div className="grid grid-cols-3 gap-1">
      {Array.from({ length: 12 }, (_, index) => {
        const key = monthKey(year, index + 1);
        const total = monthTotals.get(key) ?? 0;
        const strength = heat(total, maxMonth);
        return <button key={key} type="button" data-testid="history-calendar-month" data-month={key} disabled={key > latestMonth}
          className={cn("relative flex h-11 flex-col items-center justify-center rounded-md outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] disabled:opacity-30",
            total ? "text-fg hover:ring-1 hover:ring-accent" : "text-fg3 hover:bg-hover", key === month && "ring-2 ring-accent")}
          onClick={() => { setMonth(key); setMode("days"); }}>
          {strength ? <span aria-hidden="true" className="absolute inset-0 rounded-md bg-accent" style={{ opacity: strength * 0.8 }} /> : null}
          <span className="relative text-[12px] font-medium">{index + 1} 月</span>
          <span className="relative text-[10.5px] tabular-nums text-fg3">{total ? total.toLocaleString("zh-CN") : "—"}</span>
        </button>;
      })}
    </div>}
  </div>;
}
