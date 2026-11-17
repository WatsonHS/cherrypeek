import * as React from "react";
import type { ActivityOverview } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { StatsBucket } from "../../../../../packages/protocol/src/generated/client-message.js";
import { bucketChartTitle, bucketEnd, bucketLabel, bucketUnitLabel, clipToRange, compareText, rangeDays } from "../lib/stats-range.js";
import type { StatsRequest, StatsSlot } from "../lib/stats-store.js";
import { cn } from "../lib/utils.js";
import {
  accentAlpha, BarRow, BucketBars, formatClock, formatCount, formatDate, formatDateTime, PartialTag, SlotGate, StatsCard, StatTile, truncationNote,
} from "./stats-widgets.js";
import type { StatsActions } from "./stats-widgets.js";

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;
const INACTIVE_DAYS = 30;

export function ActivitySection({ slot, onRetry, actions }: { slot: StatsSlot<ActivityOverview>; onRetry(): void; actions: StatsActions }): React.JSX.Element {
  return <SlotGate slot={slot} onRetry={onRetry} noun="活动">
    {stats => <ActivityCards stats={stats} request={slot.loaded!} actions={actions} />}
  </SlotGate>;
}

function ActivityCards({ stats, request, actions }: { stats: ActivityOverview; request: StatsRequest; actions: StatsActions }): React.JSX.Element {
  const { range, bucket } = request;
  const { totals, previousTotals, coverage } = stats;
  const busiest = stats.rhythm.busiestDay;
  // Calendar-day measures (active days, streaks, weekday × hour) say nothing about an hour or a single day:
  // under two days the tiles count the chart's own buckets instead.
  const shortRange = rangeDays(range) < 2;
  const activeBuckets = stats.buckets.filter(item => item.count > 0).length;
  const peak = stats.buckets.reduce<ActivityOverview["buckets"][number] | null>((best, item) => item.count > (best?.count ?? 0) ? item : best, null);
  return <>
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <StatTile title="提交数" value={formatCount(totals.commits)} note={compareText(totals.commits, previousTotals.commits, range)} />
      {shortRange
        ? <StatTile title="活跃时段" value={formatCount(activeBuckets)} unit={`/ ${formatCount(stats.buckets.length)}`} note={`按每${bucketUnitLabel(bucket)}划分，有提交的时段数`} />
        : <StatTile title="活跃天数" value={formatCount(totals.activeDays)} unit={`/ ${formatCount(Math.round(rangeDays(range)))} 天`} note={compareText(totals.activeDays, previousTotals.activeDays, range)} />}
      <StatTile title="活跃作者" value={formatCount(totals.authors)} unit="人" note={compareText(totals.authors, previousTotals.authors, range)} />
      {shortRange
        ? <StatTile title="最密集时段" value={peak ? formatCount(peak.count) : "0"} unit="个提交" note={peak ? `${bucketLabel(peak.startUnix, bucket)} 起的${bucketUnitLabel(bucket)}` : "当前范围内没有提交"} />
        : <StatTile title="单日最多" value={busiest ? formatCount(busiest.count) : "0"} unit="个提交" note={busiest ? busiest.day : "当前范围内没有提交"} />}
    </div>
    {coverage.complete ? null : <div><PartialTag coverage={coverage} /> <span className="text-xs text-fg3">以上数字只覆盖已建立索引的提交。</span></div>}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <BucketCard stats={stats} bucket={bucket} range={range} actions={actions} />
      <AuthorsCard stats={stats} actions={actions} />
    </div>
    {stats.sessions.length ? <SessionsCard stats={stats} actions={actions} /> : null}
    <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
      {shortRange ? null : <HeatmapCard stats={stats} />}
      <TypesCard stats={stats} />
      <BranchesCard stats={stats} />
    </div>
    {shortRange ? null : <RhythmCard stats={stats} />}
  </>;
}

function BucketCard({ stats, bucket, range, actions }: { stats: ActivityOverview; bucket: StatsBucket; range: { startUnix: number; endUnix: number }; actions: StatsActions }): React.JSX.Element {
  const title = bucketChartTitle(bucket);
  const total = stats.buckets.reduce((sum, item) => sum + item.count, 0);
  const items = stats.buckets.map((item, index) => {
    const end = stats.buckets[index + 1]?.startUnix ?? bucketEnd(item.startUnix, bucket);
    const clipped = clipToRange(item.startUnix, end, range);
    return {
      key: item.startUnix,
      label: bucketLabel(item.startUnix, bucket),
      value: item.count,
      title: `${bucketLabel(item.startUnix, bucket)} · ${item.count} 个提交`,
      startUnix: clipped.startUnix,
      endUnix: clipped.endUnix,
    };
  });
  const pick = (startUnix: number) => {
    const item = items.find(entry => entry.key === startUnix);
    if (!item) return;
    actions.filterTime(item.startUnix, item.endUnix);
  };
  return <StatsCard title={title} label={title} coverage={stats.coverage} className="min-h-[260px]" hint="点击一个柱筛选，或拖动框选多柱放大 / 查看">
    <BucketBars items={items} label={`${title}柱状图，共 ${formatCount(total)} 个提交${stats.coverage.complete ? "" : "（部分统计）"}`} onPick={pick}
      onZoom={actions.zoomTime} onFilterRange={actions.filterTime} empty="当前范围内没有提交。" />
    <p className="m-0 text-xs text-fg3">共 <b className="font-semibold text-fg tabular-nums">{formatCount(total)}</b> 个提交 · {formatDate(range.startUnix)} 起 {formatDate(range.endUnix - 1)} 止（本地时间）</p>
  </StatsCard>;
}

