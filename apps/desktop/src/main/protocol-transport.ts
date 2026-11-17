import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ErrorObject } from "ajv";
import validators from "./generated/protocol-validators.cjs";
import type { CoreReady } from "../../../../packages/protocol/src/core-ready.js";
import type { ClientMessage } from "../../../../packages/protocol/src/generated/client-message.js";
import type {
  ClientRequestMessage,
  ProtocolErrorCode,
  RequestContext,
  ServerErrorMessage,
  ServerResponseMessage,
} from "../../../../packages/protocol/src/messages.js";
import { JsonLineFramer } from "./json-line-framer.js";
import { ViewContextGate } from "./view-context-gate.js";

const PROTOCOL_VERSION = 1;
const DEFAULT_FRAME_BYTES = 1024 * 1024;
const DEFAULT_QUEUE_FRAMES = 16;
const DEFAULT_QUEUE_BYTES = 2 * 1024 * 1024;
const DEFAULT_PENDING = 2;
const DEFAULT_TIMEOUT_MS = 5000;
const CANCEL_DRAIN_TIMEOUT_MS = 5000;

const { validateClient, validateServer, validateCoreReady } = validators;

function errorsText(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "No errors";
  return errors.map(error => `data${error.instancePath} ${error.message}`).join(", ");
}

export class ProtocolClientError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProtocolClientError";
  }
}

export interface ProtocolTransportOptions {
  maxFrameBytes?: number;
  maxQueuedFrames?: number;
  maxQueuedBytes?: number;
  /** Interactive read slots; statistics, evolution and operations each have one separate slot. */
  maxPendingRequests?: number;
  contextGate?: ViewContextGate;
  onFatal?: (error: ProtocolClientError) => void;
}

export interface RequestOptions {
  /** null delegates the work budget to the daemon, only for cancellable analyzeEvolution. */
  timeoutMs?: number | null;
  signal?: AbortSignal;
  retainResultAfterAbort?: boolean;
  drainAfterAbort?: boolean;
  fatalOnTimeout?: boolean;
  onChunk?: (chunk: ServerResponseMessage) => void;
}

export type RequestCompletion = Pick<ServerResponseMessage, "coverage" | "nextCursor">;

type RequestLane = "interactive" | "statistics" | "evolution" | "operation";

interface PendingRequest {
  context: RequestContext;
  gateBound: boolean;
  retainResultAfterAbort: boolean;
  drainAfterAbort: boolean;
  lane: RequestLane;
  fatalOnTimeout: boolean;
  cancelRequested: boolean;
  cancelError?: ProtocolClientError;
  nextSequence: number;
  resolve: (completion: RequestCompletion) => void;
  reject: (error: ProtocolClientError) => void;
  onChunk?: (chunk: ServerResponseMessage) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
  unregisterContext?: () => void;
}

interface WriteItem {
  frame: Buffer;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class ProtocolTransport {
  private readonly framer: JsonLineFramer;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly writeQueue: WriteItem[] = [];
  private readonly maxFrameBytes: number;
  private readonly maxQueuedFrames: number;
  private readonly maxQueuedBytes: number;
  private readonly maxPendingRequests: number;
  private readonly contextGate: ViewContextGate;
  private readonly onFatal?: (error: ProtocolClientError) => void;
  private queuedBytes = 0;
  private pumpingWrites = false;
  private activeWrite?: WriteItem;
  private requestCounter = 0;
  private handshakeResolve?: (ready: CoreReady) => void;
  private handshakeReject?: (error: ProtocolClientError) => void;
  private handshakeSeen = false;
  private handshakeComplete = false;
  private closed = false;
  private terminalError?: ProtocolClientError;
  private cancelDrainWait?: (error: ProtocolClientError) => void;

  constructor(
    private readonly stdout: Readable,
    private readonly stdin: Writable,
    options: ProtocolTransportOptions = {},
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_FRAME_BYTES;
    this.maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_QUEUE_FRAMES;
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_QUEUE_BYTES;
    this.maxPendingRequests = options.maxPendingRequests ?? DEFAULT_PENDING;
    this.contextGate = options.contextGate ?? new ViewContextGate();
    this.onFatal = options.onFatal;
    this.framer = new JsonLineFramer(
      stdout,
      line => this.receiveLine(line),
      error => this.fail(new ProtocolClientError("PROTOCOL_ERROR", error.message)),
      this.maxFrameBytes,
      () => this.fail(new ProtocolClientError("CORE_EXITED", "核心 stdout 提前关闭", true)),
    );
    stdin.on("error", error => this.fail(new ProtocolClientError("CORE_EXITED", `核心 stdin 写入失败：${error.message}`, true)));
    stdin.on("close", () => this.fail(new ProtocolClientError("CORE_EXITED", "核心 stdin 已关闭", true)));
  }

  async handshake(expectedPid: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CoreReady> {
    if (this.closed) throw new ProtocolClientError("CORE_EXITED", "核心连接已关闭");
    if (this.handshakeResolve || this.handshakeComplete) throw new ProtocolClientError("PROTOCOL_ERROR", "握手只能执行一次");
    let timer: NodeJS.Timeout | undefined;
    const response = new Promise<CoreReady>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
      timer = setTimeout(() => this.fail(new ProtocolClientError("TIMEOUT", `核心握手超时（${timeoutMs} ms）`, true)), timeoutMs);
    });
    const responseHandled = response.then(
      ready => ({ ready }),
      error => ({ error: asProtocolError(error, "PROTOCOL_ERROR") }),
    );
    const hello = { type: "hello", protocolVersion: PROTOCOL_VERSION } as const;
    try {
      const [writeResult, responseResult] = await Promise.all([this.enqueue(hello), responseHandled]);
      void writeResult;
      if ("error" in responseResult) throw responseResult.error;
      if (this.closed) throw this.terminalError ?? new ProtocolClientError("CORE_EXITED", "核心连接已关闭");
      const ready = responseResult.ready;
      if (ready.pid !== expectedPid) {
        const error = new ProtocolClientError("PROTOCOL_ERROR", `核心 PID 不匹配：声明 ${ready.pid}，实际 ${expectedPid}`);
        this.fail(error);
        throw error;
      }
      this.handshakeComplete = true;
      return ready;
    } finally {
      if (timer) clearTimeout(timer);
      this.handshakeResolve = undefined;
      this.handshakeReject = undefined;
    }
  }

