import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "../../lib/utils.js";

export function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>): React.JSX.Element {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

export function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>): React.JSX.Element {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

export function PopoverContent({ className, align = "start", sideOffset = 6, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>): React.JSX.Element {
  return <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content data-slot="popover-content" align={align} sideOffset={sideOffset} className={cn(
      "z-50 rounded-xl border border-line2 bg-panel text-[13px] text-fg shadow-pop outline-none",
      className,
    )} {...props} />
  </PopoverPrimitive.Portal>;
}
