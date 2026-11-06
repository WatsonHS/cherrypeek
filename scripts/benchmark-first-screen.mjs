#!/usr/bin/env node
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { aggregateProcessSamples, classifyProcess, mergeProcessObservation } from "./process-tree-observation.mjs";

const execFileAsync = promisify((await import("node:child_process")).execFile);
const require = createRequire(import.meta.url);
const args = parseArgs(process.argv.slice(2));
const root = resolve(import.meta.dirname, "..");
const appEntry = join(root, "apps/desktop/dist/main/index.cjs");
const daemonBundle = join(root, "apps/desktop/dist/resources/commitscope-daemon");
const electronBinary = require("electron");
const electronVersion = require("electron/package.json").version;

if (process.platform !== "darwin") throw new Error("benchmark:first-screen currently requires macOS for whole-process-tree ps sampling.");
if (args.runs < 1 || args.runs > 100) throw new Error("--runs must be between 1 and 100");
if (args.rows !== 200) throw new Error("P0-03 first-screen benchmark fixes rows at 200");
await access(appEntry);
await access(daemonBundle);
await access(args.repository);
if (!args.output) throw new Error("Usage: node scripts/benchmark-first-screen.mjs --repository=<100k-directory> --runs=10 --output=<new-json-path>");

const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-first-screen-"));
const host = await collectHostInfo();
const document = {
  schemaVersion: 1,
  benchmark: "p0-03-first-screen",
  startedAt: new Date().toISOString(),
  codeVersion: await currentGitRevision(root),
  artifacts: await describeBuildArtifacts(root, appEntry, daemonBundle),
  repository: resolve(args.repository),
  targetRows: args.rows,
  requestedRuns: args.runs,
  expectedFirstOid: (await execFileAsync("git", ["-C", resolve(args.repository), "log", "--topo-order", "--max-count=1", "--format=%H", "HEAD"], { timeout: 5000, env: cleanGitEnvironment() })).stdout.trim(),
  environment: {
    platform: process.platform,
    macOS: host,
    node: process.version,
    electron: electronVersion,
    samplingIntervalMs: 100,
    cacheConditions: {
      newUserDataDirectoryEachRun: true,
      osPageCacheCleared: false,
      osPageCacheControlled: false,
      applicationIndexCacheImplemented: false,
    },
  },
  measurement: {
    start: "Node wall clock immediately before Playwright Electron launch",
    completion: "200 real commit rows are present, row 1 is selected, and two animation frames after selection have completed",
    includesAutomationLaunchOverhead: true,
    processMetrics: "Sampled RSS and ps cumulative CPU time for the Electron PID and all observed descendants; RSS sum may double-count shared pages.",
    samplingStartsBeforeElectronLaunch: true,
    limitations: [
      "OS page cache is uncontrolled and is not cleared.",
      "100 ms process sampling can miss short-lived Git processes and undercount their CPU/RSS peaks.",
      "CPU seconds are derived from cumulative ps snapshots and are approximate for processes that start or exit between samples.",
      "The 10-run development baseline does not establish release-package or long-term performance.",
    ],
  },
  runs: [],
};