  request(
    method: ClientRequestMessage["method"],
    params: ClientRequestMessage["params"],
    context: RequestContext,
    options: RequestOptions = {},
  ): Promise<RequestCompletion> {
    if (!this.handshakeComplete || this.closed) {
      return Promise.reject(new ProtocolClientError("CORE_EXITED", "核心尚未就绪"));
    }
    if (!validRequestParams(method, params)) {
      return Promise.reject(new ProtocolClientError("INVALID_REQUEST", "请求方法或参数无效"));
    }
    const requestMode = requestModeFor(method);
    if (!requestMode) {
      return Promise.reject(new ProtocolClientError("INVALID_REQUEST", "请求方法不受支持"));
    }
    if (requestMode !== "session" && (context.repoId !== null || context.generation !== null)) {
      return Promise.reject(new ProtocolClientError("INVALID_REQUEST", "该请求不接受仓库上下文"));
    }
    if (requestMode === "session" && (!context.repoId || !context.generation)) {
      return Promise.reject(new ProtocolClientError("STALE_CONTEXT", "当前没有可用的仓库会话"));
    }
    const lane = requestLaneFor(method);
    const pendingInLane = [...this.pending.values()].filter(request => request.lane === lane).length;
    const laneLimit = lane === "interactive" ? this.maxPendingRequests : 1;
    if (pendingInLane >= laneLimit) {
      return Promise.reject(new ProtocolClientError("BUSY", lane === "operation" ? "已有一个操作正在进行" : "读取暂时繁忙，请稍后重试", true));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new ProtocolClientError("CANCELLED", abortMessage(options.signal), true));
    }
    if (options.retainResultAfterAbort && method !== "openRepository" && method !== "refreshRepository" && method !== "selectRepositoryScope") {
      return Promise.reject(new ProtocolClientError("INVALID_REQUEST", "仅打开、刷新和范围切换可保留迟到的成功终态"));
    }
    if (options.drainAfterAbort && method !== "readHistoryPage" && method !== "locateCommit" && method !== "locateHistoryDate" && method !== "refMergeStatus" && method !== "getMetadataIndexStatus" &&
      method !== "searchCommits" && method !== "listSearchIdentities" && method !== "listSearchPaths" &&
      method !== "getActivityStats" && method !== "observeRepository" && method !== "diffRefSnapshots" && method !== "getHandoffFacts" &&
      !["getCommit", "listChangedFiles", "readMergeCommits", "branchesContaining", "readDiff", ...WORKSPACE_METHODS, ...FILE_METHODS, ...OPERATION_METHODS, ...M5_M6_READ_METHODS].includes(method)) {
      return Promise.reject(new ProtocolClientError("INVALID_REQUEST", "该请求不支持取消并排空终态"));
    }
    if (options.fatalOnTimeout && !["openRepository", "closeRepository", "readHistoryPage", "locateCommit", "locateHistoryDate", "refreshRepository", "selectRepositoryScope"].includes(method)) {
      return Promise.reject(new ProtocolClientError("INVALID_REQUEST", "仅会话变更请求可因超时关闭连接"));
    }

