import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import type { GitPath, SearchIdentity } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { SearchQuery, StatsBucket } from "../../../../../packages/protocol/src/generated/client-message.js";
import { bucketDisabledReason, bucketUnitLabel } from "../lib/stats-range.js";
import type { BucketChoice, RangePreset, UnixRange } from "../lib/stats-range.js";
import { StatsStore } from "../lib/stats-store.js";
import type { StatsApi, StatsCapabilities, StatsSection } from "../lib/stats-store.js";
import { cn } from "../lib/utils.js";
import { PlaceholderBox } from "./placeholder.js";
import { ActivitySection } from "./stats-activity.js";
import { ChangesSection } from "./stats-changes.js";
import { EvolutionSection } from "./stats-evolution.js";
import { NotableSection } from "./stats-notable.js";
import { Segmented } from "./stats-widgets.js";
import type { StatsActions } from "./stats-widgets.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

const SECTIONS: readonly { id: StatsSection; label: string }[] = [
  { id: "activity", label: "活动" }, { id: "changes", label: "改动" }, { id: "notable", label: "关注" }, { id: "evolution", label: "演化" },
];
const RANGES: readonly { id: RangePreset; label: string }[] = [
  { id: "1h", label: "1 小时" }, { id: "6h", label: "6 小时" }, { id: "today", label: "今天" }, { id: "7d", label: "7 天" },
  { id: "30d", label: "30 天" }, { id: "90d", label: "90 天" }, { id: "custom", label: "自定义…" },
];
const BUCKETS: readonly StatsBucket[] = ["tenMinutes", "hour", "day", "week", "month"];
const PLACEHOLDERS: Record<Exclude<StatsSection, "evolution">, { task: string; title: string }> = {
  activity: { task: "P6-01", title: "活动统计" }, changes: { task: "P6-03", title: "改动量统计" }, notable: { task: "P6-04", title: "值得注意的地方" },
};

function BucketMenu({ range, choice, resolved, onChange }: { range: UnixRange | null; choice: BucketChoice; resolved: StatsBucket | null; onChange(choice: BucketChoice): void }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const current = choice === "auto" ? `自动${resolved ? ` · ${bucketUnitLabel(resolved)}` : ""}` : bucketUnitLabel(choice);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><button type="button" aria-label={`粒度：${current}`} data-testid="stats-granularity"
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-line2 bg-panel px-2.5 text-[12.5px] text-fg hover:bg-hover aria-expanded:border-accent">
      <span className="text-fg3">粒度</span>{current}<ChevronDown className="size-3 text-fg3" aria-hidden="true" />
    </button></PopoverTrigger>
    <PopoverContent align="start" className="flex w-[220px] flex-col gap-px rounded-xl p-1.5" aria-label="粒度">
      {[{ id: "auto" as const, label: "自动", hint: "随范围选择" }, ...BUCKETS.map(id => ({ id, label: bucketUnitLabel(id), hint: undefined }))].map(item => {
        const reason = item.id === "auto" || !range ? null : bucketDisabledReason(item.id, range);
        return <button key={item.id} type="button" disabled={reason !== null} aria-pressed={choice === item.id} onClick={() => { onChange(item.id); setOpen(false); }}
          className={cn("flex h-8 items-center justify-between rounded-lg px-2.5 text-left text-[13px] hover:bg-hover disabled:text-fg3 disabled:opacity-60 disabled:hover:bg-transparent",
            choice === item.id && "bg-accent-soft font-medium text-accent-fg hover:bg-accent-soft")}>
          <span>{item.label}</span>
          {reason ? <span className="text-xs text-fg3">{reason === "tooShort" ? "范围太短" : "范围太长"}</span> : choice === item.id ? <Check className="size-3.5" aria-hidden="true" />
            : item.hint ? <span className="text-xs text-fg3">{item.hint}</span> : null}
        </button>;
      })}
    </PopoverContent>
  </Popover>;
}

function Divider(): React.JSX.Element {
  return <div aria-hidden="true" className="h-5 w-px shrink-0 bg-line" />;
}

export interface StatsPageProps {
  api: StatsApi;
  /** Repository, generation and browsing scope; a change drops every result. */
  sessionKey: string | null;
  /** The commits page's search query; the statistics honour it. */
  query: SearchQuery;
  capabilities: StatsCapabilities;
  /** The page is shown and the window is visible. */
  active: boolean;
  /** Changes while the metadata index progresses. */
  indexKey: string;
  /** The tree the evolution analysis reads: the head of the browsing scope. */
  evolutionVersion: { commit: string; label: string } | null;
  allBranches: boolean;
  onQueryChange(query: SearchQuery): void;
  onAuthor(identity: SearchIdentity): void;
  /** Called after a click changed the filters, to move to the commits page. */
  onShowCommits(): void;
  /** Selects a commit on the commits page. */
  onShowCommit(oid: string): void;
}

const TIME_FIELDS = { author: "Author 时间", committer: "Committer 时间" } as const;

