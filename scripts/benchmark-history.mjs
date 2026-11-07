#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { aggregateProcessSamples, classifyProcess, mergeProcessObservation } from "./process-tree-observation.mjs";
import { HistoryDaemonClient, createDaemonEnvironment, projectPage, projectSession } from "../tests/history/daemon-client.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
if (process.platform !== "darwin") throw new Error("benchmark:history requires macOS process-tree sampling");
if (!args.repository || !args.output) throw new Error("Usage: pnpm benchmark:history --repository=<100k-fixture> --output=<new-json> [--daemon=<absolute-path>] [--runs=3]");

const fixturePath = resolve(args.repository);
const daemonPath = resolve(args.daemon ?? join(root, "target/release/commitscope-daemon"));
const outputPath = resolve(args.output);
const fixtureRoot = dirname(fixturePath);
const manifestPath = join(fixtureRoot, "manifest.json");
const gitPath = await findGitExecutable();

class ProcessTreeSampler {
  constructor(rootPid, intervalMs) {
    this.rootPid = rootPid;
    this.intervalMs = intervalMs;
    this.samples = [];
    this.identities = new Map();
    this.errors = [];
    this.cpuSecondsEstimate = 0;
    this.pending = null;
    this.timer = null;
  }
  start() { this.timer = setInterval(() => { void this.sampleNow(); }, this.intervalMs); this.timer.unref(); }
  async sampleNow() {
    if (this.pending) return this.pending;
    this.pending = this.#sample().finally(() => { this.pending = null; });
    return this.pending;
  }
  async #sample() {
    try {
      const table = await readProcessTable();
      const byParent = new Map();
      for (const item of table) {
        const children = byParent.get(item.parentPid) ?? [];
        children.push(item);
        byParent.set(item.parentPid, children);
      }
      const rootProcess = table.find(item => item.pid === this.rootPid);
      const tree = [];
      if (rootProcess) {
        const queue = [rootProcess.pid];
        const seen = new Set(queue);
        while (queue.length) {
          const parent = queue.pop();
          for (const child of byParent.get(parent) ?? []) if (!seen.has(child.pid)) { seen.add(child.pid); queue.push(child.pid); tree.push(child); }
        }
        tree.unshift(rootProcess);
      }
      const classified = tree.map(item => ({ ...item, classification: classifyProcess(item.command) }));
      for (const item of classified) {
        const key = `${item.pid}:${item.started}`;
        const previous = this.identities.get(key);
        const merged = mergeProcessObservation(previous, item);
        this.cpuSecondsEstimate += Math.max(0, item.cpuSeconds - (previous?.cpuSeconds ?? 0));
        this.identities.set(key, { ...merged, cpuSeconds: item.cpuSeconds });
      }
      const sample = { sampledAt: new Date().toISOString(), tree: classified };
      this.samples.push(sample);
      return sample;
    } catch (error) {
      this.errors.push({ message: error.message });
      return null;
    }
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.pending) await this.pending;
    await this.sampleNow();
  }
  toRecord() {
    const samples = this.samples.map(sample => ({ ...sample, tree: sample.tree.map(({ classification, ...item }) => ({ ...item, classification })) }));
    return { samples, processIdentities: [...this.identities.values()], processes: aggregateProcessSamples(samples), cpuSecondsEstimate: this.cpuSecondsEstimate, sampleErrors: this.errors };
  }
}