    const requestId = this.nextRequestId();
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    if (timeoutMs === null && (method !== "analyzeEvolution" || !options.drainAfterAbort)) {
      return Promise.reject(new ProtocolClientError("INVALID_REQUEST", "仅可取消并排空的演化分析由核心管理超时"));
    }
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      return Promise.reject(new ProtocolClientError("INVALID_REQUEST", "请求超时必须为正数"));
    }

    return new Promise<RequestCompletion>((resolve, reject) => {
      const pending: PendingRequest = {
        context: { ...context },
        gateBound: requestMode === "session",
        retainResultAfterAbort: options.retainResultAfterAbort === true,
        drainAfterAbort: options.drainAfterAbort === true,
        lane,
        fatalOnTimeout: options.fatalOnTimeout === true,
        cancelRequested: false,
        nextSequence: 0,
        resolve,
        reject,
        onChunk: options.onChunk,
        timer: timeoutMs === null ? undefined : setTimeout(() => {
          const message = `请求超时（${timeoutMs} ms）`;
          if (pending.fatalOnTimeout) this.fail(new ProtocolClientError("TIMEOUT", message, true));
          else this.cancel(requestId, "TIMEOUT", message);
        }, timeoutMs),
        signal: options.signal,
      };
      this.pending.set(requestId, pending);
      if (options.signal) {
        pending.abortHandler = () => {
          if (pending.retainResultAfterAbort) this.cancelAndDrain(requestId);
          else if (pending.drainAfterAbort) this.drainCancel(requestId, new ProtocolClientError("CANCELLED", abortMessage(options.signal!), true));
          else this.cancel(requestId, "CANCELLED", abortMessage(options.signal!));
        };
        options.signal.addEventListener("abort", pending.abortHandler, { once: true });
      }
      if (pending.gateBound) {
        pending.unregisterContext = this.contextGate.register(requestId, context, id => {
          this.cancel(id, "STALE_CONTEXT", "请求所属的仓库会话已切换");
        });
      }
      if (!this.pending.has(requestId)) return;

      const message: ClientRequestMessage = {
        type: "request",
        requestId,
        method,
        repoId: context.repoId,
        generation: context.generation,
        params,
      };
      void this.enqueue(message).catch(error => {
        this.finishReject(requestId, asProtocolError(error, "BUSY"));
      });
    });
  }

  close(error = new ProtocolClientError("CORE_EXITED", "核心已退出", true)): void {
    if (this.closed) return;
    this.fail(error);
  }

  private receiveLine(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (error) {
      this.fail(new ProtocolClientError("PROTOCOL_ERROR", `JSON 解析失败：${errorMessage(error)}`));
      return;
    }

    if (isRecord(value) && value.type === "hello" && isRecord(value.core) &&
      Number.isInteger(value.core.protocolVersion) && value.core.protocolVersion !== PROTOCOL_VERSION) {
      this.fail(new ProtocolClientError("PROTOCOL_MISMATCH", `协议版本不兼容：核心 ${value.core.protocolVersion}，客户端 ${PROTOCOL_VERSION}`));
      return;
    }
    if (!validateServer(value)) {
      this.fail(new ProtocolClientError("PROTOCOL_ERROR", `服务端消息结构无效：${errorsText(validateServer.errors)}`));
      return;
    }
    const message = value;
    if (!this.handshakeComplete) {
      if (message.type === "error" && message.requestId === null) {
        this.fail(fromServerError(message));
        return;
      }
      if (message.type !== "hello" || !this.handshakeResolve) {
        this.fail(new ProtocolClientError("PROTOCOL_ERROR", "握手期间收到意外消息"));
        return;
      }
      if (this.handshakeSeen) {
        this.fail(new ProtocolClientError("PROTOCOL_ERROR", "核心重复发送 hello"));
        return;
      }
      if (!validateCoreReady(message.core)) {
        this.fail(new ProtocolClientError("PROTOCOL_ERROR", `CoreReady 结构无效：${errorsText(validateCoreReady.errors)}`));
        return;
      }
      if (message.core.protocolVersion !== PROTOCOL_VERSION) {
        this.fail(new ProtocolClientError("PROTOCOL_MISMATCH", `协议版本不兼容：核心 ${message.core.protocolVersion}，客户端 ${PROTOCOL_VERSION}`));
        return;
      }
      this.handshakeSeen = true;
      this.handshakeResolve(message.core);
      return;
    }

    if (message.type === "hello") {
      this.fail(new ProtocolClientError("PROTOCOL_ERROR", "核心重复发送 hello"));
      return;
    }
    if (message.type === "error") {
      this.receiveError(message);
      return;
    }
    this.receiveResponse(message);
  }

  private receiveResponse(message: ServerResponseMessage): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (!sameContext(pending.context, normalizeContext(message))) {
      this.fail(new ProtocolClientError("PROTOCOL_ERROR", `响应上下文与请求 ${message.requestId} 不匹配`));
      return;
    }
    if (message.sequence !== pending.nextSequence) {
      this.fail(new ProtocolClientError("PROTOCOL_ERROR", `请求 ${message.requestId} 分块序号错误：预期 ${pending.nextSequence}，收到 ${message.sequence}`));
      return;
    }
    if (pending.gateBound && !this.contextGate.accepts(message.requestId, pending.context) &&
      !(pending.drainAfterAbort && pending.cancelRequested)) {
      this.cancel(message.requestId, "STALE_CONTEXT", "请求所属的浏览上下文已切换");
      return;
    }
    pending.nextSequence += 1;
    if (!(pending.drainAfterAbort && pending.cancelRequested)) {
      try { pending.onChunk?.(message); }
      catch (error) {
        const protocolError = new ProtocolClientError("PROTOCOL_ERROR", `分块回调失败：${errorMessage(error)}`);
        if (pending.retainResultAfterAbort) {
          this.fail(protocolError);
        } else if (message.done) {
          this.finishReject(message.requestId, protocolError);
        } else {
          this.cancel(message.requestId, "PROTOCOL_ERROR", protocolError.message);
        }
        return;
      }
    }
    if (message.done) {
      if (pending.drainAfterAbort && pending.cancelRequested) {
        this.finishReject(message.requestId, pending.cancelError ?? new ProtocolClientError("CANCELLED", "请求已取消", true));
      } else {
        this.finishResolve(message.requestId, { coverage: message.coverage, nextCursor: message.nextCursor ?? null });
      }
    }
  }

  private receiveError(message: ServerErrorMessage): void {
    if (message.requestId === null) {
      this.fail(fromServerError(message));
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (!sameContext(pending.context, normalizeContext(message))) {
      this.fail(new ProtocolClientError("PROTOCOL_ERROR", `错误上下文与请求 ${message.requestId} 不匹配`));
      return;
    }
    const error = pending.drainAfterAbort && pending.cancelRequested
      ? pending.cancelError ?? fromServerError(message)
      : fromServerError(message);
    this.finishReject(message.requestId, error);
  }

  private cancel(requestId: string, code: ProtocolErrorCode, message: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (pending.retainResultAfterAbort) {
      this.cancelAndDrain(requestId);
      return;
    }
    if (pending.drainAfterAbort) {
      this.drainCancel(requestId, new ProtocolClientError(code, message, code === "TIMEOUT" || code === "CANCELLED"));
      return;
    }
    this.finishReject(requestId, new ProtocolClientError(code, message, code === "TIMEOUT" || code === "CANCELLED"));
    if (pending.cancelRequested) return;
    pending.cancelRequested = true;
    const cancelMessage = { type: "cancel", requestId } as const;
    void this.enqueue(cancelMessage).catch(error => this.fail(asProtocolError(error, "CORE_EXITED")));
  }

  private cancelAndDrain(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.cancelRequested) return;
    pending.cancelRequested = true;
    const cancelMessage = { type: "cancel", requestId } as const;
    void this.enqueue(cancelMessage).catch(error => this.fail(asProtocolError(error, "CORE_EXITED")));
  }

  private drainCancel(requestId: string, error: ProtocolClientError): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.cancelRequested) return;
    pending.cancelRequested = true;
    pending.cancelError = error;
    if (!pending.timer) {
      // An analysis has no wall-clock request timer, but cancelling it must not
      // leave the caller or a session transition waiting forever for a dead core.
      pending.timer = setTimeout(() => {
        this.fail(new ProtocolClientError("TIMEOUT", "取消演化分析后核心未返回终态", true));
      }, CANCEL_DRAIN_TIMEOUT_MS);
    }
    const cancelMessage = { type: "cancel", requestId } as const;
    void this.enqueue(cancelMessage).catch(writeError => this.fail(asProtocolError(writeError, "CORE_EXITED")));
  }

  private finishResolve(requestId: string, completion: RequestCompletion): void {
    const pending = this.takePending(requestId);
    pending?.resolve(completion);
  }

  private finishReject(requestId: string, error: ProtocolClientError): void {
    const pending = this.takePending(requestId);
    pending?.reject(error);
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.abortHandler && pending.signal) pending.signal.removeEventListener("abort", pending.abortHandler);
    pending.unregisterContext?.();
    return pending;
  }

  private enqueue(message: ClientMessage): Promise<void> {
    if (this.closed) return Promise.reject(new ProtocolClientError("CORE_EXITED", "核心连接已关闭", true));
    if (!validateClient(message)) {
      return Promise.reject(new ProtocolClientError("PROTOCOL_ERROR", `客户端消息结构无效：${errorsText(validateClient.errors)}`));
    }
    const frame = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (frame.length - 1 > this.maxFrameBytes) {
      return Promise.reject(new ProtocolClientError("PROTOCOL_ERROR", "客户端消息超过 1 MiB 帧限制"));
    }
    if (this.writeQueue.length + (this.pumpingWrites ? 1 : 0) >= this.maxQueuedFrames || this.queuedBytes + frame.length > this.maxQueuedBytes) {
      return Promise.reject(new ProtocolClientError("BUSY", "核心写入队列已满", true));
    }
    return new Promise<void>((resolve, reject) => {
      this.writeQueue.push({ frame, resolve, reject });
      this.queuedBytes += frame.length;
      void this.pumpWrites();
    });
  }

  private async pumpWrites(): Promise<void> {
    if (this.pumpingWrites || this.closed) return;
    this.pumpingWrites = true;
    try {
      while (!this.closed && this.writeQueue.length > 0) {
        const item = this.writeQueue.shift()!;
        this.activeWrite = item;
        try {
          let canContinue = true;
          const writeCallback = new Promise<void>((resolve, reject) => {
            canContinue = this.stdin.write(item.frame, error => error ? reject(error) : resolve());
          });
          const drain = canContinue ? Promise.resolve() : this.waitForDrain();
          await Promise.all([writeCallback, drain]);
          item.resolve();
        } catch (error) {
          item.reject(error instanceof Error ? error : new Error(String(error)));
          this.fail(new ProtocolClientError("CORE_EXITED", `核心 stdin 写入失败：${errorMessage(error)}`, true));
        } finally {
          this.queuedBytes -= item.frame.length;
          this.activeWrite = undefined;
        }
      }
    } finally {
      this.pumpingWrites = false;
      if (!this.closed && this.writeQueue.length > 0) void this.pumpWrites();
    }
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `cs-${process.pid}-${this.requestCounter}-${randomUUID()}`;
  }

  private waitForDrain(): Promise<void> {
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => {
        this.stdin.off("drain", onDrain);
        this.stdin.off("error", onError);
        this.stdin.off("close", onClose);
        if (this.cancelDrainWait === onFatal) this.cancelDrainWait = undefined;
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error("Core stdin closed before drain")); };
      const onFatal = (error: ProtocolClientError) => fail(error);
      this.stdin.once("drain", onDrain);
      this.stdin.once("error", onError);
      this.stdin.once("close", onClose);
      this.cancelDrainWait = onFatal;
      if (this.closed) onFatal(this.terminalError ?? new ProtocolClientError("CORE_EXITED", "核心连接已关闭"));
    });
  }

  private fail(error: ProtocolClientError): void {
    if (this.closed) return;
    this.closed = true;
    this.terminalError = error;
    this.framer.close();
    this.cancelDrainWait?.(error);
    this.handshakeReject?.(error);
    for (const requestId of this.pending.keys()) this.finishReject(requestId, error);
    this.activeWrite?.reject(error);
    for (const item of this.writeQueue.splice(0)) {
      this.queuedBytes -= item.frame.length;
      item.reject(error);
    }
    this.onFatal?.(error);
  }
}

