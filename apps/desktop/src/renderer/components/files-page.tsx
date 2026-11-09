import * as React from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Clock, Copy, FileText, Folder, FolderOpen, Layers, Link2, LoaderCircle, Pin, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { BlameBlock, CommitIdentity, FileHistoryEntry, GitPath, TreeEntry } from "../../../../../packages/protocol/src/generated/server-message.js";
import { momentLabel, parseGitTime, shortOid } from "../lib/format.js";
import { blameHeat, blameLineIndex, type FilesSelection, type FilesView, type TreeVersion } from "../lib/files-store.js";
import { cn } from "../lib/utils.js";
import { DiffView, useDiffDisplay } from "./diff-view.js";
import { SyntaxLine } from "./syntax-text.js";
import { languageForPath } from "../lib/syntax/languages.js";
import { useSyntaxLines } from "../lib/syntax/highlight.js";
import { IdentityAvatar } from "./identity-avatar.js";
import { PlaceholderBox } from "./placeholder.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

export interface FilesActions {
  toggleDirectory(pathHex: string): void;
  /** Expands a directory and its parents in the tree; the right side stays as it is. */
  revealDirectory(path: GitPath): void;
  loadMoreEntries(pathHex: string): void;
  retryDirectory(pathHex: string): void;
  select(selection: FilesSelection): void;
  setTab(tab: "content" | "history"): void;
  setBlame(enabled: boolean): void;
  locateFromBlame(line: number): void;
  returnToLine(): number | null;
  selectCommit(oid: string): void;
  setParentIndex(parentIndex: number | null): void;
  loadMoreHistory(): void;
  retryHistory(): void;
  retryContent(): void;
  setVersion(version: TreeVersion): void;
  openCommit(oid: string): void;
}

export interface VersionOption {
  id: string;
  version: TreeVersion;
  group: string;
  hint?: string;
}

const HEAT = [3, 8, 14, 21, 30];

