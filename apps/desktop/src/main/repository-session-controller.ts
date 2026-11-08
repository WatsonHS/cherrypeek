import { isAbsolute } from "node:path";
import type {
  CommitSummary,
  CommitDetails,
  ChangedFilesPage,
  MergeCommitsPage,
  BranchesContainingResult,
  FileDiff,
  WorkspaceDiff,
  WorkspaceFile,
  WorkspaceStatus,
  HistoryCommit,
  RefInfo,
  RepositoryInfo,
  RepositorySessionInfo,
  SearchPage,
  SearchIdentities,
  SearchPaths,
  ActivityStats,
  RepositoryObservation,
  RefSnapshotDiff,
  HandoffFacts,
} from "../../../../packages/protocol/src/generated/server-message.js";
import type { MetadataIndexAction, ListSearchPathsParams, SearchCommitsParams, SearchIdentitiesParams, SearchQuery, GetActivityStatsParams, GetHandoffFactsParams,
  GetCommitParams, ListChangedFilesParams, ReadMergeCommitsParams, BranchesContainingParams, ReadDiffParams,
  ReadWorkspaceStatusParams, ReadWorkspaceDiffParams, ReadWorkspaceFileParams } from "../../../../packages/protocol/src/generated/client-message.js";
import type {
  HistoryPage,
  HistoryDateLocation,
  HistoryPageContent,
  RefreshedRepository,
  RepositoryNavigation,
  RefMergeStatusResult,
  RepositoryScope,
  RecentRepositoriesResult,
  RepositoryViewRecorded,
  SessionPreview,
  MetadataIndexStatus,
} from "../../../../packages/protocol/src/repository-session.js";
import type { CoreStatus } from "../../../../packages/protocol/src/core-status.js";
import type { RequestContext, ServerResponseMessage } from "../../../../packages/protocol/src/messages.js";
import { CoreProcess } from "./core-process.js";
import { ProtocolClientError } from "./protocol-transport.js";

const MAX_PATH_BYTES = 16 * 1024;
const SESSION_TIMEOUT_MS = 20_000;
const MAX_REFS = 2_000;
const MAX_COMMITS = 200;
const MAX_HISTORY_PAGE = 500;

type SessionResponse = Extract<ServerResponseMessage["data"], { section: "repositorySession" }>;
type ViewRecordedResponse = Extract<ServerResponseMessage["data"], { section: "repositoryViewRecorded" }>;
type ClosedResponse = Extract<ServerResponseMessage["data"], { section: "repositoryClosed" }>;
type RecentResponse = Extract<ServerResponseMessage["data"], { section: "recentRepositories" }>;
type SearchPathsResponse = Extract<ServerResponseMessage["data"], { section: "searchPaths" }>;
type ActivityStatsResponse = Extract<ServerResponseMessage["data"], { section: "activityStats" }>;
type RepositoryObservationResponse = Extract<ServerResponseMessage["data"], { section: "repositoryObservation" }>;
type RefSnapshotDiffResponse = Extract<ServerResponseMessage["data"], { section: "refSnapshotDiff" }>;
type HandoffFactsResponse = Extract<ServerResponseMessage["data"], { section: "handoffFacts" }>;
type RepositoryResponse = Extract<ServerResponseMessage["data"], { section: "repository" }>;
type CommitsResponse = Extract<ServerResponseMessage["data"], { section: "commits" }>;
type HistoryDateLocationResponse = Extract<ServerResponseMessage["data"], { section: "historyDateLocation" }>;
type HistoryPageChunk = Omit<HistoryPageContent, "nextCursor">;

interface HistoryPageAccumulator {
  commits: HistoryCommit[];
  metadata: string;
  page?: HistoryPageChunk;
  sawTerminalPage: boolean;
}

interface ActiveOpen {
  abort: AbortController;
  done: Promise<void>;
}

interface ActiveHistoryRead {
  abort: AbortController;
  done: Promise<HistoryPage | HistoryDateLocation>;
}

interface ActiveRefresh {
  abort: AbortController;
  done: Promise<RefreshedRepository>;
}

interface ActiveMergeStatus {
  abort: AbortController;
  done: Promise<RefMergeStatusResult>;
}

interface ActiveMetadataIndexRequest {
  kind: "status" | "control";
  abort?: AbortController;
  done: Promise<MetadataIndexStatus>;
}

interface ActiveSearchRequest {
  kind: "commits" | "identities" | "paths";
  abort: AbortController;
  done: Promise<SearchPage | SearchIdentities | SearchPaths>;
}

interface ActiveActivityStats {
  abort: AbortController;
  done: Promise<ActivityStats>;
}

interface ActiveRepositoryObservation {
  abort: AbortController;
  done: Promise<RepositoryObservation>;
}

interface ActiveRefSnapshotDiff {
  abort: AbortController;
  done: Promise<RefSnapshotDiff>;
}

interface ActiveHandoffFacts {
  abort: AbortController;
  done: Promise<HandoffFacts>;
}

interface ActiveCommitDetailRequest {
  kind: "commit" | "files" | "merge" | "branches" | "diff";
  abort: AbortController;
  done: Promise<unknown>;
}

export class RepositorySessionController {
  private current?: RepositorySessionInfo;
  private operation = 0;
  private pageIntent = 0;
  private lifecycleEpoch = 0;
  private disposed = false;
  private activeOpen?: ActiveOpen;
  private activeHistoryRead?: ActiveHistoryRead;
  private activeRefresh?: ActiveRefresh;
  private activeMergeStatus?: ActiveMergeStatus;
  private mergeIntent = 0;
  private metadataIndexIntent = 0;
  private activeMetadataIndexRequest?: ActiveMetadataIndexRequest;
  private searchIntent = 0;
  private activeSearchRequest?: ActiveSearchRequest;
  private activityStatsIntent = 0;
  private activeActivityStats?: ActiveActivityStats;
  private observationIntent = 0;
  private activeRepositoryObservation?: ActiveRepositoryObservation;
  private refSnapshotDiffIntent = 0;
  private activeRefSnapshotDiff?: ActiveRefSnapshotDiff;
  private handoffFactsIntent = 0;
  private activeHandoffFacts?: ActiveHandoffFacts;
  private commitDetailsIntent = 0;
  private activeCommitDetailRequest?: ActiveCommitDetailRequest;
  private currentCommitDetails?: { session: RepositorySessionInfo; details: CommitDetails };
  /** P4-09: the file list and the shown file's diff or content each have one channel; a new read replaces the old one. */
  private readonly workspaceIntent: Record<WorkspaceChannel, number> = { status: 0, content: 0 };
  private readonly activeWorkspace: Partial<Record<WorkspaceChannel, ActiveWorkspaceRequest>> = {};
  private readonly unsubscribeCore: () => void;

  constructor(private readonly core: CoreProcess) {
    this.unsubscribeCore = core.subscribe(status => this.onCoreStatus(status));
  }

  getCurrentSessionIdentity(): { repoId: string; generation: string } | null {
    return this.current ? { repoId: this.current.repoId, generation: this.current.generation } : null;
  }

  async open(path: unknown): Promise<RepositorySessionInfo> {
    if (this.disposed) throw new ProtocolClientError("CORE_EXITED", "仓库会话控制器已关闭", true);
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) {
      throw new ProtocolClientError("INVALID_REQUEST", "请输入有效的绝对目录路径");
    }
    this.requireCapability("repositorySessions");
    this.requireCapability("repositoryScopes");
    this.requireCapability("historyGraph");
    this.requireCapability("commitDetails");

