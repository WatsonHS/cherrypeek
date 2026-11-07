import * as React from "react";
import { ChevronDown, Cloud, ExternalLink, Folder, GitBranch, Keyboard, LoaderCircle, RefreshCw, Tag } from "lucide-react";
import type { RepositoryScope, RefInfo, RepositoryInfo, RepositorySessionInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositoryNavigation } from "../../../../../packages/protocol/src/repository-session.js";
import type { SearchView } from "../lib/metadata-search-store.js";
import type { SearchQuery } from "../../../../../packages/protocol/src/generated/client-message.js";
import type { SearchTimeField } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositoryView, ViewRecord } from "../lib/repository-session-store.js";
import type { RepositoryActions } from "../app.js";
import { momentLabel, repositoryName, shortOid, shortRefName } from "../lib/format.js";
import { cn } from "../lib/utils.js";
import { PathField } from "./path-field.js";
import { UpdatesPopover } from "./updates-popover.js";
import { ActivityStatsPopover } from "./activity-stats.js";
import type { HandoffTarget } from "./handoff-dialog.js";
import type { ActivityStats, RefSnapshotDiff, RepositoryObservation, SearchIdentity } from "../../../../../packages/protocol/src/generated/server-message.js";
import { SearchControls } from "./search-controls.js";
import { RecentList, storeStatusText, type RecentState } from "./recent-repositories.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

export function TopBar({ preview, actions, recent, onRefreshRecent, onSelectCommit, onLoadNavigation, onLoadMergeStatus, onCancelMergeStatus,
  searchView, activityQuery, onSearchQueryChange, onSearchComposition, onLoadSearchIdentities, onLoadSearchPaths, observation, refDiff, refDiffLoading, refDiffError,
  onLoadRefDiff, onCancelRefDiff, onObserve, onOpenHandoff, activityStats, activityLoading, activityError, onLoadActivity, onActivityAuthor }: {
  preview: RepositoryView;
  actions: RepositoryActions;
  recent: RecentState;
  onRefreshRecent(): void;
  onSelectCommit(oid: string): void;
  onLoadNavigation(): void;
  onLoadMergeStatus(names: string[]): void;
  onCancelMergeStatus(): Promise<void>;
  onRefresh(): Promise<void>;
  searchView: SearchView;
  activityQuery: SearchQuery;
  onSearchQueryChange(query: SearchQuery, composing?: boolean): void;
  onSearchComposition(composing: boolean): void;
  onLoadSearchIdentities(field: SearchTimeField, text: string): void;
  onLoadSearchPaths(text: string): void;
  observation: RepositoryObservation | null;
  refDiff: RefSnapshotDiff | null;
  refDiffLoading: boolean;
  refDiffError: string | null;
  onLoadRefDiff(): void;
  onCancelRefDiff(): void;
  onObserve(): void;
  onOpenHandoff(target: HandoffTarget | null): void;
  activityStats: ActivityStats | null;
  activityLoading: boolean;
  activityError: string | null;
  onLoadActivity(): void;
  onActivityAuthor(identity: SearchIdentity): void;
}): React.JSX.Element | null {
  const [scopeOpen, setScopeOpen] = React.useState(false);
  const repository = preview.repository;
  if (!repository) return null;
  const busy = preview.state === "loading" || preview.opening !== null || preview.scopeSwitching || preview.refreshing;
  return <header className="window-toolbar flex h-[52px] min-h-[52px] max-h-[52px] flex-nowrap items-center gap-1 overflow-hidden border-b border-line py-2">
    <RepositorySwitcher repository={repository} session={preview.session} record={preview.record} actions={actions}
      recent={recent} onRefreshRecent={onRefreshRecent} loading={busy} />
    <span aria-hidden="true" className="topbar-divider shrink-0 text-line2">/</span>
    <ScopePicker preview={preview} open={scopeOpen} onOpenChange={setScopeOpen} onChange={scope => actions.switchScope(scope)} onLoadNavigation={onLoadNavigation}
      onOpenHandoff={onOpenHandoff}
      onLoadMergeStatus={onLoadMergeStatus} onCancelMergeStatus={onCancelMergeStatus} onRefresh={actions.refresh} disabled={busy} />
    <WorktreeChip repository={repository} session={preview.session} navigation={preview.navigation} navigationLoading={preview.navigationLoading}
      navigationError={preview.navigationError?.message ?? null} onLoadNavigation={onLoadNavigation} disabled={busy} />
    {repository.isShallow ? <Badge variant="warn">浅克隆</Badge> : null}
    <div className="min-w-0 flex-1 basis-0" />
    <ActivityStatsPopover query={activityQuery} stats={activityStats} loading={activityLoading} error={activityError}
      onLoad={onLoadActivity} onQueryChange={onSearchQueryChange} onAddAuthor={onActivityAuthor} />
    <SearchControls view={searchView} sessionKey={preview.session ? `${preview.session.repoId}:${preview.session.generation}` : "offline"}
      onQueryChange={onSearchQueryChange} onComposition={onSearchComposition} onLoadIdentities={onLoadSearchIdentities} onLoadPaths={onLoadSearchPaths} />
    <ShortcutGuide />
    <UpdatesPopover observation={observation} diff={refDiff} loading={refDiffLoading} error={refDiffError} onLoad={onLoadRefDiff} onObserve={onObserve}
      onCancel={onCancelRefDiff} onRefresh={() => { void actions.refresh(); }} />
    <Button variant="soft" size="sm" className="topbar-handoff shrink-0" data-testid="handoff-prompt" title="交给 Agent" aria-label="交给 Agent"
      onClick={() => onOpenHandoff(null)}><ExternalLink className="size-3.5" /><span className="topbar-action-label">交给 Agent</span></Button>
    {preview.session ? <Button variant="outline" size="sm" disabled={preview.refreshing || busy}
      className="topbar-refresh shrink-0" onClick={() => { void actions.refresh(); }} title="刷新仓库历史" aria-label="刷新仓库历史">
      <RefreshCw className={cn("size-3.5", preview.refreshing && "animate-spin motion-reduce:animate-none")} strokeWidth={1.75} />
      <span className="topbar-action-label">{preview.refreshing ? "刷新中…" : "刷新"}</span>
    </Button> : null}
    {busy ? <div className="topbar-busy flex min-w-0 shrink-0 items-center gap-1 text-[13px] text-fg2">
      <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" strokeWidth={1.75} aria-hidden="true" />
      <span className="topbar-busy-copy max-w-[120px] truncate" title={preview.opening ?? undefined}>{preview.opening !== null ? `正在打开 ${repositoryName(preview.opening)}…` : preview.scopeSwitching ? "正在切换范围…" : preview.refreshing ? "正在刷新历史…" : "正在读取…"}</span>
      <Button variant="outline" size="sm" className="topbar-cancel-button" title="取消当前查询并关闭仓库，回到打开页" aria-label="取消并关闭仓库" onClick={() => { void actions.cancel(); }}>
        <span className="topbar-cancel-label">取消</span>
      </Button>
    </div> : null}
  </header>;
}