/** Fits the 68px date column: time for today and yesterday, month and day this year, otherwise the year too. */
function blameDate(unixMs: number, now = new Date()): string {
  const date = new Date(unixMs);
  const label = momentLabel(unixMs, now);
  if (label.startsWith("今天") || label.startsWith("昨天")) return label;
  return date.getFullYear() === now.getFullYear() ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

type BlameWidths = { date: number; author: number };
const BLAME_AUTHOR_MAX = 180;

/**
 * Widths of the blame gutter's date and author columns, sized to the longest text like JetBrains'
 * annotations rather than a fixed band; very long author names are cut at BLAME_AUTHOR_MAX.
 * Measured with hidden spans in the gutter's own font: canvas picks different fallbacks for CJK text.
 */
function blameWidths(commits: Record<string, { authorName: string; authorTime: number }>): BlameWidths {
  const dates = new Set<string>();
  const authors = new Set<string>();
  for (const commit of Object.values(commits)) {
    dates.add(blameDate(commit.authorTime * 1000));
    authors.add(commit.authorName);
  }
  const host = document.createElement("div");
  host.className = "font-sans text-xs";
  host.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden;white-space:nowrap";
  const spans = (texts: Set<string>, className: string) => [...texts].map(text => {
    const span = document.createElement("span");
    span.className = className;
    span.style.display = "inline-block";
    span.textContent = text;
    host.append(span);
    return span;
  });
  const dateSpans = spans(dates, "tabular-nums");
  const authorSpans = spans(authors, "");
  document.body.append(host);
  const widest = (list: HTMLSpanElement[]) => Math.ceil(list.reduce((max, span) => Math.max(max, span.getBoundingClientRect().width), 0));
  const widths = { date: widest(dateSpans) + 1, author: Math.min(widest(authorSpans) + 1, BLAME_AUTHOR_MAX) };
  host.remove();
  return widths;
}

function when(identity: CommitIdentity): string {
  const date = parseGitTime(identity.timestamp);
  return date ? momentLabel(date.valueOf()) : "";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}

/** Path components of a raw path, with the raw hex of each prefix so a crumb can open that directory. */
function crumbs(path: GitPath): { name: string; pathHex: string }[] {
  const names = path.display.split("/");
  const raw = path.rawHex.toLowerCase();
  const result: { name: string; pathHex: string }[] = [];
  let offset = 0;
  for (const name of names) {
    const next = raw.indexOf("2f", offset);
    // Hex offsets are always even; skip a "2f" that straddles two bytes.
    let end = next;
    while (end !== -1 && end % 2 !== 0) end = raw.indexOf("2f", end + 1);
    const pathHex = end === -1 ? raw : raw.slice(0, end);
    result.push({ name, pathHex });
    if (end === -1) break;
    offset = end + 2;
  }
  return result;
}

/** The files page: tree on the left, the selected file's content or history on the right (P4-10 to P4-12). */
export function FilesPage({ view, actions, versionOptions, find, onFindCount }: {
  view: FilesView;
  actions: FilesActions;
  versionOptions: VersionOption[];
  find: { query: string; current: number };
  onFindCount(count: number): void;
}): React.JSX.Element {
  const [scrollTarget, setScrollTarget] = React.useState<number | null>(null);
  if (!view.supported) {
    return <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-panel p-8" data-testid="files-page">
      <PlaceholderBox task="P4-10" title="文件页" className="max-w-[520px]"
        note="目录树、文件内容和文件历史需要核心按提交读取目录与文件（P4-10 后端，尚未接入）。这里不显示示例文件。" />
    </div>;
  }
  const selection = view.selection;
  const historyCount = view.history?.state === "ready" ? `${view.history.entries.length}${view.history.nextCursor ? "+" : ""}` : null;
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="files-page">
    <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-line pr-4 pl-2.5">
      <VersionBlock version={view.version} options={versionOptions} onChoose={actions.setVersion} />
      <span aria-hidden="true" className="mx-1 h-6 w-px bg-line" />
      <nav aria-label="路径" className="flex min-w-0 flex-wrap items-center">
        {selection ? crumbs(selection.path).map((crumb, index, all) => {
          const last = index === all.length - 1;
          return <React.Fragment key={crumb.pathHex}>
            {last ? <span aria-current="page" className="px-1 text-[13px] font-semibold">{crumb.name}</span>
              : <button type="button" className="rounded px-1 text-[13px] text-fg2 hover:bg-hover hover:text-fg" title="在目录树中显示" data-testid="crumb-directory"
                // Clicking a folder only browses: it is shown in the tree, and the right side keeps what it shows.
                // Directory history has its own explicit button on the tree row.
                onClick={() => {
                  actions.revealDirectory({ display: all.slice(0, index + 1).map(item => item.name).join("/"), rawHex: crumb.pathHex, textLossy: selection.path.textLossy });
                  requestAnimationFrame(() => {
                    const row = document.querySelector<HTMLElement>(`[data-testid='tree-row'][data-path-hex='${crumb.pathHex}']`);
                    row?.scrollIntoView({ block: "nearest" });
                    row?.focus({ preventScroll: true });
                  });
                }}>{crumb.name}</button>}
            {last ? null : <span aria-hidden="true" className="text-line2">/</span>}
          </React.Fragment>;
        }) : <span className="px-1 text-[13px] text-fg3">选择左侧的文件或目录</span>}
        {selection?.kind === "file" && view.content?.value && view.content.value.path.rawHex === selection.path.rawHex ? <span className="pl-1 text-xs whitespace-nowrap text-fg3">
          {view.content.value.totalLines !== null ? `${view.content.value.totalLines.toLocaleString()} 行` : ""}
          {view.content.value.size !== null ? `${view.content.value.totalLines !== null ? " · " : ""}${formatBytes(view.content.value.size)}` : ""}
        </span> : null}
      </nav>
      {selection ? <button type="button" aria-label="复制路径" title="复制路径" onClick={() => { void window.commitScope.copyText(selection.path.display); }}
        className="flex size-7 shrink-0 items-center justify-center rounded-[7px] text-fg3 hover:bg-hover hover:text-fg"><Copy className="size-[13px]" strokeWidth={1.75} /></button> : null}
      <div className="flex-1" />
      {selection?.kind === "file" && view.tab === "content" ? <button type="button" aria-pressed={view.blameEnabled} data-testid="blame-toggle"
        disabled={!view.blameSupported} onClick={() => actions.setBlame(!view.blameEnabled)}
        title={view.blameSupported ? "逐行追溯：显示每一行最后由哪个提交修改（git blame，⌥B）" : "逐行追溯需要核心支持（占位 · P4-12）"}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] px-[9px] text-[12.5px] whitespace-nowrap text-fg3 hover:bg-hover hover:text-fg disabled:opacity-50 aria-pressed:bg-accent-soft aria-pressed:font-medium aria-pressed:text-accent-fg">
        <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }}><path d="M2.5 3v10M5 4.5h8.5M5 8h6M5 11.5h7.5" /></svg>
        逐行追溯{view.blameSupported ? null : <span className="text-[11px]">· 占位</span>}
      </button> : null}
      {selection?.kind === "file" && view.tab === "history" && view.focus ? <button type="button" onClick={() => setScrollTarget(actions.returnToLine())} data-testid="return-to-line"
        title="回到内容页里你点的那一行"
        className="flex h-7 shrink-0 items-center gap-1 rounded-[7px] bg-accent-soft pr-2.5 pl-1.5 text-[12.5px] font-medium whitespace-nowrap text-accent-fg hover:brightness-95">
        <ArrowLeft className="size-3.5" strokeWidth={1.75} />回到第 {view.focus.line} 行</button> : null}
      {selection ? <nav aria-label="文件页" className="flex shrink-0 gap-0.5 rounded-[9px] bg-sunken p-[3px]">
        {selection.kind === "file" ? <button type="button" aria-current={view.tab === "content" ? "page" : undefined} onClick={() => actions.setTab("content")} data-testid="files-tab-content"
          className="flex h-[26px] items-center rounded-[7px] px-3 text-[13px] text-fg2 aria-[current=page]:bg-panel aria-[current=page]:font-semibold aria-[current=page]:text-fg aria-[current=page]:shadow-[0_0_0_1px_var(--line2)]">内容</button> : null}
        <button type="button" aria-current={view.tab === "history" ? "page" : undefined} onClick={() => actions.setTab("history")} data-testid="files-tab-history"
          className="flex h-[26px] items-center gap-1.5 rounded-[7px] px-3 text-[13px] text-fg2 aria-[current=page]:bg-panel aria-[current=page]:font-semibold aria-[current=page]:text-fg aria-[current=page]:shadow-[0_0_0_1px_var(--line2)]">
          历史{historyCount ? <span className="text-[11.5px] font-normal text-fg3">{historyCount}</span> : null}
        </button>
      </nav> : null}
    </div>
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <TreeColumn view={view} actions={actions} />
      <main aria-label={selection ? `${selection.path.display}` : "文件"} className="flex min-h-0 min-w-0 flex-[999_1_560px] flex-col overflow-hidden bg-panel">
        {!selection ? <p className="m-auto text-[13px] text-fg3">在左侧选择文件查看内容，选择目录查看它的改动历史。</p>
          : view.tab === "content" && selection.kind === "file"
            ? <ContentPane view={view} actions={actions} find={find} onFindCount={onFindCount} scrollTarget={scrollTarget} onScrolled={() => setScrollTarget(null)} />
            : <HistoryPane view={view} actions={actions} />}
      </main>
    </div>
  </div>;
}