export function StatsPage({ api, sessionKey, query, capabilities, active, indexKey, evolutionVersion, allBranches, onQueryChange, onAuthor, onShowCommits, onShowCommit }: StatsPageProps): React.JSX.Element {
  const store = React.useMemo(() => new StatsStore(api), [api]);
  const view = React.useSyncExternalStore(store.subscribe, store.getView);
  React.useEffect(() => () => store.dispose(), [store]);
  const commit = evolutionVersion?.commit ?? null;
  const [windowVisible, setWindowVisible] = React.useState(() => document.visibilityState === "visible");
  React.useEffect(() => {
    const onChange = () => setWindowVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  const { activity, changes, notable, evolution } = capabilities;
  const running = active && windowVisible;
  React.useEffect(() => {
    store.bind({ sessionKey, query, capabilities: { activity, changes, notable, evolution }, active: running, indexKey, evolutionCommit: allBranches ? null : commit });
  }, [store, sessionKey, query, activity, changes, notable, evolution, running, indexKey, allBranches, commit]);

  const actions = React.useMemo<StatsActions>(() => ({
    filterTime(fromUnix, toUnix) {
      onQueryChange({ ...query, fromTimestamp: fromUnix, toTimestamp: toUnix });
      onShowCommits();
    },
    filterAuthor(identity) {
      onAuthor({ name: identity.name, email: identity.email });
      onShowCommits();
    },
    filterPath(kind, rawHex) {
      onQueryChange({ ...query, path: { kind, rawHex, includeDescendants: kind === "directory" } });
      onShowCommits();
    },
    showCommit: onShowCommit,
    openEvolution(path: GitPath) {
      store.setSection("evolution");
      store.setEvolutionPath(path.display, path.rawHex);
    },
  }), [onAuthor, onQueryChange, onShowCommit, onShowCommits, query, store]);

  const section = view.section;
  const slot = section === "evolution" ? null : view[section];
  const coverage = slot?.value?.coverage;
  const coverageText = section === "evolution" ? "按需分析" : coverage
    ? coverage.complete ? `索引已覆盖 ${coverage.processed.toLocaleString("en-US")} 个提交` : `部分：已处理 ${coverage.processed.toLocaleString("en-US")} 个提交`
    : slot?.loading ? "正在统计…" : "尚无统计结果";
  const commitsLoader = React.useCallback((source: "changes" | "notable") => (selection: Parameters<StatsStore["commitsPage"]>[1], offset: number) => store.commitsPage(source, selection, offset), [store]);
  const changesCommits = React.useMemo(() => commitsLoader("changes"), [commitsLoader]);
  const notableCommits = React.useMemo(() => commitsLoader("notable"), [commitsLoader]);

  return <div data-testid="stats-page" className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-6 py-2">
      <Segmented<StatsSection> label="统计分区" value={section} options={SECTIONS} onChange={next => store.setSection(next)} />
      <Divider />
      {section === "evolution" ? <span className="text-xs text-fg3">选一个目录或文件，估算后再开始分析</span> : <>
        <Segmented<RangePreset> label="时间范围" value={view.preset} options={RANGES} onChange={next => store.setPreset(next)} />
        {view.preset === "custom" ? <span className="flex items-center gap-1.5 text-xs text-fg3">
          <input type="date" aria-label="开始日期" value={view.custom.from} max={view.custom.to || undefined} onChange={event => store.setCustom({ ...view.custom, from: event.target.value })}
            className="h-7 rounded-lg border border-line2 bg-panel px-2 text-[12.5px] text-fg" />
          至
          <input type="date" aria-label="结束日期（含当天）" value={view.custom.to} min={view.custom.from || undefined} onChange={event => store.setCustom({ ...view.custom, to: event.target.value })}
            className="h-7 rounded-lg border border-line2 bg-panel px-2 text-[12.5px] text-fg" />
        </span> : null}
        <BucketMenu range={view.range} choice={view.bucketChoice} resolved={view.bucket} onChange={next => store.setBucket(next)} />
        <span className="flex h-7 items-center rounded-lg border border-line2 bg-panel px-2.5 text-[12.5px] text-fg2" title="时间字段随提交页的筛选">{TIME_FIELDS[query.timeField]}</span>
        {view.range === null ? <span role="alert" className="text-xs text-bad">日期范围无效：开始日期不能晚于结束日期，最长 3660 天。</span> : null}
      </>}
      <span className="min-w-0 flex-1" />
      <span data-testid="stats-coverage" className="text-xs text-fg3">范围随提交页 · {coverageText}</span>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="flex min-w-0 flex-col gap-4">
        {section !== "evolution" && !capabilities[section]
          ? <PlaceholderBox task={PLACEHOLDERS[section].task} title={PLACEHOLDERS[section].title} note="当前核心还没有这项统计的能力，这里不显示示例数据。" />
          : section === "activity" ? <ActivitySection slot={view.activity} onRetry={() => store.retry()} actions={actions} />
            : section === "changes" ? <ChangesSection slot={view.changes} prefix={view.prefix} exclusions={view.exclusions} onRetry={() => store.retry()} onPrefix={crumbs => store.setPrefix(crumbs)}
              onLoadExclusions={() => { void store.loadExclusions(); }} onSaveExclusions={patterns => store.saveExclusions(patterns)} actions={actions} commits={changesCommits} />
              : section === "notable" ? <NotableSection slot={view.notable} onRetry={() => store.retry()} actions={actions} commits={notableCommits} />
                : !capabilities.evolution ? <PlaceholderBox task="P6-05" title="演化分析" note="当前核心还不支持按需演化分析，这里不显示示例数据。" />
                  : <EvolutionSection state={view.evolution} version={evolutionVersion} allBranches={allBranches} onPath={text => store.setEvolutionPath(text)} onRange={choice => store.setEvolutionRange(choice)}
                    onEstimate={() => { void store.estimateEvolution(); }} onAnalyze={() => { void store.analyzeEvolution(); }} onCancel={() => { void store.cancelEvolution(); }} />}
      </div>
    </div>
  </div>;
}