function fromServerError(message: ServerErrorMessage): ProtocolClientError {
  return new ProtocolClientError(message.code, message.message, message.retryable);
}

function normalizeContext(message: Pick<ServerResponseMessage, "repoId" | "generation"> | ServerErrorMessage): RequestContext {
  return { repoId: message.repoId ?? null, generation: message.generation ?? null };
}

function sameContext(left: RequestContext, right: RequestContext): boolean {
  return left.repoId === right.repoId && left.generation === right.generation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "请求已取消";
}

function validRequestParams(method: string, params: unknown): boolean {
  if (["getRuntimeInfo", "getRepositoryNavigation", "getMetadataIndexStatus"].includes(method)) {
    return isRecord(params) && Object.keys(params).length === 0;
  }
  if (method === "readRepositoryPreview" && isRecord(params) && typeof params.path === "string") {
    return params.path.length > 0 && Buffer.byteLength(params.path, "utf8") <= 16 * 1024 &&
      !params.path.includes("\0") && isAbsolute(params.path);
  }
  if (method === "openRepository" && isRecord(params) && typeof params.path === "string") {
    return params.path.length > 0 && Buffer.byteLength(params.path, "utf8") <= 16 * 1024 &&
      !params.path.includes("\0") && isAbsolute(params.path);
  }
  if (method === "readHistoryPage" && isRecord(params) &&
    (params.cursor === null || typeof params.cursor === "string") &&
    Number.isInteger(params.pageSize) && (params.pageSize as number) >= 1 && (params.pageSize as number) <= 500) return true;
  if (method === "locateCommit" && isRecord(params) && hasExactKeys(params, ["oid", "pageSize"]) &&
    typeof params.oid === "string" && /^[0-9a-fA-F]{4,64}$/.test(params.oid) &&
    Number.isInteger(params.pageSize) && (params.pageSize as number) >= 1 && (params.pageSize as number) <= 500) return true;
  if (method === "locateHistoryDate" && isRecord(params) &&
    hasExactKeys(params, params.knownCursors === undefined ? ["beforeTimestamp", "pageSize"] : ["beforeTimestamp", "pageSize", "knownCursors"]) &&
    (params.knownCursors === undefined || Array.isArray(params.knownCursors) && params.knownCursors.length <= 9 &&
      params.knownCursors.every(cursor => typeof cursor === "string" && cursor.length > 0 && Buffer.byteLength(cursor, "utf8") <= 512)) &&
    Number.isSafeInteger(params.beforeTimestamp) &&
    Number.isInteger(params.pageSize) && (params.pageSize as number) >= 1 && (params.pageSize as number) <= 500) return true;
  if (method === "refreshRepository" && isRecord(params) &&
    Number.isInteger(params.pageSize) && (params.pageSize as number) >= 1 && (params.pageSize as number) <= 500) return true;
  if (method === "selectRepositoryScope" && isRecord(params) &&
    Number.isInteger(params.pageSize) && (params.pageSize as number) >= 1 && (params.pageSize as number) <= 500 &&
    (params.scope === "head" || params.scope === "allBranches" || isRecord(params.scope))) {
    if (params.scope === "head" || params.scope === "allBranches") return true;
    if (!isRecord(params.scope)) return false;
    const scope = params.scope;
    const keys = Object.keys(scope);
    if (keys.length !== 1) return false;
    if (typeof scope.ref === "string") return scope.ref.length > 0 && Buffer.byteLength(scope.ref, "utf8") <= 16 * 1024;
    if (typeof scope.worktree === "string") return scope.worktree.length > 0 && Buffer.byteLength(scope.worktree, "utf8") <= 256;
    return false;
  }
  if (method === "refMergeStatus" && isRecord(params) && Array.isArray(params.refNames) &&
    params.refNames.length >= 1 && params.refNames.length <= 50 &&
    params.refNames.every(name => typeof name === "string" && name.length > 0 && Buffer.byteLength(name, "utf8") <= 16 * 1024)) return true;
  if (method === "controlMetadataIndex" && isRecord(params) && Object.keys(params).length === 1 &&
    ["pause", "resume", "cancel", "rebuild"].includes(params.action as string)) return true;
  if (method === "searchCommits" && isRecord(params) && hasExactKeys(params, ["anchorOid", "cursor", "pageSize", "query"]) &&
    (params.cursor === null || typeof params.cursor === "string" && Buffer.byteLength(params.cursor, "utf8") <= 1024) &&
    !(params.cursor !== null && params.anchorOid !== null) &&
    (params.anchorOid === null || typeof params.anchorOid === "string" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(params.anchorOid)) &&
    Number.isInteger(params.pageSize) && (params.pageSize as number) >= 1 && (params.pageSize as number) <= 500 &&
    isSearchQuery(params.query)) return true;
  if (method === "listSearchIdentities" && isRecord(params) && hasExactKeys(params, ["field", "limit", "text"]) &&
    (params.field === "author" || params.field === "committer") && typeof params.text === "string" &&
    Buffer.byteLength(params.text, "utf8") <= 1024 && Number.isInteger(params.limit) &&
    (params.limit as number) >= 1 && (params.limit as number) <= 100) return true;
  if (method === "listSearchPaths" && isRecord(params) && hasExactKeys(params, ["limit", "text"]) &&
    typeof params.text === "string" && Buffer.byteLength(params.text, "utf8") <= 32 * 1024 && Number.isInteger(params.limit) &&
    (params.limit as number) >= 1 && (params.limit as number) <= 100) return true;
  if (method === "getActivityStats" && isRecord(params) && hasExactKeys(params, ["query"]) && isSearchQuery(params.query)) return true;
  if ((method === "observeRepository" || method === "diffRefSnapshots") && isRecord(params) && hasExactKeys(params, [])) return true;
  if (method === "getHandoffFacts" && isRecord(params) && hasExactKeys(params, ["branchRef", "operationWorktreeId", "selectedOid", "staleWorktreeId"]) &&
    (params.branchRef === null || typeof params.branchRef === "string" && Buffer.byteLength(params.branchRef, "utf8") <= 16 * 1024 && !params.branchRef.includes("\0")) &&
    (params.operationWorktreeId === null || typeof params.operationWorktreeId === "string" && params.operationWorktreeId.length > 0 && Buffer.byteLength(params.operationWorktreeId, "utf8") <= 256) &&
    (params.staleWorktreeId === null || typeof params.staleWorktreeId === "string" && params.staleWorktreeId.length > 0 && Buffer.byteLength(params.staleWorktreeId, "utf8") <= 256) &&
    (params.selectedOid === null || typeof params.selectedOid === "string" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(params.selectedOid))) return true;
  if (["getCommit", "branchesContaining"].includes(method) && isRecord(params) && hasExactKeys(params, ["oid"]) &&
    typeof params.oid === "string" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(params.oid)) return true;
  if (["listChangedFiles", "readMergeCommits"].includes(method) && isRecord(params) &&
    hasExactKeys(params, ["offset", "oid", "pageSize", "parentIndex"]) &&
    typeof params.oid === "string" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(params.oid) &&
    Number.isInteger(params.offset) && (params.offset as number) >= 0 && (params.offset as number) <= 0xffff_ffff &&
    Number.isInteger(params.pageSize) && (params.pageSize as number) >= 1 && (params.pageSize as number) <= 200 &&
    (method === "listChangedFiles"
      ? params.parentIndex === null || Number.isInteger(params.parentIndex) && (params.parentIndex as number) >= 0 && (params.parentIndex as number) <= 127
      : Number.isInteger(params.parentIndex) && (params.parentIndex as number) >= 1 && (params.parentIndex as number) <= 127)) return true;
  if (method === "readDiff" && isRecord(params) && hasKeysWithOptional(params, ["newPathHex", "oid", "oldPathHex", "parentIndex"], ["fullFile"]) &&
    (params.fullFile === undefined || typeof params.fullFile === "boolean") &&
    typeof params.oid === "string" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(params.oid) &&
    (params.parentIndex === null || Number.isInteger(params.parentIndex) && (params.parentIndex as number) >= 0 && (params.parentIndex as number) <= 127) &&
    (params.oldPathHex === null || typeof params.oldPathHex === "string" && params.oldPathHex.length > 0 && params.oldPathHex.length <= 32 * 1024 && params.oldPathHex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(params.oldPathHex)) &&
    (params.newPathHex === null || typeof params.newPathHex === "string" && params.newPathHex.length > 0 && params.newPathHex.length <= 32 * 1024 && params.newPathHex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(params.newPathHex)) &&
    (params.oldPathHex !== null || params.newPathHex !== null)) return true;
  if (method === "readWorkspaceStatus" && isRecord(params) && hasExactKeys(params, ["maxEntries"]) &&
    Number.isInteger(params.maxEntries) && (params.maxEntries as number) >= 1 && (params.maxEntries as number) <= 2000) return true;
  if (method === "readWorkspaceDiff" && isRecord(params) && hasKeysWithOptional(params, ["oldPathHex", "pathHex", "side"], ["fullFile"]) &&
    (params.fullFile === undefined || typeof params.fullFile === "boolean") &&
    (params.side === "staged" || params.side === "unstaged") && validPathHex(params.pathHex) &&
    (params.oldPathHex === null || validPathHex(params.oldPathHex))) return true;
  if (method === "readWorkspaceFile" && isRecord(params) && hasExactKeys(params, ["maxLines", "pathHex"]) && validPathHex(params.pathHex) &&
    Number.isInteger(params.maxLines) && (params.maxLines as number) >= 1 && (params.maxLines as number) <= 5000) return true;
  if (method === "listTree" && isRecord(params) && hasExactKeys(params, ["commit", "limit", "offset", "pathHex"]) && validOid(params.commit) &&
    (params.pathHex === null || validPathHex(params.pathHex)) && Number.isInteger(params.offset) && (params.offset as number) >= 0 &&
    (params.offset as number) <= 0xffff_ffff && Number.isInteger(params.limit) && (params.limit as number) >= 1 && (params.limit as number) <= 500) return true;
  if (method === "readFileContent" && isRecord(params) && hasExactKeys(params, ["commit", "maxLines", "pathHex"]) && validOid(params.commit) &&
    validPathHex(params.pathHex) && Number.isInteger(params.maxLines) && (params.maxLines as number) >= 1 && (params.maxLines as number) <= 5000) return true;
  if (method === "readFileHistory" && isRecord(params) && hasExactKeys(params, ["commit", "cursor", "kind", "message", "pageSize", "pathHex"]) &&
    validOid(params.commit) && (params.kind === "file" || params.kind === "directory") &&
    (params.pathHex === "" ? params.kind === "directory" : validPathHex(params.pathHex)) &&
    typeof params.message === "string" && Buffer.byteLength(params.message, "utf8") <= 4096 &&
    (params.cursor === null || typeof params.cursor === "string" && params.cursor.length > 0 && Buffer.byteLength(params.cursor, "utf8") <= 512) &&
    Number.isInteger(params.pageSize) && (params.pageSize as number) >= 1 && (params.pageSize as number) <= 200) return true;
  if (method === "listPathChanges" && isRecord(params) && hasExactKeys(params, ["offset", "oid", "pageSize", "parentIndex", "pathHex"]) &&
    typeof params.oid === "string" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(params.oid) &&
    (params.parentIndex === null || Number.isInteger(params.parentIndex) && (params.parentIndex as number) >= 0 && (params.parentIndex as number) <= 127) &&
    typeof params.pathHex === "string" && params.pathHex.length <= 32 * 1024 && params.pathHex.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(params.pathHex) &&
    Number.isInteger(params.offset) && (params.offset as number) >= 0 && (params.offset as number) <= 0xffff_ffff &&
    Number.isInteger(params.pageSize) && (params.pageSize as number) >= 1 && (params.pageSize as number) <= 200) return true;
  if (method === "readFileChange" && isRecord(params) && hasKeysWithOptional(params, ["oid", "oldPathHex", "parentIndex", "pathHex"], ["fullFile"]) &&
    validOid(params.oid) && validPathHex(params.pathHex) && (params.oldPathHex === null || validPathHex(params.oldPathHex)) &&
    (params.parentIndex === null || Number.isInteger(params.parentIndex) && (params.parentIndex as number) >= 0 && (params.parentIndex as number) <= 127) &&
    (params.fullFile === undefined || typeof params.fullFile === "boolean")) return true;
  if (method === "readBlame" && isRecord(params) && hasExactKeys(params, ["commit", "pathHex"]) && validOid(params.commit) && validPathHex(params.pathHex)) return true;
  if (method === "fetchRepository" && isRecord(params) && hasExactKeys(params, ["prune", "remote"]) && typeof params.prune === "boolean" &&
    (params.remote === null || typeof params.remote === "string" && params.remote.length > 0 && !params.remote.startsWith("-") &&
      Buffer.byteLength(params.remote, "utf8") <= 256)) return true;
  if (method === "pushRepository") return validPushRepositoryParams(params);
  if (method === "getBranchSync") return validBranchSyncParams(params);
  if (method === "checkOperation" || method === "runOperation") return validOperationParams(params);
  if (method === "getActivityOverview" || method === "getNotableStats") return validStatsQueryParams(params);
  if (method === "getChangeStats") return validChangeStatsParams(params);
  if (method === "getStatsCommits") return validStatsCommitsParams(params);
  if (method === "getStatsExclusions") return isRecord(params) && hasExactKeys(params, []);
  if (method === "setStatsExclusions") return validStatsExclusionsParams(params);
  if (method === "estimateEvolution" || method === "analyzeEvolution") return validEvolutionParams(params);
  if (["getRepositorySession", "readSessionPreview", "recordRepositoryView", "closeRepository", "listRecentRepositories"].includes(method)) {
    return isRecord(params) && Object.keys(params).length === 0;
  }
  return false;
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes && !value.includes("\0");
}

