import * as React from "react";
import { ChevronDown, Cloud, Folder, GitBranch, LoaderCircle, Tag } from "lucide-react";
import type { RefInfo, RepositoryInfo, RepositorySessionInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositoryView, ViewRecord } from "../lib/repository-session-store.js";
import type { RepositoryActions } from "../app.js";
import { momentLabel, refTarget, repositoryName, shortOid, shortRefName } from "../lib/format.js";
import { cn } from "../lib/utils.js";
import { PathField } from "./path-field.js";
import { SearchPlaceholder, UpdatesPlaceholder } from "./placeholder-widgets.js";
import { RecentList, storeStatusText, type RecentState } from "./recent-repositories.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

export function TopBar({ preview, actions, recent, onRefreshRecent, onSelectCommit }: {
  preview: RepositoryView;
  actions: RepositoryActions;
  recent: RecentState;
  onRefreshRecent(): void;
  onSelectCommit(oid: string): void;
}): React.JSX.Element | null {
  const repository = preview.repository;
  if (!repository) return null;
  const busy = preview.state === "loading" || preview.opening !== null;
  return <header className="flex min-h-[52px] flex-wrap items-center gap-3 border-b border-line px-4 py-2">
    <RepositorySwitcher repository={repository} session={preview.session} record={preview.record} actions={actions}
      recent={recent} onRefreshRecent={onRefreshRecent} loading={busy} />
    <span aria-hidden="true" className="text-line2">/</span>
    <RefsPicker preview={preview} repository={repository} onSelectCommit={onSelectCommit} />
    <WorktreeChip repository={repository} />
    {repository.isShallow ? <Badge variant="warn">浅克隆</Badge> : null}
    <div className="flex-1" />
    <SearchPlaceholder />
    <UpdatesPlaceholder />
    {busy ? <div className="flex min-w-0 items-center gap-2 text-[13px] text-fg2">
      <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" strokeWidth={1.75} aria-hidden="true" />
      <span className="max-w-[220px] truncate" title={preview.opening ?? undefined}>{preview.opening !== null ? `正在打开 ${repositoryName(preview.opening)}…` : "正在读取…"}</span>
      <Button variant="outline" size="sm" title="停止读取并关闭仓库，回到打开页" onClick={() => { void actions.cancel(); }}>取消</Button>
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
      <Button variant="ghost" className="h-8 px-2.5 font-semibold text-fg" aria-label={`切换仓库：${name}`}>
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
  const tip = previous?.tips[0];
  const headOid = session.repository.headOid;
  let visit: string;
  if (!previous) visit = session.persistence.lastSeen === "ok" ? "第一次在这个 worktree 查看，还没有查看记录。" : "没有可用的查看记录。";
  else if (!tip) visit = `上次查看 ${momentLabel(previous.viewedAtUnixMs)} · 当时还没有提交`;
  else visit = `上次查看 ${momentLabel(previous.viewedAtUnixMs)} · 当时 HEAD ${shortOid(tip)}${tip === headOid ? "，与现在相同" : "，现在已不同"}`;
  const notes = [
    storeStatusText(session.persistence.lastSeen) ? `查看记录${storeStatusText(session.persistence.lastSeen)}` : null,
    record && !record.saved ? `这次查看没有保存${record.error ? `：${record.error.message}` : record.status ? `（${storeStatusText(record.status) ?? record.status}）` : ""}` : null,
  ].filter((note): note is string => Boolean(note));
  return <>
    <span className="text-xs text-fg3">HEAD 读取于 {momentLabel(session.observedAtUnixMs)}；之后的新提交要重新打开才会显示</span>
    <span className="text-xs text-fg3" data-testid="previous-view">{visit}</span>
    {notes.map(note => <span key={note} className="text-xs text-warn">{note}</span>)}
  </>;
}

function headLabel(repository: RepositoryInfo): string {
  if (repository.headReference) return shortRefName(repository.headReference);
  if (repository.headOid) return `Detached HEAD · ${shortOid(repository.headOid)}`;
  return "尚无 HEAD";
}

const GROUPS: { kind: RefInfo["kind"]; title: string; Icon: typeof GitBranch }[] = [
  { kind: "localBranch", title: "本地分支", Icon: GitBranch },
  { kind: "remoteBranch", title: "远端跟踪", Icon: Cloud },
  { kind: "tag", title: "标签", Icon: Tag },
];

function RefsPicker({ preview, repository, onSelectCommit }: {
  preview: RepositoryView;
  repository: RepositoryInfo;
  onSelectCommit(oid: string): void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const loaded = React.useMemo(() => new Set(preview.commits.map(commit => commit.oid)), [preview.commits]);
  const label = headLabel(repository);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button variant="ghost" className="h-8 px-2.5 text-fg2" aria-label={`引用列表，当前浏览 ${label}`}>
        <GitBranch className="size-3.5" strokeWidth={1.75} />
        <span className="max-w-[240px] truncate">{label}</span>
        <ChevronDown className="size-3.5 text-fg3" strokeWidth={1.75} />
      </Button>
    </PopoverTrigger>
    <PopoverContent className="flex max-h-(--radix-popover-content-available-height) w-[420px] flex-col p-0">
      <div className="flex flex-col gap-1 border-b border-line px-4 py-3">
        <span className="font-semibold">正在浏览 HEAD 可达历史</span>
        <span className="text-xs text-fg3">暂不支持切换到其他分支。点击引用，可以在已加载的 {preview.commits.length} 个提交中定位它指向的提交。</span>
      </div>
      <div className="min-h-0 overflow-auto p-2">
        {GROUPS.map(({ kind, title, Icon }) => {
          const refs = preview.refs.filter(ref => ref.kind === kind);
          if (!refs.length) return null;
          return <div key={kind} className="flex flex-col gap-px py-1">
            <div className="flex justify-between px-2.5 pt-1.5 pb-1 text-[11.5px] font-semibold text-fg3"><span>{title}</span><span className="font-normal">{refs.length}</span></div>
            {refs.map(ref => {
              const target = refTarget(ref);
              const isLoaded = loaded.has(target);
              const isHead = ref.name === repository.headReference;
              return <button key={ref.name} type="button" disabled={!isLoaded}
                className={cn("flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] hover:bg-hover disabled:hover:bg-transparent")}
                onClick={() => { onSelectCommit(target); setOpen(false); }}>
                <Icon className="size-3.5 shrink-0 text-fg3" strokeWidth={1.75} aria-hidden="true" />
                <span className={cn("min-w-0 flex-1 truncate", !isLoaded && "text-fg3")}>{shortRefName(ref.name)}</span>
                {isHead ? <Badge variant="head" size="sm">本窗口 HEAD</Badge> : null}
                {isLoaded ? <code className="font-mono text-xs text-fg3">{shortOid(target)}</code> : <span className="text-xs text-fg3">不在已加载的提交中</span>}
              </button>;
            })}
          </div>;
        })}
        {preview.refs.length === 0 ? <p className="m-0 px-2.5 py-3 text-[13px] text-fg3">这个仓库还没有引用。</p> : null}
      </div>
      {preview.refsTruncated ? <div className="border-t border-line bg-bg px-4 py-2.5 text-xs text-fg3">引用数量达到显示上限，列表不完整。</div> : null}
    </PopoverContent>
  </Popover>;
}

function WorktreeChip({ repository }: { repository: RepositoryInfo }): React.JSX.Element | null {
  const normalize = (path: string) => path.replace(/[\\/]+$/, "");
  if (repository.isBare) {
    return <span className="inline-flex h-7 items-center gap-1.5 rounded-[14px] border border-line px-2.5 text-xs text-fg2">
      <Folder className="size-3.5" strokeWidth={1.75} aria-hidden="true" />bare 仓库 · 没有工作区
    </span>;
  }
  if (!repository.worktreePath) return null;
  const linked = normalize(repository.gitDir) !== normalize(repository.commonDir);
  return <span title={repository.worktreePath} className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-[14px] border border-line px-2.5 text-xs text-fg2">
    <Folder className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
    <span className="truncate">worktree {repositoryName(repository.worktreePath)}</span>
    <span className="text-fg3">{linked ? "linked" : "主"}</span>
  </span>;
}