    const operation = ++this.operation;
    ++this.pageIntent;
    this.abortSupersededForTransition("仓库打开请求已被更新请求取代", true);
    await this.cancelPassiveRequestsForTransition();
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "仓库打开请求已被更新请求取代", true);
    if (this.activeSearchRequest) await this.cancelSearch();
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "仓库打开请求已被更新请求取代", true);
    if (this.activeCommitDetailRequest) await this.cancelCommitDetails();
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "仓库打开请求已被更新请求取代", true);
    if (this.activeMetadataIndexRequest) await this.settleMetadataIndexForTransition();
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "仓库打开请求已被更新请求取代", true);
    const mergeCancellation = this.activeMergeStatus ? this.cancelRefMergeStatus() : undefined;
    this.activeHistoryRead?.abort.abort(new Error("仓库切换已取消历史读取"));
    const refreshing = this.activeRefresh;
    if (refreshing) {
      refreshing.abort.abort(new Error("仓库打开请求已取代刷新"));
      await refreshing.done.catch(() => undefined);
      if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "仓库打开请求已被更新请求取代", true);
    }
    const previous = this.activeOpen;
    if (previous) {
      previous.abort.abort(new Error("仓库打开请求已被更新请求取代"));
      await previous.done.catch(() => undefined);
      if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "仓库打开请求已被更新请求取代", true);
      this.requireCapability("repositorySessions");
    }
    if (mergeCancellation) await mergeCancellation;
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "仓库打开请求已被更新请求取代", true);
    await this.cancelAndDrainHistoryRead(new ProtocolClientError("CANCELLED", "仓库切换已取消历史读取", true));
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "仓库打开请求已被更新请求取代", true);

    const abort = new AbortController();
    const lifecycleEpoch = this.lifecycleEpoch;
    const active: ActiveOpen = { abort, done: Promise.resolve() };
    this.activeOpen = active;
    active.done = this.openRequest(path, lifecycleEpoch, abort);
    try {
      await active.done;
      if (operation !== this.operation || abort.signal.aborted) {
        throw new ProtocolClientError("CANCELLED", "仓库打开请求已被更新请求取代", true);
      }
      if (!this.current) throw new ProtocolClientError("STALE_CONTEXT", "仓库会话未能建立");
      return this.current;
    } finally {
      if (this.activeOpen === active) this.activeOpen = undefined;
    }
  }

  async get(): Promise<RepositorySessionInfo> {
    this.requireCapability("historyGraph");
    const session = this.requireCurrent();
    const data = await this.singleSessionRequest("getRepositorySession", {}, session);
    if (data.section !== "repositorySession" || !sameSession(data.session, session)) {
      throw new ProtocolClientError("PROTOCOL_ERROR", "核心返回的仓库会话与当前会话不一致");
    }
    this.ensureCurrent(session);
    return data.session;
  }

  async readPreview(): Promise<SessionPreview> {
    const session = this.requireCurrent();
    const context = contextOf(session);
    let repository: RepositoryInfo | undefined;
    let refs: RefInfo[] = [];
    let refsTruncated = false;
    let commits: CommitSummary[] = [];
    let hasMore = false;
    let sawRepository = false;
    let sawCommits = false;
    let sawDone = false;

    const completion = await this.core.request("readSessionPreview", {}, context, {
      timeoutMs: SESSION_TIMEOUT_MS,
      onChunk: chunk => {
        this.ensureCurrent(session);
        const data = chunk.data;
        if (data.section === "repository") {
          if (sawRepository || sawCommits || chunk.done) throw invalidSessionResponse("仓库预览区块顺序无效");
          sawRepository = true;
          repository = data.repository;
          refs = data.refs.slice(0, MAX_REFS);
          refsTruncated = data.refsTruncated || data.refs.length > MAX_REFS;
        } else if (data.section === "commits") {
          if (!sawRepository || sawDone) throw invalidSessionResponse("提交区块顺序无效");
          sawCommits = true;
          if (commits.length + data.commits.length > MAX_COMMITS) throw invalidSessionResponse("会话预览超过提交上限");
          commits = [...commits, ...data.commits];
          hasMore = data.hasMore;
          if (chunk.done) sawDone = true;
        } else {
          throw invalidSessionResponse(`会话预览收到意外区块：${data.section}`);
        }
      },
    });

    this.ensureCurrent(session);
    if (!repository || !sawRepository || !sawCommits || !sawDone || !completion.coverage.complete ||
      completion.coverage.processed !== commits.length) {
      throw invalidSessionResponse("核心返回了不完整或不一致的会话预览");
    }
    return { repository, refs, refsTruncated, commits, hasMore };
  }

  async recordView(expectedGeneration: unknown): Promise<RepositoryViewRecorded> {
    const session = this.requireCurrent();
    if (this.activeMetadataIndexRequest?.kind === "status") await this.cancelMetadataIndexStatus();
    if (typeof expectedGeneration !== "string" || expectedGeneration !== session.generation) {
      throw new ProtocolClientError("STALE_CONTEXT", "当前显示的仓库会话已变化", true);
    }
    const data = await this.singleSessionRequest("recordRepositoryView", {}, session);
    if (data.section !== "repositoryViewRecorded") throw invalidSessionResponse("核心未确认查看记录");
    this.ensureCurrent(session);
    return { saved: data.saved, status: data.status };
  }

  async readHistoryPage(cursor: unknown, pageSize = 200): Promise<HistoryPage> {
    const intent = ++this.pageIntent;
    const session = this.requireHistoryCapability();
    if (this.activeSearchRequest) await this.cancelSearch();
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史页请求已被更新请求取代", true);
    if (this.activeMetadataIndexRequest?.kind === "status") await this.cancelMetadataIndexStatus();
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史页请求已被更新请求取代", true);
    if (cursor !== null && (typeof cursor !== "string" || cursor.length === 0)) {
      throw new ProtocolClientError("INVALID_REQUEST", "历史页游标无效");
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_HISTORY_PAGE) {
      throw new ProtocolClientError("INVALID_REQUEST", `每页数量必须为 1 至 ${MAX_HISTORY_PAGE} 的整数`);
    }
    await this.cancelAndDrainHistoryRead(new ProtocolClientError("CANCELLED", "历史页请求已被更新请求取代", true));
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史页请求已被更新请求取代", true);
    await this.cancelPassiveRequestsForTransition();
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史页请求已被更新请求取代", true);
    this.ensureCurrent(session);
    const abort = new AbortController();
    const done: Promise<HistoryPage> = this.readHistoryPageRequest(session, cursor, pageSize, abort);
    const active: ActiveHistoryRead = { abort, done };
    this.activeHistoryRead = active;
    try {
      return await done;
    } finally {
      if (this.activeHistoryRead === active) this.activeHistoryRead = undefined;
    }
  }

  async locateCommit(params: unknown): Promise<HistoryPage> {
    const intent = ++this.pageIntent;
    const session = this.requireHistoryCapability();
    if (!isRecord(params) || !hasExactKeys(params, ["oid", "pageSize"]) ||
      typeof params.oid !== "string" || !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(params.oid) ||
      params.oid.length !== (session.repository.objectFormat === "sha1" ? 40 : 64) ||
      !Number.isInteger(params.pageSize) || (params.pageSize as number) < 1 || (params.pageSize as number) > MAX_HISTORY_PAGE) {
      throw new ProtocolClientError("INVALID_REQUEST", "历史定位参数无效");
    }
    if (this.activeSearchRequest) await this.cancelSearch();
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史定位已被更新请求取代", true);
    if (this.activeMetadataIndexRequest?.kind === "status") await this.cancelMetadataIndexStatus();
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史定位已被更新请求取代", true);
    if (this.activeCommitDetailRequest) await this.cancelCommitDetails();
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史定位已被更新请求取代", true);
    await this.cancelAndDrainHistoryRead(new ProtocolClientError("CANCELLED", "历史定位已被更新请求取代", true));
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史定位已被更新请求取代", true);
    await this.cancelPassiveRequestsForTransition();
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史定位已被更新请求取代", true);
    this.ensureCurrent(session);
    const abort = new AbortController();
    const done: Promise<HistoryPage> = this.readHistoryPageRequest(session, null, params.pageSize as number, abort,
      { kind: "commit", oid: params.oid.toLowerCase() });
    const active: ActiveHistoryRead = { abort, done };
    this.activeHistoryRead = active;
    try {
      return await done;
    } finally {
      if (this.activeHistoryRead === active) this.activeHistoryRead = undefined;
    }
  }

  async cancelHistoryRead(): Promise<{ cancelled: boolean }> {
    ++this.pageIntent;
    const active = this.activeHistoryRead;
    if (!active) return { cancelled: false };
    active.abort.abort(new Error("历史页读取已取消"));
    await active.done.catch(() => undefined);
    return { cancelled: true };
  }

  async locateHistoryDate(beforeTimestamp: unknown, pageSize = 200, knownCursors: unknown = []): Promise<HistoryDateLocation> {
    const intent = ++this.pageIntent;
    const session = this.requireHistoryCapability();
    if (!Number.isSafeInteger(beforeTimestamp) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_HISTORY_PAGE ||
      !Array.isArray(knownCursors) || knownCursors.length > 9 || !knownCursors.every(cursor => typeof cursor === "string" && cursor.length > 0 && cursor.length <= 512)) {
      throw new ProtocolClientError("INVALID_REQUEST", "日期定位参数无效");
    }
    if (this.activeSearchRequest) await this.cancelSearch();
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史日期定位已被更新请求取代", true);
    if (this.activeMetadataIndexRequest?.kind === "status") await this.cancelMetadataIndexStatus();
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史日期定位已被更新请求取代", true);
    if (this.activeCommitDetailRequest) await this.cancelCommitDetails();
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史日期定位已被更新请求取代", true);
    await this.cancelAndDrainHistoryRead(new ProtocolClientError("CANCELLED", "历史日期定位已被更新请求取代", true));
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史日期定位已被更新请求取代", true);
    await this.cancelPassiveRequestsForTransition();
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史日期定位已被更新请求取代", true);
    this.ensureCurrent(session);
    const abort = new AbortController();
    const done: Promise<HistoryDateLocation> = this.readHistoryDateRequest(session, beforeTimestamp as number, pageSize, knownCursors as string[], abort);
    const active: ActiveHistoryRead = { abort, done };
    this.activeHistoryRead = active;
    try {
      return await done;
    } finally {
      if (this.activeHistoryRead === active) this.activeHistoryRead = undefined;
    }
  }

  async refreshRepository(pageSize = 200): Promise<RefreshedRepository> {
    if (this.activeOpen) throw new ProtocolClientError("BUSY", "仓库正在切换，暂不能刷新", true);
    const operation = ++this.operation;
    ++this.pageIntent;
    this.abortSupersededForTransition("刷新已取代进行中的读取", false);
    await this.cancelPassiveRequestsForTransition();
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "刷新已被更新请求取代", true);
    if (this.activeSearchRequest) await this.cancelSearch();
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "刷新已被更新请求取代", true);
    if (this.activeCommitDetailRequest) await this.cancelCommitDetails();
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "刷新已被更新请求取代", true);
    if (this.activeMetadataIndexRequest) await this.settleMetadataIndexForTransition();
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "刷新已被更新操作取代", true);
    const mergeCancellation = this.activeMergeStatus ? this.cancelRefMergeStatus() : undefined;
    this.activeHistoryRead?.abort.abort(new Error("刷新已取消历史页读取"));
    this.requireHistoryCapability();
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_HISTORY_PAGE) {
      throw new ProtocolClientError("INVALID_REQUEST", `每页数量必须为 1 至 ${MAX_HISTORY_PAGE} 的整数`);
    }
    const previousRefresh = this.activeRefresh;
    if (previousRefresh) {
      previousRefresh.abort.abort(new Error("刷新已被更新的刷新取代"));
      await previousRefresh.done.catch(() => undefined);
    }
    if (mergeCancellation) await mergeCancellation;
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "刷新已被更新操作取代", true);
    const session = this.requireHistoryCapability();
    await this.cancelAndDrainHistoryRead(new ProtocolClientError("CANCELLED", "刷新已取消历史页读取", true));
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "刷新已被更新操作取代", true);
    this.ensureCurrent(session);
    const abort = new AbortController();
    const active: ActiveRefresh = { abort, done: Promise.resolve(undefined as never) };
    active.done = this.refreshRepositoryRequest(session, pageSize, abort);
    this.activeRefresh = active;
    try {
      return await active.done;
    } finally {
      if (this.activeRefresh === active) this.activeRefresh = undefined;
    }
  }

  async getNavigation(): Promise<RepositoryNavigation> {
    if (this.activeOpen || this.activeRefresh) throw new ProtocolClientError("BUSY", "仓库范围正在更新，暂不能读取导航清单", true);
    this.ensurePassiveRequestCapacity("仓库导航");
    const session = this.requireCurrent();
    this.requireCapability("repositoryScopes");
    if (this.activeMetadataIndexRequest?.kind === "status") await this.cancelMetadataIndexStatus();
    this.ensureCurrent(session);
    let navigation: RepositoryNavigation | undefined;
    const completion = await this.core.request("getRepositoryNavigation", {}, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (navigation || chunk.data.section !== "repositoryNavigation" || !chunk.done) {
          throw invalidSessionResponse("仓库导航响应无效");
        }
        navigation = chunk.data.navigation;
      },
    });
    this.ensureCurrent(session);
    if (!navigation || !completion.coverage.complete ||
      completion.coverage.processed !== navigation.refs.length + navigation.worktrees.length) {
      throw invalidSessionResponse("仓库导航响应不完整");
    }
    return navigation;
  }

  async selectScope(scope: unknown, pageSize = 200): Promise<RefreshedRepository> {
    if (this.activeOpen) throw new ProtocolClientError("BUSY", "仓库正在切换，暂不能切换范围", true);
    this.requireCapability("repositoryScopes");
    validateScope(scope);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_HISTORY_PAGE) {
      throw new ProtocolClientError("INVALID_REQUEST", `每页数量必须为 1 至 ${MAX_HISTORY_PAGE} 的整数`);
    }
    const operation = ++this.operation;
    ++this.pageIntent;
    this.abortSupersededForTransition("范围切换已取代进行中的读取", false);
    await this.cancelPassiveRequestsForTransition();
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "范围切换已被更新操作取代", true);
    if (this.activeSearchRequest) await this.cancelSearch();
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "范围切换已被更新操作取代", true);
    if (this.activeCommitDetailRequest) await this.cancelCommitDetails();
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "范围切换已被更新操作取代", true);
    if (this.activeMetadataIndexRequest) await this.settleMetadataIndexForTransition();
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "范围切换已被更新操作取代", true);
    const mergeCancellation = this.activeMergeStatus ? this.cancelRefMergeStatus() : undefined;
    this.activeHistoryRead?.abort.abort(new Error("范围切换已取消历史页读取"));
    const previousRefresh = this.activeRefresh;
    if (previousRefresh) {
      previousRefresh.abort.abort(new Error("范围切换已取代旧刷新或范围切换"));
      await previousRefresh.done.catch(() => undefined);
    }
    if (mergeCancellation) await mergeCancellation;
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "范围切换已被更新操作取代", true);
    const session = this.requireHistoryCapability();
    await this.cancelAndDrainHistoryRead(new ProtocolClientError("CANCELLED", "范围切换已取消历史读取", true));
    if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "范围切换已被更新操作取代", true);
    this.ensureCurrent(session);
    const abort = new AbortController();
    const active: ActiveRefresh = { abort, done: Promise.resolve(undefined as never) };
    active.done = this.refreshRepositoryRequest(session, pageSize, abort, "selectRepositoryScope", { scope });
    this.activeRefresh = active;
    try {
      return await active.done;
    } finally {
      if (this.activeRefresh === active) this.activeRefresh = undefined;
    }
  }

  async getRefMergeStatus(refNames: unknown): Promise<RefMergeStatusResult> {
    if (this.activeOpen || this.activeRefresh) throw new ProtocolClientError("BUSY", "仓库范围正在更新，暂不能计算合入状态", true);
    this.ensurePassiveRequestCapacity("分支合入状态");
    const session = this.requireCurrent();
    this.requireCapability("repositoryScopes");
    if (this.activeMetadataIndexRequest?.kind === "status") await this.cancelMetadataIndexStatus();
    this.ensureCurrent(session);
    if (!Array.isArray(refNames) || refNames.length < 1 || refNames.length > 50 ||
      refNames.some(name => typeof name !== "string" || !name.startsWith("refs/heads/") || Buffer.byteLength(name, "utf8") > 16 * 1024)) {
      throw new ProtocolClientError("INVALID_REQUEST", "本地分支列表必须包含 1 至 50 个完整引用名");
    }
    if (new Set(refNames).size !== refNames.length) throw new ProtocolClientError("INVALID_REQUEST", "本地分支列表不能重复");
    const intent = ++this.mergeIntent;
    const previous = this.activeMergeStatus;
    if (previous) {
      previous.abort.abort(new Error("分支合入状态查询已被替代"));
      await previous.done.catch(() => undefined);
    }
    if (intent !== this.mergeIntent) throw new ProtocolClientError("CANCELLED", "分支合入状态查询已被更新操作取代", true);
    this.ensureCurrent(session);
    const abort = new AbortController();
    const active: ActiveMergeStatus = { abort, done: Promise.resolve(undefined as never) };
    active.done = this.readRefMergeStatus(session, refNames as string[], abort);
    this.activeMergeStatus = active;
    try {
      const result = await active.done;
      if (intent !== this.mergeIntent) throw new ProtocolClientError("CANCELLED", "分支合入状态查询已取消", true);
      return result;
    } finally {
      if (this.activeMergeStatus === active) this.activeMergeStatus = undefined;
    }
  }

  async cancelRefMergeStatus(): Promise<{ cancelled: boolean }> {
    ++this.mergeIntent;
    const active = this.activeMergeStatus;
    if (!active) return { cancelled: false };
    active.abort.abort(new Error("分支合入状态查询已取消"));
    await active.done.catch(() => undefined);
    return { cancelled: true };
  }

  async getMetadataIndexStatus(): Promise<MetadataIndexStatus> {
    if (this.activeOpen || this.activeRefresh) throw new ProtocolClientError("BUSY", "仓库范围正在更新，暂不能读取索引状态", true);
    this.ensurePassiveRequestCapacity("索引状态");
    const session = this.requireCurrent();
    this.requireMetadataIndexCapability();
    if (this.activeMetadataIndexRequest) throw new ProtocolClientError("BUSY", "索引状态或控制请求正在执行", true);
    const intent = ++this.metadataIndexIntent;
    const abort = new AbortController();
    const active: ActiveMetadataIndexRequest = { kind: "status", abort, done: Promise.resolve(undefined as never) };
    active.done = this.readMetadataIndexStatus(session, abort.signal);
    this.activeMetadataIndexRequest = active;
    try {
      const status = await active.done;
      if (intent !== this.metadataIndexIntent) throw new ProtocolClientError("CANCELLED", "索引状态请求已过期", true);
      this.ensureCurrent(session);
      return status;
    } finally {
      if (this.activeMetadataIndexRequest === active) this.activeMetadataIndexRequest = undefined;
    }
  }

  async controlMetadataIndex(action: unknown): Promise<MetadataIndexStatus> {
    if (this.activeOpen || this.activeRefresh) throw new ProtocolClientError("BUSY", "仓库范围正在更新，暂不能控制索引", true);
    this.ensurePassiveRequestCapacity("索引控制");
    if (action !== "pause" && action !== "resume" && action !== "cancel" && action !== "rebuild") {
      throw new ProtocolClientError("INVALID_REQUEST", "索引操作无效");
    }
    const session = this.requireCurrent();
    this.requireMetadataIndexCapability();
    if (action === "rebuild" && this.activeSearchRequest) {
      await this.cancelSearch();
      this.ensureCurrent(session);
    }
    const previous = this.activeMetadataIndexRequest;
    if (previous?.kind === "control") throw new ProtocolClientError("BUSY", "索引控制请求正在执行", true);
    if (previous?.kind === "status") await this.cancelMetadataIndexStatus();
    this.ensureCurrent(session);
    const active: ActiveMetadataIndexRequest = { kind: "control", done: Promise.resolve(undefined as never) };
    active.done = this.readMetadataIndexControl(session, action);
    this.activeMetadataIndexRequest = active;
    try {
      const status = await active.done;
      this.ensureCurrent(session);
      return status;
    } finally {
      if (this.activeMetadataIndexRequest === active) this.activeMetadataIndexRequest = undefined;
    }
  }

  async searchCommits(input: unknown): Promise<SearchPage> {
    const params = validateSearchCommitsParams(input);
    if (this.activeOpen || this.activeRefresh) throw new ProtocolClientError("BUSY", "仓库范围正在更新，暂不能搜索", true);
    const session = this.requireCurrent();
    this.requireSearchCapability();
    const oidLength = session.repository.objectFormat === "sha256" ? 64 : 40;
    if (params.anchorOid !== null && params.anchorOid.length !== oidLength) {
      throw new ProtocolClientError("INVALID_REQUEST", "搜索锚点必须是完整 OID");
    }
    const result = await this.runSearchRequest("commits", session, signal => this.readSearchPage(session, params, signal));
    return result as SearchPage;
  }

  async listSearchIdentities(input: unknown): Promise<SearchIdentities> {
    const params = validateSearchIdentitiesParams(input);
    if (this.activeOpen || this.activeRefresh) throw new ProtocolClientError("BUSY", "仓库范围正在更新，暂不能读取身份建议", true);
    const session = this.requireCurrent();
    this.requireSearchCapability();
    const result = await this.runSearchRequest("identities", session, signal => this.readSearchIdentities(session, params, signal));
    return result as SearchIdentities;
  }

  async listSearchPaths(input: unknown): Promise<SearchPaths> {
    const params = validateSearchPathsParams(input);
    if (this.activeOpen || this.activeRefresh) throw new ProtocolClientError("BUSY", "仓库范围正在更新，暂不能读取路径建议", true);
    const session = this.requireCurrent();
    this.requireSearchCapability();
    const result = await this.runSearchRequest("paths", session, signal => this.readSearchPaths(session, params, signal));
    return result as SearchPaths;
  }

  async getActivityStats(input: unknown): Promise<ActivityStats> {
    const params = validateActivityStatsParams(input);
    if (this.activeOpen || this.activeRefresh) throw new ProtocolClientError("BUSY", "仓库范围正在更新，暂不能读取活动统计", true);
    const session = this.requireCurrent();
    this.requireCapability("activityStats");
    if (this.activeActivityStats) await this.cancelActivityStats();
    this.ensureBackgroundRequestIdle("活动统计");
    const intent = ++this.activityStatsIntent;
    const abort = new AbortController();
    const active: ActiveActivityStats = { abort, done: Promise.resolve(undefined as never) };
    active.done = this.readActivityStats(session, params, abort.signal);
    this.activeActivityStats = active;
    try {
      const result = await active.done;
      if (intent !== this.activityStatsIntent) throw new ProtocolClientError("CANCELLED", "活动统计已被更新请求取代", true);
      this.ensureCurrent(session);
      return result;
    } finally {
      if (this.activeActivityStats === active) this.activeActivityStats = undefined;
    }
  }

  async cancelActivityStats(): Promise<{ cancelled: boolean }> {
    ++this.activityStatsIntent;
    const active = this.activeActivityStats;
    if (!active) return { cancelled: false };
    active.abort.abort(new Error("活动统计已取消"));
    await active.done.catch(() => undefined);
    if (this.activeActivityStats === active) this.activeActivityStats = undefined;
    return { cancelled: true };
  }

  async observeRepository(): Promise<RepositoryObservation> {
    if (this.activeOpen || this.activeRefresh) throw new ProtocolClientError("BUSY", "仓库范围正在更新，暂不能复核引用", true);
    const session = this.requireCurrent();
    this.requireCapability("repositoryObservation");
    if (this.activeRepositoryObservation) return this.activeRepositoryObservation.done;
    this.ensureBackgroundRequestIdle("仓库引用复核");
    const intent = ++this.observationIntent;
    const abort = new AbortController();
    const active: ActiveRepositoryObservation = { abort, done: Promise.resolve(undefined as never) };
    active.done = this.readRepositoryObservation(session, abort.signal);
    this.activeRepositoryObservation = active;
    try {
      const result = await active.done;
      if (intent !== this.observationIntent) throw new ProtocolClientError("CANCELLED", "仓库引用复核已取消", true);
      this.ensureCurrent(session);
      return result;
    } finally {
      if (this.activeRepositoryObservation === active) this.activeRepositoryObservation = undefined;
    }
  }

  async cancelRepositoryObservation(): Promise<{ cancelled: boolean }> {
    ++this.observationIntent;
    const active = this.activeRepositoryObservation;
    if (!active) return { cancelled: false };
    active.abort.abort(new Error("仓库引用复核已取消"));
    await active.done.catch(() => undefined);
    if (this.activeRepositoryObservation === active) this.activeRepositoryObservation = undefined;
    return { cancelled: true };
  }

  async diffRefSnapshots(): Promise<RefSnapshotDiff> {
    if (this.activeOpen || this.activeRefresh) throw new ProtocolClientError("BUSY", "仓库范围正在更新，暂不能读取更新明细", true);
    const session = this.requireCurrent();
    this.requireCapability("repositoryObservation");
    if (this.activeRefSnapshotDiff) await this.cancelRefSnapshotDiff();
    this.ensureBackgroundRequestIdle("引用更新明细");
    const intent = ++this.refSnapshotDiffIntent;
    const abort = new AbortController();
    const active: ActiveRefSnapshotDiff = { abort, done: Promise.resolve(undefined as never) };
    active.done = this.readRefSnapshotDiff(session, abort.signal);
    this.activeRefSnapshotDiff = active;
    try {
      const result = await active.done;
      if (intent !== this.refSnapshotDiffIntent) throw new ProtocolClientError("CANCELLED", "更新明细已取消", true);
      this.ensureCurrent(session);
      return result;
    } finally {
      if (this.activeRefSnapshotDiff === active) this.activeRefSnapshotDiff = undefined;
    }
  }

  async cancelRefSnapshotDiff(): Promise<{ cancelled: boolean }> {
    ++this.refSnapshotDiffIntent;
    const active = this.activeRefSnapshotDiff;
    if (!active) return { cancelled: false };
    active.abort.abort(new Error("引用更新明细已取消"));
    await active.done.catch(() => undefined);
    if (this.activeRefSnapshotDiff === active) this.activeRefSnapshotDiff = undefined;
    return { cancelled: true };
  }

  async getHandoffFacts(input: unknown): Promise<HandoffFacts> {
    const params = validateHandoffFactsParams(input);
    if (this.activeOpen || this.activeRefresh) throw new ProtocolClientError("BUSY", "仓库范围正在更新，暂不能准备 Agent 交接资料", true);
    const session = this.requireCurrent();
    this.requireCapability("handoffFacts");
    if (this.activeHandoffFacts) await this.cancelHandoffFacts();
    this.ensureBackgroundRequestIdle("Agent 交接资料");
    const intent = ++this.handoffFactsIntent;
    const abort = new AbortController();
    const active: ActiveHandoffFacts = { abort, done: Promise.resolve(undefined as never) };
    active.done = this.readHandoffFacts(session, params, abort.signal);
    this.activeHandoffFacts = active;
    try {
      const result = await active.done;
      if (intent !== this.handoffFactsIntent) throw new ProtocolClientError("CANCELLED", "Agent 交接资料已被新目标取代", true);
      this.ensureCurrent(session);
      return result;
    } finally {
      if (this.activeHandoffFacts === active) this.activeHandoffFacts = undefined;
    }
  }

  async cancelHandoffFacts(): Promise<{ cancelled: boolean }> {
    ++this.handoffFactsIntent;
    const active = this.activeHandoffFacts;
    if (!active) return { cancelled: false };
    active.abort.abort(new Error("Agent 交接资料已取消"));
    await active.done.catch(() => undefined);
    if (this.activeHandoffFacts === active) this.activeHandoffFacts = undefined;
    return { cancelled: true };
  }

  async cancelSearch(): Promise<{ cancelled: boolean }> {
    ++this.searchIntent;
    const active = this.activeSearchRequest;
    if (!active) return { cancelled: false };
    active.abort.abort(new Error("搜索已取消"));
    await active.done.catch(() => undefined);
    if (this.activeSearchRequest === active) this.activeSearchRequest = undefined;
    return { cancelled: true };
  }

  async getCommit(input: unknown): Promise<CommitDetails> {
    const params = validateGetCommitParams(input);
    const session = this.requireCommitDetailsCapability();
    this.validateOidForSession(params.oid, session);
    return this.runCommitDetailsRequest("commit", session, signal => this.readCommitDetails(session, params, signal));
  }

  async listChangedFiles(input: unknown): Promise<ChangedFilesPage> {
    const params = validateListChangedFilesParams(input);
    const session = this.requireCommitDetailsCapability();
    this.validateOidForSession(params.oid, session);
    const details = this.requireLoadedCommitDetails(session, params.oid);
    validateFileParent(params.parentIndex, details.commit.parents.length);
    return this.runCommitDetailsRequest("files", session, signal => this.readChangedFiles(session, params, details, signal));
  }

  async readMergeCommits(input: unknown): Promise<MergeCommitsPage> {
    const params = validateReadMergeCommitsParams(input);
    const session = this.requireCommitDetailsCapability();
    this.validateOidForSession(params.oid, session);
    const details = this.requireLoadedCommitDetails(session, params.oid);
    if (details.commit.parents.length < 2 || params.parentIndex < 1 || params.parentIndex >= details.commit.parents.length) {
      throw new ProtocolClientError("INVALID_REQUEST", "merge 父提交序号无效");
    }
    return this.runCommitDetailsRequest("merge", session, signal => this.readMergeCommitPage(session, params, details, signal));
  }

  async branchesContaining(input: unknown): Promise<BranchesContainingResult> {
    const params = validateBranchesContainingParams(input);
    const session = this.requireCommitDetailsCapability();
    this.validateOidForSession(params.oid, session);
    return this.runCommitDetailsRequest("branches", session, signal => this.readBranchesContaining(session, params, signal));
  }

  async readDiff(input: unknown): Promise<FileDiff> {
    const params = validateReadDiffParams(input);
    const session = this.requireCommitDetailsCapability();
    this.validateOidForSession(params.oid, session);
    const details = this.requireLoadedCommitDetails(session, params.oid);
    validateFileParent(params.parentIndex, details.commit.parents.length);
    return this.runCommitDetailsRequest("diff", session, signal => this.readFileDiff(session, params, details, signal));
  }

  async readWorkspaceStatus(input: unknown): Promise<WorkspaceStatus> {
    const params = validateWorkspaceStatusParams(input);
    const session = this.requireWorkspaceCapability();
    return this.runWorkspaceRequest("status", session, signal => this.readWorkspaceSection(session, "readWorkspaceStatus", params, signal,
      data => data.section === "workspaceStatus" ? data.status : undefined,
      status => {
        const shownConflicts = status.entries.filter(entry => entry.conflict !== null).length;
        return status.entries.length <= params.maxEntries && status.totalPaths >= status.entries.length &&
          (status.complete ? status.totalPaths === status.entries.length && status.conflictCount === shownConflicts : status.conflictCount >= shownConflicts);
      }));
  }

  async readWorkspaceDiff(input: unknown): Promise<WorkspaceDiff> {
    const params = validateWorkspaceDiffParams(input);
    const session = this.requireWorkspaceCapability();
    return this.runWorkspaceRequest("content", session, signal => this.readWorkspaceSection(session, "readWorkspaceDiff", params, signal,
      data => data.section === "workspaceDiff" ? data.diff : undefined,
      diff => diff.side === params.side && diff.path.rawHex.toLowerCase() === params.pathHex.toLowerCase()));
  }

  async readWorkspaceFile(input: unknown): Promise<WorkspaceFile> {
    const params = validateWorkspaceFileParams(input);
    const session = this.requireWorkspaceCapability();
    return this.runWorkspaceRequest("content", session, signal => this.readWorkspaceSection(session, "readWorkspaceFile", params, signal,
      data => data.section === "workspaceFile" ? data.file : undefined,
      file => file.path.rawHex.toLowerCase() === params.pathHex.toLowerCase() && file.lines <= params.maxLines &&
        (file.kind === "text" || file.text === "")));
  }

  async cancelWorkspace(): Promise<{ cancelled: boolean }> {
    let cancelled = false;
    for (const channel of ["status", "content"] as const) {
      ++this.workspaceIntent[channel];
      const active = this.activeWorkspace[channel];
      if (!active) continue;
      cancelled = true;
      active.abort.abort(new Error("工作区读取已取消"));
      await active.done.catch(() => undefined);
      if (this.activeWorkspace[channel] === active) delete this.activeWorkspace[channel];
    }
    return { cancelled };
  }

  private requireWorkspaceCapability(): RepositorySessionInfo {
    const session = this.requireCurrent();
    this.requireCapability("workspaceStatus");
    if (session.repository.isBare) throw new ProtocolClientError("INVALID_REQUEST", "bare 仓库没有工作区");
    return session;
  }

  private async runWorkspaceRequest<T>(channel: WorkspaceChannel, session: RepositorySessionInfo, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.activeOpen || this.activeRefresh) throw new ProtocolClientError("BUSY", "仓库正在更新，暂不能读取工作区", true);
    const intent = ++this.workspaceIntent[channel];
    const previous = this.activeWorkspace[channel];
    if (previous) {
      previous.abort.abort(new Error("工作区读取已被新的读取取代"));
      await previous.done.catch(() => undefined);
    }
    if (intent !== this.workspaceIntent[channel]) throw new ProtocolClientError("CANCELLED", "工作区读取已被新的读取取代", true);
    this.ensureCurrent(session);
    const abort = new AbortController();
    const active: ActiveWorkspaceRequest = { abort, done: Promise.resolve(undefined) };
    const done = read(abort.signal);
    active.done = done;
    this.activeWorkspace[channel] = active;
    try {
      const result = await done;
      if (intent !== this.workspaceIntent[channel]) throw new ProtocolClientError("CANCELLED", "工作区读取已被新的读取取代", true);
      this.ensureCurrent(session);
      return result;
    } finally {
      if (this.activeWorkspace[channel] === active) delete this.activeWorkspace[channel];
    }
  }

  /** One terminal chunk with the expected section; the schema validators in the transport have already checked its shape. */
  private async readWorkspaceSection<T>(session: RepositorySessionInfo, method: string, params: object, signal: AbortSignal,
    pick: (data: ServerResponseMessage["data"]) => T | undefined, consistent: (value: T) => boolean): Promise<T> {
    let value: T | undefined;
    const completion = await this.core.request(method, params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      signal,
      drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        const picked = pick(chunk.data);
        if (value !== undefined || picked === undefined || !chunk.done) throw invalidSessionResponse("工作区响应无效");
        value = picked;
      },
    });
    this.ensureCurrent(session);
    if (value === undefined || !completion.coverage.complete || completion.coverage.processed !== 1 || completion.nextCursor !== null ||
      !consistent(value)) throw invalidSessionResponse("工作区响应不完整或不一致");
    return value;
  }

  async cancelCommitDetails(): Promise<{ cancelled: boolean }> {
    ++this.commitDetailsIntent;
    const active = this.activeCommitDetailRequest;
    if (!active) return { cancelled: false };
    active.abort.abort(new Error("提交详情请求已取消"));
    await active.done.catch(() => undefined);
    if (this.activeCommitDetailRequest === active) this.activeCommitDetailRequest = undefined;
    return { cancelled: true };
  }

  private async runCommitDetailsRequest<T>(
    kind: ActiveCommitDetailRequest["kind"],
    session: RepositorySessionInfo,
    read: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.activeOpen || this.activeRefresh) throw new ProtocolClientError("BUSY", "仓库范围正在更新，暂不能读取提交详情", true);
    if (this.activeMetadataIndexRequest?.kind === "control") throw new ProtocolClientError("BUSY", "索引控制操作完成后再读取提交详情", true);
    const intent = ++this.commitDetailsIntent;
    const previous = this.activeCommitDetailRequest;
    if (previous) {
      previous.abort.abort(new Error("提交详情请求已被新选择取代"));
      await previous.done.catch(() => undefined);
    }
    if (intent !== this.commitDetailsIntent) throw new ProtocolClientError("CANCELLED", "提交详情请求已被新选择取代", true);
    if (this.activeMetadataIndexRequest?.kind === "status") await this.cancelMetadataIndexStatus();
    if (intent !== this.commitDetailsIntent) throw new ProtocolClientError("CANCELLED", "提交详情请求已被新选择取代", true);
    if (this.activeMergeStatus) await this.cancelRefMergeStatus();
    if (intent !== this.commitDetailsIntent) throw new ProtocolClientError("CANCELLED", "提交详情请求已被新选择取代", true);
    await this.cancelPassiveRequestsForTransition();
    if (intent !== this.commitDetailsIntent) throw new ProtocolClientError("CANCELLED", "提交详情请求已被新选择取代", true);
    this.ensureCurrent(session);
    const abort = new AbortController();
    const active: ActiveCommitDetailRequest = { kind, abort, done: Promise.resolve(undefined) };
    active.done = read(abort.signal);
    this.activeCommitDetailRequest = active;
    try {
      const result = await active.done as T;
      if (intent !== this.commitDetailsIntent) throw new ProtocolClientError("CANCELLED", "提交详情请求已被新选择取代", true);
      this.ensureCurrent(session);
      if (kind === "commit") this.currentCommitDetails = { session, details: result as CommitDetails };
      return result;
    } finally {
      if (this.activeCommitDetailRequest === active) this.activeCommitDetailRequest = undefined;
    }
  }

  private async readCommitDetails(session: RepositorySessionInfo, params: GetCommitParams, signal: AbortSignal): Promise<CommitDetails> {
    let details: CommitDetails | undefined;
    const completion = await this.core.request("getCommit", params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      signal,
      drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (details || chunk.data.section !== "commitDetails" || !chunk.done) throw invalidSessionResponse("提交详情响应无效");
        details = chunk.data.details;
      },
    });
    this.ensureCurrent(session);
    if (!details || !completion.coverage.complete || completion.coverage.processed !== 1 || completion.nextCursor !== null ||
      details.observedAtUnixMs !== session.observedAtUnixMs || !validCommitDetails(details, params.oid, session.repository.objectFormat)) {
      throw invalidSessionResponse("提交详情响应不完整或不一致");
    }
    return details;
  }

  private async readChangedFiles(
    session: RepositorySessionInfo,
    params: ListChangedFilesParams,
    details: CommitDetails,
    signal: AbortSignal,
  ): Promise<ChangedFilesPage> {
    let page: ChangedFilesPage | undefined;
    const completion = await this.core.request("listChangedFiles", params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      signal,
      drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (page || chunk.data.section !== "changedFiles" || !chunk.done) throw invalidSessionResponse("文件清单响应无效");
        page = chunk.data.page;
      },
    });
    this.ensureCurrent(session);
    if (!page || !Array.isArray(page.files) || !completion.coverage.complete || completion.coverage.processed !== page.files.length || completion.nextCursor !== null ||
      !validChangedFilesPage(page, params, details, session.repository.objectFormat)) throw invalidSessionResponse("文件清单响应不完整或不一致");
    return page;
  }

  private async readMergeCommitPage(
    session: RepositorySessionInfo,
    params: ReadMergeCommitsParams,
    details: CommitDetails,
    signal: AbortSignal,
  ): Promise<MergeCommitsPage> {
    let page: MergeCommitsPage | undefined;
    const completion = await this.core.request("readMergeCommits", params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      signal,
      drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (page || chunk.data.section !== "mergeCommits" || !chunk.done) throw invalidSessionResponse("merge 带入提交响应无效");
        page = chunk.data.page;
      },
    });
    this.ensureCurrent(session);
    if (!page || !Array.isArray(page.commits) || !completion.coverage.complete || completion.coverage.processed !== page.commits.length || completion.nextCursor !== null ||
      !validMergeCommitsPage(page, params, details, session.repository.objectFormat)) throw invalidSessionResponse("merge 带入提交响应不完整或不一致");
    return page;
  }

  private async readBranchesContaining(
    session: RepositorySessionInfo,
    params: BranchesContainingParams,
    signal: AbortSignal,
  ): Promise<BranchesContainingResult> {
    let result: BranchesContainingResult | undefined;
    const completion = await this.core.request("branchesContaining", params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      signal,
      drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (result || chunk.data.section !== "branchesContaining" || !chunk.done) throw invalidSessionResponse("包含分支响应无效");
        result = chunk.data.result;
      },
    });
    this.ensureCurrent(session);
    if (!result || !Array.isArray(result.branches) || result.oid !== params.oid || !completion.coverage.complete || completion.coverage.processed !== result.branches.length || completion.nextCursor !== null ||
      result.branches.length > MAX_REFS || result.observedAtUnixMs !== session.observedAtUnixMs || typeof result.complete !== "boolean" ||
      typeof result.refsTruncated !== "boolean" || typeof result.boundaryLimited !== "boolean" || !Number.isSafeInteger(result.observedAtUnixMs) ||
      result.complete && (result.refsTruncated || result.boundaryLimited) ||
      !result.branches.every(ref => validRefInfo(ref, session.repository.objectFormat) && ref.kind !== "tag")) throw invalidSessionResponse("包含分支响应不完整或不一致");
    return result;
  }

  private async readFileDiff(session: RepositorySessionInfo, params: ReadDiffParams, details: CommitDetails, signal: AbortSignal): Promise<FileDiff> {
    let diff: FileDiff | undefined;
    const completion = await this.core.request("readDiff", params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      signal,
      drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (diff || chunk.data.section !== "fileDiff" || !chunk.done) throw invalidSessionResponse("文件 diff 响应无效");
        diff = chunk.data.diff;
      },
    });
    this.ensureCurrent(session);
    if (!diff || !completion.coverage.complete || completion.coverage.processed !== 1 || completion.nextCursor !== null ||
      !validFileDiff(diff, params, details, session.repository.objectFormat)) throw invalidSessionResponse("文件 diff 响应不完整或不一致");
    return diff;
  }

  private requireCommitDetailsCapability(): RepositorySessionInfo {
    const session = this.requireCurrent();
    this.requireCapability("commitDetails");
    return session;
  }

  private ensurePassiveRequestCapacity(label: string): void {
    if (this.activeCommitDetailRequest && (this.activeHistoryRead || this.activeSearchRequest)) {
      throw new ProtocolClientError("BUSY", `历史/搜索和提交详情请求进行中，暂不能读取${label}`, true);
    }
  }

  private ensureBackgroundRequestIdle(label: string): void {
    if (this.activeOpen || this.activeRefresh || this.activeHistoryRead || this.activeSearchRequest || this.activeCommitDetailRequest ||
      this.activeMergeStatus || this.activeMetadataIndexRequest || this.activeActivityStats || this.activeRepositoryObservation ||
      this.activeRefSnapshotDiff || this.activeHandoffFacts) {
      throw new ProtocolClientError("BUSY", `交互请求进行中，暂不能读取${label}`, true);
    }
  }

  /**
   * Tells the foreground requests a transition replaces to stop at once. The transition still
   * drains them, after passive reads, before sending its own request; this only keeps a replaced
   * open, refresh, page read, search or commit detail from running on while passive reads drain.
   */
  private abortSupersededForTransition(reason: string, includingOpen: boolean): void {
    if (includingOpen) this.activeOpen?.abort.abort(new Error(reason));
    this.activeRefresh?.abort.abort(new Error(reason));
    this.activeHistoryRead?.abort.abort(new Error(reason));
    // Like cancelSearch / cancelCommitDetails: a result that still arrives is stale.
    if (this.activeSearchRequest) {
      ++this.searchIntent;
      this.activeSearchRequest.abort.abort(new Error(reason));
    }
    if (this.activeCommitDetailRequest) {
      ++this.commitDetailsIntent;
      this.activeCommitDetailRequest.abort.abort(new Error(reason));
    }
  }

  private async cancelPassiveRequestsForTransition(): Promise<void> {
    await Promise.all([
      this.cancelWorkspace(),
      this.cancelActivityStats(),
      this.cancelRepositoryObservation(),
      this.cancelRefSnapshotDiff(),
      this.cancelHandoffFacts(),
    ]);
  }

  private validateOidForSession(oid: string, session: RepositorySessionInfo): void {
    const length = session.repository.objectFormat === "sha256" ? 64 : 40;
    if (oid.length !== length || !/^[0-9a-f]+$/i.test(oid)) throw new ProtocolClientError("INVALID_REQUEST", "提交 OID 必须与当前仓库对象格式一致");
  }

  private requireLoadedCommitDetails(session: RepositorySessionInfo, oid: string): CommitDetails {
    const current = this.currentCommitDetails;
    if (!current || current.session !== session || current.details.commit.oid !== oid) {
      throw new ProtocolClientError("STALE_CONTEXT", "请先读取当前提交详情", true);
    }
    return current.details;
  }

  private async runSearchRequest(
    kind: ActiveSearchRequest["kind"],
    session: RepositorySessionInfo,
    read: (signal: AbortSignal) => Promise<SearchPage | SearchIdentities | SearchPaths>,
  ): Promise<SearchPage | SearchIdentities | SearchPaths> {
    const intent = ++this.searchIntent;
    const previous = this.activeSearchRequest;
    if (previous) {
      previous.abort.abort(new Error("搜索条件已更新"));
      await previous.done.catch(() => undefined);
    }
    if (intent !== this.searchIntent) throw new ProtocolClientError("CANCELLED", "搜索请求已被更新操作取代", true);
    if (this.activeMetadataIndexRequest?.kind === "status") await this.cancelMetadataIndexStatus();
    if (intent !== this.searchIntent) throw new ProtocolClientError("CANCELLED", "搜索请求已被更新操作取代", true);
    if (this.activeMergeStatus) await this.cancelRefMergeStatus();
    if (intent !== this.searchIntent) throw new ProtocolClientError("CANCELLED", "搜索请求已被更新操作取代", true);
    await this.cancelAndDrainHistoryRead(new ProtocolClientError("CANCELLED", "搜索已取消历史页读取", true));
    if (intent !== this.searchIntent) throw new ProtocolClientError("CANCELLED", "搜索请求已被更新操作取代", true);
    await this.cancelPassiveRequestsForTransition();
    if (intent !== this.searchIntent) throw new ProtocolClientError("CANCELLED", "搜索请求已被更新操作取代", true);
    this.ensureCurrent(session);
    const abort = new AbortController();
    const active: ActiveSearchRequest = { kind, abort, done: Promise.resolve(undefined as never) };
    active.done = read(abort.signal);
    this.activeSearchRequest = active;
    try {
      const result = await active.done;
      if (intent !== this.searchIntent) throw new ProtocolClientError("CANCELLED", "搜索请求已被更新操作取代", true);
      this.ensureCurrent(session);
      return result;
    } finally {
      if (this.activeSearchRequest === active) this.activeSearchRequest = undefined;
    }
  }

  private async readSearchPage(session: RepositorySessionInfo, params: SearchCommitsParams, signal: AbortSignal): Promise<SearchPage> {
    let page: SearchPage | undefined;
    const commits: SearchPage["commits"] = [];
    const pathMatches: SearchPage["pathMatches"] = [];
    const completion = await this.core.request("searchCommits", params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      signal,
      drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        const data = chunk.data;
        if (data.section !== "searchPage" || chunk.coverage.complete !== chunk.done || (!chunk.done && chunk.nextCursor !== null)) {
          throw invalidSessionResponse("搜索结果块的 coverage 无效");
        }
        if (page && !sameSearchPageMetadata(page, data.page)) throw invalidSessionResponse("搜索结果块版本或页边界不一致");
        if (!page) page = data.page;
        commits.push(...data.page.commits);
        pathMatches.push(...data.page.pathMatches);
        if (commits.length > params.pageSize || chunk.coverage.processed !== commits.length) throw invalidSessionResponse("搜索结果超过页大小或 envelope coverage 不连续");
      },
    });
    this.ensureCurrent(session);
    if (!page || !completion.coverage.complete || completion.coverage.processed !== commits.length ||
      completion.nextCursor !== page.nextCursor ||
      !validSearchPage(page, params, commits)) throw invalidSessionResponse("搜索响应不完整或不一致");
    if (!validSearchPathMatches(pathMatches, params, commits)) throw invalidSessionResponse("搜索路径命中父提交无效");
    return { ...page, commits, pathMatches };
  }

  private async readSearchIdentities(session: RepositorySessionInfo, params: SearchIdentitiesParams, signal: AbortSignal): Promise<SearchIdentities> {
    let result: SearchIdentities | undefined;
    const completion = await this.core.request("listSearchIdentities", params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      signal,
      drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (result || chunk.data.section !== "searchIdentities" || !chunk.done) throw invalidSessionResponse("身份建议响应无效");
        result = chunk.data.result;
      },
    });
    this.ensureCurrent(session);
    if (!result || result.field !== params.field || result.identities.length > params.limit ||
      !completion.coverage.complete || completion.coverage.processed !== result.identities.length) {
      throw invalidSessionResponse("身份建议响应不完整或不一致");
    }
    return result;
  }

  private async readSearchPaths(session: RepositorySessionInfo, params: ListSearchPathsParams, signal: AbortSignal): Promise<SearchPaths> {
    let paths: SearchPaths | undefined;
    const completion = await this.core.request("listSearchPaths", params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      signal,
      drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (paths || chunk.data.section !== "searchPaths" || !chunk.done) throw invalidSessionResponse("路径建议响应无效");
        paths = chunk.data.paths;
      },
    });
    this.ensureCurrent(session);
    if (!paths || !Array.isArray(paths.entries) || paths.entries.length > params.limit ||
      paths.entries.some(entry => !validGitPath(entry.path) || entry.kind !== "file" && entry.kind !== "directory") ||
      !completion.coverage.complete || completion.coverage.processed !== paths.entries.length || completion.nextCursor !== null) {
      throw invalidSessionResponse("路径建议响应不完整或不一致");
    }
    return paths;
  }

  private async readActivityStats(session: RepositorySessionInfo, params: GetActivityStatsParams, signal: AbortSignal): Promise<ActivityStats> {
    let stats: ActivityStats | undefined;
    const completion = await this.core.request("getActivityStats", params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS, signal, drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (stats || chunk.data.section !== "activityStats" || !chunk.done) throw invalidSessionResponse("活动统计响应无效");
        stats = chunk.data.stats;
      },
    });
    this.ensureCurrent(session);
    if (!stats || completion.coverage.complete !== stats.coverage.complete ||
      completion.coverage.processed !== Math.min(stats.matchedCount, 0xffff_ffff) || completion.nextCursor !== null ||
      stats.timeField !== params.query.timeField || stats.timeZone !== params.query.timeZone || !Number.isSafeInteger(stats.matchedCount) || stats.matchedCount < 0) {
      throw invalidSessionResponse("活动统计响应不完整或查询口径不匹配");
    }
    return stats;
  }

  private async readRepositoryObservation(session: RepositorySessionInfo, signal: AbortSignal): Promise<RepositoryObservation> {
    let observation: RepositoryObservation | undefined;
    const completion = await this.core.request("observeRepository", {}, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS, signal, drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (observation || chunk.data.section !== "repositoryObservation" || !chunk.done) throw invalidSessionResponse("仓库引用复核响应无效");
        observation = chunk.data.observation;
      },
    });
    this.ensureCurrent(session);
    if (!observation || !completion.coverage.complete || completion.coverage.processed !== Math.min(observation.changeCount, 0xffff_ffff) || completion.nextCursor !== null ||
      !observation.generation || !Number.isSafeInteger(observation.observedAtUnixMs) || !Number.isSafeInteger(observation.changeCount) || observation.changeCount < 0) {
      throw invalidSessionResponse("仓库引用复核响应不完整");
    }
    return observation;
  }

  private async readRefSnapshotDiff(session: RepositorySessionInfo, signal: AbortSignal): Promise<RefSnapshotDiff> {
    let diff: RefSnapshotDiff | undefined;
    const completion = await this.core.request("diffRefSnapshots", {}, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS, signal, drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (diff || chunk.data.section !== "refSnapshotDiff" || !chunk.done) throw invalidSessionResponse("更新明细响应无效");
        diff = chunk.data.diff;
      },
    });
    this.ensureCurrent(session);
    if (!diff || !completion.coverage.complete || completion.coverage.processed !== diff.changes.length || completion.nextCursor !== null ||
      diff.fromGeneration !== session.generation || !diff.toGeneration || !Number.isSafeInteger(diff.observedAtUnixMs)) {
      throw invalidSessionResponse("更新明细响应与当前浏览快照不匹配");
    }
    return diff;
  }

  private async readHandoffFacts(session: RepositorySessionInfo, params: GetHandoffFactsParams, signal: AbortSignal): Promise<HandoffFacts> {
    let facts: HandoffFacts | undefined;
    const completion = await this.core.request("getHandoffFacts", params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS, signal, drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (facts || chunk.data.section !== "handoffFacts" || !chunk.done) throw invalidSessionResponse("交接资料响应无效");
        facts = chunk.data.facts;
      },
    });
    this.ensureCurrent(session);
    if (!facts || !completion.coverage.complete || completion.coverage.processed !== 1 || completion.nextCursor !== null ||
      facts.observedAtUnixMs !== session.observedAtUnixMs || facts.repository.path !== session.repository.path ||
      JSON.stringify(facts.scope) !== JSON.stringify(session.scope)) throw invalidSessionResponse("交接资料与当前浏览快照不匹配");
    return facts;
  }

  private async readMetadataIndexStatus(session: RepositorySessionInfo, signal: AbortSignal): Promise<MetadataIndexStatus> {
    return this.readMetadataIndexRequest(session, "getMetadataIndexStatus", {}, signal);
  }

  private async readMetadataIndexControl(session: RepositorySessionInfo, action: MetadataIndexAction): Promise<MetadataIndexStatus> {
    return this.readMetadataIndexRequest(session, "controlMetadataIndex", { action });
  }

  private async readMetadataIndexRequest(
    session: RepositorySessionInfo,
    method: "getMetadataIndexStatus" | "controlMetadataIndex",
    params: Record<string, never> | { action: MetadataIndexAction },
    signal?: AbortSignal,
  ): Promise<MetadataIndexStatus> {
    let status: MetadataIndexStatus | undefined;
    const completion = await this.core.request(method, params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      signal,
      drainAfterAbort: method === "getMetadataIndexStatus",
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (status || chunk.data.section !== "metadataIndex" || !chunk.done) {
          throw invalidSessionResponse("元数据索引状态响应无效");
        }
        status = chunk.data.status;
      },
    });
    this.ensureCurrent(session);
    if (!status || !completion.coverage.complete || completion.coverage.processed !== 1 ||
      status.coverage.complete !== (status.state === "complete")) {
      throw invalidSessionResponse("元数据索引状态响应不完整或不一致");
    }
    return status;
  }

  private async cancelMetadataIndexStatus(): Promise<void> {
    const active = this.activeMetadataIndexRequest;
    if (!active || active.kind !== "status") return;
    ++this.metadataIndexIntent;
    active.abort?.abort(new Error("索引状态请求已被控制操作取代"));
    await active.done.catch(() => undefined);
  }

  private async settleMetadataIndexForTransition(): Promise<void> {
    const active = this.activeMetadataIndexRequest;
    if (!active) return;
    if (active.kind === "status") await this.cancelMetadataIndexStatus();
    else await active.done.catch(() => undefined);
  }

  async close(): Promise<{ closed: true }> {
    const operation = ++this.operation;
    ++this.pageIntent;
    this.abortSupersededForTransition("仓库会话正在关闭", true);
    await this.cancelPassiveRequestsForTransition();
    if (operation !== this.operation) throw new ProtocolClientError("STALE_CONTEXT", "仓库会话已被更新请求取代", true);
    if (this.activeSearchRequest) await this.cancelSearch();
    if (operation !== this.operation) throw new ProtocolClientError("STALE_CONTEXT", "仓库会话已被更新请求取代", true);
    if (this.activeCommitDetailRequest) await this.cancelCommitDetails();
    if (operation !== this.operation) throw new ProtocolClientError("STALE_CONTEXT", "仓库会话已被更新请求取代", true);
    if (this.activeMetadataIndexRequest) await this.settleMetadataIndexForTransition();
    if (operation !== this.operation) throw new ProtocolClientError("STALE_CONTEXT", "仓库会话已被更新请求取代", true);
    const mergeCancellation = this.activeMergeStatus ? this.cancelRefMergeStatus() : undefined;
    this.activeHistoryRead?.abort.abort(new Error("仓库关闭已取消历史读取"));
    const refreshing = this.activeRefresh;
    if (refreshing) {
      refreshing.abort.abort(new Error("仓库会话正在关闭"));
      await refreshing.done.catch(() => undefined);
    }
    const opening = this.activeOpen;
    if (opening) {
      this.activeOpen = undefined;
      opening.abort.abort(new Error("仓库会话正在关闭"));
      await opening.done.catch(() => undefined);
    }
    if (mergeCancellation) await mergeCancellation;
    await this.cancelAndDrainHistoryRead(new ProtocolClientError("CANCELLED", "仓库关闭已取消历史读取", true));
    if (operation !== this.operation) throw new ProtocolClientError("STALE_CONTEXT", "仓库会话已被更新请求取代", true);

    const session = this.current;
    if (!session) return { closed: true };
    const data = await this.singleSessionRequest("closeRepository", {}, session, true);
    if (data.section !== "repositoryClosed" || !data.closed) throw invalidSessionResponse("核心未确认关闭仓库会话");
    if (this.current !== session) {
      throw new ProtocolClientError("STALE_CONTEXT", "仓库会话已被更新请求取代", true);
    }
    this.current = undefined;
    this.currentCommitDetails = undefined;
    this.core.switchCurrentContext({ repoId: null, generation: null });
    return { closed: true };
  }

  async listRecent(): Promise<RecentRepositoriesResult> {
    this.requireCapability("repositorySessions");
    if (this.activeMetadataIndexRequest?.kind === "status") await this.cancelMetadataIndexStatus();
    let response: RecentResponse | undefined;
    const completion = await this.core.request("listRecentRepositories", {}, NULL_CONTEXT, {
      timeoutMs: SESSION_TIMEOUT_MS,
      onChunk: chunk => {
        if (response || chunk.data.section !== "recentRepositories" || !chunk.done) {
          throw invalidSessionResponse("最近仓库响应无效");
        }
        response = chunk.data;
      },
    });
    if (!response || !completion.coverage.complete || completion.coverage.processed !== response.repositories.length) {
      throw invalidSessionResponse("最近仓库响应不完整");
    }
    return { repositories: response.repositories, status: response.status };
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycleEpoch += 1;
    this.operation += 1;
    this.pageIntent += 1;
    this.activeOpen?.abort.abort(new Error("应用正在关闭"));
    this.activeHistoryRead?.abort.abort(new Error("应用正在关闭"));
    this.activeRefresh?.abort.abort(new Error("应用正在关闭"));
    this.activeMergeStatus?.abort.abort(new Error("应用正在关闭"));
    ++this.searchIntent;
    this.activeSearchRequest?.abort.abort(new Error("应用正在关闭"));
    this.activeSearchRequest = undefined;
    ++this.commitDetailsIntent;
    this.activeCommitDetailRequest?.abort.abort(new Error("应用正在关闭"));
    this.activeCommitDetailRequest = undefined;
    this.currentCommitDetails = undefined;
    ++this.mergeIntent;
    ++this.metadataIndexIntent;
    if (this.activeMetadataIndexRequest?.kind === "status") this.activeMetadataIndexRequest.abort?.abort(new Error("应用正在关闭"));
    void this.cancelPassiveRequestsForTransition();
    this.activeOpen = undefined;
    this.current = undefined;
    this.core.switchCurrentContext(NULL_CONTEXT);
    this.unsubscribeCore();
  }

  private async openRequest(path: string, lifecycleEpoch: number, abort: AbortController): Promise<void> {
    let sessionData: SessionResponse | undefined;
    const completion = await this.core.request("openRepository", { path }, NULL_CONTEXT, {
      timeoutMs: SESSION_TIMEOUT_MS,
      retainResultAfterAbort: true,
      fatalOnTimeout: true,
      signal: abort.signal,
      onChunk: chunk => {
        if (sessionData || chunk.data.section !== "repositorySession" || !chunk.done) {
          throw invalidSessionResponse("打开仓库响应无效");
        }
        sessionData = chunk.data;
      },
    });
    if (!sessionData || !completion.coverage.complete || completion.coverage.processed !== 1) {
      throw invalidSessionResponse("打开仓库响应不完整");
    }
    if (this.disposed || lifecycleEpoch !== this.lifecycleEpoch || this.core.getStatus().state !== "ready") {
      throw new ProtocolClientError("CORE_EXITED", "核心已关闭，忽略迟到的仓库会话", true);
    }
    this.current = sessionData.session;
    this.currentCommitDetails = undefined;
    this.core.observeLatestContext(contextOf(sessionData.session));
    this.core.switchCurrentContext(contextOf(sessionData.session));
  }

  private async readHistoryDateRequest(
    session: RepositorySessionInfo,
    beforeTimestamp: number,
    pageSize: number,
    knownCursors: string[],
    abort: AbortController,
  ): Promise<HistoryDateLocation> {
    const responseState: { location?: HistoryDateLocationResponse["location"]; knownCursorHit: boolean } = { knownCursorHit: false };
    const pageState: HistoryPageAccumulator = { commits: [], metadata: "", sawTerminalPage: false };
    const completion = await this.core.request("locateHistoryDate", { beforeTimestamp, pageSize, knownCursors }, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      drainAfterAbort: true,
      fatalOnTimeout: true,
      signal: abort.signal,
      onChunk: chunk => {
        this.ensureCurrent(session);
        const data = chunk.data;
        if (!responseState.location) {
          if (data.section !== "historyDateLocation") throw invalidSessionResponse("历史日期定位缺少定位区块");
          if (!validHistoryDateLocation(data, session.repository.objectFormat, pageSize)) throw invalidSessionResponse("历史日期定位区块无效");
          const location = data.location;
          responseState.location = location;
          responseState.knownCursorHit = knownCursors.includes(location.cursor);
          if (responseState.knownCursorHit) {
            if (!chunk.done || !chunk.coverage.complete || chunk.coverage.processed !== 0 || chunk.nextCursor !== null) {
              throw invalidSessionResponse("历史日期缓存命中 envelope 无效");
            }
          } else if (chunk.done || chunk.coverage.complete || chunk.coverage.processed !== 0 || chunk.nextCursor !== null) {
            throw invalidSessionResponse("历史日期缓存未命中 envelope 无效");
          }
          return;
        }
        if (responseState.knownCursorHit) throw invalidSessionResponse("历史日期缓存命中之后仍收到数据");
        const location = responseState.location;
        if (!location) throw invalidSessionResponse("核心未返回历史日期定位区块");
        appendHistoryPageChunk(chunk, pageState, session, pageSize, location.cursor, location.offset);
      },
    });
    this.ensureCurrent(session);
    const location = responseState.location;
    const knownCursorHit = responseState.knownCursorHit;
    if (!location) throw invalidSessionResponse("核心未返回历史日期定位区块");
    if (knownCursorHit) {
      if (pageState.page || !completion.coverage.complete || completion.coverage.processed !== 0 || completion.nextCursor !== null) {
        throw invalidSessionResponse("历史日期缓存命中响应不完整或不一致");
      }
      return { oid: location.oid, cursor: location.cursor, offset: location.offset, pageSize: location.pageSize, page: null };
    }
    const page = completeHistoryPage(pageState, completion.coverage, completion.nextCursor, location.oid);
    if (page.offset !== location.offset || page.pageSize !== location.pageSize) throw invalidSessionResponse("历史日期定位与历史页位置不一致");
    return { oid: location.oid, cursor: location.cursor, offset: location.offset, pageSize: location.pageSize, page };
  }

  private async readHistoryPageRequest(
    session: RepositorySessionInfo,
    cursor: string | null,
    pageSize: number,
    abort: AbortController,
    location?: { kind: "commit"; oid: string },
  ): Promise<HistoryPage> {
    let repository: RepositoryInfo | undefined;
    let refs: RefInfo[] = [];
    let refsTruncated = false;
    const pageState: HistoryPageAccumulator = { commits: [], metadata: "", sawTerminalPage: false };
    let sawRepository = false;
    const method = location?.kind === "commit" ? "locateCommit" : "readHistoryPage";
    const params = location?.kind === "commit" ? { oid: location.oid, pageSize }
      : { cursor, pageSize };
    const completion = await this.core.request(method, params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      drainAfterAbort: true,
      fatalOnTimeout: true,
      signal: abort.signal,
      onChunk: chunk => {
        this.ensureCurrent(session);
        const data = chunk.data;
        if (pageState.sawTerminalPage) throw invalidSessionResponse("历史页终止块之后仍收到数据");
        if (data.section === "repository") {
          if (sawRepository || pageState.page || chunk.done) throw invalidSessionResponse("历史页仓库头位置无效");
          if (chunk.coverage.complete || chunk.coverage.processed !== 0 || chunk.nextCursor !== null) throw invalidSessionResponse("历史页仓库头 envelope 无效");
          sawRepository = true;
          repository = data.repository;
          refs = data.refs.slice(0, MAX_REFS);
          refsTruncated = data.refsTruncated || data.refs.length > MAX_REFS;
          return;
        }
        if (data.section !== "historyPage") throw invalidSessionResponse(`历史页收到意外区块：${data.section}`);
        if (!sawRepository) throw invalidSessionResponse("历史页缺少仓库头");
        appendHistoryPageChunk(chunk, pageState, session, pageSize,
          cursor ?? (location?.kind === "commit" ? undefined : null),
          undefined,
          !location && cursor === null);
      },
    });
    this.ensureCurrent(session);
    if (!repository || !sawRepository) throw invalidSessionResponse("核心返回了不完整或不一致的历史页");
    const page = completeHistoryPage(pageState, completion.coverage, completion.nextCursor,
      location?.kind === "commit" ? location.oid : undefined);
    return { repository, refs, refsTruncated, ...page };
  }

  private async refreshRepositoryRequest(
    previous: RepositorySessionInfo,
    pageSize: number,
    abort: AbortController,
    method: "refreshRepository" | "selectRepositoryScope" = "refreshRepository",
    extraParams: Record<string, unknown> = {},
  ): Promise<RefreshedRepository> {
    let sessionData: SessionResponse | undefined;
    let repository: RepositoryInfo | undefined;
    let refs: RefInfo[] = [];
    let refsTruncated = false;
    let page: Omit<HistoryPage, "repository" | "refs" | "refsTruncated" | "nextCursor"> | undefined;
    const commits: HistoryCommit[] = [];
    let metadata = "";
    let sawTerminalPage = false;
    const lifecycleEpoch = this.lifecycleEpoch;
    const completion = await this.core.request(method, { pageSize, ...extraParams }, contextOf(previous), {
      timeoutMs: SESSION_TIMEOUT_MS,
      retainResultAfterAbort: true,
      fatalOnTimeout: true,
      signal: abort.signal,
      onChunk: chunk => {
        const data = chunk.data;
        if (data.section === "repositorySession") {
          if (sessionData || repository || chunk.done) throw invalidSessionResponse("刷新会话头位置无效");
          if (chunk.coverage.complete || chunk.coverage.processed !== 0 || chunk.nextCursor !== null) throw invalidSessionResponse("刷新会话头 envelope 无效");
          sessionData = data;
          return;
        }
        if (data.section === "repository") {
          if (!sessionData || repository || chunk.done) throw invalidSessionResponse("刷新仓库头位置无效");
          if (chunk.coverage.complete || chunk.coverage.processed !== 0 || chunk.nextCursor !== null) throw invalidSessionResponse("刷新仓库头 envelope 无效");
          repository = data.repository;
          refs = data.refs.slice(0, MAX_REFS);
          refsTruncated = data.refsTruncated || data.refs.length > MAX_REFS;
          return;
        }
        if (data.section !== "historyPage" || !repository || sawTerminalPage) {
          throw invalidSessionResponse("刷新收到意外或乱序区块");
        }
        const currentMetadata = JSON.stringify({ cursor: data.cursor, offset: data.offset, pageSize: data.pageSize,
          previousCursor: data.previousCursor, hasMore: data.hasMore,
          newSinceLastSeenStatus: data.newSinceLastSeenStatus, lastSeenDividerOid: data.lastSeenDividerOid });
        if (metadata && metadata !== currentMetadata) throw invalidSessionResponse("刷新历史页分块元数据不一致");
        metadata = currentMetadata;
        if (data.pageSize !== pageSize || commits.length + data.commits.length > pageSize) throw invalidSessionResponse("刷新历史页超过请求上限");
        const pageObjectFormat = repository?.objectFormat;
        if (!pageObjectFormat || !Array.isArray(data.commits) || !data.commits.every(commit => validHistoryGraphCommit(commit, pageObjectFormat))) {
          throw invalidSessionResponse("刷新历史页包含无效或缺失的图布局");
        }
        if (data.offset !== 0 || data.previousCursor !== null) throw invalidSessionResponse("刷新首屏位置无效");
        if (chunk.done ? (!chunk.coverage.complete || data.hasMore !== (chunk.nextCursor !== null))
          : (chunk.coverage.complete || chunk.nextCursor !== null)) throw invalidSessionResponse("刷新历史页 envelope 终态无效");
        commits.push(...data.commits);
        page = { commits, offset: data.offset, pageSize: data.pageSize, cursor: data.cursor,
          previousCursor: data.previousCursor, hasMore: data.hasMore,
          newSinceLastSeenStatus: data.newSinceLastSeenStatus, lastSeenDividerOid: data.lastSeenDividerOid };
        if (chunk.done) sawTerminalPage = true;
      },
    });
    if (!sessionData || !repository || !page || !sawTerminalPage || !completion.coverage.complete ||
      completion.coverage.processed !== commits.length || completion.nextCursor && !page.hasMore ||
      !completion.nextCursor && page.hasMore) throw invalidSessionResponse("刷新响应不完整或不一致");
    const nextSession = sessionData.session;
    if (nextSession.repoId === previous.repoId || nextSession.generation === previous.generation ||
      nextSession.repositoryKey !== previous.repositoryKey || nextSession.worktreeId !== previous.worktreeId ||
      repository.path !== nextSession.repository.path ||
      !sameScope(nextSession.scope, method === "selectRepositoryScope" ? extraParams.scope as RepositoryScope : previous.scope)) {
      throw invalidSessionResponse("范围事务返回了不匹配的新仓库会话");
    }
    if (this.disposed || lifecycleEpoch !== this.lifecycleEpoch || this.core.getStatus().state !== "ready") {
      throw new ProtocolClientError("CORE_EXITED", "核心已关闭，忽略迟到的刷新会话", true);
    }
    this.current = nextSession;
    this.currentCommitDetails = undefined;
    this.core.observeLatestContext(contextOf(nextSession));
    this.core.switchCurrentContext(contextOf(nextSession));
    const historyPage: HistoryPage = { repository, refs, refsTruncated, ...page, commits, nextCursor: completion.nextCursor };
    return { session: nextSession, page: historyPage };
  }

  private async readRefMergeStatus(
    session: RepositorySessionInfo,
    refNames: string[],
    abort: AbortController,
  ): Promise<RefMergeStatusResult> {
    let result: RefMergeStatusResult | undefined;
    const completion = await this.core.request("refMergeStatus", { refNames }, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      signal: abort.signal,
      drainAfterAbort: true,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (result || chunk.data.section !== "refMergeStatus" || !chunk.done) {
          throw invalidSessionResponse("分支合入状态响应无效");
        }
        result = chunk.data.result;
      },
    });
    this.ensureCurrent(session);
    if (!result || !completion.coverage.complete || completion.coverage.processed !== result.statuses.length ||
      result.statuses.length !== refNames.length) throw invalidSessionResponse("分支合入状态响应不完整");
    const names = new Set(refNames);
    for (const status of result.statuses) {
      if (!names.delete(status.name)) throw invalidSessionResponse("分支合入状态响应包含重复或意外的分支");
    }
    if (names.size !== 0) throw invalidSessionResponse("分支合入状态响应遗漏了分支");
    return result;
  }

  private async cancelAndDrainHistoryRead(error: ProtocolClientError): Promise<void> {
    const active = this.activeHistoryRead;
    if (!active) return;
    active.abort.abort(new Error(error.message));
    await active.done.catch(() => undefined);
  }

  private async singleSessionRequest(
    method: "getRepositorySession" | "recordRepositoryView" | "closeRepository",
    params: Record<string, never>,
    session: RepositorySessionInfo,
    fatalOnTimeout = false,
  ): Promise<SessionResponse | ViewRecordedResponse | ClosedResponse> {
    let response: SessionResponse | ViewRecordedResponse | ClosedResponse | undefined;
    const completion = await this.core.request(method, params, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      fatalOnTimeout,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (response || !chunk.done) throw invalidSessionResponse("仓库会话响应无效");
        const data = chunk.data;
        if (data.section !== "repositorySession" && data.section !== "repositoryViewRecorded" && data.section !== "repositoryClosed") {
          throw invalidSessionResponse(`仓库会话收到意外区块：${data.section}`);
        }
        response = data;
      },
    });
    this.ensureCurrent(session);
    if (!response || !completion.coverage.complete || completion.coverage.processed !== 1) {
      throw invalidSessionResponse("仓库会话响应不完整");
    }
    return response;
  }

  private requireCurrent(): RepositorySessionInfo {
    this.requireCapability("repositorySessions");
    this.requireCapability("repositoryScopes");
    if (!this.current) throw new ProtocolClientError("STALE_CONTEXT", "当前没有打开的仓库会话");
    return this.current;
  }

  private requireHistoryCapability(): RepositorySessionInfo {
    this.requireCapability("historyPagination");
    this.requireCapability("historyNewSinceLastSeen");
    this.requireCapability("historyGraph");
    return this.requireCurrent();
  }

  private ensureCurrent(session: RepositorySessionInfo): void {
    if (this.current !== session) throw new ProtocolClientError("STALE_CONTEXT", "仓库会话已被切换", true);
  }

  private requireCapability(capability: string): void {
    const status: CoreStatus = this.core.getStatus();
    if (status.state !== "ready") throw new ProtocolClientError("CORE_EXITED", "核心尚未就绪", true);
    if (!status.core.capabilities.includes(capability as typeof status.core.capabilities[number])) {
      throw new ProtocolClientError("UNKNOWN_METHOD", capability === "metadataIndex"
        ? "核心不支持元数据索引，请更新核心版本" : capability === "metadataSearch"
          ? "核心不支持元数据搜索，请更新核心版本" : capability === "historyGraph"
            ? "核心不支持历史图布局，请更新核心版本" : capability === "commitDetails"
              ? "核心不支持提交详情，请更新核心版本" : capability === "workspaceStatus"
                ? "核心还不能读取工作区（P4-09 后端尚未接入）" : "核心不支持只读范围导航，请更新核心版本");
    }
  }

  private requireMetadataIndexCapability(): void {
    this.requireCapability("metadataIndex");
  }

  private requireSearchCapability(): void {
    this.requireCapability("metadataSearch");
  }

  private onCoreStatus(status: CoreStatus): void {
    if (status.state === "ready") return;
    this.lifecycleEpoch += 1;
    this.operation += 1;
    this.pageIntent += 1;
    this.activeOpen?.abort.abort(new Error("核心已退出"));
    this.activeHistoryRead?.abort.abort(new Error("核心已退出"));
    this.activeRefresh?.abort.abort(new Error("核心已退出"));
    this.activeMergeStatus?.abort.abort(new Error("核心已退出"));
    ++this.searchIntent;
    this.activeSearchRequest?.abort.abort(new Error("核心已退出"));
    this.activeSearchRequest = undefined;
    ++this.commitDetailsIntent;
    this.activeCommitDetailRequest?.abort.abort(new Error("核心已退出"));
    this.activeCommitDetailRequest = undefined;
    if (this.activeMetadataIndexRequest?.kind === "status") this.activeMetadataIndexRequest.abort?.abort(new Error("核心已退出"));
    ++this.metadataIndexIntent;
    void this.cancelPassiveRequestsForTransition();
    this.activeOpen = undefined;
    this.current = undefined;
    this.currentCommitDetails = undefined;
    this.core.switchCurrentContext(NULL_CONTEXT);
  }
}