const output = {
  schemaVersion: 1,
  benchmark: "p1-02-history-pagination",
  startedAt: new Date().toISOString(),
  requestedRuns: args.runs,
  matrix: { pageSize: 200, targetOffsets: [0, 10_000, 50_000, 90_000], cachePages: 8, traversals: args.runs },
  measurement: {
    pageWallMs: "request write through terminal historyPage response for each actual daemon API page",
    cumulativeToOffsetMs: "elapsed from first readHistoryPage request through completion of target page; includes only the serial cursor traversal up to that page",
    processTree: "100 ms macOS ps samples include daemon and observed descendants; RSS is summed across the process tree and may double-count shared pages; short-lived Git can be missed; CPU is a separate sampled cumulative-time estimate",
    cacheDisclosure: "Each traversal uses a fresh daemon session and new app-data directory. Page cache is bounded by product behavior. OS page cache is not cleared; independent Git oracle runs before timing. Replayed cursors use the same live session/query.",
    unavailableInternals: "No product debug timing fields are added; observations contain API wall/cumulative timing only.",
  },
  environment: await collectEnvironment(),
  fixture: {},
  artifacts: {},
  oracle: {},
  traversals: [],
  summary: null,
};

let temporaryRoot;
let saveError = null;
try {
  await access(daemonPath);
  await access(fixturePath);
  await access(manifestPath);
  await ensureOutputDoesNotExist(outputPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const metadata = await inspectFixture(fixturePath, gitPath);
  if (metadata.commitCount !== 100_000) throw new Error(`Expected a 100000-commit fixture, found ${metadata.commitCount}`);
  if (manifest.fixtures?.large?.headOid !== metadata.headOid) throw new Error("Fixture manifest HEAD differs from the repository HEAD");
  if (manifest.fixtures?.large?.commitCount !== 100_000) throw new Error("Fixture manifest does not declare 100000 commits");
  const oracleStarted = performance.now();
  const expectedOids = await gitRevList(fixturePath, metadata.headOid, gitPath);
  if (expectedOids.length !== 100_000) throw new Error(`Independent Git oracle returned ${expectedOids.length} commits`);
  output.fixture = { path: fixturePath, manifestPath, manifestSha256: await sha256File(manifestPath), seed: manifest.seed, headOid: metadata.headOid, commitCount: metadata.commitCount, objectFormat: metadata.objectFormat, gitVersion: metadata.gitVersion };
  output.fixture.packState = metadata.packState;
  output.oracle = { source: "independent installed Git rev-list --topo-order at captured manifest HEAD", commitCount: expectedOids.length, orderedOidSha256: createHash("sha256").update(expectedOids.join("\n")).digest("hex"), preparationMs: performance.now() - oracleStarted };
  output.artifacts = {
    daemonPath,
    daemonSha256: await sha256File(daemonPath),
    benchmarkPath: import.meta.filename,
    benchmarkSha256: await sha256File(import.meta.filename),
    daemonClientPath: join(root, "tests/history/daemon-client.mjs"),
    daemonClientSha256: await sha256File(join(root, "tests/history/daemon-client.mjs")),
    samplerPath: join(root, "scripts/process-tree-observation.mjs"),
    samplerSha256: await sha256File(join(root, "scripts/process-tree-observation.mjs")),
    gitPath,
  };
  temporaryRoot = await (await import("node:fs/promises")).mkdtemp(join((process.env.TMPDIR ?? "/tmp"), "commitscope-history-bench-"));

  for (let runIndex = 1; runIndex <= args.runs; runIndex += 1) {
    const record = await runTraversal({ runIndex, fixturePath, daemonPath, expectedOids, temporaryRoot });
    output.traversals.push(record);
    if (record.failures.length > 0) {
      output.failures ??= [];
      output.failures.push({ runIndex, failures: record.failures });
    }
  }
  output.summary = summarize(output.traversals);
  if (output.failures?.length) process.exitCode = 1;
  output.finishedAt = new Date().toISOString();
} catch (error) {
  saveError = error;
  output.failure = { message: error.message, stack: error.stack };
  output.finishedAt = new Date().toISOString();
  process.stderr.write(`History benchmark failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`Wrote history benchmark output to ${outputPath}\n`);
  } catch (error) {
    process.stderr.write(`Could not write history benchmark output: ${error.message}\n`);
    process.exitCode = 1;
  }
  if (temporaryRoot) await (await import("node:fs/promises")).rm(temporaryRoot, { recursive: true, force: true });
  if (saveError) process.stderr.write("Failure details were retained when the new output path was available.\n");
}

async function runTraversal({ runIndex, fixturePath, daemonPath, expectedOids, temporaryRoot }) {
  const record = { runIndex, pageCount: 0, pages: [], cacheObservations: [], failures: [], timings: {}, processTree: null };
  const appData = join(temporaryRoot, `run-${runIndex}-data`);
  await mkdir(appData, { recursive: true });
  const client = new HistoryDaemonClient(daemonPath, { cwd: root, env: createDaemonEnvironment(appData) });
  let sampler;
  let openedAt;
  let traversalStarted;
  let offset = 0;
  let cursor = null;
  let firstCursor = null;
  let deepCursor = null;
  let lastCursor = null;
  const targetCursors = new Map();
  let session;
  try {
    sampler = new ProcessTreeSampler(client.child.pid, 100);
    record.core = await client.start();
    sampler.start();
    await sampler.sampleNow();
    const opened = await client.open(fixturePath);
    session = projectSession(opened);
    if (!session) throw new Error("openRepository did not return repositorySession");
    openedAt = performance.now();
    traversalStarted = openedAt;
    while (true) {
      const requestedCursor = cursor;
      const startedAt = performance.now();
      const response = await client.readPage(session, requestedCursor, 200, 60_000);
      const page = projectPage(response);
      const completedAt = performance.now();
      if (page.offset !== offset) throw new Error(`Page offset ${page.offset}, expected ${offset}`);
      if (page.pageSize !== 200) throw new Error(`Page size ${page.pageSize}, expected 200`);
      const expected = expectedOids.slice(offset, offset + page.commits.length);
      const actual = page.commits.map(commit => commit.oid);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`OID sequence mismatch at offset ${offset}`);
      if (page.commits.length !== Math.min(200, expectedOids.length - offset)) throw new Error(`Unexpected page length at offset ${offset}`);
      if ((page.nextCursor !== null) !== page.hasMore) throw new Error(`hasMore/nextCursor mismatch at offset ${offset}`);
      const pageRecord = {
        offset,
        requestedCursor,
        cursor: page.cursor,
        nextCursor: page.nextCursor,
        commitCount: page.commits.length,
        hasMore: page.hasMore,
        requestWallMs: completedAt - startedAt,
        cumulativeToPageMs: completedAt - traversalStarted,
        processTreeSampleCount: sampler.samples.length,
      };
      record.pages.push(pageRecord);
      record.pageCount += 1;
      if (offset === 0) firstCursor = page.cursor;
      if ([0, 10_000, 50_000, 90_000].includes(offset)) {
        record.targets ??= {};
        record.targets[offset] = { ...pageRecord, oidFirst: actual[0] ?? null, oidLast: actual.at(-1) ?? null };
        targetCursors.set(offset, page.cursor);
        if (offset === 90_000) deepCursor = page.cursor;
      }
      lastCursor = page.cursor;
      offset += page.commits.length;
      cursor = page.nextCursor;
      if (cursor === null) break;
      if (record.pageCount > 1000) throw new Error("Pagination exceeded 1000 pages");
    }
    record.timings.completeTraversalMs = performance.now() - traversalStarted;
    if (offset !== expectedOids.length) throw new Error(`Traversal ended at ${offset}, expected ${expectedOids.length}`);

    const lastHitStarted = performance.now();
    const lastHit = projectPage(await client.readPage(session, lastCursor, 200, 60_000));
    if (lastHit.offset !== 99_800 || JSON.stringify(lastHit.commits.map(commit => commit.oid)) !== JSON.stringify(expectedOids.slice(99_800))) throw new Error("immediate cached last-page replay mismatch");
    record.cacheObservations.push({ kind: "immediate-hit", offset: 99_800, cursor: lastCursor, wallMs: performance.now() - lastHitStarted, commitCount: lastHit.commits.length });

    const replayCases = [
      { kind: "evicted-first-page", offset: 0, cursor: firstCursor },
      { kind: "deep-cursor-after-rewind", offset: 90_000, cursor: deepCursor },
    ];
    for (const item of replayCases) {
      const startedAt = performance.now();
      const page = projectPage(await client.readPage(session, item.cursor, 200, 120_000));
      const completedAt = performance.now();
      if (page.offset !== item.offset) throw new Error(`${item.kind} returned offset ${page.offset}`);
      if (JSON.stringify(page.commits.map(commit => commit.oid)) !== JSON.stringify(expectedOids.slice(item.offset, item.offset + 200))) throw new Error(`${item.kind} OID mismatch`);
      record.cacheObservations.push({ kind: item.kind, offset: item.offset, cursor: item.cursor, wallMs: completedAt - startedAt, commitCount: page.commits.length });
    }
    const deepHitStarted = performance.now();
    const deepHit = projectPage(await client.readPage(session, deepCursor, 200, 60_000));
    record.cacheObservations.push({ kind: "deep-hit-after-replay", offset: deepHit.offset, cursor: deepCursor, wallMs: performance.now() - deepHitStarted, commitCount: deepHit.commits.length });
    if (deepHit.offset !== 90_000 || JSON.stringify(deepHit.commits.map(commit => commit.oid)) !== JSON.stringify(expectedOids.slice(90_000, 90_200))) throw new Error("deep cursor failed after lower-offset replay");
    for (const targetOffset of [0, 10_000, 50_000, 90_000]) {
      const targetCursor = targetCursors.get(targetOffset);
      const startedAt = performance.now();
      const repeated = projectPage(await client.readPage(session, targetCursor, 200, 60_000));
      if (repeated.offset !== targetOffset || JSON.stringify(repeated.commits.map(commit => commit.oid)) !== JSON.stringify(expectedOids.slice(targetOffset, targetOffset + 200))) throw new Error(`replayed cursor mismatch at ${targetOffset}`);
      record.cacheObservations.push({ kind: "target-replay", offset: targetOffset, cursor: targetCursor, wallMs: performance.now() - startedAt, commitCount: repeated.commits.length });
    }
  } catch (error) {
    record.failures.push(error.message);
  } finally {
    if (session) await client.close(session).catch(error => record.failures.push(`close session: ${error.message}`));
    if (sampler) await sampler.sampleNow().catch(() => {});
    const exitResult = await client.stop().catch(error => {
      record.failures.push(`daemon shutdown: ${error.message}`);
      return null;
    });
    const observedIdentities = sampler ? [...sampler.identities.values()] : [];
    const processExitBeforeCleanup = await waitForObservedExit(observedIdentities, 500);
    let processCleanup = { signaled: [], remaining: processExitBeforeCleanup.remaining };
    if (processExitBeforeCleanup.remaining.length > 0) {
      processCleanup = await cleanupObservedProcesses(processExitBeforeCleanup.remaining, 2000);
      record.failures.push("observed daemon descendants remained after normal shutdown and required cleanup");
    }
    if (sampler) await sampler.stop();
    const sampleRecord = sampler?.toRecord() ?? { samples: [], processIdentities: [], processes: [], cpuSecondsEstimate: null, sampleErrors: [] };
    record.processTree = {
      rootPid: client.child.pid,
      rootObserved: sampleRecord.processIdentities.some(identity => identity.pid === client.child.pid),
      sampleCount: sampleRecord.samples.length,
      samples: sampleRecord.samples,
      processIdentities: sampleRecord.processIdentities,
      aggregatedProcesses: sampleRecord.processes,
      cpuSecondsEstimate: sampleRecord.cpuSecondsEstimate,
      sampleErrors: sampleRecord.sampleErrors,
      peakTreeRssKB: sampleRecord.samples.reduce((peak, sample) => Math.max(peak, sample.tree.reduce((sum, entry) => sum + entry.rssKB, 0)), 0),
      sampleIntervalMs: 100,
    };
    record.exitResult = exitResult;
    record.processExitBeforeCleanup = processExitBeforeCleanup;
    record.processCleanup = processCleanup;
    if (!record.processTree.rootObserved) record.failures.push("process sampler never observed the daemon root PID");
    if (record.processTree.sampleErrors.length > 0) record.failures.push(`process sampler had ${record.processTree.sampleErrors.length} error(s)`);
    record.timings.openToLastPageMs = openedAt && traversalStarted && record.pages.length ? record.pages.at(-1).cumulativeToPageMs : null;
  }
  return record;
}

async function readProcessTable() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,time=,lstart=,command="], { timeout: 2000, maxBuffer: 16 * 1024 * 1024 });
  const rows = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.{24})\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), parentPid: Number(match[2]), rssKB: Number(match[3]), cpuPercent: Number(match[4]), cpuTime: match[5], cpuSeconds: parseCpuTime(match[5]), started: match[6].trim(), command: match[7].trim() });
  }
  return rows;
}

async function waitForObservedExit(identities, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let remaining = [];
  do {
    const current = await readProcessTable();
    remaining = identities.filter(identity => current.some(item => item.pid === identity.pid && item.started === identity.started));
    if (remaining.length === 0) return { allExited: true, remaining: [] };
    if (performance.now() >= deadline) break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  } while (performance.now() < deadline);
  return { allExited: false, remaining: remaining.map(({ pid, started, command, classification }) => ({ pid, started, command, classification })) };
}

async function cleanupObservedProcesses(identities, timeoutMs) {
  const signaled = [];
  for (const identity of identities) {
    const current = await readProcessTable();
    if (!current.some(item => item.pid === identity.pid && item.started === identity.started)) continue;
    try { process.kill(identity.pid, "SIGTERM"); signaled.push({ pid: identity.pid, signal: "SIGTERM" }); }
    catch (error) { if (error.code !== "ESRCH") signaled.push({ pid: identity.pid, signal: "SIGTERM", error: error.message }); }
  }
  let exit = await waitForObservedExit(identities, Math.min(timeoutMs, 750));
  if (!exit.allExited) {
    for (const identity of exit.remaining) {
      const current = await readProcessTable();
      if (!current.some(item => item.pid === identity.pid && item.started === identity.started)) continue;
      try { process.kill(identity.pid, "SIGKILL"); signaled.push({ pid: identity.pid, signal: "SIGKILL" }); }
      catch (error) { if (error.code !== "ESRCH") signaled.push({ pid: identity.pid, signal: "SIGKILL", error: error.message }); }
    }
    exit = await waitForObservedExit(identities, timeoutMs);
  }
  return { signaled, remaining: exit.remaining, allExited: exit.allExited };
}

function parseCpuTime(value) {
  const days = /^(\d+)-(.*)$/.exec(value);
  if (days) return Number(days[1]) * 86_400 + parseCpuTime(days[2]);
  const parts = value.split(":");
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  return 0;
}

async function inspectFixture(repository, gitExecutable) {
  const [head, count, format, pack, version] = await Promise.all([
    gitText(gitExecutable, repository, ["rev-parse", "--verify", "HEAD"]),
    gitText(gitExecutable, repository, ["rev-list", "--count", "HEAD"]),
    gitText(gitExecutable, repository, ["rev-parse", "--show-object-format"]),
    gitText(gitExecutable, repository, ["count-objects", "-v"]),
    execFileAsync(gitExecutable, ["--version"], { env: cleanEnvironment(), timeout: 3000 }).then(result => result.stdout.trim()),
  ]);
  return { headOid: head.trim(), commitCount: Number(count.trim()), objectFormat: format.trim(), packState: parsePackState(pack), gitVersion: version };
}

function parsePackState(text) {
  const result = {};
  for (const line of text.split("\n")) {
    const match = /^(count|size|in-pack|packs|size-pack|prune-packable|garbage|size-garbage):\s+(\d+)/.exec(line);
    if (match) result[match[1]] = Number(match[2]);
  }
  return result;
}

async function gitRevList(repository, headOid, gitExecutable) {
  const { stdout } = await execFileAsync(gitExecutable, ["--no-lazy-fetch", "--no-pager", "--no-replace-objects", "--no-optional-locks", "-c", "core.commitGraph=false", "-C", repository, "rev-list", "--topo-order", headOid, "--"], { env: cleanEnvironment(), timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim().split("\n").filter(Boolean);
}

async function gitText(gitExecutable, repository, args) {
  const { stdout } = await execFileAsync(gitExecutable, ["--no-lazy-fetch", "--no-pager", "--no-replace-objects", "--no-optional-locks", "-C", repository, ...args], { env: cleanEnvironment(), timeout: 30_000, maxBuffer: 1024 * 1024 });
  return stdout;
}

async function collectEnvironment() {
  const fields = await Promise.all([
    execFileAsync("sw_vers", ["-productVersion"], { timeout: 3000 }).then(result => result.stdout.trim()),
    execFileAsync("sysctl", ["-n", "hw.model"], { timeout: 3000 }).then(result => result.stdout.trim()),
    execFileAsync("sysctl", ["-n", "hw.physicalcpu"], { timeout: 3000 }).then(result => Number(result.stdout.trim())),
    execFileAsync("sysctl", ["-n", "hw.logicalcpu"], { timeout: 3000 }).then(result => Number(result.stdout.trim())),
    execFileAsync("sysctl", ["-n", "hw.memsize"], { timeout: 3000 }).then(result => Number(result.stdout.trim())),
  ]);
  return { platform: process.platform, macOS: fields[0], model: fields[1], physicalCpuCount: fields[2], logicalCpuCount: fields[3], memoryBytes: fields[4], node: process.version };
}

function summarize(traversals) {
  const successful = traversals.filter(item => item.failures.length === 0);
  const complete = successful.map(item => item.timings.completeTraversalMs).filter(Number.isFinite).sort((a, b) => a - b);
  const offsets = {};
  for (const offset of [0, 10_000, 50_000, 90_000]) {
    const values = successful.map(item => item.targets?.[offset]?.requestWallMs).filter(Number.isFinite).sort((a, b) => a - b);
    offsets[offset] = { valuesMs: values, medianMs: median(values), p95Ms: nearestRank(values, 0.95) };
  }
  return { successfulTraversals: successful.length, failedTraversals: traversals.length - successful.length, completeTraversalMs: { values: complete, median: median(complete), p95: nearestRank(complete, 0.95) }, targetPageWallMs: offsets, percentileMethod: "nearest-rank p95" };
}

function parseArgs(argv) {
  const result = { repository: null, output: null, daemon: null, runs: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repository") result.repository = argv[++index];
    else if (argument.startsWith("--repository=")) result.repository = argument.slice(13);
    else if (argument === "--output") result.output = argv[++index];
    else if (argument.startsWith("--output=")) result.output = argument.slice(9);
    else if (argument === "--daemon") result.daemon = argv[++index];
    else if (argument.startsWith("--daemon=")) result.daemon = argument.slice(9);
    else if (argument === "--runs") result.runs = Number(argv[++index]);
    else if (argument.startsWith("--runs=")) result.runs = Number(argument.slice(7));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(result.runs) || result.runs < 1 || result.runs > 3) throw new Error("--runs must be between 1 and 3");
  return result;
}

async function findGitExecutable() {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, process.platform === "win32" ? "git.exe" : "git");
    try { await access(candidate); return resolve(candidate); } catch {}
  }
  throw new Error("Could not find Git in PATH");
}

async function ensureOutputDoesNotExist(path) {
  try { await access(path); throw new Error(`Refusing to overwrite output ${path}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function sha256File(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function cleanEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}
function median(values) { if (!values.length) return null; const mid = Math.floor(values.length / 2); return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2; }
function nearestRank(values, percentile) { return values.length ? values[Math.max(0, Math.ceil(percentile * values.length) - 1)] : null; }
