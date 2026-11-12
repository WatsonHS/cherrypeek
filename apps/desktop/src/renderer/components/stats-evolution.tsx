import * as React from "react";
import type { EvolutionResult } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { EvolutionRangeChoice } from "../lib/stats-range.js";
import type { EvolutionState } from "../lib/stats-store.js";
import { cn } from "../lib/utils.js";
import { PlaceholderBox } from "./placeholder.js";
import { BarRow, formatCount, formatDate, GitPathText, Segmented, SegmentBar, StatsCard, errorText } from "./stats-widgets.js";
import { Button } from "./ui/button.js";

const RANGE_OPTIONS: readonly { id: EvolutionRangeChoice; label: string }[] = [
  { id: "all", label: "全部历史" }, { id: "90d", label: "近 90 天" }, { id: "1y", label: "近 1 年" },
];

const SKIP_REASONS: Record<string, string> = {
  excluded: "在排除列表中", notRegularFile: "不是普通文件（链接或子模块）", byteLimit: "超过 1 MiB 的单文件上限", lineLimit: "超过 20000 行的单文件上限",
  binary: "二进制文件", fileLimit: "超过一次最多分析的文件数",
};
export const skipReason = (reason: string): string => SKIP_REASONS[reason] ?? `未分析（${reason}）`;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** A percentage only when kept does not exceed added; merge resolutions can make kept larger, which is shown as numbers. */
export function keptShare(added: number, kept: number): string | null {
  return added > 0 && kept <= added ? `${Math.round(kept / added * 100)}%` : null;
}

export interface EvolutionSectionProps {
  state: EvolutionState;
  /** Label of the tree version analysed, or null when the browsing scope has none. */
  version: { commit: string; label: string } | null;
  allBranches: boolean;
  onPath(text: string): void;
  onRange(choice: EvolutionRangeChoice): void;
  onEstimate(): void;
  onAnalyze(): void;
  onCancel(): void;
}

export function EvolutionSection({ state, version, allBranches, onPath, onRange, onEstimate, onAnalyze, onCancel }: EvolutionSectionProps): React.JSX.Element {
  const busy = state.phase === "estimating" || state.phase === "analyzing";
  return <div className="flex min-w-0 flex-col gap-4">
    <StatsCard title="分析范围" hint="按需分析，不随索引自动运行；结果缓存后第二次更快">
      {allBranches || !version ? <p className="m-0 text-[13px] text-fg2" data-testid="evolution-needs-scope">“全部分支”没有单一的代码版本。先在顶栏把浏览范围切到一个分支，再分析它的当前代码。</p> : <>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-fg3">路径
            <input type="text" value={state.pathText} onChange={event => onPath(event.target.value)} placeholder="留空分析整棵树，或输入目录 / 文件，如 apps/desktop/src" spellCheck={false}
              aria-label="要分析的目录或文件" data-testid="evolution-path" disabled={busy}
              className="h-7 min-w-[220px] flex-1 rounded-lg border border-line2 bg-panel px-2.5 font-mono text-[12.5px] text-fg outline-none focus:border-accent" />
          </label>
          <Segmented<EvolutionRangeChoice> label="存活统计的时间段" value={state.rangeChoice} options={RANGE_OPTIONS} onChange={onRange} disabled={busy} />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-fg3">
          <span>代码版本 <b className="font-mono font-medium text-fg">{version.label}</b> · <span className="font-mono">{version.commit.slice(0, 10)}</span></span>
          <span className="min-w-0 flex-1" />
          {busy ? <Button variant="outline" size="sm" onClick={onCancel}>取消</Button> : null}
          {state.phase === "idle" || state.phase === "error" || state.phase === "ready" || state.phase === "done" || state.phase === "cancelled"
            ? <Button variant={state.phase === "ready" ? "outline" : "default"} size="sm" onClick={onEstimate} data-testid="evolution-estimate">估算范围</Button> : null}
        </div>
        {state.phase === "estimating" ? <p role="status" className="m-0 text-xs text-fg3">正在估算要分析的文件…</p> : null}
        {state.error ? <p role="alert" className="m-0 text-xs text-bad" data-testid="evolution-error">{errorText(state.error)}</p> : null}
        {state.estimate ? <EstimateBlock state={state} onAnalyze={onAnalyze} /> : null}
      </>}
    </StatsCard>
    {state.chunk ? <EvolutionResultView result={state.chunk.result} state={state} /> : null}
  </div>;
}