const NULL_CONTEXT: RequestContext = Object.freeze({ repoId: null, generation: null });

function contextOf(session: RepositorySessionInfo): RequestContext {
  return { repoId: session.repoId, generation: session.generation };
}

function sameSession(left: RepositorySessionInfo, right: RepositorySessionInfo): boolean {
  return left.repoId === right.repoId && left.generation === right.generation;
}

function sameScope(left: RepositoryScope, right: RepositoryScope): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  if ("ref" in left && "ref" in right) return left.ref === right.ref;
  if ("worktree" in left && "worktree" in right) return left.worktree === right.worktree;
  return false;
}

function validateScope(value: unknown): asserts value is RepositoryScope {
  if (value === "head" || value === "allBranches") return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolClientError("INVALID_REQUEST", "浏览范围无效");
  }
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.length !== 1) throw new ProtocolClientError("INVALID_REQUEST", "浏览范围无效");
  if (keys[0] === "ref" && typeof item.ref === "string" && item.ref.length > 0 && Buffer.byteLength(item.ref, "utf8") <= 16 * 1024) return;
  if (keys[0] === "worktree" && typeof item.worktree === "string" && item.worktree.length > 0 && Buffer.byteLength(item.worktree, "utf8") <= 256) return;
  throw new ProtocolClientError("INVALID_REQUEST", "浏览范围无效");
}

