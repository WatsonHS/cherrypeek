import * as React from "react";
import { X } from "lucide-react";
import { localDateInput } from "../lib/search-date.js";
import { Button } from "./ui/button.js";

export interface HistoryTimeRailDay {
  day: string;
  count?: number;
}

interface RailMarker extends HistoryTimeRailDay {
  top: number;
  major: boolean;
}

export function HistoryTimeRail({ days, sourceLabel, partial, viewportDay, loading, error, sessionKey, onChooseDate, onCancel, onRetry }: {
  days: HistoryTimeRailDay[];
  sourceLabel: string;
  partial: boolean;
  viewportDay: string | null;
  loading: boolean;
  error: string | null;
  sessionKey: string | null;
  onChooseDate(day: string): Promise<boolean>;
  onCancel(): Promise<void>;
  onRetry(): Promise<void>;
}): React.JSX.Element {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const chooseIntent = React.useRef(0);
  const [open, setOpen] = React.useState(false);
  const [dateValue, setDateValue] = React.useState(() => localDateInput());
  const [frozen, setFrozen] = React.useState<{ days: HistoryTimeRailDay[]; sourceLabel: string; partial: boolean } | null>(null);
  const orderedDays = React.useMemo(() => [...days].sort((a, b) => b.day.localeCompare(a.day)), [days]);
  const shownDays = open && frozen ? frozen.days : orderedDays;
  const shownSourceLabel = open && frozen ? frozen.sourceLabel : sourceLabel;
  const shownPartial = open && frozen ? frozen.partial : partial;
  const markers = React.useMemo(() => createMarkers(shownDays), [shownDays]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  React.useEffect(() => {
    chooseIntent.current += 1;
    setOpen(false);
  }, [sessionKey]);

  const chooseDate = async (day: string) => {
    setDateValue(day);
    const intent = ++chooseIntent.current;
    const found = await onChooseDate(day);
    if (intent === chooseIntent.current && found) setOpen(false);
  };

  const openRail = () => {
    setFrozen({ days: orderedDays, sourceLabel, partial });
    setOpen(true);
  };
  const currentTop = viewportDay ? markerTop(viewportDay, shownDays) : null;
  return <div ref={rootRef} className="relative z-20 h-full w-5 shrink-0" data-testid="history-time-rail">
    {!open ? <button type="button" data-testid="history-time-rail-toggle" aria-expanded="false" aria-label="展开日期时间标尺" title="展开日期时间标尺"
      className="absolute inset-0 flex w-full justify-center rounded-sm outline-none hover:bg-hover focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]"
      onClick={openRail}>
      <span aria-hidden="true" className="absolute bottom-2 top-2 w-px bg-line" />
      {markers.map((marker, index) => <span key={`${marker.day}:${index}`} aria-hidden="true" className={`absolute h-px ${marker.major ? "w-2 bg-fg3" : "w-1 bg-line"}`}
        style={{ top: `calc(8px + (100% - 16px) * ${marker.top})` }} />)}
      {currentTop !== null ? <span aria-hidden="true" className="absolute size-1.5 -translate-y-1/2 rounded-full bg-accent" style={{ top: `calc(8px + (100% - 16px) * ${currentTop})` }} /> : null}
    </button> : <section data-testid="history-time-rail-panel" aria-label="日期时间标尺" className="absolute inset-y-0 left-0 flex w-[210px] flex-col border-r border-line bg-panel shadow-pop">
      <div className="flex items-center gap-1 border-b border-line px-2 py-2">
        <strong className="min-w-0 flex-1 truncate text-xs">日期跳转</strong>
        <button type="button" data-testid="history-time-rail-toggle" aria-expanded="true" aria-label="收起日期时间标尺" title="收起日期时间标尺"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg3 hover:bg-hover hover:text-fg" onClick={() => setOpen(false)}>
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <label className="flex flex-col gap-1 px-2 py-2 text-[11px] text-fg3">
        <span>跳转到本地日期</span>
        <input data-testid="history-time-rail-date" aria-label="跳转到本地日期" type="date" value={dateValue}
          className="min-w-0 rounded-md border border-line bg-bg px-1.5 py-1 text-xs text-fg"
          onChange={event => { if (event.target.value) void chooseDate(event.target.value); else setDateValue(""); }} />
      </label>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <span aria-hidden="true" className="absolute bottom-2 left-3.5 top-2 w-px bg-line" />
        {markers.map((marker, index) => <React.Fragment key={`${marker.day}:${index}`}>
          <span aria-hidden="true" className={`absolute left-2.5 h-px ${marker.major ? "w-2 bg-fg3" : "w-1 bg-line"}`}
            style={{ top: `calc(8px + (100% - 16px) * ${marker.top})` }} />
          {marker.major ? <button type="button" data-testid={`history-date-tick-${marker.day}`} aria-label={`跳转到 ${marker.day}`}
            aria-current={viewportDay === marker.day ? "date" : undefined}
            title={marker.day}
            className={`absolute left-6 max-w-[174px] -translate-y-1/2 truncate rounded px-1.5 py-0.5 text-left text-[11px] ${viewportDay === marker.day ? "bg-accent/15 font-semibold text-fg" : "text-fg2 hover:bg-hover"}`}
            style={{ top: `calc(8px + (100% - 16px) * ${marker.top})` }} onClick={() => { void chooseDate(marker.day); }}>{marker.day}</button> : null}
        </React.Fragment>)}
        {currentTop !== null ? <span aria-hidden="true" className="absolute left-[11px] size-1.5 -translate-y-1/2 rounded-full bg-accent" style={{ top: `calc(8px + (100% - 16px) * ${currentTop})` }} /> : null}
      </div>
      <p className="m-0 px-2 pb-2 text-[10px] leading-4 text-fg3" title={`${shownSourceLabel}${shownPartial ? "（部分统计）" : ""}`}>
        当天无提交时跳到此前最近提交。
      </p>
      {markers.length === 0 ? <p className="m-0 px-2 pb-2 text-[11px] text-fg3">暂无可用日期刻度，可直接输入日期。</p> : null}
      {loading ? <div className="flex items-center gap-1.5 border-t border-line px-2 py-2 text-[11px] text-fg3">
        <span role="status" data-testid="history-date-location-status" data-state="loading" className="min-w-0 flex-1">正在定位…</span>
        <Button variant="outline" size="sm" onClick={() => { void onCancel(); }}>取消</Button>
      </div> : null}
      {!loading && error ? <div className="border-t border-line px-2 py-2">
        <p role="status" data-testid="history-date-location-status" data-state="error" className="m-0 text-[11px] leading-4 text-warn">{error}</p>
        <Button variant="outline" size="sm" className="mt-1" onClick={() => { void onRetry(); }}>重试定位</Button>
      </div> : null}
    </section>}
  </div>;
}

function createMarkers(days: HistoryTimeRailDay[]): RailMarker[] {
  if (days.length === 0) return [];
  const first = dayOrdinal(days[0]!.day);
  const last = dayOrdinal(days.at(-1)!.day);
  const spanDays = Math.max(0, Math.round((first - last) / 86_400_000));
  const majorCount = Math.min(8, spanDays + 1);
  const positions = new Map<string, RailMarker>();
  const add = (ordinal: number, major: boolean) => {
    const day = ordinalDate(ordinal);
    const top = spanDays > 0 ? (first - ordinal) / (spanDays * 86_400_000) : 0.5;
    const existing = positions.get(day);
    if (existing?.major && !major) return;
    positions.set(day, { day, top, major: major || Boolean(existing?.major) });
  };
  for (let index = 0; index < majorCount; index += 1) {
    const ordinal = majorCount === 1 ? first : first - Math.round(spanDays * index / (majorCount - 1)) * 86_400_000;
    add(ordinal, true);
  }
  for (let index = 0; index < majorCount - 1; index += 1) {
    const start = first - Math.round(spanDays * index / (majorCount - 1)) * 86_400_000;
    const end = first - Math.round(spanDays * (index + 1) / (majorCount - 1)) * 86_400_000;
    for (let part = 1; part <= 3; part += 1) add(Math.round(start + (end - start) * part / 4), false);
  }
  return [...positions.values()].sort((a, b) => a.top - b.top);
}

function dayOrdinal(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1);
}

function ordinalDate(ordinal: number): string {
  return new Date(ordinal).toISOString().slice(0, 10);
}

function markerTop(day: string, days: HistoryTimeRailDay[]): number | null {
  if (days.length === 0) return null;
  const newest = dayOrdinal(days[0]!.day);
  const oldest = dayOrdinal(days.at(-1)!.day);
  if (newest === oldest) return day === days[0]!.day ? 0.5 : null;
  const ordinal = dayOrdinal(day);
  if (ordinal > newest || ordinal < oldest) return null;
  return (newest - ordinal) / (newest - oldest);
}