function AuthorsCard({ stats, actions }: { stats: ActivityOverview; actions: StatsActions }): React.JSX.Element {
  const authors = stats.authors.slice(0, 8);
  const max = Math.max(1, ...authors.map(author => author.count));
  return <StatsCard title="作者分布" coverage={stats.coverage} className="min-h-[260px]" hint="原始 Author，不合并别名；点击筛选此人">
    {authors.length ? <div className="flex flex-col gap-1" data-testid="stats-authors">
      {authors.map(author => {
        const name = author.name || author.email || "（未知身份）";
        const identity = author.name && author.email ? `${author.name} <${author.email}>` : name;
        return <button key={`${author.name}\0${author.email}`} type="button" data-testid="stats-author" title={identity} aria-label={`${identity}，${author.count} 个提交，筛选此人`}
          onClick={() => actions.filterAuthor({ name: author.name, email: author.email })}
          className="grid grid-cols-[112px_minmax(0,1fr)_40px] items-center gap-2.5 rounded-md px-1 py-[3px] text-left text-[13px] hover:bg-hover">
          <span className="truncate">{name}</span>
          <span className="h-2.5 rounded-[5px] bg-sunken"><span className="block h-2.5 rounded-[5px] bg-bar" style={{ width: `${Math.max(2, Math.round(author.count / max * 100))}%` }} /></span>
          <span className="text-right text-fg2 tabular-nums">{author.count}</span>
        </button>;
      })}
    </div> : <p className="m-0 text-xs text-fg3">当前范围内没有提交。</p>}
    {stats.authors.length > authors.length ? <p className="m-0 text-xs text-fg3">只显示前 {authors.length} 个身份，共 {stats.authors.length}{stats.authorsTruncated ? "+" : ""} 个。</p> : null}
    {truncationNote(stats.authorsTruncated && stats.authors.length <= authors.length, stats.authors.length)}
  </StatsCard>;
}

function SessionsCard({ stats, actions }: { stats: ActivityOverview; actions: StatsActions }): React.JSX.Element {
  return <StatsCard title="连续提交时段" coverage={stats.coverage} hint="相邻提交间隔不超过 10 分钟算一段；点击在提交页查看这段">
    <div className="flex flex-col gap-0.5" data-testid="stats-sessions">
      {stats.sessions.map(session => <button key={session.startUnix} type="button" onClick={() => actions.filterTime(session.startUnix, session.endUnix)}
        aria-label={`${formatDateTime(session.startUnix)} 到 ${formatClock(session.endUnix - 1)}，${session.count} 个提交，在提交页查看`}
        className="grid grid-cols-[120px_64px_minmax(0,1fr)] items-center gap-3 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-hover">
        <span className="tabular-nums">{formatDateTime(session.startUnix)}–{formatClock(session.endUnix - 1)}</span>
        <span className="text-fg2 tabular-nums">{session.count} 个提交</span>
        <span className="truncate text-fg3" title={session.authors.join("、")}>{session.authors.join("、")}</span>
      </button>)}
    </div>
    {truncationNote(stats.sessionsTruncated, stats.sessions.length)}
  </StatsCard>;
}

function HeatmapCard({ stats }: { stats: ActivityOverview }): React.JSX.Element {
  const grid = stats.weekHour;
  const max = Math.max(0, ...grid.flat());
  let best = { day: 0, hour: 0, count: 0 };
  grid.forEach((row, day) => row.forEach((count, hour) => { if (count > best.count) best = { day, hour, count }; }));
  const label = max === 0 ? "提交时段热力图，当前范围内没有提交" : `提交时段热力图，${WEEKDAYS[best.day]} ${best.hour} 点最多，${best.count} 个提交`;
  return <StatsCard title="提交时段" coverage={stats.coverage} hint="星期 × 小时 · 本地时区" className="lg:col-span-2 xl:col-span-1">
    {max === 0 ? <p className="m-0 text-xs text-fg3">当前范围内没有提交。</p> : <div role="img" aria-label={label} className="flex flex-col gap-[3px]">
      {grid.map((row, day) => <div key={day} className="grid items-center gap-[3px]" style={{ gridTemplateColumns: "28px repeat(24, minmax(0, 1fr))" }}>
        <span className="text-[11px] text-fg3">{WEEKDAYS[day]}</span>
        {row.map((count, hour) => <span key={hour} title={`${WEEKDAYS[day]} ${String(hour).padStart(2, "0")}:00 · ${count} 个提交`}
          className={cn("h-4 rounded-[3px]", count === 0 && "bg-sunken")} style={count ? accentAlpha(0.12 + 0.88 * count / max) : undefined} />)}
      </div>)}
      <div aria-hidden="true" className="grid gap-[3px] text-[11px] text-fg3" style={{ gridTemplateColumns: "28px repeat(24, minmax(0, 1fr))" }}>
        <span />{Array.from({ length: 24 }, (_, hour) => <span key={hour} className="text-center">{hour % 6 === 0 ? hour : ""}</span>)}
      </div>
    </div>}
  </StatsCard>;
}

