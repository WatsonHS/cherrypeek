#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readdir, rm, lstat, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const screenshotPath = resolve(root, "output/playwright/p1-03-virtual-history.png");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-virtual-history-smoke-"));
const repository = join(temporaryRoot, "repository");
const profile = join(temporaryRoot, "user-data");
const commitCount = 2_205;
let app;
let page;
let failure;
let originalClipboard;

try {
  await mkdir(repository);
  await createRepository(repository, commitCount);
  const headOid = git(repository, "rev-parse", "HEAD");
  const before = await snapshotTree(repository);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  app = await withTimeout(electron.launch({
    executablePath: require("electron"),
    args: [appEntry, `--repository=${repository}`, `--user-data-dir=${profile}`],
    cwd: root,
    env,
    chromiumSandbox: true,
    timeout: 30_000,
  }), 35_000, "Electron launch");
  page = await withTimeout(app.firstWindow(), 15_000, "Electron window");
  await page.bringToFront();
  originalClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-state"][data-state="ready"]'), null, { timeout: 30_000 });
  const list = page.locator('[aria-label="提交列表"] [role="listbox"]');
  await list.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const element = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
    return element && Number(element.dataset.loadedCount) > 0 && element.querySelector('[data-testid="commit-row"]');
  }, null, { timeout: 15_000 });

  const headRow = page.locator(`[data-testid="commit-row"][data-oid="${headOid}"]`);
  assert.ok(await headRow.count(), "initial top commit should be rendered");
  const initial = await readWindowMetrics(page);
  assert.ok(initial.domRows < initial.loadedCount, `virtual DOM must retain fewer rows than loaded summaries: ${JSON.stringify(initial)}`);
  assert.ok(initial.domRows <= 60, `DOM row count should stay near viewport plus overscan: ${initial.domRows}`);

  let previousEnd = initial.offset + initial.loadedCount;
  let peakLoadedCount = initial.loadedCount;
  const orderedOids = git(repository, "rev-list", "HEAD").split("\n");
  for (let request = 0; request < 20 && previousEnd < commitCount; request += 1) {
    const bottom = await list.evaluate(async element => {
      const value = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = Math.max(0, value - 2);
      await new Promise(requestAnimationFrame);
      return value;
    });
    const anchorAtBottom = await visibleListAnchor(page);
    await list.evaluate((element, target) => { element.scrollTop = target; }, bottom);
    try {
      await page.waitForFunction(previous => {
        const element = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
        if (!element) return false;
        const end = Number(element.dataset.loadedOffset) + Number(element.dataset.loadedCount);
        return end > previous || document.querySelector('[role="alert"]') !== null;
      }, previousEnd, { timeout: 10_000 });
    } catch (error) {
      const diagnostic = { ...(await readScrollDiagnostic(page).catch(() => ({}))), anchorAtBottom };
      throw new Error(`forward scroll did not load beyond ${previousEnd}: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const next = await readWindowMetrics(page);
    assert.ok(next.loadedCount <= 2_000, `retained summaries exceeded the 2000 commit cap: ${JSON.stringify(next)}`);
    peakLoadedCount = Math.max(peakLoadedCount, next.loadedCount);
    assert.ok(next.domRows <= 60, `virtual DOM expanded beyond viewport plus overscan: ${next.domRows}`);
    assert.ok(next.offset + next.loadedCount >= previousEnd, "forward window moved without losing its latest loaded boundary");
    if (anchorAtBottom) {
      try {
        await page.waitForFunction(oid => document.querySelector(`[data-testid="commit-row"][data-oid="${CSS.escape(oid)}"]`),
          anchorAtBottom.oid, { timeout: 5000 });
      } catch (error) {
        const diagnostic = {
          anchorBefore: anchorAtBottom,
          windowAfter: next,
          visibleAnchorAfter: await visibleListAnchor(page).catch(() => null),
          scrollAfter: await readScrollDiagnostic(page).catch(() => null),
        };
        throw new Error(`visible anchor ${anchorAtBottom.oid} disappeared across append/eviction: ${JSON.stringify(diagnostic)}`, { cause: error });
      }
      const afterAnchor = await page.locator(`[data-testid="commit-row"][data-oid="${anchorAtBottom.oid}"]`).evaluate((row, containerTop) =>
        row.getBoundingClientRect().top - containerTop,
      await list.evaluate(element => element.getBoundingClientRect().top));
      assert.ok(Math.abs(afterAnchor - anchorAtBottom.offset) <= 4,
        `window append/eviction moved visible OID ${anchorAtBottom.oid}: before=${anchorAtBottom.offset}, after=${afterAnchor}, window=${JSON.stringify(next)}`);
    }
    previousEnd = next.offset + next.loadedCount;
  }
  assert.equal(previousEnd, commitCount, `should traverse to the end of ${commitCount} commits; got ${previousEnd}`);
  const afterForward = await readWindowMetrics(page);
  assert.equal(peakLoadedCount, 2_000, "the forward traversal should exercise whole-page eviction at the cache cap");
  assert.ok(afterForward.loadedCount <= 2_000, "the final short page can evict a whole page and leave fewer than 2000 retained summaries");
  assert.ok(afterForward.offset > 0, "the retained window should have evicted the oldest page");

  const firstVisibleRow = page.getByTestId("commit-row").first();
  await firstVisibleRow.click();
  const selectedBeforeArrow = await list.locator('[data-testid="commit-row"][aria-selected="true"]').getAttribute("data-oid");
  const selectedIndex = orderedOids.indexOf(selectedBeforeArrow);
  assert.ok(selectedIndex >= 0 && selectedIndex + 1 < orderedOids.length, "selected OID should have a following history row");
  await list.press("ArrowDown");
  const selectedAfterArrow = await list.locator('[data-testid="commit-row"][aria-selected="true"]').getAttribute("data-oid");
  assert.equal(selectedAfterArrow, orderedOids[selectedIndex + 1], "ArrowDown should select the next OID in Git topo order");
  await list.evaluate(element => { element.scrollTop = 0; });
  let offset = afterForward.offset;
  for (let request = 0; request < 20 && offset > 0; request += 1) {
    await list.evaluate(element => { element.scrollTop = 0; });
    await page.waitForFunction(previous => {
      const element = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
      return element && Number(element.dataset.loadedOffset) < previous;
    }, offset, { timeout: 10_000 });
    const next = await readWindowMetrics(page);
    assert.ok(next.loadedCount <= 2_000);
    assert.ok(next.domRows <= 60);
    offset = next.offset;
  }
  assert.equal(offset, 0, "reverse traversal should re-read an evicted earlier page");
  await list.evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(expected => document.querySelector('[data-testid="commit-row"][data-oid="' + CSS.escape(expected) + '"]'), headOid, { timeout: 10_000 });
  const head = page.locator(`[data-testid="commit-row"][data-oid="${headOid}"]`);
  await head.click();
  const previousButton = page.getByRole("button", { name: "上一页", exact: true });
  const nextButton = page.getByRole("button", { name: "下一页", exact: true });
  assert.equal(await previousButton.isDisabled(), true, "selecting HEAD must activate the first history page");
  const countBeforeNavigation = (await readWindowMetrics(page)).loadedCount;
  await nextButton.click();
  await page.waitForFunction(expected => document.querySelector('[data-testid="commit-row"][aria-selected="true"]')?.getAttribute("data-oid") === expected,
    orderedOids[200], { timeout: 5000 });
  assert.equal((await readWindowMetrics(page)).loadedCount, countBeforeNavigation,
    "navigating to the already loaded next page must not request or append another page");
  await list.evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(expected => document.querySelector('[data-testid="commit-row"][data-oid="' + CSS.escape(expected) + '"]'), headOid, { timeout: 5000 });
  await page.locator(`[data-testid="commit-row"][data-oid="${headOid}"]`).click();
  const copyButton = page.getByRole("button", { name: /复制完整 OID/ });
  await copyButton.click();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.equal(copied, headOid, "copy must retain the full OID after window eviction and reload");
  assert.deepEqual(await snapshotTree(repository), before, "virtual browsing must not write to the viewed repository");
  await mkdir(resolve(root, "output/playwright"), { recursive: true });
  await page.screenshot({ path: screenshotPath });

  const status = await page.evaluate(() => window.commitScope.getCoreStatus());
  assert.equal(status.state, "ready");
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), originalClipboard);
  await app.close();
  app = undefined;
  process.stdout.write(`Virtual history Electron smoke passed: ${commitCount} commits, 2000-summary cap, reverse re-read, keyboard, copy, read-only repository. Screenshot: ${screenshotPath}\n`);
} catch (error) {
  failure = error;
  if (page) {
    await mkdir(resolve(root, "output/playwright"), { recursive: true });
    await page.screenshot({ path: screenshotPath }).catch(() => {});
  }
  throw error;
} finally {
  if (app) {
    if (originalClipboard !== undefined) await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), originalClipboard).catch(() => {});
    try { await withTimeout(app.close(), 10_000, "Electron close"); }
    catch (error) { app.process().kill("SIGKILL"); failure ??= error; }
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function createRepository(path, count) {
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", path], { env: cleanGitEnvironment(), timeout: 5000 });
  const chunks = [];
  for (let index = 1; index <= count; index += 1) {
    const message = `Virtual history smoke ${String(index).padStart(4, "0")}`;
    const timestamp = 1_800_000_000 + index;
    chunks.push(`commit refs/heads/main\nmark :${index}\nauthor Virtual Smoke <virtual@example.invalid> ${timestamp} +0000\ncommitter Virtual Smoke <virtual@example.invalid> ${timestamp} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${index > 1 ? `from :${index - 1}\n` : ""}\n`);
  }
  chunks.push("done\n");
  await runFastImport(path, chunks.join(""));
  assert.equal(Number(git(path, "rev-list", "--count", "HEAD")), count);
}

function runFastImport(path, input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", ["-C", path, "-c", "core.fsmonitor=false", "fast-import", "--quiet"], { cwd: root, env: cleanGitEnvironment(), stdio: ["pipe", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16 * 1024); });
    child.stdin.on("error", () => {});
    const timeout = setTimeout(() => killGroup(child, "SIGKILL"), 30_000);
    child.once("error", error => { clearTimeout(timeout); rejectRun(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) return rejectRun(new Error(`fast-import exited ${code ?? signal}: ${stderr}`));
      resolveRun();
    });
    child.stdin.end(input);
  });
}

function git(path, ...args) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", env: cleanGitEnvironment(), timeout: 10_000 }).trim();
}

function cleanGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}

async function readWindowMetrics(page) {
  return page.locator('[aria-label="提交列表"] [role="listbox"]').evaluate(element => ({
    offset: Number(element.dataset.loadedOffset),
    loadedCount: Number(element.dataset.loadedCount),
    windowPages: Number(element.dataset.windowPages),
    domRows: element.querySelectorAll('[data-testid="commit-row"]').length,
  }));
}

async function visibleListAnchor(page) {
  return page.locator('[aria-label="提交列表"] [role="listbox"]').evaluate(element => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll('[data-testid="commit-row"]')]
      .find(candidate => candidate.getBoundingClientRect().bottom > top);
    if (!row?.dataset.oid) return null;
    return { oid: row.dataset.oid, offset: row.getBoundingClientRect().top - top };
  });
}

async function readScrollDiagnostic(page) {
  return page.evaluate(() => {
    const element = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
    return {
      offset: element?.dataset.loadedOffset,
      loadedCount: element?.dataset.loadedCount,
      windowPages: element?.dataset.windowPages,
      pageLoading: element?.dataset.pageLoading,
      scrollTop: element?.scrollTop,
      clientHeight: element?.clientHeight,
      scrollHeight: element?.scrollHeight,
      alert: document.querySelector('[role="alert"]')?.textContent,
      listStatus: element?.parentElement?.textContent?.slice(0, 400),
    };
  });
}

async function snapshotTree(directory) {
  const result = [];
  const walk = async current => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const info = await lstat(path);
      const relative = path.slice(directory.length);
      result.push({ relative, mode: info.mode & 0o777, size: info.size, mtimeMs: info.mtimeMs, kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file", target: entry.isSymbolicLink() ? await readlink(path) : null });
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(directory);
  return result;
}

function killGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  } else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function withTimeout(promise, timeoutMs, operation) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs); })]).finally(() => clearTimeout(timer));
}
