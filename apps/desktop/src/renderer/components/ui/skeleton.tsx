import * as React from "react";
import { cn } from "../../lib/utils.js";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return <div data-slot="skeleton" aria-hidden="true" className={cn("rounded bg-skel", className)} {...props} />;
}
