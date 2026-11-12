import type { BranchSync, OperationBlocker, RepositoryOperation } from "../../../../../packages/protocol/src/repository-session.js";
import type { RefInfo, RemoteInfo, RepositoryInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import { momentLabel, shortRefName } from "./format.js";

/*
 * Pure parts of the basic Git operations (M5): building operations from the snapshot the window shows,
 * and turning branch sync results into what a scope-picker row displays. The API only ever receives the
 * operation kind, full ref names, full OIDs and the new branch's name.
 */

export type OperationStep = "update" | "switch" | "createBranch";

/** What the user asked for, kept next to the operation so a refusal or failure can name it. */
export interface OperationMeta {
  step: OperationStep;
  /** Full ref name of the branch updated or switched to; for a new branch, `refs/heads/<name>`. */
  refName: string;
  /** Name as the user sees it (`main`, `origin/main`, the new branch's name). */
  name: string;
  /** Tip of `refName` when the operation was built; for a new branch, its start. */
  oid: string;
  upstream: { refName: string; oid: string } | null;
  /** Worktree paths that have the branch checked out. */
  checkedOutBy: string[];
}

export type SwitchTarget = { refName: string } | { remoteRefName: string };

/**
 * Fast-forward `sync.refName` to its upstream, with both tips as last seen. Null unless the branch has an upstream
 * and is behind it or has diverged (a diverged branch is built too, so the core can say why it cannot be updated).
 */
export function fastForwardOperation(sync: BranchSync): RepositoryOperation | null {
  if ((sync.state !== "behind" && sync.state !== "diverged") || !sync.upstream) return null;
  return { kind: "fastForward", refName: sync.refName, expectedOid: sync.oid, upstreamOid: sync.upstream.oid };
}

export function fastForwardMeta(sync: BranchSync): OperationMeta {
  return {
    step: "update", refName: sync.refName, name: shortRefName(sync.refName), oid: sync.oid,
    upstream: sync.upstream ? { refName: sync.upstream.refName, oid: sync.upstream.oid } : null, checkedOutBy: sync.checkedOutBy,
  };
}

/**
 * Switch this window's working tree. `targetOid` is the tip of the target ref in the snapshot and `headOid`
 * the window's HEAD; the core refuses with `refChanged` when either has moved.
 */
export function switchOperation(target: SwitchTarget, targetOid: string, headOid: string): RepositoryOperation {
  return { kind: "switch", target, expectedHeadOid: headOid, expectedOid: targetOid };
}

export function switchMeta(target: SwitchTarget, targetOid: string, checkedOutBy: string[] = []): OperationMeta {
  const refName = "refName" in target ? target.refName : target.remoteRefName;
  return { step: "switch", refName, name: shortRefName(refName), oid: targetOid, upstream: null, checkedOutBy };
}

export function createBranchOperation(name: string, startOid: string, switchAfter: boolean, headOid: string): RepositoryOperation {
  return { kind: "createBranch", name, startOid, switchAfter, expectedHeadOid: headOid };
}

export function createBranchMeta(name: string, startOid: string): OperationMeta {
  return { step: "createBranch", refName: `refs/heads/${name}`, name, oid: startOid, upstream: null, checkedOutBy: [] };
}

/** Whether fast-forwarding is offered: plainly behind, and not checked out in some other worktree. */
export function canFastForward(sync: BranchSync | undefined, isWindowHead: boolean): sync is BranchSync {
  return Boolean(sync && sync.state === "behind" && sync.upstream && (isWindowHead || sync.checkedOutBy.length === 0));
}

export type SyncRowAction = "update" | "diverged" | "noUpstream" | null;

export interface SyncRowModel {
  /** `↓N`, when behind. */
  behind: number | null;
  /** `↑N`, when ahead. */
  ahead: number | null;
  action: SyncRowAction;
  /** Short upstream name, e.g. `origin/main`. */
  upstream: string | null;
}

/** What the row shows; null (nothing) when the result is missing or `unavailable` - never a guess. */
export function syncRowModel(sync: BranchSync | undefined, isWindowHead: boolean): SyncRowModel | null {
  if (!sync || sync.state === "unavailable") return null;
  const upstream = sync.upstream ? shortRefName(sync.upstream.refName) : null;
  if (sync.state === "noUpstream") return { behind: null, ahead: null, action: "noUpstream", upstream };
  const behind = sync.behind && sync.behind > 0 ? sync.behind : null;
  const ahead = sync.ahead && sync.ahead > 0 ? sync.ahead : null;
  const action: SyncRowAction = sync.state === "diverged" ? "diverged" : canFastForward(sync, isWindowHead) ? "update" : null;
  return { behind, ahead, action, upstream };
}

/** Tooltip of the ↓ / ↑ tags: what they are measured against and how old the remote-tracking refs are. */
export function syncTooltip(upstream: string | null, lastFetchUnixMs: number | null | undefined, now = new Date()): string {
  const fetched = lastFetchUnixMs ? `上次 fetch ${momentLabel(lastFetchUnixMs, now)}` : "上次 fetch 时间未知";
  return `${upstream ? `相对 ${upstream}，` : ""}来自本地引用，${fetched}`;
}

/** The sync of the window's HEAD branch, if it is known. */
export function headSync(repository: RepositoryInfo | null, syncs: Record<string, BranchSync>): BranchSync | undefined {
  return repository?.headReference ? syncs[repository.headReference] : undefined;
}

/** Branch sync lookups are batched at most this many names per call. */
export const BRANCH_SYNC_BATCH = 50;

/** Local branches whose sync is not known yet, at most one batch. */
export function missingSyncNames(candidates: readonly string[], known: Record<string, BranchSync>, pending: ReadonlySet<string>): string[] {
  return candidates.filter(name => known[name] === undefined && !pending.has(name)).slice(0, BRANCH_SYNC_BATCH);
}

/** The remote whose web page can be opened, if any remote has a recognised address. */
export function webRemote(remotes: readonly RemoteInfo[] | undefined): { name: string; webUrl: string } | null {
  for (const remote of remotes ?? []) if (remote.webUrl) return { name: remote.name, webUrl: remote.webUrl };
  return null;
}

/** `github.com/owner/repo` for display; the raw `https://` form is only ever opened by the main process. */
export function webUrlLabel(webUrl: string): string {
  return webUrl.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
}

/** Tip of a ref as the snapshot shows it (branches point at commits; tags would be peeled). */
export function refTip(ref: RefInfo): string {
  return ref.peeledOid ?? ref.oid;
}

const IN_PROGRESS_NAMES: Record<string, string> = {
  merge: "合并（merge）",
  rebase: "变基（rebase）",
  cherryPick: "cherry-pick",
  revert: "revert",
  bisect: "二分查找（bisect）",
  sequencer: "多步操作（sequencer）",
};

export function inProgressName(operation: string): string {
  return IN_PROGRESS_NAMES[operation] ?? operation;
}

/** Blocker kinds shown under the name field of the new-branch dialog rather than in a refusal dialog. */
export const INLINE_BLOCKERS: readonly OperationBlocker["kind"][] = ["nameExists", "nameInvalid"];

export function inlineBlockerMessage(blockers: readonly OperationBlocker[]): string | null {
  if (blockers.some(blocker => blocker.kind === "nameInvalid")) return "Git 不接受这个分支名";
  if (blockers.some(blocker => blocker.kind === "nameExists")) return "已有同名的本地分支";
  return null;
}