function VersionBlock({ version, options, onChoose }: { version: TreeVersion | null; options: VersionOption[]; onChoose(version: TreeVersion): void }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const groups = [...new Set(options.map(option => option.group))];
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" data-testid="tree-version" aria-label={version ? `目录树版本：${version.label} ${shortOid(version.commit)}。更换版本` : "选择目录树版本"}
        title="已提交的快照，不含工作区改动；看其他版本不会 checkout"
        className="flex h-10 min-w-0 shrink flex-col items-start justify-center rounded-lg px-2.5 text-left hover:bg-hover">
        <span className="text-[10.5px] leading-[13px] text-fg3">目录树版本</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-5 font-semibold">
          <Layers className="size-3.5 shrink-0 text-accent" strokeWidth={1.75} />
          <span className="truncate">{version?.label ?? "未选择"}</span>
          {version ? <span className="font-mono text-xs font-normal text-fg3">{shortOid(version.commit)}</span> : null}
          <ChevronDown className="size-3.5 text-fg3" strokeWidth={1.75} />
        </span>
      </button>
    </PopoverTrigger>
    <PopoverContent className="flex max-h-(--radix-popover-content-available-height) w-[360px] flex-col p-0">
      <div className="border-b border-line px-4 py-3"><span className="font-semibold">目录树版本</span>
        <p className="m-0 mt-1 text-xs text-fg3">选一个提交的快照来浏览文件和历史；只读，不会 checkout。</p></div>
      <div className="min-h-0 overflow-auto p-2">
        {groups.map(group => <div key={group} className="flex flex-col gap-px py-1">
          <span className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-semibold text-fg3">{group}</span>
          {options.filter(option => option.group === group).map(option => <button key={option.id} type="button"
            aria-current={option.version.commit === version?.commit && option.version.label === version.label ? "true" : undefined}
            onClick={() => { setOpen(false); onChoose(option.version); }}
            className="flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-left text-[13px] hover:bg-hover aria-[current=true]:bg-accent-soft aria-[current=true]:text-accent-fg">
            <span className="min-w-0 flex-1 truncate">{option.version.label}</span>
            {option.hint ? <span className="text-[11px] text-fg3">{option.hint}</span> : null}
            <code className="font-mono text-xs text-fg3">{shortOid(option.version.commit)}</code>
          </button>)}
        </div>)}
      </div>
    </PopoverContent>
  </Popover>;
}

function TreeColumn({ view, actions }: { view: FilesView; actions: FilesActions }): React.JSX.Element {
  return <nav aria-label="目录树" data-testid="file-tree" className="flex min-h-0 min-w-[270px] flex-[0_1_290px] flex-col overflow-auto border-r border-line px-1.5 pt-1.5 pb-6">
    {view.version ? <Directory pathHex="" depth={0} view={view} actions={actions} /> : <p className="m-0 px-2.5 py-3 text-xs text-fg3">先选择目录树版本。</p>}
  </nav>;
}

function Directory({ pathHex, depth, view, actions }: { pathHex: string; depth: number; view: FilesView; actions: FilesActions }): React.JSX.Element | null {
  const directory = view.directories[pathHex];
  const indent = { paddingLeft: `${8 + depth * 14}px` };
  if (!directory) return null;
  return <div role="group">
    {directory.entries.map(entry => <TreeRow key={entry.path.rawHex} entry={entry} depth={depth} view={view} actions={actions} />)}
    {directory.state === "loading" ? <p role="status" className="m-0 flex h-7 items-center gap-1.5 text-xs text-fg3" style={indent}><LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />读取中…</p> : null}
    {directory.state === "error" ? <p role="alert" className="m-0 flex h-7 items-center gap-2 text-xs text-bad" style={indent}>{directory.error}<button type="button" className="underline" onClick={() => actions.retryDirectory(pathHex)}>重试</button></p> : null}
    {directory.state === "ready" && directory.hasMore ? <button type="button" className="flex h-7 items-center text-xs text-accent-fg hover:underline" style={indent}
      onClick={() => actions.loadMoreEntries(pathHex)}>再显示 {Math.min(500, directory.total - directory.entries.length)} 项（共 {directory.total.toLocaleString()} 项）</button> : null}
    {directory.state === "ready" && directory.entries.length === 0 ? <p className="m-0 h-7 text-xs leading-7 text-fg3" style={indent}>空目录</p> : null}
  </div>;
}

