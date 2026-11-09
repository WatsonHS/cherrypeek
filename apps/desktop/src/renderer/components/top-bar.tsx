import * as React from "react";
import { ArrowLeft, ArrowRight, ChevronDown, Cloud, CornerUpLeft, Ellipsis, Folder, GitBranch, Keyboard, Layers, LoaderCircle, RefreshCw, Search, Tag, X } from "lucide-react";
import type { NavigationView } from "../lib/navigation-history.js";
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
import type { HandoffRequest } from "./handoff-dialog.js";
import type { ActivityStats, RefSnapshotDiff, RepositoryObservation, SearchIdentity } from "../../../../../packages/protocol/src/generated/server-message.js";
import { SearchControls } from "./search-controls.js";
import { PageSwitch, type AppPage } from "./page-switch.js";
import type { WorkspaceBadge } from "../lib/workspace-indicator.js";
import { RecentList, storeStatusText, type RecentState } from "./recent-repositories.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

const NAV_CLASS = "flex size-7 items-center justify-center rounded-[7px] text-fg2 hover:bg-hover hover:text-fg disabled:text-fg3 disabled:opacity-45 disabled:hover:bg-transparent";
const HINT_CLASS = "flex h-7 max-w-[clamp(96px,14vw,200px)] items-center gap-1 rounded-[7px] bg-accent-soft pr-2.5 pl-1.5 text-[12.5px] font-medium whitespace-nowrap text-accent-fg hover:brightness-95";

