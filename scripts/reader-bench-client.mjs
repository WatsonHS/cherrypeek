import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { aggregateProcessSamples, classifyProcess, mergeProcessObservation } from "./process-tree-observation.mjs";

const execFileAsync = promisify(execFile);
const MAX_JOB_BYTES = 64 * 1024;
const MAX_RESULT_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_OBJECT_BYTES = 1024 * 1024;
const MAX_TOTAL_OBJECT_BYTES = 32 * 1024 * 1024;

export class ReaderBenchClient {
  constructor(executable, { cwd, env, sampleIntervalMs = 100 } = {}) {
    if (process.platform !== "darwin") throw new Error("Reader benchmark process-tree sampling currently requires macOS");
    this.executable = executable;
    this.child = spawn(executable, [], {
      cwd,
      env: env ?? cleanEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });
    this.buffer = Buffer.alloc(0);
    this.events = [];
    this.waiters = [];
    this.stderr = "";
    this.failure = null;
    this.ready = null;
    this.job = null;
    this.startedAt = null;
    this.resultAt = null;
    this.cancelAt = null;
    this.resultSeen = false;
    this.sampler = null;
    this.sampleIntervalMs = sampleIntervalMs;
    this.child.on("error", error => this.#fail(error));
    this.child.stdout.on("data", chunk => this.#onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-64 * 1024); });
    this.child.stdin.on("error", error => this.#fail(error));
    this.closed = new Promise(resolve => this.child.once("close", (code, signal) => {
      this.exitResult = { code, signal, closedAt: performance.now() };
      this.#fail(new Error(`reader_bench exited (${code ?? signal}); stderr=${this.stderr}`));
      resolve(this.exitResult);
    }));
  }

  static async launch(executable, options = {}) {
    const client = new ReaderBenchClient(executable, options);
    try {
      client.ready = await client.waitForEvent("ready", options.readyTimeoutMs ?? 10_000);
      if (client.ready.protocolVersion !== 1) throw new Error(`Unsupported reader_bench protocolVersion ${client.ready.protocolVersion}`);
      client.sampler = new ProcessTreeSampler(client.child.pid, client.sampleIntervalMs);
      client.sampler.start();
      await client.sampler.sampleNow();
      return client;
    } catch (error) {
      await client.cancelAndReap({ timeoutMs: 1500 }).catch(() => {});
      throw error;
    }
  }

  sendJob(job) {
    if (!this.ready) throw new Error("reader_bench is not ready");
    if (this.job) throw new Error("reader_bench accepts only one job per process");
    validateJob(job);
    const line = `${JSON.stringify(job)}\n`;
    if (Buffer.byteLength(line) > MAX_JOB_BYTES) throw new Error(`reader_bench job exceeds ${MAX_JOB_BYTES} bytes`);
    this.job = job;
    this.jobSentAt = performance.now();
    this.child.stdin.write(line);
  }

  async waitForStarted(timeoutMs = 5000) {
    return this.waitForEvent("started", timeoutMs);
  }

  async waitForResult(timeoutMs = 35_000) {
    const event = await this.waitForEvent("result", timeoutMs);
    this.resultSeen = true;
    return event;
  }

  sendCancel() {
    if (!this.job || this.resultSeen) return false;
    if (this.cancelAt === null) this.cancelAt = performance.now();
    this.child.stdin.write("cancel\n");
    return true;
  }

  async sampleNow() {
    return this.sampler?.sampleNow() ?? null;
  }

  async shutdownAfterResult({ exitTimeoutMs = 3000, reapTimeoutMs = 2000 } = {}) {
    if (!this.resultSeen) throw new Error("Cannot gracefully exit reader_bench before its result event");
    const postResultSampleStartedAt = performance.now();
    const preExitSample = await (this.sampler?.sampleAfterPending() ?? this.sampleNow());
    const postResultSampleMs = performance.now() - postResultSampleStartedAt;
    this.child.stdin.write("exit\n");
    this.child.stdin.end();
    let forcedCleanup = false;
    let exitResult = await raceTimeout(this.closed, exitTimeoutMs);
    if (!exitResult) {
      forcedCleanup = true;
      this.#killGroup("SIGTERM");
      exitResult = await raceTimeout(this.closed, reapTimeoutMs);
    }
    if (!exitResult) {
      this.#killGroup("SIGKILL");
      exitResult = await raceTimeout(this.closed, reapTimeoutMs);
    }
    const samplerResult = await this.#stopSampler();
    const processExitBeforeCleanup = await waitForProcessTreeExit(samplerResult.processIdentities, 250);
    let cleanup = { attempted: false, processGroupSignals: [], signaledPids: [] };
    let processExit = processExitBeforeCleanup;
    if (!processExitBeforeCleanup.allExited) {
      forcedCleanup = true;
      cleanup = await cleanOwnedProcessTree(this.child.pid, samplerResult.processIdentities, reapTimeoutMs);
      processExit = cleanup.processExitAfterCleanup;
    }
    const exitSucceeded = Boolean(exitResult?.code === 0 && !exitResult.signal);
    return {
      exitResult,
      forcedCleanup,
      exitSucceeded,
      normalExit: Boolean(exitSucceeded && !forcedCleanup && processExit.allExited),
      preExitSample,
      postResultSampleMs,
      sampler: samplerResult,
      processExitBeforeCleanup,
      processExit,
      cleanup,
      jobWallMs: this.jobSentAt === undefined || this.resultAt === null ? null : this.resultAt - this.jobSentAt,
      startedToResultMs: this.startedAt === null || this.resultAt === null ? null : this.resultAt - this.startedAt,
      resultToExitMs: this.resultAt === null || !exitResult?.closedAt ? null : exitResult.closedAt - this.resultAt,
      jobToExitMs: this.jobSentAt === undefined || !exitResult?.closedAt ? null : exitResult.closedAt - this.jobSentAt,
      startedToExitMs: this.startedAt === null || !exitResult?.closedAt ? null : exitResult.closedAt - this.startedAt,
      cancelToResultMs: this.cancelAt === null || this.resultAt === null ? null : this.resultAt - this.cancelAt,
      cancelToExitMs: this.cancelAt === null || !exitResult?.closedAt ? null : exitResult.closedAt - this.cancelAt,
      stderr: this.stderr,
    };
  }

  async cancelAndReap({ cancelResultTimeoutMs = 1000, exitTimeoutMs = 1000, reapTimeoutMs = 2000 } = {}) {
    let result = null;
    let resultTimeout = false;
    if (this.job && !this.resultSeen) {
      this.sendCancel();
      try {
        result = await this.waitForResult(cancelResultTimeoutMs);
      } catch {
        resultTimeout = true;
      }
    }
    if (result) {
      const shutdown = await this.shutdownAfterResult({ exitTimeoutMs, reapTimeoutMs });
      return { result, resultTimeout, ...shutdown };
    }

    await this.sampleNow().catch(() => {});
    this.child.stdin.end();
    let exitResult = await raceTimeout(this.closed, exitTimeoutMs);
    let forcedCleanup = false;
    if (!exitResult) {
      forcedCleanup = true;
      this.#killGroup("SIGTERM");
      exitResult = await raceTimeout(this.closed, reapTimeoutMs);
    }
    if (!exitResult) {
      this.#killGroup("SIGKILL");
      exitResult = await raceTimeout(this.closed, reapTimeoutMs);
    }
    const sampler = await this.#stopSampler();
    const processExitBeforeCleanup = await waitForProcessTreeExit(sampler.processIdentities, 250);
    let cleanup = { attempted: false, processGroupSignals: [], signaledPids: [] };
    let processExit = processExitBeforeCleanup;
    if (!processExitBeforeCleanup.allExited) {
      forcedCleanup = true;
      cleanup = await cleanOwnedProcessTree(this.child.pid, sampler.processIdentities, reapTimeoutMs);
      processExit = cleanup.processExitAfterCleanup;
    }
    const exitSucceeded = Boolean(exitResult?.code === 0 && !exitResult.signal);
    return {
      result,
      resultTimeout,
      exitResult,
      forcedCleanup,
      exitSucceeded,
      normalExit: Boolean(exitSucceeded && !forcedCleanup && processExit.allExited),
      sampler,
      processExitBeforeCleanup,
      processExit,
      cleanup,
      jobWallMs: this.jobSentAt === undefined || this.resultAt === null ? null : this.resultAt - this.jobSentAt,
      startedToResultMs: this.startedAt === null || this.resultAt === null ? null : this.resultAt - this.startedAt,
      resultToExitMs: this.resultAt === null || !exitResult?.closedAt ? null : exitResult.closedAt - this.resultAt,
      jobToExitMs: this.jobSentAt === undefined || !exitResult?.closedAt ? null : exitResult.closedAt - this.jobSentAt,
      startedToExitMs: this.startedAt === null || !exitResult?.closedAt ? null : exitResult.closedAt - this.startedAt,
      cancelToResultMs: this.cancelAt === null || this.resultAt === null ? null : this.resultAt - this.cancelAt,
      cancelToExitMs: this.cancelAt === null || !exitResult?.closedAt ? null : exitResult.closedAt - this.cancelAt,
      stderr: this.stderr,
    };
  }

  async waitForEvent(name, timeoutMs) {
    const queued = this.events.findIndex(event => event.event === name);
    if (queued >= 0) return this.events.splice(queued, 1)[0];
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      const waiter = { name, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.#removeWaiter(waiter);
        reject(new Error(`Timed out waiting for reader_bench ${name}; stderr=${this.stderr}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async #stopSampler() {
    if (!this.sampler) return { samples: [], processIdentities: [], processes: [] };
    await this.sampler.stop();
    return this.sampler.toRecord();
  }

  #onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_RESULT_FRAME_BYTES) {
      this.#fail(new Error(`reader_bench stdout frame exceeds ${MAX_RESULT_FRAME_BYTES} bytes`));
      this.#killGroup("SIGKILL");
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length === 0) continue;
      let event;
      try { event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
      catch (error) {
        this.#fail(new Error(`Invalid reader_bench JSONL: ${error.message}`));
        this.#killGroup("SIGKILL");
        return;
      }
      if (!event || typeof event.event !== "string") {
        this.#fail(new Error("reader_bench emitted a JSON event without event name"));
        this.#killGroup("SIGKILL");
        return;
      }
      const waiterIndex = this.waiters.findIndex(waiter => waiter.name === event.event);
      const eventReceivedAt = performance.now();
      if (event.event === "started" && this.startedAt === null) this.startedAt = eventReceivedAt;
      if (event.event === "result" && this.resultAt === null) this.resultAt = eventReceivedAt;
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      } else {
        this.events.push(event);
      }
    }
  }

  #removeWaiter(waiter) {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  #fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #killGroup(signal) {
    if (this.child.pid) {
      try { process.kill(-this.child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
}

export function validateJob(job) {
  const keys = ["backend", "operation", "repository", "gitExecutable", "headOid", "offset", "limit", "oids"];
  if (!job || typeof job !== "object" || Array.isArray(job)) throw new Error("reader_bench job must be an object");
  if (Object.keys(job).sort().join("\n") !== keys.slice().sort().join("\n")) throw new Error("reader_bench job fields do not match the fixed schema");
  if (!new Set(["cli", "gix"]).has(job.backend)) throw new Error("invalid reader_bench backend");
  if (!new Set(["page", "objects", "scan"]).has(job.operation)) throw new Error("invalid reader_bench operation");
  if (typeof job.repository !== "string" || !job.repository.startsWith("/")) throw new Error("repository must be an absolute path");
  if (typeof job.gitExecutable !== "string" || !job.gitExecutable.startsWith("/")) throw new Error("gitExecutable must be an absolute path");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(job.headOid)) throw new Error("headOid must be a full SHA-1 or SHA-256 OID");
  if (!Number.isInteger(job.offset) || job.offset < 0 || job.offset > 100_000) throw new Error("offset must be between 0 and 100000");
  if (!Number.isInteger(job.limit) || job.limit < 1 || job.limit > 200) throw new Error("limit must be between 1 and 200");
  if (!Array.isArray(job.oids) || job.oids.length > 200 || job.oids.some(oid => typeof oid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid))) throw new Error("oids must contain at most 200 full OIDs");
  if (job.operation === "objects" && job.oids.length === 0) throw new Error("objects operation requires OIDs");
  if (job.operation !== "objects" && job.oids.length !== 0) throw new Error("oids are only valid for objects operation");
}

export async function runGitOracle({ repository, gitExecutable, headOid, operation = "page", offset = 0, limit = 200, oids = [] }) {
  if (!repository.startsWith("/")) throw new Error("Oracle repository must be absolute");
  if (!gitExecutable.startsWith("/")) throw new Error("Oracle Git executable must be absolute");
  let requestedOids;
  let hasMore = false;
  let visitedCount = 0;
  if (operation === "page") {
    const output = await runGit(gitExecutable, repository, ["rev-list", "--topo-order", `--skip=${offset}`, `--max-count=${limit + 1}`, headOid, "--"], { maxOutputBytes: 8 * 1024 * 1024 });
    const candidates = output.toString("ascii").trim().split(/\r?\n/).filter(Boolean);
    if (candidates.some(oid => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid))) throw new Error("Git oracle returned a malformed OID");
    hasMore = candidates.length > limit;
    requestedOids = candidates.slice(0, limit);
    visitedCount = candidates.length;
  } else if (operation === "objects") {
    requestedOids = [...oids];
    visitedCount = requestedOids.length;
  } else {
    return { operation, oids: [], hasMore: false, visitedCount: 0, rawBytes: 0, objectsDigest: null, objects: [] };
  }
  const objects = await readRawCommitObjects(gitExecutable, repository, requestedOids);
  return {
    operation,
    oids: requestedOids,
    hasMore,
    visitedCount,
    rawBytes: objects.reduce((sum, object) => sum + object.size, 0),
    objectsDigest: objects.length === 0 ? null : sha256ObjectsDigest(objects),
    objects,
  };
}

export function sha256ObjectsDigest(objects) {
  const digest = createHash("sha256");
  for (const object of objects) {
    digest.update(object.oid, "ascii");
    digest.update(Buffer.from([0]));
    digest.update(String(object.size), "ascii");
    digest.update(Buffer.from([0]));
    digest.update(object.bytes);
  }
  return digest.digest("hex");
}

export async function readRawCommitObjects(gitExecutable, repository, oids) {
  if (oids.length > 200) throw new Error("Oracle object batch exceeds 200 OIDs");
  if (oids.length === 0) return [];
  const input = Buffer.from(`${oids.join("\n")}\n`, "ascii");
  const output = await runGit(gitExecutable, repository, ["cat-file", "--batch"], { input, maxOutputBytes: MAX_TOTAL_OBJECT_BYTES + oids.length * 128 + 4096 });
  const objects = [];
  let offset = 0;
  let totalBytes = 0;
  for (const expectedOid of oids) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("Truncated Git cat-file --batch header");
    const header = output.subarray(offset, newline).toString("ascii");
    offset = newline + 1;
    const fields = header.split(" ");
    if (fields.length !== 3 || fields[0] !== expectedOid || fields[1] !== "commit" || !/^\d+$/.test(fields[2])) throw new Error(`Unexpected cat-file header: ${header.slice(0, 256)}`);
    const size = Number(fields[2]);
    if (!Number.isSafeInteger(size) || size > MAX_OBJECT_BYTES) throw new Error(`Commit object ${expectedOid} exceeds 1 MiB`);
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_OBJECT_BYTES) throw new Error("Commit object batch exceeds 32 MiB");
    if (offset + size >= output.length || output[offset + size] !== 0x0a) throw new Error(`Truncated commit object ${expectedOid}`);
    const bytes = output.subarray(offset, offset + size);
    objects.push({ oid: expectedOid, size, bytes: Buffer.from(bytes) });
    offset += size + 1;
  }
  if (offset !== output.length) throw new Error("Unexpected trailing bytes in cat-file --batch response");
  return objects;
}

async function runGit(executable, repository, args, { input, maxOutputBytes, timeoutMs = 30_000 }) {
  const gitArgs = [
    "--no-lazy-fetch", "--no-pager", "--no-replace-objects", "--no-optional-locks",
    "-c", "protocol.allow=never", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
    "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "fetch.writeCommitGraph=false",
    "-C", repository, ...args,
  ];
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, gitArgs, { env: cleanGitEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let outputBytes = 0;
    let stderr = "";
    let stdinError = null;
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", chunk => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16 * 1024); });
    child.stdin.on("error", error => { stdinError = error; });
    child.once("error", error => { clearTimeout(timeout); rejectRun(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (stdinError) return rejectRun(new Error(`Git oracle stdin failed: ${stdinError.message}`));
      if (code === 0) resolveRun(Buffer.concat(chunks));
      else rejectRun(new Error(`Git oracle command failed (${code ?? signal}): ${stderr.trim()}`));
    });
    child.stdin.end(input ?? undefined);
  });
}

function cleanGitEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  return {
    ...env,
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    ...extra,
  };
}

class ProcessTreeSampler {
  constructor(rootPid, intervalMs) {
    this.rootPid = rootPid;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.samplePromise = null;
    this.samples = [];
    this.processIdentities = new Map();
    this.cpuSecondsEstimate = 0;
    this.errors = [];
  }

  start() {
    this.timer = setInterval(() => { void this.sampleNow(); }, this.intervalMs);
    this.timer.unref();
  }

  async sampleNow() {
    if (this.samplePromise) return this.samplePromise;
    this.samplePromise = this.#sample().finally(() => { this.samplePromise = null; });
    return this.samplePromise;
  }

  async #sample() {
    try {
      const processes = await readProcessTable();
      const tree = collectProcessTree(processes, this.rootPid).map(processInfo => ({ ...processInfo, classification: classifyProcess(processInfo.command) }));
      for (const processInfo of tree) {
        const previousCpu = this.processIdentities.get(processInfo.pid)?.cpuSeconds;
        this.cpuSecondsEstimate += Math.max(0, processInfo.cpuSeconds - (previousCpu ?? 0));
        const identity = mergeProcessObservation(this.processIdentities.get(processInfo.pid), processInfo);
        this.processIdentities.set(processInfo.pid, { ...identity, cpuSeconds: processInfo.cpuSeconds });
      }
      const sample = { sampledAt: new Date().toISOString(), tree };
      this.samples.push(sample);
      return sample;
    } catch (error) {
      this.errors.push({ message: error.message });
      return null;
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.samplePromise) await this.samplePromise;
    await this.sampleNow();
  }

  async sampleAfterPending() {
    if (this.samplePromise) await this.samplePromise;
    return this.sampleNow();
  }

  toRecord() {
    const samples = this.samples.map(sample => ({ ...sample, tree: sample.tree.map(({ classification, ...processInfo }) => ({ ...processInfo, classification })) }));
    return {
      samples,
      processIdentities: [...this.processIdentities.values()],
      processes: aggregateProcessSamples(samples),
      cpuSecondsEstimate: this.cpuSecondsEstimate,
      sampleErrors: this.errors,
      sampleIntervalMs: this.intervalMs,
    };
  }
}

async function readProcessTable() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,time=,lstart=,command="], { timeout: 2000, maxBuffer: 16 * 1024 * 1024 });
  const output = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.{24})\s+(.*)$/.exec(line);
    if (!match) continue;
    output.push({ pid: Number(match[1]), parentPid: Number(match[2]), rssKB: Number(match[3]), cpuPercent: Number(match[4]), cpuTime: match[5], cpuSeconds: parseCpuTime(match[5]), started: match[6].trim(), command: match[7].trim() });
  }
  return output;
}

function collectProcessTree(processes, rootPid) {
  const byParent = new Map();
  for (const processInfo of processes) {
    const children = byParent.get(processInfo.parentPid) ?? [];
    children.push(processInfo);
    byParent.set(processInfo.parentPid, children);
  }
  const root = processes.find(processInfo => processInfo.pid === rootPid);
  const result = root ? [root] : [];
  const seen = new Set(root ? [rootPid] : []);
  const pending = root ? [rootPid] : [];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    for (const child of byParent.get(parentPid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
      pending.push(child.pid);
    }
  }
  return result;
}

async function waitForProcessTreeExit(identities, timeoutMs) {
  const identityList = identities instanceof Map ? [...identities.values()] : identities;
  const deadline = Date.now() + timeoutMs;
  let live = [];
  do {
    live = [];
    for (const identity of identityList) {
      const current = await readProcessIdentity(identity.pid);
      if (current && current.started === identity.started) live.push({ pid: identity.pid, started: identity.started, command: identity.command });
    }
    if (live.length === 0) return { allExited: true, checkedPids: identityList.length, live };
    await delay(50);
  } while (Date.now() < deadline);
  return { allExited: false, checkedPids: identityList.length, live };
}

async function cleanOwnedProcessTree(rootPid, identities, timeoutMs) {
  const identityList = identities instanceof Map ? [...identities.values()] : identities;
  const processGroupSignals = [];
  const signaledPids = [];
  const liveBefore = [];
  for (const identity of identityList) {
    const current = await readProcessIdentity(identity.pid);
    if (current && current.started === identity.started) liveBefore.push(identity);
  }
  if (liveBefore.length > 0) {
    try {
      process.kill(-rootPid, "SIGTERM");
      processGroupSignals.push("SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  let processExitAfterCleanup = await waitForProcessTreeExit(identityList, Math.min(timeoutMs, 750));
  if (!processExitAfterCleanup.allExited) {
    for (const identity of processExitAfterCleanup.live) {
      const current = await readProcessIdentity(identity.pid);
      if (!current || current.started !== identity.started) continue;
      try {
        process.kill(identity.pid, "SIGKILL");
        signaledPids.push(identity.pid);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    processExitAfterCleanup = await waitForProcessTreeExit(identityList, timeoutMs);
  }
  return { attempted: liveBefore.length > 0, processGroupSignals, signaledPids, liveBefore, processExitAfterCleanup };
}

async function readProcessIdentity(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart=,command="], { timeout: 1000, maxBuffer: 4096 });
    const match = /^(.{24})\s+(.*)$/.exec(stdout.trimEnd());
    return match ? { started: match[1].trim(), command: match[2].trim() } : null;
  } catch {
    return null;
  }
}

function parseCpuTime(value) {
  const days = /^(\d+)-(.*)$/.exec(value);
  if (days) return Number(days[1]) * 86400 + parseCpuTime(days[2]);
  const parts = value.split(":");
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  return 0;
}

function raceTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]).finally(() => clearTimeout(timer));
}