function TreeRow({ entry, depth, view, actions }: { entry: TreeEntry; depth: number; view: FilesView; actions: FilesActions }): React.JSX.Element {
  const isDirectory = entry.kind === "directory";
  const expanded = Boolean(view.expanded[entry.path.rawHex]);
  const selected = view.selection?.path.rawHex === entry.path.rawHex;
  const inPath = !selected && Boolean(view.selection?.path.rawHex.startsWith(`${entry.path.rawHex}2f`));
  const Icon = isDirectory ? expanded ? FolderOpen : Folder : entry.kind === "symlink" ? Link2 : entry.kind === "submodule" ? Layers : FileText;
  return <>
    <div className={cn("group flex items-center rounded-[7px] hover:bg-hover", selected && "bg-accent-soft hover:bg-accent-soft")}>
    <button type="button" data-testid="tree-row" data-path-hex={entry.path.rawHex} aria-expanded={isDirectory ? expanded : undefined} aria-current={selected ? "true" : undefined}
      title={entry.kind === "symlink" ? `${entry.path.display}（符号链接）` : entry.kind === "submodule" ? `${entry.path.display}（子模块）` : entry.path.display}
      onClick={() => {
        if (isDirectory) actions.toggleDirectory(entry.path.rawHex);
        else actions.select({ path: entry.path, kind: "file" });
      }}
      className={cn("flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[7px] pr-2 text-left text-[13px] whitespace-nowrap text-fg2",
        inPath && "text-fg", selected && "bg-accent-soft font-semibold text-accent-fg hover:bg-accent-soft")}
      style={{ paddingLeft: `${6 + depth * 14}px` }}>
      {isDirectory ? expanded ? <ChevronDown className="size-3 shrink-0 text-fg3" /> : <ChevronRight className="size-3 shrink-0 text-fg3" /> : <span className="w-3 shrink-0" />}
      <Icon className={cn("size-3.5 shrink-0", isDirectory ? "text-fg3" : "text-fg3")} strokeWidth={1.75} />
      <span className="min-w-0 truncate">{entry.name.display}</span>
    </button>
    {isDirectory ? <button type="button" data-testid="directory-history" title="查看目录历史" aria-label={`查看 ${entry.path.display} 的历史`}
      onClick={() => actions.select({ path: entry.path, kind: "directory" })}
      className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-fg3 opacity-0 hover:bg-hover hover:text-fg group-hover:opacity-100 focus-visible:opacity-100">
      <Clock className="size-3.5" />
    </button> : null}
    </div>
    {isDirectory && expanded ? <Directory pathHex={entry.path.rawHex} depth={depth + 1} view={view} actions={actions} /> : null}
  </>;
}

/** Splits a line into text and find matches; `offset` is the index of the line's first match among all matches. */
function findSegments(text: string, needle: string): { text: string; match: boolean }[] {
  if (!needle) return [{ text, match: false }];
  const lower = text.toLocaleLowerCase();
  const segments: { text: string; match: boolean }[] = [];
  let from = 0;
  for (let index = lower.indexOf(needle); index !== -1; index = lower.indexOf(needle, index + needle.length)) {
    if (index > from) segments.push({ text: text.slice(from, index), match: false });
    segments.push({ text: text.slice(index, index + needle.length), match: true });
    from = index + needle.length;
  }
  if (from < text.length) segments.push({ text: text.slice(from), match: false });
  return segments;
}

