#!/usr/bin/env node
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir as fsReaddir, stat as fsStat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const appEntry = join(root, "apps/desktop/dist/main/index.cjs");
const daemonPath = join(root, "apps/desktop/dist/resources/commitscope-daemon");
const output = { schemaVersion: 1, benchmark: "history-navigation-before-after", startedAt: new Date().toISOString(), measurements: {}, failures: [] };
let app;
let page;

try {
  for (const key of ["repository", "profile", "output"]) if (!args[key].startsWith("/")) throw new Error(`--${key} must be an absolute path`);
  await Promise.all([access(appEntry), access(daemonPath), access(args.repository)]);
  await ensureNewOutput(args.output);
  const [head, dateValues, sourceHead, sourceDirty] = await Promise.all([
    git(args.repository, ["rev-parse", "HEAD"]), git(args.repository, ["log", "--topo-order", "--format=%ct", "HEAD"]),
    git(root, ["rev-parse", "HEAD"]), git(root, ["status", "--porcelain"]),
  ]);
  const uniqueTimes = [...new Set(dateValues.trim().split(/\s+/).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  if (uniqueTimes.length < 6) throw new Error(`Expected at least six unique commit timestamps, found ${uniqueTimes.length}`);
  const quantiles = [0.1, 0.28, 0.43, 0.58, 0.73, 0.88];
  const dates = quantiles.map(q => uniqueTimes[Math.min(uniqueTimes.length - 1, Math.floor(q * uniqueTimes.length))]);
  if (new Set(dates).size !== dates.length) throw new Error("Could not choose six distinct timestamp quantiles from the fixture");
  output.input = { repository: args.repository, headOid: head.trim(), commitCount: Number((await git(args.repository, ["rev-list", "--count", "HEAD"])).trim()), profile: args.profile, profileState: await inspectProfile(args.profile), sourceHead: sourceHead.trim(), sourceDirty: Boolean(sourceDirty.trim()), sourceDirtySummary: sourceDirty.trim().split("\n").filter(Boolean).slice(0, 30), sampleTimestamps: dates };
  const assetDirectory = join(root, "apps/desktop/dist/renderer/assets");
  output.build = { appEntrySha256: await hashFile(appEntry), bundledDaemonSha256: await hashFile(daemonPath),
    rendererAssets: await Promise.all((await fsReaddir(assetDirectory)).filter(name => name.endsWith(".js")).sort()
      .map(async name => ({ name, sha256: await hashFile(join(assetDirectory, name)) }))),
  };
  output.measurements.dateContract = "All direct calls use locateHistoryDate(beforeTimestamp=selectedUniqueTimestamp+1,pageSize=200). Timings include preload IPC request/response and exclude render/paint. Each result records HistoryPage offset and SHA256 of the full returned commit rows.";

  app = await electron.launch({
    executablePath: require("electron"),
    args: [appEntry, `--repository=${args.repository}`, `--user-data-dir=${args.profile}`],
    cwd: root, chromiumSandbox: true, timeout: 30_000, env: launchEnv(),
  });
  page = await app.firstWindow();
  await page.bringToFront();
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-state"]')?.dataset.state === "ready", null, { timeout: 45_000 });
  await page.waitForFunction(() => {
    const list = document.querySelector('[aria-label="提交"]');
    return list && Number(list.dataset.loadedCount) >= 200 && list.querySelector('[data-testid="commit-row"]');
  }, null, { timeout: 30_000 });
  output.measurements.window = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(candidate => candidate.isVisible());
    return win ? { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds(), contentBounds: win.getContentBounds() } : { visible: false };
  });
  const index = await waitForIndex(page, 30_000);
  output.measurements.index = { initialState: index.initial?.state ?? null, initialCoverage: index.initial?.coverage ?? null, finalState: index.final.state, finalCoverage: index.final.coverage };
  output.measurements.sliderReadiness = await waitForCompleteSliderDays(page, 10_000);
  output.measurements.sliderComparability = { activityDaysComplete: output.measurements.sliderReadiness.complete, directlyComparable: output.measurements.sliderReadiness.complete, limitation: output.measurements.sliderReadiness.complete ? null : "Activity days remained partial after 10 seconds; slider before/after latency must not be attributed to the code change." };

  output.measurements.directDateQueries = [];
  for (let index = 0; index < dates.length; index += 1) {
    const timestamp = dates[index];
    const beforeTimestamp = timestamp + 1;
    const sample = await dateIpc(page, beforeTimestamp);
    output.measurements.directDateQueries.push({ phase: index === 0 ? "cold-first-call" : "subsequent-distinct-timestamp", sourceTimestamp: timestamp, ...sample });
    if (!sample.success) {
      output.failures.push({ stage: "locateHistoryDate", ...sample });
      throw new Error("Date lookup failed; stopping before drag and memory measurements");
    }
  }

  const samePageSeed = await dateIpc(page, dates[3] + 1);
  output.measurements.samePageSeed = samePageSeed;
  if (!samePageSeed.success) throw new Error("Cannot seed the same-page lookup");
  output.measurements.samePageQueries = [];
  for (let index = 0; index < 3; index += 1) {
    const sample = await dateIpc(page, dates[3] + 1, [samePageSeed.cursor]);
    output.measurements.samePageQueries.push(sample);
    if (!sample.success) {
      output.failures.push({ stage: "same-page-location", ...sample });
      throw new Error("Same-page lookup failed; stopping before drag and memory measurements");
    }
  }

  output.measurements.timeSliderDrag = { cacheCondition: "after the six date IPC samples; this is the actual pointer drag, with date-query caches already warm", ...(await dragSliderAndMeasure(page, dates[3])) };
  output.measurements.timeSliderDrag.processTreeRssSnapshot = await sampleProcessTree(app.process().pid);
  output.measurements.timeSliderDrag.processTreeRssSnapshot.note = "Single point-in-time ps sample after date caches were populated and the drag result settled; not a peak or idle baseline.";
  output.measurements.postDragIdle = [];
  for (let second = 1; second <= 5; second += 1) {
    await delay(1_000);
    const memory = await sampleProcessTree(app.process().pid);
    output.measurements.postDragIdle.push({ secondsAfterSnapshot: second, treeRssKB: memory.treeRssKB, roleRssKB: memory.roleRssKB,
      mainHeap: await app.evaluate(() => process.memoryUsage()),
      rendererHeap: await page.evaluate(() => {
        const memory = performance.memory;
        return memory ? { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize } : null;
      }),
    });
  }
  await goNewest(page);
  output.measurements.fastScroll = await fastScroll(page);
  await goNewest(page);
  if (output.failures.length) process.exitCode = 1;
} catch (error) {
  output.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  if (app) {
    try { await app.close(); }
    catch (error) { output.failures.push({ stage: "electron-close", message: error.message }); process.exitCode = 1; }
  }
  output.finishedAt = new Date().toISOString();
  try {
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(args.output, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`History navigation benchmark evidence: ${args.output}\n`);
  } catch (error) { process.stderr.write(`Cannot write output: ${error.message}\n`); process.exitCode = 1; }
}