function validateSearchCommitsParams(value: unknown): SearchCommitsParams {
  if (!isRecord(value) || !hasExactKeys(value, ["anchorOid", "cursor", "pageSize", "query"]) ||
    !Number.isInteger(value.pageSize) || (value.pageSize as number) < 1 || (value.pageSize as number) > 500 ||
    (value.cursor !== null && (typeof value.cursor !== "string" || Buffer.byteLength(value.cursor, "utf8") > 1024)) ||
    (value.cursor !== null && value.anchorOid !== null) ||
    (value.anchorOid !== null && (typeof value.anchorOid !== "string" || !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value.anchorOid))) ||
    !isSearchQuery(value.query)) throw new ProtocolClientError("INVALID_REQUEST", "搜索请求参数无效");
  return value as unknown as SearchCommitsParams;
}

function validateSearchIdentitiesParams(value: unknown): SearchIdentitiesParams {
  if (!isRecord(value) || !hasExactKeys(value, ["field", "limit", "text"]) ||
    (value.field !== "author" && value.field !== "committer") || typeof value.text !== "string" ||
    Buffer.byteLength(value.text, "utf8") > 1024 || !Number.isInteger(value.limit) ||
    (value.limit as number) < 1 || (value.limit as number) > 100) {
    throw new ProtocolClientError("INVALID_REQUEST", "身份建议请求参数无效");
  }
  return value as unknown as SearchIdentitiesParams;
}