function ContentPane({ view, actions, find, onFindCount, scrollTarget, onScrolled }: {
  view: FilesView;
  actions: FilesActions;
  find: { query: string; current: number };
  onFindCount(count: number): void;
  scrollTarget: number | null;
  onScrolled(): void;
}): React.JSX.Element {
  const display = useDiffDisplay();
  const content = view.content;
  const rootRef = React.useRef<HTMLDivElement>(null);
  const text = content?.value?.kind === "text" ? content.value.text : null;
  const lines = React.useMemo(() => {
    if (text === null) return [];
    const split = text.split("\n");
    if (split.at(-1) === "") split.pop();
    return split;
  }, [text]);
  const language = React.useMemo(() => view.selection ? languageForPath(view.selection.path.display) : null, [view.selection]);
  const tokens = useSyntaxLines(text === null ? null : lines, language);
  const needle = find.query.toLocaleLowerCase();
  const matchCount = React.useMemo(() => needle ? lines.reduce((sum, line) => sum + findSegments(line, needle).filter(segment => segment.match).length, 0) : 0, [lines, needle]);
  React.useEffect(() => onFindCount(matchCount), [matchCount, onFindCount]);
  const current = matchCount ? ((find.current % matchCount) + matchCount) % matchCount : -1;
  React.useEffect(() => {
    if (current < 0) return;
    rootRef.current?.querySelector(`[data-match="${current}"]`)?.scrollIntoView({ block: "center" });
  }, [current, needle]);
  React.useEffect(() => {
    if (scrollTarget === null || !lines.length) return;
    rootRef.current?.querySelector(`[data-line="${scrollTarget}"]`)?.scrollIntoView({ block: "center" });
    onScrolled();
  }, [scrollTarget, lines.length, onScrolled]);
  const blame = view.blameEnabled ? view.blame : null;
  const lineBlocks = React.useMemo(() => blame ? blameLineIndex(blame.blocks, Math.max(blame.totalLines, lines.length)) : null, [blame, lines.length]);
  const heat = React.useMemo(() => blame ? blameHeat(blame.commits) : {}, [blame]);
  const gutterWidths = React.useMemo(() => blame ? blameWidths(blame.commits) : null, [blame]);
  const historyByOid = React.useMemo(() => new Map((view.history?.entries ?? []).map(entry => [entry.commit.oid, entry])), [view.history]);

  if (!content || content.state === "loading" && !content.value) {
    return <p role="status" className="m-0 flex items-center gap-1.5 p-6 text-xs text-fg3"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />正在读取文件…</p>;
  }
  if (content.state === "error") {
    return <div role="alert" className="m-6 flex items-center gap-2 text-xs text-bad"><span>{content.error?.message}</span><Button variant="outline" size="sm" onClick={actions.retryContent}>重试</Button></div>;
  }
  const file = content.value!;
  const note = {
    binary: `二进制文件${file.size === null ? "" : `（${formatBytes(file.size)}）`}，不显示内容。`,
    lfs: "这是 Git LFS 指针；未下载 LFS 内容。",
    submodule: "这是子模块引用，只记录子模块的提交，不读取子模块内容。",
    symlink: `符号链接，指向 ${file.symlinkTarget?.display ?? "（无法读取目标）"}。不跟随链接。`,
    tooLarge: `文件${file.size === null ? "" : ` ${formatBytes(file.size)}`}，超过读取上限，不显示内容。`,
    missing: "这个版本里没有这个文件。",
    text: "",
  }[file.kind];
  if (note) return <p className="m-6 rounded-xl border border-line bg-bg px-4 py-3 text-[13px] text-fg2" data-testid="file-content-note">{note}</p>;
  let matchIndex = 0;
  return <div ref={rootRef} className="min-h-0 flex-1 overflow-auto overscroll-contain" data-testid="file-content">
    {file.textLossy ? <p className="m-0 border-b border-line px-4 py-2 text-xs text-warn">内容含有无法按 UTF-8 无损解码的数据。</p> : null}
    {blame?.state === "error" ? <p role="alert" className="m-0 border-b border-line px-4 py-2 text-xs text-bad">逐行追溯失败：{blame.error?.message}</p> : null}
    {blame?.state === "loading" ? <p role="status" className="m-0 border-b border-line px-4 py-2 text-xs text-fg3">正在逐行追溯… 已覆盖 {blame.blocks.reduce((sum, block) => sum + block.lineCount, 0).toLocaleString()} / {blame.totalLines ? blame.totalLines.toLocaleString() : "?"} 行</p> : null}
    <div className={cn("py-1 font-mono text-[13px] leading-[22px]", display.wrap ? "min-w-0" : "min-w-max")}>
      {lines.map((line, index) => {
        const number = index + 1;
        const block = lineBlocks?.[number];
        const segments = findSegments(line, needle);
        return <div key={index} data-line={number} className={cn("flex", display.wrap ? "min-w-0" : "whitespace-pre")}>
          {lineBlocks ? <BlameGutter block={block} number={number} commit={block ? blame!.commits[block.oid] : undefined} level={block ? heat[block.oid] ?? 0 : null} widths={gutterWidths!}
            history={block ? historyByOid.get(block.oid) : undefined} actions={actions} /> : null}
          <span className="w-14 shrink-0 pr-4 text-right text-fg3 select-none">{number}</span>
          <span className={cn("pr-5", display.wrap && "min-w-0 flex-1 break-all whitespace-pre-wrap")}>
            {!needle ? <SyntaxLine tokens={tokens?.[index] ?? null} fallback={line} /> : segments.map((segment, part) => segment.match
              ? <mark key={part} data-match={matchIndex++} className={cn("rounded-[3px] bg-warn-bg text-fg", matchIndex - 1 === current && "outline-2 outline-accent")}>{segment.text}</mark>
              : <React.Fragment key={part}>{segment.text}</React.Fragment>)}
          </span>
        </div>;
      })}
    </div>
    {file.truncated ? <p className="m-0 border-t border-line px-4 py-3 text-xs text-fg3">只显示前 {file.lines.toLocaleString()} 行{file.totalLines !== null ? `（共 ${file.totalLines.toLocaleString()} 行）` : ""}；查找和逐行追溯只覆盖这些行。</p> : null}
  </div>;
}

const BLAME_CARD_WIDTH = 340;

