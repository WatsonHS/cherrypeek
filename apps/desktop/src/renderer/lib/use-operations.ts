import * as React from "react";
import type { RepositorySessionStore, RepositoryView } from "./repository-session-store.js";
import type { OperationsStore, OperationsView } from "./operations-store.js";
import type { OperationBlocker } from "../../../../../packages/protocol/src/repository-session.js";
import type { HandoffRequest } from "./handoff-prompt.js";
import { operationFailedRequest } from "./handoff-prompt.js";
import { refusalHandoffRequest } from "./operation-refusal.js";
import {
  canFastForward,
  createBranchMeta,
  createBranchOperation,
  fastForwardMeta,
  fastForwardOperation,
  inlineBlockerMessage,
  refTip,
  switchMeta,
  switchOperation,
  type SwitchTarget,
} from "./operations.js";
import { shortRefName } from "./format.js";

/** What the top bar and menus need to offer the basic operations. Null in `RepositoryActions` when the core lacks them. */
export interface OperationsActions {
  view: OperationsView;
  /** An operation (or the fetch before an update) is running: every entry point is disabled. */
  busy: boolean;
  /** The window's HEAD branch when it is behind its upstream. */
  headBehind: { branch: string; refName: string; upstream: string | null; behind: number; ahead: number; canUpdate: boolean } | null;
  loadSync(refNames: string[]): void;
  /** Fast-forward a local branch to its upstream. The window's own branch is fetched first. */
  update(refName: string): Promise<void>;
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

/** Wires the operations store to the window: sync loading, the one function every entry point runs through, and its follow-up. */
export function useOperations(options: UseOperationsOptions): { actions: OperationsActions | null; view: OperationsView } {
  const { store, sessionStore, view, supported } = options;
  const opsView = React.useSyncExternalStore(store.subscribe, store.getView);
  const latest = React.useRef(options);
  latest.current = options;
  const key = supported ? sessionKeyOf(view) : null;
  const ready = view.state === "ready" && !view.refreshing && !view.scopeSwitching && view.opening === null;
  const headReference = view.repository?.isBare ? null : view.repository?.headReference ?? null;

  React.useEffect(() => { store.bind(key); }, [store, key]);
  // The window's own branch is always wanted: the page switch, the fetch notice and the repository popover show it.
  React.useEffect(() => {
    if (key && ready && headReference) void store.loadSync([headReference]);
  }, [store, key, ready, headReference]);

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
      if (headRef) await store.loadSync([headRef], { force: true });
    };
    /** Runs one operation between begin / end and follows up on how it ended. Returns the outcome. */
    const run = async (label: string, body: () => Promise<Awaited<ReturnType<OperationsStore["execute"]>> | null>) => {
      if (current().fetching || !store.begin(label)) return null;
      try {
        const outcome = await body();
        if (!outcome) return null;
        const headRef = snapshot().repository?.headReference ?? null;
        if (outcome.kind === "done") {
          current().dismissFetchNotice();
          await current().refresh();
          await reread(headRef);
        } else if (outcome.kind === "failed" || outcome.kind === "refChanged") {
          // The real state is what matters now, whatever Git got done.
          await current().refresh();
          await reread(headRef);
        } else if (outcome.kind === "checkFailed") {
          store.setNotice(`没能检查这个操作，仓库未被改动：${outcome.message}`);
        }
        return outcome;
      } finally {
        store.end();
      }
    };
    const headRefName = () => snapshot().repository?.headReference ?? null;

    return {
      view: opsView,
      busy: opsView.running !== null || options.fetching,
      headBehind: null,
      loadSync: names => { void store.loadSync(names); },
      update: async refName => {
        const isHead = headRefName() === refName;
        await run(`更新 ${shortRefName(refName)}`, async () => {
          if (isHead) {
            // The contract has no fetch-first flag: fetch explicitly, refresh, then read the new tips and check against those.
            if (!(await current().fetchAll())) return null;
            store.bind(sessionKeyOf(sessionStore.getView()));
            await store.loadSync([refName], { force: true });
          }
          const sync = store.getView().syncs[refName];
          const operation = sync ? fastForwardOperation(sync) : null;
          if (!sync || !operation) {
            store.setNotice(sync && sync.state === "upToDate" ? `${shortRefName(refName)} 已是最新，没有可更新的提交。`
              : `暂时无法确定 ${shortRefName(refName)} 能否更新，请刷新后再试。`);
            return null;
          }
          return store.execute(operation, fastForwardMeta(sync));
        });
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
        return operationFailedRequest(repository, {
          step: failure.meta.step,
          branch: { refName: failure.meta.refName, oid: failure.meta.oid },
          upstream: failure.meta.upstream,
          checkedOutBy: failure.meta.checkedOutBy,
        }, failure.message, failure.atUnixMs);
      },
    };
    // Dependencies are deliberately the identity of the session and the store view: everything else is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, key, opsView, options.fetching, store, sessionStore]);

  const withHead = React.useMemo<OperationsActions | null>(() => {
    if (!actions) return null;
    const sync = headReference ? opsView.syncs[headReference] : undefined;
    const behind = sync && sync.state === "behind" && sync.behind ? sync : undefined;
    return {
      ...actions,
      headBehind: behind && headReference ? {
        branch: shortRefName(headReference), refName: headReference, upstream: behind.upstream ? shortRefName(behind.upstream.refName) : null,
        behind: behind.behind ?? 0, ahead: behind.ahead ?? 0, canUpdate: canFastForward(behind, true),
      } : null,
    };
  }, [actions, headReference, opsView.syncs]);

  return { actions: withHead, view: opsView };
}
