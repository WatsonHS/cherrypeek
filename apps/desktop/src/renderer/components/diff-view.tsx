import * as React from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { diffDisplay, type DiffDisplay } from "../lib/diff-display.js";
import { parseUnifiedPatch, splitRows, type DiffLine, type Segment, type SplitRow, type SplitSide } from "../lib/diff-model.js";
import { cn } from "../lib/utils.js";

export function useDiffDisplay(): DiffDisplay {
  return React.useSyncExternalStore(diffDisplay.subscribe, diffDisplay.getView);
}

function typingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName));
}

/** ⌥D layout, ⌥F range, ⌥Z wrap. Matched by `code`, because ⌥ changes `key` on macOS. Mounted once by the app. */
export function useDiffDisplayShortcuts(fullAvailable: boolean): void {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.isComposing || event.keyCode === 229 || typingTarget(event.target)) return;
      if (event.code === "KeyD") { event.preventDefault(); diffDisplay.toggleLayout(); }
      else if (event.code === "KeyZ") { event.preventDefault(); diffDisplay.toggleWrap(); }
      else if (event.code === "KeyF" && fullAvailable) { event.preventDefault(); diffDisplay.toggleScope(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [fullAvailable]);
}

const ICON = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function UnifiedIcon(): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[15px] shrink-0" style={ICON}><rect x={2} y={2.5} width={12} height={11} rx={1.5} /><path d="M4.5 6h7M4.5 8.5h7M4.5 11h4" /></svg>;
}

function SplitIcon(): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[15px] shrink-0" style={ICON}><rect x={2} y={2.5} width={12} height={11} rx={1.5} /><path d="M8 2.5v11M4 6h2.5M4 8.5h2.5M9.5 6h2.5M9.5 8.5h2.5" /></svg>;
}

const MENU_ITEM = "flex h-[30px] w-full cursor-default items-center gap-2 rounded-[7px] px-2 text-[13px] text-fg outline-none select-none data-[disabled]:text-fg3 data-[highlighted]:bg-hover";

function ItemCheck(): React.JSX.Element {
  return <span className="flex w-3.5 shrink-0 text-accent"><DropdownMenu.ItemIndicator><Check className="size-3.5" strokeWidth={2} /></DropdownMenu.ItemIndicator></span>;
}