function BlameGutter({ block, number, commit, level, widths, history, actions }: {
  block: BlameBlock | undefined;
  number: number;
  commit: { summary: string; authorName: string; authorTime: number } | undefined;
  level: number | null;
  widths: BlameWidths;
  history: FileHistoryEntry | undefined;
  actions: FilesActions;
}): React.JSX.Element {
  // The card mounts only for the line being hovered or focused: a hover-card component on each of up to
  // 5,000 lines made turning blame on about 350 ms slower.
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null);
  const timer = React.useRef<number | undefined>(undefined);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const later = (next: () => void, delayMs: number) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(next, delayMs); };
  const keep = () => window.clearTimeout(timer.current);
  const show = (element: HTMLElement, delayMs: number) => later(() => setAnchor(element.getBoundingClientRect()), delayMs);
  const hide = () => later(() => setAnchor(null), 120);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  React.useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("keydown", onKey); };
  }, [anchor]);
  React.useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !anchor) return;
    const overflow = card.getBoundingClientRect().bottom - (window.innerHeight - 8);
    if (overflow > 0) card.style.top = `${Math.max(8, anchor.top - overflow)}px`;
  }, [anchor]);

  const background = level === null ? "var(--skel)" : `color-mix(in srgb, var(--accent) ${HEAT[level]}%, transparent)`;
  // Every line carries its own date and author, as in JetBrains' annotations; the colour band groups a block.
  const cell = "flex shrink-0 items-center gap-2.5 border-r border-line pr-2.5 pl-3.5 font-sans text-xs text-fg2 overflow-hidden";
  const width = 14 + widths.date + 10 + widths.author + 10 + 1;
  if (!block || !commit) return <span aria-hidden="true" className={cell} style={{ background, width }} />;
  const date = blameDate(commit.authorTime * 1000);
  const range = block.lineCount > 1 ? `第 ${block.startLine}–${block.startLine + block.lineCount - 1} 行` : `第 ${block.startLine} 行`;
  return <>
    <button type="button" className={cn(cell, "text-left hover:text-accent-fg")} style={{ background, width }} data-testid="blame-cell"
      aria-label={`第 ${number} 行：${shortOid(block.oid)}，${commit.authorName}，${date}。在文件历史中定位`} title="单击：在文件历史中定位这个提交"
      onPointerEnter={event => show(event.currentTarget, 350)} onPointerLeave={hide}
      onFocus={event => show(event.currentTarget, 0)} onBlur={hide}
      onClick={() => actions.locateFromBlame(number)}>
      <span className="shrink-0 truncate text-fg3 tabular-nums" style={{ width: widths.date }}>{date}</span>
      <span className="min-w-0 truncate">{commit.authorName}</span>
    </button>
    {anchor ? createPortal(<div ref={cardRef} data-testid="blame-card" onPointerEnter={keep} onPointerLeave={hide} onFocus={keep} onBlur={hide}
      className="fixed z-50 flex flex-col gap-2 rounded-xl border border-line2 bg-panel p-3.5 text-[13px] text-fg shadow-pop"
      style={{ width: BLAME_CARD_WIDTH, left: Math.max(8, Math.min(anchor.right + 6, window.innerWidth - BLAME_CARD_WIDTH - 8)), top: Math.max(8, anchor.top) }}>
      <span className="font-semibold leading-snug break-words">{commit.summary}</span>
      <span className="text-xs text-fg3"><span className="font-mono">{shortOid(block.oid)}</span> · {commit.authorName} · {momentLabel(commit.authorTime * 1000)}</span>
      <span className="text-xs text-fg2">这一块：{range}{history?.change.additions !== null && history?.change.additions !== undefined ? `。这个提交在本文件 +${history.change.additions} −${history.change.deletions ?? 0}` : ""}</span>
      {block.originalPath ? <span className="text-xs text-warn">当时路径：{block.originalPath.display}（之后整个文件改过名）</span> : null}
      <div className="flex gap-2 pt-1">
        <Button size="sm" onClick={() => { setAnchor(null); actions.locateFromBlame(number); }}>定位到这个提交</Button>
        <Button size="sm" variant="outline" onClick={() => { setAnchor(null); actions.openCommit(block.oid); }}>在提交历史中定位</Button>
      </div>
    </div>, document.body) : null}
  </>;
}

const STATUS_LABEL = { added: "新增", modified: "修改", deleted: "删除", renamed: "重命名", copied: "复制", typeChanged: "类型" } as const;