/** A full ref name as the core reports it: bounded, no NUL, never an option-looking string. */
function validRefName(value: unknown): value is string {
  return boundedText(value, 16 * 1024) && !value.startsWith("-");
}

function validLocalBranchRef(value: unknown): value is string {
  return validRefName(value) && value.startsWith("refs/heads/") && value.length > "refs/heads/".length;
}

function validBranchRef(value: unknown): value is string {
  return validRefName(value) && ((value.startsWith("refs/heads/") && value.length > "refs/heads/".length)
    || (value.startsWith("refs/remotes/") && value.length > "refs/remotes/".length));
}

export function validPushRepositoryParams(params: unknown): boolean {
  return isRecord(params) && hasExactKeys(params, ["expectedOid", "refName", "remote", "setUpstream"]) &&
    validOid(params.expectedOid) && validLocalBranchRef(params.refName) &&
    (params.remote === null || (boundedText(params.remote, 256) && !params.remote.startsWith("-"))) &&
    typeof params.setUpstream === "boolean";
}

export function validBranchSyncParams(params: unknown): boolean {
  return isRecord(params) && hasExactKeys(params, ["refNames"]) && Array.isArray(params.refNames) &&
    params.refNames.length >= 1 && params.refNames.length <= 50 && params.refNames.every(validRefName);
}