function parseArgs(argv) {
  const values = {};
  for (const token of argv) {
    const split = token.indexOf("=");
    if (!token.startsWith("--") || split < 3) throw new Error(`Expected --name=value: ${token}`);
    const name = token.slice(2, split);
    if (!["repository", "profile", "output"].includes(name)) throw new Error(`Unknown argument: ${name}`);
    values[name] = token.slice(split + 1);
  }
  for (const name of ["repository", "profile", "output"]) if (!values[name]) throw new Error("Usage: node scripts/benchmark-history-navigation.mjs --repository=/abs/wide-history --profile=/abs/app-data --output=/abs/new.json");
  return values;
}
async function dateIpc(target, beforeTimestamp, knownCursors = []) {
  const measured = await target.evaluate(async ({ before, known }) => {
    const started = performance.now();
    try { const response = await window.commitScope.locateHistoryDate(before, 200, known); return { elapsedMs: performance.now() - started, response }; }
    catch (error) { return { elapsedMs: performance.now() - started, thrown: String(error?.message ?? error) }; }
  }, { before: beforeTimestamp, known: knownCursors });
  const response = measured.response;
  if (response?.ok !== true) return { success: false, beforeTimestamp, pageSize: 200, ipcMs: measured.elapsedMs, error: response?.error ?? measured.thrown ?? { message: "Malformed locateHistoryDate response" } };
  const location = response.value;
  const page = "page" in location ? location.page : location;
  const rows = page?.commits ?? [];
  return { success: true, beforeTimestamp, pageSize: 200, ipcMs: measured.elapsedMs, cursor: location.cursor, offset: location.offset,
    reusedPage: page === null, targetOid: location.oid ?? null, responseBytes: Buffer.byteLength(JSON.stringify(response.value)),
    rowCount: rows.length, rowsSha256: page === null ? null : sha256(JSON.stringify(rows)), firstOids: rows.slice(0, 5).map(row => row.oid), lastOid: rows.at(-1)?.oid ?? null };
}
async function dragSliderAndMeasure(target, centerTimestamp) {
  const slider = target.getByTestId("history-time-slider-track");
  await slider.waitFor({ state: "visible", timeout: 10_000 });
  let box = await slider.boundingBox();
  if (!box) throw new Error("History time slider has no bounding box");
  const x = box.x + box.width - 8;
  await target.mouse.move(x, box.y + box.height * 0.35);
  await target.waitForTimeout(80);
  box = await slider.boundingBox();
  if (!box) throw new Error("History time slider lost its bounding box");
  await slider.focus();
  await target.keyboard.press("End");
  let rail = await readRail(target);
  let zoomSteps = 0;
  while (rail.windowEnd - rail.windowStart > 21_600 && zoomSteps < 12) {
    await target.keyboard.press("=");
    zoomSteps += 1;
    rail = await readRail(target);
  }
  const spanSeconds = rail.windowEnd - rail.windowStart;
  const usableHeight = Math.max(1, box.height - 16);
  const wheelDeltaToCenter = (rail.windowEnd - (centerTimestamp + spanSeconds / 2)) / spanSeconds * usableHeight;
  await target.mouse.move(x, box.y + box.height / 2);
  await target.mouse.wheel(0, wheelDeltaToCenter);
  await target.waitForTimeout(50);
  rail = await readRail(target);
  box = await slider.boundingBox();
  if (!box) throw new Error("History time slider lost its bounding box after centering");
  const initialRail = await target.getByTestId("history-time-slider").evaluate(element => ({ partial: element.dataset.partial ?? null, windowStart: Number(element.dataset.windowStart), windowEnd: Number(element.dataset.windowEnd) }));
  const startY = box.y + box.height * 0.2;
  const endY = box.y + box.height * 0.82;
  await target.mouse.move(x, startY);
  await target.mouse.down();
  const dragStarted = performance.now();
  for (let i = 1; i <= 24; i += 1) {
    await target.mouse.move(x, startY + (endY - startY) * i / 24);
    await delay(50);
  }
  const bubble = target.getByTestId("history-time-bubble");
  await bubble.waitFor({ state: "visible", timeout: 3_000 });
  const requestedSecondsRounded = Number(await bubble.getAttribute("data-seconds"));
  const releaseStarted = performance.now();
  await target.mouse.up();
  const releasedAt = performance.now();
  const stable = await waitForStableHistory(target, 15_000);
  const finalRail = await target.getByTestId("history-time-slider").evaluate(element => ({ partial: element.dataset.partial ?? null, windowStart: Number(element.dataset.windowStart), windowEnd: Number(element.dataset.windowEnd) }));
  return { targetTimestamp: centerTimestamp, zoomSteps, wheelDeltaToCenter, spanSeconds, dragDurationMs: Math.round((releaseStarted - dragStarted) * 100) / 100, releaseToFirstStableMs: Math.round((stable.stableAt - releasedAt) * 100) / 100, stableConfirmationMs: Math.round((stable.confirmedAt - stable.stableAt) * 100) / 100, initialRail, finalRail, requestedSecondsRounded, finalVisibleOid: stable.selectedOid, finalDataLoadedOffset: stable.offset, finalDataLoadedCount: stable.count, settledSamples: stable.stableSamples };
}
async function readRail(target) { return target.getByTestId("history-time-slider").evaluate(element => ({ windowStart: Number(element.dataset.windowStart), windowEnd: Number(element.dataset.windowEnd), height: element.getBoundingClientRect().height })); }
async function waitForStableHistory(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previous = "", stableSamples = 0, stableAt = null;
  while (Date.now() < deadline) {
    const state = await target.evaluate(() => {
      const list = document.querySelector('[aria-label="提交"]');
      const slider = document.querySelector('[data-testid="history-time-slider-track"]');
      return list ? { busy: list.getAttribute("aria-busy"), sliderBusy: slider?.getAttribute("aria-busy") ?? "false", loading: list.dataset.pageLoading, offset: list.dataset.loadedOffset, count: list.dataset.loadedCount, selectedOid: list.querySelector('[data-testid="commit-row"][aria-selected="true"]')?.getAttribute("data-oid") ?? null } : null;
    });
    if (state && state.busy !== "true" && state.sliderBusy !== "true" && state.loading === "false") {
      const key = JSON.stringify(state);
      if (key !== previous) stableAt = performance.now();
      stableSamples = key === previous ? stableSamples + 1 : 1;
      previous = key;
      if (stableSamples >= 4) return { ...state, offset: Number(state.offset), count: Number(state.count), stableSamples, stableAt, confirmedAt: performance.now() };
    } else { stableSamples = 0; previous = ""; stableAt = null; }
    await delay(100);
  }
  throw new Error("History list did not become stable after releasing the time slider");
}
async function fastScroll(target) {
  const list = target.getByRole("listbox", { name: "提交" });
  await list.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await target.waitForTimeout(150);
  const listBox = await list.boundingBox();
  if (!listBox) throw new Error("History list has no bounding box");
  await target.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
  await list.evaluate(() => {
    const list = document.querySelector('[aria-label="提交"]');
    if (!list) throw new Error("History list missing");
    const samples = [];
    let edgeBusyStart = null, edgeWaitMs = 0, edgeWaitCount = 0, maxDomRows = 0, maxLoadedCount = 0;
    const sample = () => {
      const busy = list.getAttribute("aria-busy") === "true" || list.dataset.pageLoading === "true";
      const now = performance.now();
      const distanceToLoadedBottom = Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop);
      const atLoadedBottom = distanceToLoadedBottom <= 2;
      const edgeBusy = busy && atLoadedBottom;
      if (edgeBusy && edgeBusyStart === null) { edgeBusyStart = now; edgeWaitCount += 1; }
      if (!edgeBusy && edgeBusyStart !== null) { edgeWaitMs += now - edgeBusyStart; edgeBusyStart = null; }
      const offset = Number(list.dataset.loadedOffset), count = Number(list.dataset.loadedCount);
      maxDomRows = Math.max(maxDomRows, list.querySelectorAll('[data-testid="commit-row"]').length);
      maxLoadedCount = Math.max(maxLoadedCount, count);
      samples.push({ at: now, offset, count, scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, distanceToLoadedBottom, atLoadedBottom, busy, edgeBusy });
    };
    sample();
    const timer = setInterval(sample, 25);
    window.__historyNavigationBench = { finish() { clearInterval(timer); sample(); if (edgeBusyStart !== null) edgeWaitMs += performance.now() - edgeBusyStart; return { samples, maxDomRows, maxLoadedCount, edgeWaitCount, edgeWaitMs }; } };
  });
  const start = performance.now();
  let calls = 0, deltaPx = 0;
  while (performance.now() - start < 6_000) { await target.mouse.wheel(0, 1_200); calls += 1; deltaPx += 1_200; await delay(50); }
  const scrollDurationMs = performance.now() - start;
  const measured = await target.evaluate(() => window.__historyNavigationBench.finish());
  await waitForStableHistory(target, 10_000);
  const ranges = measured.samples.map(item => item.offset).filter(Number.isFinite);
  const counts = measured.samples.map(item => item.count).filter(Number.isFinite);
  const scrollTops = measured.samples.map(item => item.scrollTop).filter(Number.isFinite);
  return { requestedDurationMs: 6_000, actualDurationMs: Math.round(scrollDurationMs), targetScrollRatePxPerSecond: 24_000, wheelDeltaSumPx: deltaPx, wheelEvents: calls, scrollTopStart: scrollTops[0] ?? null, scrollTopEnd: scrollTops.at(-1) ?? null, scrollTopDelta: scrollTops.length ? scrollTops.at(-1) - scrollTops[0] : null, loadedOffsetMin: Math.min(...ranges), loadedOffsetMax: Math.max(...ranges), loadedOffsetRange: [Math.min(...ranges), Math.max(...ranges)], loadedCountMin: Math.min(...counts), loadedCountMax: Math.max(...counts), edgeWaitDefinition: "Count only while history list is loading and its distance to the currently loaded bottom is <=2 CSS px; 25ms observer stops immediately at the end of the six-second wheel phase.", edgeWaitCount: measured.edgeWaitCount, edgeWaitTotalMs: Math.round(measured.edgeWaitMs), domRowsPeak: measured.maxDomRows, retainedRowsPeak: measured.maxLoadedCount, last: measured.samples.at(-1) };
}
async function goNewest(target) {
  const list = target.getByRole("listbox", { name: "提交" });
  const bounds = await list.boundingBox();
  if (bounds) await target.mouse.move(bounds.x + 20, bounds.y + bounds.height / 2);
  await target.waitForTimeout(100);
  const newest = target.getByTestId("history-newest");
  if (await newest.count()) await newest.click({ timeout: 5_000 });
  await target.waitForFunction(() => {
    const list = document.querySelector('[aria-label="提交"]');
    return list && list.dataset.pageLoading === "false" && Number(list.dataset.loadedOffset) === 0;
  }, null, { timeout: 5_000 });
}
async function waitForIndex(target, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let initial = null, final = null;
  while (Date.now() < until) {
    const response = await target.evaluate(() => window.commitScope.getMetadataIndexStatus());
    if (response?.ok) { final = response.value; initial ??= final; if (final.state === "complete") return { initial, final }; if (["failed", "unavailable", "quotaLimited", "cancelled"].includes(final.state)) throw new Error(`Metadata index ${final.state}: ${JSON.stringify(final.error)}`); }
    else if (!(["BUSY", "CANCELLED", "STALE_CONTEXT"].includes(response?.error?.code))) throw new Error(`Index status failed: ${JSON.stringify(response?.error ?? response)}`);
    await delay(1_000);
  }
  throw new Error(`Metadata index timeout: ${JSON.stringify({ initial, final })}`);
}
async function waitForCompleteSliderDays(target, timeoutMs) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await target.getByTestId("history-time-slider").evaluate(element => ({ partial: element.dataset.partial ?? null, dayMarks: element.querySelectorAll('[data-testid="history-time-day"]').length, windowStart: Number(element.dataset.windowStart), windowEnd: Number(element.dataset.windowEnd) }));
    if (last.partial === null) return { ...last, complete: true, waitedMs: Date.now() - started };
    await delay(200);
  }
  return { ...last, complete: false, waitedMs: Date.now() - started };
}
async function git(repository, args) { return (await exec("git", ["-C", repository, ...args], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env: cleanEnv() })).stdout; }
async function sampleProcessTree(rootPid) {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,rss=,lstart=,command="], { timeout: 3_000, maxBuffer: 16 * 1024 * 1024 });
  const rows = stdout.split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    if (!match) return null;
    const command = match[5].trim();
    return { pid: Number(match[1]), ppid: Number(match[2]), rssKB: Number(match[3]), started: match[4].trim(), command, role: processRole(command) };
  }).filter(Boolean);
  const byParent = new Map();
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  const root = rows.find(row => row.pid === rootPid);
  const tree = root ? [root] : [];
  const queue = root ? [root.pid] : [];
  while (queue.length) for (const child of byParent.get(queue.pop()) ?? []) { tree.push(child); queue.push(child.pid); }
  const roles = {};
  for (const name of ["main", "renderer", "gpu", "utility", "rust", "git", "other"]) roles[name] = tree.filter(row => row.role === name).reduce((sum, row) => sum + row.rssKB, 0);
  return { sampledAt: new Date().toISOString(), sampleCount: 1, rootPid, treeRssKB: tree.reduce((sum, row) => sum + row.rssKB, 0), roleRssKB: roles, processes: tree.map(({ ppid, ...row }) => row) };
}
function processRole(command) {
  const value = command.toLowerCase();
  if (value.includes("commitscope-daemon")) return "rust";
  if (/(^|\/)git(\s|$)|\(git\)/.test(value)) return "git";
  if (value.includes("--type=utility") || value.includes("utility")) return "utility";
  if (value.includes("--type=gpu-process") || value.includes("gpu process")) return "gpu";
  if (value.includes("--type=renderer") || value.includes("renderer")) return "renderer";
  if (value.includes("electron")) return "main";
  return "other";
}
function cleanEnv() { const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]; return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }; }
function launchEnv() { const env = cleanEnv(); delete env.ELECTRON_RUN_AS_NODE; return env; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
async function ensureNewOutput(path) { try { await access(path); throw new Error(`Refusing to overwrite output: ${path}`); } catch (error) { if (error.code !== "ENOENT") throw error; } }
async function inspectProfile(path) {
  let profileEntries;
  try { profileEntries = await fsReaddir(path); }
  catch (error) { if (error.code === "ENOENT") return { existed: false, indexFiles: [] }; throw error; }
  let entries = [];
  try { entries = await fsReaddir(join(path, "repository-state", "metadata-index"), { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const indexes = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const indexPath = join(path, "repository-state", "metadata-index", entry.name, "index.sqlite3");
    try { return { path: indexPath, sizeBytes: (await fsStat(indexPath)).size }; } catch { return null; }
  }));
  return { existed: true, profileEntryCount: profileEntries.length, indexFiles: indexes.filter(Boolean) };
}
async function hashFile(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function delay(ms) { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)); }
