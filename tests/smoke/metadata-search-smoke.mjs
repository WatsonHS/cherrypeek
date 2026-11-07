import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";
import { createSearchFixture, snapshotTree } from "../search/fixture.mjs";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-search-smoke-"));
const fixture = await createSearchFixture(join(temporaryRoot, "fixtures"), { count: 2_600 });
const repositoryBefore = fixture.snapshot;
const profile = join(temporaryRoot, "electron-user-data");
const appDataDir = join(profile, "repository-state");
const helperDirectory = join(temporaryRoot, "git-wrapper");
const gateFile = join(temporaryRoot, "index-batch.gate");
const pidFile = join(temporaryRoot, "index-batch.pid");
const countFile = join(temporaryRoot, "index-batch.count");
const diagnostics = [];
let app;
let page;
let appStderr = "";
let appClosed = false;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.PATH = `${helperDirectory}:${process.env.PATH ?? ""}`;
env.COMMITSCOPE_APP_DATA_DIR = appDataDir;
env.COMMITSCOPE_INDEX_GATE_REPOSITORY = fixture.repository;
env.COMMITSCOPE_INDEX_GATE_FILE = gateFile;
env.COMMITSCOPE_INDEX_BLOCK_PID_FILE = pidFile;
env.COMMITSCOPE_INDEX_BATCH_COUNT_FILE = countFile;
env.COMMITSCOPE_INDEX_BLOCK_BATCH_AFTER = "1";