function TypesCard({ stats }: { stats: ActivityOverview }): React.JSX.Element {
  const max = Math.max(1, ...stats.types.map(item => item.count));
  const specials = [["Merge 提交", stats.mergeCount], ["Revert", stats.revertCount], ["fixup! / squash!", stats.fixupCount]] as const;
  return <StatsCard title="提交类型" coverage={stats.coverage} hint="按标题前缀分组；merge 单列">
    {stats.types.length ? <div className="flex flex-col gap-1.5">
      {stats.types.map(item => <BarRow key={item.prefix} label={item.prefix || "其他"} value={item.count} max={max} labelWidth={84} />)}
    </div> : <p className="m-0 text-xs text-fg3">当前范围内没有非 merge 提交。</p>}
    <div className="flex flex-col gap-1 border-t border-line pt-2 text-[13px]">
      {specials.map(([name, count]) => <div key={name} className="flex justify-between"><span className="text-fg2">{name}</span><span className="tabular-nums">{formatCount(count)}</span></div>)}
    </div>
  </StatsCard>;
}

function BranchesCard({ stats }: { stats: ActivityOverview }): React.JSX.Element {
  const now = Math.floor(Date.now() / 1_000);
  const max = Math.max(1, ...stats.branches.map(item => item.count));
  return <StatsCard title="分支活跃度" coverage={stats.coverage} hint={`周期内的提交数；超过 ${INACTIVE_DAYS} 天没有提交的标“不活跃”`} className="lg:col-span-2 xl:col-span-1">
    {stats.branches.length ? <div className="flex flex-col gap-1.5" data-testid="stats-branches">
      {stats.branches.map(branch => {
        // An incomplete branch has ancestors the index has not reached yet: zero there is "not covered", never "inactive".
        const uncovered = !branch.complete && branch.count === 0;
        const inactive = branch.complete && branch.count === 0 && (branch.lastCommitUnix == null || now - branch.lastCommitUnix > INACTIVE_DAYS * 86_400);
        return <div key={branch.refName} className="grid grid-cols-[minmax(0,1fr)_96px_44px] items-center gap-2 text-[13px]">
          <span title={branch.refName} className="truncate font-mono text-xs">{branch.refName}</span>
          <span className="text-xs text-fg3">{uncovered ? "索引未覆盖" : inactive ? "不活跃" : branch.lastCommitUnix != null ? formatDate(branch.lastCommitUnix) : "—"}</span>
          <span className="text-right tabular-nums text-fg2">{uncovered ? "—" : `${branch.complete ? "" : "≥ "}${branch.count}`}</span>
          {branch.count > 0 ? <span aria-hidden="true" className="col-span-3 -mt-1 h-1 rounded-sm bg-sunken"><span className="block h-1 rounded-sm bg-bar" style={{ width: `${Math.round(branch.count / max * 100)}%` }} /></span> : null}
        </div>;
      })}
    </div> : <p className="m-0 text-xs text-fg3">没有本地分支。</p>}
    {truncationNote(stats.branchesTruncated, stats.branches.length)}
    {stats.branches.some(branch => !branch.complete) ? <p className="m-0 text-xs text-fg3">“≥”表示该分支的历史还没有全部进入索引，数字可能偏小。</p> : null}
  </StatsCard>;
}

function RhythmCard({ stats }: { stats: ActivityOverview }): React.JSX.Element {
  const { rhythm } = stats;
  return <StatsCard title="提交节奏" coverage={stats.coverage} hint="按本地日历日">
    <div className="grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-3">
      <div><div className="text-xs text-fg3">最长连续有提交</div><b className="text-lg font-semibold tabular-nums">{rhythm.longestStreakDays}</b> 天</div>
      <div><div className="text-xs text-fg3">最长间隔</div><b className="text-lg font-semibold tabular-nums">{rhythm.longestGapDays}</b> 天<span className="ml-1 text-xs text-fg3">相邻活跃日之间</span></div>
      <div><div className="text-xs text-fg3">单日最多</div>{rhythm.busiestDay
        ? <><b className="text-lg font-semibold tabular-nums">{rhythm.busiestDay.count}</b> 个 <span className="text-xs text-fg3">{rhythm.busiestDay.day}</span></>
        : <span className="text-fg3">—</span>}</div>
    </div>
  </StatsCard>;
}