export function TopBar({ preview, actions, recent, onRefreshRecent, onSelectCommit, onLoadNavigation, onLoadMergeStatus, onCancelMergeStatus,
  searchView, activityQuery, onSearchQueryChange, onSearchComposition, onLoadSearchIdentities, onLoadSearchPaths, observation, refDiff, refDiffLoading, refDiffError,
  onLoadRefDiff, onCancelRefDiff, onObserve, onOpenHandoff, activityStats, activityLoading, activityError, onLoadActivity, onActivityAuthor,
  page, onPageChange, workspace, workspaceBranch, filesAvailable, pageSearch, history }: {
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
  onOpenHandoff(request: HandoffRequest): void;
  activityStats: ActivityStats | null;
  activityLoading: boolean;
  activityError: string | null;
  onLoadActivity(): void;
  onActivityAuthor(identity: SearchIdentity): void;
  page: AppPage;
  onPageChange(page: AppPage): void;
  workspace: WorkspaceBadge;
  workspaceBranch: string | null;
  filesAvailable: boolean;
  /** The search box of the files and workspace pages; the commits page uses the metadata search. */
  pageSearch: React.ReactNode;
  /**
   * Back / forward between recorded places (⌘[ / ⌘]). After a jump to another page, `hint` names where it came from:
   * merged into the back button while one step back is that place, otherwise a separate button that returns there.
   */
  history: { view: NavigationView; hint: { label: string; title: string; merged: boolean } | null; onBack(): void; onForward(): void; onReturn(): void };
}): React.JSX.Element | null {
  const [scopeOpen, setScopeOpen] = React.useState(false);
  const hint = history.hint;
  const repository = preview.repository;
  if (!repository) return null;
  const busy = preview.state === "loading" || preview.opening !== null || preview.scopeSwitching || preview.refreshing;
  return <header className="window-toolbar relative flex h-[52px] min-h-[52px] max-h-[52px] flex-nowrap items-center gap-1 overflow-hidden border-b border-line py-2">
    {/* Two labelled blocks: which repository (and worktree) this window shows, and which history it browses. */}
    <RepositorySwitcher repository={repository} session={preview.session} record={preview.record} actions={actions}
      recent={recent} onRefreshRecent={onRefreshRecent} loading={busy}
      navigation={preview.navigation} navigationLoading={preview.navigationLoading} navigationError={preview.navigationError?.message ?? null}
      onLoadNavigation={onLoadNavigation} />
    <span aria-hidden="true" className="topbar-divider h-6 w-px shrink-0 bg-line" />
    <div className="flex shrink-0 items-center" data-testid="nav-buttons">
      {/* After a jump to another page: "← 提交 92aa8c23" while one step back is that place; once other steps are recorded,
          ← goes one step and "↩ 提交 92aa8c23" beside it returns to where the jump came from. */}
      <button type="button" data-testid="nav-back" data-hint={hint?.merged ? "true" : undefined}
        aria-label={history.view.backLabel ? `后退到 ${history.view.backLabel}` : "后退"} disabled={!history.view.canBack} onClick={history.onBack}
        title={history.view.backLabel ? `后退到 ${history.view.backLabel}（⌘[）` : "后退（⌘[）"}
        className={hint?.merged ? `nav-hint ${HINT_CLASS}` : NAV_CLASS}>
        <ArrowLeft className={hint?.merged ? "size-3.5 shrink-0" : "size-4"} strokeWidth={1.75} />{hint?.merged ? <span className="truncate">{hint.label}</span> : null}</button>
      <button type="button" data-testid="nav-forward" aria-label={history.view.forwardLabel ? `前进到 ${history.view.forwardLabel}` : "前进"} disabled={!history.view.canForward} onClick={history.onForward}
        title={history.view.forwardLabel ? `前进到 ${history.view.forwardLabel}（⌘]）` : "前进（⌘]）"} className={NAV_CLASS}>
        <ArrowRight className="size-4" strokeWidth={1.75} /></button>
      {hint && !hint.merged ? <button type="button" data-testid="nav-return" data-hint="true" onClick={history.onReturn}
        aria-label={`回到 ${hint.title}`} title={`回到 ${hint.title}`} className={`nav-hint ml-1 ${HINT_CLASS}`}>
        <CornerUpLeft className="size-3.5 shrink-0" strokeWidth={1.75} /><span className="truncate">{hint.label}</span></button> : null}
    </div>
    <PageSwitch page={page} onChange={onPageChange} workspace={workspace} workspaceBranch={workspaceBranch} filesAvailable={filesAvailable} />
    <ScopePicker dimmed={page === "workspace"} preview={preview} open={scopeOpen} onOpenChange={setScopeOpen} onChange={scope => actions.switchScope(scope)} onLoadNavigation={onLoadNavigation}
      onOpenHandoff={onOpenHandoff}
      onLoadMergeStatus={onLoadMergeStatus} onCancelMergeStatus={onCancelMergeStatus} onRefresh={actions.refresh} disabled={busy} />
    {repository.isShallow ? <Badge variant="warn">浅克隆</Badge> : null}
    <div className="min-w-0 flex-1 basis-0" />
    <ActivityStatsPopover query={activityQuery} stats={activityStats} loading={activityLoading} error={activityError}
      onLoad={onLoadActivity} onQueryChange={onSearchQueryChange} onAddAuthor={onActivityAuthor} />
    <TopBarSearch label={page === "commits" ? "搜索提交消息" : page === "files" ? "在文件页搜索" : "过滤改动的文件"}>
      {page === "commits" ? <SearchControls view={searchView} sessionKey={preview.session ? `${preview.session.repoId}:${preview.session.generation}` : "offline"}
        onQueryChange={onSearchQueryChange} onComposition={onSearchComposition} onLoadIdentities={onLoadSearchIdentities} onLoadPaths={onLoadSearchPaths} /> : pageSearch}
    </TopBarSearch>
    <ShortcutGuide />
    <UpdatesPopover observation={observation} diff={refDiff} loading={refDiffLoading} error={refDiffError} onLoad={onLoadRefDiff} onObserve={onObserve}
      onCancel={onCancelRefDiff} onRefresh={() => { void actions.refresh(); }} />
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

/** Fires when ⌘F asks for the search box; narrow windows expand it first. */
export const FOCUS_SEARCH_EVENT = "commitscope:focus-search";

/**
 * The search slot. Below 1100px it collapses into an icon button (CSS in styles.css); the button or ⌘F expands it
 * over the right end of the top bar and focuses it. Esc, ×, or a click outside collapse it again; a search that is
 * still in effect marks the icon.
 */
/** Below 1100px the search box collapses into an icon (styles.css); only then is there an "expanded" state. */
function narrowSearch(): boolean {
  return window.matchMedia("(max-width: 1099px)").matches;
}

function TopBarSearch({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const [hasQuery, setHasQuery] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const wantsFocus = React.useRef(false);
  const input = () => rootRef.current?.querySelector<HTMLInputElement>(".topbar-search-body [data-testid='search-input'], .topbar-search-body input:not([type='hidden'])") ?? null;
  const focusInput = React.useCallback(() => {
    // A visible box takes focus at once, so keys typed right after ⌘F are not lost; a collapsed one focuses once shown.
    // Only a narrow window has a collapsed box: at full width ⌘F just focuses, and Esc keeps its meaning for the page.
    wantsFocus.current = true;
    if (narrowSearch()) setExpanded(true);
    const field = input();
    if (field && field.offsetParent !== null) { field.focus(); wantsFocus.current = false; }
  }, []);
  React.useLayoutEffect(() => {
    if (!expanded || !wantsFocus.current) return;
    wantsFocus.current = false;
    input()?.focus();
  }, [expanded]);
  React.useEffect(() => {
    window.addEventListener(FOCUS_SEARCH_EVENT, focusInput);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, focusInput);
  }, [focusInput]);
  const collapse = React.useCallback(() => {
    setHasQuery(Boolean(input()?.value));
    setExpanded(false);
    if (rootRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }, []);
  // While expanded, Esc anywhere closes the box (and goes no further), and so does a click outside it.
  React.useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (!narrowSearch()) { setExpanded(false); return; }
      // A popover or dialog opened on top (e.g. ⌘K) takes its own Esc first.
      if (event.key !== "Escape" || event.isComposing || document.querySelector("[data-slot='popover-content'][data-state='open'], [role='dialog'][data-state='open']")) return;
      event.preventDefault();
      event.stopPropagation();
      collapse();
    };
    const onPointer = (event: PointerEvent) => {
      if (!narrowSearch()) { setExpanded(false); return; }
      const target = event.target as Node | null;
      if (rootRef.current?.contains(target) || (target instanceof Element && target.closest("[data-slot='popover-content']"))) return;
      collapse();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => { window.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onPointer, true); };
  }, [collapse, expanded]);
  return <div ref={rootRef} className="topbar-search contents" data-expanded={expanded ? "true" : "false"}>
    <Button variant="ghost" size="icon" className="topbar-search-toggle" data-active={hasQuery ? "true" : undefined} aria-label={label}
      title={hasQuery ? `${label}（搜索仍在生效，⌘F）` : `${label}（⌘F）`} onClick={focusInput}>
      <Search className="size-4" strokeWidth={1.75} />
    </Button>
    <div className="topbar-search-body flex min-w-0 items-center">{children}
      <button type="button" className="topbar-search-close" aria-label="收起搜索框" title="收起搜索框（Esc）" onClick={collapse}><X className="size-3.5" strokeWidth={1.75} /></button>
    </div>
  </div>;
}