try {
  await access(appEntry);
  await mkdir(profile, { recursive: true });
  await mkdir(resolve(root, "output/playwright"), { recursive: true });
  await createGitWrapper(helperDirectory);
  await rm(pidFile, { force: true });
  await writeFile(countFile, "0\n");
  await writeFile(gateFile, "hold second metadata batch\n");

  app = await launchApp();
  page = await app.firstWindow();
  observePage(page);
  const initialSession = await waitReady(page, fixture.mainTip, "HEAD");

  const input = page.getByTestId("search-input");
  await waitForFile(pidFile);
  const partialStatus = await waitIndexStatus(page, status => status.state === "running" && status.coverage.processed >= 64);
  assert.ok(partialStatus.coverage.processed < fixture.oids.length);
  await input.fill("common searchable marker");
  await waitSearch(page, text => text.startsWith("部分结果"));
  assert.match(await page.getByTestId("search-results").innerText(), /索引仍在构建/u);
  assert.equal(await currentSearchResultCount(page), partialStatus.coverage.processed,
    "the partial message query returns exactly the indexed prefix matches");
  await page.getByTestId("search-result-" + (await topVisibleResultOid(page))).waitFor({ state: "visible" });
  const selectedOid = await topVisibleResultOid(page);
  await page.getByTestId(`search-result-${selectedOid}`).click();
  const anchorBefore = await captureViewportAnchor(page);
  assert.ok(anchorBefore?.oid, "partial result list reports a real top viewport anchor");
  await page.screenshot({ path: resolve(root, "output/playwright/p1-06-search-partial.png") });

  await openIndexStatus(page);
  await page.getByTestId("index-action-pause").click();
  const paused = await waitIndexStatus(page, status => status.state === "paused");
  assert.equal(paused.coverage.complete, false);
  await waitSearch(page, text => text.startsWith("部分结果"));
  await page.getByText("部分结果 · 索引已暂停", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await currentSearchResultCount(page), partialStatus.coverage.processed,
    "search remains useful on the committed prefix after index pause");

  await rm(gateFile, { force: true });
  await writeFile(countFile, "0\n");
  await openIndexStatus(page);
  await page.getByTestId("index-action-resume").click();
  const complete = await waitIndexStatus(page, status => status.state === "complete", 90_000);
  assert.equal(complete.coverage.processed, fixture.oids.length);
  await waitSearch(page, text => text.startsWith(`最终结果 · ${fixture.oids.length} 条`), 45_000);
  const selected = page.getByTestId(`search-result-${selectedOid}`);
  await selected.waitFor({ state: "visible" });
  assert.equal(await selected.getAttribute("aria-selected"), "true", "the selected partial result stays selected after a new version inserts a root row");
  const anchorAfter = await waitForViewportAnchor(page, anchorBefore.oid, 5_000);
  assert.ok(Math.abs(anchorAfter.offset - anchorBefore.offset) <= 3, "partial refresh preserves the top result's viewport pixel offset");
  await page.screenshot({ path: resolve(root, "output/playwright/p1-06-search-final.png") });
  await input.fill("late-sorting root");
  await waitSearchCount(page, 1);
  assert.equal(await topVisibleResultOid(page), fixture.rootOid, "the late-indexed future-time root sorts first after index completion");
  await input.fill("common searchable marker");
  await waitSearchCount(page, fixture.oids.length);

  // Walk deep pages through user controls and verify that the renderer remains virtualized/bounded.
  const resultList = page.getByTestId("search-results").getByRole("listbox");
  for (let index = 0; index < 10; index += 1) {
    const next = resultList.getByRole("button", { name: "读取后续结果" });
    if (!(await next.count())) break;
    const beforeHeight = await resultList.evaluate(element => element.scrollHeight);
    await next.click();
    await waitUntil(async () => {
      const current = await resultList.evaluate(element => ({ height: element.scrollHeight, busy: element.getAttribute("aria-busy") }));
      return current.busy === "false" && (current.height > beforeHeight || index >= 8) ? true : null;
    }, `search page ${index + 1} loaded`, 30_000);
  }
  const listDiagnostics = await resultList.evaluate(element => ({
    rows: element.querySelectorAll("[data-testid^='search-result-']").length,
    scrollHeight: element.scrollHeight,
    viewportHeight: element.clientHeight,
  }));
  assert.ok(listDiagnostics.rows <= 40, `virtualized list renders a bounded DOM window (${listDiagnostics.rows} rows)`);
  assert.ok(listDiagnostics.scrollHeight <= 2_000 * 62 + 5_000, `loaded result window remains bounded (${listDiagnostics.scrollHeight}px)`);

  // Add two Authors (OR), then one Committer; message/identity fields combine with AND.
  await page.getByTestId("search-clear").click();
  await addSearchCondition(page, "author");
  const authorInput = page.getByLabel("搜索Author姓名或邮箱");
  await authorInput.fill("Search");
  await page.getByTestId("search-identity-author-0").waitFor({ state: "visible" });
  await page.getByTestId("search-identity-author-0").click();
  await page.getByText("Bob Search", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("option", { name: /Bob Search/u }).click();
  await addSearchCondition(page, "committer");
  const committerInput = page.getByLabel("搜索Committer姓名或邮箱");
  await committerInput.fill("Committer");
  await page.getByRole("option", { name: /Xavier Committer/u }).waitFor({ state: "visible" });
  await page.getByRole("option", { name: /Xavier Committer/u }).click();
  await input.fill("common searchable marker");
  const expectedCombined = [...fixture.commits.values()].filter(commit =>
    commit.message.includes("common searchable marker") &&
    ["Alice Search", "Bob Search"].includes(commit.author.name) && commit.committer.name === "Xavier Committer");
  await waitSearchCount(page, expectedCombined.length);
  assert.equal(await currentSearchResultCount(page), expectedCombined.length,
    "two Author choices OR together and combine with message and Committer by AND");
  await page.screenshot({ path: resolve(root, "output/playwright/p1-06-search-filters.png") });

  // Author-time sorting and a local-calendar date range are both applied through the filter UI.
  await page.getByTestId("search-clear").click();
  await addSearchCondition(page, "author-time");
  await input.fill("common searchable marker");
  const authorSorted = [...fixture.commits.values()].sort((left, right) =>
    right.author.timestamp - left.author.timestamp || left.oid.localeCompare(right.oid, "en"));
  await waitSearchCount(page, authorSorted.length);
  assert.equal(await topVisibleResultOid(page), authorSorted[0].oid, "the UI Author time field changes the result ordering");

  await addSearchCondition(page, "time");
  const date = new Date(fixture.commits.get(fixture.mainTip).author.timestamp * 1_000);
  const dateValue = await page.evaluate(seconds => {
    const value = new Date(seconds * 1_000);
    const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
    const part = name => parts.find(item => item.type === name).value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }, fixture.commits.get(fixture.mainTip).author.timestamp);
  const fromDate = page.getByLabel("开始日期");
  const toDate = page.getByLabel("结束日期（含当天）");
  await fromDate.fill(dateValue);
  await toDate.fill(dateValue);
  await page.getByRole("button", { name: "应用日期范围" }).click();
  const localStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1_000;
  const localEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() / 1_000;
  const expectedDateRows = fixture.oids.map(oid => fixture.commits.get(oid)).filter(commit =>
    commit.author.timestamp >= localStart && commit.author.timestamp < localEnd);
  await waitSearchCount(page, expectedDateRows.length);
  assert.ok(expectedDateRows.length > 0, `local date range for ${date.toISOString().slice(0, 10)} has fixture hits`);
  assert.match(await page.getByTestId("search-filter-time").innerText(), /本地日历区间/u);

  // OID uses a full user-entered prefix; then a scope switch and refresh preserve the message condition.
  await ensureFilterOpen(page);
  await page.getByTestId("search-filter-time").locator("xpath=..").getByRole("button", { name: "移除此筛选条件" }).click();
  await addSearchCondition(page, "hash");
  const chosenOid = fixture.mainTip;
  await page.getByTestId("search-filter-hash").fill(chosenOid.slice(0, 8));
  await waitSearchCount(page, 1);
  assert.equal(await currentSearchResultCount(page), 1, "OID filter narrows to the exact matching full object id");
  assert.equal(await topVisibleResultOid(page), chosenOid);
  await page.getByTestId("search-clear").click();
  await input.fill("common searchable marker");
  await waitSearchCount(page, fixture.oids.length);
  await page.getByTestId("scope-picker").click();
  await page.getByTestId("scope-option-ref-refs/heads/pre-merge").click();
  const scopedSession = await waitSession(page, session => session.scope?.ref === "refs/heads/pre-merge");
  assert.equal(scopedSession.repositoryKey, initialSession.repositoryKey);
  assert.equal(scopedSession.worktreeId, initialSession.worktreeId, "changing scope preserves the main window worktree identity");
  await waitSearchCount(page, fixture.preMergeOids.length, 90_000);
  const scopeGeneration = scopedSession.generation;
  await page.getByRole("button", { name: "刷新仓库历史" }).click();
  await waitSession(page, session => session.scope?.ref === "refs/heads/pre-merge" && session.generation !== scopeGeneration);
  await waitSearchCount(page, fixture.preMergeOids.length, 90_000);
  await page.getByTestId("search-clear").click();
  await assertHistoryVisible(page, fixture.preMergeTip);
  await page.screenshot({ path: resolve(root, "output/playwright/p1-06-search-history-restored.png") });

  // An in-progress IME composition must not submit a search before compositionend.
  await input.dispatchEvent("compositionstart", { data: "中文" });
  await input.fill("中文");
  await delay(400);
  assert.doesNotMatch(await page.getByTestId("search-status").innerText(), /最终结果|正在搜索/u,
    "IME composition neither submits a request nor displays a final result before compositionend");
  await input.dispatchEvent("compositionend", { data: "中文" });
  await waitSearchCount(page, 1);
  const chineseOid = fixture.unicodeOids.chinese[0];
  await page.getByTestId(`search-result-${chineseOid}`).waitFor({ state: "visible" });
  assert.equal(await currentSearchResultCount(page), 1);
  await page.getByTestId("search-clear").click();
  await assertHistoryVisible(page, fixture.preMergeTip);

  await page.getByTestId("scope-picker").click();
  await page.getByTestId("scope-option-head").click();
  await waitSession(page, session => session.scope === "head");
  await scrollHistoryToTop(page);
  await waitReady(page, fixture.mainTip, "HEAD");
  await waitIndexStatus(page, status => status.state === "complete", 90_000);
  await app.close();
  app = null;
  const databasePath = await locateDatabase(appDataDir);
  await writeFile(databasePath, Buffer.from("broken metadata search cache\n"));

  app = await launchApp();
  page = await app.firstWindow();
  observePage(page);
  await waitReady(page, fixture.mainTip, "HEAD");
  await assertHistoryVisible(page, fixture.mainTip);
  await page.getByTestId("search-input").fill("common searchable marker");
  const failedIndex = await waitIndexStatus(page, status => ["failed", "unavailable"].includes(status.state));
  assert.ok(failedIndex.error);
  await openIndexStatus(page);
  const indexError = page.getByTestId("index-error");
  await indexError.waitFor({ state: "visible" });
  assert.match(await indexError.innerText(), /历史仍可浏览/u);
  await page.screenshot({ path: resolve(root, "output/playwright/p1-06-search-index-error.png") });

  await page.keyboard.press("Escape");
  await page.getByTestId("search-clear").click();
  await assertHistoryVisible(page, fixture.mainTip);
  await page.getByTestId("search-input").fill("common searchable marker");
  await openIndexStatus(page);
  await page.getByTestId("index-error").waitFor({ state: "visible" });
  await page.getByTestId("index-action-rebuild").click();
  const rebuilt = await waitIndexStatus(page, status => status.state === "complete", 90_000);
  assert.equal(rebuilt.coverage.processed, fixture.oids.length);
  const retry = page.getByRole("button", { name: "重试搜索" });
  if (await retry.count()) await retry.click();
  await waitSearchCount(page, fixture.oids.length, 45_000);
  await page.getByTestId("search-input").fill("late-sorting root");
  await waitSearchCount(page, 1);
  assert.equal(await topVisibleResultOid(page), fixture.rootOid);
  await page.getByTestId("search-clear").click();
  await assertHistoryVisible(page, fixture.mainTip);

  await app.close();
  app = null;
  appClosed = true;
  assert.deepEqual(await snapshotTree(fixture.repository), repositoryBefore, "Electron search leaves the fixture Git repository unchanged");
  process.stdout.write(`Electron metadata search smoke passed: ${fixture.oids.length} full-text results; partial pause/resume and anchor; deep virtualized paging; Author OR/Committer AND; Author time, local dates, OID, scope/refresh and history restore.\n`);
} catch (error) {
  diagnostics.unshift(`smoke error: ${error.stack ?? error.message}`);
  if (page) {
    try { diagnostics.push("session: " + JSON.stringify(await currentSession(page))); } catch (e) { diagnostics.push("session query: " + String(e)); }
    try { diagnostics.push("index: " + JSON.stringify(await currentIndexStatus(page))); } catch (e) { diagnostics.push("index query: " + String(e)); }
    try { diagnostics.push("search UI: " + JSON.stringify(await page.evaluate(() => ({
      status: document.querySelector('[data-testid="search-status"]')?.textContent,
      error: document.querySelector('[role="alert"]')?.textContent,
      top: document.querySelector('[data-testid="search-results"] [data-oid]')?.getAttribute("data-oid"),
      rows: document.querySelectorAll('[data-testid^="search-result-"]').length,
    })))); } catch (e) { diagnostics.push("search DOM query: " + String(e)); }
    try { await page.screenshot({ path: resolve(root, "output/playwright/p1-06-search-failure.png") }); } catch (e) { diagnostics.push("screenshot: " + String(e)); }
  }
  diagnostics.push("app/daemon stderr:\n" + appStderr);
  await writeFile(resolve(root, "output/test/p1-06-search-smoke-diagnostics.log"), diagnostics.join("\n") + "\n");
  throw error;
} finally {
  await rm(gateFile, { force: true });
  if (!appClosed && app) await app.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function launchApp() {
  const launched = await electron.launch({
    executablePath: require("electron"),
    args: [appEntry, `--repository=${fixture.repository}`, `--user-data-dir=${profile}`],
    env,
    chromiumSandbox: true,
  });
  launched.process().stderr?.setEncoding("utf8");
  launched.process().stderr?.on("data", chunk => { appStderr = (appStderr + chunk).slice(-64 * 1024); });
  return launched;
}

function observePage(target) {
  target.on("console", message => diagnostics.push(`console ${message.type()}: ${message.text()}`));
  target.on("pageerror", error => diagnostics.push(`pageerror: ${error.stack}`));
}

async function currentSession(target) {
  const result = await target.evaluate(() => window.commitScope.getRepositorySession());
  if (!result?.ok) throw new Error(result?.error?.message ?? "repository session unavailable");
  return result.value;
}

async function currentIndexStatus(target) {
  const result = await target.evaluate(() => window.commitScope.getMetadataIndexStatus());
  if (!result?.ok) {
    const error = new Error(result?.error?.message ?? "metadata index status unavailable");
    error.code = result?.error?.code;
    throw error;
  }
  return result.value;
}

async function waitReady(target, oid, scopeName, timeoutMs = 30_000) {
  return waitUntil(async () => {
    const session = await currentSession(target);
    const ui = await target.evaluate(() => ({
      state: document.querySelector('[data-testid="preview-state"]')?.dataset.state,
      scope: document.querySelector('[data-testid="scope-picker"]')?.getAttribute("aria-label") ?? "",
      first: document.querySelector('[aria-label="提交列表"] [role="listbox"] [data-testid="commit-row"]')?.getAttribute("data-oid"),
    }));
    if (ui.state === "ready" && ui.scope.includes(scopeName) && ui.first === oid) return session;
    return null;
  }, `visible ${scopeName} history row ${oid}`, timeoutMs);
}

async function waitSession(target, predicate, timeoutMs = 30_000) {
  return waitUntil(async () => {
    const session = await currentSession(target);
    return predicate(session) ? session : null;
  }, "repository scope session", timeoutMs);
}

async function assertHistoryVisible(target, oid) {
  await waitUntil(async () => {
    const state = await target.evaluate(oid => ({
      ready: document.querySelector('[data-testid="preview-state"]')?.dataset.state === "ready",
      row: document.querySelector(`[data-testid="commit-row"][data-oid="${oid}"]`) !== null,
      search: document.querySelector('[data-testid="search-results"]') !== null,
    }), oid);
    return state.ready && state.row && !state.search;
  }, `history restored with ${oid}`);
}

async function scrollHistoryToTop(target) {
  await waitUntil(async () => target.evaluate(() => {
    const list = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
    if (!list) return null;
    list.scrollTop = 0;
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
    return list.scrollTop === 0;
  }), "history list viewport at top", 10_000);
}

async function waitSearch(target, predicate, timeoutMs = 30_000) {
  return waitUntil(async () => {
    const status = await target.getByTestId("search-status").textContent().catch(() => null);
    return status && predicate(status) ? status : null;
  }, "search status", timeoutMs);
}

async function waitSearchCount(target, expectedCount, timeoutMs = 30_000) {
  const expectedStatus = `最终结果 · ${expectedCount} 条`;
  await waitSearch(target, status => status === expectedStatus, timeoutMs);
  return expectedStatus;
}

async function currentSearchResultCount(target) {
  const status = await target.getByTestId("search-status").innerText();
  const match = status.match(/(?:最终结果|最终没有匹配提交|部分结果[^\n]*)\s*[·：]\s*(\d+)\s*条/u) ?? status.match(/(\d+)\s*条/u);
  assert.ok(match, `search status has a parseable result count: ${status}`);
  return Number(match[1]);
}

async function waitIndexStatus(target, predicate, timeoutMs = 30_000) {
  return waitUntil(async () => {
    let status;
    try { status = await currentIndexStatus(target); }
    catch (error) {
      if (["BUSY", "CANCELLED", "STALE_CONTEXT"].includes(error.code)) return null;
      throw error;
    }
    return predicate(status) ? status : null;
  }, "metadata index status", timeoutMs);
}

async function openIndexStatus(target) {
  if (!(await target.getByTestId("index-status-label").isVisible().catch(() => false))) await target.getByTestId("index-status-trigger").click();
  await target.getByTestId("index-status-label").waitFor({ state: "visible" });
}

async function ensureFilterOpen(target) {
  const popover = target.getByTestId("search-filter-popover");
  if (!(await popover.isVisible().catch(() => false))) {
    await target.getByTestId("search-filter-trigger").click();
    await popover.waitFor({ state: "visible" });
  }
}

async function addSearchCondition(target, value) {
  await ensureFilterOpen(target);
  await target.getByTestId("search-add-condition").selectOption(value);
}

async function topVisibleResultOid(target) {
  return target.evaluate(() => {
    const list = document.querySelector('[data-testid="search-results"] [role="listbox"]');
    if (!list) return null;
    const listRect = list.getBoundingClientRect();
    const rows = [...list.querySelectorAll("[data-oid]")].map(row => ({
      oid: row.getAttribute("data-oid"), rect: row.getBoundingClientRect(),
    })).filter(item => item.rect.bottom > listRect.top && item.rect.top < listRect.bottom);
    rows.sort((left, right) => left.rect.top - right.rect.top);
    return rows[0]?.oid ?? null;
  });
}

async function captureViewportAnchor(target) {
  return target.evaluate(() => {
    const list = document.querySelector('[data-testid="search-results"] [role="listbox"]');
    if (!list) return null;
    const listRect = list.getBoundingClientRect();
    const rows = [...list.querySelectorAll("[data-oid]")].map(row => ({
      oid: row.getAttribute("data-oid"), rect: row.getBoundingClientRect(),
    })).filter(item => item.rect.bottom > listRect.top + 1 && item.rect.top < listRect.bottom);
    rows.sort((left, right) => left.rect.top - right.rect.top);
    return rows[0] ? { oid: rows[0].oid, offset: rows[0].rect.top - listRect.top } : null;
  });
}

async function waitForViewportAnchor(target, oid, timeoutMs) {
  return waitUntil(async () => {
    const anchor = await captureViewportAnchor(target);
    return anchor?.oid === oid ? anchor : null;
  }, `viewport anchor ${oid}`, timeoutMs);
}

async function waitForFile(path, timeoutMs = 15_000) {
  return waitUntil(async () => { try { await access(path); return true; } catch { return null; } }, `gate file ${path}`, timeoutMs);
}

async function locateDatabase(appDataDir) {
  const matches = [];
  const pending = [appDataDir];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === "index.sqlite3") matches.push(path);
    }
  }
  assert.equal(matches.length, 1, `expected one per-repository index database under ${appDataDir}`);
  return matches[0];
}

