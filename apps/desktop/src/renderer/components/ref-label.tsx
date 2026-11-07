import * as React from "react";
import { homeAbbreviated } from "../lib/format.js";
import { labelTitle, type RefLabel, type RefLabelKind } from "../lib/ref-labels.js";
import { cn } from "../lib/utils.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

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

export function RefChip({ label, size = "sm", className, describe = true }: {
  label: RefLabel;
  size?: "sm" | "default";
  className?: string;
  /** Adds the full description for screen readers; off where the kind is already written next to the chip. */
  describe?: boolean;
}): React.JSX.Element {
  const iconSize = size === "sm" ? 11 : 12;
  const icon = ICONS[label.kind];
  return <span data-testid="ref-label" data-ref-kind={label.kind} title={labelTitle(label)}
    className={cn("inline-flex min-w-0 items-center font-medium whitespace-nowrap", SIZE_CLASS[size], KIND_CLASS[label.kind], className)}>
    {icon ? <Icon size={iconSize}>{icon}</Icon> : null}
    {describe ? <span className="sr-only">{label.description}{label.remotes.length ? `；${label.remotes.join("、")} 也指向这里` : ""}</span> : null}
    <span aria-hidden="true" className="min-w-0 truncate">{label.text}</span>
    {label.remotes.length ? <span aria-hidden="true" className="flex shrink-0 opacity-70"><Icon size={iconSize}>{REMOTE_ICON}</Icon></span> : null}
  </span>;
}

const OVERFLOW_CLASS = "inline-flex shrink-0 items-center bg-sunken font-medium whitespace-nowrap text-fg2";

// The row selects on click, and React events bubble out of portals: keep clicks and keys
// on the trigger and in the list from reaching the row.
const stop = (event: React.SyntheticEvent) => event.stopPropagation();

/**
 * Shows the first `limit` labels and a "+N" for the rest. Clicking opens the full list.
 * With `wholeGroup`, the labels and "+N" form one button, so every label's details
 * (full name, kind, folded remotes, worktree path) are one click away, not only on hover.
 */
export function RefChips({ labels, size = "sm", limit, chipClassName, wholeGroup = false }: {
  labels: RefLabel[];
  size?: "sm" | "default";
  limit?: number;
  chipClassName?(index: number): string | undefined;
  wholeGroup?: boolean;
}): React.JSX.Element | null {
  if (!labels.length) return null;
  const shown = limit === undefined ? labels : labels.slice(0, limit);
  const hidden = labels.slice(shown.length);
  const chips = shown.map((label, index) => <RefChip key={label.key} label={label} size={size} className={chipClassName?.(index)} />);
  const list = <PopoverContent align="end" className="w-[300px] p-1.5" data-testid="ref-label-list" onClick={stop} onKeyDown={stop}>
    <p className="m-0 px-2 pt-1 pb-1.5 text-[11.5px] font-semibold text-fg3">这个提交上的引用 · {labels.length}</p>
    <ul className="m-0 flex max-h-[320px] list-none flex-col overflow-auto p-0">
      {labels.map(label => <li key={label.key} className="flex flex-col gap-0.5 rounded-lg px-2 py-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <RefChip label={label} describe={false} className="max-w-[170px] shrink" />
          <span className="min-w-0 flex-1 truncate text-right text-xs text-fg3">{label.kindText}</span>
        </span>
        {label.remotes.length ? <span className="text-xs text-fg3">{label.remotes.join("、")} 也指向这里</span> : null}
        {label.path ? <span className="truncate font-mono text-[11px] text-fg3" title={label.path}>{homeAbbreviated(label.path)}</span> : null}
      </li>)}
    </ul>
  </PopoverContent>;

  if (wholeGroup) {
    return <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-testid="ref-label-trigger" onClick={stop} onKeyDown={stop}
          aria-label={`引用：${labels.map(label => label.text).join("、")}。查看详情`}
          className={cn("flex max-w-full min-w-0 cursor-pointer items-center justify-end gap-1 rounded-[11px] border-0 bg-transparent p-0 outline-none",
            "hover:shadow-[0_0_0_2px_var(--line2)] focus-visible:shadow-[0_0_0_2px_var(--accent)] data-[state=open]:shadow-[0_0_0_2px_var(--accent)]")}>
          {chips}
          {hidden.length ? <span data-testid="ref-label-overflow" className={cn(OVERFLOW_CLASS, SIZE_CLASS[size])}>+{hidden.length}</span> : null}
        </button>
      </PopoverTrigger>
      {list}
    </Popover>;
  }
  return <>
    {chips}
    {hidden.length ? <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-testid="ref-label-overflow" onClick={stop} onKeyDown={stop}
          aria-label={`另有 ${hidden.length} 个引用，查看全部 ${labels.length} 个`}
          className={cn(OVERFLOW_CLASS, "cursor-pointer border-0 hover:bg-hover hover:text-fg data-[state=open]:bg-accent-soft data-[state=open]:text-accent-fg", SIZE_CLASS[size])}>
          +{hidden.length}
        </button>
      </PopoverTrigger>
      {list}
    </Popover> : null}
  </>;
}
