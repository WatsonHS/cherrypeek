import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import type { HandoffRangeCommit, HandoffRequest } from "../lib/handoff-prompt.js";

interface MenuItem {
  key: string;
  label: string;
  hint: string;
  request: HandoffRequest;
}

/**
 * "交给 Agent ▾" on a commit: the tasks that make sense for it. Reading tasks first (review it,
 * explain a merge, review everything from here to the newest), then changes (revert, fix).
 */
export function CommitHandoffMenu({ oid, isMerge, toNewest, onOpenHandoff }: {
  oid: string;
  isMerge: boolean;
  /** Commits from the newest down to this one, newest first; null when it is the newest or not in the history list. */
  toNewest: { commits: HandoffRangeCommit[]; complete: boolean; oldestOid?: string; headTips?: string[] } | null;
  onOpenHandoff(request: HandoffRequest): void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const commit = { kind: "commit" as const, oid };
  const rangeLabel = toNewest
    ? toNewest.complete
      ? `审阅从这里到最新的 ${toNewest.commits.length} 个提交`
      : "审阅从这里到最新的全部提交"
    : "";
  const reading: MenuItem[] = [
    { key: "review", label: "审阅这个提交", hint: "列出问题和修改建议，不改代码", request: { scenario: "review", target: commit } },
    ...(isMerge ? [{ key: "explain-merge", label: "解释这个 merge 带入了什么", hint: "按父提交分组说明带入的改动", request: { scenario: "explain-merge" as const, target: commit } }] : []),
    ...(toNewest && (toNewest.commits.length > 1 || !toNewest.complete) ? [{
      key: "review-range",
      label: rangeLabel,
      hint: "先概括这批改动，再列出问题",
      request: {
        scenario: "review-range" as const,
        target: {
          kind: "commits" as const,
          commits: toNewest.commits,
          complete: toNewest.complete,
          reason: "toNewest" as const,
          ...(toNewest.oldestOid ? { oldestOid: toNewest.oldestOid } : {}),
          ...(toNewest.headTips?.length ? { headTips: toNewest.headTips } : {}),
        },
      },
    }] : []),
  ];
  const changing: MenuItem[] = [
    { key: "revert", label: "撤销这个提交", hint: "在本窗口的工作区 git revert，不 push", request: { scenario: "revert", target: commit } },
    { key: "fix", label: "修复这个提交引入的问题", hint: "补测试并修复，不 push", request: { scenario: "fix", target: commit } },
  ];
  const item = (entry: MenuItem) => <button key={entry.key} type="button" role="menuitem" data-testid={`handoff-menu-${entry.key}`}
    className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-hover focus-visible:bg-hover"
    onClick={() => { setOpen(false); onOpenHandoff(entry.request); }}>
    <span className="text-[13px] text-fg">{entry.label}</span>
    <span className="text-[11px] text-fg3">{entry.hint}</span>
  </button>;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button variant="soft" size="sm" data-testid="handoff-commit" className="gap-1">交给 Agent<ChevronDown className="size-3.5" strokeWidth={1.75} /></Button>
    </PopoverTrigger>
    <PopoverContent align="end" data-testid="handoff-menu" className="w-[272px] p-1.5">
      <div role="menu" aria-label="交给 Agent" className="flex flex-col">
        {reading.map(item)}
        <div className="mx-2.5 my-1 h-px bg-line" />
        {changing.map(item)}
      </div>
    </PopoverContent>
  </Popover>;
}
