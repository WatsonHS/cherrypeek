import * as React from "react";
import type { NotableStats, StatsCommitPage } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { StatsSelection } from "../../../../../packages/protocol/src/generated/client-message.js";
import type { RepositorySessionResult } from "../../../../../packages/protocol/src/repository-session.js";
import type { StatsSlot } from "../lib/stats-store.js";
import { cn } from "../lib/utils.js";
import { CommitsPopover } from "./stats-commits-popover.js";
import { formatCount, GitPathText, SlotGate, StatsCard, truncationNote } from "./stats-widgets.js";
import type { StatsActions } from "./stats-widgets.js";

export interface NotableSectionProps {
  slot: StatsSlot<NotableStats>;
  onRetry(): void;
  actions: StatsActions;
  commits(selection: StatsSelection, offset: number): Promise<RepositorySessionResult<StatsCommitPage>>;
}

/** Observed facts only: no scores, no verdicts. */
export function NotableSection({ slot, onRetry, actions, commits }: NotableSectionProps): React.JSX.Element {
  return <SlotGate slot={slot} onRetry={onRetry} noun="关注项">
    {stats => <>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChurnCard stats={stats} actions={actions} commits={commits} />
        <PairsCard stats={stats} commits={commits} actions={actions} />
        <SoloCard stats={stats} actions={actions} commits={commits} />
        <UntestedCard stats={stats} actions={actions} commits={commits} />
      </div>
      <p className="m-0 text-xs text-fg3">这里只陈述观察到的事实，供你判断；排除列表中的文件不参与。反复修改可能是返工，也可能只是热点。</p>
    </>}
  </SlotGate>;
}

function ChurnCard({ stats, actions, commits }: { stats: NotableStats; actions: StatsActions; commits: NotableSectionProps["commits"] }): React.JSX.Element {
  return <StatsCard title="反复修改的文件" coverage={stats.coverage} hint="至少改动两次；按次数；方格为当前粒度下有无改动">
    {stats.churnFiles.length ? <div className="flex flex-col gap-1" data-testid="stats-churn">
      {stats.churnFiles.map(file => <div key={file.path.rawHex} className="grid grid-cols-[minmax(0,1fr)_auto_44px_52px] items-center gap-2 text-[13px]">
        <button type="button" className="min-w-0 rounded px-1 text-left hover:bg-hover" onClick={() => actions.filterPath("file", file.path.rawHex)} title="在提交页按此文件筛选"><GitPathText path={file.path} className="block" /></button>
        <span role="img" aria-label={`${file.days.filter(Boolean).length} 个时间段有改动`} className="flex h-3 w-24 gap-px">
          {file.days.slice(0, 48).map((day, index) => <span key={index} className={cn("h-3 min-w-px flex-1 rounded-[1px]", day ? "bg-bar" : "bg-sunken")} />)}
        </span>
        <span className="text-right text-xs text-fg3" title="涉及的作者数">{file.authors} 人</span>
        <CommitsPopover label={`${file.path.display} 的 ${file.commits} 个提交`} title={`${file.path.display} 的提交`}
          load={offset => commits({ kind: "file", pathHex: file.path.rawHex }, offset)} onSelect={actions.showCommit}>{formatCount(file.commits)} 次</CommitsPopover>
      </div>)}
    </div> : <p className="m-0 text-xs text-fg3">当前范围内没有被改动两次以上的文件。</p>}
    {truncationNote(stats.churnFilesTruncated, stats.churnFiles.length)}
  </StatsCard>;
}

function PairsCard({ stats, commits, actions }: { stats: NotableStats; actions: StatsActions; commits: NotableSectionProps["commits"] }): React.JSX.Element {
  return <StatsCard title="常一起改的文件" coverage={stats.coverage} hint="同一个提交里共同出现；只统计改动不超过 50 个文件的提交">
    {stats.pairs.length ? <div className="flex flex-col gap-1.5" data-testid="stats-pairs">
      {stats.pairs.map(pair => <div key={`${pair.a.rawHex}|${pair.b.rawHex}`} className="grid grid-cols-[minmax(0,1fr)_52px] items-center gap-2 text-[13px]">
        <div className="flex min-w-0 flex-col"><GitPathText path={pair.a} /><GitPathText path={pair.b} className="text-fg2" />
          <span className="text-xs text-fg3">{(pair.shareOfAPerMille / 10).toFixed(1)}% 的 A 提交同时改了 B</span></div>
        <CommitsPopover label={`${pair.a.display} 和 ${pair.b.display} 一起出现的 ${pair.together} 个提交`} title="一起改动的提交"
          load={offset => commits({ kind: "pair", aHex: pair.a.rawHex, bHex: pair.b.rawHex }, offset)} onSelect={actions.showCommit}>{formatCount(pair.together)} 次</CommitsPopover>
      </div>)}
    </div> : <p className="m-0 text-xs text-fg3">当前范围内没有共同改动两次以上的文件对。</p>}
    {stats.pairCommitsSkipped > 0 ? <p className="m-0 text-xs text-fg3" data-testid="stats-pairs-skipped">另有 {formatCount(stats.pairCommitsSkipped)} 个提交改动超过 50 个文件，没有参与文件对统计。</p> : null}
    {truncationNote(stats.pairsTruncated, stats.pairs.length)}
  </StatsCard>;
}