/**
 * One rule per modifier, the same on every page: ⌘ + digit picks the page, ⌥⌘ + digit the first or second view on the
 * right of it, ⌥ + letter toggles a display option, and ⌘[ / ⌘] always go back and forward.
 */
function ShortcutGuide(): React.JSX.Element {
  const mac = /Mac|iPhone|iPad/u.test(navigator.platform);
  const cmd = mac ? "⌘" : "Ctrl+";
  const alt = mac ? "⌥" : "Alt+";
  const altCmd = mac ? "⌥⌘" : "Ctrl+Alt+";
  const groups: { title: string; rows: [string, string][] }[] = [
    { title: "全局", rows: [
      ["快速跳转", `${cmd}K`],
      ["切换页面：提交 / 文件 / 工作区", `${cmd}1 / 2 / 3`],
      ["后退 / 前进", `${cmd}[ / ]`],
      ["聚焦搜索", `${cmd}F`],
      ["刷新仓库历史", `${altCmd}R`],
    ] },
    { title: "右侧视图", rows: [
      ["提交页：滚到概览 / 文件改动", `${altCmd}1 / 2`],
      ["文件页：文件 / 修改", `${altCmd}1 / 2`],
    ] },
    { title: "显示开关", rows: [
      ["文件页：历史列", `${alt}H`],
      ["文件页：逐行追溯", `${alt}B`],
      ["diff：上下合并 / 左右并排", `${alt}D`],
      ["diff：只看改动 / 完整文件", `${alt}F`],
      ["diff：自动换行", `${alt}Z`],
    ] },
    { title: "搜索与列表", rows: [
      ["在历史中定位所选结果", `${cmd}L`],
      ["定位后回到搜索结果", `${cmd}[`],
      ["列表中上下选择", "↑ / ↓"],
      ["关闭修改 / 收起搜索", "Esc"],
    ] },
  ];
  return <Popover>
    <PopoverTrigger asChild><Button variant="ghost" size="icon" aria-label="快捷键说明" title="快捷键说明" data-testid="shortcut-guide-trigger">
      <Keyboard className="topbar-shortcut-icon size-4" strokeWidth={1.75} />
      <Ellipsis className="topbar-more-icon hidden size-4" strokeWidth={1.75} />
    </Button></PopoverTrigger>
    <PopoverContent align="end" className="w-[320px] p-3" data-testid="shortcut-guide">
      <h2 className="m-0 mb-1 text-[13px] font-semibold">快捷键</h2>
      {groups.map(group => <section key={group.title} className="mt-2.5 first-of-type:mt-1.5">
        <h3 className="m-0 mb-1 text-[11px] font-semibold text-fg3">{group.title}</h3>
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-xs">
          {group.rows.map(([label, keys]) => <React.Fragment key={label}><dt className="text-fg2">{label}</dt><dd className="m-0 text-right font-mono text-fg3">{keys}</dd></React.Fragment>)}
        </dl>
      </section>)}
      <p className="m-0 mt-2.5 text-[11px] text-fg3">浏览范围用顶部的范围选择器切换。</p>
    </PopoverContent>
  </Popover>;
}

