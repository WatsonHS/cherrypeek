import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

// Reference tags from docs/DESIGN.md section 5 (.tag and its data-k variants).
const badgeVariants = cva("inline-flex min-w-0 items-center gap-1 whitespace-nowrap font-medium [&_svg]:shrink-0", {
  variants: {
    variant: {
      default: "bg-sunken text-fg2",
      browse: "bg-accent-soft text-accent-fg",
      head: "bg-fg text-panel",
      ok: "bg-ok-bg text-ok",
      outline: "text-fg2 shadow-[inset_0_0_0_1px_var(--line2)]",
      warn: "bg-warn-bg text-warn",
    },
    size: {
      default: "h-[22px] rounded-[11px] px-2 text-xs",
      sm: "h-[18px] rounded-[9px] px-1.5 text-[11px]",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export interface BadgeProps extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps): React.JSX.Element {
  return <span data-slot="badge" className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}
