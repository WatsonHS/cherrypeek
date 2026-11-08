import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readdir, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const screenshotDir = resolve(root, "output/playwright");
const temp = await mkdtemp(join(tmpdir(), "commitscope-history-smoke-"));
const repository = join(temp, "repository");
const profile = join(temp, "profile");
await mkdir(repository);
await mkdir(screenshotDir, { recursive: true });
createRepository(repository, 205);
const repositoryBeforeUI = await snapshotTree(repository);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: require("electron"),
  args: [appEntry, `--repository=${repository}`, `--user-data-dir=${profile}`],
  env,
  chromiumSandbox: true,
});
let closed = false;
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-state"]')?.dataset.state === "ready", null, { timeout: 25000 });
  await page.getByTestId("commit-row").first().waitFor({ state: "visible" });
  const initialWindow = await windowMetrics(page);
  assert.equal(initialWindow.offset, 0);
  assert.equal(initialWindow.loadedCount, 200);
  assert.ok(initialWindow.domRows < initialWindow.loadedCount);
  assert.ok(initialWindow.domRows <= 60);
  assert.equal(await page.getByTestId("history-marker").count(), 0, "a first view has no new markers");

  const list = page.locator('[aria-label="提交列表"] [role="listbox"]');
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(expected => {
    const element = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
    return element && element.dataset.pageLoading === "false" && Number(element.dataset.loadedCount) === expected;
  }, 205, { timeout: 15000 });
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.locator('[aria-label="提交列表"] [role="listbox"]').getByText("Commit 5", { exact: true }).waitFor({ state: "visible" });
  const nextWindow = await windowMetrics(page);
  assert.equal(nextWindow.loadedCount, 205);
  assert.ok(nextWindow.domRows <= 60);

  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.locator('[aria-label="提交列表"] [role="listbox"]').getByText("Commit 6", { exact: true }).waitFor({ state: "visible" });
  assert.deepEqual(await snapshotTree(repository), repositoryBeforeUI, "scrolling across history pages must be read-only");

  const oldSelected = page.getByTestId("commit-row").filter({ hasText: "Commit 6" });
  await oldSelected.click();
  const oldOid = await oldSelected.getAttribute("data-oid");
  const oldSummary = await oldSelected.locator("span.truncate").first().innerText();
  assert.ok(oldOid);
  assert.equal(oldSummary, "Commit 6");
  // The anchor needs enough commits below it to be scrolled to the very top of a tall list,
  // and must stay inside the refreshed first page.
  const anchorCommitOid = git(repository, "log", "--format=%H%x09%s", "HEAD").split("\n")
    .find(line => line.endsWith("\tCommit 30"))?.split("\t", 1)[0];
  assert.ok(anchorCommitOid, "fixture should have an independently identifiable Commit 30 OID");
  // The list is virtualized: walk up from the end until the anchor row is rendered.
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const anchorCommitRow = page.locator(`[data-testid="commit-row"][data-oid="${anchorCommitOid}"]`);
  for (let step = 0; step < 20 && !(await anchorCommitRow.count()); step += 1) {
    await list.evaluate(element => { element.scrollTop -= element.clientHeight / 2; });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await anchorCommitRow.scrollIntoViewIfNeeded();
  await list.evaluate((element, oid) => {
    const row = element.querySelector(`[data-testid="commit-row"][data-oid="${CSS.escape(oid)}"]`);
    if (row) element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top;
  }, anchorCommitOid);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const anchorBeforeRefresh = await visibleAnchor(page);
  assert.equal(anchorBeforeRefresh?.oid, anchorCommitOid, "the refresh should capture Commit 30 as its visible top anchor");
  assert.ok(Math.abs(anchorBeforeRefresh.offset) <= 8, `Commit 30 should be aligned near the viewport top: ${JSON.stringify(anchorBeforeRefresh)}`);
  const newHead = await createCommit(repository, 206);
  const repositoryAfterExternalCommit = await snapshotTree(repository);
  assert.equal(newHead, git(repository, "rev-parse", "HEAD"));
  await page.getByRole("button", { name: "刷新仓库历史" }).click();
  await waitForRefreshReady(page, 200);
  assert.equal((await windowMetrics(page)).loadedCount, 200);
  await page.getByText(oldSummary, { exact: true }).last().waitFor({ state: "visible" });
  await page.getByText(/来自 .+ 的观察/).waitFor({ state: "visible" });
  await page.getByText(/这条提交不在当前已加载窗口.*不推断整个范围的可达性/).waitFor({ state: "visible" });
  const firstPageOids = git(repository, "rev-list", newHead).split("\n").slice(0, 200);
  assert.ok(firstPageOids.includes(anchorBeforeRefresh.oid), "Commit 30 must remain inside the refreshed first page");
  await page.waitForFunction(oid => document.querySelector(`[data-testid="commit-row"][data-oid="${CSS.escape(oid)}"]`),
    anchorBeforeRefresh.oid, { timeout: 5000 });
  await page.waitForFunction(({ oid, offset }) => {
    const row = document.querySelector(`[data-testid="commit-row"][data-oid="${CSS.escape(oid)}"]`);
    const container = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
    return Boolean(row && container && Math.abs(row.getBoundingClientRect().top - container.getBoundingClientRect().top - offset) <= 4);
  }, anchorBeforeRefresh, { timeout: 5000 });
  await page.locator('[aria-label="提交列表"] [role="listbox"]').evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(expected => document.querySelector('[data-testid="commit-row"]')?.getAttribute("data-oid") === expected,
    newHead, { timeout: 10000 });
  assert.equal(await page.getByTestId("commit-row").first().getAttribute("data-oid"), newHead);
  await page.getByTestId("history-marker").first().waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("history-marker").count(), 1, "the fast-forward adds one marked commit");
  assert.equal(await page.getByTestId("history-divider").count(), 1, "the consecutive new prefix has one divider");
  // The new commits can go to an agent for review straight from the divider.
  await page.getByTestId("handoff-new-commits").click();
  const handoff = page.getByTestId("handoff-dialog");
  await handoff.waitFor({ state: "visible" });
  assert.equal(await handoff.getAttribute("data-scenario"), "review-range");
  assert.match(await page.locator("#handoff-title").innerText(), /审阅这批提交 · 1 个/u);
  await page.getByTestId("handoff-close").click();
  await handoff.waitFor({ state: "hidden" });
  assert.deepEqual(await snapshotTree(repository), repositoryAfterExternalCommit, "refresh must not write to the viewed repository");
  await page.screenshot({ path: resolve(screenshotDir, "p1-03-history-refresh.png") });

  for (let index = 207; index <= 236; index += 1) createCommit(repository, index);
  const repositoryAfterMoreExternalCommits = await snapshotTree(repository);
  await list.evaluate(element => { element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight * 1.5); });
  await page.waitForTimeout(100);
  const secondAnchor = await visibleAnchor(page);
  assert.ok(secondAnchor, "second refresh should capture a visible row near the old page tail");
  const newestHead = git(repository, "rev-parse", "HEAD");
  const refreshedOids = git(repository, "rev-list", newestHead).split("\n");
  assert.ok(refreshedOids.indexOf(secondAnchor.oid) >= 200, "the chosen old tail anchor must be outside the refreshed first page");
  await page.getByRole("button", { name: "刷新仓库历史" }).click();
  await waitForRefreshReady(page, 200);
  await page.getByText("刷新后，原列表位置不在当前窗口。", { exact: true }).waitFor({ state: "visible" });
  await list.evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(expected => document.querySelector('[data-testid="commit-row"]')?.getAttribute("data-oid") === expected,
    newestHead, { timeout: 10_000 });
  assert.equal(await page.getByTestId("commit-row").first().getAttribute("data-oid"), git(repository, "rev-parse", "HEAD"));
  if (secondAnchor) {
    const loaded = await page.getByTestId("commit-row").evaluateAll((rows, oid) => rows.some(row => row.getAttribute("data-oid") === oid), secondAnchor.oid);
    assert.equal(loaded, false, "the old anchor must be outside the refreshed first window");
  }
  assert.deepEqual(await snapshotTree(repository), repositoryAfterMoreExternalCommits, "refresh must not write to the viewed repository");

  const status = await page.evaluate(() => window.commitScope.getCoreStatus());
  assert.equal(status.state, "ready");
  const electronPid = app.process().pid;
  const daemonPid = status.core.pid;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await Promise.all([waitForExit(electronPid), waitForExit(daemonPid)]);
  await app.close().catch(() => undefined);
  closed = true;
  process.stdout.write(`History pagination UI smoke passed. Screenshot: output/playwright/p1-03-history-refresh.png\n`);
} finally {
  if (!closed) await app.close().catch(() => undefined);
  await rm(temp, { recursive: true, force: true });
}