function ShortcutGuide(): React.JSX.Element {
  const modifier = /Mac|iPhone|iPad/u.test(navigator.platform) ? "⌘" : "Ctrl+";
  const refreshKey = modifier === "⌘" ? "⌥⌘R" : "Ctrl+Alt+R";
  return <Popover>
    <PopoverTrigger asChild><Button variant="ghost" size="icon" aria-label="快捷键说明" data-testid="shortcut-guide-trigger"><Keyboard className="size-4" strokeWidth={1.75} /></Button></PopoverTrigger>
    <PopoverContent align="end" className="w-[300px] p-3" data-testid="shortcut-guide">
      <h2 className="m-0 mb-2 text-[13px] font-semibold">快捷键</h2>
      <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-xs">
        <dt className="text-fg2">聚焦搜索</dt><dd className="m-0 font-mono text-fg3">{modifier}F</dd>
        <dt className="text-fg2">从搜索结果在历史中定位</dt><dd className="m-0 font-mono text-fg3">{modifier}]</dd>
        <dt className="text-fg2">返回搜索结果</dt><dd className="m-0 font-mono text-fg3">{modifier}[</dd>
        <dt className="text-fg2">切换详情：概览 / 文件</dt><dd className="m-0 font-mono text-fg3">{modifier}1 / 2</dd>
        <dt className="text-fg2">刷新仓库历史</dt><dd className="m-0 font-mono text-fg3">{refreshKey}</dd>
        <dt className="text-fg2">切换浏览范围</dt><dd className="m-0 text-fg3">顶部范围选择器</dd>
        <dt className="text-fg2">历史列表中上下选择提交</dt><dd className="m-0 font-mono text-fg3">↑ / ↓</dd>
      </dl>
    </PopoverContent>
  </Popover>;
}