function validateSearchPathsParams(value: unknown): ListSearchPathsParams {
  if (!isRecord(value) || !hasExactKeys(value, ["limit", "text"]) || typeof value.text !== "string" ||
    Buffer.byteLength(value.text, "utf8") > 32 * 1024 || !Number.isInteger(value.limit) ||
    (value.limit as number) < 1 || (value.limit as number) > 100) {
    throw new ProtocolClientError("INVALID_REQUEST", "路径建议请求参数无效");
  }
  return value as unknown as ListSearchPathsParams;
}

function validateActivityStatsParams(value: unknown): GetActivityStatsParams {
  if (!isRecord(value) || !hasExactKeys(value, ["query"]) || !isSearchQuery(value.query)) {
    throw new ProtocolClientError("INVALID_REQUEST", "活动统计请求参数无效");
  }
  return value as unknown as GetActivityStatsParams;
}

function validateHandoffFactsParams(value: unknown): GetHandoffFactsParams {
  const validNullableText = (item: unknown, maxBytes: number) => item === null || typeof item === "string" && item.length > 0 &&
    Buffer.byteLength(item, "utf8") <= maxBytes && !item.includes("\0");
  if (!isRecord(value) || !hasExactKeys(value, ["branchRef", "operationWorktreeId", "selectedOid", "staleWorktreeId"]) ||
    !validNullableText(value.branchRef, 16 * 1024) || !validNullableText(value.operationWorktreeId, 256) || !validNullableText(value.staleWorktreeId, 256) ||
    !(value.selectedOid === null || typeof value.selectedOid === "string" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value.selectedOid))) {
    throw new ProtocolClientError("INVALID_REQUEST", "Agent 交接资料请求参数无效");
  }
  return value as unknown as GetHandoffFactsParams;
}