function EstimateBlock({ state, onAnalyze }: { state: EvolutionState; onAnalyze(): void }): React.JSX.Element {
  const estimate = state.estimate!;
  const idle = state.phase === "ready" || state.phase === "done" || state.phase === "cancelled" || state.phase === "error";
  return <div className="flex flex-col gap-2 border-t border-line pt-3" data-testid="evolution-estimate-result">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
      <span>可分析 <b className="tabular-nums">{formatCount(estimate.files)}</b> 个文件</span>
      <span><b className="tabular-nums">{formatCount(estimate.lines)}</b> 行</span>
      <span className="tabular-nums text-fg2">{formatBytes(estimate.bytes)}</span>
      <span className="text-fg3">路径下共 {formatCount(estimate.totalFiles)} 个条目，一次最多分析 {estimate.fileLimit} 个文件</span>
      <span className="min-w-0 flex-1" />
      {idle ? <Button size="sm" onClick={onAnalyze} disabled={estimate.files === 0} data-testid="evolution-start">开始分析</Button> : null}
    </div>
    {estimate.files === 0 ? <p className="m-0 text-xs text-fg3">这个路径下没有可分析的文件。</p> : null}
    <SkippedList skipped={estimate.skipped} title="估算时跳过" />
  </div>;
}

function SkippedList({ skipped, title }: { skipped: { path: { display: string; rawHex: string; textLossy: boolean }; reason: string }[]; title: string }): React.JSX.Element | null {
  if (!skipped.length) return null;
  return <details className="text-xs text-fg3">
    <summary className="cursor-pointer select-none">{title} {formatCount(skipped.length)} 个文件</summary>
    <ul className="m-0 mt-1 flex max-h-40 list-none flex-col gap-0.5 overflow-y-auto p-0">
      {skipped.map(item => <li key={item.path.rawHex} className="flex gap-2"><GitPathText path={item.path} className="flex-1" /><span className="shrink-0">{skipReason(item.reason)}</span></li>)}
    </ul>
  </details>;
}

