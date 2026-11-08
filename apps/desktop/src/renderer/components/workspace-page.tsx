import * as React from "react";
import { Clock, Info, LoaderCircle, RefreshCw } from "lucide-react";
import type { ChangedFileStatus, GitPath, RepositoryInfo, WorkspaceDiff, WorkspaceFile } from "../../../../../packages/protocol/src/generated/server-message.js";
import { shortOid, shortRefName } from "../lib/format.js";
import { cn } from "../lib/utils.js";
import { workspaceHeadText } from "../lib/workspace-indicator.js";
import { workspaceItems, type WorkspaceGroup, type WorkspaceItem, type WorkspaceView } from "../lib/workspace-store.js";
import { DiffView } from "./diff-view.js";
import { SyntaxLine } from "./syntax-text.js";
import { languageForPath } from "../lib/syntax/languages.js";
import { useSyntaxLines } from "../lib/syntax/highlight.js";
import { PlaceholderBox } from "./placeholder.js";
import { Button } from "./ui/button.js";

const GROUP_TITLE: Record<WorkspaceGroup, string> = { conflict: "冲突", staged: "已暂存", unstaged: "未暂存", untracked: "未跟踪" };
const GROUP_BASE: Record<WorkspaceGroup, string> = { conflict: "", staged: "HEAD → index", unstaged: "index → 工作区", untracked: "" };
const STATUS_LABEL: Record<ChangedFileStatus, string> = { added: "新增", modified: "修改", deleted: "删除", renamed: "重命名", copied: "复制", typeChanged: "类型" };
const OPERATION_LABEL = { none: "", merge: "正在合并", rebase: "正在变基", cherryPick: "正在拣选", revert: "正在还原", bisect: "正在二分查找" } as const;

