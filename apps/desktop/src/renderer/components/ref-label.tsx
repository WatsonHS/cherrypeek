import * as React from "react";
import { labelTitle, type RefLabel, type RefLabelKind } from "../lib/ref-labels.js";
import { cn } from "../lib/utils.js";

// Icons follow docs/DESIGN.md section 8 (16 × 16 stroke icons).
function Icon({ children, size }: { children: React.ReactNode; size: number }): React.JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="shrink-0"
    style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }}>{children}</svg>;
}

const ICONS: Partial<Record<RefLabelKind, React.ReactNode>> = {
  head: <><circle cx={8} cy={8} r={5} /><circle cx={8} cy={8} r={1.5} style={{ fill: "currentColor" }} /></>,
  worktree: <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />,
  tag: <><path d="M2.5 2.5h5l6 6-5 5-6-6z" /><circle cx={5.5} cy={5.5} r={1} /></>,
  remote: <path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5z" />,
};

const REMOTE_ICON = ICONS.remote;

const KIND_CLASS: Record<RefLabelKind, string> = {
  head: "bg-accent-soft text-accent-fg font-semibold",
  worktree: "text-fg2 shadow-[inset_0_0_0_1px_var(--line2)]",
  branch: "bg-sunken text-fg2",
  tag: "bg-sunken text-fg2",
  remote: "bg-sunken text-fg3",
};

const SIZE_CLASS = {
  sm: "h-[18px] gap-1 rounded-[9px] px-1.5 text-[11px]",
  default: "h-[22px] gap-1 rounded-[11px] px-2 text-xs",
};

export function RefChip({ label, size = "sm", className }: { label: RefLabel; size?: "sm" | "default"; className?: string }): React.JSX.Element {
  const iconSize = size === "sm" ? 11 : 12;
  const icon = ICONS[label.kind];
  return <span data-testid="ref-label" data-ref-kind={label.kind} title={labelTitle(label)}
    className={cn("inline-flex min-w-0 items-center font-medium whitespace-nowrap", SIZE_CLASS[size], KIND_CLASS[label.kind], className)}>
    {icon ? <Icon size={iconSize}>{icon}</Icon> : null}
    <span className="sr-only">{label.description}{label.remotes.length ? `；${label.remotes.join("、")} 也指向这里` : ""}</span>
    <span aria-hidden="true" className="min-w-0 truncate">{label.text}</span>
    {label.remotes.length ? <span aria-hidden="true" className="flex shrink-0 opacity-70"><Icon size={iconSize}>{REMOTE_ICON}</Icon></span> : null}
  </span>;
}

/** Shows the first `limit` labels and folds the rest into a "+N" chip. */
export function RefChips({ labels, size = "sm", limit, chipClassName }: {
  labels: RefLabel[];
  size?: "sm" | "default";
  limit?: number;
  chipClassName?(index: number): string | undefined;
}): React.JSX.Element | null {
  if (!labels.length) return null;
  const shown = limit === undefined ? labels : labels.slice(0, limit);
  const hidden = labels.slice(shown.length);
  return <>
    {shown.map((label, index) => <RefChip key={label.key} label={label} size={size} className={chipClassName?.(index)} />)}
    {hidden.length ? <span data-testid="ref-label-overflow" title={hidden.map(labelTitle).join("\n")}
      className={cn("inline-flex shrink-0 items-center bg-sunken font-medium whitespace-nowrap text-fg3", SIZE_CLASS[size])}>
      <span aria-hidden="true">+{hidden.length}</span>
      <span className="sr-only">另有 {hidden.length} 个：{hidden.map(label => label.description).join("；")}</span>
    </span> : null}
  </>;
}
