import * as React from "react";
import type { RepositorySessionStore, RepositoryView } from "./repository-session-store.js";
import type { OperationsStore, OperationsView } from "./operations-store.js";
import type {
  MergePreviewResult,
  MergeSyncMode,
  OperationBlocker,
  PreviewMergeParams,
  RepositorySessionApi,
  RepositorySessionResult,
  ResolvedMergeFile,
} from "../../../../../packages/protocol/src/repository-session.js";
import type { RemoteInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { HandoffRequest } from "./handoff-prompt.js";
import { operationFailedRequest, pushFailedRequest } from "./handoff-prompt.js";
import { refusalHandoffRequest } from "./operation-refusal.js";
import {
  canFastForward,
  canPush,
  completeMergeMeta,
  completeMergeOperation,
  createBranchMeta,
  createBranchOperation,
  deleteBranchDoneNotice,
  deleteBranchMeta,
  deleteBranchOperation,
  fastForwardMergeMeta,
  fastForwardMergeOperation,
  fastForwardMeta,
  fastForwardOperation,
  inlineBlockerMessage,
  mergeDoneNotice,
  mergeSyncDoneNotice,
  pushDoneNotice,
  pushMeta,
  refTip,
  switchMeta,
  switchOperation,
  untrackedReplacePlan,
  updateDoneNotice,
  withUntrackedReplace,
  workspaceCommitDoneNotice,
  workspaceCommitMeta,
  workspaceCommitOperation,
  workspaceDiscardMeta,
  workspaceDiscardOperation,
  workspaceStageMeta,
  workspaceStageOperation,
  workspaceUnstageMeta,
  workspaceUnstageOperation,
  type SwitchTarget,
  type UntrackedChoice,
} from "./operations.js";
import { batchRecordFromOperation, saveUpdateBatch } from "./update-batch.js";
import { shortRefName } from "./format.js";

export interface HeadPushInfo {
  branch: string;
  refName: string;
  oid: string;
  upstream: string | null;
  remote: string | null;
  ahead: number;
  setUpstream: boolean;
}

export interface PushProgressState {
  refName: string;
  remote: string | null;
  startedAt: number;
  phase: "pushing" | "refreshing";
}

/** What the top bar and menus need to offer the basic operations. Null in `RepositoryActions` when the core lacks them. */
export interface OperationsActions {
  view: OperationsView;
  /** An operation (or the fetch before an update, or a push) is running: every entry point is disabled. */
  busy: boolean;
  /** The window's HEAD branch when it is behind its upstream. */
  headBehind: { branch: string; refName: string; upstream: string | null; behind: number; ahead: number; canUpdate: boolean } | null;
  /** The window's HEAD branch when it can push (ahead of upstream) or publish to a configured remote. */
  headPush: HeadPushInfo | null;
  /** Live progress for an in-flight push, if one is running. */
  pushState: PushProgressState | null;
  loadSync(refNames: string[]): void;
  /** Fast-forward a local branch to its upstream. The window's own branch is fetched first. */
  update(refName: string, options?: { currentWorktreeOnly?: boolean }): Promise<void>;
  /** Apply the selected handling of differing untracked files and fast-forward (P5-06). */
  replaceUntrackedAndUpdate(choice: UntrackedChoice): Promise<void>;
  /** Non-force push of a local branch (or initial publish with --set-upstream). */
  pushBranch(refName: string, options?: { remote?: string | null; setUpstream?: boolean }): Promise<void>;
  /** Abort the currently running push request. */
  cancelPush(): void;
  /** Delete an ancestor-merged local branch not checked out in any worktree. */
  deleteBranch(refName: string, expectedOid: string, baseRefName: string): Promise<void>;
  /** Fast-forward merge `sourceRef` into `targetRef`, optionally switching to `targetRef`. */
  fastForwardMerge(
    targetRef: string,
    expectedTargetOid: string,
    sourceRef: string,
    expectedSourceOid: string,
    switchToTarget: boolean,
  ): Promise<boolean>;
  /** M8: read-only three-way merge preview in isolated temporary objects. */
  previewMerge(params: PreviewMergeParams): Promise<RepositorySessionResult<MergePreviewResult>>;
  /** M8: complete a clean merge, single-commit rebase, or resolved 3-pane merge atomically (optionally pushing afterwards). */
  completeMerge(params: {
    targetRef: string;
    expectedTargetOid: string;
    sourceRef: string;
    expectedSourceOid: string;
    expectedHeadOid: string | null;
    mode: MergeSyncMode;
    message: string;
    resolvedFiles: ResolvedMergeFile[];
    switchToTarget: boolean;
    pushAfter?: boolean;
    pushRemote?: string | null;
  }): Promise<boolean>;
  /** Stage specific workspace paths (by rawHex) or all changes. */
  stagePaths(pathsHex: string[], all?: boolean): Promise<boolean>;
  /** Unstage specific workspace paths (by rawHex) or all staged changes. */
  unstagePaths(pathsHex: string[], all?: boolean): Promise<boolean>;
  /** Discard one unstaged or untracked path after confirmation. */
  discardPath(pathHex: string, untracked: boolean, displayPath: string, expectedHeadOid: string | null): Promise<boolean>;
  /** Commit staged workspace changes with the given message. */
  commitWorkspace(message: string, expectedHeadOid: string | null): Promise<{ committed: boolean; committedOid: string | null }>;
  /** Switch this window's working tree to a local branch, or to a new tracking branch for a remote one. */
  switchTo(target: SwitchTarget): Promise<void>;
  /** Create a branch. `error` is set when the dialog should stay open with a message under the name. */
  createBranch(name: string, startOid: string, switchAfter: boolean): Promise<{ close: boolean; error?: string }>;
  /** Diverged branch: check, then hand the facts to an agent without showing the refusal first. */
  handoffDiverged(refName: string): Promise<void>;
  openRemote(target: { commit: string } | { branch: string }): Promise<void>;
  /** The hand-off request for the refusal on screen, if a template fits. */
  refusalHandoff(): HandoffRequest | null;
  failureHandoff(): HandoffRequest | null;
}

export interface UseOperationsOptions {
  store: OperationsStore;
  sessionStore: RepositorySessionStore;
  view: RepositoryView;
  supported: boolean;
  remotes?: readonly RemoteInfo[];
  pushRepository?: RepositorySessionApi["pushRepository"];
  previewMerge?: RepositorySessionApi["previewMerge"];
  cancelOperation?: () => Promise<unknown>;
  /** Fetch every remote and refresh the snapshot; true when it succeeded. */
  fetchAll(): Promise<boolean>;
  fetching: boolean;
  refresh(): Promise<void>;
  /** The working tree may have changed: read its status again. */
  afterChange(): void;
  dismissFetchNotice(): void;
  openHandoff(request: HandoffRequest): void;
}

const sessionKeyOf = (view: Pick<RepositoryView, "session">) => view.session ? `${view.session.repoId}:${view.session.generation}` : null;

function remoteNameFromRef(refName: string | null | undefined): string | null {
  if (!refName?.startsWith("refs/remotes/")) return null;
  return refName.slice("refs/remotes/".length).split("/", 1)[0] ?? null;
}

/** Wires the operations store to the window: sync loading, the one function every entry point runs through, and its follow-up. */
export function useOperations(options: UseOperationsOptions): { actions: OperationsActions | null; view: OperationsView } {
  const { store, sessionStore, view, supported, remotes = [] } = options;
  const opsView = React.useSyncExternalStore(store.subscribe, store.getView);
  const latest = React.useRef(options);
  latest.current = options;
  const pushCancelledRef = React.useRef(false);
  const pushBusyRef = React.useRef(false);
  const [pushState, setPushState] = React.useState<PushProgressState | null>(null);
  const key = supported ? sessionKeyOf(view) : null;
  const ready = view.state === "ready" && !view.refreshing && !view.scopeSwitching && view.opening === null;
  const headReference = view.repository?.isBare ? null : view.repository?.headReference ?? null;

  React.useEffect(() => { store.bind(key); }, [store, key]);
  React.useEffect(() => {
    pushCancelledRef.current = false;
  }, [key]);
  // The window's own branch is always wanted: the page switch, the fetch notice and the repository popover show it.
  React.useEffect(() => {
    if (key && ready && headReference && !opsView.running) void store.loadSync([headReference]);
  }, [store, key, ready, headReference, opsView.running]);

  const actions = React.useMemo<OperationsActions | null>(() => {
    if (!supported || !key) return null;
    const current = () => latest.current;
    const snapshot = () => {
      const live = sessionStore.getView();
      return { repository: live.repository, refs: live.navigation?.refs ?? live.refs, navigation: live.navigation };
    };
    const reread = async (headRef: string | null) => {
      // The refresh replaced the session; follow it now rather than waiting for the next render.
      store.bind(sessionKeyOf(sessionStore.getView()));
      store.invalidate();
      current().afterChange();
      if (headRef) await store.loadSync([headRef], { force: true, waitForRetry: true });
    };
    /** Runs one operation between begin / end and follows up on how it ended. Returns the outcome. */
    const run = async (
      label: string,
      body: () => Promise<Awaited<ReturnType<OperationsStore["execute"]>> | null>,
      optionsArg: { refreshSession?: boolean; deletedBranchRef?: string } = {},
    ) => {
      if (current().fetching || pushBusyRef.current || !store.begin(label)) return null;
      const refreshSession = optionsArg.refreshSession ?? true;
      try {
        const outcome = await body();
        if (!outcome) return null;
        const headRef = snapshot().repository?.headReference ?? null;
        if (outcome.kind === "done") {
          current().dismissFetchNotice();
          if (optionsArg.deletedBranchRef) {
            const activeScope = sessionStore.getView().session?.scope;
            if (activeScope && typeof activeScope === "object" && "ref" in activeScope && activeScope.ref === optionsArg.deletedBranchRef) {
              await sessionStore.switchScope("head");
              await reread(headRef);
              return outcome;
            }
          }
          if (refreshSession) {
            await current().refresh();
            await reread(headRef);
          } else {
            current().afterChange();
          }
        } else if (outcome.kind === "failed" || outcome.kind === "refChanged") {
          // The real state is what matters now, whatever Git got done.
          if (refreshSession || outcome.kind === "refChanged") {
            await current().refresh();
            await reread(headRef);
          } else {
            current().afterChange();
          }
        } else if (outcome.kind === "checkFailed") {
          store.setNotice(`没能检查这个操作，仓库未被改动：${outcome.message}`);
        }
        return outcome;
      } finally {
        store.end();
      }
    };
    const headRefName = () => snapshot().repository?.headReference ?? null;
    const doPushBranch = async (
      refName: string,
      pushOptions: { remote?: string | null; setUpstream?: boolean } = {},
    ): Promise<void> => {
      if (current().fetching || pushBusyRef.current) return;
      const pushApi = current().pushRepository ?? (typeof window !== "undefined" ? window.commitScope?.pushRepository : undefined);
      if (!pushApi) {
        store.setNotice("当前内核不支持推送操作。");
        return;
      }
      const { refs, navigation } = snapshot();
      const sync = store.getView().syncs[refName];
      const ref = refs.find(item => item.name === refName);
      const expectedOid = sync?.oid ?? (ref ? refTip(ref) : null);
      if (!expectedOid) {
        store.setNotice("找不到这个分支的最新位置，请刷新后再试。");
        return;
      }
      const availableRemotes = current().remotes ?? [];
      const preferredRemote = availableRemotes.find(item => item.name === "origin")?.name ?? availableRemotes[0]?.name ?? null;
      const remote = pushOptions.remote ?? remoteNameFromRef(sync?.upstream?.refName) ?? (sync?.upstream ? null : preferredRemote);
      const setUpstream = pushOptions.setUpstream ?? !sync?.upstream;
      if (!sync?.upstream && !remote) {
        store.setNotice("没有可发布的远端配置。");
        return;
      }
      if (!store.begin(`推送 ${shortRefName(refName)}`)) return;
      pushBusyRef.current = true;
      pushCancelledRef.current = false;
      const holders = sync?.checkedOutBy ?? (navigation?.worktrees ?? []).filter(item => item.headReference === refName).map(item => item.path);
      const meta = pushMeta(refName, expectedOid, sync?.upstream ? { refName: sync.upstream.refName, oid: sync.upstream.oid } : null, remote, holders);
      setPushState({ refName, remote, startedAt: Date.now(), phase: "pushing" });
      try {
        const result = await pushApi({ refName, expectedOid, remote, setUpstream })
          .catch((error: unknown) => ({
            ok: false as const,
            error: { code: "PROTOCOL_ERROR" as const, message: error instanceof Error ? error.message : String(error), retryable: false },
          }));
        if (!result.ok) {
          if (result.error.code === "CANCELLED" || pushCancelledRef.current) {
            store.setNotice("已取消推送；正在刷新本地视图。");
          } else {
            store.recordFailure(meta, result.error.message);
          }
          setPushState(prev => prev ? { ...prev, phase: "refreshing" } : null);
          await current().refresh();
          await reread(headRefName());
          return;
        }
        if (result.value.outcome === "rejected") {
          const outcome = store.refuse(result.value.blockers, meta);
          if (outcome.kind === "refChanged") {
            setPushState(prev => prev ? { ...prev, phase: "refreshing" } : null);
            await current().refresh();
            await reread(headRefName());
          }
          return;
        }
        current().dismissFetchNotice();
        setPushState(prev => prev ? { ...prev, phase: "refreshing" } : null);
        await current().refresh();
        await reread(headRefName());
        store.setNotice(pushDoneNotice(result.value));
      } finally {
        pushCancelledRef.current = false;
        pushBusyRef.current = false;
        setPushState(null);
        store.end();
      }
    };

    return {
      view: opsView,
      busy: opsView.running !== null || pushState !== null || options.fetching,
      headBehind: null,
      headPush: null,
      pushState,
      loadSync: names => { void store.loadSync(names); },
      update: async (refName, updateOptions = {}) => {
        const originalRepository = snapshot().repository;
        const isHead = headRefName() === refName;
        if (updateOptions.currentWorktreeOnly && (!isHead || originalRepository?.isBare || !originalRepository?.headOid)) {
          store.setNotice("当前工作区分支已经变化，请刷新后再试；没有执行更新。");
          return;
        }
        await run(`更新 ${shortRefName(refName)}`, async () => {
          if (isHead) {
            // The contract has no fetch-first flag: fetch explicitly, refresh, then read the new tips and check against those.
            if (!(await current().fetchAll())) return null;
            if (snapshot().repository?.path !== originalRepository?.path || headRefName() !== refName) {
              store.setNotice("Fetch 已完成，但当前工作区或分支已经变化；没有继续更新本地分支。");
              return null;
            }
            store.bind(sessionKeyOf(sessionStore.getView()));
            const syncKey = store.getView().sessionKey;
            await store.loadSync([refName], { force: true, waitForRetry: true });
            if (syncKey !== sessionKeyOf(sessionStore.getView())) return null;
          }
          const sync = store.getView().syncs[refName];
          if (sync?.state === "noUpstream") return store.refuse([{ kind: "noUpstream" }], { ...fastForwardMeta(sync), fetched: isHead });
          const operation = sync ? fastForwardOperation(sync) : null;
          if (!sync || !operation) {
            const name = shortRefName(refName);
            const prefix = isHead ? "Fetch 已完成；" : "";
            store.setNotice(prefix + (sync?.state === "upToDate" ? `${name} 已是最新，没有可更新的提交。`
              : sync?.state === "ahead" ? `${name} 领先上游 ${sync.ahead ?? 0} 个提交，无需快进；本地提交已保留。`
                : `暂时无法确定 ${name} 能否更新，本地分支和工作区未更新；请稍后重试。`));
            return null;
          }
          const outcome = await store.execute(operation, { ...fastForwardMeta(sync), fetched: isHead });
          if (outcome.kind === "done") {
            const activeSession = sessionStore.getView().session;
            const batch = batchRecordFromOperation({
              label: "快进更新",
              branchName: shortRefName(refName),
              updatedRef: outcome.run.updatedRef,
              run: outcome.run,
              fallbackOldOid: sync.oid,
              fallbackNewOid: sync.upstream?.oid,
            });
            if (batch && activeSession) saveUpdateBatch(activeSession.repositoryKey, activeSession.worktreeId, batch);
            store.setNotice(updateDoneNotice(shortRefName(refName), outcome.run, batch ?? undefined));
          }
          if (isHead && outcome.kind === "checkFailed") {
            store.setNotice(`Fetch 已完成；没能检查更新，本地分支和工作区未更新：${outcome.message}`);
            return null;
          }
          return outcome;
        });
      },
      replaceUntrackedAndUpdate: async choice => {
        // `run` clears the refusal, so everything it needs is taken from it first.
        const { refusal } = store.getView();
        const plan = refusal ? untrackedReplacePlan(refusal.blockers, refusal.meta) : null;
        const operation = refusal?.operation && plan ? withUntrackedReplace(refusal.operation, plan.token, choice) : null;
        if (!refusal || !operation) return;
        const { meta } = refusal;
        await run(`更新 ${meta.name}`, async () => {
          if (headRefName() !== meta.refName) {
            store.setNotice("当前工作区分支已经变化，请刷新后再试；没有执行更新，也没有移动任何文件。");
            return null;
          }
          // No second fetch: the operation still names the tips the refusal was about, and the core refuses if they moved.
          const outcome = await store.execute(operation, meta);
          if (outcome.kind === "done") {
            const activeSession = sessionStore.getView().session;
            const batch = batchRecordFromOperation({
              label: "快进更新",
              branchName: meta.name,
              updatedRef: outcome.run.updatedRef,
              run: outcome.run,
              fallbackOldOid: meta.oid,
              fallbackNewOid: meta.upstream?.oid,
            });
            if (batch && activeSession) saveUpdateBatch(activeSession.repositoryKey, activeSession.worktreeId, batch);
            store.setNotice(updateDoneNotice(meta.name, outcome.run, batch ?? undefined));
          }
          return outcome;
        });
      },
      pushBranch: doPushBranch,
      cancelPush: () => {
        pushCancelledRef.current = true;
        const cancelOp = current().cancelOperation ?? (typeof window !== "undefined" ? window.commitScope?.cancelRepositoryOperation : undefined);
        if (cancelOp) void cancelOp().catch(() => undefined);
      },
      deleteBranch: async (refName, expectedOid, baseRefName) => {
        const outcome = await run(`删除分支 ${shortRefName(refName)}`, async () => {
          const sync = store.getView().syncs[refName];
          const meta = deleteBranchMeta(refName, expectedOid, baseRefName, sync?.checkedOutBy ?? []);
          const res = await store.execute(deleteBranchOperation(refName, expectedOid, baseRefName), meta);
          if (res.kind === "done") store.setNotice(deleteBranchDoneNotice(refName));
          return res;
        }, { deletedBranchRef: refName });
        void outcome;
      },
      fastForwardMerge: async (targetRef, expectedTargetOid, sourceRef, expectedSourceOid, switchToTarget) => {
        const outcome = await run(`快进合入 ${shortRefName(targetRef)}`, async () => {
          const holders = (snapshot().navigation?.worktrees ?? []).filter(item => item.headReference === targetRef).map(item => item.path);
          const meta = fastForwardMergeMeta(sourceRef, expectedSourceOid, targetRef, expectedTargetOid, holders);
          const res = await store.execute(fastForwardMergeOperation(targetRef, expectedTargetOid, sourceRef, expectedSourceOid, switchToTarget), meta);
          if (res.kind === "done") {
            const activeSession = sessionStore.getView().session;
            const batch = batchRecordFromOperation({
              label: "快进合入",
              branchName: shortRefName(targetRef),
              updatedRef: res.run.updatedRef,
              run: res.run,
              fallbackOldOid: expectedTargetOid,
              fallbackNewOid: expectedSourceOid,
            });
            if (batch && activeSession) saveUpdateBatch(activeSession.repositoryKey, activeSession.worktreeId, batch);
            const summary = mergeDoneNotice(sourceRef, targetRef, switchToTarget);
            store.setNotice(batch ? { summary, untracked: null, batch } : summary);
          }
          return res;
        });
        return outcome?.kind === "done";
      },
      previewMerge: params => {
        const previewApi = current().previewMerge ?? (typeof window !== "undefined" ? window.commitScope?.previewMerge : undefined);
        if (!previewApi) {
          return Promise.resolve({
            ok: false,
            error: { code: "PROTOCOL_ERROR", message: "当前内核不支持合并预演。", retryable: false },
          });
        }
        return previewApi(params);
      },
      completeMerge: async params => {
        const outcome = await run(`同步 ${shortRefName(params.targetRef)}`, async () => {
          const holders = (snapshot().navigation?.worktrees ?? []).filter(item => item.headReference === params.targetRef).map(item => item.path);
          const meta = completeMergeMeta(params.targetRef, params.expectedTargetOid, params.sourceRef, params.expectedSourceOid, holders);
          const operation = completeMergeOperation(params);
          const res = await store.execute(operation, meta);
          if (res.kind === "done") {
            const activeSession = sessionStore.getView().session;
            const batch = batchRecordFromOperation({
              label: params.mode === "singleCommitRebase" ? "单提交变基" : "合并同步",
              branchName: shortRefName(params.targetRef),
              updatedRef: res.run.updatedRef,
              run: res.run,
              fallbackOldOid: params.expectedTargetOid,
            });
            if (batch && activeSession) saveUpdateBatch(activeSession.repositoryKey, activeSession.worktreeId, batch);
            const summary = mergeSyncDoneNotice(params.targetRef, params.sourceRef, params.mode, params.switchToTarget);
            store.setNotice(batch ? { summary, untracked: null, batch } : summary);
          }
          return res;
        });
        if (outcome?.kind === "done" && params.pushAfter) {
          await doPushBranch(params.targetRef, { remote: params.pushRemote ?? undefined });
        }
        return outcome?.kind === "done";
      },
      stagePaths: async (pathsHex, all = false) => {
        const outcome = await run("暂存改动", async () => {
          return store.execute(workspaceStageOperation(pathsHex, all), workspaceStageMeta(pathsHex.length, all));
        }, { refreshSession: false });
        return outcome?.kind === "done";
      },
      unstagePaths: async (pathsHex, all = false) => {
        const outcome = await run("取消暂存", async () => {
          return store.execute(workspaceUnstageOperation(pathsHex, all), workspaceUnstageMeta(pathsHex.length, all));
        }, { refreshSession: false });
        return outcome?.kind === "done";
      },
      discardPath: async (pathHex, untracked, displayPath, expectedHeadOid) => {
        const outcome = await run(`丢弃 ${displayPath}`, async () => {
          const res = await store.execute(workspaceDiscardOperation(pathHex, untracked, expectedHeadOid), workspaceDiscardMeta(displayPath, expectedHeadOid));
          if (res.kind === "done") store.setNotice(`已丢弃 ${displayPath}`);
          return res;
        }, { refreshSession: false });
        return outcome?.kind === "done";
      },
      commitWorkspace: async (message, expectedHeadOid) => {
        const { repository } = snapshot();
        const outcome = await run("提交已暂存改动", async () => {
          const meta = workspaceCommitMeta(repository?.headReference ?? null, expectedHeadOid ?? repository?.headOid ?? null);
          const res = await store.execute(workspaceCommitOperation(message, expectedHeadOid), meta);
          if (res.kind === "done") store.setNotice(workspaceCommitDoneNotice(res.run.committedOid));
          return res;
        });
        return outcome?.kind === "done"
          ? { committed: true, committedOid: outcome.run.committedOid ?? null }
          : { committed: false, committedOid: null };
      },
      switchTo: async target => {
        await run(`切换到 ${shortRefName("refName" in target ? target.refName : target.remoteRefName)}`, async () => {
          const { repository, refs, navigation } = snapshot();
          const refName = "refName" in target ? target.refName : target.remoteRefName;
          const ref = refs.find(item => item.name === refName);
          if (!repository?.headOid || !ref) { store.setNotice("找不到这个分支的最新位置，请刷新后再试。"); return null; }
          const holders = "refName" in target ? (navigation?.worktrees ?? []).filter(item => item.headReference === refName).map(item => item.path) : [];
          return store.execute(switchOperation(target, refTip(ref), repository.headOid), switchMeta(target, refTip(ref), holders));
        });
      },
      createBranch: async (name, startOid, switchAfter) => {
        let inline: string | undefined;
        const outcome = await run(`新建分支 ${name}`, async () => {
          const headOid = snapshot().repository?.headOid;
          if (!headOid) { inline = "空仓库还不能新建分支"; return null; }
          const result = await store.execute(createBranchOperation(name, startOid, switchAfter, headOid), createBranchMeta(name, startOid), { inline: true });
          if (result.kind === "rejected" && !result.shown) inline = inlineBlockerMessage(result.blockers) ?? "不能新建这个分支";
          if (result.kind === "checkFailed") inline = `没能检查：${result.message}`;
          return result;
        });
        if (inline) return { close: false, error: inline };
        return { close: outcome !== null };
      },
      handoffDiverged: async refName => {
        const sync = store.getView().syncs[refName];
        const operation = sync ? fastForwardOperation(sync) : null;
        if (!sync || !operation || !store.begin(`检查 ${shortRefName(refName)}`)) return;
        try {
          const result = await store.check(operation);
          if (result.kind === "error") { store.setNotice(`没能检查这个分支：${result.message}`); return; }
          if (result.kind !== "blocked") { store.setNotice(`${shortRefName(refName)} 现在可以更新，不需要交给 Agent。`); return; }
          if (result.blockers.some((blocker: OperationBlocker) => blocker.kind === "refChanged")) {
            store.setNotice(`${shortRefName(refName)} 在此期间已经变化，已刷新到最新状态；请重新查看后再试。`);
            await current().refresh();
            await reread(headRefName());
            return;
          }
          const repository = snapshot().repository;
          const request = repository ? refusalHandoffRequest(result.blockers, fastForwardMeta(sync), repository, Date.now()) : null;
          if (request) current().openHandoff(request);
        } finally {
          store.end();
        }
      },
      openRemote: async target => {
        const result = await window.commitScope.openRemotePage(target).catch((error: unknown) => ({ ok: false as const, error: { message: error instanceof Error ? error.message : String(error) } }));
        if (!result.ok) store.setNotice(`没能打开网页：${result.error.message}`);
        else if (!result.value) store.setNotice("没有可识别的远端网页地址。");
      },
      refusalHandoff: () => {
        const { refusal } = store.getView();
        const repository = snapshot().repository;
        return refusal && repository ? refusalHandoffRequest(refusal.blockers, refusal.meta, repository, refusal.atUnixMs) : null;
      },
      failureHandoff: () => {
        const { failure } = store.getView();
        const repository = snapshot().repository;
        if (!failure || !repository) return null;
        const subject = {
          step: failure.meta.step,
          fetched: failure.meta.fetched,
          branch: failure.meta.refName ? { refName: failure.meta.refName, oid: failure.meta.oid } : null,
          upstream: failure.meta.step === "mergeInto" ? null : failure.meta.upstream,
          target: failure.meta.step === "mergeInto" ? failure.meta.upstream : null,
          remote: failure.meta.remote ?? null,
          checkedOutBy: failure.meta.checkedOutBy,
        };
        if (failure.meta.step === "push") {
          return pushFailedRequest(repository, subject, failure.meta.remote ?? null, failure.message, failure.atUnixMs, false);
        }
        return operationFailedRequest(repository, subject, failure.message, failure.atUnixMs);
      },
    };
    // Dependencies are deliberately the identity of the session and the store view: everything else is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, key, opsView, pushState, options.fetching, store, sessionStore]);

  const withHead = React.useMemo<OperationsActions | null>(() => {
    if (!actions) return null;
    const sync = headReference ? opsView.syncs[headReference] : undefined;
    const behind = sync && sync.state === "behind" && sync.behind ? sync : undefined;
    const preferredRemote = remotes.find(item => item.name === "origin")?.name ?? remotes[0]?.name ?? null;
    const headPush: HeadPushInfo | null = !headReference
      ? null
      : sync && canPush(sync) && sync.upstream
        ? {
          branch: shortRefName(headReference),
          refName: headReference,
          oid: sync.oid,
          upstream: shortRefName(sync.upstream.refName),
          remote: remoteNameFromRef(sync.upstream.refName) ?? preferredRemote,
          ahead: sync.ahead ?? 1,
          setUpstream: false,
        }
        : sync?.state === "noUpstream" && preferredRemote
          ? {
            branch: shortRefName(headReference),
            refName: headReference,
            oid: sync.oid,
            upstream: null,
            remote: preferredRemote,
            ahead: 0,
            setUpstream: true,
          }
          : null;
    return {
      ...actions,
      headBehind: behind && headReference ? {
        branch: shortRefName(headReference), refName: headReference, upstream: behind.upstream ? shortRefName(behind.upstream.refName) : null,
        behind: behind.behind ?? 0, ahead: behind.ahead ?? 0, canUpdate: canFastForward(behind, true),
      } : null,
      headPush,
    };
  }, [actions, headReference, opsView.syncs, remotes]);

  return { actions: withHead, view: opsView };
}