async function waitUntil(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last !== null && last !== false) return last;
    } catch (error) { last = String(error.message ?? error); }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(last)}`);
}

async function createGitWrapper(directory) {
  if (process.platform === "win32") throw new Error("Search smoke's Git batch gate requires a Unix-like shell");
  await mkdir(directory, { recursive: true });
  const realGit = spawnSync("/usr/bin/env", ["which", "git"], { encoding: "utf8" }).stdout.trim();
  if (!realGit) throw new Error("Could not find the real Git executable");
  const wrapper = join(directory, "git");
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const body = [
    "#!/bin/sh",
    "target=''",
    "previous=''",
    "is_metadata_batch='false'",
    "for argument in \"$@\"; do",
    "  if [ \"$previous\" = '-C' ]; then target=\"$argument\"; fi",
    "  case \"$argument\" in --batch=*) is_metadata_batch='true' ;; esac",
    "  previous=\"$argument\"",
    "done",
    "input_file=''",
    "if [ \"$is_metadata_batch\" = 'true' ] && [ \"$target\" = \"$COMMITSCOPE_INDEX_GATE_REPOSITORY\" ]; then",
    "  input_file=$(mktemp); cat > \"$input_file\"",
    "  batch_limit=$(wc -l < \"$input_file\" | tr -d ' ')",
    "  if [ \"$batch_limit\" -eq 64 ]; then",
    "    count=0; [ ! -f \"$COMMITSCOPE_INDEX_BATCH_COUNT_FILE\" ] || count=$(cat \"$COMMITSCOPE_INDEX_BATCH_COUNT_FILE\")",
    "    count=$((count + 1)); printf '%s\\n' \"$count\" > \"$COMMITSCOPE_INDEX_BATCH_COUNT_FILE\"",
    "    if [ -e \"$COMMITSCOPE_INDEX_GATE_FILE\" ] && [ \"$count\" -gt \"${COMMITSCOPE_INDEX_BLOCK_BATCH_AFTER:-999999}\" ]; then",
    "      printf '%s\\n' \"$$\" > \"$COMMITSCOPE_INDEX_BLOCK_PID_FILE\"",
    "      while [ -e \"$COMMITSCOPE_INDEX_GATE_FILE\" ]; do /bin/sleep 0.02; done",
    "    fi",
    "  fi",
    "fi",
    "if [ -n \"$input_file\" ]; then " + quote(realGit) + " \"$@\" < \"$input_file\"; status=$?; rm -f \"$input_file\"; exit $status; fi",
    "exec " + quote(realGit) + " \"$@\"",
  ].join("\n") + "\n";
  await writeFile(wrapper, body, { mode: 0o700 });
  await chmod(wrapper, 0o700);
}
