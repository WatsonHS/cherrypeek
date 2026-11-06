import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { CoreReady } from "../../../../packages/protocol/src/core-ready.js";
import type { CoreStatus } from "../../../../packages/protocol/src/core-status.js";
import type { RequestContext } from "../../../../packages/protocol/src/messages.js";
import type { ClientRequestMessage } from "../../../../packages/protocol/src/messages.js";
import { ProtocolClientError, ProtocolTransport, type ProtocolTransportOptions, type RequestCompletion, type RequestOptions } from "./protocol-transport.js";
import { ViewContextGate } from "./view-context-gate.js";

const START_TIMEOUT_MS = 5000;

export interface CoreProcessOptions {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  handshakeTimeoutMs?: number;
  transport?: Omit<ProtocolTransportOptions, "onFatal" | "contextGate">;
}

type CoreStatusUpdate = CoreStatus extends infer Status ? Status extends CoreStatus ? Omit<Status, "revision"> : never : never;

export class CoreProcess {
  private child: ChildProcess | undefined;
  private transport: ProtocolTransport | undefined;
  private status: CoreStatus = { state: "stopped", revision: 0 };
  private readonly listeners = new Set<(status: CoreStatus) => void>();
  private readonly contextGate = new ViewContextGate();
  private stopping = false;
  private started = false;
  private childClosed = false;
  private childExitHandled = false;
  private exitPromise: Promise<void> | undefined;
  private processGroupCleanup: Promise<void> | undefined;
  private stderrBytes = 0;
  private stderrTail = "";
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly executable: string, private readonly options: CoreProcessOptions = {}) {}

  getStatus(): CoreStatus { return this.status; }

  subscribe(listener: (status: CoreStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  observeLatestContext(context: RequestContext): void { this.contextGate.observeLatest(context); }

  switchCurrentContext(context: RequestContext): void { this.contextGate.switchCurrent(context); }

  async start(): Promise<void> {
    if (this.started || this.stopping) throw new Error("Core process cannot be started more than once or after stop");
    this.started = true;
    this.setStatus({ state: "starting" });
    const spawnOptions = {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    };
    let child: ChildProcess;
    try {
      child = spawn(this.executable, this.options.args ?? [], spawnOptions);
    } catch (error) {
      this.fail(`无法启动核心：${errorMessage(error)}`);
      return;
    }
    this.child = child;
    this.exitPromise = new Promise<void>(resolve => {
      child.once("exit", (code, signal) => { resolve(); this.handleChildExit(child, code, signal); });
      child.once("close", (code, signal) => { resolve(); this.handleChildExit(child, code, signal); });
    });
    child.stderr?.on("data", (chunk: Buffer) => this.captureStderr(chunk));
    child.on("error", error => this.fail(`核心进程错误：${error.message}`));

    if (!child.stdin || !child.stdout || child.pid === undefined) {
      this.fail("核心进程 stdio 未能建立");
      return;
    }
    this.transport = new ProtocolTransport(child.stdout, child.stdin, {
      ...this.options.transport,
      contextGate: this.contextGate,
      onFatal: error => this.fail(`核心协议错误 [${error.code}]：${error.message}`),
    });
    try {
      const core = await this.transport.handshake(child.pid, this.options.handshakeTimeoutMs ?? START_TIMEOUT_MS);
      if (!this.stopping && this.status.state === "starting") this.setStatus({ state: "ready", core });
    } catch (error) {
      if (!this.stopping) this.fail(`核心握手失败：${formatError(error)}`);
    }
  }

  request(
    method: "getRuntimeInfo" | "readRepositoryPreview",
    params: ClientRequestMessage["params"],
    context: RequestContext,
    options: RequestOptions = {},
  ): Promise<RequestCompletion> {
    if (this.status.state !== "ready" || !this.transport) {
      return Promise.reject(new ProtocolClientError("CORE_EXITED", "核心尚未就绪", true));
    }
    return this.transport.request(method, params, context, options);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.transport?.close(new ProtocolClientError("CORE_EXITED", "应用正在关闭", true));
    this.stopPromise = this.stopChild();
    return this.stopPromise;
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.setStatus({ state: "stopped" });
      return;
    }
    const exited = this.exitPromise ?? Promise.resolve();
    if (this.childClosed || child.exitCode !== null || child.signalCode !== null) {
      await this.processGroupCleanup;
      this.setStatus({ state: "stopped" });
      return;
    }
    child.stdin?.end();
    if (await Promise.race([exited.then(() => true), delay(1500).then(() => false)])) {
      await this.processGroupCleanup;
      this.setStatus({ state: "stopped" });
      return;
    }
    this.signalProcessTree(child, "SIGTERM");
    if (await Promise.race([exited.then(() => true), delay(1000).then(() => false)])) {
      await this.processGroupCleanup;
      this.setStatus({ state: "stopped" });
      return;
    }
    this.signalProcessTree(child, "SIGKILL");
    await exited;
    await this.processGroupCleanup;
    this.setStatus({ state: "stopped" });
  }

  private fail(message: string): void {
    if (this.stopping || this.status.state === "error") return;
    const diagnostic = this.stderrTail.trim();
    this.setStatus({ state: "error", message: diagnostic ? `${message}：${diagnostic}` : message });
    this.transport?.close(new ProtocolClientError("CORE_EXITED", message, true));
    void this.reapAfterFailure();
  }

  private async reapAfterFailure(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (this.childClosed || child.exitCode !== null || child.signalCode !== null) {
      await this.processGroupCleanup;
      return;
    }
    child.stdin?.end();
    const exited = this.exitPromise ?? Promise.resolve();
    if (await Promise.race([exited.then(() => true), delay(500).then(() => false)])) return;
    this.signalProcessTree(child, "SIGTERM");
    if (await Promise.race([exited.then(() => true), delay(500).then(() => false)])) return;
    this.signalProcessTree(child, "SIGKILL");
    await exited;
  }

  private handleChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.childExitHandled) return;
    this.childExitHandled = true;
    this.childClosed = true;
    this.processGroupCleanup = this.cleanupProcessGroup(child);
    const message = `核心进程已退出（code=${code ?? "null"}, signal=${signal ?? "none"}）`;
    this.transport?.close(new ProtocolClientError("CORE_EXITED", message, true));
    if (this.stopping) this.setStatus({ state: "stopped" });
    else if (this.status.state !== "error") this.fail(message);
  }

  private async cleanupProcessGroup(child: ChildProcess): Promise<void> {
    if (process.platform === "win32" || child.pid === undefined) return;
    this.signalProcessTree(child, "SIGTERM");
    await delay(100);
    try { process.kill(-child.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
    this.signalProcessTree(child, "SIGKILL");
  }

  private signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal); }
    } else child.kill(signal);
  }

  private captureStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    this.stderrTail = `${this.stderrTail}${text}`.slice(-4096);
    if (this.stderrBytes >= 8192) return;
    const forwarded = chunk.subarray(0, 8192 - this.stderrBytes);
    process.stderr.write(`[commitscope-core] ${forwarded.toString("utf8")}`);
    this.stderrBytes += forwarded.length;
  }

  private setStatus(status: CoreStatusUpdate): void {
    this.status = { ...status, revision: this.status.revision + 1 } as CoreStatus;
    for (const listener of this.listeners) listener(this.status);
  }
}

function formatError(error: unknown): string {
  return error instanceof ProtocolClientError ? `[${error.code}] ${error.message}` : errorMessage(error);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