/** Caption-over-value toolbar button, so each block says what it is. */
const BLOCK_BUTTON = "h-10 min-w-0 shrink flex-col items-start justify-center gap-0 px-2.5 py-0.5 text-left";
function BlockCaption({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="max-w-full truncate text-[10.5px] leading-[13px] font-normal text-fg3">{children}</span>;
}

function isLinkedWorktree(repository: RepositoryInfo): boolean {
  return repository.worktreePath !== null
    && repository.gitDir.replace(/[\\/]+$/, "") !== repository.commonDir.replace(/[\\/]+$/, "");
}

function RepositorySwitcher({ repository, session, record, actions, recent, onRefreshRecent, loading, navigation, navigationLoading, navigationError, onLoadNavigation }: {
  repository: RepositoryInfo;
  session: RepositorySessionInfo | null;
  record: ViewRecord | null;
  actions: RepositoryActions;
  recent: RecentState;
  onRefreshRecent(): void;
  loading: boolean;
  navigation: RepositoryNavigation | null;
  navigationLoading: boolean;
  navigationError: string | null;
  onLoadNavigation(): void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const name = repositoryName(repository.worktreePath ?? repository.path);
  const caption = repository.isBare ? "仓库 · bare" : isLinkedWorktree(repository) ? "仓库 · 关联 worktree" : "仓库";
  const openPath = (path: string) => { setOpen(false); void actions.open(path); };
  return <Popover open={open} onOpenChange={next => {
    setOpen(next);
    if (!next) return;
    onRefreshRecent();
    if (!navigation && !navigationLoading && !navigationError) onLoadNavigation();
  }}>
    <PopoverTrigger asChild>
      <Button variant="ghost" className={cn("topbar-repository max-w-[240px]", BLOCK_BUTTON)} aria-label={`切换仓库：${name}`} title={repository.path} disabled={loading}>
        <BlockCaption>{caption}</BlockCaption>
        <span className="flex min-w-0 max-w-full items-center gap-1 text-[13px] leading-5 font-semibold text-fg">
          <span className="min-w-0 truncate">{name}</span>
          <ChevronDown className="size-3.5 text-fg3" strokeWidth={1.75} />
        </span>
      </Button>
    </PopoverTrigger>
    <PopoverContent className="flex max-h-(--radix-popover-content-available-height) w-[460px] flex-col gap-3.5 overflow-auto p-4">
      <div className="flex flex-col gap-1">
        <span className="text-[11.5px] font-semibold text-fg3">当前仓库</span>
        {/* A worktree's directory is listed under 当前工作区 below. */}
        {repository.worktreePath === null ? <code className="font-mono text-xs break-all text-fg2">{repository.path}</code> : null}
        <span className="text-xs text-fg3">对象格式 {repository.objectFormat}{repository.isBare ? " · bare 仓库" : ""}{repository.isShallow ? " · 浅克隆" : ""}</span>
        {session ? <SessionFacts session={session} record={record} /> : <span className="text-xs text-warn">核心已断开，这里显示的是之前读取的内容。</span>}
      </div>
      <WorktreeFacts repository={repository} navigation={navigation} navigationLoading={navigationLoading}
        navigationError={navigationError} onLoadNavigation={onLoadNavigation} />
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

/** What the scope button shows: the branch, ref or worktree being browsed, with a matching icon. */
function scopeValue(scope: RepositoryScope, repository: RepositoryInfo, navigation: RepositoryNavigation | null): { text: string; icon: React.ReactNode } {
  const iconClass = "size-3.5 shrink-0 text-fg3";
  if (scope === "head") return {
    text: repository.headReference ? shortRefName(repository.headReference) : repository.headOid ? `HEAD ${shortOid(repository.headOid)}` : "空仓库",
    icon: <HeadIcon className={cn(iconClass, "text-accent")} />,
  };
  if (scope === "allBranches") return { text: "全部分支", icon: <Layers className={iconClass} strokeWidth={1.75} /> };
  if ("ref" in scope) {
    const Icon = scope.ref.startsWith("refs/tags/") ? Tag : scope.ref.startsWith("refs/remotes/") ? Cloud : GitBranch;
    return { text: shortRefName(scope.ref), icon: <Icon className={iconClass} strokeWidth={1.75} /> };
  }
  const worktree = navigation?.worktrees.find(item => item.id === scope.worktree);
  return { text: worktree ? `worktree · ${repositoryName(worktree.path)}` : "worktree", icon: <Folder className={iconClass} strokeWidth={1.75} /> };
}

/** The HEAD icon from docs/DESIGN.md section 8, also used by the HEAD label in the history list. */
function HeadIcon({ className }: { className?: string }): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true" className={className}
    style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.5 }}><circle cx={8} cy={8} r={5} /><circle cx={8} cy={8} r={1.5} style={{ fill: "currentColor" }} /></svg>;
}