function RepositorySwitcher({ repository, session, record, actions, recent, onRefreshRecent, loading }: {
  repository: RepositoryInfo;
  session: RepositorySessionInfo | null;
  record: ViewRecord | null;
  actions: RepositoryActions;
  recent: RecentState;
  onRefreshRecent(): void;
  loading: boolean;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const name = repositoryName(repository.worktreePath ?? repository.path);
  const openPath = (path: string) => { setOpen(false); void actions.open(path); };
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (next) onRefreshRecent(); }}>
    <PopoverTrigger asChild>
      <Button variant="ghost" className="topbar-repository h-8 min-w-0 max-w-[220px] shrink px-2.5 font-semibold text-fg" aria-label={`切换仓库：${name}`} title={repository.path} disabled={loading}>
        <span className="min-w-0 max-w-[220px] truncate">{name}</span>
        <ChevronDown className="size-3.5 text-fg3" strokeWidth={1.75} />
      </Button>
    </PopoverTrigger>
    <PopoverContent className="flex max-h-(--radix-popover-content-available-height) w-[460px] flex-col gap-3.5 overflow-auto p-4">
      <div className="flex flex-col gap-1">
        <span className="text-[11.5px] font-semibold text-fg3">当前仓库</span>
        <code className="font-mono text-xs break-all text-fg2">{repository.path}</code>
        <span className="text-xs text-fg3">对象格式 {repository.objectFormat}{repository.isBare ? " · bare 仓库" : ""}{repository.isShallow ? " · 浅克隆" : ""}</span>
        {session ? <SessionFacts session={session} record={record} /> : <span className="text-xs text-warn">核心已断开，这里显示的是之前读取的内容。</span>}
      </div>
    <RecentList recent={recent} currentWorktreeId={session?.worktreeId ?? null} disabled={loading} onOpen={openPath} />
      <div className="flex flex-col gap-2">
        <span className="text-[11.5px] font-semibold text-fg3">打开其他仓库</span>
        <PathField actions={actions} disabled={loading} onOpened={() => setOpen(false)} />
        <Button variant="soft" className="self-start" disabled={loading} onClick={() => { setOpen(false); void actions.choose(); }}>选择目录…</Button>
      </div>
    </PopoverContent>
  </Popover>;
}

/** Facts from the session: when HEAD was read and what the previous visit saw. */
function SessionFacts({ session, record }: { session: RepositorySessionInfo; record: ViewRecord | null }): React.JSX.Element {
  const previous = session.previousView;
  const previousTips = previous?.tips ?? [];
  const sameScopeTips = previousTips.length === session.tips.length && previousTips.every(tip => session.tips.includes(tip));
  let visit: string;
  if (!previous) visit = session.persistence.lastSeen === "ok" ? "第一次在这个 worktree 查看此浏览范围，还没有查看记录。" : "没有可用的查看记录。";
  else if (previousTips.length === 0) visit = `上次查看 ${momentLabel(previous.viewedAtUnixMs)} · 当时这个范围没有可达 tip${sameScopeTips ? "，与当前范围相同" : "，与当前范围不同"}`;
  else {
    const examples = previousTips.slice(0, 2).map(shortOid).join("、");
    const more = previousTips.length > 2 ? ` 等 ${previousTips.length} 个` : previousTips.length === 2 ? "（共 2 个）" : "";
    visit = `上次查看 ${momentLabel(previous.viewedAtUnixMs)} · 当时此范围的 tip：${examples}${more}${sameScopeTips ? "，与当前范围相同" : "，与当前范围不同"}`;
  }
  const notes = [
    storeStatusText(session.persistence.lastSeen) ? `查看记录${storeStatusText(session.persistence.lastSeen)}` : null,
    record && !record.saved ? `这次查看没有保存${record.error ? `：${record.error.message}` : record.status ? `（${storeStatusText(record.status) ?? record.status}）` : ""}` : null,
  ].filter((note): note is string => Boolean(note));
  return <>
    <span className="text-xs text-fg3">本窗口 HEAD 读取于 {momentLabel(session.observedAtUnixMs)}；手动刷新可读取新提交</span>
    <span className="text-xs text-fg3" data-testid="previous-view">{visit}</span>
    {notes.map(note => <span key={note} className="text-xs text-warn">{note}</span>)}
  </>;
}

