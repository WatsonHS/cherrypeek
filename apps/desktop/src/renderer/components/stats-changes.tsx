import * as React from "react";
import { ChevronRight } from "lucide-react";
import type { ChangeStats, GitPath } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { StatsBucket, StatsSelection } from "../../../../../packages/protocol/src/generated/client-message.js";
import type { RepositorySessionResult } from "../../../../../packages/protocol/src/repository-session.js";
import type { StatsCommitPage } from "../../../../../packages/protocol/src/generated/server-message.js";
import { bucketEnd, bucketLabel, clipToRange, compareText } from "../lib/stats-range.js";
import { crumbOf } from "../lib/stats-store.js";
import type { ExclusionsState, StatsCrumb, StatsRequest, StatsSlot } from "../lib/stats-store.js";
import { cn } from "../lib/utils.js";
import { CommitsPopover } from "./stats-commits-popover.js";
import {
  accentAlpha, AddDelLegend, BarRow, formatClock, formatCount, formatDateTime, GitPathText, PartialTag, SegmentBar, SignedBars, SlotGate, StatsCard, StatTile, truncationNote,
} from "./stats-widgets.js";
import type { StatsActions } from "./stats-widgets.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

const SIZE_LABELS = ["1–10 行", "11–50 行", "51–200 行", "201–1,000 行", "1,000 行以上"] as const;

export interface ChangesSectionProps {
  slot: StatsSlot<ChangeStats>;
  prefix: StatsCrumb[];
  exclusions: ExclusionsState;
  onRetry(): void;
  onPrefix(crumbs: StatsCrumb[]): void;
  onLoadExclusions(): void;
  onSaveExclusions(patterns: string[]): Promise<boolean>;
  actions: StatsActions;
  commits(selection: StatsSelection, offset: number): Promise<RepositorySessionResult<StatsCommitPage>>;
}

export function ChangesSection(props: ChangesSectionProps): React.JSX.Element {
  return <SlotGate slot={props.slot} onRetry={props.onRetry} noun="改动">
    {stats => <ChangeCards stats={stats} request={props.slot.loaded!} {...props} />}
  </SlotGate>;
}