async function executeBenchmark() {
  try {
    for (let runIndex = 1; runIndex <= args.runs; runIndex += 1) {
      try {
        const run = await runOne(runIndex, temporaryRoot);
        document.runs.push(run);
        process.stdout.write(`run ${runIndex}/${args.runs}: ${run.firstSelectableRowMs.toFixed(1)} ms, ${run.sampledPeakTreeRssKB} KiB sampled process-tree RSS\n`);
      } catch (error) {
        if (error.runRecord) document.runs.push(error.runRecord);
        throw error;
      }
    }
    document.summary = summarize(document.runs);
    document.finishedAt = new Date().toISOString();
    await writeJsonSafely(args.output, document);
    process.stdout.write(`Wrote ${args.runs}-run baseline to ${resolve(args.output)}\n`);
  } catch (error) {
    document.failure = { message: error.message, stack: error.stack };
    document.finishedAt = new Date().toISOString();
    document.summary = document.runs.length > 0 ? summarize(document.runs) : null;
    await writeJsonSafely(args.output, document).catch(writeError => {
      process.stderr.write(`Could not save partial benchmark JSON: ${writeError.message}\n`);
    });
    process.stderr.write(`Benchmark failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  let repository;
  let output;
  let runs = 10;
  let rows = 200;
  for (const argument of argv) {
    if (argument.startsWith("--repository=")) repository = argument.slice("--repository=".length);
    else if (argument.startsWith("--output=")) output = argument.slice("--output=".length);
    else if (argument.startsWith("--runs=")) runs = Number(argument.slice("--runs=".length));
    else if (argument.startsWith("--rows=")) rows = Number(argument.slice("--rows=".length));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!repository || !repository.startsWith("/")) throw new Error("--repository must be an absolute path");
  if (output && !output.trim()) throw new Error("--output must not be empty");
  if (!Number.isInteger(runs) || !Number.isInteger(rows)) throw new Error("--runs and --rows must be integers");
  return { repository, output, runs, rows };
}

async function runOne(runIndex, temporaryRoot) {
  const profile = join(temporaryRoot, `user-data-${String(runIndex).padStart(2, "02")}`);
  await mkdir(profile, { recursive: false });
  const started = performance.now();
  const sampler = new ProcessTreeSampler(null, started, 100, profile, appEntry);
  sampler.start();
  let electronApp;
  let page;
  let firstRowOid;
  let elapsed;
  let electronRuntime;
  let runFailure;
  let forcedCleanup = false;
  try {
    electronApp = await withTimeout(electron.launch({
      executablePath: electronBinary,
      args: [appEntry, `--repository=${resolve(args.repository)}`, `--user-data-dir=${profile}`],
      cwd: root,
      chromiumSandbox: true,
      timeout: 30_000,
      env: sanitizedLaunchEnvironment(),
    }), 35_000, "Electron launch");
    sampler.setRootPid(electronApp.process().pid);
    electronRuntime = await electronApp.evaluate(() => ({ node: process.versions.node, electron: process.versions.electron, chrome: process.versions.chrome }));
    page = await withTimeout(electronApp.firstWindow(), 15_000, "Electron window");
    await withTimeout(page.waitForSelector('[data-testid="preview-state"][data-state="ready"]'), 30_000, "ready preview state");
    const rows = await page.locator('[data-testid="commit-row"]').count();
    if (rows !== args.rows) throw new Error(`Expected ${args.rows} commit rows, saw ${rows}`);
    const firstRow = page.locator('[data-testid="commit-row"]').first();
    firstRowOid = await firstRow.getAttribute("data-oid");
    if (!firstRowOid) throw new Error("The first rendered commit row has no data-oid");
    if (firstRowOid !== document.expectedFirstOid) throw new Error(`First visible OID ${firstRowOid} does not match independent Git HEAD ${document.expectedFirstOid}`);
    await firstRow.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="commit-row"][aria-selected="true"]') !== null);
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    elapsed = performance.now() - started;
  } catch (error) {
    runFailure = error;
  } finally {
    if (electronApp) {
      try { await withTimeout(electronApp.close(), 10_000, "Electron close"); }
      catch (error) {
        forcedCleanup = true;
        runFailure ??= error;
        electronApp.process().kill("SIGKILL");
      }
    }
    await sampler.stop();
  }
  let processExit = await waitForCapturedProcessesToExit(sampler.processIdentities, 5000);
  if (!processExit.allExited) {
    forcedCleanup = true;
    await terminateCapturedProcesses(sampler.processIdentities, processExit.live);
    processExit = await waitForCapturedProcessesToExit(sampler.processIdentities, 2000);
  }
  const record = sampler.toRunRecord({ runIndex, firstSelectableRowMs: elapsed ?? null, firstRowOid: firstRowOid ?? null, processExit, electronRuntime: electronRuntime ?? null, forcedCleanup, error: runFailure?.message ?? null });
  const requiredGroups = ["electron", "rust-daemon", "electron-renderer-or-helper"];
  const observedGroups = new Set(record.observedProcesses.map(processInfo => processInfo.classification));
  record.processCoverage = {
    mainElectronObserved: sampler.processIdentities.has(sampler.rootPid),
    rustDaemonObserved: observedGroups.has("rust-daemon"),
    rendererOrHelperObserved: observedGroups.has("electron-renderer-or-helper"),
    gitObserved: observedGroups.has("git"),
    requiredGroups,
  };
  if (!runFailure && !requiredGroups.every(group => observedGroups.has(group))) runFailure = new Error(`Process sampling did not observe required groups: ${requiredGroups.filter(group => !observedGroups.has(group)).join(", ")}`);
  if (forcedCleanup) runFailure ??= new Error("Electron required forced process cleanup; this run is not a successful measurement");
  if (!processExit.allExited) runFailure ??= new Error(`Captured process tree still has live processes after cleanup: ${processExit.live.map(entry => entry.pid).join(",")}`);
  if (runFailure) {
    record.error = runFailure.message;
    runFailure.runRecord = record;
    throw runFailure;
  }
  return record;
}

class ProcessTreeSampler {
  constructor(rootPid, startedAt, intervalMs, profile, appEntryPath) {
    this.rootPid = rootPid;
    this.startedAt = startedAt;
    this.intervalMs = intervalMs;
    this.profile = profile;
    this.appEntryPath = appEntryPath;
    this.timer = null;
    this.samplingPromise = null;
    this.samples = [];
    this.processIdentities = new Map();
    this.cpuByPid = new Map();
    this.cpuSecondsObserved = 0;
    this.sampleErrors = [];
  }

  start() {
    this.timer = setInterval(() => { void this.sample(); }, this.intervalMs);
    this.timer.unref();
    void this.sample();
  }

  setRootPid(pid) {
    this.rootPid = pid;
  }

  async sample() {
    if (this.samplingPromise) return this.samplingPromise;
    this.samplingPromise = this.#sampleOnce().finally(() => { this.samplingPromise = null; });
    return this.samplingPromise;
  }

  async #sampleOnce() {
    try {
      const allProcesses = await readProcessTable();
      if (!this.rootPid) {
        const profileFlag = `--user-data-dir=${this.profile}`;
        const candidate = allProcesses.find(entry => entry.command.includes(profileFlag) && entry.command.includes(this.appEntryPath));
        if (candidate) this.rootPid = candidate.pid;
      }
      const tree = collectDescendants(allProcesses, this.rootPid).map(processInfo => ({ ...processInfo, classification: classifyProcess(processInfo.command) }));
      const elapsedMs = performance.now() - this.startedAt;
      for (const processInfo of tree) {
        const priorCpu = this.cpuByPid.get(processInfo.pid);
        this.cpuSecondsObserved += Math.max(0, processInfo.cpuSeconds - (priorCpu ?? 0));
        this.cpuByPid.set(processInfo.pid, processInfo.cpuSeconds);
        const previous = this.processIdentities.get(processInfo.pid);
        this.processIdentities.set(processInfo.pid, mergeProcessObservation(previous, processInfo));
      }
      this.samples.push({ elapsedMs, rootPid: this.rootPid, tree });
    } catch (error) {
      this.sampleErrors.push({ elapsedMs: performance.now() - this.startedAt, message: error.message });
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.sample();
    if (this.samplingPromise) await this.samplingPromise;
  }

  toRunRecord({ runIndex, firstSelectableRowMs, firstRowOid, processExit, electronRuntime, forcedCleanup, error }) {
    const peak = this.samples.reduce((max, sample) => Math.max(max, sample.tree.reduce((sum, processInfo) => sum + processInfo.rssKB, 0)), 0);
    const perProcess = aggregateProcessSamples(this.samples);
    return {
      runIndex,
      firstSelectableRowMs,
      rowsVisible: args.rows,
      firstRowOid,
      electronRuntime,
      error,
      rootPid: this.rootPid,
      sampledPeakTreeRssKB: peak,
      cumulativeCpuSecondsBetweenSamplesEstimate: this.cpuSecondsObserved,
      observedProcesses: perProcess,
      processExit,
      forcedCleanup,
      sampleIntervalMs: this.intervalMs,
      samples: this.samples,
      sampleErrors: this.sampleErrors,
    };
  }
}

async function readProcessTable() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,time=,lstart=,command="], { timeout: 2000, maxBuffer: 16 * 1024 * 1024 });
  const processes = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.{24})\s+(.*)$/.exec(line);
    if (!match) continue;
    processes.push({ pid: Number(match[1]), parentPid: Number(match[2]), rssKB: Number(match[3]), cpuPercent: Number(match[4]), cpuTime: match[5], cpuSeconds: parseCpuTime(match[5]), started: match[6].trim(), command: match[7].trim() });
  }
  return processes;
}

function collectDescendants(processes, rootPid) {
  if (!rootPid) return [];
  const byParent = new Map();
  for (const entry of processes) {
    const list = byParent.get(entry.parentPid) ?? [];
    list.push(entry);
    byParent.set(entry.parentPid, list);
  }
  const result = [];
  const root = processes.find(entry => entry.pid === rootPid);
  if (root) result.push(root);
  const pending = [rootPid];
  const seen = new Set();
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

function parseCpuTime(value) {
  const parts = value.split(":");
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  const daysMatch = /^(\d+)-(.*)$/.exec(value);
  if (daysMatch) return Number(daysMatch[1]) * 86400 + parseCpuTime(daysMatch[2]);
  return 0;
}

async function waitForCapturedProcessesToExit(identities, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const live = [];
  do {
    live.length = 0;
    for (const identity of identities.values()) {
      const current = await processIdentity(identity.pid);
      if (current && current.started === identity.started) live.push({ ...identity, currentCommand: current.command });
    }
    if (live.length === 0) return { allExited: true, checkedPids: identities.size, live: [] };
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  } while (Date.now() < deadline);
  return { allExited: false, checkedPids: identities.size, live };
}

async function terminateCapturedProcesses(identities, live) {
  for (const processInfo of live) {
    const identity = identities.get(processInfo.pid);
    const current = await processIdentity(processInfo.pid);
    if (!identity || !current || current.started !== identity.started) continue;
    try { process.kill(processInfo.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  await new Promise(resolveSleep => setTimeout(resolveSleep, 500));
  for (const processInfo of live) {
    const identity = identities.get(processInfo.pid);
    const current = await processIdentity(processInfo.pid);
    if (!identity || !current || current.started !== identity.started) continue;
    try { process.kill(processInfo.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

async function processIdentity(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart=,command="], { timeout: 1500, maxBuffer: 4096 });
    const match = /^(.{24})\s+(.*)$/.exec(stdout.trimEnd());
    return match ? { started: match[1].trim(), command: match[2].trim() } : null;
  } catch {
    return null;
  }
}

async function collectHostInfo() {
  const [version, model, physical, logical, memory] = await Promise.all([
    execFileAsync("sw_vers", ["-productVersion"], { timeout: 3000 }).then(result => result.stdout.trim()),
    execFileAsync("sysctl", ["-n", "hw.model"], { timeout: 3000 }).then(result => result.stdout.trim()),
    execFileAsync("sysctl", ["-n", "hw.physicalcpu"], { timeout: 3000 }).then(result => Number(result.stdout.trim())),
    execFileAsync("sysctl", ["-n", "hw.logicalcpu"], { timeout: 3000 }).then(result => Number(result.stdout.trim())),
    execFileAsync("sysctl", ["-n", "hw.memsize"], { timeout: 3000 }).then(result => Number(result.stdout.trim())),
  ]);
  return { version, model, physicalCpuCount: physical, logicalCpuCount: logical, memoryBytes: memory, nodePlatform: os.platform(), nodeRelease: os.release() };
}

async function describeBuildArtifacts(projectRoot, entry, daemon) {
  const mainSha256 = await sha256File(entry);
  const daemonSha256 = await sha256File(daemon);
  const releasePath = join(projectRoot, "target/release/commitscope-daemon");
  const debugPath = join(projectRoot, "target/debug/commitscope-daemon");
  const releaseHash = await sha256File(releasePath).catch(() => null);
  const debugHash = await sha256File(debugPath).catch(() => null);
  const buildProfile = daemonSha256 === releaseHash ? "release" : daemonSha256 === debugHash ? "debug" : "unknown";
  return {
    desktopMainPath: entry,
    desktopMainSha256: mainSha256,
    daemonPath: daemon,
    daemonSha256,
    buildProfile,
    embeddedElectronNodeVersion: "measured from process.versions inside the running Electron main process for every run",
  };
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function currentGitRevision(cwd) {
  try { return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, timeout: 2000, env: cleanGitEnvironment() })).stdout.trim(); }
  catch { return "uncommitted-or-unavailable"; }
}

function cleanGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}

function sanitizedLaunchEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function summarize(runs) {
  const validRuns = runs.filter(run => !run.error && Number.isFinite(run.firstSelectableRowMs));
  const values = validRuns.map(run => run.firstSelectableRowMs).sort((a, b) => a - b);
  const rss = validRuns.map(run => run.sampledPeakTreeRssKB).sort((a, b) => a - b);
  return {
    runCount: values.length,
    failedRuns: runs.length - values.length,
    p95Method: "nearest-rank",
    firstSelectableRowMs: { values: validRuns.map(run => run.firstSelectableRowMs), median: median(values), p95: percentileNearestRank(values, 0.95) },
    sampledPeakTreeRssKB: { values: validRuns.map(run => run.sampledPeakTreeRssKB), median: median(rss), p95: percentileNearestRank(rss, 0.95) },
    cumulativeCpuSecondsBetweenSamplesEstimate: validRuns.map(run => run.cumulativeCpuSecondsBetweenSamplesEstimate),
    failedRunSampledPeakTreeRssKB: runs.filter(run => run.error).map(run => ({ runIndex: run.runIndex, sampledPeakTreeRssKB: run.sampledPeakTreeRssKB })),
  };
}

function median(values) {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function percentileNearestRank(values, percentile) {
  if (values.length === 0) return null;
  return values[Math.max(0, Math.ceil(percentile * values.length) - 1)];
}

async function writeJsonSafely(path, value) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function withTimeout(promise, timeoutMs, operation) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

await executeBenchmark();