function HistoryPane({ view, actions }: { view: FilesView; actions: FilesActions }): React.JSX.Element {
  const display = useDiffDisplay();
  const [pinned, setPinned] = React.useState(false);
  const [floatingOpen, setFloatingOpen] = React.useState(false);
  const floating = display.layout === "split" && !pinned;
  React.useEffect(() => { if (!floating) setFloatingOpen(false); }, [floating]);
  const history = view.history;
  const entries = history?.entries ?? [];
  const selected = entries.find(entry => entry.commit.oid === view.selectedCommit) ?? null;
  const list = <HistoryList view={view} actions={actions} onPick={() => setFloatingOpen(false)} />;
  return <div className="relative flex min-h-0 flex-1 overflow-hidden">
    {!floating ? <div className="flex min-h-0 w-[340px] shrink-0 flex-col border-r border-line bg-bg">{list}</div> : null}
    {floating && floatingOpen ? <div role="dialog" aria-label="文件历史" data-testid="history-float"
      className="absolute top-[66px] left-5 z-10 flex max-h-[calc(100%-88px)] w-[380px] flex-col rounded-xl border border-line2 bg-panel shadow-pop">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-3.5 text-[13px] font-semibold">
        <span className="flex-1">文件历史</span>
        <button type="button" aria-label="固定为侧栏" title="固定为侧栏（左右并排时会挤窄 diff）" onClick={() => setPinned(true)}
          className="flex size-7 items-center justify-center rounded-[7px] text-fg3 hover:bg-hover hover:text-fg"><Pin className="size-3.5" strokeWidth={1.75} /></button>
        <button type="button" aria-label="关闭" onClick={() => setFloatingOpen(false)}
          className="flex size-7 items-center justify-center rounded-[7px] text-fg3 hover:bg-hover hover:text-fg"><X className="size-3.5" strokeWidth={1.75} /></button>
      </div>
      {list}
    </div> : null}
    <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
      <div className="mx-auto flex max-w-[960px] flex-col gap-3.5 px-8 pt-5 pb-12">
        {view.focus?.originalPath ? <p className="m-0 text-xs text-fg3">这一行来自改名之前的 <span className="font-mono">{view.focus.originalPath.display}</span>，下面是那个路径的历史。</p> : null}
        {!selected && view.selectedCommit && history?.state === "ready" ? <p className="m-0 text-xs text-fg3">所选提交 {shortOid(view.selectedCommit)} 不在已加载的历史里。</p> : null}
        {selected ? <CommitHeader entry={selected} onOpenCommit={() => actions.openCommit(selected.commit.oid)} /> : null}
        {view.selection?.kind === "directory" && selected ? <p className="m-0 rounded-xl border border-line bg-bg px-4 py-3 text-[13px] text-fg2">
          这个提交改动了这个目录下 {selected.change.files} 个文件<Counts additions={selected.change.additions} deletions={selected.change.deletions} />。目录没有单独的 diff，打开完整提交查看各个文件。</p> : null}
        {view.selection?.kind === "file" && view.selectedCommit ? <ChangeBox view={view} actions={actions} entry={selected}
          floatingButton={floating ? <button type="button" aria-expanded={floatingOpen} aria-haspopup="dialog" onClick={() => setFloatingOpen(open => !open)} data-testid="history-float-toggle"
            className="flex h-[30px] items-center gap-1.5 rounded-lg border border-line2 bg-panel px-2.5 text-[13px] font-medium aria-expanded:border-transparent aria-expanded:bg-accent-soft aria-expanded:text-accent-fg">
            <Clock className="size-3.5" strokeWidth={1.75} />历史 {entries.length}{history?.nextCursor ? "+" : ""}<ChevronDown className="size-3" strokeWidth={1.75} />
          </button> : null} /> : null}
        {!view.selectedCommit && history?.state === "ready" && entries.length === 0 ? <p className="m-0 text-[13px] text-fg3">{view.historyMessage ? `没有提交消息包含“${view.historyMessage}”的修改。` : "这个版本的可达历史里没有修改过这个路径的提交。"}</p> : null}
      </div>
    </div>
  </div>;
}

function Counts({ additions, deletions }: { additions: number | null; deletions: number | null }): React.JSX.Element | null {
  if (additions === null || deletions === null) return null;
  return <span className="ml-1.5 font-mono text-[11.5px] whitespace-nowrap tabular-nums"><span className="text-add">+{additions}</span> <span className="text-del">−{deletions}</span></span>;
}

function HistoryList({ view, actions, onPick }: { view: FilesView; actions: FilesActions; onPick(): void }): React.JSX.Element {
  const history = view.history;
  const entries = history?.entries ?? [];
  const last = entries.at(-1);
  return <div className="min-h-0 flex-1 overflow-auto px-2 pt-2 pb-4" data-testid="file-history">
    {history?.state === "loading" ? <p role="status" className="m-0 flex items-center gap-1.5 px-2.5 py-3 text-xs text-fg3"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />正在读取历史…</p> : null}
    {history?.state === "error" ? <div role="alert" className="flex items-center gap-2 px-2.5 py-3 text-xs text-bad"><span>{history.error?.message}</span><Button variant="outline" size="sm" onClick={actions.retryHistory}>重试</Button></div> : null}
    {entries.map(entry => {
      const selected = entry.commit.oid === view.selectedCommit;
      return <button key={entry.commit.oid} type="button" data-testid="file-history-row" aria-pressed={selected}
        onClick={() => { actions.selectCommit(entry.commit.oid); onPick(); }}
        className={cn("flex h-[58px] w-full flex-col justify-center gap-1 rounded-[10px] px-3 text-left hover:bg-hover", selected && "bg-panel shadow-selected hover:bg-panel")}>
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{entry.commit.summary}</span>
          {entry.change.status !== "modified" ? <span className="shrink-0 rounded bg-sunken px-1 text-[10.5px] font-semibold text-fg2">{STATUS_LABEL[entry.change.status]}</span> : null}
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-fg3">
          <IdentityAvatar identity={entry.commit.author} />
          <span className="min-w-0 truncate">{entry.commit.author.name}</span>
          <span className="shrink-0">· {when(entry.commit.author)}</span>
          <span className="ml-auto shrink-0"><Counts additions={entry.change.additions} deletions={entry.change.deletions} /></span>
        </span>
      </button>;
    })}
    {history?.nextCursor ? <Button variant="outline" size="sm" className="mt-2 ml-2.5" disabled={history.loadingMore} onClick={actions.loadMoreHistory}>{history.loadingMore ? "读取中…" : "加载更早的历史"}</Button> : null}
    {history?.state === "ready" && !history.nextCursor && last ? <p className="m-0 px-2.5 pt-3 text-[11.5px] leading-relaxed text-fg3">
      历史从 <span className="font-mono">{shortOid(last.commit.oid)}</span> 开始{last.change.status === "added" ? "（这个提交新增了它）" : ""}；按字面路径查询，不追溯改名之前的记录。</p> : null}
  </div>;
}

