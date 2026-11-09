import * as React from "react";
import { Dialog } from "radix-ui";
import { Search } from "lucide-react";
import { paletteItems, type PaletteAction, type PaletteContext } from "../lib/command-palette.js";
import { cn } from "../lib/utils.js";

export const OPEN_COMMAND_PALETTE = "commitscope:open-command-palette";

export function CommandPalette({ context, sessionKey, loading, error, onLoadNavigation, onExecute }: {
  context: PaletteContext;
  sessionKey: string | null;
  loading: boolean;
  error?: string;
  onLoadNavigation(): void;
  onExecute(action: PaletteAction): void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const previousSession = React.useRef(sessionKey);
  React.useEffect(() => {
    if (previousSession.current !== sessionKey) setOpen(false);
    previousSession.current = sessionKey;
  }, [sessionKey]);
  React.useEffect(() => {
    const show = () => { returnFocus.current = document.activeElement as HTMLElement | null; setOpen(true); };
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey) return;
      if ((event.metaKey || event.ctrlKey) && event.code === "KeyK") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(value => {
          if (!value) returnFocus.current = document.activeElement as HTMLElement | null;
          return !value;
        });
      }
    };
    window.addEventListener(OPEN_COMMAND_PALETTE, show);
    document.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener(OPEN_COMMAND_PALETTE, show); document.removeEventListener("keydown", onKey, true); };
  }, []);
  const loadRef = React.useRef(onLoadNavigation);
  loadRef.current = onLoadNavigation;
  React.useEffect(() => { if (open) loadRef.current(); }, [open]);
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    {open ? <PaletteContents context={context} loading={loading} error={error} onClose={() => setOpen(false)}
      onRestoreFocus={() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); }}
      onExecute={action => { setOpen(false); onExecute(action); }} /> : null}
  </Dialog.Root>;
}

function PaletteContents({ context, loading, error, onClose, onRestoreFocus, onExecute }: {
  context: PaletteContext; loading: boolean; error?: string; onClose(): void; onRestoreFocus(): void; onExecute(action: PaletteAction): void;
}): React.JSX.Element {
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const composing = React.useRef(false);
  const list = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  const modifier = /Mac|iPhone|iPad/u.test(navigator.platform) ? "⌘" : "Ctrl+";
  const result = React.useMemo(() => paletteItems(query, context, modifier), [query, context, modifier]);
  const selected = Math.min(active, Math.max(0, result.items.length - 1));
  React.useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [selected, query]);
  return <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--scrim)]" />
    <Dialog.Content aria-describedby={undefined} onKeyDown={event => event.stopPropagation()}
      onCloseAutoFocus={event => { event.preventDefault(); onRestoreFocus(); }} onEscapeKeyDown={event => {
      if (composing.current || event.isComposing || event.keyCode === 229) event.preventDefault();
    }} className="fixed top-[18vh] left-1/2 z-50 flex max-h-[70vh] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line bg-panel text-fg shadow-[0_24px_60px_rgba(20,20,18,.24)]">
      <Dialog.Title className="sr-only">快速跳转</Dialog.Title>
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search className="size-4 shrink-0 text-fg3" />
        <input autoFocus role="combobox" aria-label="搜索命令或跳转目标" aria-expanded="true" aria-controls={`${id}-list`}
          aria-autocomplete="list" aria-activedescendant={result.items.length ? `${id}-${selected}` : undefined}
          value={query} placeholder="提交 hash、分支、标签、worktree 或命令…"
          className="h-14 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-fg3"
          onChange={event => { setQuery(event.target.value); setActive(0); }}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive(result.items.length ? (selected + (event.key === "ArrowDown" ? 1 : -1) + result.items.length) % result.items.length : 0);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const item = result.items[selected];
              if (item) onExecute(item.action);
            }
          }} />
        <button type="button" aria-label="关闭快速跳转" onClick={onClose} className="rounded border border-line2 px-1.5 py-0.5 text-xs text-fg3">Esc</button>
      </div>
      <div ref={list} id={`${id}-list`} role="listbox" aria-label="跳转结果" className="min-h-0 overflow-auto overscroll-contain p-2">
        {result.items.map((item, index) => <React.Fragment key={item.id}>
          {index === 0 || result.items[index - 1]?.group !== item.group ? <div role="presentation" className="px-2 pt-3 pb-1.5 text-[11px] font-semibold text-fg3">{item.group}</div> : null}
          <button id={`${id}-${index}`} type="button" role="option" aria-selected={selected === index} tabIndex={-1}
            className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px]", selected === index ? "bg-accent-soft text-accent-fg" : "text-fg2 hover:bg-hover")}
            onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()}
            onClick={() => { if (!composing.current) onExecute(item.action); }}>
            <span className="min-w-0 flex-1"><span className="block truncate"><Match text={item.label} query={query} /></span>
              {item.detail ? <span className="mt-0.5 block truncate text-xs text-fg3"><Match text={item.detail} query={query} /></span> : null}</span>
            {item.shortcut ? <kbd className="shrink-0 rounded border border-line2 bg-sunken px-1.5 py-0.5 text-xs text-fg3">{item.shortcut}</kbd> : null}
          </button>
        </React.Fragment>)}
        {!result.items.length ? <p className="px-3 py-6 text-center text-sm text-fg3">{query ? "没有匹配的结果" : "核心正在启动…"}</p> : null}
      </div>
      {loading || error ? <p role="status" className="m-0 px-4 py-2 text-xs text-fg3">{loading ? "正在读取分支与 worktree…" : error}</p> : null}
      <div className="flex justify-between gap-2 border-t border-line px-4 py-2.5 text-xs text-fg3">
        <span>↑↓ 选择 · ↵ 打开 · Esc 关闭</span>
        {result.total > result.items.length ? <span>继续输入以缩小范围</span> : null}
      </div>
    </Dialog.Content>
  </Dialog.Portal>;
}

function Match({ text, query }: { text: string; query: string }): React.JSX.Element {
  const needle = query.trim();
  const index = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  return index < 0 ? <>{text}</> : <>{text.slice(0, index)}<mark className="bg-transparent font-semibold text-accent-fg">{text.slice(index, index + needle.length)}</mark>{text.slice(index + needle.length)}</>;
}
