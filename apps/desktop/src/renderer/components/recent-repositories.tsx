import * as React from "react";
import { Folder } from "lucide-react";
import type { RecentRepository, StoreStatus } from "../../../../../packages/protocol/src/generated/server-message.js";
import { homeAbbreviated, relativeTime, repositoryName } from "../lib/format.js";
import { cn } from "../lib/utils.js";

export interface RecentState {
  loaded: boolean;
  repositories: RecentRepository[];
  status: StoreStatus | null;
  error: string | null;
}

type Kind = "main" | "linked" | "bare";

const trimSeparators = (path: string): string => path.replace(/[\\/]+$/, "");

function kindOf(entry: RecentRepository): Kind {
  if (entry.worktreePath === null) return "bare";
  return trimSeparators(entry.gitDir) === trimSeparators(entry.commonDir) ? "main" : "linked";
}

function entryName(entry: RecentRepository): string {
  return repositoryName(entry.worktreePath ?? entry.path);
}

/** Where the shared object store lives: the main worktree root, or the bare repository itself. */
function storeRoot(entry: RecentRepository): string {
  return trimSeparators(entry.commonDir).replace(/[\\/]\.git$/, "");
}

interface Group {
  key: string;
  entries: RecentRepository[];
}

/** Worktrees that share an object store are listed under one repository, newest first. */
function groupRecent(repositories: RecentRepository[]): Group[] {
  const groups = new Map<string, RecentRepository[]>();
  for (const entry of repositories) {
    const list = groups.get(entry.repositoryKey) ?? [];
    list.push(entry);
    groups.set(entry.repositoryKey, list);
  }
  return [...groups.entries()]
    .map(([key, entries]) => ({ key, entries: entries.sort((a, b) => b.lastOpenedAtUnixMs - a.lastOpenedAtUnixMs) }))
    .sort((a, b) => b.entries[0]!.lastOpenedAtUnixMs - a.entries[0]!.lastOpenedAtUnixMs);
}