export function validOperationParams(params: unknown): boolean {
  if (!isRecord(params) || !hasExactKeys(params, ["operation"]) || !isRecord(params.operation)) return false;
  return validRepositoryOperation(params.operation);
}

export function validRepositoryOperation(operation: Record<string, unknown>): boolean {
  if (operation.kind === "fastForward") {
    return hasKeysWithOptional(operation, ["expectedOid", "kind", "refName", "upstreamOid"], ["replaceUntracked", "discardUntracked"]) &&
      validRefName(operation.refName) && validOid(operation.expectedOid) && validOid(operation.upstreamOid) &&
      (operation.replaceUntracked === undefined || boundedText(operation.replaceUntracked, 256)) &&
      (operation.discardUntracked === undefined || boundedText(operation.discardUntracked, 256)) &&
      !(operation.replaceUntracked !== undefined && operation.discardUntracked !== undefined);
  }
  if (operation.kind === "switch") {
    if (!hasExactKeys(operation, ["expectedHeadOid", "expectedOid", "kind", "target"]) || !validOid(operation.expectedHeadOid) ||
      !validOid(operation.expectedOid) || !isRecord(operation.target)) return false;
    const target = operation.target;
    return hasExactKeys(target, ["refName"]) ? validRefName(target.refName)
      : hasExactKeys(target, ["remoteRefName"]) && validRefName(target.remoteRefName);
  }
  if (operation.kind === "createBranch") {
    return hasExactKeys(operation, ["expectedHeadOid", "kind", "name", "startOid", "switchAfter"]) && validOid(operation.expectedHeadOid) &&
      validOid(operation.startOid) && typeof operation.switchAfter === "boolean" && boundedText(operation.name, 1024) && !operation.name.startsWith("-");
  }
  if (operation.kind === "deleteBranch") {
    return hasExactKeys(operation, ["baseRefName", "expectedOid", "kind", "refName"]) &&
      validLocalBranchRef(operation.refName) && validBranchRef(operation.baseRefName) && validOid(operation.expectedOid);
  }
  if (operation.kind === "fastForwardMerge") {
    return hasExactKeys(operation, ["expectedSourceOid", "expectedTargetOid", "kind", "sourceRef", "switchToTarget", "targetRef"]) &&
      validLocalBranchRef(operation.targetRef) && validBranchRef(operation.sourceRef) &&
      validOid(operation.expectedTargetOid) && validOid(operation.expectedSourceOid) && typeof operation.switchToTarget === "boolean";
  }
  if (operation.kind === "workspaceStage" || operation.kind === "workspaceUnstage") {
    return hasExactKeys(operation, ["all", "kind", "pathsHex"]) && typeof operation.all === "boolean" &&
      Array.isArray(operation.pathsHex) && operation.pathsHex.length <= 2000 && operation.pathsHex.every(validPathHex) &&
      (operation.all ? operation.pathsHex.length === 0 : operation.pathsHex.length > 0);
  }
  if (operation.kind === "workspaceDiscard") {
    return hasKeysWithOptional(operation, ["kind", "pathHex", "untracked"], ["expectedHeadOid"]) &&
      validPathHex(operation.pathHex) && typeof operation.untracked === "boolean" &&
      (operation.expectedHeadOid === undefined || operation.expectedHeadOid === null || validOid(operation.expectedHeadOid));
  }
  if (operation.kind === "workspaceCommit") {
    return hasKeysWithOptional(operation, ["kind", "message"], ["expectedHeadOid"]) &&
      typeof operation.message === "string" && operation.message.trim().length > 0 &&
      Buffer.byteLength(operation.message, "utf8") <= 65536 && !operation.message.includes("\0") &&
      (operation.expectedHeadOid === undefined || operation.expectedHeadOid === null || validOid(operation.expectedHeadOid));
  }
  return false;
}

