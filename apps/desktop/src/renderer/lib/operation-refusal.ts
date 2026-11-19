import type { OperationBlocker } from "../../../../../packages/protocol/src/repository-session.js";
import { shortOid } from "./format.js";
import { inProgressName, untrackedReplacePlan, type OperationMeta, type OperationStep } from "./operations.js";
import {
  blockedOperationRequest,
  divergedUpdateRequest,
  pushFailedRequest,
  type HandoffOperationRepository,
  type HandoffOperationSubject,
  type HandoffRequest,
  type OperationBlockerOf,
} from "./handoff-prompt.js";

/*
 * Turns the blockers of a refused operation into the facts the refusal dialog shows. Every string that
 * comes from the repository (branch names, paths, commit titles, the core's messages) stays a separate
 * list item or is interpolated into plain text only; nothing here is markup.
 */

export interface RefusalListItem {
  text: string;
  /** e.g. "未暂存" / "已暂存". */
  tag?: string;
  mono?: boolean;
}

export interface RefusalList {
  /** e.g. "本地独有 · 2 个提交". */
  heading: string;
  items: RefusalListItem[];
  /** e.g. "另有 3 个". */
  more?: string;
  /** Two consecutive `half` lists sit side by side. */
  half?: boolean;
}

export interface RefusalModel {
  title: string;
  explanation: string;
  lists: RefusalList[];
  footnote?: string;
  /** A "在工作区页查看这些改动" link: the refusal is about uncommitted changes. */
  workspaceLink: boolean;
  /** A bare repository has no working tree to open. */
  terminalAllowed: boolean;
  /** Which hand-off template fits, if any. */
  handoff: "diverged" | "blocked" | "pushRejected" | "cleanup" | null;
  /** Offer fetching before retrying when remote has moved ahead or rejected non-fast-forward push. */
  fetchBeforeRetry?: boolean;
  /** Offered next to the hand-off: back up the differing untracked files and take the upstream ones (P5-06). */
  replace: { token: string; count: number } | null;
}

const PRIORITY: OperationBlocker["kind"][] = [
  "bare",
  "inProgress",
  "unsafeState",
  "checkedOutElsewhere",
  "noUpstream",
  "remoteRejected",
  "diverged",
  "notFastForward",
  "notAncestorMerged",
  "dirty",
  "nameInvalid",
  "nameExists",
  "refChanged",
];

/** Blockers in the order they are explained: the most fundamental first. */
export function sortBlockers(blockers: readonly OperationBlocker[]): OperationBlocker[] {
  return [...blockers].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
}

const VERB: Record<OperationStep, string> = {
  update: "更新",
  switch: "切换",
  createBranch: "切换",
  push: "推送",
  deleteBranch: "删除分支",
  mergeInto: "快进合入",
  workspaceStage: "暂存",
  workspaceUnstage: "取消暂存",
  workspaceDiscard: "丢弃改动",
  workspaceCommit: "提交",
  completeMerge: "分叉同步",
};

function titleFor(meta: OperationMeta): string {
  switch (meta.step) {
    case "update": return `无法更新 ${meta.name}`;
    case "switch": return `无法切换到 ${meta.name}`;
    case "createBranch": return `无法新建分支 ${meta.name}`;
    case "push": return `无法推送 ${meta.name}`;
    case "deleteBranch": return `无法删除分支 ${meta.name}`;
    case "mergeInto": return `无法把 ${meta.name} 快进合入 ${meta.targetName ?? "目标分支"}`;
    case "workspaceStage": return "无法暂存工作区改动";
    case "workspaceUnstage": return "无法取消暂存";
    case "workspaceDiscard": return `无法丢弃 ${meta.name}`;
    case "workspaceCommit": return "无法创建提交";
    case "completeMerge": return `无法同步分支 ${meta.name}`;
  }
}

function commitList(heading: string, commits: { oid: string; summary: string }[], total: number, truncated: boolean): RefusalList {
  const rest = total - commits.length;
  return {
    heading,
    half: true,
    items: commits.map(commit => ({ text: `${shortOid(commit.oid)}  ${commit.summary}` })),
    more: rest > 0 ? `另有 ${rest} 个` : truncated ? "列表已截断" : undefined,
  };
}

interface Piece { explanation: string; lists: RefusalList[]; footnote?: string }

