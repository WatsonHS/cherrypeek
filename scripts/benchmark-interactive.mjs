#!/usr/bin/env node
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import os from "node:os";
import { performance } from "node:perf_hooks";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const appEntry = join(root, "apps/desktop/dist/main/index.cjs");
const daemonPath = join(root, "apps/desktop/dist/resources/commitscope-daemon");
const electronPath = require("electron");
const output = { schemaVersion: 1, benchmark: "p4-01-interactive", startedAt: new Date().toISOString(), measurements: {}, failures: [] };
let app;
let page;
let sampler;

async function main() {
try {
  if (process.platform !== "darwin") throw new Error("Interactive process-tree benchmark requires macOS ps");
  for (const path of [args.repository, args.profile]) if (!path.startsWith("/")) throw new Error("--repository and --profile must be absolute paths");
  if (!args.output.startsWith("/")) throw new Error("--output must be an absolute path");
  await Promise.all([access(appEntry), access(daemonPath), access(args.repository)]);
  await ensureMissing(args.output);
  const [gitHead, gitDirty, fixtureDates, sourceHead, sourceDirty] = await Promise.all([
    git(args.repository, ["rev-parse", "HEAD"]), git(args.repository, ["status", "--porcelain"]), deepDates(args.repository),
    git(root, ["rev-parse", "HEAD"]), git(root, ["status", "--porcelain"]),
  ]);
  const profileState = await inspectProfile(args.profile);
  output.input = { repository: args.repository, fixtureHead: gitHead.trim(), fixtureCommitCount: Number((await git(args.repository, ["rev-list", "--count", "HEAD"])).trim()), profile: args.profile, profileState, idleMs: args.idleMs, queryRounds: args.queries };
  output.build = { sourceHead: sourceHead.trim(), sourceDirty: Boolean(sourceDirty.trim()), sourceDirtySummary: sourceDirty.trim().split("\n").slice(0, 30), bundledDaemonSha256: await hashFile(daemonPath), appEntrySha256: await hashFile(appEntry), electronPackageVersion: require("electron/package.json").version };
  output.environment = { platform: process.platform, macOS: await command("sw_vers", ["-productVersion"]), model: await command("sysctl", ["-n", "hw.model"]), cpuCount: os.cpus().length, memoryBytes: os.totalmem(), node: process.version, processSampleIntervalMs: 500, processSamplerLimit: "ps snapshots can miss short-lived Git children" };
  const started = performance.now();
  sampler = new ProcessSampler(500);
  sampler.start();
  const startupMark = sampler.mark();
  app = await electron.launch({ executablePath: electronPath, args: [appEntry, `--repository=${args.repository}`, `--user-data-dir=${args.profile}`], cwd: root, chromiumSandbox: true, timeout: 30_000, env: launchEnv() });
  sampler.setRoot(app.process().pid);
  page = await app.firstWindow();
  await page.bringToFront();
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-state"]')?.dataset.state === "ready", null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const list = document.querySelector('[aria-label="提交"]') ?? document.querySelector('[aria-label="提交列表"] [role="listbox"]');
    return list && Number(list.dataset.loadedCount) >= 200 && list.querySelector('[data-testid="commit-row"]');
  }, null, { timeout: 60_000 });
  output.measurements.startupToFirst200Ms = Math.round(performance.now() - started);
  process.stdout.write(`First 200 ready: ${output.measurements.startupToFirst200Ms} ms\n`);
  output.measurements.startupProcessTree = sampler.snapshot(startupMark, "Electron launch through first 200 history summaries");
  output.measurements.windowAtFirst200 = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.isVisible());
    if (!window) return { visible: false };
    const bounds = window.getBounds();
    return { visible: window.isVisible(), focused: window.isFocused(), bounds, contentBounds: window.getContentBounds(), display: screen.getDisplayMatching(bounds).bounds };
  });
  const indexMark = sampler.mark();
  const indexStart = performance.now();
  output.measurements.index = await waitForCompleteIndex(page, 180_000);
  output.measurements.index.waitMs = Math.round(performance.now() - indexStart);
  process.stdout.write(`Index complete: ${output.measurements.index.waitMs} ms wait\n`);
  output.input.profileState.initialIndexStatus = output.measurements.index.initial;
  output.measurements.indexProcessTree = sampler.snapshot(indexMark, "automatic metadata index until complete");
  await page.locator('[data-testid="commit-row"][data-oid]').first().click();
  output.measurements.detailSettleProcessTree = await sampler.measure(async () => page.waitForTimeout(2_000), "selected commit details settled or 2 second static wait");
  output.measurements.idle = await sampler.measure(async () => page.waitForTimeout(args.idleMs), "stable visible foreground window after metadata index complete");
  output.measurements.mainMemory = await app.evaluate(() => process.memoryUsage());
  output.measurements.rendererMemory = await page.evaluate(() => performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null);
  const oid = await page.locator('[data-testid="commit-row"][data-oid]').first().getAttribute("data-oid");
  if (!oid) throw new Error("The first visible history row has no OID");
  const datePoints = fixtureDates.map(timestamp => timestamp + 1);
  output.measurements.queryContract = "Serial page.evaluate calls; duration is end-to-end IPC request/response time, excludes rendering/paint. Process sampling continues. Errors are recorded as failures, never counted as successful results.";
  output.measurements.queries = [];
  const queryMark = sampler.mark();
  for (let round = 0; round < args.queries; round += 1) {
    const cases = [
      { name: "search-hit", kind: "search", params: searchParams({ message: "graph-" }) },
      { name: "search-miss", kind: "search", params: searchParams({ message: "p4-01-no-such-message-7f2a" }) },
      { name: "search-oid-prefix", kind: "search", params: searchParams({ oidPrefix: oid.slice(0, 10) }) },
      { name: "activity-default", kind: "activity", params: { query: searchParams({}).query } },
      ...datePoints.map((beforeTimestamp, index) => ({ name: `locate-date-deep-${index + 1}`, kind: "date", params: { beforeTimestamp, pageSize: 200 } })),
      { name: "branches-containing-visible-head", kind: "branches", params: { oid } },
    ];
    for (const query of cases) {
      const result = await invokeMeasured(page, query.kind, query.params);
      const record = { round: round + 1, name: query.name, params: query.params, ...result };
      output.measurements.queries.push(record);
      if (!record.success) output.failures.push({ stage: "query", ...record });
    }
  }
  output.measurements.queryProcessTree = sampler.snapshot(queryMark, "sequential interactive IPC queries");
} catch (error) {
  output.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  if (app) {
    try { await app.close(); } catch (error) { output.failures.push({ stage: "electron-close", message: error.message }); }
  }
  if (sampler) { await sampler.stop(); output.processTree = sampler.summary(); }
  output.finishedAt = new Date().toISOString();
  try { await mkdir(dirname(args.output), { recursive: true }); await writeFile(args.output, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" }); }
  catch (error) { process.stderr.write(`Cannot write output: ${error.message}\n`); process.exitCode = 1; }
  if (output.failure || output.failures.length) process.exitCode = 1;
  process.stdout.write(`Interactive benchmark evidence: ${args.output}\n`);
}
}

function parseArgs(argv) {
  const values = { idleMs: 15_000, queries: 3 };
  for (const item of argv) {
    const split = item.indexOf("=");
    if (split < 0) throw new Error(`Expected --name=value, received ${item}`);
    const key = item.slice(2, split), value = item.slice(split + 1);
    if (key === "repository" || key === "profile" || key === "output") values[key] = value;
    else if (key === "idle-ms") values.idleMs = Number(value);
    else if (key === "queries") values.queries = Number(value);
    else throw new Error(`Unknown argument ${key}`);
  }
  if (!values.repository || !values.profile || !values.output || !Number.isInteger(values.idleMs) || values.idleMs < 0 || !Number.isInteger(values.queries) || values.queries < 1 || values.queries > 3) throw new Error("Usage: node scripts/benchmark-interactive.mjs --repository=/abs/repo --profile=/abs/app-data --output=/abs/new.json [--idle-ms=15000] [--queries=3]");
  return values;
}
function searchParams(overrides) { return { anchorOid: null, cursor: null, pageSize: 200, query: { authors: [], caseSensitive: false, committers: [], fromTimestamp: null, message: "", oidPrefix: "", path: null, timeField: "committer", timeZone: "UTC", toTimestamp: null, ...overrides } }; }
async function invokeMeasured(target, kind, params) {
  const started = performance.now(); let retries = 0; let firstWaitMs = 0;
  while (true) {
    const attempt = await target.evaluate(async ({ kind, params }) => {
      const start = performance.now();
      try {
        const api = window.commitScope;
        const response = kind === "search" ? await api.searchCommits(params) : kind === "activity" ? await api.getActivityStats(params) : kind === "date" ? await api.locateHistoryDate(params.beforeTimestamp, params.pageSize) : await api.branchesContaining(params);
        return { elapsedMs: performance.now() - start, response };
      } catch (error) { return { elapsedMs: performance.now() - start, thrown: String(error?.message ?? error) }; }
    }, { kind, params });
    const response = attempt.response;
    const error = response?.ok === false ? response.error : attempt.thrown ? { message: attempt.thrown } : response?.ok !== true ? { message: "IPC response did not contain an ok result" } : null;
    if (error?.code === "BUSY" && retries < 4) { if (!retries) firstWaitMs = Math.round(performance.now() - started); retries += 1; await new Promise(resolveSleep => setTimeout(resolveSleep, 250 * retries)); continue; }
    const value = response?.ok === true ? response.value : null;
    return { success: !error, latencyMs: Math.round((performance.now() - started) * 100) / 100, successfulAttemptIpcMs: !error ? Math.round(attempt.elapsedMs * 100) / 100 : null, attempts: retries + 1, firstWaitMs, error, result: value ? summarizeResult(kind, value) : null };
  }
}
function summarizeResult(kind, value) {
  const digest = input => createHash("sha256").update(JSON.stringify(input)).digest("hex");
  if (kind === "search") return { matchedCount: value.matchedCount, pageOffset: value.pageOffset, oids: value.commits.slice(0, 5).map(row => row.oid), rowsSha256: digest(value.commits), resultVersion: value.resultVersion, indexState: value.index?.state };
  if (kind === "activity") return { matchedCount: value.matchedCount, days: value.days.length, authors: value.authors.length, coverage: value.coverage, indexState: value.index?.state };
  if (kind === "date") return { pageOffset: value.offset, oids: value.commits.slice(0, 5).map(row => row.oid), rowsSha256: digest(value.commits), selectedPageCount: value.commits.length };
  return { oid: value.oid, branchCount: value.branches.length, complete: value.complete, refsTruncated: value.refsTruncated, branches: value.branches.slice(0, 8).map(ref => ref.name) };
}
async function waitForCompleteIndex(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs; let last = null, initial = null;
  while (Date.now() < deadline) {
    const result = await target.evaluate(() => window.commitScope.getMetadataIndexStatus());
    if (result?.ok) { last = result.value; initial ??= last; if (last.state === "complete") return { initial, final: last }; if (["failed", "unavailable", "quotaLimited", "cancelled"].includes(last.state)) throw new Error(`Metadata index ended in ${last.state}: ${JSON.stringify(last.error)}`); }
    else if (!["BUSY", "CANCELLED", "STALE_CONTEXT"].includes(result?.error?.code)) throw new Error(`Metadata index status unavailable: ${JSON.stringify(result?.error ?? result)}`);
    await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000));
  }
  throw new Error(`Metadata index did not complete within ${timeoutMs} ms; initial=${JSON.stringify(initial)} last=${JSON.stringify(last)}`);
}
async function deepDates(repository) { const values = await Promise.all([25_000, 50_000, 75_000].map(skip => git(repository, ["log", "--topo-order", "--format=%ct", "--skip", String(skip), "-n", "1", "HEAD"]))); return values.map(value => Number(value.trim())).filter(Number.isFinite); }
async function git(repository, args) { return (await exec("git", ["-C", repository, ...args], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: cleanGitEnv() })).stdout; }
async function command(file, args) { return (await exec(file, args, { timeout: 3000 })).stdout.trim(); }
function cleanGitEnv() { const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]; return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }; }
function launchEnv() { const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]; delete env.ELECTRON_RUN_AS_NODE; return env; }
async function hashFile(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function ensureMissing(path) { try { await access(path); throw new Error(`Refusing to overwrite existing output: ${path}`); } catch (error) { if (error.code !== "ENOENT") throw error; } }
async function inspectProfile(path) { try { const entries = await readdir(path); const indexes = await findIndexFiles(join(path, "repository-state")); return { existed: true, entryCount: entries.length, repositoryStateExists: entries.includes("repository-state"), indexFilesBeforeLaunch: indexes }; } catch (error) { if (error.code === "ENOENT") return { existed: false, entryCount: 0, indexFilesBeforeLaunch: [] }; throw error; } }
async function findIndexFiles(directory) { const found = []; const walk = async path => { let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; } for (const entry of entries) { const child = join(path, entry.name); if (entry.isDirectory()) await walk(child); else if (entry.name === "index.sqlite3") { const info = await stat(child); found.push({ path: child, sizeBytes: info.size }); } } }; await walk(directory); return found; }

