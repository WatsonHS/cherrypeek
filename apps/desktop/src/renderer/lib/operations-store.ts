import type {
  BranchSync,
  OperationBlocker,
  OperationCheck,
  OperationRun,
  RepositoryOperation,
  RepositorySessionApi,
  RepositorySessionResult,
} from "../../../../../packages/protocol/src/repository-session.js";
import { BRANCH_SYNC_BATCH, INLINE_BLOCKERS, type OperationMeta, type UpdateNotice } from "./operations.js";

/*
 * State of the basic Git operations (M5): branch sync results for the current session generation, the one
 * operation in progress, and the refusal or failure waiting to be shown. Every answer carries the epoch or
 * token it was asked under; an answer for an older generation or a superseded request is dropped.
 */

export type OperationsApi = Pick<RepositorySessionApi, "getBranchSync" | "checkOperation" | "runOperation">;

export interface PendingRefusal {
  id: number;
  meta: OperationMeta;
  blockers: OperationBlocker[];
  /** The operation that was refused; absent when the refusal did not come from a check or a run. */
  operation?: RepositoryOperation;
  /** Known only when the refusal came from `checkOperation`. */
  preservedDirtyCount?: number;
  atUnixMs: number;
}

export interface PendingFailure {
  id: number;
  meta: OperationMeta;
  /** Git's own output, shown as plain text. */
  message: string;
  atUnixMs: number;
}

export interface OperationsView {
  /** `repoId:generation` the sync results belong to. */
  sessionKey: string | null;
  /** Local branches by full ref name. Absent means unknown, not "in sync". */
  syncs: Record<string, BranchSync>;
  lastFetchUnixMs: number | null;
  syncLoading: boolean;
  /** The operation in progress (only one at a time); `label` is for the control that triggered it. */
  running: { label: string } | null;
  refusal: PendingRefusal | null;
  failure: PendingFailure | null;
  /** A short remark for the user, e.g. that the branch changed in the meantime. */
  notice: string | UpdateNotice | null;
}

export type ExecuteOutcome =
  | { kind: "done"; run: Extract<OperationRun, { outcome: "done" }> }
  /** `shown` is false for blockers the caller handles inline (name problems). */
  | { kind: "rejected"; blockers: OperationBlocker[]; shown: boolean }
  /** The snapshot the operation was built from is out of date; refresh and let the user look again. */
  | { kind: "refChanged" }
  /** The check itself failed. Nothing ran. */
  | { kind: "checkFailed"; message: string }
  /** Git failed after the operation started. The repository may have changed. */
  | { kind: "failed"; message: string }
  | { kind: "busy" }
  | { kind: "stale" };

const initialView = (): OperationsView => ({
  sessionKey: null, syncs: {}, lastFetchUnixMs: null, syncLoading: false, running: null, refusal: null, failure: null, notice: null,
});

