import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "../../lib/utils.js";

export function Tabs(props: React.ComponentProps<typeof TabsPrimitive.Root>): React.JSX.Element {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />;
}

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>): React.JSX.Element {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn("flex gap-6 border-b border-line", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>): React.JSX.Element {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" className={cn(
    "-mb-px flex h-10 items-center gap-2 border-b-2 border-transparent px-0.5 text-sm font-medium text-fg3 outline-none hover:text-fg",
    "data-[state=active]:border-fg data-[state=active]:text-fg focus-visible:text-fg",
    className,
  )} {...props} />;
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>): React.JSX.Element {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("outline-none", className)} {...props} />;
}