class ProcessSampler {
  constructor(intervalMs) { this.intervalMs = intervalMs; this.rootPid = null; this.samples = []; this.cpu = new Map(); this.cpuDelta = 0; this.timer = null; this.pending = false; }
  setRoot(pid) { this.rootPid = pid; }
  mark() { return { sampleIndex: this.samples.length, cpuSeconds: this.cpuDelta, at: performance.now() }; }
  snapshot(mark, label) { return summarizeSamples(this.samples.slice(mark.sampleIndex), this.cpuDelta - mark.cpuSeconds, performance.now() - mark.at, label); }
  start() { this.timer = setInterval(() => void this.sample(), this.intervalMs); this.timer.unref(); void this.sample(); }
  async sample() {
    if (this.pending) return; this.pending = true;
    try {
      const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,rss=,time=,lstart=,command="], { timeout: 2500, maxBuffer: 16 * 1024 * 1024 });
      const table = stdout.split("\n").map(line => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.*)$/.exec(line); return m && { pid: +m[1], ppid: +m[2], rssKB: +m[3], cpuSeconds: cpuSeconds(m[4]), started: m[5].trim(), command: m[6].trim() }; }).filter(Boolean);
      const byParent = new Map(); for (const row of table) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
      const root = table.find(row => row.pid === this.rootPid); const tree = root ? [root] : []; const queue = root ? [root.pid] : [];
      while (queue.length) for (const child of byParent.get(queue.pop()) ?? []) { tree.push(child); queue.push(child.pid); }
      for (const row of tree) { const key = `${row.pid}:${row.started}`; this.cpuDelta += Math.max(0, row.cpuSeconds - (this.cpu.get(key) ?? 0)); this.cpu.set(key, row.cpuSeconds); row.role = role(row.command); }
      this.samples.push({ at: performance.now(), tree });
    } catch (error) { this.errors ??= []; this.errors.push({ message: error.message }); }
    finally { this.pending = false; }
  }
  async measure(action, label) { const mark = this.mark(); await action(); await this.sample(); return this.snapshot(mark, label); }
  async stop() { clearInterval(this.timer); if (this.pending) await new Promise(resolveSleep => setTimeout(resolveSleep, 50)); await this.sample(); }
  summary() { return { intervalMs: this.intervalMs, samplingNote: "A 500ms ps cadence may miss short-lived Git children; cumulative CPU is the sum of observed per-process CPU deltas.", samples: this.samples.length, sampleErrors: this.errors ?? [], processes: [...new Map(this.samples.flatMap(sample => sample.tree.map(row => [`${row.pid}:${row.started}`, { pid: row.pid, started: row.started, role: row.role, command: row.command }]))).values()] }; }
}
function summarizeSamples(samples, cpuDeltaSeconds, durationMs, scope) { const totals = samples.map(sample => sample.tree.reduce((sum, row) => sum + row.rssKB, 0)).sort((a,b)=>a-b); const roles = {}; for (const name of ["main","renderer","gpu","utility","rust","git","other"]) { const values = samples.map(sample => sample.tree.filter(row => row.role === name).reduce((sum,row)=>sum+row.rssKB,0)).sort((a,b)=>a-b); roles[name] = { peakRssKB: Math.max(0,...values), medianRssKB: median(values) }; } return { scope, durationMs: Math.round(durationMs), sampleCount: samples.length, peakTreeRssKB: Math.max(0,...totals), medianTreeRssKB: median(totals), observedCpuDeltaSeconds: Math.round(cpuDeltaSeconds*1000)/1000, roleRss: roles, rssSamplesKB: totals }; }
function role(command) { const text = command.toLowerCase(); if (text.includes("commitscope-daemon")) return "rust"; if (/(^|\/)git(\s|$)|\(git\)/.test(text)) return "git"; if (text.includes("--type=gpu-process")) return "gpu"; if (text.includes("--type=utility")) return "utility"; if (text.includes("--type=renderer")) return "renderer"; if (text.includes("electron")) return "main"; return "other"; }
function median(values) { return values.length ? values[Math.floor((values.length - 1) / 2)] : 0; }
function cpuSeconds(value) { const p = value.split(":").map(Number); return p.length === 3 ? p[0]*3600+p[1]*60+p[2] : p.length === 2 ? p[0]*60+p[1] : 0; }

await main();
