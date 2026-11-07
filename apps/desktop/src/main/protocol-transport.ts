import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { Ajv } from "ajv";
import coreReadySchema from "../../../../packages/protocol/schema/core-ready.schema.json" with { type: "json" };
import clientMessageSchema from "../../../../packages/protocol/schema/client-message.schema.json" with { type: "json" };
import serverMessageSchema from "../../../../packages/protocol/schema/server-message.schema.json" with { type: "json" };
import type { CoreReady } from "../../../../packages/protocol/src/core-ready.js";
import type {
  ClientMessage,
} from "../../../../packages/protocol/src/generated/client-message.js";
import type { ServerMessage } from "../../../../packages/protocol/src/generated/server-message.js";
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

const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
const validateClient = ajv.compile<ClientMessage>(clientMessageSchema);
const validateServer = ajv.compile<ServerMessage>(serverMessageSchema);
const validateCoreReady = ajv.compile<CoreReady>(coreReadySchema);

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
  maxPendingRequests?: number;
  contextGate?: ViewContextGate;
  onFatal?: (error: ProtocolClientError) => void;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  retainResultAfterAbort?: boolean;
  drainAfterAbort?: boolean;
  fatalOnTimeout?: boolean;
  onChunk?: (chunk: ServerResponseMessage) => void;
}

export type RequestCompletion = Pick<ServerResponseMessage, "coverage" | "nextCursor">;

interface PendingRequest {
  context: RequestContext;
  gateBound: boolean;
  retainResultAfterAbort: boolean;
  drainAfterAbort: boolean;
  fatalOnTimeout: boolean;
  cancelRequested: boolean;
  cancelError?: ProtocolClientError;
  nextSequence: number;
  resolve: (completion: RequestCompletion) => void;
  reject: (error: ProtocolClientError) => void;
  onChunk?: (chunk: ServerResponseMessage) => void;
  timer: NodeJS.Timeout;
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
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new ProtocolClientError("BUSY", "交互请求已满", true));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new ProtocolClientError("CANCELLED", abortMessage(options.signal), true));
    }
    if (options.retainResultAfterAbort && method !== "openRepository" && method !== "refreshRepository" && method !== "selectRepositoryScope") {
      return Promise.reject(new ProtocolClientError("INVALID_REQUEST", "仅打开、刷新和范围切换可保留迟到的成功终态"));
    }
    if (options.drainAfterAbort && method !== "readHistoryPage" && method !== "locateCommit" && method !== "refMergeStatus" && method !== "getMetadataIndexStatus" &&
      method !== "searchCommits" && method !== "listSearchIdentities" &&
      !["getCommit", "listChangedFiles", "readMergeCommits", "branchesContaining", "readDiff"].includes(method)) {
      return Promise.reject(new ProtocolClientError("INVALID_REQUEST", "该请求不支持取消并排空终态"));
    }
    if (options.fatalOnTimeout && !["openRepository", "closeRepository", "readHistoryPage", "locateCommit", "refreshRepository", "selectRepositoryScope"].includes(method)) {
      return Promise.reject(new ProtocolClientError("INVALID_REQUEST", "仅会话变更请求可因超时关闭连接"));
    }

    const requestId = this.nextRequestId();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new ProtocolClientError("INVALID_REQUEST", "请求超时必须为正数"));
    }

    return new Promise<RequestCompletion>((resolve, reject) => {
      const pending: PendingRequest = {
        context: { ...context },
        gateBound: requestMode === "session",
        retainResultAfterAbort: options.retainResultAfterAbort === true,
        drainAfterAbort: options.drainAfterAbort === true,
        fatalOnTimeout: options.fatalOnTimeout === true,
        cancelRequested: false,
        nextSequence: 0,
        resolve,
        reject,
        onChunk: options.onChunk,
        timer: setTimeout(() => {
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
      this.fail(new ProtocolClientError("PROTOCOL_ERROR", `服务端消息结构无效：${ajv.errorsText(validateServer.errors)}`));
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
        this.fail(new ProtocolClientError("PROTOCOL_ERROR", `CoreReady 结构无效：${ajv.errorsText(validateCoreReady.errors)}`));
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
    if (pending.gateBound && !this.contextGate.accepts(message.requestId, pending.context)) {
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
      return Promise.reject(new ProtocolClientError("PROTOCOL_ERROR", `客户端消息结构无效：${ajv.errorsText(validateClient.errors)}`));
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
    typeof params.oid === "string" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(params.oid) &&
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
  if (method === "readDiff" && isRecord(params) && hasExactKeys(params, ["newPathHex", "oid", "oldPathHex", "parentIndex"]) &&
    typeof params.oid === "string" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(params.oid) &&
    (params.parentIndex === null || Number.isInteger(params.parentIndex) && (params.parentIndex as number) >= 0 && (params.parentIndex as number) <= 127) &&
    (params.oldPathHex === null || typeof params.oldPathHex === "string" && params.oldPathHex.length > 0 && params.oldPathHex.length <= 32 * 1024 && params.oldPathHex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(params.oldPathHex)) &&
    (params.newPathHex === null || typeof params.newPathHex === "string" && params.newPathHex.length > 0 && params.newPathHex.length <= 32 * 1024 && params.newPathHex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(params.newPathHex)) &&
    (params.oldPathHex !== null || params.newPathHex !== null)) return true;
  if (["getRepositorySession", "readSessionPreview", "recordRepositoryView", "closeRepository", "listRecentRepositories"].includes(method)) {
    return isRecord(params) && Object.keys(params).length === 0;
  }
  return false;
}

function isSearchQuery(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["authors", "caseSensitive", "committers", "fromTimestamp", "message", "oidPrefix", "timeField", "timeZone", "toTimestamp"])) return false;
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
    typeof value.timeZone === "string" && value.timeZone.length > 0 && Buffer.byteLength(value.timeZone, "utf8") <= 128;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

type RequestMode = "legacy" | "control" | "session";

function requestModeFor(method: string): RequestMode | undefined {
  if (method === "getRuntimeInfo" || method === "readRepositoryPreview") return "legacy";
  if (method === "openRepository" || method === "listRecentRepositories") return "control";
  if (["getRepositorySession", "readSessionPreview", "recordRepositoryView", "closeRepository", "readHistoryPage", "locateCommit", "refreshRepository", "getRepositoryNavigation", "selectRepositoryScope", "refMergeStatus", "getMetadataIndexStatus", "controlMetadataIndex", "searchCommits", "listSearchIdentities", "getCommit", "listChangedFiles", "readMergeCommits", "branchesContaining", "readDiff"].includes(method)) return "session";
  return undefined;
}

function asProtocolError(error: unknown, fallback: ProtocolErrorCode): ProtocolClientError {
  return error instanceof ProtocolClientError ? error : new ProtocolClientError(fallback, errorMessage(error), true);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