function createRepository(path, count) {
  execFileSync("git", ["init", "-q", path]);
  git(path, "config", "user.name", "History Smoke");
  git(path, "config", "user.email", "history-smoke@example.invalid");
  for (let index = 1; index <= count; index += 1) createCommit(path, index);
}

function createCommit(path, index) {
  git(path, "commit", "--allow-empty", "-qm", `Commit ${index}`);
  return git(path, "rev-parse", "HEAD");
}

function git(path, ...args) {
  return execFileSync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-C", path, ...args], { encoding: "utf8" }).trim();
}

async function windowMetrics(page) {
  return page.locator('[aria-label="提交列表"] [role="listbox"]').evaluate(element => ({
    offset: Number(element.dataset.loadedOffset),
    loadedCount: Number(element.dataset.loadedCount),
    windowPages: Number(element.dataset.windowPages),
    domRows: element.querySelectorAll('[data-testid="commit-row"]').length,
  }));
}

async function waitForRefreshReady(page, expectedCount) {
  await page.waitForFunction(expected => {
    const button = document.querySelector('button[aria-label="刷新仓库历史"]');
    const list = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
    const state = document.querySelector('[data-testid="preview-state"]');
    return button && !button.disabled && list?.dataset.pageLoading === "false" &&
      Number(list.dataset.loadedCount) === expected && state?.dataset.state === "ready";
  }, expectedCount, { timeout: 20000 });
}

async function visibleAnchor(page) {
  return page.evaluate(() => {
    const container = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
    if (!container) return null;
    const top = container.getBoundingClientRect().top;
    const row = [...container.querySelectorAll('[data-testid="commit-row"]')]
      .find(candidate => candidate.getBoundingClientRect().bottom > top);
    if (!row?.dataset.oid) return null;
    return { oid: row.dataset.oid, offset: row.getBoundingClientRect().top - top };
  });
}

async function snapshotTree(directory) {
  const entries = [];
  const walk = async current => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const info = await lstat(path);
      entries.push(`${path.slice(directory.length)} ${entry.isDirectory() ? "d" : info.size} ${info.mtimeMs}`);
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(directory);
  return entries;
}

async function waitForExit(pid, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Process ${pid} is still alive`);
}