function clock(unixMs: number): string {
  return new Date(unixMs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function splitPath(display: string): { name: string; dir: string } {
  const index = display.lastIndexOf("/");
  return index < 0 ? { name: display, dir: "" } : { name: display.slice(index + 1), dir: display.slice(0, index) };
}

function StatusBadge({ item, small = false }: { item: WorkspaceItem; small?: boolean }): React.JSX.Element {
  const status = item.change?.status;
  const tone = item.group === "conflict" ? "bg-bad text-panel"
    : item.group === "untracked" ? "bg-sunken text-fg2 shadow-[inset_0_0_0_1px_var(--line2)]"
      : status === "added" ? "bg-ok-bg text-ok" : status === "deleted" ? "bg-del-bg text-del"
        : status === "renamed" || status === "copied" ? "bg-accent-soft text-accent-fg" : "bg-warn-bg text-warn";
  const label = item.group === "conflict" ? "冲突" : item.group === "untracked" ? "未跟踪" : STATUS_LABEL[status ?? "modified"];
  return <span className={cn("inline-flex shrink-0 items-center justify-center font-semibold", small ? "h-[18px] min-w-[30px] rounded px-1 text-[10.5px]" : "h-5 min-w-9 rounded-[5px] px-1.5 text-[11px]", tone)}>{label}</span>;
}

function Counts({ additions, deletions }: { additions: number | null | undefined; deletions: number | null | undefined }): React.JSX.Element | null {
  if (additions === null || additions === undefined || deletions === null || deletions === undefined) return null;
  return <span className="font-mono text-[11.5px] whitespace-nowrap tabular-nums"><span className="text-add">+{additions}</span> <span className="text-del">−{deletions}</span></span>;
}

/** The workspace page: files changed in this window's directory on the left, the chosen file on the right. */
export function WorkspacePage({ repository, view, filter, onSelect, onRefresh, onLoadMore, onRetryContent, onOpenFileHistory }: {
  repository: RepositoryInfo;
  view: WorkspaceView;
  filter: string;
  onSelect(item: WorkspaceItem): void;
  onRefresh(): void;
  onLoadMore(): void;
  onRetryContent(): void;
  /** Opens the files page on this path's committed history (P4-10). */
  onOpenFileHistory?(path: GitPath): void;
}): React.JSX.Element {
  const directory = repository.worktreePath ?? repository.path;
  if (!view.supported) {
    return <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="workspace-page">
      <nav aria-label="工作区改动的文件" className="flex min-h-0 max-w-[400px] flex-[1_1_340px] flex-col border-r border-line">
        <div className="flex items-center gap-1.5 px-[18px] pt-2 pb-0.5">
          <span className="min-w-0 flex-1 truncate text-xs text-fg3" title={directory}><span className="font-mono">{directory}</span> · {workspaceHeadText(repository)}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 pt-2 pb-4">
          <PlaceholderBox task="P4-09" title="已暂存 / 未暂存 / 未跟踪 / 冲突"
            note="核心还不能读取工作区状态。接入后这里按组列出改动的文件，同一文件两组都有时各出现一次。" />
        </div>
      </nav>
      <main aria-label="所选文件的改动" className="flex min-h-0 min-w-0 flex-[999_1_560px] items-center justify-center overflow-auto bg-panel p-8">
        <PlaceholderBox task="P4-09" title="工作区改动" className="max-w-[520px]"
          note="读取工作区需要核心提供只读的工作区查询（P4-09 后端，尚未接入）。这里不显示示例文件，也不会把未读取说成“干净”。" />
      </main>
    </div>;
  }
  const status = view.status;
  const items = workspaceItems(status);
  const needle = filter.trim().toLocaleLowerCase();
  const shown = needle ? items.filter(item => item.entry.path.display.toLocaleLowerCase().includes(needle)) : items;
  const groups = (["conflict", "staged", "unstaged", "untracked"] as const).map(group => ({ group, items: shown.filter(item => item.group === group) })).filter(group => group.items.length);
  const selected = view.selection ? items.find(item => item.group === view.selection!.group && item.entry.path.rawHex === view.selection!.pathHex) ?? null : null;
  const head = status ? status.headReference ? shortRefName(status.headReference) : status.headOid ? `detached ${shortOid(status.headOid)}` : "尚无提交" : workspaceHeadText(repository);
  const operation = status && status.operation !== "none" ? OPERATION_LABEL[status.operation] : "";
  return <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="workspace-page">
    <nav aria-label="工作区改动的文件" className="flex min-h-0 max-w-[400px] flex-[1_1_340px] flex-col border-r border-line">
      <div className="flex items-center gap-1.5 pt-2 pr-2.5 pb-0.5 pl-[18px]">
        <span className="min-w-0 flex-1 truncate text-xs text-fg3" title={`${directory} · HEAD ${head}`}>
          <span className="font-mono">{directory}</span> · {head} · {view.loading && !status ? "正在读取…" : status ? `${clock(status.observedAtUnixMs)} 读取` : ""}
        </span>
        <button type="button" aria-label="重新读取工作区" title="重新读取（文件变化和窗口聚焦时也会自动复核）" onClick={onRefresh}
          className="flex size-7 shrink-0 items-center justify-center rounded-[7px] text-fg3 hover:bg-hover hover:text-fg">
          <RefreshCw className={cn("size-3.5", view.loading && "animate-spin motion-reduce:animate-none")} strokeWidth={1.75} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-4" data-testid="workspace-files">
        {operation ? <p role="status" className="mx-1 mt-2 mb-0 rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn">{operation}{status?.conflictCount ? ` · ${status.conflictCount} 个冲突` : ""}</p> : null}
        {view.stale ? <p role="status" className="mx-1 mt-2 mb-0 text-xs text-fg3">文件有变化，正在重新读取；下面是 {status ? clock(status.observedAtUnixMs) : ""} 的结果。</p> : null}
        {status && !status.complete ? <p role="status" className="mx-1 mt-2 mb-0 rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn">改动的文件超过 {status.entries.length.toLocaleString()} 个，只列出前 {status.entries.length.toLocaleString()} 个；总数至少 {status.totalPaths.toLocaleString()}。</p> : null}
        {view.error ? <div role="alert" className="mx-1 mt-2 flex flex-col gap-2 rounded-lg border border-bad-line bg-bad-bg px-3 py-2.5 text-xs text-bad">
          <span>读取工作区失败：{view.error.message}{status ? "。下面是上一次读取的结果。" : ""}</span>
          <Button variant="outline" size="sm" className="self-start" onClick={onRefresh}>重试</Button>
        </div> : null}
        {!status && view.loading ? <p role="status" className="m-0 flex items-center gap-1.5 px-2.5 py-3 text-xs text-fg3"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />正在读取工作区…</p> : null}
        {status && status.complete && status.entries.length === 0 && !view.stale ? <div data-testid="workspace-clean" className="flex flex-col items-center gap-2.5 px-5 pt-8 pb-7 text-center">
          <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-ok-bg text-ok"><svg viewBox="0 0 16 16" className="size-5" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.5 }}><path d="M3.5 8.5l3 3 6-7" /></svg></span>
          <span className="text-[15px] font-semibold">工作区干净</span>
          <span className="max-w-[240px] text-[12.5px] text-fg2">{clock(status.observedAtUnixMs)} 完整读取：没有已暂存、未暂存、未跟踪或冲突的文件。忽略的文件不计入。</span>
        </div> : null}
        {status && needle && shown.length === 0 && items.length > 0 ? <p className="m-0 px-2.5 py-3 text-xs text-fg3">没有路径包含“{filter.trim()}”的改动文件。</p> : null}
        {groups.map(({ group, items: groupItems }) => {
          const additions = groupItems.reduce((sum, item) => sum + (item.change?.additions ?? 0), 0);
          const deletions = groupItems.reduce((sum, item) => sum + (item.change?.deletions ?? 0), 0);
          return <div key={group} role="group" aria-label={GROUP_TITLE[group]}>
            <div className="flex h-[30px] items-baseline gap-2 px-2.5 pt-2 text-xs">
              <b className="font-semibold text-fg2">{GROUP_TITLE[group]}</b><span className="text-fg3">{groupItems.length}</span>
              {GROUP_BASE[group] ? <span className="font-mono text-[11px] text-fg3">{GROUP_BASE[group]}</span> : null}
              {group === "staged" || group === "unstaged" ? <span className="ml-auto"><Counts additions={additions} deletions={deletions} /></span> : null}
            </div>
            {groupItems.map(item => {
              const { name, dir } = splitPath(item.entry.path.display);
              const isSelected = selected?.group === item.group && selected.entry.path.rawHex === item.entry.path.rawHex;
              return <button key={`${item.group}:${item.entry.path.rawHex}`} type="button" data-testid="workspace-file" aria-pressed={isSelected}
                aria-label={`${GROUP_TITLE[item.group]}：${item.entry.path.display}`} onClick={() => onSelect(item)}
                className={cn("flex h-10 w-full items-center gap-2 rounded-[9px] px-2.5 text-left hover:bg-hover", isSelected && "bg-panel shadow-selected hover:bg-panel")}>
                <StatusBadge item={item} small />
                <span className="flex min-w-0 flex-1 items-baseline gap-[7px] overflow-hidden whitespace-nowrap" title={item.entry.originalPath ? `${item.entry.originalPath.display} → ${item.entry.path.display}` : item.entry.path.display}>
                  <span className="text-[13.5px] font-medium">{name}</span><span className="truncate text-xs text-fg3">{dir}</span>
                </span>
                {item.alsoIn ? <span className="inline-flex h-[18px] shrink-0 items-center rounded-[9px] bg-sunken px-1.5 text-[10.5px] font-medium whitespace-nowrap text-fg3">也有{GROUP_TITLE[item.alsoIn]}</span> : null}
                {item.change ? <Counts additions={item.change.additions} deletions={item.change.deletions} />
                  : item.group === "untracked" && item.entry.untrackedSize !== null ? <span className="text-[11.5px] whitespace-nowrap text-fg3 tabular-nums">{formatBytes(item.entry.untrackedSize)}</span> : null}
              </button>;
            })}
          </div>;
        })}
      </div>
      <div className="flex h-[34px] shrink-0 items-center border-t border-line px-[18px] text-xs text-fg3">
        {status ? `${needle ? `${shown.length} / ` : ""}${status.complete ? "" : "至少 "}${status.totalPaths.toLocaleString()} 个文件` : ""}
      </div>
    </nav>
    <main aria-label={selected ? `${selected.entry.path.display} 的改动` : "所选文件的改动"} className="min-h-0 min-w-0 flex-[999_1_560px] overflow-auto overscroll-contain bg-panel">
      {selected ? <SelectedFile item={selected} view={view} onLoadMore={onLoadMore} onRetry={onRetryContent}
        onOpenHistory={onOpenFileHistory && selected.group !== "untracked" ? () => onOpenFileHistory(selected.entry.originalPath ?? selected.entry.path) : undefined} />
        : <p className="m-0 flex h-full items-center justify-center text-[13px] text-fg3">{status ? "选择左侧的文件查看改动。" : ""}</p>}
    </main>
  </div>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}

function SelectedFile({ item, view, onLoadMore, onRetry, onOpenHistory }: { item: WorkspaceItem; view: WorkspaceView; onLoadMore(): void; onRetry(): void; onOpenHistory?(): void }): React.JSX.Element {
  const { name, dir } = splitPath(item.entry.path.display);
  const content = view.content;
  const side = item.group === "staged" ? "已暂存 · HEAD → index" : item.group === "unstaged" ? "未暂存 · index → 工作区" : item.group === "untracked" ? "未跟踪 · 只在工作区" : "冲突 · 工作区里带冲突标记的内容";
  const other = item.alsoIn ? item.entry[item.alsoIn] : null;
  return <div className="mx-auto flex max-w-[960px] flex-col gap-3.5 px-9 pt-[22px] pb-12" data-testid="workspace-selected">
    <div className="flex flex-wrap items-center gap-3">
      <StatusBadge item={item} />
      <div className="flex min-w-[200px] flex-1 flex-col gap-px">
        <span className="flex items-baseline gap-2 overflow-hidden whitespace-nowrap"><span className="text-[17px] font-semibold">{name}</span><span className="truncate text-[12.5px] text-fg3">{dir}</span></span>
        <span className="text-[12.5px] text-fg3">{side}{item.change ? <> · <Counts additions={item.change.additions} deletions={item.change.deletions} /></> : null}
          {item.entry.originalPath ? ` · 来自 ${item.entry.originalPath.display}` : ""}</span>
      </div>
      {onOpenHistory ? <Button variant="outline" size="sm" onClick={onOpenHistory} data-testid="workspace-file-history">
        <Clock className="size-3.5" strokeWidth={1.75} />文件历史</Button> : null}
    </div>
    {item.alsoIn && other ? <div className="flex items-center gap-2.5 rounded-[10px] bg-bg px-3 py-[9px] text-[12.5px] text-fg2 shadow-[inset_0_0_0_1px_var(--line)]">
      <Info className="size-3.5 shrink-0 text-fg3" strokeWidth={1.75} />
      <span className="flex-1">这个文件还有{item.alsoIn === "staged" ? "已暂存" : "未暂存"}的改动（<span className="font-mono">{item.alsoIn === "staged" ? "HEAD → index" : "index → 工作区"}</span>{other.additions !== null ? <>，<Counts additions={other.additions} deletions={other.deletions} /></> : null}）。这里只显示{item.group === "staged" ? "已暂存" : "还没暂存"}的部分。</span>
    </div> : null}
    <div className="overflow-hidden rounded-xl border border-line bg-bg">
      {!content || content.state === "loading" && !content.diff && !content.file
        ? <p role="status" className="m-0 flex items-center gap-1.5 px-4 py-3 text-xs text-fg3"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />正在读取…</p>
        : content.state === "error"
          ? <div role="alert" className="flex items-center gap-2 px-4 py-3 text-xs text-bad"><span>{content.error?.message}</span><Button variant="outline" size="sm" onClick={onRetry}>重试</Button></div>
          : content.diff ? <WorkspaceDiffBody diff={content.diff} />
            : content.file ? <WorkspaceFileBody file={content.file} conflict={item.group === "conflict"} canLoadMore={view.previewLines < 5_000} onLoadMore={onLoadMore} loading={content.state === "loading"} />
              : null}
    </div>
  </div>;
}

function WorkspaceDiffBody({ diff }: { diff: WorkspaceDiff }): React.JSX.Element {
  const note = {
    binary: "二进制文件不展示文本 diff。",
    gitlink: "这是子模块引用，只显示对象变化，不读取子模块工作区。",
    lfs: "这是 Git LFS 指针；未下载 LFS 内容。",
    tooLarge: `文件超过读取上限（${diff.oldSize === null ? "大小未知" : formatBytes(diff.oldSize)} → ${diff.newSize === null ? "大小未知" : formatBytes(diff.newSize)}），未生成 diff。`,
    text: "",
  }[diff.kind];
  return <div data-testid="workspace-diff">
    {note ? <p className="m-0 px-4 py-3 text-xs text-fg3">{note}</p> : null}
    {diff.kind === "text" && diff.patch === "" && !diff.truncated ? <p className="m-0 px-4 py-3 text-xs text-fg3">内容相同，只有模式变化。</p> : null}
    {diff.textLossy ? <p className="m-0 px-4 py-2 text-xs text-warn">diff 文本含有无法按 UTF-8 无损解码的数据。</p> : null}
    {diff.truncated ? <p className="m-0 px-4 py-2 text-xs text-warn">diff 已截断，只显示读取上限内的部分。</p> : null}
    {diff.kind === "text" && diff.patch ? <DiffView patch={diff.patch} path={diff.path.display} /> : null}
  </div>;
}

function WorkspaceFileBody({ file, conflict, canLoadMore, onLoadMore, loading }: { file: WorkspaceFile; conflict: boolean; canLoadMore: boolean; onLoadMore(): void; loading: boolean }): React.JSX.Element {
  const note = {
    binary: `二进制文件${file.size === null ? "" : `（${formatBytes(file.size)}）`}，不显示内容。`,
    tooLarge: `文件${file.size === null ? "" : ` ${formatBytes(file.size)}`}，超过 1 MB 的预览上限，不读取内容。`,
    symlink: `符号链接，指向 ${file.symlinkTarget?.display ?? "（无法读取目标）"}。不跟随链接。`,
    missing: "文件已不在工作区，可能刚被删除；重新读取状态后会更新。",
    notFile: "这个路径不是普通文件。",
    text: "",
  }[file.kind];
  const lines = React.useMemo(() => {
    const split = file.text.split("\n");
    if (split.at(-1) === "") split.pop();
    return split;
  }, [file.text]);
  const language = React.useMemo(() => conflict ? null : languageForPath(file.path.display), [conflict, file.path.display]);
  const tokens = useSyntaxLines(file.kind === "text" ? lines : null, language);
  if (note) return <p className="m-0 px-4 py-3 text-xs text-fg3" data-testid="workspace-file-note">{note}</p>;
  let region: "ours" | "theirs" | null = null;
  return <div data-testid="workspace-file-text">
    {file.textLossy ? <p className="m-0 px-4 py-2 text-xs text-warn">内容含有无法按 UTF-8 无损解码的数据。</p> : null}
    <div className="overflow-x-auto py-1 font-mono text-[12px] leading-[21px]">
      {lines.map((text, index) => {
        let tone = "";
        if (conflict) {
          if (text.startsWith("<<<<<<<")) { region = "ours"; tone = "bg-warn-bg text-warn font-medium"; }
          else if (text.startsWith("=======") && region) { region = "theirs"; tone = "bg-warn-bg text-warn font-medium"; }
          else if (text.startsWith(">>>>>>>") && region) { region = null; tone = "bg-warn-bg text-warn font-medium"; }
          else if (region === "ours") tone = "bg-accent-soft";
          else if (region === "theirs") tone = "bg-hunk-bg";
        }
        return <div key={index} className={cn("flex min-h-[21px] min-w-max whitespace-pre", tone)}>
          <span className="w-12 shrink-0 pr-2 text-right text-fg3 select-none">{index + 1}</span>
          <span className="pr-5 pl-3">{conflict ? text : <SyntaxLine tokens={tokens?.[index] ?? null} fallback={text} />}</span>
        </div>;
      })}
    </div>
    {file.truncated ? <div className="flex items-center gap-3 border-t border-line px-4 py-2.5 text-xs text-fg3">
      <span>只显示前 {file.lines.toLocaleString()} 行。</span>
      {canLoadMore ? <Button variant="outline" size="sm" disabled={loading} onClick={onLoadMore}>再加载 500 行</Button> : <span>预览最多 5,000 行。</span>}
    </div> : null}
  </div>;
}
