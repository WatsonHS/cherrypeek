import * as React from "react";
import { ChevronDown, FileText, Info, LoaderCircle, RefreshCw } from "lucide-react";
import type { ChangedFileStatus, GitPath, RepositoryInfo, WorkspaceDiff, WorkspaceFile } from "../../../../../packages/protocol/src/generated/server-message.js";
import { repositoryName, shortOid, shortRefName } from "../lib/format.js";
import { cn } from "../lib/utils.js";
import { workspaceHeadText } from "../lib/workspace-indicator.js";
import { workspaceIsClean, workspaceItems, type WorkspaceGroup, type WorkspaceItem, type WorkspaceView } from "../lib/workspace-store.js";
import { workspaceCommitRequest, workspaceReviewRequest, type HandoffRequest } from "../lib/handoff-prompt.js";
import type { OperationsActions } from "../lib/use-operations.js";
import { DiffView } from "./diff-view.js";
import { SyntaxLine } from "./syntax-text.js";
import { languageForPath } from "../lib/syntax/languages.js";
import { useSyntaxLines } from "../lib/syntax/highlight.js";
import { PlaceholderBox } from "./placeholder.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

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

function unstageTargets(item: WorkspaceItem): string[] {
  return item.entry.originalPath ? [item.entry.path.rawHex, item.entry.originalPath.rawHex] : [item.entry.path.rawHex];
}

