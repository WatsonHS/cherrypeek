import * as React from "react";
import { Check } from "lucide-react";
import { Button } from "./ui/button.js";
import type { RefusalList } from "../lib/operation-refusal.js";

export type { RefusalList, RefusalListItem } from "../lib/operation-refusal.js";

export interface RefusalDialogProps {
  /** e.g. "无法更新 ui-density" */
  title: string;
  explanation: string;
  /** The reassurance line; defaults to saying nothing was run and the repository is untouched. */
  safeLine?: string;
  /** Lists shown side by side when there are two, otherwise stacked. */
  lists?: RefusalList[];
  /** A closing remark under the lists, e.g. files that do not conflict. */
  footnote?: string;
  onClose(): void;
  closeLabel?: string;
  focusClose?: boolean;
  /** A link under the lists: "在工作区页查看这些改动". */
  onOpenWorkspace?(): void;
  onOpenTerminal?(): void;
  discard?: { label: string; onSelect(): void };
  alternative?: { label: string; onSelect(): void };
  resolveDiverged?: { label: string; onSelect(): void };
  onHandoff?(): void;
}

/**
 * A basic operation (fast-forward update, switch branch) was refused before anything ran. States the
 * reason as facts, says the repository is untouched, and offers the terminal or a hand-off to an agent.
 * Fully driven by props; every string comes from the caller and is rendered as plain text.
 */
export function RefusalDialog({ title, explanation, safeLine = "没有执行任何操作，仓库未被改动", lists = [], footnote, onClose, closeLabel = "关闭", focusClose = false, onOpenWorkspace, onOpenTerminal, alternative, discard, resolveDiverged, onHandoff }: RefusalDialogProps): React.JSX.Element {
  const composingRef = React.useRef(false);
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && !composingRef.current) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" data-testid="refusal-backdrop">
    <section role="dialog" aria-modal="true" aria-labelledby="refusal-title" data-testid="refusal-dialog"
      className="flex max-h-[min(88vh,820px)] w-full max-w-[520px] flex-col gap-3 overflow-auto rounded-xl border border-line bg-panel p-5 shadow-xl">
      <h2 id="refusal-title" className="m-0 text-[17px] font-semibold break-words">{title}</h2>
      <p className="m-0 text-[13px] text-fg2">{explanation}</p>
      <div role="status" data-testid="refusal-safe" className="flex items-center gap-1.5 self-start rounded-lg bg-ok-bg px-2.5 py-1.5 text-[12.5px] font-medium text-ok">
        <Check className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />{safeLine}
      </div>
      {lists.length ? <div className="flex flex-col gap-2.5">
        {groupLists(lists).map(group => <div key={group.map(list => list.heading).join("|")} className={group.length === 2 ? "grid grid-cols-2 gap-2.5" : "flex flex-col gap-2.5"}>
          {group.map(list => <div key={list.heading} className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-bg px-3 py-2.5 text-[13px]" data-testid="refusal-list">
            <span className="text-xs text-fg3">{list.heading}</span>
            {list.items.map((item, index) => <div key={`${index}:${item.text}`} className="flex min-w-0 items-center gap-2">
              {item.tag ? <span className="shrink-0 rounded-full bg-hover px-2 py-px text-[11px] text-fg2">{item.tag}</span> : null}
              <span className={item.mono ? "min-w-0 truncate font-mono text-xs" : "min-w-0 truncate"} title={item.text}>{item.text}</span>
            </div>)}
            {list.more ? <span className="text-xs text-fg3">{list.more}</span> : null}
          </div>)}
        </div>)}
      </div> : null}
      {onOpenWorkspace ? <button type="button" onClick={onOpenWorkspace} data-testid="refusal-workspace"
        className="self-start text-[12.5px] text-accent-fg underline-offset-2 hover:underline">在工作区页查看这些改动</button> : null}
      {footnote ? <p className="m-0 text-xs text-fg3">{footnote}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" autoFocus={focusClose} onClick={onClose} data-testid="refusal-close">{closeLabel}</Button>
        {onOpenTerminal ? <Button variant="outline" onClick={onOpenTerminal} data-testid="refusal-terminal">在终端打开</Button> : null}
        {discard ? <Button variant="outline" className="text-bad hover:text-bad" onClick={discard.onSelect} data-testid="refusal-discard">{discard.label}</Button> : null}
        {alternative ? <Button variant="outline" onClick={alternative.onSelect} data-testid="refusal-alternative">{alternative.label}</Button> : null}
        {resolveDiverged ? <Button variant="soft" onClick={resolveDiverged.onSelect} data-testid="refusal-resolve-diverged">{resolveDiverged.label}</Button> : null}
        {onHandoff ? <Button onClick={onHandoff} data-testid="refusal-handoff">交给 Agent…</Button> : null}
      </div>
    </section>
  </div>;
}

/** Consecutive `half` lists share a row; every other list has a row of its own. */
function groupLists(lists: RefusalList[]): RefusalList[][] {
  const groups: RefusalList[][] = [];
  for (let index = 0; index < lists.length; index += 1) {
    const list = lists[index]!;
    const next = lists[index + 1];
    if (list.half && next?.half) { groups.push([list, next]); index += 1; } else groups.push([list]);
  }
  return groups;
}