function SoloCard({ stats, actions, commits }: { stats: NotableStats; actions: StatsActions; commits: NotableSectionProps["commits"] }): React.JSX.Element {
  return <StatsCard title="单人维护的目录" coverage={stats.coverage} hint="周期内只有一位作者改过、行数大于零的顶层目录">
    {stats.soloDirectories.length ? <div className="flex flex-col gap-1" data-testid="stats-solo">
      {stats.soloDirectories.map(item => <div key={item.path.rawHex} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_64px_52px] items-center gap-2 text-[13px]">
        <button type="button" className="min-w-0 rounded px-1 text-left hover:bg-hover" onClick={() => actions.filterPath("directory", item.path.rawHex)} title="在提交页按此目录筛选"><GitPathText path={item.path} className="block" /></button>
        <button type="button" className="min-w-0 truncate rounded px-1 text-left text-fg2 hover:bg-hover" onClick={() => actions.filterAuthor(item.author)} title={`${item.author.name} <${item.author.email}>`}>{item.author.name || item.author.email}</button>
        <span className="text-right text-xs tabular-nums text-fg3">{formatCount(item.lines)} 行</span>
        <CommitsPopover label={`${item.path.display} 的 ${item.commits} 个提交`} title={`${item.path.display} 的提交`}
          load={offset => commits({ kind: "directory", pathHex: item.path.rawHex }, offset)} onSelect={actions.showCommit}>{formatCount(item.commits)} 次</CommitsPopover>
      </div>)}
    </div> : <p className="m-0 text-xs text-fg3">当前范围内没有符合条件的目录。</p>}
    {truncationNote(stats.soloDirectoriesTruncated, stats.soloDirectories.length)}
  </StatsCard>;
}

function UntestedCard({ stats, actions, commits }: { stats: NotableStats; actions: StatsActions; commits: NotableSectionProps["commits"] }): React.JSX.Element {
  const { untested } = stats;
  return <StatsCard title="代码与测试" coverage={stats.coverage} hint="改了代码但没改任何测试文件的提交（按路径约定识别）">
    {untested.total ? <>
      <div className="flex flex-wrap items-baseline gap-2 text-[13px]">
        <CommitsPopover label={`${untested.count} 个没改测试的提交`} title="改了代码但没改测试的提交"
          load={offset => commits({ kind: "untested" }, offset)} onSelect={actions.showCommit}><b className="text-2xl font-semibold tabular-nums text-fg">{formatCount(untested.count)}</b></CommitsPopover>
        <span className="text-fg2">/ {formatCount(untested.total)} 个改过代码的非 merge 提交 · {Math.round(untested.count / untested.total * 100)}%</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {untested.commits.map(commit => <button key={commit.oid} type="button" onClick={() => actions.showCommit(commit.oid)} title={commit.summary}
          className="grid grid-cols-[60px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-hover">
          <span className="font-mono text-xs text-fg3">{commit.oid.slice(0, 8)}</span>
          <span className="truncate">{commit.summary || "（无标题）"}</span>
          <span className="text-xs tabular-nums"><span className="text-chart-add">+{formatCount(commit.additions)}</span> <span className="text-chart-del">−{formatCount(commit.deletions)}</span></span>
        </button>)}
      </div>
      {untested.commitsTruncated ? <p className="m-0 text-xs text-fg3">示例只列出前 {untested.commits.length} 个；点上面的数字看完整列表。</p> : null}
    </> : <p className="m-0 text-xs text-fg3">当前范围内没有改过代码的非 merge 提交。</p>}
  </StatsCard>;
}
