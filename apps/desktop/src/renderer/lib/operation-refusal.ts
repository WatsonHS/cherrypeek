import type { OperationBlocker } from "../../../../../packages/protocol/src/repository-session.js";
import { shortOid } from "./format.js";
import { inProgressName, type OperationMeta } from "./operations.js";
import {
  blockedOperationRequest,
  divergedUpdateRequest,
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
  handoff: "diverged" | "blocked" | null;
}

const PRIORITY: OperationBlocker["kind"][] = [
  "bare", "inProgress", "unsafeState", "checkedOutElsewhere", "noUpstream", "diverged", "notFastForward", "dirty", "nameInvalid", "nameExists", "refChanged",
];

/** Blockers in the order they are explained: the most fundamental first. */
export function sortBlockers(blockers: readonly OperationBlocker[]): OperationBlocker[] {
  return [...blockers].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
}

const VERB = { update: "更新", switch: "切换", createBranch: "切换" } as const;

function titleFor(meta: OperationMeta): string {
  switch (meta.step) {
    case "update": return `无法更新 ${meta.name}`;
    case "switch": return `无法切换到 ${meta.name}`;
    case "createBranch": return `无法新建分支 ${meta.name}`;
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
      const upstream = meta.upstream ? shortName(meta.upstream.refName) : "上游";
      const overlap = blocker.overlapPaths.length;
      return {
        explanation: `本地分支 ${name} 与 ${upstream} 已分叉（领先 ${blocker.ahead}、落后 ${blocker.behind}），不能快进。合并或 rebase 可能有冲突，CherryPeek 不处理。`,
        lists: [
          commitList(`本地独有 · ${blocker.ahead} 个提交`, blocker.localCommits, blocker.ahead, blocker.localCommitsTruncated),
          commitList(`${upstream} 独有 · ${blocker.behind} 个提交`, blocker.upstreamCommits, blocker.behind, blocker.upstreamCommitsTruncated),
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
      return {
        explanation: `工作区有${blocker.pathsTruncated ? "至少 " : ""}${count} 个文件的未提交改动会被覆盖。CherryPeek 不会强制${verb}，也不会自动 stash。`,
        lists: [{
          heading: "会被覆盖的改动",
          items: blocker.paths.map(entry => ({ text: entry.path.display, mono: true, tag: dirtyTag(entry) })),
          more: blocker.pathsTruncated ? "还有更多文件未列出" : undefined,
        }],
        footnote: preservedDirtyCount && preservedDirtyCount > 0 ? `另有 ${preservedDirtyCount} 个文件的改动不冲突，会保留。` : undefined,
      };
    }
    case "checkedOutElsewhere":
      return {
        explanation: `${name} 已在另一个工作区检出，不能在这里${meta.step === "update" ? "更新" : "切换"}。`,
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
    case "notFastForward": return { explanation: `${meta.upstream ? shortName(meta.upstream.refName) : "上游"} 不是 ${name} 的后代，不能快进。`, lists: [] };
    case "nameInvalid": return { explanation: "Git 不接受这个分支名。", lists: [] };
    case "nameExists": return { explanation: "已有同名的本地分支，CherryPeek 不会覆盖它。", lists: [] };
    case "bare": return { explanation: "这是 bare 仓库，没有工作区，不能执行这个操作。", lists: [] };
    case "refChanged": return { explanation: `${name} 在此期间已经变化，没有按旧的信息执行。`, lists: [] };
  }
}

function shortName(refName: string): string {
  return refName.replace(/^refs\/(?:heads|remotes)\//u, "");
}

function dirtyTag(entry: { staged: boolean; unstaged: boolean; untracked: boolean }): string {
  const tags = [entry.staged ? "已暂存" : null, entry.unstaged ? "未暂存" : null, entry.untracked ? "未跟踪" : null].filter(Boolean);
  return tags.join(" · ");
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
    handoff: hasKind("diverged") ? "diverged" : hasKind("dirty") || hasKind("inProgress") ? "blocked" : null,
  };
}

/** Hand-off request for a refusal, from the blockers and the facts the renderer already holds. Null when no template fits. */
export function refusalHandoffRequest(blockers: readonly OperationBlocker[], meta: OperationMeta, repository: HandoffOperationRepository, atUnixMs: number): HandoffRequest | null {
  const subject: HandoffOperationSubject = {
    step: meta.step,
    branch: { refName: meta.refName, oid: meta.oid },
    upstream: meta.upstream,
    checkedOutBy: meta.checkedOutBy,
  };
  const diverged = blockers.find((blocker): blocker is OperationBlockerOf<"diverged"> => blocker.kind === "diverged");
  if (diverged) return divergedUpdateRequest(repository, subject, diverged, atUnixMs);
  const dirty = blockers.find((blocker): blocker is OperationBlockerOf<"dirty"> => blocker.kind === "dirty") ?? null;
  const progress = blockers.find((blocker): blocker is OperationBlockerOf<"inProgress"> => blocker.kind === "inProgress");
  if (dirty || progress) return blockedOperationRequest(repository, subject, { dirty, inProgress: progress?.operation ?? null }, atUnixMs);
  return null;
}
