import * as React from "react";
import { cn } from "../lib/utils.js";

/*
 * Placeholders for areas whose backend is not implemented yet. The user allowed
 * showing them with sample content as long as they are clearly marked; every
 * placeholder names the PLAN task that will replace it. Never treat placeholder
 * content as real data or as acceptance evidence.
 */

export function PlaceholderTag({ task, className }: { task: string; className?: string }): React.JSX.Element {
  return <span className={cn("inline-flex h-[18px] shrink-0 items-center rounded-[5px] border border-dashed border-current px-1.5 text-[11px] font-medium whitespace-nowrap text-(--l2)", className)}>
    占位 · {task}
  </span>;
}

export function PlaceholderBox({ task, title, note, children, className }: {
  task: string;
  title: string;
  note: string;
  children?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return <section aria-label={`${title}（占位）`} data-placeholder={task}
    className={cn("flex flex-col gap-3 rounded-xl border border-dashed border-line2 p-4", className)}>
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-fg3">{title}</span>
      <PlaceholderTag task={task} />
    </div>
    <p className="m-0 text-xs text-fg3">{note}</p>
    {children ? <div className="opacity-80">{children}</div> : null}
  </section>;
}
