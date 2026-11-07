import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export class SessionDaemonClient {
  constructor(executable, { cwd, env } = {}) {
    this.child = spawn(executable, [], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.buffer = Buffer.alloc(0);
    this.lines = [];
    this.waiters = [];
    this.pending = new Map();
    this.stderr = "";
    this.failure = null;
    this.sequence = 0;
    this.closed = new Promise(resolve => this.child.once("close", (code, signal) => resolve({ code, signal })));
    this.child.once("error", error => this.#fail(error));
    this.child.once("close", (code, signal) => this.#fail(new Error(`Daemon exited (${code ?? signal}); ${this.stderr}`)));
    this.child.stdout.on("data", chunk => this.#onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-32 * 1024); });
    this.child.stdin.on("error", () => {});
  }

  async start(timeoutMs = 7000) {
    this.child.stdin.write(`${JSON.stringify({ type: "hello", protocolVersion: 1 })}\n`);
    const message = await this.#nextMessage(timeoutMs);
    if (message.type !== "hello") throw new Error(`Expected hello, received ${JSON.stringify(message)}`);
    if (!message.core.capabilities.includes("repositorySessions")) throw new Error("Daemon does not advertise repositorySessions");
    return message.core;
  }

  open(path) { return this.request("openRepository", null, null, { path }); }
  beginOpen(path) { return this.beginRequest("openRepository", null, null, { path }); }
  listRecent() { return this.request("listRecentRepositories", null, null, {}); }
  getSession(session) { return this.request("getRepositorySession", session.repoId, session.generation, {}); }
  readPreview(session) { return this.request("readSessionPreview", session.repoId, session.generation, {}); }
  beginReadPreview(session) { return this.beginRequest("readSessionPreview", session.repoId, session.generation, {}); }
  recordView(session) { return this.request("recordRepositoryView", session.repoId, session.generation, {}); }
  closeSession(session) { return this.request("closeRepository", session.repoId, session.generation, {}); }

  request(method, repoId, generation, params) {
    return this.beginRequest(method, repoId, generation, params).result;
  }

  beginRequest(method, repoId, generation, params) {
    const requestId = `session-${++this.sequence}`;
    const chunks = [];
    let timer;
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${method} timed out; stderr=${this.stderr}`));
      }, 20_000);
      this.pending.set(requestId, message => {
        if (message.type === "error") {
          const error = new Error(`${message.code}: ${message.message}`);
          error.code = message.code;
          error.retryable = message.retryable;
          clearTimeout(timer);
          reject(error);
          return;
        }
        if (message.type !== "response") {
          clearTimeout(timer);
          reject(new Error(`Unexpected daemon message: ${JSON.stringify(message)}`));
          return;
        }
        chunks.push(message);
        if (message.done) {
          clearTimeout(timer);
          resolve({ chunks, completion: message, data: message.data });
        }
      });
    });
    this.child.stdin.write(`${JSON.stringify({ type: "request", requestId, method, repoId, generation, params })}\n`);
    const tracked = result.finally(() => this.pending.delete(requestId));
    tracked.catch(() => {});
    return { requestId, result: tracked };
  }

  cancel(requestId) { this.child.stdin.write(`${JSON.stringify({ type: "cancel", requestId })}\n`); }

  async stop(timeoutMs = 3000) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.closed;
    this.child.stdin.end();
    const result = await Promise.race([this.closed, delay(timeoutMs).then(() => null)]);
    if (result) {
      if (result.code === 0 && result.signal === null) return result;
      throw new Error(`Daemon exited abnormally (${result.code ?? result.signal}); stderr=${this.stderr}`);
    }
    this.#killGroup("SIGTERM");
    const terminated = await Promise.race([this.closed, delay(1000).then(() => null)]);
    if (terminated) throw new Error(`Daemon required SIGTERM cleanup (${terminated.code ?? terminated.signal}); stderr=${this.stderr}`);
    this.#killGroup("SIGKILL");
    const killed = await Promise.race([this.closed, delay(1000).then(() => null)]);
    if (!killed) throw new Error(`Daemon PID ${this.child.pid} remained alive after SIGKILL`);
    throw new Error(`Daemon required SIGKILL cleanup (${killed.code ?? killed.signal}); stderr=${this.stderr}`);
  }

  #nextMessage(timeoutMs) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for daemon; stderr=${this.stderr}`));
      }, Math.max(1, timeoutMs));
      waiter.resolve = value => { clearTimeout(timer); resolve(value); };
      waiter.reject = error => { clearTimeout(timer); reject(error); };
      this.waiters.push(waiter);
      if (this.lines.length) waiter.resolve(this.lines.shift());
    });
  }

  #onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 1024 * 1024 + 1) {
      this.#fail(new Error("Daemon output exceeded the JSONL frame limit"));
      this.#killGroup("SIGKILL");
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.length) continue;
      let message;
      try { message = JSON.parse(line.toString("utf8")); }
      catch (error) { this.#fail(new Error(`Invalid daemon JSON: ${error.message}`)); this.#killGroup("SIGKILL"); return; }
      if (typeof message.requestId === "string" && this.pending.has(message.requestId)) this.pending.get(message.requestId)(message);
      else {
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message);
        else this.lines.push(message);
      }
    }
  }

  #fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending({ type: "error", code: "DAEMON_EXITED", message: error.message, retryable: false });
    this.pending.clear();
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  #killGroup(signal) {
    if (process.platform !== "win32" && this.child.pid) {
      try { process.kill(-this.child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
    } else if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
  }
}

export function createDaemonEnvironment(dataDir, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, COMMITSCOPE_APP_DATA_DIR: dataDir, ...extra };
}
