#!/usr/bin/env node
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { aggregateProcessSamples, classifyProcess, mergeProcessObservation } from "./process-tree-observation.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const appEntry = join(root, "apps/desktop/dist/main/index.cjs");
const rendererRoot = join(root, "apps/desktop/dist/renderer");
const daemonPath = join(root, "apps/desktop/dist/resources/commitscope-daemon");
const releaseDaemonPath = join(root, "target/release/commitscope-daemon");
const electronBinary = require("electron");
const electronVersion = require("electron/package.json").version;
const scrollDurationMs = 30_000;
const outputPath = resolve(args.output);

if (process.platform !== "darwin") throw new Error("benchmark:history-scroll currently requires macOS ps process-tree sampling");
if (args.runs < 1 || args.runs > 10) throw new Error("--runs must be between 1 and 10");
await Promise.all([access(appEntry), access(rendererRoot), access(daemonPath), access(args.repository)]);
await ensureMissing(outputPath);
const repository = await describeRepository(resolve(args.repository));
if (repository.commitCount !== 100_000) throw new Error(`Expected the fixed 100000-commit fixture, got ${repository.commitCount}`);
if (repository.headOid !== args.expectedHead) throw new Error(`Fixture HEAD mismatch: expected ${args.expectedHead}, got ${repository.headOid}`);
const artifacts = {
  appEntry,
  appEntrySha256: await sha256File(appEntry),
  rendererRoot,
  rendererFiles: await describeFileTree(rendererRoot),
  rendererTreeSha256: await sha256Tree(rendererRoot),
  daemonPath,
  daemonSha256: await sha256File(daemonPath),
  releaseDaemonPath,
  releaseDaemonSha256: await sha256File(releaseDaemonPath).catch(() => null),
  electronVersion,
};
artifacts.buildProfile = artifacts.daemonSha256 === artifacts.releaseDaemonSha256 ? "release" : "not-confirmed-release";
const output = {
  schemaVersion: 1,
  benchmark: "p1-03-history-scroll",
  startedAt: new Date().toISOString(),
  repository,
  artifacts,
  requestedRuns: args.runs,
  trajectory: {
    durationMs: scrollDurationMs,
    segments: [
      { direction: "down", durationMs: 23_000, pixelsPerSecond: 8_000 },
      { direction: "up", durationMs: 7_000, pixelsPerSecond: 8_000 },
    ],
    frameBudgetMs: 20,
    hitchThresholdMs: 100,
  },
  measurement: {
    frameInterval: "renderer requestAnimationFrame timestamp delta while the fixed trajectory is active",
    longTasks: "PerformanceObserver longtask entries in the renderer when supported; entries are not equivalent to visible hitches",
    pageRequestToPaint: "time from the list aria-busy/data-page-loading transition to a loaded offset/count change and its following requestAnimationFrame; this is an observer estimate, not an RPC timestamp or compositor presentation timestamp",
    idleWindow: "two second stable foreground window before the scroll trajectory; sampled process-tree RSS peak and cumulative ps CPU estimate for this short interval only",
    notMeasured: "The separate one minute idle CPU budget is not measured by this run.",
    retainedData: "data-loaded-count and data-window-pages on the real listbox; these describe the bounded summary window, not total repository history",
    processTree: "100 ms macOS ps samples rooted at the Electron process and all observed descendants, including renderer, GPU, daemon and Git when captured; RSS sum can double-count shared pages",
    limitations: [
      "OS page cache is uncontrolled and is not cleared.",
      "100 ms ps sampling can miss short-lived Git children and undercount their peak RSS/CPU.",
      "A 30 second / 3 run measurement is an implementation baseline, not sufficient release acceptance evidence.",
      "The 60 Hz budget is only considered verified when the actual display refresh rate is independently confirmed as 60 Hz; this script does not change system display settings.",
      "Frame timing is renderer requestAnimationFrame timing and does not directly measure compositor presentation or physical panel scanout.",
    ],
  },
  environment: await collectEnvironment(),
  runs: [],
};