function EvolutionResultView({ result, state }: { result: EvolutionResult; state: EvolutionState }): React.JSX.Element {
  const progress = state.chunk!.progress;
  const running = state.phase === "analyzing";
  const partial = state.phase !== "done" || !result.complete;
  const ageTotal = result.age.within7d + result.age.within30d + result.age.within90d + result.age.within1y + result.age.older;
  const ageParts = [
    { name: "7 天内", count: result.age.within7d, tone: "bg-chart-strong" }, { name: "30 天内", count: result.age.within30d, tone: "bg-accent" },
    { name: "90 天内", count: result.age.within90d, tone: "bg-bar" }, { name: "1 年内", count: result.age.within1y, tone: "bg-chart-weak" }, { name: "更早", count: result.age.older, tone: "bg-line2" },
  ];
  const ownerMax = Math.max(1, ...result.ownership.map(item => item.lines));
  const weeks = result.survival.weeks;
  const weekMax = Math.max(1, ...weeks.map(week => Math.max(week.added, week.kept)));
  const totalAdded = weeks.reduce((sum, week) => sum + week.added, 0);
  const totalKept = weeks.reduce((sum, week) => sum + week.kept, 0);
  const overall = keptShare(totalAdded, totalKept);
  return <div className="flex min-w-0 flex-col gap-4" data-testid="evolution-result">
    <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-panel px-[18px] py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg3">
        <span role="status">{running ? "正在分析" : state.phase === "cancelled" ? "已取消，保留已收到的结果" : state.phase === "error" ? "分析中断，保留已收到的结果" : result.complete ? "分析完成" : "分析完成，部分文件没有结果"}</span>
        <span className="tabular-nums">{formatCount(progress.filesDone)} / {formatCount(progress.filesTotal)} 个文件</span>
        {partial && !running ? <span className="inline-flex h-[18px] items-center rounded-[5px] bg-warn-bg px-1.5 text-[11px] font-medium text-warn">部分 · 已覆盖 {formatCount(result.covered.files)} 个文件 / {formatCount(result.covered.lines)} 行</span> : null}
        <span className="min-w-0 flex-1" />
        <span>截至 {formatDate(result.asOfUnix)}</span>
      </div>
      {running ? <>
        <div role="progressbar" aria-label="分析进度" aria-valuemin={0} aria-valuemax={Math.max(1, progress.filesTotal)} aria-valuenow={progress.filesDone} className="h-1.5 rounded-full bg-sunken">
          <div className="h-1.5 rounded-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${progress.filesTotal ? Math.round(progress.filesDone / progress.filesTotal * 100) : 0}%` }} />
        </div>
        {progress.currentPath ? <div className="flex gap-1 text-xs text-fg3">正在处理 <GitPathText path={progress.currentPath} /></div> : null}
      </> : null}
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <StatsCard title="代码年龄" hint="当前行按最后修改的 Author 时间">
        {ageTotal ? <>
          <SegmentBar label={`代码年龄：${ageParts.map(part => `${part.name} ${formatCount(part.count)} 行`).join("，")}`} parts={ageParts.map(part => ({ name: part.name, percent: part.count / ageTotal * 100, tone: part.tone }))} />
          <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[13px]">
            {ageParts.map(part => <li key={part.name} className="flex items-center gap-1.5"><span aria-hidden="true" className={cn("size-2.5 rounded-xs", part.tone)} />{part.name}
              <span className="tabular-nums text-fg2">{formatCount(part.count)} 行</span></li>)}
          </ul>
        </> : <p className="m-0 text-xs text-fg3">还没有结果。</p>}
      </StatsCard>
      <StatsCard title="当前归属" hint="现有代码行的最后修改者（blame）；不合并别名">
        {result.ownership.length ? <div className="flex flex-col gap-1.5">
          {result.ownership.slice(0, 10).map(item => <BarRow key={`${item.author.name}\0${item.author.email}`} label={item.author.name || item.author.email || "（未知）"} value={item.lines} max={ownerMax}
            display={`${formatCount(item.lines)} 行 · ${formatCount(item.commits)} 提交`} valueWidth={130} />)}
          {result.ownership.length > 10 ? <p className="m-0 text-xs text-fg3">只显示前 10 位，共 {result.ownership.length} 位。</p> : null}
        </div> : <p className="m-0 text-xs text-fg3">还没有结果。</p>}
      </StatsCard>
    </div>
    <StatsCard title="代码存活" coverage={result.survival.coverage} hint="时间段内新增的行，有多少还在当前代码里；按周（UTC 周一）">
      {weeks.length ? <>
        <div role="img" aria-label={`代码存活：新增 ${formatCount(totalAdded)} 行，仍保留 ${formatCount(totalKept)} 行`} className="flex h-[110px] items-end gap-[3px] border-b border-line">
          {weeks.map(week => <div key={week.startUnix} title={`${formatDate(week.startUnix)} 起的一周 · 新增 ${formatCount(week.added)} · 保留 ${formatCount(week.kept)}`} className="flex h-full min-w-0 flex-1 items-end gap-px">
            <div className="min-w-px flex-1 rounded-t bg-chart-weak" style={{ height: Math.round(week.added / weekMax * 100) }} />
            <div className="min-w-px flex-1 rounded-t bg-chart-strong" style={{ height: Math.round(week.kept / weekMax * 100) }} />
          </div>)}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg3">
          <span className="flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-xs bg-chart-weak" />新增</span>
          <span className="flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-xs bg-chart-strong" />仍保留</span>
          <span>合计 新增 {formatCount(totalAdded)} · 保留 {formatCount(totalKept)}{overall ? ` · ${overall}` : totalKept > totalAdded ? "（保留多于新增，通常来自 merge 解决，不换算百分比）" : ""}</span>
        </div>
        {result.survival.byAuthor.length ? <div className="flex flex-col gap-1 text-[13px]" data-testid="evolution-by-author">
          {result.survival.byAuthor.slice(0, 10).map(item => <div key={`${item.author.name}\0${item.author.email}`} className="grid grid-cols-[minmax(0,1fr)_96px_96px_56px] items-center gap-2">
            <span className="truncate" title={`${item.author.name} <${item.author.email}>`}>{item.author.name || item.author.email}</span>
            <span className="text-right tabular-nums text-fg2">新增 {formatCount(item.added)}</span>
            <span className="text-right tabular-nums text-fg2">保留 {formatCount(item.kept)}</span>
            <span className="text-right tabular-nums text-fg3">{keptShare(item.added, item.kept) ?? "—"}</span>
          </div>)}
        </div> : null}
      </> : <p className="m-0 text-xs text-fg3">所选时间段内没有新增的行。</p>}
      <p className="m-0 text-xs text-fg3">存活只比较新增与保留的行数，不推断工作量；重命名会追踪旧路径，已跳过的文件不计入。</p>
    </StatsCard>
    <SkippedList skipped={result.skipped} title="未分析" />
  </div>;
}

export function EvolutionPlaceholder(): React.JSX.Element {
  return <PlaceholderBox task="P6-05" title="演化分析" note="当前核心还不支持按需演化分析（缺少 evolution 能力）。" />;
}

