import * as React from "react";
import { cn } from "../../lib/utils.js";

export function Input({ className, type = "text", ...props }: React.ComponentProps<"input">): React.JSX.Element {
  return <input data-slot="input" type={type} className={cn(
    "h-9 w-full min-w-0 rounded-lg border border-line2 bg-bg px-3 text-[13px] text-fg outline-none placeholder:text-fg3",
    "focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] focus-visible:outline-none disabled:opacity-50",
    className,
  )} {...props} />;
}
