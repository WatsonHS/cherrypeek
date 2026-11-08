import type { RepositoryInfo, RepositoryScope } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositoryNavigation } from "../../../../../packages/protocol/src/repository-session.js";
import { shortOid, shortRefName } from "./format.js";

/** What the top bar knows about this window's working tree. */
export type WorkspaceIndicator =
  | { state: "unavailable"; reason: string }
  | { state: "bare" }
  | { state: "loading" }
  | { state: "clean"; observedAtUnixMs: number }
  | { state: "changes"; files: number; conflicts: number; complete: boolean; stale: boolean; observedAtUnixMs: number }
  | { state: "error"; message: string };

export type WorkspaceBadgeKind = "none" | "spinner" | "ok" | "warn" | "bad" | "stale" | "muted";

export interface WorkspaceBadge {
  kind: WorkspaceBadgeKind;
  text: string;
  /** Spoken name of the switch item, e.g. "工作区：main，有 5 个文件改动". */
  ariaLabel: string;
  /** Hover text: directory, branch, read time and the shortcut. */
  title: string;
  disabled: boolean;
}

/**
 * The branch shown next to "工作区" when the browsing scope is not the branch the
 * working tree is on. Returns null when they match, so the label stays short.
 */
export function workspaceBranchLabel(scope: RepositoryScope | undefined, repository: RepositoryInfo,
  navigation: RepositoryNavigation | null): string | null {
  if (repository.isBare) return null;
  const head = repository.headReference ? shortRefName(repository.headReference) : repository.headOid ? shortOid(repository.headOid) : null;
  if (!head || !scope || scope === "head") return null;
  if (typeof scope === "object" && "ref" in scope && scope.ref === repository.headReference) return null;
  if (typeof scope === "object" && "worktree" in scope && navigation?.worktrees.some(item => item.id === scope.worktree && item.isCurrent)) return null;
  return head;
}

export function workspaceHeadText(repository: RepositoryInfo): string {
  if (repository.headReference) return shortRefName(repository.headReference);
  if (repository.headOid) return `detached ${shortOid(repository.headOid)}`;
  return "尚无提交";
}

function clock(unixMs: number): string {
  return new Date(unixMs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function workspaceBadge(indicator: WorkspaceIndicator, repository: RepositoryInfo, branchLabel: string | null,
  shortcut = "⌘3"): WorkspaceBadge {
  const where = `本窗口工作区 ${workspaceHeadText(repository)}`;
  const spokenBranch = branchLabel ? `：${branchLabel}` : "";
  switch (indicator.state) {
    case "bare":
      return { kind: "none", text: "", ariaLabel: "工作区：bare 仓库没有工作区", title: "bare 仓库没有工作区", disabled: true };
    case "unavailable":
      return { kind: "none", text: "", ariaLabel: `工作区${spokenBranch}，状态尚未读取`, title: `${where} · ${indicator.reason}（${shortcut}）`, disabled: false };
    case "loading":
      return { kind: "spinner", text: "", ariaLabel: `工作区${spokenBranch}，正在读取`, title: `${where} · 正在读取…（${shortcut}）`, disabled: false };
    case "error":
      return { kind: "muted", text: "?", ariaLabel: `工作区${spokenBranch}，状态未知：读取失败`, title: `${where} · 状态未知：${indicator.message}（${shortcut}）`, disabled: false };
    case "clean":
      return { kind: "ok", text: "", ariaLabel: `工作区${spokenBranch}，工作区干净`, title: `${where} · 工作区干净 · ${clock(indicator.observedAtUnixMs)} 读取（${shortcut}）`, disabled: false };
    case "changes": {
      const count = `${indicator.files}${indicator.complete ? "" : "+"}`;
      const amount = indicator.complete ? `${indicator.files} 个文件改动` : `至少 ${indicator.files} 个文件改动`;
      const conflicts = indicator.conflicts > 0 ? `${indicator.conflicts} 个冲突，` : "";
      const when = indicator.stale ? `${clock(indicator.observedAtUnixMs)} 读取，之后又有变化，正在复核` : `${clock(indicator.observedAtUnixMs)} 读取`;
      return {
        kind: indicator.conflicts > 0 ? "bad" : indicator.stale ? "stale" : "warn",
        text: indicator.conflicts > 0 ? `冲突 ${indicator.conflicts}` : count,
        ariaLabel: `工作区${spokenBranch}，${conflicts}有 ${amount}${indicator.stale ? "，可能已过期" : ""}`,
        title: `${where} · ${conflicts}${amount} · ${when}（${shortcut}）`,
        disabled: false,
      };
    }
  }
}