function validateGetCommitParams(value: unknown): GetCommitParams {
  if (!isRecord(value) || !hasExactKeys(value, ["oid"]) || typeof value.oid !== "string" ||
    !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value.oid)) {
    throw new ProtocolClientError("INVALID_REQUEST", "提交详情请求参数无效");
  }
  return { oid: value.oid.toLowerCase() };
}

function validateBranchesContainingParams(value: unknown): BranchesContainingParams {
  if (!isRecord(value) || !hasExactKeys(value, ["oid"]) || typeof value.oid !== "string" ||
    !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value.oid)) {
    throw new ProtocolClientError("INVALID_REQUEST", "包含分支请求参数无效");
  }
  return { oid: value.oid.toLowerCase() };
}

function validateReadDiffParams(value: unknown): ReadDiffParams {
  const validPathHex = (item: unknown) => item === null || typeof item === "string" && item.length > 0 &&
    item.length <= MAX_PATH_BYTES * 2 && item.length % 2 === 0 && /^[0-9a-f]+$/i.test(item);
  if (!isRecord(value) || !hasExactKeys(value, ["newPathHex", "oid", "oldPathHex", "parentIndex"]) ||
    typeof value.oid !== "string" || !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value.oid) ||
    value.parentIndex !== null && (!Number.isInteger(value.parentIndex) || (value.parentIndex as number) < 0 || (value.parentIndex as number) > 127) ||
    !validPathHex(value.oldPathHex) || !validPathHex(value.newPathHex) || value.oldPathHex === null && value.newPathHex === null) {
    throw new ProtocolClientError("INVALID_REQUEST", "文件 diff 请求参数无效");
  }
  return { oid: value.oid.toLowerCase(), parentIndex: value.parentIndex as number | null,
    oldPathHex: typeof value.oldPathHex === "string" ? value.oldPathHex.toLowerCase() : null,
    newPathHex: typeof value.newPathHex === "string" ? value.newPathHex.toLowerCase() : null };
}

function validateListChangedFilesParams(value: unknown): ListChangedFilesParams {
  if (!isRecord(value) || !hasExactKeys(value, ["offset", "oid", "pageSize", "parentIndex"]) ||
    typeof value.oid !== "string" || !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value.oid) ||
    !Number.isInteger(value.offset) || (value.offset as number) < 0 || (value.offset as number) > 0xffff_ffff ||
    !Number.isInteger(value.pageSize) || (value.pageSize as number) < 1 || (value.pageSize as number) > 200 ||
    value.parentIndex !== null && (!Number.isInteger(value.parentIndex) || (value.parentIndex as number) < 0 || (value.parentIndex as number) > 127)) {
    throw new ProtocolClientError("INVALID_REQUEST", "文件清单请求参数无效");
  }
  return { ...value, oid: value.oid.toLowerCase() } as unknown as ListChangedFilesParams;
}

function validateReadMergeCommitsParams(value: unknown): ReadMergeCommitsParams {
  if (!isRecord(value) || !hasExactKeys(value, ["offset", "oid", "pageSize", "parentIndex"]) ||
    typeof value.oid !== "string" || !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value.oid) ||
    !Number.isInteger(value.offset) || (value.offset as number) < 0 || (value.offset as number) > 0xffff_ffff ||
    !Number.isInteger(value.pageSize) || (value.pageSize as number) < 1 || (value.pageSize as number) > 200 ||
    !Number.isInteger(value.parentIndex) || (value.parentIndex as number) < 1 || (value.parentIndex as number) > 127) {
    throw new ProtocolClientError("INVALID_REQUEST", "merge 提交分页请求参数无效");
  }
  return { ...value, oid: value.oid.toLowerCase() } as unknown as ReadMergeCommitsParams;
}

