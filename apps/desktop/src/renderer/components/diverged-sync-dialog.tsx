import * as React from "react";
import { Check, GitBranch, GitMerge, LoaderCircle, TriangleAlert } from "lucide-react";
import type {
  MergePreviewResult,
  MergeSyncMode,
  OperationBlocker,
  PreviewMergeParams,
  RepositorySessionResult,
} from "../../../../../packages/protocol/src/repository-session.js";
import { shortOid, shortRefName } from "../lib/format.js";
import {
  blockedOperationRequest,
  divergedUpdateRequest,
  type HandoffOperationRepository,
  type OperationBlockerOf,
} from "../lib/handoff-prompt.js";
import { completeMergeMeta, type DivergedSyncTarget } from "../lib/operations.js";
import { refusalModel } from "../lib/operation-refusal.js";
import type { HandoffRequest } from "./handoff-dialog.js";
import { Button } from "./ui/button.js";

export interface DivergedSyncDialogProps {
  target: DivergedSyncTarget | null;
  repository: HandoffOperationRepository | null;
  headOid: string | null;
  busy: boolean;
  previewMerge(params: PreviewMergeParams): Promise<RepositorySessionResult<MergePreviewResult>>;
  onConfirmClean(params: {
    targetRef: string;
    expectedTargetOid: string;
    sourceRef: string;
    expectedSourceOid: string;
    expectedHeadOid: string | null;
    mode: MergeSyncMode;
    message: string;
    switchToTarget: boolean;
    pushAfter: boolean;
    pushRemote: string | null;
  }): Promise<boolean>;
  onOpenThreePane(
    target: DivergedSyncTarget,
    preview: Extract<MergePreviewResult, { outcome: "conflicted" }>,
  ): void;
  onOpenWorkspace(): void;
  onHandoff(request: HandoffRequest): void;
  onClose(): void;
}