const GROUPS: { kind: RefInfo["kind"]; title: string; Icon: typeof GitBranch }[] = [
  { kind: "localBranch", title: "本地分支", Icon: GitBranch },
  { kind: "remoteBranch", title: "远端跟踪", Icon: Cloud },
  { kind: "tag", title: "标签", Icon: Tag },
];

function scopeLabel(scope: RepositoryScope, repository: RepositoryInfo, navigation: RepositoryNavigation | null): string {
  if (scope === "head") return repository.headReference ? `HEAD · ${shortRefName(repository.headReference)}`
    : repository.headOid ? `Detached HEAD · ${shortOid(repository.headOid)}` : "HEAD · 空仓库";
  if (scope === "allBranches") return "全部分支";
  if ("ref" in scope) return shortRefName(scope.ref);
  const worktree = navigation?.worktrees.find(item => item.id === scope.worktree);
  return worktree ? `worktree · ${repositoryName(worktree.path)}` : "worktree";
}

function sameScope(left: RepositoryScope | undefined, right: RepositoryScope): boolean {
  if (!left) return false;
  if (typeof left === "string" || typeof right === "string") return left === right;
  if ("ref" in left && "ref" in right) return left.ref === right.ref;
  if ("worktree" in left && "worktree" in right) return left.worktree === right.worktree;
  return false;
}