function Tag({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="inline-flex h-5 shrink-0 items-center rounded-[10px] bg-sunken px-[7px] text-[11.5px] font-medium whitespace-nowrap text-fg2">{children}</span>;
}

const KIND_TAG: Record<Kind, string | null> = { main: null, linked: "linked", bare: "bare 仓库" };

/** Full list for the open screen, laid out after the v3 open-screen board. */
export function RecentRepositories({ recent, onOpen, disabled }: {
  recent: RecentState;
  onOpen(path: string): void;
  disabled?: boolean;
}): React.JSX.Element | null {
  if (!recent.loaded) return null;
  const groups = groupRecent(recent.repositories);
  return <section aria-labelledby="recent-repositories" className="flex flex-col gap-2.5">
    <h2 id="recent-repositories" className="m-0 px-1 text-[13px] font-semibold text-fg3">最近打开</h2>
    {groups.length
      ? <div className="flex flex-col divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-panel">
        {groups.map(group => <RecentGroup key={group.key} group={group} onOpen={onOpen} disabled={disabled} />)}
      </div>
      : recent.status === "ok" && !recent.error ? <p className="m-0 px-1 text-[13px] text-fg3">还没有打开过仓库。打开后会出现在这里。</p> : null}
    <StoreNote recent={recent} />
  </section>;
}

function RecentGroup({ group, onOpen, disabled }: { group: Group; onOpen(path: string): void; disabled?: boolean }): React.JSX.Element {
  const latest = group.entries[0]!;
  const rowClass = "flex w-full items-center gap-3.5 border-0 bg-transparent px-4 py-2.5 text-left hover:bg-hover disabled:hover:bg-transparent";
  if (group.entries.length === 1) {
    const tag = KIND_TAG[kindOf(latest)];
    return <button type="button" disabled={disabled} className={cn(rowClass, "min-h-[60px]")} title={latest.path} onClick={() => onOpen(latest.path)}>
      <Folder className="size-5 shrink-0 text-fg3" strokeWidth={1.5} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2"><span className="truncate font-semibold">{entryName(latest)}</span>{tag ? <Tag>{tag}</Tag> : null}</span>
        <span className="truncate font-mono text-xs text-fg3">{homeAbbreviated(latest.worktreePath ?? latest.path)}</span>
      </span>
      <span className="shrink-0 text-[12.5px] text-fg3">{relativeTime(latest.lastOpenedAtUnixMs)}</span>
    </button>;
  }
  const root = storeRoot(latest);
  return <div className="flex flex-col">
    <button type="button" disabled={disabled} className={cn(rowClass, "min-h-[60px]")} title={`打开最近使用的 worktree：${latest.path}`} onClick={() => onOpen(latest.path)}>
      <Folder className="size-5 shrink-0 text-fg3" strokeWidth={1.5} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2"><span className="truncate font-semibold">{repositoryName(root)}</span><Tag>{group.entries.length} 个 worktree</Tag></span>
        <span className="truncate font-mono text-xs text-fg3">{homeAbbreviated(root)}</span>
      </span>
      <span className="shrink-0 text-[12.5px] text-fg3">{relativeTime(latest.lastOpenedAtUnixMs)}</span>
    </button>
    {group.entries.map(entry => {
      const kind = kindOf(entry);
      return <button key={entry.worktreeId} type="button" disabled={disabled} title={entry.path} onClick={() => onOpen(entry.path)}
        className="flex min-h-11 w-full items-center gap-3 border-0 bg-transparent py-1.5 pr-4 pl-[52px] text-left text-[13px] hover:bg-hover disabled:hover:bg-transparent">
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="truncate font-medium">{entryName(entry)}</span>
          <Tag>{kind === "main" ? "主 worktree" : KIND_TAG[kind]}</Tag>
        </span>
        <span className="shrink-0 text-[12.5px] text-fg3">{relativeTime(entry.lastOpenedAtUnixMs)}</span>
      </button>;
    })}
  </div>;
}

/** Compact list for the repository switcher; leaves out the worktree that is already open. */
export function RecentList({ recent, currentWorktreeId, onOpen, disabled, limit = 8 }: {
  recent: RecentState;
  currentWorktreeId: string | null;
  onOpen(path: string): void;
  disabled?: boolean;
  limit?: number;
}): React.JSX.Element | null {
  const entries = recent.repositories
    .filter(entry => entry.worktreeId !== currentWorktreeId)
    .sort((a, b) => b.lastOpenedAtUnixMs - a.lastOpenedAtUnixMs)
    .slice(0, limit);
  if (!recent.loaded || (!entries.length && recent.status === "ok" && !recent.error)) return null;
  return <div className="flex flex-col gap-1">
    <span className="text-[11.5px] font-semibold text-fg3">最近打开</span>
    {entries.length ? <div className="-mx-2 flex max-h-[240px] flex-col overflow-auto">
      {entries.map(entry => {
        const kind = kindOf(entry);
        return <button key={entry.worktreeId} type="button" disabled={disabled} title={entry.path} onClick={() => onOpen(entry.path)}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover disabled:hover:bg-transparent">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2 text-[13px]"><span className="truncate font-medium">{entryName(entry)}</span>{KIND_TAG[kind] ? <Tag>{KIND_TAG[kind]}</Tag> : null}</span>
            <span className="truncate font-mono text-[11.5px] text-fg3">{homeAbbreviated(entry.worktreePath ?? entry.path)}</span>
          </span>
          <span className="shrink-0 text-xs text-fg3">{relativeTime(entry.lastOpenedAtUnixMs)}</span>
        </button>;
      })}
    </div> : null}
    <StoreNote recent={recent} />
  </div>;
}

export function storeStatusText(status: StoreStatus): string | null {
  switch (status) {
    case "ok": return null;
    case "disabled": return "未启用";
    case "unavailable": return "暂时无法读写";
    case "corrupt": return "文件已损坏，暂时不用";
  }
}

function StoreNote({ recent }: { recent: RecentState }): React.JSX.Element | null {
  const text = recent.error
    ? `最近打开记录读取失败：${recent.error}`
    : recent.status && storeStatusText(recent.status) ? `最近打开记录${storeStatusText(recent.status)}，不影响打开仓库。` : null;
  return text ? <p className="m-0 px-1 text-xs text-fg3">{text}</p> : null;
}