export function DivergedSyncDialog({
  target,
  repository,
  headOid,
  busy,
  previewMerge,
  onConfirmClean,
  onOpenThreePane,
  onOpenWorkspace,
  onHandoff,
  onClose,
}: DivergedSyncDialogProps): React.JSX.Element | null {
  const [loading, setLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<MergePreviewResult | null>(null);
  const [mode, setMode] = React.useState<MergeSyncMode>("mergeCommit");
  const [message, setMessage] = React.useState("");
  const [messageEdited, setMessageEdited] = React.useState(false);
  const [pushAfter, setPushAfter] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const seqRef = React.useRef(0);
  const previewMergeRef = React.useRef(previewMerge);
  previewMergeRef.current = previewMerge;

  const key = target
    ? `${target.targetRef}:${target.expectedTargetOid}<-${target.sourceRef}:${target.expectedSourceOid}:${target.switchToTarget ? "1" : "0"}`
    : "";

  React.useEffect(() => {
    if (!target) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setPreviewError(null);
    setPreview(null);
    setMode("mergeCommit");
    setMessage("");
    setMessageEdited(false);
    setPushAfter(target.defaultPushAfter);
    setSubmitting(false);

    void previewMergeRef.current({
      targetRef: target.targetRef,
      expectedTargetOid: target.expectedTargetOid,
      sourceRef: target.sourceRef,
      expectedSourceOid: target.expectedSourceOid,
    }).then(result => {
      if (seq !== seqRef.current) return;
      setLoading(false);
      if (!result.ok) {
        setPreviewError(result.error.message);
        return;
      }
      setPreview(result.value);
      if (result.value.outcome === "clean") {
        const defaultMode: MergeSyncMode = result.value.canSingleCommitRebase && target.canPushAfter
          ? "singleCommitRebase"
          : "mergeCommit";
        setMode(defaultMode);
        setMessage(
          defaultMode === "singleCommitRebase"
            ? (result.value.singleCommitSummary ?? result.value.defaultMessage)
            : result.value.defaultMessage,
        );
      }
    }).catch((reason: unknown) => {
      if (seq !== seqRef.current) return;
      setLoading(false);
      setPreviewError(reason instanceof Error ? reason.message : String(reason));
    });
    // Only re-run preview when `key` changes (new branch/OID pair); parent re-renders must not reset preview state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  React.useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && !submitting) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [target, submitting, onClose]);

  if (!target) return null;

  const targetName = shortRefName(target.targetRef);
  const sourceName = shortRefName(target.sourceRef);

  const selectMode = (nextMode: MergeSyncMode) => {
    setMode(nextMode);
    if (!messageEdited && preview?.outcome === "clean") {
      setMessage(
        nextMode === "singleCommitRebase"
          ? (preview.singleCommitSummary ?? preview.defaultMessage)
          : preview.defaultMessage,
      );
    }
  };

  const buildHandoffRequest = (): HandoffRequest | null => {
    if (!repository) return null;
    const subject = {
      step: "completeMerge" as const,
      branch: { refName: target.targetRef, oid: target.expectedTargetOid },
      upstream: { refName: target.sourceRef, oid: target.expectedSourceOid },
      remote: target.pushRemote,
      checkedOutBy: repository.headReference === target.targetRef && repository.worktreePath
        ? [repository.worktreePath]
        : [],
    };
    if (preview?.outcome === "blocked") {
      const dirty = preview.blockers.find((b): b is OperationBlockerOf<"dirty"> => b.kind === "dirty") ?? null;
      const inProg = preview.blockers.find((b): b is OperationBlockerOf<"inProgress"> => b.kind === "inProgress");
      if (dirty || inProg) {
        return blockedOperationRequest(repository, subject, { dirty, inProgress: inProg?.operation ?? null }, Date.now());
      }
    }
    const overlapPaths = preview?.outcome === "conflicted"
      ? preview.files.map(f => f.path)
      : preview?.outcome === "unsupported"
        ? preview.conflictPaths
        : [];
    return divergedUpdateRequest(
      repository,
      subject,
      {
        kind: "diverged",
        ahead: 1,
        behind: 1,
        localCommits: [],
        upstreamCommits: [],
        localCommitsTruncated: false,
        upstreamCommitsTruncated: false,
        overlapPaths,
        overlapPathsTruncated: false,
      },
      Date.now(),
    );
  };

  const triggerHandoff = () => {
    const request = buildHandoffRequest();
    if (!request) return;
    onClose();
    onHandoff(request);
  };

  const confirmClean = async () => {
    if (busy || submitting || preview?.outcome !== "clean" || !message.trim()) return;
    setSubmitting(true);
    try {
      const ok = await onConfirmClean({
        targetRef: target.targetRef,
        expectedTargetOid: target.expectedTargetOid,
        sourceRef: target.sourceRef,
        expectedSourceOid: target.expectedSourceOid,
        expectedHeadOid: headOid,
        mode,
        message: message.trim(),
        switchToTarget: target.switchToTarget,
        pushAfter: target.canPushAfter && pushAfter,
        pushRemote: target.pushRemote,
      });
      if (ok) onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const blockedMeta = completeMergeMeta(
    target.targetRef,
    target.expectedTargetOid,
    target.sourceRef,
    target.expectedSourceOid,
  );
  const blockedModel = preview?.outcome === "blocked"
    ? refusalModel(preview.blockers as readonly OperationBlocker[], blockedMeta)
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" data-testid="diverged-sync-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="diverged-sync-title"
        data-testid="diverged-sync-dialog"
        className="flex max-h-[min(88vh,820px)] w-full max-w-[540px] flex-col gap-3.5 overflow-auto rounded-xl border border-line bg-panel p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id="diverged-sync-title" className="m-0 text-[17px] font-semibold">
            同步分叉分支 {targetName}
          </h2>
          <code className="shrink-0 rounded bg-bg px-2 py-0.5 font-mono text-[11px] text-fg3">
            {targetName} ({shortOid(target.expectedTargetOid)}) ← {sourceName} ({shortOid(target.expectedSourceOid)})
          </code>
        </div>

        <div role="status" data-testid="diverged-sync-safe" className="flex items-center gap-1.5 self-start rounded-lg bg-ok-bg px-2.5 py-1.5 text-[12px] font-medium text-ok">
          <Check className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          预演在隔离临时对象中完成，未写入任何合并或 rebase 中间状态
        </div>

        {loading ? (
          <div className="flex items-center gap-2 rounded-lg bg-bg px-3.5 py-4 text-[13px] text-fg2" data-testid="diverged-sync-loading">
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none text-accent" strokeWidth={1.75} aria-hidden="true" />
            正在只读预演三方合并结果…
          </div>
        ) : previewError ? (
          <div className="rounded-lg border border-bad-line bg-bad-bg px-3.5 py-3 text-[13px] text-bad" data-testid="diverged-sync-error">
            预演失败：{previewError}
          </div>
        ) : preview?.outcome === "clean" ? (
          <div className="flex flex-col gap-3" data-testid="diverged-sync-clean">
            <p className="m-0 text-[13px] text-fg2">
              两边改动可以无冲突自动合并{preview.autoMergedCount > 0 ? `（共 ${preview.autoMergedCount} 个两边都改过的文件已自动合并）` : ""}。请选择完成方式：
            </p>
            <div className="flex flex-col gap-2">
              {preview.canSingleCommitRebase ? (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-bg px-3 py-2.5 hover:border-line2">
                  <input
                    type="radio"
                    name="merge-sync-mode"
                    data-testid="merge-mode-single-rebase"
                    checked={mode === "singleCommitRebase"}
                    onChange={() => selectMode("singleCommitRebase")}
                    disabled={submitting}
                    className="mt-0.5 accent-[var(--accent)]"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                      <GitBranch className="size-3.5 text-accent" strokeWidth={1.75} aria-hidden="true" />
                      单提交线性变基（推荐）
                    </span>
                    <span className="text-xs text-fg3">
                      将本地唯一的提交无冲突重放到 {sourceName} 之上，保留原作者与时间，不产生 merge 节点。
                    </span>
                  </div>
                </label>
              ) : null}
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-bg px-3 py-2.5 hover:border-line2">
                <input
                  type="radio"
                  name="merge-sync-mode"
                  data-testid="merge-mode-merge-commit"
                  checked={mode === "mergeCommit"}
                  onChange={() => selectMode("mergeCommit")}
                  disabled={submitting}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                    <GitMerge className="size-3.5 text-fg2" strokeWidth={1.75} aria-hidden="true" />
                    创建合并提交（Merge Commit）
                  </span>
                  <span className="text-xs text-fg3">
                    生成一个包含双方父提交的 merge commit，保留两边原有提交哈希。
                  </span>
                </div>
              </label>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="diverged-sync-message-input" className="text-xs font-medium text-fg2">
                {mode === "singleCommitRebase" ? "提交标题（未改动标题时保留原提交完整正文）" : "合并提交说明"}
              </label>
              <textarea
                id="diverged-sync-message-input"
                data-testid="diverged-sync-message"
                rows={2}
                value={message}
                onChange={event => {
                  setMessageEdited(true);
                  setMessage(event.target.value);
                }}
                disabled={submitting}
                className="w-full resize-y rounded-lg border border-line2 bg-bg px-3 py-2 font-mono text-xs text-fg focus:border-accent focus:outline-none"
              />
            </div>

            {target.canPushAfter ? (
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg select-none">
                <input
                  type="checkbox"
                  data-testid="diverged-sync-push-after"
                  checked={pushAfter}
                  disabled={busy || submitting}
                  onChange={event => setPushAfter(event.target.checked)}
                  className="size-3.5 rounded border-line2 accent-[var(--accent)]"
                />
                <span>同步完成后立即非强制推送到远端</span>
              </label>
            ) : null}
          </div>
        ) : preview?.outcome === "conflicted" ? (
          <div className="flex flex-col gap-3" data-testid="diverged-sync-conflicted">
            <p className="m-0 text-[13px] leading-5 text-fg2">
              预演发现 <strong className="text-fg">{preview.files.length}</strong> 个文本文件存在冲突
              {preview.autoMergedCount > 0 ? `（另有 ${preview.autoMergedCount} 个文件可自动合并）` : ""}。建议交给 Agent 处理；如果只有几行小冲突，也可以打开三栏双边点选视图顺手解决：
            </p>
            <div className="flex max-h-44 flex-col gap-1 overflow-auto rounded-lg bg-bg px-3 py-2.5 text-xs">
              {preview.files.map(file => (
                <div key={file.path.rawHex} className="flex items-center justify-between gap-2 font-mono text-fg">
                  <span className="min-w-0 truncate">{file.path.display}</span>
                  <span className="shrink-0 text-[11px] text-warn">文本冲突</span>
                </div>
              ))}
            </div>
          </div>
        ) : preview?.outcome === "unsupported" ? (
          <div className="flex flex-col gap-2.5" data-testid="diverged-sync-unsupported">
            <div className="flex items-start gap-2 rounded-lg border border-warn-line bg-warn-bg px-3 py-2.5 text-[13px] text-warn">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              <span>{preview.message}</span>
            </div>
            {preview.conflictPaths.length > 0 ? (
              <div className="flex max-h-36 flex-col gap-1 overflow-auto rounded-lg bg-bg px-3 py-2 text-xs font-mono text-fg2">
                {preview.conflictPaths.map(item => (
                  <div key={item.rawHex} className="truncate">{item.display}</div>
                ))}
              </div>
            ) : null}
          </div>
        ) : preview?.outcome === "blocked" && blockedModel ? (
          <div className="flex flex-col gap-2.5" data-testid="diverged-sync-blocked">
            <p className="m-0 text-[13px] text-fg2">{blockedModel.explanation}</p>
            {blockedModel.lists.map(list => (
              <div key={list.heading} className="flex flex-col gap-1 rounded-lg bg-bg px-3 py-2 text-xs">
                <span className="text-fg3">{list.heading}</span>
                {list.items.map((item, idx) => (
                  <span key={`${idx}:${item.text}`} className="truncate font-mono text-fg">{item.text}</span>
                ))}
              </div>
            ))}
            {blockedModel.workspaceLink ? (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenWorkspace();
                }}
                className="self-start text-xs text-accent-fg underline-offset-2 hover:underline"
              >
                在工作区页查看这些改动
              </button>
            ) : null}
          </div>
        ) : null}

        <footer className="mt-1 flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting} data-testid="diverged-sync-cancel">
            取消
          </Button>
          {repository ? (
            <Button
              variant={preview?.outcome === "clean" ? "outline" : "default"}
              size="sm"
              onClick={triggerHandoff}
              disabled={submitting}
              data-testid="diverged-sync-handoff"
            >
              交给 Agent…
            </Button>
          ) : null}
          {preview?.outcome === "conflicted" ? (
            <Button
              variant="soft"
              size="sm"
              disabled={busy || submitting}
              data-testid="open-three-pane-merge"
              onClick={() => {
                onClose();
                onOpenThreePane(target, preview);
              }}
            >
              顺手解决冲突…
            </Button>
          ) : null}
          {preview?.outcome === "clean" ? (
            <Button
              size="sm"
              disabled={busy || submitting || message.trim().length === 0}
              data-testid="diverged-sync-confirm"
              onClick={() => { void confirmClean(); }}
            >
              {submitting ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" strokeWidth={1.75} aria-hidden="true" /> : null}
              {target.canPushAfter && pushAfter ? "同步并推送" : "确认同步"}
            </Button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