function validateFileParent(parentIndex: number | null, parentCount: number): void {
  if (parentCount === 0 ? parentIndex !== null : parentIndex === null || parentIndex >= parentCount) {
    throw new ProtocolClientError("INVALID_REQUEST", "文件比较父提交序号无效");
  }
}

function isSearchQuery(value: unknown): value is SearchQuery {
  if (!isRecord(value) || !hasExactKeys(value, ["authors", "caseSensitive", "committers", "fromTimestamp", "message", "oidPrefix", "path", "timeField", "timeZone", "toTimestamp"])) return false;
  const path = value.path;
  const validPath = path === null || isRecord(path) && hasExactKeys(path, ["includeDescendants", "kind", "rawHex"]) &&
    (path.kind === "file" || path.kind === "directory") && typeof path.includeDescendants === "boolean" &&
    typeof path.rawHex === "string" && path.rawHex.length <= MAX_PATH_BYTES * 2 && path.rawHex.length % 2 === 0 && /^[0-9a-f]*$/i.test(path.rawHex) &&
    (path.kind === "directory" || path.rawHex.length > 0) && !Buffer.from(path.rawHex, "hex").includes(0);
  const timestamp = (item: unknown) => item === null || Number.isSafeInteger(item);
  const identities = (item: unknown) => Array.isArray(item) && item.length <= 50 && item.every(identity =>
    isRecord(identity) && hasExactKeys(identity, ["email", "name"]) && typeof identity.name === "string" &&
    Buffer.byteLength(identity.name, "utf8") <= 4096 && typeof identity.email === "string" && Buffer.byteLength(identity.email, "utf8") <= 4096);
  return typeof value.message === "string" && Buffer.byteLength(value.message, "utf8") <= 4096 &&
    typeof value.caseSensitive === "boolean" && identities(value.authors) && identities(value.committers) &&
    typeof value.oidPrefix === "string" && (value.oidPrefix === "" || /^[0-9a-fA-F]{4,64}$/.test(value.oidPrefix)) &&
    (value.timeField === "author" || value.timeField === "committer") && timestamp(value.fromTimestamp) && timestamp(value.toTimestamp) &&
    (value.fromTimestamp === null || value.toTimestamp === null || (value.fromTimestamp as number) < (value.toTimestamp as number)) &&
    typeof value.timeZone === "string" && value.timeZone.length > 0 && Buffer.byteLength(value.timeZone, "utf8") <= 128 && validPath;
}

function sameSearchPageMetadata(left: SearchPage, right: SearchPage): boolean {
  return left.queryKey === right.queryKey && left.snapshotKey === right.snapshotKey && left.resultVersion === right.resultVersion &&
    left.pageOffset === right.pageOffset && left.previousCursor === right.previousCursor && left.nextCursor === right.nextCursor &&
    left.matchedCount === right.matchedCount && left.coverage.processed === right.coverage.processed &&
    left.coverage.complete === right.coverage.complete && left.anchorFound === right.anchorFound &&
    JSON.stringify(left.index) === JSON.stringify(right.index);
}

function validSearchPage(page: SearchPage, params: SearchCommitsParams, commits: SearchPage["commits"]): boolean {
  if (!page.queryKey || !page.snapshotKey || !page.resultVersion || !Number.isSafeInteger(page.pageOffset) || page.pageOffset < 0 ||
    !Number.isSafeInteger(page.matchedCount) || page.matchedCount < 0 || page.matchedCount > page.coverage.processed || !Number.isSafeInteger(page.coverage.processed) ||
    page.coverage.processed < 0 ||
    page.index.coverage.complete !== (page.index.state === "complete") || commits.length > params.pageSize || commits.length === 0 && page.matchedCount > 0 ||
    page.pageOffset + commits.length > page.matchedCount || (page.anchorFound === false && page.pageOffset !== 0) ||
    (page.anchorFound === null && params.anchorOid !== null) || (page.anchorFound !== null && params.anchorOid === null) ||
    (page.pageOffset === 0) !== (page.previousCursor === null) ||
    (page.pageOffset + commits.length < page.matchedCount) !== (page.nextCursor !== null)) return false;
  const seen = new Set<string>();
  let previousTime = Number.POSITIVE_INFINITY;
  let previousOid = "";
  for (const commit of commits) {
    if (seen.has(commit.oid) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit.oid)) return false;
    seen.add(commit.oid);
    const identity = params.query.timeField === "author" ? commit.author : commit.committer;
    const timestamp = Number(identity.timestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp > previousTime || timestamp === previousTime && commit.oid < previousOid) return false;
    previousTime = timestamp;
    previousOid = commit.oid;
  }
  return true;
}

function validSearchPathMatches(matches: SearchPage["pathMatches"], params: SearchCommitsParams, commits: SearchPage["commits"]): boolean {
  if (!Array.isArray(matches)) return false;
  if (params.query.path === null) return matches.length === 0;
  if (matches.length !== commits.length) return false;
  const commitsByOid = new Map(commits.map(commit => [commit.oid, commit]));
  const seen = new Set<string>();
  for (const match of matches) {
    const commit = commitsByOid.get(match.oid);
    if (!commit || seen.has(match.oid) || !Array.isArray(match.parentIndices) || match.parentIndices.length === 0) return false;
    seen.add(match.oid);
    const parents = new Set<number | null>();
    for (const parentIndex of match.parentIndices) {
      if (parentIndex === null ? commit.parents.length !== 0 || match.parentIndices.length !== 1 :
        !Number.isInteger(parentIndex) || parentIndex < 0 || parentIndex >= commit.parents.length || parents.has(parentIndex)) return false;
      parents.add(parentIndex);
    }
  }
  return seen.size === commits.length;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validHistoryDateLocation(
  response: HistoryDateLocationResponse,
  objectFormat: string,
  pageSize: number,
): boolean {
  const location = response.location as unknown;
  const oidLength = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : 0;
  return isRecord(location) && hasExactKeys(location, ["cursor", "offset", "oid", "pageSize"]) &&
    typeof location.oid === "string" && location.oid.length === oidLength && /^[0-9a-fA-F]+$/.test(location.oid) &&
    typeof location.cursor === "string" && location.cursor.length > 0 && location.cursor.length <= 512 &&
    Number.isSafeInteger(location.offset) && (location.offset as number) >= 0 && (location.offset as number) <= 0xffff_ffff &&
    Number.isInteger(location.pageSize) && location.pageSize === pageSize && (location.offset as number) % pageSize === 0;
}

function appendHistoryPageChunk(
  chunk: ServerResponseMessage,
  state: HistoryPageAccumulator,
  session: RepositorySessionInfo,
  pageSize: number,
  expectedCursor?: string | null,
  expectedOffset?: number,
  initialPage = false,
): void {
  if (state.sawTerminalPage) throw invalidSessionResponse("历史页终止块之后仍收到数据");
  if (chunk.data.section !== "historyPage") throw invalidSessionResponse(`历史页收到意外区块：${chunk.data.section}`);
  const data = chunk.data;
  const currentMetadata = JSON.stringify({
    cursor: data.cursor,
    offset: data.offset,
    pageSize: data.pageSize,
    previousCursor: data.previousCursor,
    hasMore: data.hasMore,
    newSinceLastSeenStatus: data.newSinceLastSeenStatus,
    lastSeenDividerOid: data.lastSeenDividerOid,
  });
  if (state.metadata && currentMetadata !== state.metadata) throw invalidSessionResponse("历史页分块元数据不一致");
  state.metadata = currentMetadata;
  if (!Array.isArray(data.commits) || data.pageSize !== pageSize || state.commits.length + data.commits.length > pageSize) {
    throw invalidSessionResponse("历史页提交数量超过请求上限");
  }
  if (!data.commits.every(commit => validHistoryGraphCommit(commit, session.repository.objectFormat))) {
    throw invalidSessionResponse("历史页包含无效或缺失的图布局");
  }
  if ((initialPage && (data.offset !== 0 || data.previousCursor !== null)) ||
    (typeof expectedCursor === "string" && data.cursor !== expectedCursor) ||
    (expectedOffset !== undefined && data.offset !== expectedOffset)) {
    throw invalidSessionResponse("历史页游标与位置不一致");
  }
  if (chunk.done ? (!chunk.coverage.complete || data.hasMore !== (chunk.nextCursor !== null))
    : (chunk.coverage.complete || chunk.nextCursor !== null)) throw invalidSessionResponse("历史页 envelope 终态无效");
  state.commits.push(...data.commits);
  state.page = {
    commits: state.commits,
    offset: data.offset,
    pageSize: data.pageSize,
    cursor: data.cursor,
    previousCursor: data.previousCursor,
    hasMore: data.hasMore,
    newSinceLastSeenStatus: data.newSinceLastSeenStatus,
    lastSeenDividerOid: data.lastSeenDividerOid,
  };
  if (chunk.done) state.sawTerminalPage = true;
}

function completeHistoryPage(
  state: HistoryPageAccumulator,
  coverage: { complete: boolean; processed: number },
  nextCursor: string | null,
  expectedOid?: string,
): HistoryPageContent {
  const page = state.page;
  if (!page || !state.sawTerminalPage || !coverage.complete || coverage.processed !== state.commits.length ||
    (nextCursor !== null && !page.hasMore) || (nextCursor === null && page.hasMore) ||
    (expectedOid !== undefined && !state.commits.some(commit => commit.oid === expectedOid))) {
    throw invalidSessionResponse("核心返回了不完整或不一致的历史页");
  }
  return { ...page, commits: state.commits, nextCursor };
}

function validHistoryGraphCommit(value: unknown, objectFormat: string): boolean {
  const oidLength = objectFormat === "sha256" ? 64 : 40;
  const validOid = (oid: unknown): oid is string => typeof oid === "string" && oid.length === oidLength && /^[0-9a-f]+$/i.test(oid);
  if (!isRecord(value) || !validOid(value.oid) || !Array.isArray(value.parents) || !value.parents.every(validOid)) return false;
  const commit = value as unknown as HistoryCommit;
  const graph = (value as Record<string, unknown>).graph;
  if (!isRecord(graph) || !hasExactKeys(graph, ["lane", "color", "parents", "boundary", "above", "below", "hiddenLaneCount", "hiddenThroughRanges", "segments"])) return false;
  if (!Number.isInteger(graph.lane) || (graph.lane as number) < 0 || (graph.lane as number) > 16_383 ||
    graph.color !== (graph.lane as number) % 6 || typeof graph.boundary !== "boolean" ||
    !Number.isInteger(graph.above) || (graph.above as number) < 0 || (graph.above as number) > 63 ||
    !Number.isInteger(graph.below) || (graph.below as number) < 0 || (graph.below as number) > 63 ||
    !Number.isInteger(graph.hiddenLaneCount) || (graph.hiddenLaneCount as number) < 0 || (graph.hiddenLaneCount as number) > 16_384 ||
    !Array.isArray(graph.parents) || graph.parents.length > 128 || !graph.parents.every(validOid) ||
    !Array.isArray(graph.hiddenThroughRanges) || graph.hiddenThroughRanges.length > 8192 ||
    !Array.isArray(graph.segments) || graph.segments.length > 256) return false;
  const parents = graph.parents as string[];
  if (graph.boundary !== (parents.length !== commit.parents.length || parents.some((parent, index) => parent !== commit.parents[index]))) return false;
  const lane = graph.lane as number;
  const above = graph.above as number;
  const below = graph.below as number;
  const representedAbove = new Set<number>();
  const representedBelow = new Set<number>();
  const hiddenLanes = new Set<number>();
  const segments = new Set<string>();
  if (lane >= 6) hiddenLanes.add(lane);
  let previousRangeEnd = 5;
  for (const range of graph.hiddenThroughRanges) {
    if (!isRecord(range) || !hasExactKeys(range, ["startLane", "endLane"]) ||
      !Number.isInteger(range.startLane) || (range.startLane as number) < 6 || (range.startLane as number) > 16_383 ||
      !Number.isInteger(range.endLane) || (range.endLane as number) < (range.startLane as number) || (range.endLane as number) > 16_383 ||
      (range.startLane as number) <= previousRangeEnd) return false;
    const start = range.startLane as number;
    const end = range.endLane as number;
    for (let hiddenLane = start; hiddenLane <= end; hiddenLane += 1) hiddenLanes.add(hiddenLane);
    previousRangeEnd = end;
  }
  for (const rawSegment of graph.segments) {
    if (!isRecord(rawSegment) || !hasExactKeys(rawSegment, ["kind", "fromLane", "toLane", "color"])) return false;
    const { kind, fromLane, toLane, color } = rawSegment;
    if (!(kind === "through" || kind === "incoming" || kind === "outgoing") ||
      !Number.isInteger(fromLane) || (fromLane as number) < 0 || (fromLane as number) > 16_383 ||
      !Number.isInteger(toLane) || (toLane as number) < 0 || (toLane as number) > 16_383 ||
      !Number.isInteger(color) || (color as number) < 0 || (color as number) >= 6 ||
      kind === "through" && (fromLane as number) >= 6) return false;
    const segmentKey = `${kind}:${fromLane}:${toLane}`;
    if (segments.has(segmentKey) || kind === "through" && fromLane !== toLane) return false;
    segments.add(segmentKey);
    if (kind === "through" && (fromLane as number < 6 && !maskHasLane(above, fromLane as number) ||
      (toLane as number) < 6 && !maskHasLane(below, toLane as number) || color !== (fromLane as number) % 6)) return false;
    if (kind === "incoming" && ((fromLane as number) < 6 && !maskHasLane(above, fromLane as number) ||
      toLane !== lane || color !== (fromLane as number) % 6)) return false;
    if (kind === "outgoing" && (fromLane !== lane || (toLane as number) < 6 && !maskHasLane(below, toLane as number) ||
      color !== (toLane as number) % 6)) return false;
    if ((kind === "through" || kind === "incoming") && (fromLane as number) < 6) representedAbove.add(fromLane as number);
    if ((kind === "through" || kind === "outgoing") && (toLane as number) < 6) representedBelow.add(toLane as number);
    if ((fromLane as number) >= 6) hiddenLanes.add(fromLane as number);
    if ((toLane as number) >= 6) hiddenLanes.add(toLane as number);
  }
  for (let visibleLane = 0; visibleLane < 6; visibleLane += 1) {
    if (maskHasLane(above, visibleLane) !== representedAbove.has(visibleLane) ||
      maskHasLane(below, visibleLane) !== representedBelow.has(visibleLane)) return false;
  }
  if ((graph.hiddenLaneCount as number) < hiddenLanes.size) return false;
  return true;
}

function validCommitDetails(details: CommitDetails, oid: string, objectFormat: string): boolean {
  const oidLength = objectFormat === "sha256" ? 64 : 40;
  if (!isRecord(details) || !hasExactKeys(details, ["commit", "message", "messageWithoutTrailers", "observedAtUnixMs", "refs", "refsTruncated", "trailers", "update", "worktrees", "worktreesTruncated"]) ||
    !validCommitSummary(details.commit, oidLength) || details.commit.oid !== oid ||
    typeof details.message !== "string" || Buffer.byteLength(details.message, "utf8") > 512 * 1024 ||
    typeof details.messageWithoutTrailers !== "string" || Buffer.byteLength(details.messageWithoutTrailers, "utf8") > 512 * 1024 ||
    !Number.isSafeInteger(details.observedAtUnixMs) || typeof details.refsTruncated !== "boolean" ||
    !Array.isArray(details.refs) || details.refs.length > MAX_REFS || !details.refs.every(ref => validRefInfo(ref, objectFormat)) ||
    !Array.isArray(details.trailers) || details.trailers.length > 4_096 || !details.trailers.every(trailer => isRecord(trailer) &&
      hasExactKeys(trailer, ["key", "value"]) && typeof trailer.key === "string" && typeof trailer.value === "string") ||
    typeof details.worktreesTruncated !== "boolean" || !Array.isArray(details.worktrees) || details.worktrees.length > 128 ||
    !details.worktrees.every(worktree => validWorktreeInfo(worktree)) || !isRecord(details.update) ||
    !hasExactKeys(details.update, ["checkedAtUnixMs", "reason", "state"]) || !Number.isSafeInteger(details.update.checkedAtUnixMs) ||
    !["unaffected", "affected", "unknown"].includes(details.update.state as string) ||
    details.update.reason !== null && !["scopeUnavailable", "noLongerReachable"].includes(details.update.reason as string) ||
    details.update.state === "affected" && details.update.reason === null ||
    details.update.state !== "affected" && details.update.reason !== null) return false;
  return true;
}

function validCommitSummary(value: unknown, oidLength: number): value is CommitSummary {
  if (!isRecord(value) || !hasExactKeys(value, ["author", "committer", "oid", "parents", "summary", "summaryTruncated", "textLossy"]) ||
    typeof value.oid !== "string" || value.oid.length !== oidLength || !/^[0-9a-f]+$/i.test(value.oid) ||
    !Array.isArray(value.parents) || value.parents.length > 128 || !value.parents.every(parent => typeof parent === "string" && parent.length === oidLength && /^[0-9a-f]+$/i.test(parent)) ||
    typeof value.summary !== "string" || Buffer.byteLength(value.summary, "utf8") > 4_096 ||
    typeof value.summaryTruncated !== "boolean" || typeof value.textLossy !== "boolean") return false;
  const identity = (item: unknown) => isRecord(item) && hasExactKeys(item, ["email", "name", "offset", "timestamp"]) &&
    typeof item.name === "string" && Buffer.byteLength(item.name, "utf8") <= 4_096 &&
    typeof item.email === "string" && Buffer.byteLength(item.email, "utf8") <= 4_096 &&
    typeof item.timestamp === "string" && /^-?\d{1,16}$/.test(item.timestamp) &&
    typeof item.offset === "string" && /^[+-]\d{4}$/.test(item.offset);
  return identity(value.author) && identity(value.committer);
}

function validRefInfo(value: unknown, objectFormat: string): value is RefInfo {
  const oidLength = objectFormat === "sha256" ? 64 : 40;
  return isRecord(value) && hasExactKeys(value, ["kind", "name", "oid", "peeledOid", "symbolicTarget"]) &&
    ["localBranch", "remoteBranch", "tag"].includes(value.kind as string) && typeof value.name === "string" &&
    Buffer.byteLength(value.name, "utf8") <= 16 * 1024 && typeof value.oid === "string" && value.oid.length === oidLength && /^[0-9a-f]+$/i.test(value.oid) &&
    (value.peeledOid === null || typeof value.peeledOid === "string" && value.peeledOid.length === oidLength && /^[0-9a-f]+$/i.test(value.peeledOid)) &&
    (value.symbolicTarget === null || typeof value.symbolicTarget === "string" && Buffer.byteLength(value.symbolicTarget, "utf8") <= 16 * 1024);
}

function validWorktreeInfo(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["available", "headOid", "headReference", "id", "isBare", "isCurrent", "isDetached", "isMain", "lockedReason", "path", "prunableReason"]) &&
    typeof value.available === "boolean" && (value.headOid === null || typeof value.headOid === "string" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(value.headOid)) &&
    (value.headReference === null || typeof value.headReference === "string" && Buffer.byteLength(value.headReference, "utf8") <= 16 * 1024) &&
    typeof value.id === "string" && value.id.length > 0 && Buffer.byteLength(value.id, "utf8") <= 256 &&
    typeof value.isBare === "boolean" && typeof value.isCurrent === "boolean" && typeof value.isDetached === "boolean" && typeof value.isMain === "boolean" &&
    (value.lockedReason === null || typeof value.lockedReason === "string" && Buffer.byteLength(value.lockedReason, "utf8") <= 16 * 1024) &&
    typeof value.path === "string" && Buffer.byteLength(value.path, "utf8") <= MAX_PATH_BYTES && !value.path.includes("\0") &&
    (value.prunableReason === null || typeof value.prunableReason === "string" && Buffer.byteLength(value.prunableReason, "utf8") <= 16 * 1024);
}