async function settle<T>(promise: Promise<RepositorySessionResult<T>>): Promise<RepositorySessionResult<T>> {
  try {
    return await promise;
  } catch (error) {
    return { ok: false, error: { code: "PROTOCOL_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false } };
  }
}

const SYNC_RETRY_DELAYS_MS = [400, 1_200, 3_000, 6_000];
const CHECK_RETRY_DELAYS_MS = [120, 300, 700];

export class OperationsStore {
  private view = initialView();
  private readonly listeners = new Set<() => void>();
  /** Bumped whenever the session generation changes: answers from an earlier epoch are dropped. */
  private epoch = 0;
  /** Names asked in this epoch, so scrolling does not ask again; cleared with the epoch. */
  private readonly attempted = new Set<string>();
  /** The newest request per ref; an older answer for the same ref is dropped. */
  private readonly latest = new Map<string, number>();
  private requests = 0;
  private pending = 0;
  private ids = 0;

  constructor(private readonly api: OperationsApi, private readonly now: () => number = () => Date.now()) {}

  getView = (): OperationsView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(next: Partial<OperationsView>): void {
    this.view = { ...this.view, ...next };
    for (const listener of [...this.listeners]) listener();
  }

  /** Follows the session generation. A new one forgets every branch sync result and ignores answers still on the way. */
  bind(sessionKey: string | null): void {
    if (sessionKey === this.view.sessionKey) return;
    this.reset(sessionKey);
  }

  /** Forgets every branch sync result even though the generation is the same, e.g. after an operation moved refs. */
  invalidate(): void {
    this.reset(this.view.sessionKey);
  }

  private reset(sessionKey: string | null): void {
    this.epoch += 1;
    this.attempted.clear();
    this.latest.clear();
    this.pending = 0;
    this.update({ sessionKey, syncs: {}, lastFetchUnixMs: null, syncLoading: false, refusal: null });
  }

  /** Whether sync for this branch has been asked for (or answered) in this generation. */
  isKnownOrAsked(refName: string): boolean {
    return this.attempted.has(refName);
  }

  /**
   * Reads branch sync for local branches, in batches of at most 50. Names already asked for in this generation are
   * skipped unless `force` is set (used for the window's HEAD branch after a refresh or fetch). A failed read or an
   * `unavailable` result leaves the branch without any claim.
   */
  async loadSync(refNames: readonly string[], options: { force?: boolean; attempt?: number; waitForRetry?: boolean } = {}): Promise<void> {
    if (!this.view.sessionKey) return;
    const names = [...new Set(refNames)].filter(name => options.force || !this.attempted.has(name));
    for (let offset = 0; offset < names.length; offset += BRANCH_SYNC_BATCH) {
      const batch = names.slice(offset, offset + BRANCH_SYNC_BATCH);
      const epoch = this.epoch;
      const token = ++this.requests;
      for (const name of batch) { this.attempted.add(name); this.latest.set(name, token); }
      this.pending += 1;
      this.update({ syncLoading: true });
      const result = await settle(this.api.getBranchSync({ refNames: batch }));
      if (epoch !== this.epoch) return;
      this.pending -= 1;
      if (!result.ok) {
        // Not answered is not "asked": the names may be requested again. Right after a refresh the read slots
        // are often taken (BUSY), so a retryable failure is tried again a few times instead of leaving the
        // branch without its ahead / behind for the rest of the generation.
        for (const name of batch) if (this.latest.get(name) === token) this.attempted.delete(name);
        this.update({ syncLoading: this.pending > 0 });
        const attempt = options.attempt ?? 0;
        if (result.error.retryable && attempt < SYNC_RETRY_DELAYS_MS.length) {
          const retry = async () => {
            if (epoch === this.epoch) await this.loadSync(batch.filter(name => !this.attempted.has(name)), { ...options, attempt: attempt + 1 });
          };
          // A user-triggered update needs the answer before it can decide whether to fast-forward.
          if (options.waitForRetry) {
            await new Promise(resolve => setTimeout(resolve, SYNC_RETRY_DELAYS_MS[attempt]));
            await retry();
          } else setTimeout(() => { void retry(); }, SYNC_RETRY_DELAYS_MS[attempt]);
        }
        continue;
      }
      const syncs = { ...this.view.syncs };
      for (const branch of result.value.branches) {
        if (this.latest.get(branch.refName) !== token) continue;
        if (branch.state === "unavailable") delete syncs[branch.refName];
        else syncs[branch.refName] = branch;
      }
      this.update({ syncs, lastFetchUnixMs: result.value.lastFetchUnixMs ?? this.view.lastFetchUnixMs, syncLoading: this.pending > 0 });
    }
  }

  /** Marks an operation as in progress. Returns false when one is already running: only one at a time. */
  begin(label: string): boolean {
    if (this.view.running) return false;
    this.update({ running: { label }, refusal: null, failure: null, notice: null });
    return true;
  }

  end(): void {
    if (this.view.running) this.update({ running: null });
  }

  private async settleCheck(key: string, operation: RepositoryOperation): Promise<RepositorySessionResult<OperationCheck> | null> {
    let check = await settle(this.api.checkOperation(operation));
    for (const delay of CHECK_RETRY_DELAYS_MS) {
      if (key !== this.view.sessionKey) return null;
      if (check.ok || !check.error.retryable) break;
      await new Promise(resolve => setTimeout(resolve, delay));
      if (key !== this.view.sessionKey) return null;
      check = await settle(this.api.checkOperation(operation));
    }
    return key === this.view.sessionKey ? check : null;
  }

  /**
   * Checks the operation and, when allowed, runs it. Call between `begin` and `end`. Rejections become the pending
   * refusal (unless the caller handles `inline` blockers itself); a failure after the run started becomes the pending
   * failure. A write is never retried.
   */
  async execute(operation: RepositoryOperation, meta: OperationMeta, options: { inline?: boolean } = {}): Promise<ExecuteOutcome> {
    const key = this.view.sessionKey;
    if (!key) return { kind: "stale" };
    const check = await this.settleCheck(key, operation);
    if (!check) return { kind: "stale" };
    if (!check.ok) return { kind: "checkFailed", message: check.error.message };
    if (!check.value.allowed) return this.reject(check.value.blockers, meta, options.inline === true, check.value.preservedDirtyCount, operation);
    const run = await settle(this.api.runOperation(operation));
    if (key !== this.view.sessionKey) return { kind: "stale" };
    if (!run.ok) {
      // The core may have started writing: show Git's text and let the caller re-read the real state.
      this.update({ failure: { id: ++this.ids, meta, message: run.error.message, atUnixMs: this.now() } });
      return { kind: "failed", message: run.error.message };
    }
    if (run.value.outcome === "rejected") return this.reject(run.value.blockers, meta, options.inline === true, undefined, operation);
    return { kind: "done", run: run.value };
  }

  /** Read-only: whether the operation could run now. Used where only the blockers are wanted (a hand-off). */
  async check(operation: RepositoryOperation): Promise<{ kind: "allowed" } | { kind: "blocked"; blockers: OperationBlocker[] } | { kind: "error"; message: string } | { kind: "stale" }> {
    const key = this.view.sessionKey;
    if (!key) return { kind: "stale" };
    const check = await this.settleCheck(key, operation);
    if (!check) return { kind: "stale" };
    if (!check.ok) return { kind: "error", message: check.error.message };
    return check.value.allowed ? { kind: "allowed" } : { kind: "blocked", blockers: check.value.blockers };
  }

  private reject(blockers: OperationBlocker[], meta: OperationMeta, inline: boolean, preservedDirtyCount: number | undefined, operation?: RepositoryOperation): ExecuteOutcome {
    if (blockers.some(blocker => blocker.kind === "refChanged")) {
      const pendingReplacement = operation?.kind === "fastForward" && (operation.replaceUntracked || operation.discardUntracked);
      this.update({ notice: pendingReplacement
        ? "分支或同名文件已变化，请重新检查更新。"
        : `${meta.name} 在此期间已经变化，已刷新到最新状态；请重新查看后再试。` });
      return { kind: "refChanged" };
    }
    if (inline && blockers.length > 0 && blockers.every(blocker => INLINE_BLOCKERS.includes(blocker.kind))) return { kind: "rejected", blockers, shown: false };
    this.update({ refusal: { id: ++this.ids, meta, blockers, operation, preservedDirtyCount, atUnixMs: this.now() } });
    return { kind: "rejected", blockers, shown: true };
  }

  setNotice(notice: string | UpdateNotice | null): void { this.update({ notice }); }
  /** Record a failure produced by a specialized transport path (such as pushRepository). */
  recordFailure(meta: OperationMeta, message: string): void {
    this.update({ failure: { id: ++this.ids, meta, message, atUnixMs: this.now() } });
  }
  /** Surface a blocker already reported by the core's branch-sync query, without inventing an operation target. */
  refuse(blockers: OperationBlocker[], meta: OperationMeta): ExecuteOutcome { return this.reject(blockers, meta, false, undefined); }
  dismissRefusal(): void { if (this.view.refusal) this.update({ refusal: null }); }
  dismissFailure(): void { if (this.view.failure) this.update({ failure: null }); }
  dismissNotice(): void { if (this.view.notice) this.update({ notice: null }); }
}