function sameScope(left: RepositoryScope | undefined, right: RepositoryScope): boolean {
  if (!left) return false;
  if (typeof left === "string" || typeof right === "string") return left === right;
  if ("ref" in left && "ref" in right) return left.ref === right.ref;
  if ("worktree" in left && "worktree" in right) return left.worktree === right.worktree;
  return false;
}

function ScopePicker({ preview, open, onOpenChange, onChange, onLoadNavigation, onOpenHandoff, onLoadMergeStatus, onCancelMergeStatus, onRefresh, disabled, dimmed }: {
  preview: RepositoryView;
  open: boolean;
  onOpenChange(open: boolean): void;
  onChange(scope: RepositoryScope): void;
  onLoadNavigation(): void;
  onOpenHandoff(request: HandoffRequest): void;
  onLoadMergeStatus(names: string[]): void;
  onCancelMergeStatus(): Promise<void>;
  onRefresh(): Promise<void>;
  disabled: boolean;
  /** On the workspace page the scope does not apply; it stays usable but recedes. */
  dimmed: boolean;
}): React.JSX.Element {
  const optionsRef = React.useRef<HTMLDivElement>(null);
  const repository = preview.repository!;
  const navigation = preview.navigation;
  const scope = preview.session?.scope;
  const label = scopeLabel(scope ?? "head", repository, navigation);
  const value = scopeValue(scope ?? "head", repository, navigation);
  const caption = scope === "head" || !scope ? "浏览范围 · HEAD" : "浏览范围";
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
      <Button variant="ghost" className={cn("topbar-scope-picker max-w-[220px]", BLOCK_BUTTON, dimmed && "opacity-50 hover:opacity-100")}
        aria-label={`浏览范围：${label}${dimmed ? "（只影响提交和文件页）" : ""}`}
        title={dimmed ? `浏览范围：${label}。只影响提交和文件页，不会改变工作区` : `浏览范围：${label}。只切换历史，不会 checkout`} data-testid="scope-picker" disabled={disabled}>
        <BlockCaption>{caption}</BlockCaption>
        <span className="flex min-w-0 max-w-full items-center gap-1.5 text-[13px] leading-5 font-medium text-fg">
          {value.icon}
          <span className="topbar-scope-label min-w-0 truncate">{value.text}</span>
          <ChevronDown className="size-3.5 text-fg3" strokeWidth={1.75} />
        </span>
      </Button>
    </PopoverTrigger>
    {open ? <PopoverContent className="flex max-h-(--radix-popover-content-available-height) w-[440px] flex-col p-0" data-testid="scope-popover">
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
              ? <Button variant="ghost" size="sm" data-testid="handoff-stale-worktree" className="h-7 shrink-0 px-2 text-xs"
                aria-label={`交给 Agent 核查失效 worktree ${repositoryName(item.path)}`} title="交给 Agent 核查这条失效记录"
                onClick={() => { onOpenChange(false); onOpenHandoff({ scenario: "stale-worktree", target: { kind: "worktree", id: item.id, stale: true } }); }}>核查</Button> : null}
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
                {merged === "patchEquivalent" && navigation?.defaultBase ? <Badge size="sm" className="max-w-[180px]" title="已找到等价补丁；清理前需要重新核对当前内容"><span className="truncate">内容已在 {shortRefName(navigation.defaultBase.name)}</span></Badge> : null}
                <code className="shrink-0 font-mono text-xs text-fg3">{shortOid(ref.peeledOid ?? ref.oid)}</code>
                </>, sameScope(scope, { ref: ref.name }))}</div>
                {kind === "localBranch" && (merged === "merged" || merged === "patchEquivalent") && !isHead && ref.name !== navigation?.defaultBase?.name
                  ? <Button variant="ghost" size="sm" data-testid="handoff-cleanup" className="h-7 shrink-0 px-2 text-xs"
                    aria-label={`交给 Agent 清理已合入的分支 ${shortRefName(ref.name)}`} title="交给 Agent 核对后删除这个已合入的分支"
                    onClick={() => { onOpenChange(false); onOpenHandoff({ scenario: "cleanup", target: { kind: "branch", ref: ref.name } }); }}>清理</Button> : null}
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
    </PopoverContent> : null}
  </Popover>;
}