function validStatsRange(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["endUnix", "startUnix"]) && Number.isSafeInteger(value.startUnix) &&
    Number.isSafeInteger(value.endUnix) && (value.startUnix as number) >= 0 && (value.startUnix as number) < (value.endUnix as number);
}

function validStatsBucket(value: unknown): boolean {
  return value === "tenMinutes" || value === "hour" || value === "day" || value === "week" || value === "month";
}

/** Raw path as hex; the empty string is the repository root. */
function validOptionalPathHex(value: unknown): boolean {
  return value === "" || validPathHex(value);
}

export function validStatsQueryParams(params: unknown): boolean {
  return isRecord(params) && hasExactKeys(params, ["bucket", "query", "range"]) && validStatsBucket(params.bucket) &&
    validStatsRange(params.range) && isSearchQuery(params.query);
}

export function validChangeStatsParams(params: unknown): boolean {
  return isRecord(params) && hasKeysWithOptional(params, ["bucket", "query", "range"], ["directoryPrefix"]) && validStatsBucket(params.bucket) &&
    validStatsRange(params.range) && isSearchQuery(params.query) && (params.directoryPrefix === undefined || validOptionalPathHex(params.directoryPrefix));
}

function validStatsSelection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "file") return hasExactKeys(value, ["kind", "pathHex"]) && validPathHex(value.pathHex);
  if (value.kind === "directory") return hasExactKeys(value, ["kind", "pathHex"]) && validOptionalPathHex(value.pathHex);
  if (value.kind === "pair") return hasExactKeys(value, ["aHex", "bHex", "kind"]) && validPathHex(value.aHex) && validPathHex(value.bHex);
  return value.kind === "untested" && hasExactKeys(value, ["kind"]);
}

export function validStatsCommitsParams(params: unknown): boolean {
  return isRecord(params) && hasExactKeys(params, ["limit", "offset", "query", "range", "selection"]) &&
    Number.isInteger(params.limit) && (params.limit as number) >= 1 && (params.limit as number) <= 200 &&
    Number.isInteger(params.offset) && (params.offset as number) >= 0 && (params.offset as number) <= 0xffff_ffff &&
    validStatsRange(params.range) && isSearchQuery(params.query) && validStatsSelection(params.selection);
}