async function main() {
let temporaryRoot;
try {
  if (artifacts.buildProfile !== "release") throw new Error("The bundled daemon does not match target/release/commitscope-daemon; build the release app before benchmarking");
  temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-history-scroll-"));
  for (let runIndex = 1; runIndex <= args.runs; runIndex += 1) {
    const record = await runOne(runIndex, temporaryRoot);
    output.runs.push(record);
    if (record.error) {
      output.failures ??= [];
      output.failures.push({ runIndex, error: record.error });
    }
    process.stdout.write(`run ${runIndex}/${args.runs}: ${record.frameSummary.p95Ms ?? "n/a"}ms RAF p95, max ${record.frameSummary.maxMs ?? "n/a"}ms, ${record.peakTreeRssKB} KiB tree RSS\n`);
  }
  output.summary = summarize(output.runs);
  output.finishedAt = new Date().toISOString();
  if (output.failures?.length) process.exitCode = 1;
} catch (error) {
  output.failure = { message: error.message, stack: error.stack };
  output.finishedAt = new Date().toISOString();
  process.stderr.write(`History scroll benchmark failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`Wrote scroll benchmark JSON to ${outputPath}\n`);
  } catch (error) {
    process.stderr.write(`Could not write new benchmark output: ${error.message}\n`);
    process.exitCode = 1;
  }
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}
}

function parseArgs(argv) {
  let repository;
  let output;
  let runs = 3;
  let expectedHead = "91081e9df378d40ab325f9c04b9cc4774b2c33ee";
  for (const argument of argv) {
    if (argument.startsWith("--repository=")) repository = argument.slice("--repository=".length);
    else if (argument.startsWith("--output=")) output = argument.slice("--output=".length);
    else if (argument.startsWith("--runs=")) runs = Number(argument.slice("--runs=".length));
    else if (argument.startsWith("--expected-head=")) expectedHead = argument.slice("--expected-head=".length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!repository || !repository.startsWith("/")) throw new Error("--repository must be an absolute path");
  if (!output) throw new Error("Usage: pnpm benchmark:history-scroll --repository=<fixed-100k> --output=<new-json> [--runs=3|10]");
  if (!Number.isInteger(runs)) throw new Error("--runs must be an integer");
  return { repository, output, runs, expectedHead };
}

async function runOne(runIndex, temporaryRootPath) {
  const profile = join(temporaryRootPath, `user-data-${String(runIndex).padStart(2, "02")}`);
  await mkdir(profile, { recursive: false });
  const startedAt = performance.now();
  const sampler = new ProcessTreeSampler(startedAt, profile, appEntry);
  sampler.start();
  let app;
  let page;
  let runtime;
  let uiState;
  let foregroundState;
  let displayState;
  let displayStateEnd;
  let idleTreeSnapshot;
  let executionError;
  let forcedCleanup = false;
  try {
    app = await withTimeout(electron.launch({
      executablePath: electronBinary,
      args: [appEntry, `--repository=${resolve(args.repository)}`, `--user-data-dir=${profile}`],
      cwd: root,
      chromiumSandbox: true,
      timeout: 30_000,
      env: launchEnvironment(),
    }), 35_000, "Electron launch");
    sampler.setRootPid(app.process().pid);
    runtime = await app.evaluate(() => ({ node: process.versions.node, electron: process.versions.electron, chrome: process.versions.chrome }));
    page = await withTimeout(app.firstWindow(), 15_000, "Electron window");
    await page.bringToFront();
    await page.waitForFunction(() => document.querySelector('[data-testid="preview-state"][data-state="ready"]'), null, { timeout: 60_000 });
    await page.waitForFunction(() => {
      const list = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
      return list && Number(list.getAttribute("data-loaded-count")) > 0 && list.querySelector('[data-testid="commit-row"]');
    }, null, { timeout: 20_000 });
    displayState = await app.evaluate(({ BrowserWindow, screen }) => {
      const active = BrowserWindow.getAllWindows().find(candidate => candidate.isVisible());
      if (!active) return { visible: false, focused: false, displayFrequencyHz: null, displays: [] };
      const displays = screen.getAllDisplays().map(display => ({
        id: display.id,
        frequencyHz: display.displayFrequency,
        scaleFactor: display.scaleFactor,
        bounds: display.bounds,
        workArea: display.workArea,
      }));
      const target = displays.find(display => Math.abs(display.frequencyHz - 60) < 0.5);
      if (target) {
        const bounds = active.getBounds();
        active.setBounds({
          x: target.workArea.x + 20,
          y: target.workArea.y + 20,
          width: Math.min(bounds.width, Math.max(320, target.workArea.width - 40)),
          height: Math.min(bounds.height, Math.max(400, target.workArea.height - 40)),
        });
        active.show();
        active.focus();
      }
      const matching = screen.getDisplayMatching(active.getBounds());
      return {
        visible: active.isVisible(),
        focused: active.isFocused(),
        displayFrequencyHz: matching.displayFrequency,
        matchingDisplayId: matching.id,
        targeted60HzDisplay: Boolean(target),
        displays,
      };
    });
    foregroundState = { visible: displayState.visible, focused: displayState.focused };
    if (!foregroundState.visible || !foregroundState.focused) throw new Error(`Electron window is not foregrounded: ${JSON.stringify(foregroundState)}`);
    await page.waitForTimeout(250);
    const settledDisplay = await app.evaluate(({ BrowserWindow, screen }) => {
      const active = BrowserWindow.getAllWindows().find(candidate => candidate.isVisible());
      const matching = active ? screen.getDisplayMatching(active.getBounds()) : null;
      return {
        ...(matching ? { displayFrequencyHz: matching.displayFrequency, matchingDisplayId: matching.id } : {}),
        focused: Boolean(active?.isFocused()),
        visible: Boolean(active?.isVisible()),
      };
    });
    displayState = { ...displayState, ...settledDisplay };
    const idleWindowStart = sampler.beginWindow();
    await page.waitForTimeout(2_000);
    await sampler.sample();
    idleTreeSnapshot = sampler.summarizeWindow(idleWindowStart);
    uiState = await page.evaluate(installTrajectory, scrollDurationMs);
    if (uiState.listSelectorMissing) throw new Error("Could not locate the listbox for scrolling");
    if (uiState.offsetAttributesMissing) throw new Error("The listbox must expose data-loaded-offset/count/window-pages for P1-03 measurement");
    await page.waitForFunction(() => window.__historyScrollBench?.finished === true, null, { timeout: scrollDurationMs + 10_000 });
    uiState = await page.evaluate(() => window.__historyScrollBench.snapshot());
    displayStateEnd = await app.evaluate(({ BrowserWindow, screen }) => {
      const active = BrowserWindow.getAllWindows().find(candidate => candidate.isVisible());
      const matching = active ? screen.getDisplayMatching(active.getBounds()) : null;
      return { frequencyHz: matching?.displayFrequency ?? null, displayId: matching?.id ?? null, visible: Boolean(active?.isVisible()), focused: Boolean(active?.isFocused()) };
    });
  } catch (error) {
    executionError = error;
  } finally {
    if (app) {
      try { await withTimeout(app.close(), 12_000, "Electron close"); }
      catch (error) {
        forcedCleanup = true;
        executionError ??= error;
        app.process().kill("SIGKILL");
      }
    }
    await sampler.stop();
  }
  let processExit = await waitForCapturedProcessesToExit(sampler.identities, 6000);
  if (!processExit.allExited) {
    forcedCleanup = true;
    await terminateCapturedProcesses(sampler.identities, processExit.live);
    processExit = await waitForCapturedProcessesToExit(sampler.identities, 2500);
  }
  const tree = sampler.record();
  const record = {
    runIndex,
    startedAtMs: startedAt,
    runtime: runtime ?? null,
    foregroundState: foregroundState ?? null,
    displayState: displayState ?? null,
    displayStateEnd: displayStateEnd ?? null,
    sixtyHzModeConfirmed: Math.abs((displayState?.displayFrequencyHz ?? Number.NaN) - 60) <= 0.5 &&
      displayState?.focused === true && displayState?.visible === true &&
      Math.abs((displayStateEnd?.frequencyHz ?? Number.NaN) - 60) <= 0.5 &&
      displayStateEnd?.displayId === displayState?.matchingDisplayId &&
      displayStateEnd?.focused === true && displayStateEnd?.visible === true &&
      (uiState?.stateSamples?.length ?? 0) > 0 &&
      uiState.stateSamples.every(sample => sample.visibilityState === "visible" && sample.hasFocus),
    ui: uiState ?? null,
    frameSummary: summarizeFrames(uiState?.frameIntervalsMs ?? []),
    loadingToWindowSummary: summarizeNumbers(uiState?.loadingToWindowMs ?? []),
    loadingWindowChanges: uiState?.windowChanges ?? [],
    visibilitySummary: uiState ? {
      sampleCount: uiState.stateSamples.length,
      hiddenSamples: uiState.stateSamples.filter(sample => sample.visibilityState !== "visible").length,
      unfocusedSamples: uiState.stateSamples.filter(sample => !sample.hasFocus).length,
    } : null,
    idleTreeSnapshot: idleTreeSnapshot ?? null,
    peakTreeRssKB: tree.peakTreeRssKB,
    cumulativeTreeCpuSecondsEstimate: tree.cumulativeCpuSecondsEstimate,
    processTree: tree,
    processExit,
    forcedCleanup,
    error: executionError?.message ?? null,
  };
  const groups = new Set(tree.processes.map(item => item.classification));
  record.processCoverage = {
    mainElectron: [...sampler.identities.keys()].some(key => key.startsWith(`${sampler.rootPid}:`)),
    rendererOrHelper: groups.has("electron-renderer-or-helper"),
    rustDaemon: groups.has("rust-daemon"),
    git: groups.has("git"),
  };
  if (tree.sampleErrors.length) record.error ??= `Process sampler had ${tree.sampleErrors.length} errors`;
  if (!record.processCoverage.mainElectron || !record.processCoverage.rendererOrHelper || !record.processCoverage.rustDaemon) {
    record.error ??= `Process tree sampling missed required groups: ${JSON.stringify(record.processCoverage)}`;
  }
  if (forcedCleanup) record.error ??= "Electron process tree required forced cleanup";
  if (!processExit.allExited) record.error ??= `Process tree remained alive after cleanup: ${processExit.live.map(item => item.pid).join(",")}`;
  if (!uiState) record.error ??= "Scroll trajectory did not produce renderer metrics";
  if (record.frameSummary.sampleCount === 0) record.error ??= "No RAF frame intervals were recorded";
  if (record.loadingToWindowSummary.sampleCount === 0) record.error ??= "No observed list-loading-to-window-draw samples were recorded";
  if (record.visibilitySummary && (record.visibilitySummary.hiddenSamples > 0 || record.visibilitySummary.unfocusedSamples > 0)) record.error ??= "Electron window was hidden or unfocused during the scroll trajectory";
  record.observedThresholds = {
    sixtyHzModeConfirmed: record.sixtyHzModeConfirmed,
    frameP95AtMost20Ms: record.sixtyHzModeConfirmed && record.frameSummary.p95Ms !== null && record.frameSummary.p95Ms <= 20,
    noFrameIntervalOver100Ms: record.frameSummary.maxMs !== null && record.frameSummary.maxMs <= 100,
    loadingToWindowP95AtMost200Ms: record.loadingToWindowSummary.p95Ms !== null && record.loadingToWindowSummary.p95Ms <= 200,
    wholeTreePeakRssAtMost500MiB: record.peakTreeRssKB <= 500 * 1024,
    retainedWindowAtMost2000: uiState?.maxLoadedCount <= 2_000,
    virtualDomRowsBounded: uiState?.maxDomRows <= 60,
    continuousForeground: record.visibilitySummary?.hiddenSamples === 0 && record.visibilitySummary?.unfocusedSamples === 0,
    releaseAcceptanceSufficient: false,
  };
  return record;
}

function installTrajectory(durationMs) {
  const list = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
  if (!list) return { listSelectorMissing: true };
  const offsetAttributesMissing = !list.hasAttribute("data-loaded-offset") || !list.hasAttribute("data-loaded-count") || !list.hasAttribute("data-window-pages");
  const frameIntervalsMs = [];
  const longTasks = [];
  const stateSamples = [];
  let active = false;
  let finished = false;
  let lastFrame = null;
  let trajectoryStart = 0;
  let previousOffset = Number(list.getAttribute("data-loaded-offset"));
  let previousCount = Number(list.getAttribute("data-loaded-count"));
  let pendingBusyStart = null;
  const windowChanges = [];
  const observer = new MutationObserver(() => {
    const busy = list.getAttribute("aria-busy") === "true" || list.getAttribute("data-page-loading") === "true";
    if (busy && pendingBusyStart === null) pendingBusyStart = performance.now();
    const currentOffset = Number(list.getAttribute("data-loaded-offset"));
    const currentCount = Number(list.getAttribute("data-loaded-count"));
    if (!Number.isFinite(currentOffset) || !Number.isFinite(currentCount) || (currentOffset === previousOffset && currentCount === previousCount)) return;
    const requestStarted = pendingBusyStart;
    const from = { offset: previousOffset, count: previousCount };
    const to = { offset: currentOffset, count: currentCount };
    const direction = currentOffset > previousOffset || (currentOffset === previousOffset && currentCount > previousCount) ? "forward" : "backward";
    if (requestStarted !== null) requestAnimationFrame(() => windowChanges.push({
      direction,
      from,
      to,
      loadingObservedToWindowMs: performance.now() - requestStarted,
      completedAtMs: performance.now() - trajectoryStart,
    }));
    previousOffset = currentOffset;
    previousCount = currentCount;
    pendingBusyStart = null;
  });
  observer.observe(list, { attributes: true, attributeFilter: ["aria-busy", "data-page-loading", "data-loaded-offset", "data-loaded-count", "data-window-pages"] });
  let longTaskSupported = false;
  try {
    const longTaskObserver = new PerformanceObserver(entries => {
      for (const entry of entries.getEntries()) longTasks.push({ startTimeMs: entry.startTime, durationMs: entry.duration });
    });
    longTaskObserver.observe({ type: "longtask", buffered: true });
    longTaskSupported = true;
  } catch {}
  const frame = timestamp => {
    if (active && lastFrame !== null) frameIntervalsMs.push(timestamp - lastFrame);
    if (active) {
      const elapsed = timestamp - trajectoryStart;
      const direction = elapsed < 23_000 ? 1 : -1;
      const frameDeltaMs = lastFrame === null ? 0 : Math.max(0, Math.min(50, timestamp - lastFrame));
      list.scrollTop += direction * frameDeltaMs * 8;
      if (elapsed >= durationMs) { active = false; finished = true; clearInterval(stateTimer); }
    }
    lastFrame = timestamp;
    if (!finished) requestAnimationFrame(frame);
  };
  const stateTimer = setInterval(() => {
    if (!active) return;
    stateSamples.push({
      elapsedMs: performance.now() - trajectoryStart,
      scrollTop: list.scrollTop,
      loadedOffset: Number(list.getAttribute("data-loaded-offset")),
      loadedCount: Number(list.getAttribute("data-loaded-count")),
      windowPages: Number(list.getAttribute("data-window-pages")),
      domRows: list.querySelectorAll('[data-testid="commit-row"]').length,
      jsHeapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
    });
  }, 100);
  trajectoryStart = performance.now();
  active = true;
  requestAnimationFrame(frame);
  const controller = {
    offsetAttributesMissing,
    longTaskSupported,
    started: true,
    get finished() { return finished; },
    snapshot() {
      observer.disconnect();
      clearInterval(stateTimer);
      return {
        durationMs,
        frameIntervalsMs,
        windowChanges,
        loadingToWindowMs: windowChanges.map(change => change.loadingObservedToWindowMs),
        longTasks,
        longTaskSupported,
        stateSamples,
        maxDomRows: Math.max(0, ...stateSamples.map(sample => sample.domRows)),
        maxLoadedCount: Math.max(0, ...stateSamples.map(sample => sample.loadedCount)),
        maxWindowPages: Math.max(0, ...stateSamples.map(sample => sample.windowPages)),
        maxJsHeapUsedBytes: Math.max(0, ...stateSamples.map(sample => sample.jsHeapUsedBytes ?? 0)) || null,
        scrollDirection: "down 23s then up 7s, 8k CSS px/s",
        pageLatencyStart: "observed aria-busy/data-page-loading transition to loaded offset/count change plus following requestAnimationFrame; not an RPC hook",
        listMetrics: { offsetAttributesMissing },
      };
    },
  };
  window.__historyScrollBench = controller;
  return { offsetAttributesMissing, longTaskSupported, started: true };
}

class ProcessTreeSampler {
  constructor(startedAt, profile, appEntryPath) {
    this.startedAt = startedAt;
    this.profile = profile;
    this.appEntryPath = appEntryPath;
    this.rootPid = null;
    this.samples = [];
    this.identities = new Map();
    this.cpuByIdentity = new Map();
    this.cumulativeCpuSecondsEstimate = 0;
    this.sampleErrors = [];
    this.timer = null;
    this.pending = null;
  }
  start() { this.timer = setInterval(() => { void this.sample(); }, 100); this.timer.unref(); void this.sample(); }
  setRootPid(pid) { this.rootPid = pid; }
  beginWindow() {
    return {
      sampleIndex: this.samples.length,
      errorIndex: this.sampleErrors.length,
      cpuSeconds: this.cumulativeCpuSecondsEstimate,
      elapsedMs: performance.now() - this.startedAt,
    };
  }
  summarizeWindow(start) {
    const samples = this.samples.slice(start.sampleIndex);
    return {
      durationMs: performance.now() - this.startedAt - start.elapsedMs,
      sampleCount: samples.length,
      peakTreeRssKB: Math.max(0, ...samples.map(sample => sample.tree.reduce((sum, item) => sum + item.rssKB, 0))),
      cumulativeCpuSecondsEstimate: this.cumulativeCpuSecondsEstimate - start.cpuSeconds,
      sampleErrors: this.sampleErrors.slice(start.errorIndex),
      scope: "stable visible foreground window immediately before the 30-second scroll trajectory",
    };
  }
  async sample() {
    if (this.pending) return this.pending;
    this.pending = this.#sample().finally(() => { this.pending = null; });
    return this.pending;
  }
  async #sample() {
    try {
      const table = await readProcessTable();
      if (!this.rootPid) {
        const entry = table.find(item => item.command.includes(`--user-data-dir=${this.profile}`) && item.command.includes(this.appEntryPath));
        if (entry) this.rootPid = entry.pid;
      }
      const tree = collectTree(table, this.rootPid).map(item => ({ ...item, classification: classifyProcess(item.command) }));
      for (const item of tree) {
        const key = `${item.pid}:${item.started}`;
        const old = this.identities.get(key);
        this.identities.set(key, { ...mergeProcessObservation(old, item), cpuSeconds: Math.max(old?.cpuSeconds ?? 0, item.cpuSeconds) });
        const previousCpu = this.cpuByIdentity.get(key);
        this.cumulativeCpuSecondsEstimate += Math.max(0, item.cpuSeconds - (previousCpu ?? 0));
        this.cpuByIdentity.set(key, item.cpuSeconds);
      }
      this.samples.push({ elapsedMs: performance.now() - this.startedAt, rootPid: this.rootPid, tree });
    } catch (error) { this.sampleErrors.push({ elapsedMs: performance.now() - this.startedAt, message: error.message }); }
  }
  async stop() { if (this.timer) clearInterval(this.timer); if (this.pending) await this.pending; await this.sample(); }
  record() {
    const peakTreeRssKB = Math.max(0, ...this.samples.map(sample => sample.tree.reduce((sum, item) => sum + item.rssKB, 0)));
    return {
      rootPid: this.rootPid,
      sampleIntervalMs: 100,
      samples: this.samples,
      processes: aggregateProcessSamples(this.samples),
      processIdentities: [...this.identities.values()],
      peakTreeRssKB,
      cumulativeCpuSecondsEstimate: this.cumulativeCpuSecondsEstimate,
      sampleErrors: this.sampleErrors,
    };
  }
}

async function readProcessTable() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,time=,lstart=,command="], { timeout: 2000, maxBuffer: 16 * 1024 * 1024 });
  const result = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.{24})\s+(.*)$/.exec(line);
    if (match) result.push({ pid: Number(match[1]), parentPid: Number(match[2]), rssKB: Number(match[3]), cpuPercent: Number(match[4]), cpuTime: match[5], cpuSeconds: parseCpuTime(match[5]), started: match[6].trim(), command: match[7].trim() });
  }
  return result;
}

function collectTree(table, rootPid) {
  if (!rootPid) return [];
  const byParent = new Map();
  for (const item of table) { const children = byParent.get(item.parentPid) ?? []; children.push(item); byParent.set(item.parentPid, children); }
  const rootProcess = table.find(item => item.pid === rootPid);
  if (!rootProcess) return [];
  const result = [rootProcess]; const queue = [rootPid]; const seen = new Set(queue);
  while (queue.length) for (const child of byParent.get(queue.pop()) ?? []) if (!seen.has(child.pid)) { seen.add(child.pid); result.push(child); queue.push(child.pid); }
  return result;
}

function parseCpuTime(value) {
  const days = /^(\d+)-(.*)$/.exec(value);
  if (days) return Number(days[1]) * 86400 + parseCpuTime(days[2]);
  const parts = value.split(":");
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  return 0;
}

async function waitForCapturedProcessesToExit(identities, timeoutMs) {
  const deadline = Date.now() + timeoutMs; let live = [];
  do {
    live = [];
    for (const identity of identities.values()) {
      const current = await processIdentity(identity.pid);
      if (current && current.started === identity.started) live.push({ ...identity, currentCommand: current.command });
    }
    if (!live.length) return { allExited: true, checkedPids: identities.size, live: [] };
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  } while (Date.now() < deadline);
  return { allExited: false, checkedPids: identities.size, live };
}

async function terminateCapturedProcesses(identities, live) {
  for (const item of live) {
    const identity = identities.get(`${item.pid}:${item.started}`);
    const current = await processIdentity(item.pid);
    if (identity && current?.started === identity.started) try { process.kill(item.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  await new Promise(resolveSleep => setTimeout(resolveSleep, 500));
  for (const item of live) {
    const identity = identities.get(`${item.pid}:${item.started}`);
    const current = await processIdentity(item.pid);
    if (identity && current?.started === identity.started) try { process.kill(item.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

async function processIdentity(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart=,command="], { timeout: 1500, maxBuffer: 4096 });
    const match = /^(.{24})\s+(.*)$/.exec(stdout.trimEnd());
    return match ? { started: match[1].trim(), command: match[2].trim() } : null;
  } catch { return null; }
}

async function describeRepository(path) {
  const manifestPath = join(dirname(path), "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const expected = manifest.fixtures?.large;
  const headOid = (await execFileAsync("git", ["-C", path, "rev-parse", "HEAD"], { timeout: 5000, env: cleanGitEnvironment() })).stdout.trim();
  const commitCount = Number((await execFileAsync("git", ["-C", path, "rev-list", "--count", "HEAD"], { timeout: 30_000, env: cleanGitEnvironment() })).stdout.trim());
  if (expected?.headOid !== headOid || expected?.commitCount !== commitCount) throw new Error("Repository does not match its fixture manifest");
  return { path, manifestPath, manifestSha256: await sha256File(manifestPath), headOid, commitCount, objectFormat: expected.objectFormat ?? null, fixedFixture: "p0-03 seed 20261107; read-only" };
}

async function collectEnvironment() {
  const [macOSVersion, model, physicalCpuCount] = await Promise.all([
    execFileAsync("sw_vers", ["-productVersion"], { timeout: 3000 }).then(result => result.stdout.trim()).catch(() => null),
    execFileAsync("sysctl", ["-n", "hw.model"], { timeout: 3000 }).then(result => result.stdout.trim()).catch(() => null),
    execFileAsync("sysctl", ["-n", "hw.physicalcpu"], { timeout: 3000 }).then(result => Number(result.stdout.trim())).catch(() => null),
  ]);
  return {
    platform: process.platform,
    macOSVersion,
    model,
    physicalCpuCount,
    logicalCpuCount: os.cpus().length,
    memoryBytes: os.totalmem(),
    kernelRelease: os.release(),
    node: process.version,
    electronPackageVersion: electronVersion,
    sampleIntervalMs: 100,
    displayRefreshRateSource: "per-run Electron screen.getDisplayMatching(activeWindowBounds).displayFrequency; nominal 60Hz mode accepts an absolute difference <=0.5Hz at start and end on the same display",
    changesSystemDisplaySettings: false,
  };
}

async function sha256File(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function describeFileTree(directory) {
  const files = [];
  const walk = async current => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push({ path: path.slice(directory.length + 1), sha256: await sha256File(path), sizeBytes: (await stat(path)).size });
    }
  };
  await walk(directory);
  return files;
}
async function sha256Tree(directory) {
  const files = await describeFileTree(directory);
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(file.sha256).update("\0");
  return hash.digest("hex");
}
async function ensureMissing(path) { try { await access(path); throw new Error(`Refusing to overwrite existing output: ${path}`); } catch (error) { if (error.code !== "ENOENT") throw error; } }
function cleanGitEnvironment() { const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]; return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }; }
function launchEnvironment() { const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]; delete env.ELECTRON_RUN_AS_NODE; return env; }
function summarizeFrames(values) { const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b); return { sampleCount: sorted.length, p95Ms: nearestRank(sorted, 0.95), maxMs: sorted.length ? sorted.at(-1) : null, over20Ms: sorted.filter(value => value > 20).length, over100Ms: sorted.filter(value => value > 100).length }; }
function summarizeNumbers(values) { const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b); return { sampleCount: sorted.length, p50Ms: nearestRank(sorted, 0.5), p95Ms: nearestRank(sorted, 0.95), maxMs: sorted.length ? sorted.at(-1) : null }; }
function nearestRank(values, percentile) { return values.length ? values[Math.max(0, Math.ceil(percentile * values.length) - 1)] : null; }
function summarize(runs) {
  return {
    runCount: runs.length,
    failedRuns: runs.filter(run => run.error).length,
    p95Method: "nearest-rank per run; aggregate values retained per run",
    frameP95Ms: runs.map(run => run.frameSummary.p95Ms),
    loadingObservedToWindowP95Ms: runs.map(run => run.loadingToWindowSummary.p95Ms),
    forwardLoadingP95Ms: runs.map(run => summarizeNumbers((run.loadingWindowChanges ?? []).filter(change => change.direction === "forward").map(change => change.loadingObservedToWindowMs)).p95Ms),
    backwardLoadingP95Ms: runs.map(run => summarizeNumbers((run.loadingWindowChanges ?? []).filter(change => change.direction === "backward").map(change => change.loadingObservedToWindowMs)).p95Ms),
    peakTreeRssKB: runs.map(run => run.peakTreeRssKB),
    idleTreeRssKB: runs.map(run => run.idleTreeSnapshot?.peakTreeRssKB ?? null),
    cumulativeTreeCpuSecondsEstimate: runs.map(run => run.cumulativeTreeCpuSecondsEstimate),
    releaseAcceptanceSufficient: false,
  };
}
function withTimeout(promise, timeoutMs, name) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs} ms`)), timeoutMs); })]).finally(() => clearTimeout(timer)); }

await main();