function piece(blocker: OperationBlocker, meta: OperationMeta, preservedDirtyCount: number | undefined): Piece {
  const name = meta.name;
  const verb = VERB[meta.step];
  switch (blocker.kind) {
    case "diverged": {
      const targetLabel = meta.step === "mergeInto"
        ? (meta.targetName ?? (meta.upstream ? shortName(meta.upstream.refName) : "目标分支"))
        : (meta.upstream ? shortName(meta.upstream.refName) : "上游");
      const overlap = blocker.overlapPaths.length;
      const explanation = meta.step === "push"
        ? `本地分支 ${name} 与 ${targetLabel} 已分叉（领先 ${blocker.ahead}、落后 ${blocker.behind}），不能快进推送。CherryPeek 不执行 --force，请先同步再推送。`
        : meta.step === "mergeInto"
          ? `源分支 ${name} 与目标分支 ${targetLabel} 已分叉（相对目标领先 ${blocker.ahead}、落后 ${blocker.behind}），不能直接快进合入。`
          : `本地分支 ${name} 与 ${targetLabel} 已分叉（领先 ${blocker.ahead}、落后 ${blocker.behind}），不能快进。可交给 Agent，或预演同步 / 解决轻量冲突。`;
      return {
        explanation,
        lists: [
          commitList(`本地独有 · ${blocker.ahead} 个提交`, blocker.localCommits, blocker.ahead, blocker.localCommitsTruncated),
          commitList(`${targetLabel} 独有 · ${blocker.behind} 个提交`, blocker.upstreamCommits, blocker.behind, blocker.upstreamCommitsTruncated),
          ...(overlap ? [{
            heading: `两边都改过的文件 · ${blocker.overlapPathsTruncated ? "至少 " : ""}${overlap} 个`,
            items: blocker.overlapPaths.map(path => ({ text: path.display, mono: true, tag: path.textLossy ? "非 UTF-8" : undefined })),
            more: blocker.overlapPathsTruncated ? "还有更多文件未列出" : undefined,
          }] : []),
        ],
      };
    }
    case "dirty": {
      const count = blocker.paths.length;
      if (untrackedReplacePlan([blocker], meta)) {
        return {
          explanation: `上游新增的 ${count} 个文件与本地未跟踪文件同名。请选择如何处理本地副本。`,
          lists: [{
            heading: "与上游不同的未跟踪文件",
            items: blocker.paths.map(entry => ({ text: entry.path.display, mono: true, tag: replaceTag(entry.replace) })),
          }],
          footnote: preservedDirtyCount && preservedDirtyCount > 0 ? `另有 ${preservedDirtyCount} 个文件的改动不冲突，会保留。` : undefined,
        };
      }
      return {
        explanation: `工作区有${blocker.pathsTruncated ? "至少 " : ""}${count} 个文件的未提交改动会被覆盖。CherryPeek 不会强制${verb}，也不会自动 stash。`,
        lists: [{
          heading: "会被覆盖的改动",
          items: blocker.paths.map(entry => ({ text: entry.path.display, mono: true, tag: entry.replace ? `${dirtyTag(entry)} · 与上游不同` : dirtyTag(entry) })),
          more: blocker.pathsTruncated ? "还有更多文件未列出" : undefined,
        }],
        footnote: preservedDirtyCount && preservedDirtyCount > 0 ? `另有 ${preservedDirtyCount} 个文件的改动不冲突，会保留。` : undefined,
      };
    }
    case "checkedOutElsewhere":
      return {
        explanation: meta.step === "deleteBranch"
          ? `${name} 已在另一个工作区检出，不能删除它。`
          : meta.step === "mergeInto"
            ? `${meta.targetName ?? "目标分支"} 已在另一个工作区检出，不能直接快进合入。`
            : `${name} 已在另一个工作区检出，不能在这里${meta.step === "update" ? "更新" : "切换"}。`,
        lists: [{ heading: "检出于", items: [{ text: blocker.worktreePath, mono: true }] }],
      };
    case "inProgress":
      return { explanation: `工作区有一个未完成的${inProgressName(blocker.operation)}，CherryPeek 不会在它之上${verb}。请先在终端处理它，或交给 Agent。`, lists: [] };
    case "unsafeState":
      return {
        explanation: "仓库处于 CherryPeek 无法确认安全的状态（例如未解决的冲突，或标记为忽略改动的文件），所以没有执行。",
        lists: [{ heading: "详情", items: [{ text: blocker.message }] }],
      };
    case "noUpstream": return { explanation: `${name} 没有上游分支，没有可以快进到的目标。`, lists: [] };
    case "notFastForward": {
      if (meta.step === "push") {
        const remote = meta.remote ?? (meta.upstream ? shortName(meta.upstream.refName) : "远端");
        return { explanation: `远端 ${remote} 的提交无法由 ${name} 快进推进，CherryPeek 不会执行 --force。`, lists: [] };
      }
      if (meta.step === "mergeInto") {
        const target = meta.targetName ?? (meta.upstream ? shortName(meta.upstream.refName) : "目标分支");
        return { explanation: `${target} 不能快进到 ${name}（或双方已分叉 / 已无需合入）。`, lists: [] };
      }
      return { explanation: `${meta.upstream ? shortName(meta.upstream.refName) : "上游"} 不是 ${name} 的后代，不能快进。`, lists: [] };
    }
    case "remoteRejected": {
      const msg = blocker.message.trim();
      return {
        explanation: `远端 ${blocker.remote} 拒绝了这次非强制推送（CherryPeek 不会执行 --force，本地分支和工作区未改动）。可先 Fetch 查看远端进展，或交给 Agent 处理。`,
        lists: msg ? [{ heading: "远端返回", items: [{ text: msg.slice(0, 1000), mono: true }] }] : [],
      };
    }
    case "notAncestorMerged": {
      const base = shortName(blocker.baseRefName);
      return {
        explanation: `${name} 尚未按提交祖先关系合入 ${base}（可能仅补丁等价或仍有独有提交）。CherryPeek 只删除明确已按祖先关系合入的本地分支，不使用 git branch -D。`,
        lists: [],
      };
    }
    case "nameInvalid": return { explanation: "Git 不接受这个分支名。", lists: [] };
    case "nameExists": return { explanation: "已有同名的本地分支，CherryPeek 不会覆盖它。", lists: [] };
    case "bare": return { explanation: "这是 bare 仓库，没有工作区，不能执行这个操作。", lists: [] };
    case "refChanged": return { explanation: `${name || "相关引用或 HEAD"} 在此期间已经变化，没有按旧的信息执行。`, lists: [] };
  }
}

