import { isAbsolute } from "node:path";
import type {
  CommitSummary,
  RefInfo,
  RepositoryInfo,
  RepositorySessionInfo,
} from "../../../../packages/protocol/src/generated/server-message.js";
import type {
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

type SessionResponse = Extract<ServerResponseMessage["data"], { section: "repositorySession" }>;
type ViewRecordedResponse = Extract<ServerResponseMessage["data"], { section: "repositoryViewRecorded" }>;
type ClosedResponse = Extract<ServerResponseMessage["data"], { section: "repositoryClosed" }>;
type RecentResponse = Extract<ServerResponseMessage["data"], { section: "recentRepositories" }>;
type RepositoryResponse = Extract<ServerResponseMessage["data"], { section: "repository" }>;
type CommitsResponse = Extract<ServerResponseMessage["data"], { section: "commits" }>;

interface ActiveOpen {
  abort: AbortController;
  done: Promise<void>;
}

export class RepositorySessionController {
  private current?: RepositorySessionInfo;
  private operation = 0;
  private lifecycleEpoch = 0;
  private disposed = false;
  private activeOpen?: ActiveOpen;
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
    const previous = this.activeOpen;
    if (previous) {
      previous.abort.abort(new Error("仓库打开请求已被更新请求取代"));
      await previous.done.catch(() => undefined);
      if (operation !== this.operation) throw new ProtocolClientError("CANCELLED", "仓库打开请求已被更新请求取代", true);
      this.requireCapability("repositorySessions");
    }

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

  async recordView(): Promise<RepositoryViewRecorded> {
    const session = this.requireCurrent();
    const data = await this.singleSessionRequest("recordRepositoryView", {}, session);
    if (data.section !== "repositoryViewRecorded") throw invalidSessionResponse("核心未确认查看记录");
    this.ensureCurrent(session);
    return { saved: data.saved, status: data.status };
  }

  async close(): Promise<{ closed: true }> {
    const operation = ++this.operation;
    const opening = this.activeOpen;
    if (opening) {
      this.activeOpen = undefined;
      opening.abort.abort(new Error("仓库会话正在关闭"));
      await opening.done.catch(() => undefined);
    }
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
    this.activeOpen?.abort.abort(new Error("应用正在关闭"));
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
    this.activeOpen?.abort.abort(new Error("核心已退出"));
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