export function validStatsExclusionsParams(params: unknown): boolean {
  if (!isRecord(params) || !hasExactKeys(params, ["patterns"]) || !Array.isArray(params.patterns) || params.patterns.length > 100) return false;
  let total = 0;
  for (const pattern of params.patterns) {
    if (!boundedText(pattern, 1024)) return false;
    total += Buffer.byteLength(pattern, "utf8");
  }
  return total <= 64 * 1024;
}

export function validEvolutionParams(params: unknown): boolean {
  return isRecord(params) && hasKeysWithOptional(params, ["commit", "pathHex"], ["range"]) && validOid(params.commit) &&
    validOptionalPathHex(params.pathHex) && (params.range === undefined || params.range === null || validStatsRange(params.range));
}

/** P5-01 / P7-01: user-triggered operations that write to the repository or use the network; one at a time. */
const OPERATION_METHODS = ["fetchRepository", "pushRepository", "runOperation"];

// Keep these lanes aligned with daemon admission. getActivityStats is the old
// top-bar read and deliberately remains interactive, with its existing preemption.
const STATISTICS_METHODS = ["getActivityOverview", "getChangeStats", "getNotableStats", "getStatsCommits", "getStatsExclusions", "setStatsExclusions"];
const EVOLUTION_METHODS = ["estimateEvolution", "analyzeEvolution"];

function requestLaneFor(method: ClientRequestMessage["method"]): RequestLane {
  if (OPERATION_METHODS.includes(method)) return "operation";
  if (STATISTICS_METHODS.includes(method)) return "statistics";
  if (EVOLUTION_METHODS.includes(method)) return "evolution";
  return "interactive";
}

/** P5-02 / P5-03 and M6: ordinary session reads that can be cancelled and drained. `runOperation` is in OPERATION_METHODS. */
const M5_M6_READ_METHODS = [
  "getBranchSync", "checkOperation", "getActivityOverview", "getChangeStats", "getNotableStats", "getStatsCommits",
  "getStatsExclusions", "setStatsExclusions", "estimateEvolution", "analyzeEvolution",
];

/** P4-10 to P4-12 reads of the files page: session methods that can be cancelled and drained. */
const FILE_METHODS = ["listTree", "readFileContent", "readFileHistory", "readFileChange", "listPathChanges", "readBlame"];

function validOid(value: unknown): boolean {
  return typeof value === "string" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value);
}

function hasKeysWithOptional(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => required.includes(key) || optional.includes(key));
}

/** P4-09 workspace reads: session methods that can be cancelled and drained. */
const WORKSPACE_METHODS = ["readWorkspaceStatus", "readWorkspaceDiff", "readWorkspaceFile"];

/** A repository-relative path as hex of its raw bytes: non-empty, even length, no NUL byte. */
function validPathHex(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 32 * 1024 && value.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(value) && !Buffer.from(value, "hex").includes(0);
}

function isSearchQuery(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["authors", "caseSensitive", "committers", "fromTimestamp", "message", "oidPrefix", "path", "timeField", "timeZone", "toTimestamp"])) return false;
  const timestamp = (item: unknown) => item === null || Number.isSafeInteger(item);
  const identities = (item: unknown) => Array.isArray(item) && item.length <= 50 && item.every(identity =>
    isRecord(identity) && hasExactKeys(identity, ["email", "name"]) &&
    typeof identity.name === "string" && Buffer.byteLength(identity.name, "utf8") <= 4096 &&
    typeof identity.email === "string" && Buffer.byteLength(identity.email, "utf8") <= 4096);
  return typeof value.message === "string" && Buffer.byteLength(value.message, "utf8") <= 4096 &&
    typeof value.caseSensitive === "boolean" && identities(value.authors) && identities(value.committers) &&
    typeof value.oidPrefix === "string" && (value.oidPrefix === "" || /^[0-9a-fA-F]{4,64}$/.test(value.oidPrefix)) &&
    (value.timeField === "author" || value.timeField === "committer") && timestamp(value.fromTimestamp) && timestamp(value.toTimestamp) &&
    (value.fromTimestamp === null || value.toTimestamp === null || (value.fromTimestamp as number) < (value.toTimestamp as number)) &&
    typeof value.timeZone === "string" && value.timeZone.length > 0 && Buffer.byteLength(value.timeZone, "utf8") <= 128 &&
    validSearchPathFilter(value.path);
}

function validSearchPathFilter(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || !hasExactKeys(value, ["includeDescendants", "kind", "rawHex"]) ||
    (value.kind !== "file" && value.kind !== "directory") || typeof value.includeDescendants !== "boolean" ||
    typeof value.rawHex !== "string" || value.rawHex.length > 32 * 1024 || value.rawHex.length % 2 !== 0 ||
    !/^[0-9a-fA-F]*$/.test(value.rawHex) || value.kind === "file" && value.rawHex.length === 0) return false;
  return !Buffer.from(value.rawHex, "hex").includes(0);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

type RequestMode = "legacy" | "control" | "session";

function requestModeFor(method: string): RequestMode | undefined {
  if (method === "getRuntimeInfo" || method === "readRepositoryPreview") return "legacy";
  if (method === "openRepository" || method === "listRecentRepositories") return "control";
  if (["getRepositorySession", "readSessionPreview", "recordRepositoryView", "closeRepository", "readHistoryPage", "locateCommit", "locateHistoryDate", "refreshRepository", "getRepositoryNavigation", "selectRepositoryScope", "refMergeStatus", "getMetadataIndexStatus", "controlMetadataIndex", "searchCommits", "listSearchIdentities", "listSearchPaths", "getActivityStats", "observeRepository", "diffRefSnapshots", "getHandoffFacts", "getCommit", "listChangedFiles", "readMergeCommits", "branchesContaining", "readDiff", ...WORKSPACE_METHODS, ...FILE_METHODS, ...OPERATION_METHODS, ...M5_M6_READ_METHODS].includes(method)) return "session";
  return undefined;
}

function asProtocolError(error: unknown, fallback: ProtocolErrorCode): ProtocolClientError {
  return error instanceof ProtocolClientError ? error : new ProtocolClientError(fallback, errorMessage(error), true);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