function signed(value: number): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatCount(Math.abs(value))}`;
}

function ChangeCards({ stats, request, prefix, exclusions, onPrefix, onLoadExclusions, onSaveExclusions, actions, commits }: ChangesSectionProps & { stats: ChangeStats; request: StatsRequest }): React.JSX.Element {
  const { totals, previousTotals, range, bucket } = { ...stats, ...request };
  const net = totals.additions - totals.deletions;
  const previousNet = previousTotals.additions - previousTotals.deletions;
  const hasChanges = totals.additions + totals.deletions + totals.filesChanged > 0;
  return <>
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <StatTile title="增加行" value={formatCount(totals.additions)} note={compareText(totals.additions, previousTotals.additions, range)} />
      <StatTile title="删除行" value={formatCount(totals.deletions)} note={compareText(totals.deletions, previousTotals.deletions, range)} />
      <StatTile title="净增行" value={signed(net)} note={compareText(net, previousNet, range)} />
      <StatTile title="改动文件" value={formatCount(totals.filesChanged)} unit="条"
        note={`新增 ${formatCount(totals.filesAdded)} · 删除 ${formatCount(totals.filesDeleted)} · 重命名 ${formatCount(totals.filesRenamed)}`} />
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg3">
      <PartialTag coverage={stats.coverage} />
      <span data-testid="stats-excluded">已从行数中排除 <b className="font-semibold text-fg tabular-nums">{formatCount(stats.excluded.lines)}</b> 行
        （命中排除列表的文件改动 {formatCount(stats.excluded.lockFiles)} 条；排除 merge 提交 {formatCount(stats.excluded.mergeCommits)} 个）。文件数仍保留这些改动。</span>
      <ExclusionsEditor state={exclusions} onLoad={onLoadExclusions} onSave={onSaveExclusions} />
    </div>
    {!hasChanges && stats.coverage.complete ? <p className="m-0 rounded-xl border border-line px-4 py-6 text-center text-xs text-fg3">当前范围内没有文件改动。</p> : null}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <StatsCard title="增加 / 删除行" coverage={stats.coverage} hint={<AddDelLegend />}>
        <SignedBars label={`增加和删除行数，每${bucket === "tenMinutes" ? " 10 分钟" : bucket === "hour" ? "小时" : bucket === "day" ? "天" : bucket === "week" ? "周" : "月"}一柱，共增加 ${formatCount(totals.additions)} 行，删除 ${formatCount(totals.deletions)} 行`}
          onRangeSelect={{ onZoom: actions.zoomTime, onFilter: actions.filterTime }}
          items={stats.buckets.map((item, index) => {
            const end = stats.buckets[index + 1]?.startUnix ?? bucketEnd(item.startUnix, bucket);
            const clipped = clipToRange(item.startUnix, end, range);
            return { label: bucketLabel(item.startUnix, bucket), add: item.additions, del: item.deletions, startUnix: clipped.startUnix, endUnix: clipped.endUnix };
          })} />
        <p className="m-0 text-xs text-fg3">行数相对第一父提交；merge 提交不计；二进制只计文件数；拖动柱状图可框选放大或在提交页查看。</p>
      </StatsCard>
      <NetGrowthCard stats={stats} bucket={bucket} />
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <DirectoriesCard stats={stats} prefix={prefix} onPrefix={onPrefix} actions={actions} commits={commits} />
      <FilesCard stats={stats} actions={actions} commits={commits} />
    </div>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <SizeCard stats={stats} />
      <LargestCard stats={stats} actions={actions} />
    </div>
    <MatrixCard stats={stats} actions={actions} />
    <div className="grid gap-4 lg:grid-cols-2">
      <KindsCard stats={stats} />
      <ExtensionsCard stats={stats} />
    </div>
    {stats.sessions.length ? <ChangeSessionsCard stats={stats} actions={actions} /> : null}
    <p className="m-0 text-xs text-fg3">口径：统计行数时启用整文件重命名检测，移动文件不算整份删除加新增（与路径历史的字面匹配不同）；测试按路径中的 test / tests / __tests__ / spec 目录或文件名含 .test. / .spec. / _test. 识别，
      .md 文件和 docs/ 下的文件算文档，其余算代码，识别不了的仓库结果会偏，不据此下结论。</p>
  </>;
}

function ExclusionsEditor({ state, onLoad, onSave }: { state: ExclusionsState; onLoad(): void; onSave(patterns: string[]): Promise<boolean> }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => { if (state.value && !dirty) setText(state.value.patterns.join("\n")); }, [state.value, dirty]);
  const change = (next: boolean) => {
    setOpen(next);
    if (next) { setDirty(false); if (!state.value) onLoad(); }
  };
  const patterns = text.split("\n").map(line => line.trim()).filter(Boolean);
  const save = async () => { if (await onSave(patterns)) { setDirty(false); setOpen(false); } };
  return <Popover open={open} onOpenChange={change}>
    <PopoverTrigger asChild><button type="button" data-testid="stats-exclusions-edit" className="rounded px-1.5 py-0.5 text-accent-fg underline-offset-2 hover:bg-hover hover:underline">编辑排除列表</button></PopoverTrigger>
    <PopoverContent align="start" aria-label="排除列表" className="flex w-[380px] flex-col gap-2 p-3">
      <span className="text-xs font-semibold text-fg3">从行数中排除的文件（按仓库保存）</span>
      <p className="m-0 text-xs text-fg3">每行一条。不含 / 的规则精确匹配文件名；含 / 的匹配完整路径；以 / 结尾的匹配目录前缀；hex:… 精确匹配非 UTF-8 路径。不支持通配符。最多 100 条。</p>
      <textarea aria-label="排除规则，每行一条" value={text} rows={8} spellCheck={false} disabled={!state.value && state.loading}
        onChange={event => { setText(event.target.value); setDirty(true); }}
        className="resize-y rounded-lg border border-line2 bg-sunken p-2 font-mono text-xs text-fg outline-none focus:border-accent" />
      {state.value ? <p className="m-0 text-xs text-fg3" title={state.value.defaults.join("\n")}>默认：{state.value.defaults.slice(0, 4).join("、")} 等 {state.value.defaults.length} 项。</p> : null}
      {state.error ? <p role="alert" className="m-0 text-xs text-bad">{state.error.message}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={!state.value || state.saving} onClick={() => { setText(state.value!.defaults.join("\n")); setDirty(true); }}>恢复默认</Button>
        <Button size="sm" disabled={!state.value || state.saving || patterns.length > 100} onClick={() => void save()}>{state.saving ? "保存中…" : "保存"}</Button>
      </div>
    </PopoverContent>
  </Popover>;
}

function NetGrowthCard({ stats, bucket }: { stats: ChangeStats; bucket: StatsBucket }): React.JSX.Element {
  const values = stats.buckets.map(item => item.netGrowth);
  const last = values[values.length - 1] ?? 0;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = Math.max(1, max - min);
  const points = values.map((value, index) => `${values.length > 1 ? index / (values.length - 1) * 100 : 50},${38 - (value - min) / span * 36}`).join(" ");
  const zero = 38 - (0 - min) / span * 36;
  return <StatsCard title="净增长" coverage={stats.coverage} hint="本周期累计">
    {values.length ? <>
      <svg role="img" aria-label={`净增长曲线，${bucketLabel(stats.buckets[0]!.startUnix, bucket)} 起累计 ${signed(last)} 行`} viewBox="0 0 100 40" preserveAspectRatio="none" className="h-[120px] w-full overflow-visible">
        <line x1="0" x2="100" y1={zero} y2={zero} className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <polyline points={points} fill="none" className="stroke-chart-strong" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="m-0 text-xs text-fg3">累计 <b className="font-semibold text-fg tabular-nums">{signed(last)}</b> 行（增加减删除，排除列表中的文件不计）。</p>
    </> : <p className="m-0 text-xs text-fg3">当前范围内没有数据。</p>}
  </StatsCard>;
}

function relativeName(path: GitPath, parent: StatsCrumb | undefined): string {
  if (parent && path.display.startsWith(`${parent.display}/`)) return path.display.slice(parent.display.length + 1);
  return path.display;
}

function DirectoriesCard({ stats, prefix, onPrefix, actions, commits }: { stats: ChangeStats; prefix: StatsCrumb[]; onPrefix(crumbs: StatsCrumb[]): void; actions: StatsActions; commits: ChangesSectionProps["commits"] }): React.JSX.Element {
  const parent = prefix[prefix.length - 1];
  const max = Math.max(1, ...stats.directories.map(item => item.lines));
  return <StatsCard title="热点目录" coverage={stats.coverage} hint="按改动行数；点目录名下钻一级">
    <nav aria-label="目录路径" className="flex flex-wrap items-center gap-0.5 text-xs">
      <button type="button" onClick={() => onPrefix([])} aria-current={prefix.length === 0 ? "true" : undefined} className="rounded px-1 py-0.5 hover:bg-hover aria-[current=true]:font-semibold">仓库根</button>
      {prefix.map((crumb, index) => <React.Fragment key={crumb.rawHex}>
        <ChevronRight className="size-3 text-fg3" aria-hidden="true" />
        <button type="button" onClick={() => onPrefix(prefix.slice(0, index + 1))} aria-current={index === prefix.length - 1 ? "true" : undefined}
          className="max-w-[200px] truncate rounded px-1 py-0.5 font-mono hover:bg-hover aria-[current=true]:font-semibold" title={crumb.display}>{crumb.display.split("/").pop()}</button>
      </React.Fragment>)}
    </nav>
    {stats.directories.length ? <div className="flex flex-col gap-1" data-testid="stats-directories">
      {stats.directories.map(item => <div key={item.path.rawHex} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_56px_44px_auto] items-center gap-2 text-[13px]">
        <button type="button" onClick={() => onPrefix([...prefix, crumbOf(item.path)])} title={`${item.path.display}（下钻）`} aria-label={`下钻到 ${item.path.display}`}
          className="min-w-0 truncate rounded px-1 text-left font-mono text-xs hover:bg-hover">{relativeName(item.path, parent)}/{item.path.textLossy ? <span className="ml-1 font-sans text-warn">非 UTF-8</span> : null}</button>
        <div className="h-2.5 rounded-[5px] bg-sunken"><div className="h-2.5 rounded-[5px] bg-bar" style={{ width: `${Math.max(2, Math.round(item.lines / max * 100))}%` }} /></div>
        <span className="text-right tabular-nums text-fg2" title="改动行数">{formatCount(item.lines)}</span>
        <CommitsPopover label={`${item.path.display} 的 ${item.commits} 个提交`} title={`${item.path.display} 的提交`}
          load={offset => commits({ kind: "directory", pathHex: item.path.rawHex }, offset)} onSelect={actions.showCommit}>{formatCount(item.commits)}</CommitsPopover>
        <RowActions path={item.path} kind="directory" actions={actions} />
      </div>)}
    </div> : <p className="m-0 text-xs text-fg3">这一级下没有子目录的改动。</p>}
    {truncationNote(stats.directoriesTruncated, stats.directories.length)}
    <p className="m-0 text-xs text-fg3">最右两列：行数 · 提交数（点开提交列表）。</p>
  </StatsCard>;
}

function RowActions({ path, kind, actions }: { path: GitPath; kind: "file" | "directory"; actions: StatsActions }): React.JSX.Element {
  const button = "rounded px-1 text-xs text-fg3 hover:bg-hover hover:text-fg";
  return <span className="flex gap-0.5">
    <button type="button" className={button} title="在提交页按此路径筛选" aria-label={`在提交页筛选 ${path.display}`} onClick={() => actions.filterPath(kind, path.rawHex)}>筛选</button>
    <button type="button" className={button} title="在演化分析中分析此路径" aria-label={`分析 ${path.display} 的演化`} onClick={() => actions.openEvolution(path)}>演化</button>
  </span>;
}

function FilesCard({ stats, actions, commits }: { stats: ChangeStats; actions: StatsActions; commits: ChangesSectionProps["commits"] }): React.JSX.Element {
  const max = Math.max(1, ...stats.files.map(item => item.additions + item.deletions));
  return <StatsCard title="热点文件" coverage={stats.coverage} hint="按改动行数（当前目录范围内）">
    {stats.files.length ? <div className="flex flex-col gap-1" data-testid="stats-files">
      {stats.files.map(item => <div key={item.path.rawHex} className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,0.8fr)_76px_44px_auto] items-center gap-2 text-[13px]">
        <GitPathText path={item.path} />
        <div className="h-2.5 rounded-[5px] bg-sunken"><div className="h-2.5 rounded-[5px] bg-bar" style={{ width: `${Math.max(2, Math.round((item.additions + item.deletions) / max * 100))}%` }} /></div>
        <span className="text-right text-xs tabular-nums text-fg2" title="增加 / 删除行"><span className="text-chart-add">+{formatCount(item.additions)}</span> <span className="text-chart-del">−{formatCount(item.deletions)}</span></span>
        <CommitsPopover label={`${item.path.display} 的 ${item.commits} 个提交`} title={`${item.path.display} 的提交`}
          load={offset => commits({ kind: "file", pathHex: item.path.rawHex }, offset)} onSelect={actions.showCommit}>{formatCount(item.commits)}</CommitsPopover>
        <RowActions path={item.path} kind="file" actions={actions} />
      </div>)}
    </div> : <p className="m-0 text-xs text-fg3">没有文件改动。</p>}
    {truncationNote(stats.filesTruncated, stats.files.length)}
  </StatsCard>;
}

function SizeCard({ stats }: { stats: ChangeStats }): React.JSX.Element {
  const max = Math.max(1, ...stats.sizeHistogram);
  const total = stats.sizeHistogram.reduce((sum, value) => sum + value, 0);
  return <StatsCard title="提交大小" coverage={stats.coverage} hint="按改动行数分档；零行提交不入档">
    {total ? <div className="flex flex-col gap-1.5" role="group" aria-label={`提交大小分布，共 ${total} 个提交`}>
      {SIZE_LABELS.map((label, index) => <BarRow key={label} label={label} value={stats.sizeHistogram[index] ?? 0} max={max} labelWidth={96} valueWidth={44} />)}
    </div> : <p className="m-0 text-xs text-fg3">当前范围内没有带行数的提交。</p>}
  </StatsCard>;
}

function LargestCard({ stats, actions }: { stats: ChangeStats; actions: StatsActions }): React.JSX.Element {
  return <StatsCard title="最大的提交" coverage={stats.coverage} hint="点击在提交页选中">
    {stats.largest.length ? <div className="flex flex-col gap-0.5" data-testid="stats-largest">
      {stats.largest.map(commit => <button key={commit.oid} type="button" onClick={() => actions.showCommit(commit.oid)} title={commit.summary}
        className="grid grid-cols-[60px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-hover">
        <span className="font-mono text-xs text-fg3">{commit.oid.slice(0, 8)}</span>
        <span className="min-w-0"><span className="block truncate">{commit.summary || "（无标题）"}</span><span className="block truncate text-xs text-fg3">{commit.author.name || commit.author.email}</span></span>
        <span className="text-xs tabular-nums"><span className="text-chart-add">+{formatCount(commit.additions)}</span> <span className="text-chart-del">−{formatCount(commit.deletions)}</span></span>
      </button>)}
    </div> : <p className="m-0 text-xs text-fg3">当前范围内没有带行数的提交。</p>}
  </StatsCard>;
}

function MatrixCard({ stats, actions }: { stats: ChangeStats; actions: StatsActions }): React.JSX.Element {
  const totals = new Map<string, { path: GitPath; lines: number }>();
  for (const row of stats.authorDirectories) for (const cell of row.cells) {
    const entry = totals.get(cell.directory.rawHex) ?? { path: cell.directory, lines: 0 };
    entry.lines += cell.lines;
    totals.set(cell.directory.rawHex, entry);
  }
  const columns = [...totals.values()].sort((left, right) => right.lines - left.lines).slice(0, 6);
  const max = Math.max(1, ...stats.authorDirectories.flatMap(row => row.cells.map(cell => cell.lines)));
  const template = `minmax(96px, 1.2fr) repeat(${Math.max(1, columns.length)}, minmax(0, 1fr))`;
  return <StatsCard title="作者 × 目录" coverage={stats.coverage} hint="每人行数最多的顶层目录；点作者筛选">
    {stats.authorDirectories.length && columns.length ? <div className="flex flex-col gap-1 overflow-x-auto" role="table" aria-label="作者与顶层目录的改动行数">
      <div role="row" className="grid gap-1.5 text-[11.5px] text-fg3" style={{ gridTemplateColumns: template }}>
        <span role="columnheader">作者</span>{columns.map(column => <span role="columnheader" key={column.path.rawHex} className="truncate font-mono" title={column.path.display}>{column.path.display || "（根）"}</span>)}
      </div>
      {stats.authorDirectories.slice(0, 12).map(row => <div role="row" key={`${row.author.name}\0${row.author.email}`} className="grid items-center gap-1.5 text-[13px]" style={{ gridTemplateColumns: template }}>
        <button type="button" role="rowheader" onClick={() => actions.filterAuthor(row.author)} className="truncate rounded px-1 text-left hover:bg-hover" title={`${row.author.name} <${row.author.email}>`}>{row.author.name || row.author.email}</button>
        {columns.map(column => {
          const lines = row.cells.find(cell => cell.directory.rawHex === column.path.rawHex)?.lines ?? 0;
          return <span role="cell" key={column.path.rawHex} title={`${row.author.name} · ${column.path.display} · ${formatCount(lines)} 行`}
            className={cn("flex h-6 items-center justify-center rounded-md text-[11.5px] tabular-nums", lines === 0 && "bg-sunken text-fg3")} style={lines ? accentAlpha(0.12 + 0.6 * lines / max) : undefined}>{lines ? formatCount(lines) : ""}</span>;
        })}
      </div>)}
    </div> : <p className="m-0 text-xs text-fg3">没有可显示的作者与目录。</p>}
    {stats.authorDirectories.length > 12 ? <p className="m-0 text-xs text-fg3">只显示前 12 位作者，共 {stats.authorDirectories.length}{stats.authorDirectoriesTruncated ? "+" : ""} 位。</p> : truncationNote(stats.authorDirectoriesTruncated, stats.authorDirectories.length)}
  </StatsCard>;
}

function KindsCard({ stats }: { stats: ChangeStats }): React.JSX.Element {
  const { code, test, docs } = stats.kinds;
  const total = code + test + docs;
  const parts = [{ name: "代码", count: code, tone: "bg-chart-strong" }, { name: "测试", count: test, tone: "bg-chart-add" }, { name: "文档", count: docs, tone: "bg-chart-weak" }];
  return <StatsCard title="代码 / 测试 / 文档" coverage={stats.coverage} hint="改动行数，按路径约定识别">
    {total ? <>
      <SegmentBar label={`改动行数构成：${parts.map(part => `${part.name} ${formatCount(part.count)} 行`).join("，")}`} parts={parts.map(part => ({ name: part.name, percent: part.count / total * 100, tone: part.tone }))} />
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[13px]">
        {parts.map(part => <li key={part.name} className="flex items-center gap-1.5"><span aria-hidden="true" className={cn("size-2.5 rounded-xs", part.tone)} />{part.name}
          <span className="tabular-nums text-fg2">{formatCount(part.count)} 行 · {Math.round(part.count / total * 100)}%</span></li>)}
      </ul>
    </> : <p className="m-0 text-xs text-fg3">当前范围内没有带行数的改动。</p>}
  </StatsCard>;
}

function ExtensionsCard({ stats }: { stats: ChangeStats }): React.JSX.Element {
  const list = [...stats.extensions].sort((left, right) => right.additions + right.deletions - (left.additions + left.deletions)).slice(0, 10);
  const max = Math.max(1, ...list.map(item => item.additions + item.deletions));
  return <StatsCard title="文件类型" coverage={stats.coverage} hint="按扩展名的改动行数">
    {list.length ? <div className="flex flex-col gap-1.5">
      {list.map(item => <BarRow key={item.extension} label={item.extension} mono value={item.additions + item.deletions} max={max} labelWidth={84} valueWidth={64}
        display={`${formatCount(item.additions + item.deletions)}`} />)}
    </div> : <p className="m-0 text-xs text-fg3">没有文件改动。</p>}
    {truncationNote(stats.extensionsTruncated || stats.extensions.length > list.length, list.length)}
  </StatsCard>;
}

function ChangeSessionsCard({ stats, actions }: { stats: ChangeStats; actions: StatsActions }): React.JSX.Element {
  return <StatsCard title="连续提交时段 · 改动" coverage={stats.coverage} hint="相邻提交间隔不超过 10 分钟算一段；点击在提交页查看">
    <div className="flex flex-col gap-0.5">
      {stats.sessions.map(session => <button key={session.startUnix} type="button" onClick={() => actions.filterTime(session.startUnix, session.endUnix)}
        className="grid grid-cols-[120px_64px_96px_minmax(0,1fr)] items-center gap-3 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-hover">
        <span className="tabular-nums">{formatDateTime(session.startUnix)}–{formatClock(session.endUnix - 1)}</span>
        <span className="text-fg2 tabular-nums">{session.count} 个提交</span>
        <span className="text-xs tabular-nums"><span className="text-chart-add">+{formatCount(session.additions)}</span> <span className="text-chart-del">−{formatCount(session.deletions)}</span></span>
        <span className="truncate font-mono text-xs text-fg3" title={session.directories.map(path => path.display).join("、")}>{session.directories.map(path => path.display || "（根）").join("、")}</span>
      </button>)}
    </div>
    {truncationNote(stats.sessionsTruncated, stats.sessions.length)}
  </StatsCard>;
}
