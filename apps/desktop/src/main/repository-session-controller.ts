import { isAbsolute } from "node:path";
import type {
  CommitSummary,
  RefInfo,
  RepositoryInfo,
  RepositorySessionInfo,
} from "../../../../packages/protocol/src/generated/server-message.js";
import type {
  HistoryPage,
  RefreshedRepository,
  RecentRepositoriesResult,
  RepositoryViewRecorded,
  SessionPreview,
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

export class RepositorySessionController {
  private current?: RepositorySessionInfo;
  private operation = 0;
  private pageIntent = 0;
  private lifecycleEpoch = 0;
  private disposed = false;
  private activeOpen?: ActiveOpen;
  private activeHistoryRead?: ActiveHistoryRead;
  private activeRefresh?: ActiveRefresh;
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

    const operation = ++this.operation;
    ++this.pageIntent;
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

  async close(): Promise<{ closed: true }> {
    const operation = ++this.operation;
    ++this.pageIntent;
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
    const commits: CommitSummary[] = [];
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
  ): Promise<RefreshedRepository> {
    let sessionData: SessionResponse | undefined;
    let repository: RepositoryInfo | undefined;
    let refs: RefInfo[] = [];
    let refsTruncated = false;
    let page: Omit<HistoryPage, "repository" | "refs" | "refsTruncated" | "nextCursor"> | undefined;
    const commits: CommitSummary[] = [];
    let metadata = "";
    let sawTerminalPage = false;
    const lifecycleEpoch = this.lifecycleEpoch;
    const completion = await this.core.request("refreshRepository", { pageSize }, contextOf(previous), {
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
          previousCursor: data.previousCursor, hasMore: data.hasMore });
        if (metadata && metadata !== currentMetadata) throw invalidSessionResponse("刷新历史页分块元数据不一致");
        metadata = currentMetadata;
        if (data.pageSize !== pageSize || commits.length + data.commits.length > pageSize) throw invalidSessionResponse("刷新历史页超过请求上限");
        if (data.offset !== 0 || data.previousCursor !== null) throw invalidSessionResponse("刷新首屏位置无效");
        if (chunk.done ? (!chunk.coverage.complete || data.hasMore !== (chunk.nextCursor !== null))
          : (chunk.coverage.complete || chunk.nextCursor !== null)) throw invalidSessionResponse("刷新历史页 envelope 终态无效");
        commits.push(...data.commits);
        page = { commits, offset: data.offset, pageSize: data.pageSize, cursor: data.cursor,
          previousCursor: data.previousCursor, hasMore: data.hasMore };
        if (chunk.done) sawTerminalPage = true;
      },
    });
    if (!sessionData || !repository || !page || !sawTerminalPage || !completion.coverage.complete ||
      completion.coverage.processed !== commits.length || completion.nextCursor && !page.hasMore ||
      !completion.nextCursor && page.hasMore) throw invalidSessionResponse("刷新响应不完整或不一致");
    const nextSession = sessionData.session;
    if (nextSession.repoId === previous.repoId || nextSession.generation === previous.generation ||
      nextSession.repositoryKey !== previous.repositoryKey || nextSession.worktreeId !== previous.worktreeId ||
      repository.path !== nextSession.repository.path) throw invalidSessionResponse("刷新返回了不匹配的新仓库会话");
    if (this.disposed || lifecycleEpoch !== this.lifecycleEpoch || this.core.getStatus().state !== "ready") {
      throw new ProtocolClientError("CORE_EXITED", "核心已关闭，忽略迟到的刷新会话", true);
    }
    this.current = nextSession;
    this.core.observeLatestContext(contextOf(nextSession));
    this.core.switchCurrentContext(contextOf(nextSession));
    const historyPage: HistoryPage = { repository, refs, refsTruncated, ...page, commits, nextCursor: completion.nextCursor };
    return { session: nextSession, page: historyPage };
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
    if (!this.current) throw new ProtocolClientError("STALE_CONTEXT", "当前没有打开的仓库会话");
    return this.current;
  }

  private requireHistoryCapability(): RepositorySessionInfo {
    this.requireCapability("historyPagination");
    return this.requireCurrent();
  }

  private ensureCurrent(session: RepositorySessionInfo): void {
    if (this.current !== session) throw new ProtocolClientError("STALE_CONTEXT", "仓库会话已被切换", true);
  }

  private requireCapability(capability: string): void {
    const status: CoreStatus = this.core.getStatus();
    if (status.state !== "ready") throw new ProtocolClientError("CORE_EXITED", "核心尚未就绪", true);
    if (!status.core.capabilities.includes(capability as typeof status.core.capabilities[number])) {
      throw new ProtocolClientError("UNKNOWN_METHOD", "核心不支持仓库会话");
    }
  }

  private onCoreStatus(status: CoreStatus): void {
    if (status.state === "ready") return;
    this.lifecycleEpoch += 1;
    this.operation += 1;
    this.pageIntent += 1;
    this.activeOpen?.abort.abort(new Error("核心已退出"));
    this.activeHistoryRead?.abort.abort(new Error("核心已退出"));
    this.activeRefresh?.abort.abort(new Error("核心已退出"));
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

function invalidSessionResponse(message: string): ProtocolClientError {
  return new ProtocolClientError("PROTOCOL_ERROR", message);
}
