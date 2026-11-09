import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/** Columns a line takes in a monospace sense: CJK and full-width characters count twice. */
function displayWidth(line: string): number {
  let width = 0;
  for (const char of line) width += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u.test(char) ? 2 : 1;
  return width;
}

/** A line this long was most likely broken by the author's ~72-column wrapping, not on purpose. */
const WRAPPED_LINE_WIDTH = 50;

/**
 * A commit message body for a narrow pane: a line long enough to be the author's ~72-column wrapping is joined with the
 * next one, so the pane does not show ragged half-empty lines. Short lines (a list of files under "改动：", deliberate
 * breaks), blank lines, lists, quotes and indented code keep their breaks exactly.
 */
export function reflowMessage(text: string): string {
  return text.split(/\n[ \t]*\n/u).map(paragraph => {
    const lines = paragraph.split("\n");
    if (lines.some(line => /^\s*([-*+•]|\d+[.)]|>|```)(\s|$)/u.test(line) || /^(\t| {2,})\S/u.test(line))) return paragraph;
    let joined = lines[0] ?? "";
    for (let index = 1; index < lines.length; index += 1) {
      const previous = lines[index - 1]!;
      const line = lines[index]!;
      if (displayWidth(previous.trimEnd()) < WRAPPED_LINE_WIDTH || !line.trim()) { joined += `\n${line}`; continue; }
      // No space between two CJK characters, as Chinese text is written without spaces.
      const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。；：！？、）]$/u.test(joined.trimEnd()) && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}（]/u.test(line.trim());
      joined = `${joined.trimEnd()}${cjk ? "" : " "}${line.trim()}`;
    }
    return joined;
  }).join("\n\n");
}

/**
 * Long text (a commit message body) reflowed and folded to the height of its first lines, with "展开全文（共 N 行）"
 * (N counts the original lines) and "收起". It folds again whenever the text changes, e.g. for the next commit.
 */
export function FoldedText({ text, lines = 8, className, testId }: { text: string; lines?: number; className?: string; testId?: string }): React.JSX.Element {
  const shown = React.useMemo(() => reflowMessage(text), [text]);
  const total = React.useMemo(() => text.split("\n").length, [text]);
  const [open, setOpen] = React.useState(false);
  const [foldable, setFoldable] = React.useState(false);
  const ref = React.useRef<HTMLPreElement>(null);
  React.useEffect(() => setOpen(false), [text]);
  // Folded by height, so a long paragraph counts for the lines it takes on screen; measured again when the pane resizes.
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open) return;
    const measure = () => setFoldable(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown, open]);
  return <div className="flex min-w-0 flex-col gap-1">
    <pre ref={ref} data-testid={testId} data-folded={foldable && !open ? "true" : undefined} className={className}
      style={open ? undefined : { maxHeight: `${lines * 1.625}em`, overflow: "hidden" }}>{shown}</pre>
    {foldable ? <button type="button" data-testid="text-fold-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}
      className="inline-flex items-center gap-1 self-start rounded-md px-1 text-xs font-medium text-accent-fg hover:bg-accent-soft">
      {open ? <>收起<ChevronUp className="size-3" strokeWidth={1.75} /></> : <>展开全文（共 {total} 行）<ChevronDown className="size-3" strokeWidth={1.75} /></>}
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