/** The current directory's worktree facts, independent of the browsing scope. */
function WorktreeFacts({ repository, navigation, navigationLoading, navigationError, onLoadNavigation }: {
  repository: RepositoryInfo;
  navigation: RepositoryNavigation | null;
  navigationLoading: boolean;
  navigationError: string | null;
  onLoadNavigation(): void;
}): React.JSX.Element {
  const path = repository.worktreePath ?? repository.path;
  const linked = isLinkedWorktree(repository);
  const headDescription = repository.headReference
    ? `分支 ${repository.headReference}`
    : repository.headOid ? "detached HEAD" : "空仓库（尚无 HEAD 提交）";
  const worktreeCount = navigation
    ? `${navigation.worktreesTruncated ? "至少 " : ""}${navigation.worktrees.length} 个 worktree`
    : navigationLoading ? "正在读取 worktree 清单…" : navigationError ? "worktree 清单读取失败" : "尚未读取 worktree 清单";
  return <section className="flex flex-col gap-1.5" data-testid="worktree-info" aria-label="当前工作区">
    <span className="text-[11.5px] font-semibold text-fg3">当前工作区</span>
      <dl className="m-0 grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        <dt className="text-fg3">目录</dt><dd className="m-0 break-all font-mono" title={path}>{path}</dd>
        <dt className="text-fg3">类型</dt><dd className="m-0">{repository.isBare ? "bare 仓库（没有工作区目录）" : linked ? "关联 worktree" : "主 worktree"}</dd>
        <dt className="text-fg3">实际 HEAD</dt><dd className="m-0 break-all">{repository.isBare ? "bare 仓库没有工作区 HEAD" : headDescription}</dd>
        <dt className="text-fg3">HEAD 完整 OID</dt><dd className="m-0 break-all font-mono">{repository.headOid ?? "无提交"}</dd>
        <dt className="text-fg3">关联 worktree</dt><dd className="m-0">{worktreeCount}</dd>
      </dl>
      {navigationLoading ? <p role="status" className="mb-0 mt-3 text-xs text-fg3">正在读取导航快照…</p> : null}
      {navigationError ? <div role="alert" className="mt-3 text-xs text-bad">{navigationError}<button type="button" className="ml-2 underline" onClick={onLoadNavigation}>重试</button></div> : null}
      {navigation?.worktreesTruncated ? <p role="status" className="mb-0 mt-2 text-xs text-warn">worktree 清单已达到显示上限，数量为下限。</p> : null}
  </section>;
}
