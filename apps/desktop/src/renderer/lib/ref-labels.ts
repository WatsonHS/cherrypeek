import type { RefInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import { repositoryName as folderName, shortRefName } from "./format.js";

export type RefLabelKind = "head" | "worktree" | "branch" | "tag" | "remote";

export interface RefLabel {
  key: string;
  kind: RefLabelKind;
  /** Visible text: a short ref name, "HEAD" when detached, or a worktree folder name. */
  text: string;
  /** Full description for the tooltip and screen readers. */
  description: string;
  /** Short kind, shown next to the label in the full list, e.g. "本窗口 HEAD" or "标签". */
  kindText: string;
  /** The other worktree's path, for worktree labels. */
  path: string | null;
  /** Remote branches at the same commit folded into this label (short names). */
  remotes: string[];
}

export interface OtherWorktreeHead {
  path: string;
  isMain: boolean;
  headReference: string | null;
}

export interface RefLabelInput {
  refs: RefInfo[];
  /** The window's checked-out branch, or null when HEAD is detached or unborn. */
  headReference: string | null;
  /** True when the window's HEAD points at this commit. */
  isHeadCommit: boolean;
  /** Other worktrees whose HEAD points at this commit. */
  otherWorktrees?: OtherWorktreeHead[];
  /** Fold `origin/x` (and `origin/HEAD` aimed at it) into the local `x` label when they point here too. */
  foldRemotes?: boolean;
}

// Display order: the window's HEAD, branches checked out in other worktrees, other local
// branches, tags, other worktrees' detached HEADs, then remote branches.
const RANK = { head: 0, checkedOut: 1, branch: 2, tag: 3, worktreeHead: 4, remote: 5 } as const;

/** `origin/feature/x` → `feature/x`; null when there is no remote prefix. */
function remoteBranchName(shortName: string): string | null {
  const slash = shortName.indexOf("/");
  return slash > 0 ? shortName.slice(slash + 1) : null;
}

/** Turns the refs and worktree HEADs that point at one commit into labels, most important first. */
export function refLabels({ refs, headReference, isHeadCommit, otherWorktrees = [], foldRemotes = false }: RefLabelInput): RefLabel[] {
  const labels: { label: RefLabel; rank: number; order: number }[] = [];
  const add = (label: Omit<RefLabel, "remotes">, rank: number, order: number): RefLabel => {
    const full = { ...label, remotes: [] };
    labels.push({ label: full, rank, order });
    return full;
  };
  const localByName = new Map<string, RefLabel>();
  const checkedOut = new Map(otherWorktrees.flatMap(worktree => worktree.headReference ? [[worktree.headReference, worktree] as const] : []));
  const isHere = isHeadCommit || (headReference !== null && refs.some(ref => ref.name === headReference));

  if (isHere) {
    const text = headReference ? shortRefName(headReference) : "HEAD";
    const label = add({ key: "HEAD", kind: "head", text, description: headReference ? `本窗口 HEAD：${text}` : "本窗口 HEAD（detached）",
      kindText: headReference ? "本窗口 HEAD" : "本窗口 HEAD · detached", path: null }, RANK.head, 0);
    if (headReference) localByName.set(text, label);
  }

  refs.forEach((ref, order) => {
    const text = shortRefName(ref.name);
    if (ref.kind === "tag") add({ key: ref.name, kind: "tag", text, description: `标签：${text}`, kindText: "标签", path: null }, RANK.tag, order);
    if (ref.kind !== "localBranch" || ref.name === headReference) return;
    const worktree = checkedOut.get(ref.name);
    localByName.set(text, worktree
      ? add({ key: ref.name, kind: "worktree", text, description: `本地分支 ${text}，已在${worktree.isMain ? "主" : ""}工作区 ${folderName(worktree.path)} 检出（${worktree.path}）`,
        kindText: `本地分支 · 在${worktree.isMain ? "主" : ""}工作区 ${folderName(worktree.path)} 检出`, path: worktree.path }, RANK.checkedOut, order)
      : add({ key: ref.name, kind: "branch", text, description: `本地分支：${text}`, kindText: "本地分支", path: null }, RANK.branch, order));
  });

  otherWorktrees.forEach((worktree, order) => {
    if (worktree.headReference && localByName.has(shortRefName(worktree.headReference))) return;
    const name = folderName(worktree.path);
    add({
      key: `worktree:${worktree.path}`, kind: "worktree", text: worktree.headReference ? shortRefName(worktree.headReference) : name,
      description: `${worktree.isMain ? "主" : ""}工作区 ${name} 的 HEAD${worktree.headReference ? `（${shortRefName(worktree.headReference)}）` : "（detached）"}指向这里：${worktree.path}`,
      kindText: `${worktree.isMain ? "主" : ""}工作区 ${name} 的 HEAD${worktree.headReference ? "" : " · detached"}`, path: worktree.path,
    }, RANK.worktreeHead, order);
  });

  // Plain remote branches first, so `origin/HEAD` can follow the branch it points at.
  const remotes = refs.filter(ref => ref.kind === "remoteBranch");
  const remoteByName = new Map<string, RefLabel>();
  for (const ref of [...remotes.filter(ref => !ref.symbolicTarget), ...remotes.filter(ref => ref.symbolicTarget)]) {
    const text = shortRefName(ref.name);
    const local = remoteBranchName(shortRefName(ref.symbolicTarget ?? ref.name));
    const into = !foldRemotes ? undefined
      : (local !== null ? localByName.get(local) : undefined) ?? (ref.symbolicTarget ? remoteByName.get(ref.symbolicTarget) : undefined);
    if (into) {
      into.remotes.push(text);
      continue;
    }
    remoteByName.set(ref.name, add({ key: ref.name, kind: "remote", text, description: `远端分支：${text}`, kindText: "远端分支", path: null }, RANK.remote, refs.indexOf(ref)));
  }

  return labels.sort((a, b) => a.rank - b.rank || a.order - b.order).map(entry => entry.label);
}

/** Tooltip text for one label, including the remotes folded into it. */
export function labelTitle(label: RefLabel): string {
  return label.remotes.length ? `${label.description}\n${label.remotes.join("、")} 也指向这里` : label.description;
}