function ScopePicker({ preview, open, onOpenChange, onChange, onLoadNavigation, onOpenHandoff, onLoadMergeStatus, onCancelMergeStatus, onRefresh, disabled }: {
  preview: RepositoryView;
  open: boolean;
  onOpenChange(open: boolean): void;
  onChange(scope: RepositoryScope): void;
  onLoadNavigation(): void;
  onOpenHandoff(target: HandoffTarget | null): void;
  onLoadMergeStatus(names: string[]): void;
  onCancelMergeStatus(): Promise<void>;
  onRefresh(): Promise<void>;
  disabled: boolean;
}): React.JSX.Element {
  const optionsRef = React.useRef<HTMLDivElement>(null);
  const repository = preview.repository!;
  const navigation = preview.navigation;
  const scope = preview.session?.scope;
  const label = scopeLabel(scope ?? "head", repository, navigation);
  const visibleBranches = React.useCallback((force = false) => {
    if (!open || !navigation?.defaultBase || preview.mergeStatusLoading || (!force && preview.mergeStatusError) || !optionsRef.current) return;
    const box = optionsRef.current.getBoundingClientRect();
    const names = [...optionsRef.current.querySelectorAll<HTMLElement>("[data-scope-ref-kind='localBranch'][data-ref-name]")]
      .filter(element => { const row = element.getBoundingClientRect(); return row.bottom > box.top && row.top < box.bottom; })
      .map(element => element.dataset.refName!).filter(name => preview.mergeStatuses[name] === undefined).slice(0, 50);
    if (names.length) onLoadMergeStatus(names);
  }, [open, navigation, preview.mergeStatusLoading, preview.mergeStatusError, preview.mergeStatuses, onLoadMergeStatus]);
  React.useEffect(() => {
    if (!open || !navigation?.defaultBase || !optionsRef.current) return;
    const root = optionsRef.current;
    if (typeof IntersectionObserver === "undefined") {
      visibleBranches();
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) visibleBranches();
    }, { root, threshold: 0.01 });
    root.querySelectorAll("[data-scope-ref-kind='localBranch'][data-ref-name]").forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [open, navigation, preview.mergeStatuses, preview.mergeStatusLoading, visibleBranches]);
  const choose = (next: RepositoryScope) => { onOpenChange(false); onChange(next); };
  const option = (id: string, next: RepositoryScope, text: React.ReactNode, selected: boolean, disabled = false) =>
    <button key={id} type="button" data-testid={`scope-option-${id}`} aria-current={selected ? "true" : undefined} disabled={disabled}
      className={cn("flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] hover:bg-hover disabled:opacity-50", selected && "bg-hover")}
      onClick={() => choose(next)}>{text}{selected ? <Badge variant="head" size="sm">正在浏览</Badge> : null}</button>;
  return <Popover open={open} onOpenChange={next => {
    onOpenChange(next);
    if (next) onLoadNavigation();
    else void onCancelMergeStatus();
  }}>
    <PopoverTrigger asChild>
      <Button variant="ghost" className="topbar-scope-picker h-8 min-w-0 max-w-[190px] shrink px-2 text-fg2" aria-label={`浏览范围：${label}`} title={label} data-testid="scope-picker" disabled={disabled}>
        <GitBranch className="size-3.5" strokeWidth={1.75} />
        <span className="topbar-scope-label min-w-0 max-w-[240px] truncate">{label}</span>
        <ChevronDown className="size-3.5 text-fg3" strokeWidth={1.75} />
      </Button>
    </PopoverTrigger>
    <PopoverContent className="flex max-h-(--radix-popover-content-available-height) w-[440px] flex-col p-0" data-testid="scope-popover">
      <div className="flex flex-col gap-1 border-b border-line px-4 py-3">
        <span className="font-semibold">浏览范围</span>
        <span className="text-xs text-fg3">只切换只读历史范围；不会切换或修改任何 worktree。</span>
      </div>
      <div ref={optionsRef} className="min-h-0 overflow-auto p-2" data-testid="scope-options" onScroll={() => visibleBranches()}>
        {option("head", "head", <>HEAD 可达历史{repository.headReference ? <code className="ml-auto font-mono text-xs text-fg3">{shortRefName(repository.headReference)}</code> : repository.headOid ? <code className="ml-auto font-mono text-xs text-fg3">{shortOid(repository.headOid)}</code> : <span className="ml-auto text-xs text-fg3">空仓库</span>}</>, sameScope(scope, "head"))}
        {option("allBranches", "allBranches", <>全部分支<span className="ml-auto text-xs text-fg3">本地与远端可达</span></>, sameScope(scope, "allBranches"), !navigation || Boolean(navigation.refsTruncated))}
        <div className="flex flex-col gap-px py-1">
          <div className="flex justify-between px-2.5 pt-1.5 pb-1 text-[11.5px] font-semibold text-fg3"><span>Worktree</span><span className="font-normal">{navigation ? navigation.worktrees.length : preview.navigationLoading ? "读取中…" : ""}</span></div>
          {(navigation?.worktrees ?? []).map(item => <div key={`worktree-row-${item.id}`} className="flex items-center gap-1">
            <div className="min-w-0 flex-1">{option(`worktree-${item.id}`, { worktree: item.id }, <>
            <Folder className="size-3.5 shrink-0 text-fg3" aria-hidden="true" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{repositoryName(item.path)} · {item.isMain ? "主" : "linked"}{item.isCurrent ? " · 本窗口" : ""}</span>
              <span className="truncate font-mono text-[10.5px] text-fg3" title={item.path}>{item.path}</span>
              <span className="text-[11px] text-fg3">{item.isDetached ? "detached HEAD" : item.headReference ? shortRefName(item.headReference) : item.headOid ? shortOid(item.headOid) : "unborn HEAD"}{item.lockedReason !== null ? ` · 已锁定${item.lockedReason ? `：${item.lockedReason}` : ""}` : ""}{item.prunableReason !== null ? ` · 可清理${item.prunableReason ? `：${item.prunableReason}` : ""}` : ""}{!item.available ? " · 不可用" : ""}</span>
            </span>
            </>, sameScope(scope, { worktree: item.id }), !item.available)}</div>
            {!item.available || item.lockedReason !== null || item.prunableReason !== null
              ? <Button variant="ghost" size="icon-sm" aria-label={`为失效 worktree ${repositoryName(item.path)} 准备交接`} title="检查失效 worktree"
                onClick={() => { onOpenChange(false); onOpenHandoff({ kind: "worktree", id: item.id, stale: true }); }}><ExternalLink className="size-3.5" /></Button> : null}
          </div>)}
        </div>
        {GROUPS.map(({ kind, title, Icon }) => {
          const refs = navigation?.refs.filter(ref => ref.kind === kind) ?? [];
          if (!refs.length) return null;
          return <div key={kind} className="flex flex-col gap-px py-1">
            <div className="flex justify-between px-2.5 pt-1.5 pb-1 text-[11.5px] font-semibold text-fg3"><span>{title}{kind === "localBranch" ? navigation?.defaultBase ? ` · 基准 ${shortRefName(navigation.defaultBase.name)}` : " · 无可用默认基准" : ""}</span><span className="font-normal">{refs.length}</span></div>
            {kind === "remoteBranch" ? <p className="m-0 px-2.5 pb-1 text-[10.5px] text-fg3" data-testid="remote-ref-disclaimer">本地引用快照 · fetch 时间未知 · 未 fetch</p> : null}
            {refs.map(ref => {
              const isHead = ref.name === repository.headReference;
              const merged = navigation?.defaultBase ? preview.mergeStatuses[ref.name] : undefined;
              const checkedOut = kind === "localBranch" ? (navigation?.worktrees ?? []).filter(worktree => worktree.headReference === ref.name) : [];
              const checkoutLabel = checkedOut.length
                ? `检出于 ${checkedOut.map(worktree => repositoryName(worktree.path)).join("、")}`
                : "未检出";
              const checkoutTitle = checkedOut.length
                ? `检出于：${checkedOut.map(worktree => worktree.path).join("、")}`
                : "未被 worktree 检出";
              return <div key={ref.name} data-scope-ref-kind={kind} data-ref-name={kind === "localBranch" ? ref.name : undefined} className="flex items-center gap-1">
                <div className="min-w-0 flex-1">{option(`ref-${ref.name}`, { ref: ref.name }, <>
                <Icon className="size-3.5 shrink-0 text-fg3" strokeWidth={1.75} aria-hidden="true" />
                <span className="flex min-w-[96px] flex-1 flex-col">
                  <span className="truncate" title={ref.name}>{shortRefName(ref.name)}</span>
                  {kind === "localBranch" ? <span className="truncate text-[10.5px] text-fg3" title={checkoutTitle}>{checkoutLabel}</span> : null}
                </span>
                {isHead ? <Badge variant="head" size="sm">本窗口 HEAD</Badge> : null}
                {merged === "merged" ? <Badge size="sm">已合入</Badge> : null}
                {merged === "unavailable" ? <span className="text-[11px] text-fg3">状态不可用</span> : null}
                <code className="shrink-0 font-mono text-xs text-fg3">{shortOid(ref.peeledOid ?? ref.oid)}</code>
                </>, sameScope(scope, { ref: ref.name }))}</div>
                <Button variant="ghost" size="icon-sm" aria-label={`为分支 ${shortRefName(ref.name)} 准备交接`} title="交给 Agent"
                  onClick={() => { onOpenChange(false); onOpenHandoff({ kind: "branch", ref: ref.name }); }}><ExternalLink className="size-3.5" /></Button>
                {merged === "unavailable" ? <button type="button" aria-label={`重新计算 ${shortRefName(ref.name)} 的合入状态`}
                  className="ml-2 self-start px-2 text-[11px] text-fg3 underline" onClick={() => onLoadMergeStatus([ref.name])}>重试</button> : null}
              </div>;
            })}
          </div>;
        })}
        {navigation?.refsTruncated || navigation?.worktreesTruncated ? <p role="status" className="m-0 px-2.5 py-2 text-xs text-warn">导航清单已达到上限，选择器不完整；全部分支暂不可用。</p> : null}
        {preview.navigationLoading ? <p role="status" className="m-0 px-2.5 py-2 text-xs text-fg3">正在读取导航清单…</p> : null}
        {preview.navigationError ? <div role="alert" data-testid="navigation-error" className="px-2.5 py-2 text-xs text-bad">{preview.navigationError.message}<button data-testid="navigation-retry" className="ml-2 underline" onClick={() => { void onRefresh().then(onLoadNavigation); }}>刷新仓库后重试</button></div> : null}
        {preview.mergeStatusError ? <div role="alert" className="px-2.5 py-2 text-xs text-bad">合入状态读取失败：{preview.mergeStatusError.message}<button className="ml-2 underline" onClick={() => visibleBranches(true)}>重试当前可见分支</button></div> : null}
        {preview.mergeStatusLoading ? <p role="status" className="m-0 px-2.5 py-1 text-[11px] text-fg3">正在计算可见分支的合入状态…</p> : null}
        {preview.scopeSwitching ? <p role="status" data-testid="scope-switch-status" className="m-0 px-2.5 py-2 text-xs text-fg3">正在准备新范围的历史…</p> : null}
        {navigation && navigation.refs.length === 0 && navigation.worktrees.length === 0 ? <p className="m-0 px-2.5 py-3 text-[13px] text-fg3">没有可选引用或 worktree。</p> : null}
      </div>
      {navigation ? <div className="border-t border-line px-4 py-2 text-[11px] text-fg3">本地引用快照 {momentLabel(navigation.observedAtUnixMs)} · 未 fetch</div> : null}
      {preview.refsTruncated ? <div className="border-t border-line bg-bg px-4 py-2.5 text-xs text-fg3">引用数量达到显示上限，列表不完整。</div> : null}
    </PopoverContent>
  </Popover>;
}