function CommitHeader({ entry, onOpenCommit }: { entry: FileHistoryEntry; onOpenCommit(): void }): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-3">
    <IdentityAvatar identity={entry.commit.author} size="md" />
    <div className="flex min-w-[220px] flex-1 flex-col gap-px">
      <span className="truncate text-[17px] font-semibold">{entry.commit.summary}</span>
      <span className="text-[12.5px] text-fg3">{entry.commit.author.name} · {when(entry.commit.author)}{entry.change.oldPath ? ` · 从 ${entry.change.oldPath.display} 改名` : ""}</span>
    </div>
    <Button variant="outline" size="sm" className="font-mono" onClick={() => { void window.commitScope.copyText(entry.commit.oid); }} title="复制完整 OID">{shortOid(entry.commit.oid)}</Button>
    <Button variant="outline" size="sm" onClick={onOpenCommit} data-testid="open-full-commit">查看完整提交<ChevronRight className="size-3" strokeWidth={1.75} /></Button>
  </div>;
}

function ChangeBox({ view, actions, entry, floatingButton }: { view: FilesView; actions: FilesActions; entry: FileHistoryEntry | null; floatingButton: React.ReactNode }): React.JSX.Element {
  const change = view.change;
  const parents = entry?.commit.parents ?? [];
  const diff = change?.value;
  const leading = <>
    {floatingButton}
    {diff ? <span className="mr-1 rounded-[5px] bg-warn-bg px-1.5 text-[11px] leading-5 font-semibold text-warn">{STATUS_LABEL[diff.file.status]}</span> : null}
    {diff ? <Counts additions={diff.file.additions} deletions={diff.file.deletions} /> : null}
    {parents.length > 1 ? <span role="radiogroup" aria-label="对比的父提交" className="ml-2 flex rounded-[9px] bg-sunken p-[3px]">
      {parents.map((parent, index) => <button key={parent} type="button" role="radio" aria-checked={view.parentIndex === index}
        onClick={() => actions.setParentIndex(index)}
        className="flex h-6 items-center gap-1.5 rounded-[7px] px-2 text-xs text-fg2 aria-checked:bg-panel aria-checked:font-semibold aria-checked:text-fg aria-checked:shadow-[0_0_0_1px_var(--line2)]">
        父提交 {index + 1}<span className="font-mono">{shortOid(parent)}</span></button>)}
    </span> : parents.length === 1 ? <span className="ml-2 text-xs text-fg3">对比父提交 <span className="font-mono">{shortOid(parents[0]!)}</span></span>
      : entry ? <span className="ml-2 text-xs text-fg3">根提交 · 与空树比较</span> : null}
  </>;
  if (!change || change.state === "loading" && !diff) {
    return <div className="rounded-xl border border-line bg-bg"><div className="flex h-9 items-center gap-1 border-b border-line px-3">{leading}</div>
      <p role="status" className="m-0 flex items-center gap-1.5 px-4 py-3 text-xs text-fg3"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />正在读取这次修改…</p></div>;
  }
  if (change.state === "error") {
    return <div className="rounded-xl border border-line bg-bg"><div className="flex h-9 items-center gap-1 border-b border-line px-3">{leading}</div>
      <div role="alert" className="flex items-center gap-2 px-4 py-3 text-xs text-bad"><span>{change.error?.message}</span><Button variant="outline" size="sm" onClick={() => entry && actions.selectCommit(entry.commit.oid)}>重试</Button></div></div>;
  }
  const value = diff!;
  const note = {
    binary: "二进制文件不展示文本 diff。",
    gitlink: "这是子模块引用，只显示对象变化。",
    lfs: "这是 Git LFS 指针；未下载 LFS 内容。",
    tooLarge: "文件超过读取上限，未生成 diff。",
    text: "",
  }[value.kind];
  const focus = view.focus && view.focus.oid === view.selectedCommit ? { newLine: view.focus.originalLine, label: `你在内容页点的第 ${view.focus.line} 行` } : null;
  return <div className="rounded-xl border border-line bg-bg" data-testid="file-change">
    {note || value.kind !== "text" || !value.patch ? <div className="flex h-9 items-center gap-1 border-b border-line px-3">{leading}</div> : null}
    {note ? <p className="m-0 px-4 py-3 text-xs text-fg3">{note}</p> : null}
    {value.kind === "text" && value.patch === "" ? <p className="m-0 px-4 py-3 text-xs text-fg3">内容相同，只有路径或模式变化。</p> : null}
    {value.truncated ? <p className="m-0 px-4 py-2 text-xs text-warn">diff 已截断，只显示读取上限内的部分。</p> : null}
    {value.kind === "text" && value.patch ? <DiffView patch={value.patch} fullAvailable={view.fullFileSupported} fullFileLimited={change.fullFileLimited ?? false} leading={leading} focus={focus}
      path={(value.file.newPath ?? value.file.oldPath)?.display ?? null} /> : null}
  </div>;
}
