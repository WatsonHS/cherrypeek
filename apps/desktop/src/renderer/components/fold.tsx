import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

const TEXT_FOLD_CHARS = 1_200;

/**
 * Long text (a commit message body) folded to its first lines, with "展开全文（共 N 行）" and "收起".
 * It folds again whenever the text changes, e.g. for the next commit.
 */
export function FoldedText({ text, lines = 8, className, testId }: { text: string; lines?: number; className?: string; testId?: string }): React.JSX.Element {
  const all = React.useMemo(() => text.split("\n"), [text]);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => setOpen(false), [text]);
  const long = all.length > lines || text.length > TEXT_FOLD_CHARS;
  const head = all.slice(0, lines).join("\n");
  // Cut at a line break the toggle below says enough; a cut inside a line gets "…".
  const shown = !long || open ? text : head.length > TEXT_FOLD_CHARS ? `${head.slice(0, TEXT_FOLD_CHARS)}…` : head;
  return <div className="flex min-w-0 flex-col gap-1">
    <pre data-testid={testId} data-folded={long && !open ? "true" : undefined} className={className}>{shown}</pre>
    {long ? <button type="button" data-testid="text-fold-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}
      className="inline-flex items-center gap-1 self-start rounded-md px-1 text-xs font-medium text-accent-fg hover:bg-accent-soft">
      {open ? <>收起<ChevronUp className="size-3" strokeWidth={1.75} /></> : <>展开全文（共 {all.length} 行）<ChevronDown className="size-3" strokeWidth={1.75} /></>}
    </button> : null}
  </div>;
}

/** The items a folded list shows: the first `limit`, plus any later ones `keep` says must stay visible. */
export function foldItems<T>(items: readonly T[], limit: number, open: boolean, keep?: (item: T) => boolean): T[] {
  if (open || items.length <= limit) return [...items];
  return [...items.slice(0, limit), ...(keep ? items.slice(limit).filter(keep) : [])];
}

/** "还有 N 个文件" / "收起" under a folded list. */
export function FoldToggle({ hidden, open, noun, onToggle, testId = "list-fold-toggle", className = "" }: {
  hidden: number;
  open: boolean;
  noun: string;
  onToggle(): void;
  testId?: string;
  className?: string;
}): React.JSX.Element | null {
  if (!open && hidden <= 0) return null;
  return <button type="button" data-testid={testId} aria-expanded={open} onClick={onToggle}
    className={`inline-flex items-center gap-1 self-start rounded-md px-1 text-xs font-medium text-accent-fg hover:bg-accent-soft ${className}`}>
    {open ? <>收起<ChevronUp className="size-3" strokeWidth={1.75} /></> : <>还有 {hidden} 个{noun}<ChevronDown className="size-3" strokeWidth={1.75} /></>}
  </button>;
}
