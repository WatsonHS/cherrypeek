import { isAbsolute } from "node:path";
import type {
  CommitSummary,
  HistoryCommit,
  RefInfo,
  RepositoryInfo,
  RepositorySessionInfo,
  SearchPage,
  SearchIdentities,
} from "../../../../packages/protocol/src/generated/server-message.js";
import type { MetadataIndexAction, SearchCommitsParams, SearchIdentitiesParams, SearchQuery } from "../../../../packages/protocol/src/generated/client-message.js";
import type {
  HistoryPage,
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
type RepositoryResponse = Extract<ServerResponseMessage["data"], { section: "repository" }>;
type CommitsResponse = Extract<ServerResponseMessage["data"], { section: "commits" }>;
type HistoryPageResponse = Extract<ServerResponseMessage["data"], { section: "historyPage" }>;

interface ActiveOpen {
  abort: AbortController;
  done: Promise<void>;
}

interface ActiveHistoryRead {
  abort: AbortController;
  done: Promise<HistoryPage>;
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
  kind: "commits" | "identities";
  abort: AbortController;
  done: Promise<SearchPage | SearchIdentities>;
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
  private readonly unsubscribeCore: () => void;

  constructor(private readonly core: CoreProcess) {
    this.unsubscribeCore = core.subscribe(status => this.onCoreStatus(status));
  }

  async open(path: unknown): Promise<RepositorySessionInfo> {
    if (this.disposed) throw new ProtocolClientError("CORE_EXITED", "仓库会话控制器已关闭", true);
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) {
      throw new ProtocolClientError("INVALID_REQUEST", "请输入有效的绝对目录路径");
    }
    this.requireCapability("repositorySessions");
    this.requireCapability("repositoryScopes");

    const operation = ++this.operation;
    ++this.pageIntent;
    if (this.activeSearchRequest) await this.cancelSearch();
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
    if (cursor !== null && (typeof cursor !== "string" || cursor.length === 0)) {
      throw new ProtocolClientError("INVALID_REQUEST", "历史页游标无效");
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_HISTORY_PAGE) {
      throw new ProtocolClientError("INVALID_REQUEST", `每页数量必须为 1 至 ${MAX_HISTORY_PAGE} 的整数`);
    }
    await this.cancelAndDrainHistoryRead(new ProtocolClientError("CANCELLED", "历史页请求已被更新请求取代", true));
    if (intent !== this.pageIntent) throw new ProtocolClientError("CANCELLED", "历史页请求已被更新请求取代", true);
    this.ensureCurrent(session);
    const abort = new AbortController();
    const active: ActiveHistoryRead = { abort, done: Promise.resolve(undefined as never) };
    active.done = this.readHistoryPageRequest(session, cursor, pageSize, abort);
    this.activeHistoryRead = active;
    try {
      return await active.done;
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

  async refreshRepository(pageSize = 200): Promise<RefreshedRepository> {
    if (this.activeOpen) throw new ProtocolClientError("BUSY", "仓库正在切换，暂不能刷新", true);
    const operation = ++this.operation;
    ++this.pageIntent;
    if (this.activeSearchRequest) await this.cancelSearch();
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
    if (this.activeSearchRequest) await this.cancelSearch();
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

  async cancelSearch(): Promise<{ cancelled: boolean }> {
    ++this.searchIntent;
    const active = this.activeSearchRequest;
    if (!active) return { cancelled: false };
    active.abort.abort(new Error("搜索已取消"));
    await active.done.catch(() => undefined);
    if (this.activeSearchRequest === active) this.activeSearchRequest = undefined;
    return { cancelled: true };
  }

  private async runSearchRequest(
    kind: ActiveSearchRequest["kind"],
    session: RepositorySessionInfo,
    read: (signal: AbortSignal) => Promise<SearchPage | SearchIdentities>,
  ): Promise<SearchPage | SearchIdentities> {
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
        if (commits.length > params.pageSize || chunk.coverage.processed !== commits.length) throw invalidSessionResponse("搜索结果超过页大小或 envelope coverage 不连续");
      },
    });
    this.ensureCurrent(session);
    if (!page || !completion.coverage.complete || completion.coverage.processed !== commits.length ||
      completion.nextCursor !== page.nextCursor ||
      !validSearchPage(page, params, commits)) throw invalidSessionResponse("搜索响应不完整或不一致");
    return { ...page, commits };
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
    if (this.activeSearchRequest) await this.cancelSearch();
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
    ++this.mergeIntent;
    ++this.metadataIndexIntent;
    if (this.activeMetadataIndexRequest?.kind === "status") this.activeMetadataIndexRequest.abort?.abort(new Error("应用正在关闭"));
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
    this.core.observeLatestContext(contextOf(sessionData.session));
    this.core.switchCurrentContext(contextOf(sessionData.session));
  }

  private async readHistoryPageRequest(
    session: RepositorySessionInfo,
    cursor: string | null,
    pageSize: number,
    abort: AbortController,
  ): Promise<HistoryPage> {
    let repository: RepositoryInfo | undefined;
    let refs: RefInfo[] = [];
    let refsTruncated = false;
    let page: Omit<HistoryPage, "repository" | "refs" | "refsTruncated" | "nextCursor"> | undefined;
    const commits: HistoryCommit[] = [];
    let metadata = "";
    let sawRepository = false;
    let sawTerminalPage = false;
    const completion = await this.core.request("readHistoryPage", { cursor, pageSize }, contextOf(session), {
      timeoutMs: SESSION_TIMEOUT_MS,
      drainAfterAbort: true,
      fatalOnTimeout: true,
      signal: abort.signal,
      onChunk: chunk => {
        this.ensureCurrent(session);
        if (sawTerminalPage) throw invalidSessionResponse("历史页终止块之后仍收到数据");
        const data = chunk.data;
        if (data.section === "repository") {
          if (sawRepository || page || chunk.done) throw invalidSessionResponse("历史页仓库头位置无效");
          if (chunk.coverage.complete || chunk.coverage.processed !== 0 || chunk.nextCursor !== null) throw invalidSessionResponse("历史页仓库头 envelope 无效");
          sawRepository = true;
          repository = data.repository;
          refs = data.refs.slice(0, MAX_REFS);
          refsTruncated = data.refsTruncated || data.refs.length > MAX_REFS;
          return;
        }
        if (data.section !== "historyPage") throw invalidSessionResponse(`历史页收到意外区块：${data.section}`);
        if (!sawRepository) throw invalidSessionResponse("历史页缺少仓库头");
        const currentMetadata = JSON.stringify({
          cursor: data.cursor,
          offset: data.offset,
          pageSize: data.pageSize,
          previousCursor: data.previousCursor,
          hasMore: data.hasMore,
          newSinceLastSeenStatus: data.newSinceLastSeenStatus,
          lastSeenDividerOid: data.lastSeenDividerOid,
        });
        if (metadata && currentMetadata !== metadata) throw invalidSessionResponse("历史页分块元数据不一致");
        metadata = currentMetadata;
        if (data.pageSize !== pageSize || data.commits.length + commits.length > pageSize) {
          throw invalidSessionResponse("历史页提交数量超过请求上限");
        }
        if ((cursor === null && (data.offset !== 0 || data.previousCursor !== null)) ||
          (cursor !== null && data.cursor !== cursor)) throw invalidSessionResponse("历史页游标与位置不一致");
        if (chunk.done ? (!chunk.coverage.complete || data.hasMore !== (chunk.nextCursor !== null))
          : (chunk.coverage.complete || chunk.nextCursor !== null)) throw invalidSessionResponse("历史页 envelope 终态无效");
        commits.push(...data.commits);
        page = {
          commits,
          offset: data.offset,
          pageSize: data.pageSize,
          cursor: data.cursor,
          previousCursor: data.previousCursor,
          hasMore: data.hasMore,
          newSinceLastSeenStatus: data.newSinceLastSeenStatus,
          lastSeenDividerOid: data.lastSeenDividerOid,
        };
        if (chunk.done) sawTerminalPage = true;
      },
    });
    this.ensureCurrent(session);
    if (!repository || !sawRepository || !page || !sawTerminalPage || !completion.coverage.complete ||
      completion.coverage.processed !== commits.length || completion.nextCursor && !page.hasMore ||
      !completion.nextCursor && page.hasMore) {
      throw invalidSessionResponse("核心返回了不完整或不一致的历史页");
    }
    return { repository, refs, refsTruncated, ...page, commits, nextCursor: completion.nextCursor };
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
          ? "核心不支持元数据搜索，请更新核心版本" : "核心不支持只读范围导航，请更新核心版本");
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
    if (this.activeMetadataIndexRequest?.kind === "status") this.activeMetadataIndexRequest.abort?.abort(new Error("核心已退出"));
    ++this.metadataIndexIntent;
    this.activeOpen = undefined;
    this.current = undefined;
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

function isSearchQuery(value: unknown): value is SearchQuery {
  if (!isRecord(value) || !hasExactKeys(value, ["authors", "caseSensitive", "committers", "fromTimestamp", "message", "oidPrefix", "timeField", "timeZone", "toTimestamp"])) return false;
  const timestamp = (item: unknown) => item === null || Number.isSafeInteger(item);
  const identities = (item: unknown) => Array.isArray(item) && item.length <= 50 && item.every(identity =>
    isRecord(identity) && hasExactKeys(identity, ["email", "name"]) && typeof identity.name === "string" &&
    Buffer.byteLength(identity.name, "utf8") <= 4096 && typeof identity.email === "string" && Buffer.byteLength(identity.email, "utf8") <= 4096);
  return typeof value.message === "string" && Buffer.byteLength(value.message, "utf8") <= 4096 &&
    typeof value.caseSensitive === "boolean" && identities(value.authors) && identities(value.committers) &&
    typeof value.oidPrefix === "string" && (value.oidPrefix === "" || /^[0-9a-fA-F]{4,64}$/.test(value.oidPrefix)) &&
    (value.timeField === "author" || value.timeField === "committer") && timestamp(value.fromTimestamp) && timestamp(value.toTimestamp) &&
    (value.fromTimestamp === null || value.toTimestamp === null || (value.fromTimestamp as number) < (value.toTimestamp as number)) &&
    typeof value.timeZone === "string" && value.timeZone.length > 0 && Buffer.byteLength(value.timeZone, "utf8") <= 128;
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

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSessionResponse(message: string): ProtocolClientError {
  return new ProtocolClientError("PROTOCOL_ERROR", message);
}
