import * as React from "react";
import { LoaderCircle } from "lucide-react";
import type { WorkspaceBadge } from "../lib/workspace-indicator.js";
import { cn } from "../lib/utils.js";

export type AppPage = "commits" | "files" | "workspace";

export const PAGE_SHORTCUTS: Record<AppPage, string> = { commits: "⌘1", files: "⌘2", workspace: "⌘3" };

const ICON = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** The commits page's icon; also on buttons that go there, so they read as "to the commits page". */
export function CommitsIcon({ className = "size-[15px]" }: { className?: string }): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true" className={`${className} shrink-0`} style={ICON}><circle cx={8} cy={8} r={2.5} /><path d="M1.5 8h4M10.5 8h4" /></svg>;
}

function FilesIcon(): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[15px] shrink-0" style={ICON}><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /></svg>;
}

function WorkspaceIcon(): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[15px] shrink-0" style={ICON}><path d="M4 1.75h5.5L12.5 4.75v9.5H4z" /><path d="M8.25 6v3M6.75 7.5h3M6.75 11h3" /></svg>;
}

function Badge({ badge }: { badge: WorkspaceBadge }): React.JSX.Element | null {
  if (badge.kind === "none") return null;
  if (badge.kind === "spinner") return <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin text-fg3 motion-reduce:animate-none" />;
  if (badge.kind === "ok") return <span aria-hidden="true" data-testid="workspace-badge" data-kind="ok" className="size-2 shrink-0 rounded-full bg-ok" />;
  return <span aria-hidden="true" data-testid="workspace-badge" data-kind={badge.kind} className={cn(
    "inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[9px] px-[5px] text-[11px] font-semibold tabular-nums",
    badge.kind === "warn" && "bg-warn-bg text-warn",
    badge.kind === "bad" && "bg-bad text-panel",
    badge.kind === "stale" && "text-warn shadow-[inset_0_0_0_1.5px_var(--warn-line)]",
    badge.kind === "muted" && "text-fg3 shadow-[inset_0_0_0_1px_var(--line2)]",
  )}>{badge.text}</span>;
}

/** Commits / files / workspace switch, right after the repository block in the top bar. */
export function PageSwitch({ page, onChange, workspace, workspaceBranch, filesAvailable = true }: {
  page: AppPage;
  onChange(page: AppPage): void;
  workspace: WorkspaceBadge;
  workspaceBranch: string | null;
  filesAvailable?: boolean;
}): React.JSX.Element {
  const item = (id: AppPage, label: string, icon: React.ReactNode, extra: React.ReactNode, options: { title: string; ariaLabel?: string; disabled?: boolean }) =>
    <button key={id} type="button" data-testid={`page-${id}`} aria-current={page === id ? "page" : undefined}
      aria-label={options.ariaLabel ?? label} title={options.title} disabled={options.disabled}
      onClick={() => onChange(id)}
      className={cn("page-switch-item flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3.5 text-[13.5px] font-medium whitespace-nowrap text-fg2 hover:text-fg disabled:text-fg3 disabled:opacity-55 disabled:hover:text-fg3",
        "aria-[current=page]:bg-panel aria-[current=page]:font-semibold aria-[current=page]:text-fg aria-[current=page]:shadow-[0_1px_2px_rgba(20,20,18,.08),0_0_0_1px_var(--line2)]")}>
      {icon}<span className="page-switch-label">{label}</span>{extra}
    </button>;
  return <nav aria-label="页面" data-testid="page-switch" className="page-switch mr-1.5 ml-0.5 flex shrink-0 gap-0.5 rounded-[10px] bg-sunken p-[3px]">
    {item("commits", "提交", <CommitsIcon />, null, { title: `提交（${PAGE_SHORTCUTS.commits}）`, ariaLabel: "提交页" })}
    {item("files", "文件", <FilesIcon />, null, { title: filesAvailable ? `文件（${PAGE_SHORTCUTS.files}）` : "这个仓库还没有提交，没有可浏览的文件", ariaLabel: "文件页", disabled: !filesAvailable })}
    {item("workspace", "工作区", <WorkspaceIcon />, <>
      {workspaceBranch ? <span className="page-switch-branch max-w-[120px] truncate font-medium text-fg3">· {workspaceBranch}</span> : null}
      <Badge badge={workspace} />
    </>, { title: workspace.title, ariaLabel: workspace.ariaLabel, disabled: workspace.disabled })}
  </nav>;
}
