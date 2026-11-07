import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent font-semibold text-panel hover:bg-accent/90",
        outline: "border border-line2 bg-panel text-fg2 hover:bg-hover hover:text-fg",
        ghost: "text-fg2 hover:bg-hover hover:text-fg",
        soft: "bg-accent-soft text-accent-fg hover:bg-accent-soft/80",
        link: "h-auto px-0 text-accent underline-offset-2 hover:underline",
      },
      size: {
        sm: "h-7 rounded-[7px] px-2.5 text-xs",
        default: "h-8 rounded-lg px-3 text-[13px]",
        lg: "h-10 rounded-[10px] px-[18px] text-sm",
        icon: "size-8 rounded-lg",
        "icon-sm": "size-7 rounded-[7px]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends React.ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps): React.JSX.Element {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp data-slot="button" type={asChild ? undefined : type ?? "button"} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
