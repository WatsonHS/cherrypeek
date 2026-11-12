import * as React from "react";
import { Ellipsis } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import { cn } from "../lib/utils.js";

export interface ActionMenuItem {
  key: string;
  label: string;
  onSelect(): void;
  disabled?: boolean;
}

/**
 * A compact "⋯" button with a small menu, shaped like the hand-off menu. Choosing an item closes
 * the menu first, then runs the item.
 */
export function ActionMenu({ label, menuLabel, items, triggerClassName, testId }: {
  /** Accessible name of the "⋯" button. */
  label: string;
  /** Accessible name of the menu. */
  menuLabel: string;
  items: ActionMenuItem[];
  triggerClassName?: string;
  testId?: string;
}): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  if (!items.length) return null;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" aria-label={label} title={label} data-testid={testId}
        className={cn("flex size-7 shrink-0 items-center justify-center rounded-[7px] text-fg2 hover:bg-hover hover:text-fg data-[state=open]:bg-hover", triggerClassName)}>
        <Ellipsis className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" className="w-[220px] p-1.5" data-testid={testId ? `${testId}-menu` : undefined}>
      <div role="menu" aria-label={menuLabel} className="flex flex-col">
        {items.map(item => <button key={item.key} type="button" role="menuitem" data-testid={testId ? `${testId}-${item.key}` : undefined}
          disabled={item.disabled}
          className="flex h-[30px] w-full items-center rounded-[7px] px-2.5 text-left text-[13px] text-fg outline-none hover:bg-hover focus-visible:bg-hover disabled:opacity-50 disabled:hover:bg-transparent"
          onClick={() => { setOpen(false); item.onSelect(); }}>{item.label}</button>)}
      </div>
    </PopoverContent>
  </Popover>;
}