/** One quiet button for layout, range and wrapping, so the diff header keeps few controls. */
export function DiffDisplayMenu({ fullAvailable, fullUnavailableReason }: { fullAvailable: boolean; fullUnavailableReason: string }): React.JSX.Element {
  const display = useDiffDisplay();
  const scope = fullAvailable ? display.scope : "changes";
  const layoutText = display.layout === "split" ? "左右" : "上下";
  const scopeText = scope === "full" ? "完整文件" : "只看改动";
  return <DropdownMenu.Root modal={false}>
    <DropdownMenu.Trigger asChild>
      <button type="button" data-testid="diff-display-trigger" aria-label={`显示方式：${layoutText}，${scopeText}${display.wrap ? "，自动换行" : ""}`} title="显示方式：排列、范围、自动换行"
        className="diff-display-trigger flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-[12.5px] whitespace-nowrap text-fg2 outline-none hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent data-[state=open]:bg-sunken data-[state=open]:text-fg">
        {display.layout === "split" ? <SplitIcon /> : <UnifiedIcon />}
        <span className="diff-display-label">{layoutText} · {scopeText}</span>
        <ChevronDown className="size-3 text-fg3" strokeWidth={1.75} />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="end" sideOffset={6} data-testid="diff-display-menu"
        className="z-50 flex w-[252px] flex-col gap-px rounded-xl border border-line bg-panel p-1.5 text-fg shadow-[0_12px_32px_rgba(20,20,18,.16),0_2px_6px_rgba(20,20,18,.06)] outline-none">
        <DropdownMenu.Label className="flex justify-between py-1.5 pr-2 pl-[30px] text-[11.5px] font-semibold text-fg3">排列<span className="font-normal">⌥D 切换</span></DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={display.layout} onValueChange={value => diffDisplay.update({ layout: value === "split" ? "split" : "unified" })}>
          <DropdownMenu.RadioItem value="unified" className={MENU_ITEM} data-testid="diff-layout-unified"><ItemCheck /><UnifiedIcon />上下合并</DropdownMenu.RadioItem>
          <DropdownMenu.RadioItem value="split" className={MENU_ITEM} data-testid="diff-layout-split"><ItemCheck /><SplitIcon />左右并排</DropdownMenu.RadioItem>
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator className="mx-1 my-[5px] h-px bg-line" />
        <DropdownMenu.Label className="flex justify-between py-1.5 pr-2 pl-[30px] text-[11.5px] font-semibold text-fg3">范围<span className="font-normal">⌥F 切换</span></DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={scope} onValueChange={value => diffDisplay.update({ scope: value === "full" ? "full" : "changes" })}>
          <DropdownMenu.RadioItem value="changes" className={MENU_ITEM}><ItemCheck />只看改动<span className="ml-auto text-[11.5px] text-fg3">前后各 3 行</span></DropdownMenu.RadioItem>
          <DropdownMenu.RadioItem value="full" className={MENU_ITEM} disabled={!fullAvailable} title={fullAvailable ? undefined : fullUnavailableReason}>
            <ItemCheck />完整文件<span className="ml-auto text-[11.5px] text-fg3">{fullAvailable ? "超过 5,000 行不可选" : "占位 · P4-11"}</span>
          </DropdownMenu.RadioItem>
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator className="mx-1 my-[5px] h-px bg-line" />
        <DropdownMenu.CheckboxItem checked={display.wrap} onCheckedChange={checked => diffDisplay.update({ wrap: checked === true })} className={MENU_ITEM} data-testid="diff-wrap">
          <ItemCheck />自动换行<span className="ml-auto text-[11.5px] text-fg3">⌥Z</span>
        </DropdownMenu.CheckboxItem>
        <p className="m-0 pt-1.5 pr-2 pb-1 pl-[30px] text-[11.5px] leading-[1.45] text-fg3">所有 diff 共用这里的选择，下次打开仍然有效</p>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

const NUMBER = "shrink-0 pr-2 text-right text-fg3 select-none";

/** A text diff with a change stepper and the display menu above it. */
export function DiffView({ patch, fullAvailable = false }: { patch: string; fullAvailable?: boolean }): React.JSX.Element {
  const display = useDiffDisplay();
  const parsed = React.useMemo(() => parseUnifiedPatch(patch), [patch]);
  const rows = React.useMemo(() => display.layout === "split" ? splitRows(parsed) : null, [parsed, display.layout]);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [current, setCurrent] = React.useState(0);
  React.useEffect(() => setCurrent(0), [patch]);
  const go = (next: number) => {
    const target = Math.max(0, Math.min(parsed.hunkCount - 1, next));
    setCurrent(target);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    rootRef.current?.querySelector(`[data-hunk-start="${target}"]`)?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  };
  return <div ref={rootRef} data-testid="diff-view" data-layout={display.layout} data-wrap={display.wrap ? "true" : "false"}>
    <div className="flex h-9 items-center gap-1 border-b border-line px-3">
      <div className="flex-1" />
      {parsed.hunkCount > 1 ? <>
        <span className="diff-hunk-count mr-0.5 text-xs text-fg3 tabular-nums" data-testid="diff-hunk-position">第 {current + 1} / {parsed.hunkCount} 处改动</span>
        <button type="button" aria-label="上一处改动" disabled={current === 0} onClick={() => go(current - 1)}
          className="flex size-[26px] items-center justify-center rounded-md text-fg2 hover:bg-hover disabled:text-fg3 disabled:opacity-50"><ChevronUp className="size-3.5" strokeWidth={1.75} /></button>
        <button type="button" aria-label="下一处改动" disabled={current >= parsed.hunkCount - 1} onClick={() => go(current + 1)}
          className="flex size-[26px] items-center justify-center rounded-md text-fg2 hover:bg-hover disabled:text-fg3 disabled:opacity-50"><ChevronDown className="size-3.5" strokeWidth={1.75} /></button>
      </> : null}
      <DiffDisplayMenu fullAvailable={fullAvailable} fullUnavailableReason="完整文件需要核心返回带全文上下文的 diff（占位 · P4-11）" />
    </div>
    {rows ? display.wrap ? <SplitWrapped rows={rows} /> : <SplitColumns rows={rows} /> : <Unified lines={parsed.lines} wrap={display.wrap} />}
  </div>;
}

function rowTone(kind: DiffLine["kind"] | SplitSide["kind"]): string {
  return kind === "add" ? "bg-add-bg" : kind === "del" ? "bg-del-bg" : kind === "hunk" ? "bg-hunk-bg text-fg3" : kind === "notice" ? "bg-warn-bg text-warn" : "";
}

function noticeText(text: string): string {
  return text === "\\ No newline at end of file" ? "文件末尾没有换行" : text.replace(/^\\ ?/u, "");
}

function Unified({ lines, wrap }: { lines: DiffLine[]; wrap: boolean }): React.JSX.Element {
  return <div className={cn("py-1 font-mono text-[12px] leading-[21px]", !wrap && "overflow-x-auto")} data-testid="diff-lines">
    {lines.map((line, index) => {
      const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "notice" ? "!" : "";
      return <div key={index} data-hunk-start={line.kind === "hunk" ? line.hunk : undefined}
        className={cn("flex min-h-[21px]", wrap ? "min-w-0" : "min-w-max whitespace-pre", rowTone(line.kind))}>
        <span className={cn(NUMBER, "w-12")}>{line.oldNumber ?? ""}</span>
        <span className={cn(NUMBER, "w-12")}>{line.newNumber ?? ""}</span>
        <span className={cn("w-5 shrink-0 text-center select-none", line.kind === "add" && "text-add", line.kind === "del" && "text-del")}>{sign}</span>
        <span className={cn("pr-5", wrap && "min-w-0 flex-1 break-all whitespace-pre-wrap")}>{line.kind === "notice" ? noticeText(line.text) : line.text}</span>
      </div>;
    })}
  </div>;
}

function SideText({ side }: { side: SplitSide }): React.JSX.Element {
  if (!side.segments) return <>{side.text}</>;
  return <>{side.segments.map((segment: Segment, index) => segment.changed
    ? <span key={index} className={cn("rounded-[2px]", side.kind === "del" ? "bg-[color-mix(in_srgb,var(--del)_16%,transparent)]" : "bg-[color-mix(in_srgb,var(--add)_16%,transparent)]")}>{segment.text}</span>
    : <React.Fragment key={index}>{segment.text}</React.Fragment>)}</>;
}

const EMPTY_SIDE = "bg-[repeating-linear-gradient(135deg,var(--sunken)_0_3px,transparent_3px_7px)]";

function SideCell({ side, wrap }: { side: SplitSide; wrap: boolean }): React.JSX.Element {
  const sign = side.kind === "add" ? "+" : side.kind === "del" ? "−" : "";
  return <div className={cn("flex min-h-[21px]", wrap ? "min-w-0" : "min-w-max whitespace-pre", side.kind === "empty" ? EMPTY_SIDE : rowTone(side.kind))}>
    <span className={cn(NUMBER, "w-[42px]", !wrap && "sticky left-0 z-[1]", !wrap && (side.kind === "add" ? "bg-add-bg" : side.kind === "del" ? "bg-del-bg" : side.kind === "empty" ? "bg-transparent" : "bg-bg"))}>{side.number ?? ""}</span>
    <span className={cn("w-3.5 shrink-0 text-center select-none", side.kind === "add" && "text-add", side.kind === "del" && "text-del")}>{sign}</span>
    <span className={cn("pr-3", wrap && "min-w-0 flex-1 break-all whitespace-pre-wrap")}><SideText side={side} /></span>
  </div>;
}

function FullRow({ row }: { row: Exclude<SplitRow, { kind: "pair" }> }): React.JSX.Element {
  return <div data-hunk-start={row.kind === "hunk" ? row.hunk : undefined} className={cn("px-3 whitespace-pre-wrap break-all", rowTone(row.kind), row.kind === "meta" && "text-fg3")}>
    {row.kind === "notice" ? noticeText(row.text) : row.text}
  </div>;
}

/** Wrapped side-by-side: one grid, so a long line on either side keeps both rows the same height. */
function SplitWrapped({ rows }: { rows: SplitRow[] }): React.JSX.Element {
  return <div className="py-1 font-mono text-[12px] leading-[21px]" data-testid="diff-split">
    {rows.map((row, index) => row.kind === "pair"
      ? <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SideCell side={row.left} wrap />
        <div className="border-l border-line"><SideCell side={row.right} wrap /></div>
      </div>
      : <FullRow key={index} row={row} />)}
  </div>;
}

/** Unwrapped side-by-side: every row has the same height, so each side can scroll sideways on its own. */
function SplitColumns({ rows }: { rows: SplitRow[] }): React.JSX.Element {
  const column = (side: "left" | "right") => <div className={cn("min-w-0 overflow-x-auto py-1", side === "right" && "border-l border-line")}>
    {rows.map((row, index) => row.kind === "pair"
      ? <SideCell key={index} side={row[side]} wrap={false} />
      : <div key={index} data-hunk-start={side === "left" && row.kind === "hunk" ? row.hunk : undefined}
        className={cn("min-w-max px-3 whitespace-pre", rowTone(row.kind), row.kind === "meta" && "text-fg3")}>
        {side === "left" ? row.kind === "notice" ? noticeText(row.text) : row.text : " "}
      </div>)}
  </div>;
  return <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] font-mono text-[12px] leading-[21px]" data-testid="diff-split">
    {column("left")}{column("right")}
  </div>;
}
