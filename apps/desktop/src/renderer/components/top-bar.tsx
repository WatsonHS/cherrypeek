import * as React from "react";
import { ChevronDown, Cloud, Folder, GitBranch, LoaderCircle, RefreshCw, Tag } from "lucide-react";
import type { RepositoryScope, RefInfo, RepositoryInfo, RepositorySessionInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositoryNavigation } from "../../../../../packages/protocol/src/repository-session.js";
import type { RepositoryView, ViewRecord } from "../lib/repository-session-store.js";
import type { RepositoryActions } from "../app.js";
import { momentLabel, repositoryName, shortOid, shortRefName } from "../lib/format.js";
import { cn } from "../lib/utils.js";
import { PathField } from "./path-field.js";
import { SearchPlaceholder, UpdatesPlaceholder } from "./placeholder-widgets.js";
import { RecentList, storeStatusText, type RecentState } from "./recent-repositories.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

export function TopBar({ preview, actions, recent, onRefreshRecent, onSelectCommit, onLoadNavigation, onLoadMergeStatus, onCancelMergeStatus }: {
  preview: RepositoryView;
  actions: RepositoryActions;
  recent: RecentState;
  onRefreshRecent(): void;
  onSelectCommit(oid: string): void;
  onLoadNavigation(): void;
  onLoadMergeStatus(names: string[]): void;
  onCancelMergeStatus(): Promise<void>;
  onRefresh(): Promise<void>;
}): React.JSX.Element | null {
  const [scopeOpen, setScopeOpen] = React.useState(false);
  const repository = preview.repository;
  if (!repository) return null;
  const busy = preview.state === "loading" || preview.opening !== null || preview.scopeSwitching || preview.refreshing;
  return <header className="window-toolbar flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
    <RepositorySwitcher repository={repository} session={preview.session} record={preview.record} actions={actions}
      recent={recent} onRefreshRecent={onRefreshRecent} loading={busy} />
    <span aria-hidden="true" className="text-line2">/</span>
    <ScopePicker preview={preview} open={scopeOpen} onOpenChange={setScopeOpen} onChange={scope => actions.switchScope(scope)} onLoadNavigation={onLoadNavigation}
      onLoadMergeStatus={onLoadMergeStatus} onCancelMergeStatus={onCancelMergeStatus} onRefresh={actions.refresh} disabled={busy} />
    <WorktreeChip repository={repository} session={preview.session} navigation={preview.navigation} onOpen={() => setScopeOpen(true)} disabled={busy} />
    {repository.isShallow ? <Badge variant="warn">浅克隆</Badge> : null}
    <div className="flex-1" />
    <SearchPlaceholder />
    <UpdatesPlaceholder />
    {preview.session ? <Button variant="outline" size="sm" disabled={preview.refreshing || busy}
      onClick={() => { void actions.refresh(); }} aria-label="刷新仓库历史">
      <RefreshCw className={cn("size-3.5", preview.refreshing && "animate-spin motion-reduce:animate-none")} strokeWidth={1.75} />
      {preview.refreshing ? "刷新中…" : "刷新"}
    </Button> : null}
    {busy ? <div className="flex min-w-0 items-center gap-2 text-[13px] text-fg2">
      <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" strokeWidth={1.75} aria-hidden="true" />
      <span className="max-w-[220px] truncate" title={preview.opening ?? undefined}>{preview.opening !== null ? `正在打开 ${repositoryName(preview.opening)}…` : preview.scopeSwitching ? "正在切换范围…" : preview.refreshing ? "正在刷新历史…" : "正在读取…"}</span>
      <Button variant="outline" size="sm" title="取消当前查询并关闭仓库，回到打开页" aria-label="取消并关闭仓库" onClick={() => { void actions.cancel(); }}>取消并关闭仓库</Button>
    </div> : null}
  </header>;
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
      <Button variant="ghost" className="h-8 px-2.5 font-semibold text-fg" aria-label={`切换仓库：${name}`} disabled={loading}>
        <span className="max-w-[220px] truncate">{name}</span>
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

function ScopePicker({ preview, open, onOpenChange, onChange, onLoadNavigation, onLoadMergeStatus, onCancelMergeStatus, onRefresh, disabled }: {
  preview: RepositoryView;
  open: boolean;
  onOpenChange(open: boolean): void;
  onChange(scope: RepositoryScope): void;
  onLoadNavigation(): void;
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
      <Button variant="ghost" className="h-8 px-2.5 text-fg2" aria-label={`浏览范围：${label}`} data-testid="scope-picker" disabled={disabled}>
        <GitBranch className="size-3.5" strokeWidth={1.75} />
        <span className="max-w-[240px] truncate">{label}</span>
        <ChevronDown className="size-3.5 text-fg3" strokeWidth={1.75} />
      </Button>
    </PopoverTrigger>
    <PopoverContent className="flex max-h-(--radix-popover-content-available-height) w-[440px] flex-col p-0">
      <div className="flex flex-col gap-1 border-b border-line px-4 py-3">
        <span className="font-semibold">浏览范围</span>
        <span className="text-xs text-fg3">只切换只读历史范围；不会切换或修改任何 worktree。</span>
      </div>
      <div ref={optionsRef} className="min-h-0 overflow-auto p-2" data-testid="scope-options" onScroll={() => visibleBranches()}>
        {option("head", "head", <>HEAD 可达历史{repository.headReference ? <code className="ml-auto font-mono text-xs text-fg3">{shortRefName(repository.headReference)}</code> : repository.headOid ? <code className="ml-auto font-mono text-xs text-fg3">{shortOid(repository.headOid)}</code> : <span className="ml-auto text-xs text-fg3">空仓库</span>}</>, sameScope(scope, "head"))}
        {option("allBranches", "allBranches", <>全部分支<span className="ml-auto text-xs text-fg3">本地与远端可达</span></>, sameScope(scope, "allBranches"), !navigation || Boolean(navigation.refsTruncated))}
        <div className="flex flex-col gap-px py-1">
          <div className="flex justify-between px-2.5 pt-1.5 pb-1 text-[11.5px] font-semibold text-fg3"><span>Worktree</span><span className="font-normal">{navigation ? navigation.worktrees.length : preview.navigationLoading ? "读取中…" : ""}</span></div>
          {(navigation?.worktrees ?? []).map(item => option(`worktree-${item.id}`, { worktree: item.id }, <>
            <Folder className="size-3.5 shrink-0 text-fg3" aria-hidden="true" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{repositoryName(item.path)} · {item.isMain ? "主" : "linked"}{item.isCurrent ? " · 本窗口" : ""}</span>
              <span className="truncate font-mono text-[10.5px] text-fg3" title={item.path}>{item.path}</span>
              <span className="text-[11px] text-fg3">{item.isDetached ? "detached HEAD" : item.headReference ? shortRefName(item.headReference) : item.headOid ? shortOid(item.headOid) : "unborn HEAD"}{item.lockedReason !== null ? ` · 已锁定${item.lockedReason ? `：${item.lockedReason}` : ""}` : ""}{item.prunableReason !== null ? ` · 可清理${item.prunableReason ? `：${item.prunableReason}` : ""}` : ""}{!item.available ? " · 不可用" : ""}</span>
            </span>
          </>, sameScope(scope, { worktree: item.id }), !item.available))}
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
              return <div key={ref.name} data-scope-ref-kind={kind} data-ref-name={kind === "localBranch" ? ref.name : undefined}>
                {option(`ref-${ref.name}`, { ref: ref.name }, <>
                <Icon className="size-3.5 shrink-0 text-fg3" strokeWidth={1.75} aria-hidden="true" />
                <span className="flex min-w-[96px] flex-1 flex-col">
                  <span className="truncate" title={ref.name}>{shortRefName(ref.name)}</span>
                  {kind === "localBranch" ? <span className="truncate text-[10.5px] text-fg3" title={checkoutTitle}>{checkoutLabel}</span> : null}
                </span>
                {isHead ? <Badge variant="head" size="sm">本窗口 HEAD</Badge> : null}
                {merged === "merged" ? <Badge size="sm">已合入</Badge> : null}
                {merged === "unavailable" ? <span className="text-[11px] text-fg3">状态不可用</span> : null}
                <code className="shrink-0 font-mono text-xs text-fg3">{shortOid(ref.peeledOid ?? ref.oid)}</code>
              </>, sameScope(scope, { ref: ref.name }))}
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

function WorktreeChip({ repository, session, navigation, onOpen, disabled }: { repository: RepositoryInfo; session: RepositorySessionInfo | null; navigation: RepositoryNavigation | null; onOpen(): void; disabled: boolean }): React.JSX.Element | null {
  const normalize = (path: string) => path.replace(/[\\/]+$/, "");
  if (repository.isBare) {
    return <Button variant="ghost" size="sm" className="max-w-[280px] min-w-0 justify-start border border-line text-xs text-fg2" onClick={onOpen} disabled={disabled} aria-label="打开 worktree 范围列表" title={repository.path}>
      <Folder className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" /><span className="truncate">bare 仓库 · 没有工作区</span>
    </Button>;
  }
  if (!repository.worktreePath) return null;
  const linked = normalize(repository.gitDir) !== normalize(repository.commonDir);
  const head = repository.headReference ? shortRefName(repository.headReference) : repository.headOid ? shortOid(repository.headOid) : "空";
  const count = navigation ? `${navigation.worktrees.length} 个 worktree` : "worktree 列表";
  return <Button variant="ghost" size="sm" className="max-w-[320px] min-w-0 justify-start border border-line text-xs text-fg2" onClick={onOpen} disabled={disabled}
    title={`${repository.worktreePath} · HEAD ${head}`} aria-label={`打开 worktree 列表，本窗口 ${repositoryName(repository.worktreePath)}，HEAD ${head}`}>
    <Folder className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
    <span className="truncate">本窗口 {repositoryName(repository.worktreePath)}</span>
    <span className="shrink-0 text-fg3">{linked ? "linked" : "主"} · HEAD {head} · {count}</span>
  </Button>;
}
