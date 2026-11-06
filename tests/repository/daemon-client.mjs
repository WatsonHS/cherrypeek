import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export class DaemonClient {
  constructor(executable, options = {}) {
    this.child = spawn(executable, [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.buffer = Buffer.alloc(0);
    this.lines = [];
    this.waiters = [];
    this.stderr = "";
    this.failure = null;
    this.closed = new Promise(resolve => this.child.once("close", (code, signal) => resolve({ code, signal })));
    this.child.once("error", error => this.#fail(error));
    this.child.once("close", (code, signal) => this.#fail(new Error(`Daemon closed (${code ?? signal}); stderr=${this.stderr}`)));
    this.child.stdout.on("data", chunk => this.#onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-32 * 1024); });
    this.child.stdin.on("error", () => {});
  }

  async start(timeoutMs = 7000) {
    this.child.stdin.write(`${JSON.stringify({ type: "hello", protocolVersion: 1 })}\n`);
    const hello = await this.#nextMessage(timeoutMs);
    if (hello.type !== "hello") throw new Error(`Expected daemon hello, received ${JSON.stringify(hello)}`);
    if (!hello.core.capabilities.includes("readRepositoryPreview")) throw new Error("Daemon did not advertise readRepositoryPreview");
    return hello.core;
  }

  async readRepositoryPreview(path, timeoutMs = 20_000) {
    const requestId = `repository-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.child.stdin.write(`${JSON.stringify({ type: "request", requestId, method: "readRepositoryPreview", repoId: null, generation: null, params: { path } })}\n`);
    return this.#collect(requestId, timeoutMs);
  }

  startRepositoryPreview(path, timeoutMs = 20_000) {
    const requestId = `repository-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.child.stdin.write(`${JSON.stringify({ type: "request", requestId, method: "readRepositoryPreview", repoId: null, generation: null, params: { path } })}\n`);
    return { requestId, result: this.#collect(requestId, timeoutMs) };
  }

  cancel(requestId) {
    this.child.stdin.write(`${JSON.stringify({ type: "cancel", requestId })}\n`);
  }

  async #collect(requestId, timeoutMs) {
    const chunks = [];
    let sequence = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const message = await this.#nextMessage(deadline - Date.now());
      if (message.requestId !== requestId) throw new Error(`Unexpected response requestId ${message.requestId}, expected ${requestId}`);
      if (message.type === "error") {
        const error = new Error(`${message.code}: ${message.message}`);
        error.code = message.code;
        error.retryable = message.retryable;
        throw error;
      }
      if (message.type !== "response") throw new Error(`Unexpected message: ${JSON.stringify(message)}`);
      if (message.sequence !== sequence) throw new Error(`Response sequence ${message.sequence}, expected ${sequence}`);
      sequence += 1;
      chunks.push(message);
      if (message.done) return { chunks, completion: message };
    }
    throw new Error(`readRepositoryPreview exceeded ${timeoutMs}ms`);
  }

  async stop(timeoutMs = 3000) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.closed;
    this.child.stdin.end();
    const result = await Promise.race([this.closed, delay(timeoutMs).then(() => null)]);
    if (result) return result;
    this.killGroup("SIGTERM");
    const terminated = await Promise.race([this.closed, delay(1000).then(() => null)]);
    if (terminated) return terminated;
    this.killGroup("SIGKILL");
    return Promise.race([this.closed, delay(1000).then(() => { throw new Error(`Daemon PID ${this.child.pid} did not exit after SIGKILL`); })]);
  }

  killGroup(signal) {
    if (process.platform !== "win32" && this.child.pid) {
      try { process.kill(-this.child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
    } else if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
  }

  async #nextMessage(timeoutMs) {
    if (this.failure) throw this.failure;
    if (this.lines.length > 0) return this.lines.shift();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for daemon output; stderr=${this.stderr}`));
      }, Math.max(1, timeoutMs));
      const waiter = { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } };
      const cleanup = () => {
        clearTimeout(timer);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      this.waiters.push(waiter);
      if (this.lines.length > 0) waiter.resolve(this.lines.shift());
    });
  }

  #onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 1024 * 1024 + 1) {
      this.killGroup("SIGKILL");
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length === 0) continue;
      let message;
      try { message = JSON.parse(line.toString("utf8")); }
      catch (error) { this.#fail(new Error(`Invalid daemon JSON: ${error.message}`)); this.killGroup("SIGKILL"); return; }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(message);
      else this.lines.push(message);
    }
  }

  #fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}