function validGitPath(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["display", "rawHex", "textLossy"]) ||
    typeof value.display !== "string" || Buffer.byteLength(value.display, "utf8") > MAX_PATH_BYTES * 3 ||
    typeof value.rawHex !== "string" || value.rawHex.length > MAX_PATH_BYTES * 2 || value.rawHex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value.rawHex) ||
    typeof value.textLossy !== "boolean") return false;
  const bytes = Buffer.from(value.rawHex, "hex");
  let decoded: string;
  let lossy = false;
  try { decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { decoded = bytes.toString("utf8"); lossy = true; }
  return value.display === decoded && value.textLossy === lossy;
}

function validChangedFilesPage(page: ChangedFilesPage, params: ListChangedFilesParams, details: CommitDetails, objectFormat: string): boolean {
  const parents = details.commit.parents;
  const expectedParent = params.parentIndex === null ? null : parents[params.parentIndex] ?? null;
  if (!isRecord(page) || !hasExactKeys(page, ["files", "hasMore", "offset", "oid", "overview", "pageSize", "parentIndex", "parentOid", "totalFiles"]) ||
    page.oid !== params.oid || page.parentIndex !== params.parentIndex || page.parentOid !== expectedParent || page.offset !== params.offset ||
    page.pageSize !== params.pageSize || !Number.isSafeInteger(page.totalFiles) || page.totalFiles < 0 || page.totalFiles > 20_000 ||
    !Array.isArray(page.files) || page.files.length > params.pageSize || page.offset > page.totalFiles ||
    page.files.length !== Math.min(params.pageSize, page.totalFiles - page.offset) ||
    typeof page.hasMore !== "boolean" || page.hasMore !== (page.offset + page.files.length < page.totalFiles) ||
    !validChangeOverview(page.overview) || page.overview.totalFiles !== page.totalFiles ||
    !page.files.every(file => validChangedFile(file, objectFormat)) || new Set(page.files.map(file => `${file.status}:${file.oldPath?.rawHex ?? ""}:${file.newPath?.rawHex ?? ""}`)).size !== page.files.length) return false;
  return true;
}

function validChangeOverview(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["additions", "binaryFiles", "counts", "deletions", "directories", "gitlinkFiles", "totalFiles"]) ||
    !isNonnegativeSafeInteger(value.additions) || !isNonnegativeSafeInteger(value.deletions) ||
    !isNonnegativeSafeInteger(value.binaryFiles) || !isNonnegativeSafeInteger(value.gitlinkFiles) || !isNonnegativeSafeInteger(value.totalFiles) ||
    value.binaryFiles > value.totalFiles || value.gitlinkFiles > value.totalFiles || !isRecord(value.counts) ||
    !hasExactKeys(value.counts, ["added", "copied", "deleted", "modified", "renamed", "typeChanged"]) ||
    !Object.values(value.counts).every(isNonnegativeSafeInteger) || Object.values(value.counts).reduce<number>((sum, count) => sum + Number(count), 0) !== value.totalFiles ||
    !Array.isArray(value.directories) || value.directories.length > 20_000 || !value.directories.every(directory => isRecord(directory) &&
      hasExactKeys(directory, ["additions", "deletions", "path", "totalFiles"]) && isNonnegativeSafeInteger(directory.additions) &&
      isNonnegativeSafeInteger(directory.deletions) && isNonnegativeSafeInteger(directory.totalFiles) &&
      (directory.path === null || validGitPath(directory.path)))) return false;
  const directoryTotals = value.directories.reduce((sum, directory) => sum + directory.totalFiles, 0);
  return directoryTotals === value.totalFiles &&
    value.directories.reduce((sum, directory) => sum + directory.additions, 0) === value.additions &&
    value.directories.reduce((sum, directory) => sum + directory.deletions, 0) === value.deletions;
}

function validChangedFile(value: unknown, objectFormat: string): boolean {
  const oidLength = objectFormat === "sha256" ? 64 : 40;
  const similarity = isRecord(value) ? value.similarity : undefined;
  if (!isRecord(value) || !hasExactKeys(value, ["additions", "binary", "deletions", "gitlink", "newMode", "newOid", "newPath", "oldMode", "oldOid", "oldPath", "similarity", "status"]) ||
    !["added", "modified", "deleted", "renamed", "copied", "typeChanged"].includes(value.status as string) ||
    !(value.oldPath === null || validGitPath(value.oldPath)) || !(value.newPath === null || validGitPath(value.newPath)) ||
    !(value.oldOid === null || typeof value.oldOid === "string" && value.oldOid.length === oidLength && /^[0-9a-f]+$/i.test(value.oldOid)) ||
    !(value.newOid === null || typeof value.newOid === "string" && value.newOid.length === oidLength && /^[0-9a-f]+$/i.test(value.newOid)) ||
    typeof value.oldMode !== "string" || !/^[0-7]{6}$/.test(value.oldMode) || typeof value.newMode !== "string" || !/^[0-7]{6}$/.test(value.newMode) ||
    !(similarity === null || Number.isInteger(similarity) && (similarity as number) >= 0 && (similarity as number) <= 100) ||
    typeof value.binary !== "boolean" || typeof value.gitlink !== "boolean" ||
    !(value.additions === null || isNonnegativeSafeInteger(value.additions)) || !(value.deletions === null || isNonnegativeSafeInteger(value.deletions)) ||
    value.binary && (value.additions !== null || value.deletions !== null)) return false;
  if (value.status === "added") return value.oldPath === null && value.newPath !== null;
  if (value.status === "deleted") return value.oldPath !== null && value.newPath === null;
  if (value.status === "renamed" || value.status === "copied") return value.oldPath !== null && value.newPath !== null && value.similarity !== null;
  return value.oldPath !== null && value.newPath !== null;
}

function validMergeCommitsPage(page: MergeCommitsPage, params: ReadMergeCommitsParams, details: CommitDetails, objectFormat: string): boolean {
  const parents = details.commit.parents;
  return isRecord(page) && hasExactKeys(page, ["authors", "commits", "firstParentOid", "hasMore", "offset", "oid", "pageSize", "parentIndex", "parentOid", "totalCommits"]) &&
    page.oid === params.oid && page.parentIndex === params.parentIndex && page.parentOid === parents[params.parentIndex] && page.firstParentOid === parents[0] &&
    page.offset === params.offset && page.pageSize === params.pageSize && isNonnegativeSafeInteger(page.totalCommits) && page.totalCommits <= 10_000 &&
    Array.isArray(page.commits) && page.commits.length <= params.pageSize && page.offset <= page.totalCommits &&
    page.commits.length === Math.min(params.pageSize, page.totalCommits - page.offset) &&
    typeof page.hasMore === "boolean" && page.hasMore === (page.offset + page.commits.length < page.totalCommits) &&
    page.commits.every(commit => validCommitSummary(commit, objectFormat === "sha256" ? 64 : 40)) &&
    new Set(page.commits.map(commit => commit.oid)).size === page.commits.length && Array.isArray(page.authors) && page.authors.length <= 1_000 &&
    page.authors.every(author => isRecord(author) && hasExactKeys(author, ["count", "email", "name"]) && isNonnegativeSafeInteger(author.count) && author.count > 0 &&
      typeof author.name === "string" && Buffer.byteLength(author.name, "utf8") <= 4_096 && typeof author.email === "string" && Buffer.byteLength(author.email, "utf8") <= 4_096) &&
    page.authors.reduce((sum, author) => sum + author.count, 0) === page.totalCommits;
}

function validFileDiff(diff: FileDiff, params: ReadDiffParams, details: CommitDetails, objectFormat: string): boolean {
  const parentOid = params.parentIndex === null ? null : details.commit.parents[params.parentIndex] ?? null;
  if (!isRecord(diff) || !hasExactKeys(diff, ["file", "kind", "newSize", "oid", "oldSize", "parentIndex", "parentOid", "patch", "textLossy", "truncated"]) ||
    diff.oid !== params.oid || diff.parentIndex !== params.parentIndex || diff.parentOid !== parentOid || !validChangedFile(diff.file, objectFormat) ||
    (diff.file.oldPath?.rawHex ?? null) !== params.oldPathHex || (diff.file.newPath?.rawHex ?? null) !== params.newPathHex ||
    !["text", "binary", "gitlink", "lfs", "tooLarge"].includes(diff.kind as string) || typeof diff.patch !== "string" ||
    Buffer.byteLength(diff.patch, "utf8") > 128 * 1024 || typeof diff.textLossy !== "boolean" || typeof diff.truncated !== "boolean" ||
    !(diff.oldSize === null || isNonnegativeSafeInteger(diff.oldSize)) || !(diff.newSize === null || isNonnegativeSafeInteger(diff.newSize))) return false;
  return diff.kind === "text" || diff.patch === "";
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function maskHasLane(mask: number, lane: number): boolean {
  return lane < 6 && (mask & (1 << lane)) !== 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type WorkspaceChannel = "status" | "content";

interface ActiveWorkspaceRequest {
  abort: AbortController;
  done: Promise<unknown>;
}

function workspacePathHex(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32 * 1024 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/u.test(value) &&
    !Buffer.from(value, "hex").includes(0);
}

function validateWorkspaceStatusParams(value: unknown): ReadWorkspaceStatusParams {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Number.isInteger(value.maxEntries) || (value.maxEntries as number) < 1 || (value.maxEntries as number) > 2000) {
    throw new ProtocolClientError("INVALID_REQUEST", "工作区读取参数无效");
  }
  return { maxEntries: value.maxEntries as number };
}

function validateWorkspaceDiffParams(value: unknown): ReadWorkspaceDiffParams {
  if (!isRecord(value) || Object.keys(value).length !== 3 || (value.side !== "staged" && value.side !== "unstaged") || !workspacePathHex(value.pathHex) ||
    !(value.oldPathHex === null || workspacePathHex(value.oldPathHex))) {
    throw new ProtocolClientError("INVALID_REQUEST", "工作区 diff 参数无效");
  }
  return { side: value.side, pathHex: value.pathHex, oldPathHex: value.oldPathHex };
}

function validateWorkspaceFileParams(value: unknown): ReadWorkspaceFileParams {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !workspacePathHex(value.pathHex) || !Number.isInteger(value.maxLines) ||
    (value.maxLines as number) < 1 || (value.maxLines as number) > 5000) {
    throw new ProtocolClientError("INVALID_REQUEST", "工作区文件参数无效");
  }
  return { pathHex: value.pathHex, maxLines: value.maxLines as number };
}

function invalidSessionResponse(message: string): ProtocolClientError {
  return new ProtocolClientError("PROTOCOL_ERROR", message);
}
