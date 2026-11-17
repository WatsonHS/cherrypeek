import * as React from "react";
import type { HandoffFacts } from "../../../../../packages/protocol/src/generated/server-message.js";
import { Button } from "./ui/button.js";
import {
  HANDOFF_SCENARIO_TITLES,
  buildHandoffPrompt,
  cleanupAvailable,
  handoffNeedsFacts,
  handoffRequestKey,
  handoffSummary,
  type HandoffPromptFacts,
  type HandoffRequest,
  type HandoffTarget,
} from "../lib/handoff-prompt.js";

export type { HandoffRequest, HandoffTarget } from "../lib/handoff-prompt.js";

export interface HandoffDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  request: HandoffRequest | null;
  sessionKey: string | null;
  onLoadFacts(request: HandoffRequest, intent: number): Promise<HandoffFacts | null>;
  onCancelFacts(): Promise<void>;
  onCopyText(text: string): Promise<void>;
}

const NOTE_PLACEHOLDER: Record<HandoffRequest["scenario"], string> = {
  "review-range": "可选：想让它重点看什么，比如接口变动、性能、测试是否覆盖……",
  review: "可选：想让它重点看什么……",
  "explain-merge": "可选：想了解的方面……",
  revert: "可选：为什么要撤销，或需要注意什么……",
  fix: "问题是什么、怎么复现、期望的结果……",
  cleanup: "可选：需要保留或特别注意的内容……",
  "stale-worktree": "可选：这个目录的情况，比如是不是移到了别处……",
  "fetch-failed": "可选：这个仓库的远端或认证方式，比如用的是 SSH 还是 HTTPS……",
  "update-diverged": "可选：项目习惯用 rebase 还是 merge，或需要注意什么……",
  "operation-blocked": "可选：这些改动是什么、你打算怎么处理……",
  "operation-failed": "可选：失败前你做过什么，比如磁盘空间、权限、其他程序在用仓库……",
  "workspace-review": "可选：想让它重点审阅什么，比如某个文件、边界条件或兼容问题……",
  "workspace-commit": "可选：希望怎么修改改动、是否拆分提交，或想使用的提交说明方向……",
  "push-failed": "可选：希望用 rebase 还是 merge 同步，或远端分支规则……",
};

/**
 * Hands one chosen task to an outside agent: a sentence on what it will be asked to do, the
 * objects involved, an optional note, and the full prompt folded away for editing. Copying only
 * writes the clipboard; CherryPeek runs neither the agent nor Git.
 */