function shortName(refName: string): string {
  return refName.replace(/^refs\/(?:heads|remotes)\//u, "");
}

function dirtyTag(entry: { staged: boolean; unstaged: boolean; untracked: boolean }): string {
  const tags = [entry.staged ? "已暂存" : null, entry.unstaged ? "未暂存" : null, entry.untracked ? "未跟踪" : null].filter(Boolean);
  return tags.join(" · ");
}

/** e.g. "上游多 40 行 · 本地多 1 行"; a file without line counts (binary, too large) only says that it differs. */
function replaceTag(replace: Extract<OperationBlocker, { kind: "dirty" }>["paths"][number]["replace"]): string {
  if (!replace || replace.upstreamOnlyLines == null || replace.localOnlyLines == null) return "内容不同";
  const parts = [replace.upstreamOnlyLines > 0 ? `上游多 ${replace.upstreamOnlyLines} 行` : null, replace.localOnlyLines > 0 ? `本地多 ${replace.localOnlyLines} 行` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "文件有差异";
}

/** The dialog's content for a refused operation. `preservedDirtyCount` is only known for a refusal from `checkOperation`. */
export function refusalModel(blockers: readonly OperationBlocker[], meta: OperationMeta, preservedDirtyCount?: number): RefusalModel {
  const sorted = sortBlockers(blockers);
  const pieces = sorted.map(blocker => piece(blocker, meta, preservedDirtyCount));
  const hasKind = (kind: OperationBlocker["kind"]) => sorted.some(blocker => blocker.kind === kind);
  return {
    title: titleFor(meta),
    explanation: pieces.map(item => item.explanation).join(" "),
    lists: pieces.flatMap(item => item.lists),
    footnote: pieces.map(item => item.footnote).find(Boolean),
    workspaceLink: hasKind("dirty"),
    terminalAllowed: !hasKind("bare"),
    handoff: hasKind("remoteRejected")
      ? "pushRejected"
      : hasKind("diverged")
        ? "diverged"
        : hasKind("notAncestorMerged")
          ? "cleanup"
          : hasKind("dirty") || hasKind("inProgress") || hasKind("noUpstream") ? "blocked" : null,
    fetchBeforeRetry: meta.step === "push" && (hasKind("remoteRejected") || hasKind("diverged") || hasKind("notFastForward")),
    replace: untrackedReplacePlan(blockers, meta),
  };
}

/** Hand-off request for a refusal, from the blockers and the facts the renderer already holds. Null when no template fits. */
export function refusalHandoffRequest(blockers: readonly OperationBlocker[], meta: OperationMeta, repository: HandoffOperationRepository, atUnixMs: number): HandoffRequest | null {
  const subject: HandoffOperationSubject = {
    step: meta.step,
    fetched: meta.fetched,
    branch: meta.refName ? { refName: meta.refName, oid: meta.oid } : null,
    upstream: meta.step === "mergeInto" ? null : meta.upstream,
    target: meta.step === "mergeInto" ? meta.upstream : null,
    remote: meta.remote ?? null,
    checkedOutBy: meta.checkedOutBy,
  };
  const remoteRejected = blockers.find((blocker): blocker is OperationBlockerOf<"remoteRejected"> => blocker.kind === "remoteRejected");
  if (remoteRejected) return pushFailedRequest(repository, subject, remoteRejected.remote, remoteRejected.message, atUnixMs, true);
  const diverged = blockers.find((blocker): blocker is OperationBlockerOf<"diverged"> => blocker.kind === "diverged");
  if (diverged) return divergedUpdateRequest(repository, subject, diverged, atUnixMs);
  if (blockers.some(blocker => blocker.kind === "notAncestorMerged") && meta.refName) {
    return { scenario: "cleanup", target: { kind: "branch", ref: meta.refName } };
  }
  const dirty = blockers.find((blocker): blocker is OperationBlockerOf<"dirty"> => blocker.kind === "dirty") ?? null;
  const progress = blockers.find((blocker): blocker is OperationBlockerOf<"inProgress"> => blocker.kind === "inProgress");
  const noUpstream = blockers.some(blocker => blocker.kind === "noUpstream");
  if (dirty || progress || noUpstream) return blockedOperationRequest(repository, subject, { dirty, inProgress: progress?.operation ?? null, noUpstream }, atUnixMs);
  return null;
}
