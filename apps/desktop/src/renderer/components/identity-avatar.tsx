import * as React from "react";
import type { CommitIdentity } from "../../../../../packages/protocol/src/generated/server-message.js";
import { initials, paletteIndex } from "../lib/format.js";
import { cn } from "../lib/utils.js";

// Literal class strings so Tailwind can see every palette entry.
const PALETTE = [
  "bg-(--av0-bg) text-(--av0-fg)",
  "bg-(--av1-bg) text-(--av1-fg)",
  "bg-(--av2-bg) text-(--av2-fg)",
  "bg-(--av3-bg) text-(--av3-fg)",
  "bg-(--av4-bg) text-(--av4-fg)",
  "bg-(--av5-bg) text-(--av5-fg)",
  "bg-(--av6-bg) text-(--av6-fg)",
  "bg-(--av7-bg) text-(--av7-fg)",
];
const SIZES = { xs: "size-4 text-[8px]", sm: "size-[22px] text-[9px]", md: "size-8 text-[11px]" } as const;

export function IdentityAvatar({ identity, size = "xs", className }: {
  identity: Pick<CommitIdentity, "name" | "email">;
  size?: keyof typeof SIZES;
  className?: string;
}): React.JSX.Element {
  return <span aria-hidden="true" className={cn(
    "inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none",
    PALETTE[paletteIndex(identity)], SIZES[size], className,
  )}>{initials(identity.name)}</span>;
}
