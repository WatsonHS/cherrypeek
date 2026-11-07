import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export class HistoryDaemonClient {
  constructor(executable, { cwd, env } = {}) {
    this.child = spawn(executable, [], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.waiters = [];
    this.stderr = "";
    this.failure = null;
    this.sequence = 0;
    this.outputPaused = false;
    this.closed = new Promise(resolve => this.child.once("close", (code, signal) => resolve({ code, signal })));
    this.child.once("error", error => this.#fail(error));
    this.child.once("close", (code, signal) => this.#fail(new Error(`Daemon exited (${code ?? signal}); ${this.stderr}`)));
    this.child.stdout.on("data", chunk => this.#onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-64 * 1024); });
    this.child.stdin.on("error", () => {});
  }

  async start(timeoutMs = 7000) {
    this.child.stdin.write(`${JSON.stringify({ type: "hello", protocolVersion: 1 })}\n`);
    const hello = await this.#nextMessage(timeoutMs);
    if (hello.type !== "hello") throw new Error(`Expected hello, received ${JSON.stringify(hello)}`);
    if (!hello.core.capabilities.includes("historyPagination")) throw new Error("Daemon does not advertise historyPagination");
    return hello.core;
  }

  open(path) { return this.request("openRepository", null, null, { path }); }
  listRecent() { return this.request("listRecentRepositories", null, null, {}); }
  getSession(session) { return this.request("getRepositorySession", session.repoId, session.generation, {}); }
  readPage(session, cursor = null, pageSize = 200, timeoutMs = 30_000, onMessage = null) {
    return this.request("readHistoryPage", session.repoId, session.generation, { cursor, pageSize }, timeoutMs, onMessage);
  }
  beginReadPage(session, cursor = null, pageSize = 200, timeoutMs = 30_000, onMessage = null) {
    return this.beginRequest("readHistoryPage", session.repoId, session.generation, { cursor, pageSize }, timeoutMs, onMessage);
  }
  refresh(session, pageSize = 200, timeoutMs = 30_000) {
    return this.request("refreshRepository", session.repoId, session.generation, { pageSize }, timeoutMs);
  }
  recordView(session) { return this.request("recordRepositoryView", session.repoId, session.generation, {}); }
  close(session) { return this.request("closeRepository", session.repoId, session.generation, {}); }
  cancel(requestId) { this.child.stdin.write(`${JSON.stringify({ type: "cancel", requestId })}\n`); }
  pauseOutput() {
    this.outputPaused = true;
    this.child.stdout.pause();
  }
  resumeOutput() {
    this.outputPaused = false;
    this.#drainBuffer();
    this.child.stdout.resume();
  }
  request(method, repoId, generation, params, timeoutMs, onMessage = null) { return this.beginRequest(method, repoId, generation, params, timeoutMs, onMessage).result; }

  beginRequest(method, repoId, generation, params, timeoutMs = 20_000, onMessage = null) {
    const requestId = `history-${++this.sequence}`;
    const chunks = [];
    let timer;
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${method} timed out; stderr=${this.stderr}`));
      }, timeoutMs);
      this.pending.set(requestId, message => {
        if (message.type === "error") {
          const error = new Error(`${message.code}: ${message.message}`);
          error.code = message.code;
          error.retryable = message.retryable;
          error.repoId = message.repoId;
          error.generation = message.generation;
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
        if (onMessage?.(message) === false) this.pauseOutput();
        if (message.done) {
          clearTimeout(timer);
          resolve({ requestId, chunks, completion: message, data: message.data });
        }
      });
    });
    this.child.stdin.write(`${JSON.stringify({ type: "request", requestId, method, repoId, generation, params })}\n`);
    const tracked = result.finally(() => this.pending.delete(requestId));
    tracked.catch(() => {});
    return { requestId, result: tracked };
  }

  async stop(timeoutMs = 3000) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.closed;
    this.child.stdin.end();
    const result = await Promise.race([this.closed, delay(timeoutMs).then(() => null)]);
    if (result) {
      if (result.code === 0 && result.signal === null) return result;
      throw new Error(`Daemon exited abnormally (${result.code ?? result.signal}); ${this.stderr}`);
    }
    this.#killGroup("SIGTERM");
    const terminated = await Promise.race([this.closed, delay(1000).then(() => null)]);
    if (terminated) throw new Error(`Daemon required SIGTERM cleanup (${terminated.code ?? terminated.signal})`);
    this.#killGroup("SIGKILL");
    const killed = await Promise.race([this.closed, delay(1000).then(() => null)]);
    if (!killed) throw new Error(`Daemon PID ${this.child.pid} remained alive after SIGKILL`);
    throw new Error(`Daemon required SIGKILL cleanup (${killed.code ?? killed.signal})`);
  }

  async #nextMessage(timeoutMs) {
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for daemon; stderr=${this.stderr}`));
      }, timeoutMs);
      waiter.resolve = value => { clearTimeout(timer); resolve(value); };
      waiter.reject = error => { clearTimeout(timer); reject(error); };
      this.waiters.push(waiter);
    });
  }

  #onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 1024 * 1024 + 1) {
      this.#fail(new Error("Daemon output exceeded the JSONL frame limit"));
      this.#killGroup("SIGKILL");
      return;
    }
    this.#drainBuffer();
  }

  #drainBuffer() {
    if (this.outputPaused) return;
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
      }
      if (this.outputPaused) return;
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

export function projectSession(response) {
  const sessionChunk = response.chunks.find(chunk => chunk.data.section === "repositorySession");
  return sessionChunk?.data.session ?? null;
}

export function projectPage(response) {
  const repositoryChunk = response.chunks.find(chunk => chunk.data.section === "repository");
  const pageChunks = response.chunks.filter(chunk => chunk.data.section === "historyPage");
  if (!repositoryChunk || pageChunks.length === 0) throw new Error(`Incomplete history response: ${JSON.stringify(response.chunks.map(chunk => chunk.data.section))}`);
  const metadata = pageChunks[0].data;
  for (const chunk of pageChunks) {
    if (chunk.data.offset !== metadata.offset || chunk.data.pageSize !== metadata.pageSize || chunk.data.cursor !== metadata.cursor || chunk.data.previousCursor !== metadata.previousCursor || chunk.data.hasMore !== metadata.hasMore || chunk.data.newSinceLastSeenStatus !== metadata.newSinceLastSeenStatus || chunk.data.lastSeenDividerOid !== metadata.lastSeenDividerOid) {
      throw new Error("historyPage metadata changed between response chunks");
    }
  }
  const commits = pageChunks.flatMap(chunk => chunk.data.commits);
  const last = response.completion;
  if (last.data.section !== "historyPage") throw new Error("terminal response was not a historyPage chunk");
  return {
    repository: repositoryChunk.data.repository,
    refs: repositoryChunk.data.refs,
    refsTruncated: repositoryChunk.data.refsTruncated,
    ...metadata,
    commits,
    nextCursor: last.nextCursor,
    coverage: last.coverage,
    done: last.done,
    chunks: pageChunks,
  };
}