function WorktreeChip({ repository, session, navigation, navigationLoading, navigationError, onLoadNavigation, disabled }: {
  repository: RepositoryInfo;
  session: RepositorySessionInfo | null;
  navigation: RepositoryNavigation | null;
  navigationLoading: boolean;
  navigationError: string | null;
  onLoadNavigation(): void;
  disabled: boolean;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const path = repository.worktreePath ?? repository.path;
  const linked = repository.worktreePath !== null
    && repository.gitDir.replace(/[\\/]+$/, "") !== repository.commonDir.replace(/[\\/]+$/, "");
  const worktreeName = repository.isBare ? "bare 仓库" : repositoryName(path);
  const headDescription = repository.headReference
    ? `分支 ${repository.headReference}`
    : repository.headOid ? "detached HEAD" : "空仓库（尚无 HEAD 提交）";
  const worktreeCount = navigation
    ? `${navigation.worktreesTruncated ? "至少 " : ""}${navigation.worktrees.length} 个 worktree`
    : navigationLoading ? "正在读取 worktree 清单…" : navigationError ? "worktree 清单读取失败" : "尚未读取 worktree 清单";

  return <Popover open={open} onOpenChange={next => {
    setOpen(next);
    if (next && !navigation && !navigationLoading && !navigationError) onLoadNavigation();
  }}>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" className="topbar-worktree max-w-[280px] min-w-0 shrink justify-start border border-line text-xs text-fg2"
        disabled={disabled} data-testid="worktree-info-trigger" aria-label={`工作区信息：${worktreeName}`} title={`${path} · ${worktreeCount}`}>
        <Folder className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        <span className="min-w-0 truncate">工作区 · {worktreeName}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-[360px] max-w-[calc(100vw-24px)] p-3" data-testid="worktree-info">
      <h2 className="m-0 text-[13px] font-semibold">当前工作区</h2>
      <p className="mb-3 mt-1 text-xs text-fg3">这里显示当前窗口对应的目录事实；它与左侧浏览范围独立，切换浏览范围不会 checkout 或改变工作区。</p>
      <dl className="m-0 grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        <dt className="text-fg3">目录</dt><dd className="m-0 break-all font-mono" title={path}>{path}</dd>
        <dt className="text-fg3">类型</dt><dd className="m-0">{repository.isBare ? "bare 仓库（没有工作区目录）" : linked ? "关联 worktree" : "主 worktree"}</dd>
        <dt className="text-fg3">实际 HEAD</dt><dd className="m-0 break-all">{repository.isBare ? "bare 仓库没有工作区 HEAD" : headDescription}</dd>
        <dt className="text-fg3">HEAD 完整 OID</dt><dd className="m-0 break-all font-mono">{repository.headOid ?? "无提交"}</dd>
        <dt className="text-fg3">快照时间</dt><dd className="m-0">{session ? momentLabel(session.observedAtUnixMs) : "未知"}</dd>
        <dt className="text-fg3">关联 worktree</dt><dd className="m-0">{worktreeCount}</dd>
      </dl>
      {navigationLoading ? <p role="status" className="mb-0 mt-3 text-xs text-fg3">正在读取导航快照…</p> : null}
      {navigationError ? <div role="alert" className="mt-3 text-xs text-bad">{navigationError}<button type="button" className="ml-2 underline" onClick={onLoadNavigation}>重试</button></div> : null}
      {navigation?.worktreesTruncated ? <p role="status" className="mb-0 mt-2 text-xs text-warn">worktree 清单已达到显示上限，数量为下限。</p> : null}
    </PopoverContent>
  </Popover>;
}