/** The workspace page: files changed in this window's directory on the left, the chosen file on the right. */
export function WorkspacePage({ repository, view, filter, onSelect, onRefresh, onLoadMore, onRetryContent, onOpenFile, operations, onOpenHandoff }: {
  repository: RepositoryInfo;
  view: WorkspaceView;
  filter: string;
  onSelect(item: WorkspaceItem): void;
  onRefresh(): void;
  onLoadMore(): void;
  onRetryContent(): void;
  /** "在文件页打开": the committed file (its path before a staged rename) on the files page. */
  onOpenFile?(path: GitPath): void;
  operations?: OperationsActions | null;
  onOpenHandoff?(request: HandoffRequest): void;
}): React.JSX.Element {
  const directory = repository.worktreePath ?? repository.path;
  const repoKey = `${repository.path}:${repository.worktreePath ?? ""}`;
  const status = view.status;
  const [handoffOpen, setHandoffOpen] = React.useState(false);
  const [discardTarget, setDiscardTarget] = React.useState<WorkspaceItem | null>(null);
  const [discardSubmitting, setDiscardSubmitting] = React.useState(false);
  const [commitMessage, setCommitMessage] = React.useState("");
  const [userEditedMessage, setUserEditedMessage] = React.useState(false);
  const [appliedDraftText, setAppliedDraftText] = React.useState<string | null>(null);
  const [commitComposing, setCommitComposing] = React.useState(false);
  const commitComposingRef = React.useRef(false);

  React.useEffect(() => {
    setHandoffOpen(false);
    setDiscardTarget(null);
    setDiscardSubmitting(false);
    setCommitMessage("");
    setUserEditedMessage(false);
    setAppliedDraftText(null);
  }, [repoKey]);

  React.useEffect(() => {
    if (userEditedMessage) return;
    const draft = status?.draftCommitMessage ?? null;
    if (draft && draft !== appliedDraftText) {
      setCommitMessage(draft);
      setAppliedDraftText(draft);
    } else if (!draft && appliedDraftText !== null) {
      setCommitMessage("");
      setAppliedDraftText(null);
    }
  }, [status?.draftCommitMessage, userEditedMessage, appliedDraftText]);

  React.useEffect(() => {
    if (!discardTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !discardSubmitting) {
        event.preventDefault();
        setDiscardTarget(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [discardTarget, discardSubmitting]);

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
  const items = workspaceItems(status);
  const needle = filter.trim().toLocaleLowerCase();
  const shown = needle ? items.filter(item => item.entry.path.display.toLocaleLowerCase().includes(needle)) : items;
  const groups = (["conflict", "staged", "unstaged", "untracked"] as const).map(group => ({ group, items: shown.filter(item => item.group === group) })).filter(group => group.items.length);
  const selected = view.selection ? items.find(item => item.group === view.selection!.group && item.entry.path.rawHex === view.selection!.pathHex) ?? null : null;
  const head = status ? status.headReference ? shortRefName(status.headReference) : status.headOid ? `detached ${shortOid(status.headOid)}` : "尚无提交" : workspaceHeadText(repository);
  const operation = status && status.operation !== "none" ? OPERATION_LABEL[status.operation] : "";
  const stagedCount = items.filter(item => item.group === "staged").length;
  const stageableCount = items.filter(item => item.group === "unstaged" || item.group === "untracked").length;
  const canMutate = Boolean(!repository.isBare && operations && status && status.conflictCount === 0 && status.operation === "none");
  const opBusy = Boolean(operations?.busy);
  const draftText = status?.draftCommitMessage ?? null;
  const hasUnloadableDraft = Boolean(draftText && userEditedMessage && commitMessage !== draftText);
  const canCommit = Boolean(canMutate && !opBusy && stagedCount > 0 && commitMessage.trim().length > 0 && !commitComposing);
  const submitCommit = async () => {
    if (!operations || !canCommit) return;
    const res = await operations.commitWorkspace(commitMessage, status?.headOid ?? repository.headOid ?? null);
    if (res.committed) {
      setCommitMessage("");
      setUserEditedMessage(false);
      setAppliedDraftText(null);
    }
  };
  const confirmDiscard = async () => {
    if (!discardTarget || !operations || opBusy || discardSubmitting) return;
    setDiscardSubmitting(true);
    try {
      const done = await operations.discardPath(
        discardTarget.entry.path.rawHex,
        discardTarget.group === "untracked",
        discardTarget.entry.path.display,
        status?.headOid ?? repository.headOid ?? null,
      );
      if (done) setDiscardTarget(null);
    } finally {
      setDiscardSubmitting(false);
    }
  };

  return <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="workspace-page">
    <nav aria-label="工作区改动的文件" className="flex min-h-0 max-w-[400px] flex-[1_1_340px] flex-col border-r border-line">
      <div className="flex items-center gap-1.5 pt-2 pr-2.5 pb-0.5 pl-[18px]">
        {/* The folder's name (the full path is the tooltip); the branch and the read time never give way. */}
        <span className="flex min-w-0 flex-1 items-baseline text-xs whitespace-nowrap text-fg3" title={`${directory} · HEAD ${head}${status ? ` · ${clock(status.observedAtUnixMs)} 读取` : ""}`}>
          <span className="min-w-0 truncate font-mono">{repositoryName(directory)}</span>
          <span className="shrink-0">&nbsp;· {head} · {view.loading && !status ? "正在读取…" : status ? `${clock(status.observedAtUnixMs)} 读取` : ""}</span>
        </span>
        <button type="button" aria-label="重新读取工作区" title="重新读取（文件变化和窗口聚焦时也会自动复核）" onClick={onRefresh}
          className="flex size-7 shrink-0 items-center justify-center rounded-[7px] text-fg3 hover:bg-hover hover:text-fg">
          <RefreshCw className={cn("size-3.5", view.loading && "animate-spin motion-reduce:animate-none")} strokeWidth={1.75} />
        </button>
      </div>
      {!repository.isBare && status && (items.length > 0 || (canMutate && stageableCount > 0)) ? (
        <div className="flex items-center gap-1.5 px-3 py-1.5">
          {items.length > 0 && onOpenHandoff ? (
            <Popover open={handoffOpen} onOpenChange={setHandoffOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" data-testid="workspace-handoff-button" className="h-7 gap-1 px-2 text-xs">
                  <span>交给 Agent</span>
                  <ChevronDown className="size-3 text-fg3" strokeWidth={1.75} aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[216px] p-1.5">
                <div role="menu" aria-label="交给 Agent" className="flex flex-col">
                  <button type="button" role="menuitem" data-testid="workspace-handoff-review"
                    className="rounded-[7px] px-2.5 py-1.5 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover"
                    onClick={() => {
                      setHandoffOpen(false);
                      onOpenHandoff(workspaceReviewRequest(repository, status, status.observedAtUnixMs, selected?.entry.path ?? null));
                    }}>
                    <span className="block font-medium">审阅未提交改动…</span>
                    <span className="block text-[11px] text-fg3">只读检查风险与遗漏</span>
                  </button>
                  <button type="button" role="menuitem" data-testid="workspace-handoff-commit"
                    className="rounded-[7px] px-2.5 py-1.5 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover"
                    onClick={() => {
                      setHandoffOpen(false);
                      onOpenHandoff(workspaceCommitRequest(repository, status, status.observedAtUnixMs, selected?.entry.path ?? null));
                    }}>
                    <span className="block font-medium">让 Agent 整理并提交…</span>
                    <span className="block text-[11px] text-fg3">核对、验证检查后生成提交</span>
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
          {canMutate && stageableCount > 0 ? (
            <Button variant="soft" size="sm" data-testid="workspace-stage-all" disabled={opBusy}
              className="ml-auto h-7 px-2 text-xs"
              onClick={() => { void operations?.stagePaths([], true); }}>
              全部暂存
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-4" data-testid="workspace-files">
        {operation ? <p role="status" className="mx-1 mt-2 mb-0 rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn">{operation}{status?.conflictCount ? ` · ${status.conflictCount} 个冲突` : ""}</p> : null}
        {view.stale ? <p role="status" className="mx-1 mt-2 mb-0 text-xs text-fg3">文件有变化，正在重新读取；下面是 {status ? clock(status.observedAtUnixMs) : ""} 的结果。</p> : null}
        {status && !status.complete ? <p role="status" className="mx-1 mt-2 mb-0 rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn">改动的文件超过 {status.entries.length.toLocaleString()} 个，只列出前 {status.entries.length.toLocaleString()} 个；总数至少 {status.totalPaths.toLocaleString()}。</p> : null}
        {view.error ? <div role="alert" className="mx-1 mt-2 flex flex-col gap-2 rounded-lg border border-bad-line bg-bad-bg px-3 py-2.5 text-xs text-bad">
          <span>读取工作区失败：{view.error.message}{status ? "。下面是上一次读取的结果。" : ""}</span>
          <Button variant="outline" size="sm" className="self-start" onClick={onRefresh}>重试</Button>
        </div> : null}
        {!status && view.loading ? <p role="status" className="m-0 flex items-center gap-1.5 px-2.5 py-3 text-xs text-fg3"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />正在读取工作区…</p> : null}
        {status && workspaceIsClean(view) ? <div data-testid="workspace-clean" className="flex flex-col items-center gap-2.5 px-5 pt-8 pb-7 text-center">
          <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-ok-bg text-ok"><svg viewBox="0 0 16 16" className="size-5" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.5 }}><path d="M3.5 8.5l3 3 6-7" /></svg></span>
          <span className="text-[15px] font-semibold">工作区干净</span>
          <span className="max-w-[240px] text-[12.5px] text-fg2">{clock(status.observedAtUnixMs)} 完整读取：没有已暂存、未暂存、未跟踪或冲突的文件。忽略的文件不计入。</span>
        </div>
          // An empty result that is being re-read, failed to re-read or is stale is not a claim of "clean".
          : status && status.entries.length === 0 ? <p className="m-0 px-2.5 py-3 text-xs text-fg3" data-testid="workspace-empty-unconfirmed">{clock(status.observedAtUnixMs)} 读取时没有改动的文件。</p> : null}
        {status && needle && shown.length === 0 && items.length > 0 ? <p className="m-0 px-2.5 py-3 text-xs text-fg3">没有路径包含“{filter.trim()}”的改动文件。</p> : null}
        {groups.map(({ group, items: groupItems }) => {
          const additions = groupItems.reduce((sum, item) => sum + (item.change?.additions ?? 0), 0);
          const deletions = groupItems.reduce((sum, item) => sum + (item.change?.deletions ?? 0), 0);
          return <div key={group} role="group" aria-label={GROUP_TITLE[group]}>
            <div className="flex h-[30px] items-center gap-2 px-2.5 pt-2 text-xs">
              <b className="font-semibold text-fg2">{GROUP_TITLE[group]}</b><span className="text-fg3">{groupItems.length}</span>
              {GROUP_BASE[group] ? <span className="font-mono text-[11px] text-fg3">{GROUP_BASE[group]}</span> : null}
              <span className="ml-auto flex items-center gap-2">
                {group === "staged" || group === "unstaged" ? <Counts additions={additions} deletions={deletions} /> : null}
                {group === "staged" && canMutate ? (
                  <button type="button" data-testid="workspace-unstage-all" disabled={opBusy}
                    className="rounded px-1.5 py-0.5 text-[11px] text-fg2 hover:bg-hover hover:text-fg disabled:opacity-45"
                    onClick={() => { void operations?.unstagePaths([], true); }}>
                    全部取消暂存
                  </button>
                ) : null}
              </span>
            </div>
            {groupItems.map(item => {
              const { name, dir } = splitPath(item.entry.path.display);
              const isSelected = selected?.group === item.group && selected.entry.path.rawHex === item.entry.path.rawHex;
              return <div key={`${item.group}:${item.entry.path.rawHex}`} data-testid="workspace-file-row"
                className={cn("group/ws flex h-10 w-full items-center gap-1 rounded-[9px] pr-1.5 hover:bg-hover", isSelected && "bg-panel shadow-selected hover:bg-panel")}>
                <button type="button" data-testid="workspace-file" aria-pressed={isSelected}
                  aria-label={`${GROUP_TITLE[item.group]}：${item.entry.path.display}`} onClick={() => onSelect(item)}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5 pr-1 text-left">
                  <StatusBadge item={item} small />
                  <span className="flex min-w-0 flex-1 items-baseline gap-[7px] overflow-hidden whitespace-nowrap" title={item.entry.originalPath ? `${item.entry.originalPath.display} → ${item.entry.path.display}` : item.entry.path.display}>
                    <span className="text-[13.5px] font-medium">{name}</span><span className="truncate text-xs text-fg3">{dir}</span>
                  </span>
                  {item.alsoIn ? <span className="inline-flex h-[18px] shrink-0 items-center rounded-[9px] bg-sunken px-1.5 text-[10.5px] font-medium whitespace-nowrap text-fg3">也有{GROUP_TITLE[item.alsoIn]}</span> : null}
                  {item.change ? <Counts additions={item.change.additions} deletions={item.change.deletions} />
                    : item.group === "untracked" && item.entry.untrackedSize !== null ? <span className="text-[11.5px] whitespace-nowrap text-fg3 tabular-nums">{formatBytes(item.entry.untrackedSize)}</span> : null}
                </button>
                {canMutate && item.group === "staged" ? (
                  <button type="button" data-testid="workspace-unstage-file" disabled={opBusy}
                    aria-label={`取消暂存 ${item.entry.path.display}`} title="从暂存区撤回"
                    className={cn("h-6 shrink-0 rounded px-1.5 text-[11px] text-fg2 hover:bg-sunken hover:text-fg disabled:opacity-45",
                      isSelected ? "opacity-100" : "opacity-0 group-hover/ws:opacity-100 focus-visible:opacity-100")}
                    onClick={() => { void operations?.unstagePaths(unstageTargets(item)); }}>
                    撤回
                  </button>
                ) : null}
                {canMutate && (item.group === "unstaged" || item.group === "untracked") ? (
                  <>
                    <button type="button" data-testid="workspace-stage-file" disabled={opBusy}
                      aria-label={`暂存 ${item.entry.path.display}`} title="暂存到 index"
                      className={cn("h-6 shrink-0 rounded px-1.5 text-[11px] font-medium text-accent-fg hover:bg-accent-soft disabled:opacity-45",
                        isSelected ? "opacity-100" : "opacity-0 group-hover/ws:opacity-100 focus-visible:opacity-100")}
                      onClick={() => { void operations?.stagePaths([item.entry.path.rawHex]); }}>
                      暂存
                    </button>
                    <button type="button" data-testid="workspace-discard-file" disabled={opBusy}
                      aria-label={`丢弃 ${item.entry.path.display}`} title="丢弃工作区修改或删除未跟踪文件（需确认）"
                      className={cn("h-6 shrink-0 rounded px-1.5 text-[11px] text-bad hover:bg-bad-bg disabled:opacity-45",
                        isSelected ? "opacity-100" : "opacity-0 group-hover/ws:opacity-100 focus-visible:opacity-100")}
                      onClick={() => setDiscardTarget(item)}>
                      丢弃…
                    </button>
                  </>
                ) : null}
              </div>;
            })}
          </div>;
        })}
      </div>
      {!repository.isBare && operations ? (
        <div className="flex shrink-0 flex-col gap-2 border-t border-line bg-bg px-3 py-2.5" data-testid="workspace-commit-panel">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-fg2">提交说明</span>
            {appliedDraftText && !userEditedMessage ? <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] text-accent-fg" data-testid="workspace-draft-badge">已载入草稿</span> : null}
            {hasUnloadableDraft ? <button type="button" data-testid="workspace-load-draft"
              className="text-[11px] text-accent-fg underline"
              onClick={() => { if (draftText) { setCommitMessage(draftText); setAppliedDraftText(draftText); setUserEditedMessage(false); } }}>
              载入草稿
            </button> : null}
            {commitMessage ? <button type="button" className="ml-auto text-[11px] text-fg3 hover:text-fg"
              onClick={() => { setCommitMessage(""); setUserEditedMessage(true); }}>
              清空
            </button> : null}
          </div>
          {status && (status.conflictCount > 0 || status.operation !== "none") ? (
            <p className="m-0 rounded bg-warn-bg px-2.5 py-1.5 text-[11.5px] text-warn">
              工作区有冲突或进行中的合并/变基，不能直接暂存或提交；可交给 Agent 或在终端处理。
            </p>
          ) : null}
          <textarea
            data-testid="workspace-commit-message"
            aria-label="提交说明"
            placeholder="输入提交说明（⌘Enter 或 Ctrl+Enter 提交）"
            rows={3}
            disabled={Boolean(!status || status.conflictCount > 0 || status.operation !== "none")}
            value={commitMessage}
            onChange={event => {
              setCommitMessage(event.target.value);
              setUserEditedMessage(true);
            }}
            onCompositionStart={() => { commitComposingRef.current = true; setCommitComposing(true); }}
            onCompositionEnd={() => { commitComposingRef.current = false; setCommitComposing(false); }}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing && !commitComposingRef.current && event.keyCode !== 229) {
                event.preventDefault();
                void submitCommit();
              }
            }}
            className="min-h-[68px] resize-y rounded-lg border border-line2 bg-panel px-2.5 py-2 text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-fg3 focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
          />
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] text-fg3">
              {stagedCount > 0 ? `已暂存 ${stagedCount} 个文件` : "请先暂存改动再提交"}
            </span>
            <Button size="sm" className="ml-auto" data-testid="workspace-commit-submit" disabled={!canCommit}
              onClick={() => { void submitCommit(); }}>
              提交已暂存改动（{stagedCount}）
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex h-[34px] shrink-0 items-center border-t border-line px-[18px] text-xs text-fg3">
        {status ? `${needle ? `${shown.length} / ` : ""}${status.complete ? "" : "至少 "}${status.totalPaths.toLocaleString()} 个文件` : ""}
      </div>
    </nav>
    <main aria-label={selected ? `${selected.entry.path.display} 的改动` : "所选文件的改动"} className="min-h-0 min-w-0 flex-[999_1_560px] overflow-auto overscroll-contain bg-panel">
      {selected ? <SelectedFile item={selected} view={view} onLoadMore={onLoadMore} onRetry={onRetryContent}
        onOpenFile={onOpenFile && committed(selected) ? () => onOpenFile(selected.entry.originalPath ?? selected.entry.path) : undefined}
        onStage={canMutate && (selected.group === "unstaged" || selected.group === "untracked") ? () => { void operations?.stagePaths([selected.entry.path.rawHex]); } : undefined}
        onUnstage={canMutate && selected.group === "staged" ? () => { void operations?.unstagePaths(unstageTargets(selected)); } : undefined}
        onDiscard={canMutate && (selected.group === "unstaged" || selected.group === "untracked") ? () => setDiscardTarget(selected) : undefined}
        onHandoff={onOpenHandoff && status ? () => onOpenHandoff(workspaceReviewRequest(repository, status, status.observedAtUnixMs, selected.entry.path)) : undefined}
        busy={opBusy} />
        : <p className="m-0 flex h-full items-center justify-center text-[13px] text-fg3">{status ? "选择左侧的文件查看改动。" : ""}</p>}
    </main>
    {discardTarget ? (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" data-testid="workspace-discard-backdrop">
        <section role="dialog" aria-modal="true" aria-labelledby="workspace-discard-title" data-testid="workspace-discard-dialog"
          className="flex w-full max-w-[440px] flex-col gap-3 rounded-xl border border-line bg-panel p-5 shadow-xl">
          <h2 id="workspace-discard-title" className="m-0 text-[16px] font-semibold">
            {discardTarget.group === "untracked" ? "删除未跟踪文件？" : "丢弃未暂存改动？"}
          </h2>
          <code className="rounded-lg bg-bg px-3 py-2 font-mono text-xs break-all text-fg">{discardTarget.entry.path.display}</code>
          <p className="m-0 text-[13px] leading-5 text-fg2">
            {discardTarget.group === "untracked"
              ? "该未跟踪文件将从磁盘删除，无法撤回。"
              : discardTarget.alsoIn === "staged"
                ? "工作区未暂存部分的修改将被还原为当前暂存区版本；已暂存的内容会保留。"
                : "该文件在工作区相对于 index 的修改将被还原，无法撤回。"}
          </p>
          <footer className="mt-1 flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" autoFocus data-testid="workspace-discard-cancel"
              disabled={discardSubmitting} onClick={() => setDiscardTarget(null)}>
              取消
            </Button>
            <Button size="sm" data-testid="workspace-discard-confirm" disabled={opBusy || discardSubmitting}
              className="bg-bad text-panel hover:bg-bad/90"
              onClick={() => { void confirmDiscard(); }}>
              确认丢弃
            </Button>
          </footer>
        </section>
      </div>
    ) : null}
  </div>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}

/** Whether the file has a committed version to open: not untracked, and not a new file (added without a rename). */
function committed(item: WorkspaceItem): boolean {
  if (item.group === "untracked") return false;
  const added = item.entry.staged?.status === "added" || item.entry.unstaged?.status === "added";
  return !added || item.entry.originalPath !== null;
}

function SelectedFile({
  item,
  view,
  onLoadMore,
  onRetry,
  onOpenFile,
  onStage,
  onUnstage,
  onDiscard,
  onHandoff,
  busy,
}: {
  item: WorkspaceItem;
  view: WorkspaceView;
  onLoadMore(): void;
  onRetry(): void;
  onOpenFile?(): void;
  onStage?(): void;
  onUnstage?(): void;
  onDiscard?(): void;
  onHandoff?(): void;
  busy?: boolean;
}): React.JSX.Element {
  const [controls, setControls] = React.useState<HTMLElement | null>(null);
  const { name, dir } = splitPath(item.entry.path.display);
  const content = view.content;
  const side = item.group === "staged" ? "已暂存 · HEAD → index" : item.group === "unstaged" ? "未暂存 · index → 工作区" : item.group === "untracked" ? "未跟踪 · 只在工作区" : "冲突 · 工作区里带冲突标记的内容";
  const other = item.alsoIn ? item.entry[item.alsoIn] : null;
  return <div className="mx-auto flex max-w-[960px] flex-col gap-3.5 px-9 pt-[22px] pb-12" data-testid="workspace-selected">
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge item={item} />
      <div className="flex min-w-[200px] flex-1 flex-col gap-px">
        <span className="flex items-baseline gap-2 overflow-hidden whitespace-nowrap"><span className="text-[17px] font-semibold">{name}</span><span className="truncate text-[12.5px] text-fg3">{dir}</span></span>
        <span className="text-[12.5px] text-fg3">{side}{item.change ? <> · <Counts additions={item.change.additions} deletions={item.change.deletions} /></> : null}
          {item.entry.originalPath ? ` · 来自 ${item.entry.originalPath.display}` : ""}</span>
      </div>
      <div ref={setControls} data-testid="workspace-diff-controls" className="flex shrink-0 items-center gap-1" />
      {onStage ? <Button variant="soft" size="sm" disabled={busy} onClick={onStage} data-testid="workspace-selected-stage">暂存</Button> : null}
      {onUnstage ? <Button variant="outline" size="sm" disabled={busy} onClick={onUnstage} data-testid="workspace-selected-unstage">取消暂存</Button> : null}
      {onDiscard ? <Button variant="outline" size="sm" disabled={busy} onClick={onDiscard} className="text-bad hover:bg-bad-bg" data-testid="workspace-selected-discard">丢弃…</Button> : null}
      {onHandoff ? <Button variant="outline" size="sm" onClick={onHandoff} data-testid="workspace-handoff-file">交给 Agent…</Button> : null}
      {onOpenFile ? <Button variant="outline" size="sm" onClick={onOpenFile} data-testid="workspace-open-file" title="在文件页看这个文件在 HEAD 里的版本（这些改动的出发点）和它的历史">
        <FileText className="size-3.5" strokeWidth={1.75} />在文件页打开</Button> : null}
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
          : content.diff ? <WorkspaceDiffBody diff={content.diff} fullFileLimited={content.fullFileLimited ?? false} controls={controls} />
            : content.file ? <WorkspaceFileBody file={content.file} conflict={item.group === "conflict"} canLoadMore={view.previewLines < 5_000} onLoadMore={onLoadMore} loading={content.state === "loading"} />
              : null}
    </div>
  </div>;
}

function WorkspaceDiffBody({ diff, fullFileLimited, controls }: { diff: WorkspaceDiff; fullFileLimited: boolean; controls: HTMLElement | null }): React.JSX.Element {
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
    {(diff.kind === "text" || diff.kind === "gitlink") && diff.patch ? <DiffView patch={diff.patch} fullFileLimited={fullFileLimited} path={diff.path.display} controlsTarget={controls} /> : null}
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