export function HandoffDialog({ open, onOpenChange, request, sessionKey, onLoadFacts, onCancelFacts, onCopyText }: HandoffDialogProps): React.JSX.Element | null {
  const requestKey = handoffRequestKey(request);
  const intentRef = React.useRef(0);
  const composingRef = React.useRef(false);
  const loadRef = React.useRef(onLoadFacts);
  const cancelRef = React.useRef(onCancelFacts);
  const copyRef = React.useRef(onCopyText);
  loadRef.current = onLoadFacts;
  cancelRef.current = onCancelFacts;
  copyRef.current = onCopyText;

  const [facts, setFacts] = React.useState<HandoffPromptFacts | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const [editedText, setEditedText] = React.useState<string | null>(null);
  const [showPrompt, setShowPrompt] = React.useState(false);
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "failed">("idle");
  const [composing, setComposing] = React.useState(false);

  React.useEffect(() => {
    if (!open || !request) return;
    // Requests built from what the renderer already knows (a failed operation) need no facts from the core.
    if (!handoffNeedsFacts(request)) { setFacts(null); setLoadError(null); setLoading(false); return; }
    const intent = ++intentRef.current;
    let current = true;
    setFacts(null);
    setLoadError(null);
    setLoading(true);
    void loadRef.current(request, intent).then(
      nextFacts => { if (current && intentRef.current === intent) setFacts(nextFacts); },
      error => { if (current && intentRef.current === intent) setLoadError(error instanceof Error ? error.message : String(error)); },
    ).finally(() => { if (current && intentRef.current === intent) setLoading(false); });
    return () => {
      current = false;
      intentRef.current += 1;
      void cancelRef.current().catch(() => undefined);
    };
  }, [open, requestKey, sessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (!open) return;
    setNote("");
    setEditedText(null);
    setShowPrompt(false);
    setCopyState("idle");
  }, [open, requestKey]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && !composingRef.current) {
        event.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const built = React.useMemo(() => {
    if (!request || (!facts && handoffNeedsFacts(request))) return null;
    try {
      return buildHandoffPrompt(facts, request, note);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [facts, request, note]);
  React.useEffect(() => { setEditedText(null); setCopyState("idle"); }, [built]);

  if (!open || !request) return null;
  const generatedText = built && "text" in built ? built.text : "";
  const prompt = editedText ?? generatedText;
  const tooLong = new TextEncoder().encode(prompt).byteLength > 64 * 1024;
  const blocker = blockingReason(request, facts);
  const composingNow = composing || composingRef.current;
  const needsFacts = handoffNeedsFacts(request);
  const rows = request.target.kind === "operation"
    ? operationRows(request.target)
    : request.target.kind === "workspace"
      ? workspaceRows(request.target)
      : facts ? subjectRows(request.target, facts, request.scenario) : null;
  const copyDisabled = loading || (needsFacts && !facts) || Boolean(blocker) || composingNow || tooLong || !prompt || Boolean(built && "error" in built);
  const title = HANDOFF_SCENARIO_TITLES[request.scenario];
  const count = request.target.kind === "commits" ? request.target.commits.length : null;

  const beginComposition = () => { composingRef.current = true; setComposing(true); setCopyState("idle"); };
  const endComposition = () => { composingRef.current = false; setComposing(false); };
  const handleCopy = async () => {
    if (copyDisabled || composingRef.current) return;
    try {
      await copyRef.current(prompt);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" data-testid="handoff-backdrop">
    <section role="dialog" aria-modal="true" aria-labelledby="handoff-title" data-testid="handoff-dialog" data-scenario={request.scenario}
      className="flex max-h-[min(88vh,820px)] w-full max-w-[600px] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-xl">
      <header className="flex items-start gap-4 px-5 pt-4 pb-2">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[11.5px] font-medium text-fg3">交给 Agent</p>
          <h2 id="handoff-title" className="m-0 mt-0.5 text-base font-semibold">{title}{count !== null ? ` · ${count} 个` : ""}</h2>
          <p data-testid="handoff-summary" className="m-0 mt-1.5 text-[13px] leading-5 text-fg2">{handoffSummary(request)}</p>
        </div>
        <Button variant="ghost" size="sm" aria-label="关闭交给 Agent" data-testid="handoff-close" onClick={() => onOpenChange(false)}>关闭</Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-5 pt-2 pb-4">
        {loading ? <p role="status" data-testid="handoff-loading" className="m-0 text-[13px] text-fg3">正在读取仓库信息…</p> : null}
        {loadError ? <p role="alert" data-testid="handoff-error" className="m-0 rounded-lg border border-bad-line bg-bad-bg p-3 text-[13px] text-bad">仓库信息读取失败：{loadError}。请关闭后重试。</p> : null}
        {rows ? <dl data-testid="handoff-subject" className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg bg-bg px-3 py-2.5 text-xs">
          {rows.map(([label, value]) => <React.Fragment key={label}>
            <dt className="text-fg3">{label}</dt>
            <dd className="m-0 min-w-0 break-words text-fg">{value}</dd>
          </React.Fragment>)}
        </dl> : null}
        {blocker ? <p role="alert" data-testid="handoff-blocked" className="m-0 rounded-lg border border-warn-line bg-warn-bg p-3 text-[13px] text-warn">{blocker}</p> : null}
        {built && "error" in built ? <p role="alert" data-testid="handoff-prompt-error" className="m-0 rounded-lg border border-bad-line bg-bad-bg p-3 text-[13px] text-bad">{built.error}</p> : null}

        <label className="flex flex-col gap-1.5 text-xs text-fg3">
          {request.scenario === "fix" ? "问题是什么" : "补充说明"}
          <textarea data-testid="handoff-note" value={note} placeholder={NOTE_PLACEHOLDER[request.scenario]}
            onChange={event => { setNote(event.target.value); setCopyState("idle"); }}
            onCompositionStart={beginComposition} onCompositionEnd={endComposition}
            className="h-16 resize-y rounded-lg border border-line2 bg-bg p-2.5 text-[13px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
        </label>

        <div className="flex flex-col gap-1.5">
          <button type="button" data-testid="handoff-toggle-prompt" aria-expanded={showPrompt}
            className="self-start rounded px-1 text-xs text-fg3 hover:bg-hover hover:text-fg" onClick={() => setShowPrompt(current => !current)}>
            {showPrompt ? "收起完整 prompt" : "查看完整 prompt（可编辑）"}{editedText !== null ? " · 已手动修改" : ""}
          </button>
          {showPrompt ? <textarea data-testid="handoff-preview" aria-label="Prompt 预览" value={prompt}
            onChange={event => { setEditedText(event.target.value); setCopyState("idle"); }}
            onCompositionStart={beginComposition} onCompositionEnd={endComposition}
            className="min-h-[240px] resize-y rounded-lg border border-line2 bg-bg p-3 font-mono text-xs leading-relaxed text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" /> : null}
          {tooLong ? <p role="alert" data-testid="handoff-limit-error" className="m-0 text-xs text-bad">修改后的 prompt 超过 64 KiB，不能复制。</p> : null}
        </div>
      </div>

      <footer className="flex items-center gap-3 border-t border-line px-5 py-3">
        <span role="status" aria-live="polite" data-testid="handoff-copy-status" className="mr-auto text-xs text-fg3">
          {copyState === "copied" ? "已复制，粘贴给你的 Agent 即可。" : copyState === "failed" ? "复制失败，请重试。" : "CherryPeek 只复制文字，不运行 Agent 或 Git。"}
        </span>
        <Button data-testid="handoff-copy" disabled={copyDisabled} onClick={() => { void handleCopy(); }}>复制 prompt</Button>
      </footer>
    </section>
  </div>;
}

/** Why the task cannot be handed off with these facts, or null. */
function blockingReason(request: HandoffRequest, facts: HandoffPromptFacts | null): string | null {
  if (!facts) return null;
  if (request.scenario === "cleanup" && !cleanupAvailable(facts)) {
    return "现在不能交出清理：需要本地分支已明确合入基准、不是基准分支、没有在本窗口检出，并且 worktree 清单读取完整。";
  }
  if (request.scenario === "stale-worktree" && !facts.staleWorktree) return "这条 worktree 记录已经不是失效状态，或读取不到，不需要核查。";
  if ((request.scenario === "review" || request.scenario === "explain-merge" || request.scenario === "revert" || request.scenario === "fix") && !facts.selectedCommit) {
    return "读取不到这个提交的详情，无法交出。";
  }
  if (request.scenario === "explain-merge" && (facts.selectedCommit?.parents.length ?? 0) < 2) return "这个提交不是 merge。";
  return null;
}

/** Rows for a failed or refused operation: only what the renderer itself knew at the time. */
function operationRows(target: Extract<HandoffTarget, { kind: "operation" }>): [string, string][] {
  const { repository } = target;
  const shortRef = (name: string) => name.replace(/^refs\/(?:heads|remotes)\//u, "");
  const STEP_LABELS: Record<Extract<HandoffTarget, { kind: "operation"; operation: "failed" }>["subject"]["step"], string> = {
    update: "更新（快进）",
    switch: "切换分支",
    createBranch: "新建分支",
    push: "推送分支",
    deleteBranch: "删除分支",
    mergeInto: "快进合入",
    workspaceStage: "暂存改动",
    workspaceUnstage: "取消暂存",
    workspaceDiscard: "丢弃改动",
    workspaceCommit: "提交改动",
  };
  const rows: [string, string][] = [];
  if (target.operation === "fetch") rows.push(["操作", "fetch（没有成功，远端引用可能已部分更新）"]);
  else if (target.operation === "pushFailed") {
    const { subject } = target;
    rows.push(["操作", target.rejected ? "推送（远端拒绝非快进或规则检查，未使用 --force）" : "推送（中途失败，本地分支未改写）"]);
    if (subject.branch) rows.push(["分支", `${shortRef(subject.branch.refName)} · ${shortOid(subject.branch.oid)}`]);
    if (subject.upstream) rows.push(["上游", `${shortRef(subject.upstream.refName)} · ${shortOid(subject.upstream.oid)}`]);
    else if (target.remote) rows.push(["远端", target.remote]);
  } else {
    const { subject } = target;
    const stepName = STEP_LABELS[subject.step];
    rows.push(["操作", `${stepName}${target.operation === "failed" ? "（未完成，仓库或工作区状态待检查）" : subject.fetched ? "（Fetch 已完成，本地分支和工作区未更新）" : "（被拒绝，仓库未被改动）"}`]);
    if (subject.branch) rows.push(["分支", `${shortRef(subject.branch.refName)} · ${shortOid(subject.branch.oid)}`]);
    if (subject.target) rows.push(["目标", `${shortRef(subject.target.refName)} · ${shortOid(subject.target.oid)}`]);
    if (subject.upstream) rows.push(["上游", `${shortRef(subject.upstream.refName)} · ${shortOid(subject.upstream.oid)}`]);
    if (target.operation === "diverged") rows.push(["分叉", `领先 ${target.blocker.ahead} · 落后 ${target.blocker.behind}`]);
    if (target.operation === "blocked") {
      if (target.dirty) rows.push(["未提交改动", `${target.dirty.paths.length}${target.dirty.pathsTruncated ? "+" : ""} 个文件`]);
      if (target.inProgress) rows.push(["进行中的操作", target.inProgress]);
      if (target.noUpstream) rows.push(["阻止原因", "没有上游分支"]);
    }
  }
  if (!repository.isBare && repository.worktreePath) {
    rows.push(["工作区", `${repository.worktreePath}${repository.headReference ? ` · ${repository.headReference.replace(/^refs\/heads\//u, "")}` : repository.headOid ? " · detached" : ""}`]);
  } else {
    rows.push(["仓库", repository.path]);
  }
  rows.push([target.operation === "diverged" || target.operation === "blocked" ? "拒绝时间" : "时间", new Date(target.failedAtUnixMs).toLocaleString("zh-CN")]);
  return rows;
}

function workspaceRows(target: Extract<HandoffTarget, { kind: "workspace" }>): [string, string][] {
  const { repository, status, focusPath, observedAtUnixMs } = target;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const entry of status.entries) {
    if (entry.staged) staged += 1;
    if (entry.unstaged) unstaged += 1;
    if (entry.untracked) untracked += 1;
  }
  const rows: [string, string][] = [
    ["范围", `${status.totalPaths}${status.complete ? "" : "+"} 个文件（已暂存 ${staged} · 未暂存 ${unstaged} · 未跟踪 ${untracked}）`],
  ];
  if (focusPath) rows.push(["关注文件", focusPath.display]);
  if (status.draftCommitMessage) rows.push(["提交草稿", "已有未提交草稿"]);
  if (repository.worktreePath) {
    rows.push(["工作区", `${repository.worktreePath}${repository.headReference ? ` · ${repository.headReference.replace(/^refs\/heads\//u, "")}` : repository.headOid ? " · detached" : ""}`]);
  }
  rows.push(["观察时间", new Date(observedAtUnixMs).toLocaleString("zh-CN")]);
  return rows;
}

function shortOid(oid: string): string {
  return oid.slice(0, 8);
}

/** Readable rows naming what the task is about. Repository text appears here as plain text, never as markup. */
function subjectRows(target: HandoffTarget, facts: HandoffPromptFacts, scenario: HandoffRequest["scenario"]): [string, string][] {
  const rows: [string, string][] = [];
  if (target.kind === "commits" && target.commits.length) {
    const newest = target.commits[0]!;
    const oldest = target.commits.at(-1)!;
    rows.push(["提交", `${target.commits.length} 个${target.complete ? "" : "（已加载部分）"}`]);
    rows.push(["最新", `${shortOid(newest.oid)}  ${newest.summary}`]);
    if (oldest.oid !== newest.oid) rows.push(["最早", `${shortOid(oldest.oid)}  ${oldest.summary}`]);
  } else if (facts.selectedCommit && scenario !== "cleanup" && scenario !== "stale-worktree") {
    rows.push(["提交", `${shortOid(facts.selectedCommit.oid)}  ${facts.selectedCommit.summary}`]);
    if (facts.selectedCommit.parents.length >= 2) rows.push(["父提交", `${facts.selectedCommit.parents.length} 个`]);
    if (scenario !== "explain-merge" && facts.changedFilesCount !== null) rows.push(["改动", `${facts.changedFilesCount} 个文件`]);
  }
  if (scenario === "cleanup" && facts.branch) {
    rows.push(["分支", facts.branch.name.replace(/^refs\/heads\//u, "")]);
    if (facts.base) rows.push(["基准", `${facts.base.name.replace(/^refs\/(?:heads|remotes)\//u, "")}${facts.mergeStatus === "merged" ? " · 已合入" : facts.mergeStatus === "patchEquivalent" ? " · 已找到等价补丁" : ""}`]);
    const linked = facts.checkedOutBy.filter(worktree => !worktree.isMain);
    rows.push(["worktree", linked.length ? linked.map(worktree => worktree.path).join("、") : "没有 linked worktree 检出它"]);
  }
  if (scenario === "stale-worktree" && facts.staleWorktree) rows.push(["失效记录", facts.staleWorktree.path]);
  const window = facts.windowWorktree;
  if ((scenario === "revert" || scenario === "fix" || scenario === "cleanup") && window && !window.isBare) {
    rows.push(["工作区", `${window.path}${window.headReference ? ` · ${window.headReference.replace(/^refs\/heads\//u, "")}` : " · detached"}`]);
  }
  rows.push(["观察时间", `${new Date(facts.observedAtUnixMs).toLocaleString("zh-CN")} · 本地引用，未 fetch`]);
  return rows;
}
