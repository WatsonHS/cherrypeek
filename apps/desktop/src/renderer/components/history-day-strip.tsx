import * as React from "react";
import { CalendarDays, FoldHorizontal } from "lucide-react";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

export interface DayMarker {
  /** Top of the day row inside the scrolled list. */
  offset: number;
  label: string;
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
}

/**
 * One strip pinned over the top of the history list. Left: the day being read, which the next
 * day row pushes out as it arrives; clicking it opens a date field for an exact jump.
 * Right, while the graph is expanded: "全部图线 · N 列" and the collapse button.
 *
 * The strip is as tall as a day row and its label sits where day-row labels sit, so at the top
 * of the list it covers the first day row exactly. Only the text column gets a background, so
 * graph lines stay continuous.
 */
export function HistoryDayStrip({ listRef, markers, rowHeight, textLeft, graphLaneCount, onCollapseGraph, onChooseDate }: {
  listRef: React.RefObject<HTMLDivElement | null>;
  markers: DayMarker[];
  rowHeight: number;
  /** Left edge of day-row labels inside the list content, before horizontal scrolling. */
  textLeft: number;
  /** Lane count while the graph is expanded; null in the compact six-lane view. */
  graphLaneCount: number | null;
  onCollapseGraph(): void;
  onChooseDate(day: string): Promise<boolean>;
}): React.JSX.Element | null {
  const [scroll, setScroll] = React.useState({ top: 0, left: 0, width: 0 });
  const [dateOpen, setDateOpen] = React.useState(false);
  const [dateValue, setDateValue] = React.useState("");

  React.useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setScroll(previous => previous.top === element.scrollTop && previous.left === element.scrollLeft && previous.width === element.clientWidth
        ? previous : { top: element.scrollTop, left: element.scrollLeft, width: element.clientWidth });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(read); };
    read();
    element.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [listRef, markers]);

  const index = lastAtOrBefore(markers, scroll.top);
  if (index < 0) return null;
  const marker = markers[index]!;
  const next = markers[index + 1];
  const push = next ? Math.min(0, next.offset - scroll.top - rowHeight) : 0;
  const labelLeft = Math.round(Math.min(Math.max(16, textLeft - scroll.left), Math.max(16, scroll.width * 0.45)));
  const scrolled = scroll.top > marker.offset + 0.5;

  return <div data-testid="history-day-strip" className="pointer-events-none absolute inset-x-0 top-0 z-10" style={{ height: rowHeight }}>
    <div className="absolute inset-y-0 right-0 bg-bg" style={{ left: labelLeft - 8, transform: push ? `translateY(${push}px)` : undefined }}>
      <Popover open={dateOpen} onOpenChange={open => {
        setDateOpen(open);
        if (open) setDateValue(marker.day);
      }}>
        <PopoverTrigger asChild>
          <button type="button" data-testid="history-date-trigger" data-day={marker.day}
            aria-label={`正在看 ${marker.label}。按日期跳转`} title="按日期跳转"
            className="pointer-events-auto absolute bottom-0.5 left-1 flex h-6 items-center gap-1.5 rounded-md border-0 bg-transparent px-1 text-xs font-semibold text-fg2 outline-none hover:bg-hover hover:text-fg focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] data-[state=open]:bg-accent-soft data-[state=open]:text-accent-fg">
            <span>{marker.label}</span>
            <CalendarDays className="size-3 text-fg3" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent data-testid="history-date-popover" className="w-[240px] p-3">
          {/* Jump on Enter or the button only: typing a year passes through dates like 0002-09-26. */}
          <form className="flex flex-col gap-1.5 text-xs text-fg3" onSubmit={event => {
            event.preventDefault();
            if (!dateValue) return;
            void onChooseDate(dateValue).then(found => { if (found) setDateOpen(false); });
          }}>
            <label htmlFor="history-date-input" className="font-semibold text-fg2">跳转到日期</label>
            <span className="flex gap-1.5">
              <input id="history-date-input" data-testid="history-time-rail-date" type="date" value={dateValue}
                className="min-w-0 flex-1 rounded-md border border-line2 bg-bg px-2 py-1 text-[13px] text-fg"
                onChange={event => setDateValue(event.target.value)} />
              <Button type="submit" size="sm" variant="soft" data-testid="history-date-submit" disabled={!dateValue}>跳转</Button>
            </span>
            <span className="text-[11.5px] leading-4">当天没有提交时，跳到这之前最近的一次提交。也可以在右侧刻度上点选。</span>
          </form>
        </PopoverContent>
      </Popover>
      {scrolled && push === 0 ? <span aria-hidden="true" className="absolute inset-x-0 top-full h-1.5 bg-gradient-to-b from-bg to-transparent" /> : null}
    </div>
    {graphLaneCount !== null ? <div data-testid="graph-mode-bar" className="pointer-events-auto absolute right-1 bottom-0.5 flex items-center gap-1.5 rounded-md bg-bg pl-2 text-xs">
      <span className="whitespace-nowrap"><span className="font-semibold text-fg2">全部图线</span><span className="text-fg3"> · {graphLaneCount} 列</span></span>
      <Button data-testid="graph-collapse" variant="ghost" size="sm" className="h-6 shrink-0 gap-1 px-1.5"
        aria-label="收起完整提交图" title="收起完整提交图，回到前 6 列（Esc）" onClick={event => {
          event.stopPropagation();
          onCollapseGraph();
        }}><FoldHorizontal className="size-3.5" strokeWidth={1.75} aria-hidden="true" />收起</Button>
    </div> : null}
  </div>;
}

/** Index of the last marker at or above `top`, or -1. */
function lastAtOrBefore(markers: DayMarker[], top: number): number {
  let low = 0;
  let high = markers.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (markers[middle]!.offset <= top + 0.5) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}
