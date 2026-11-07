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
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-state"]')?.dataset.state === "ready", { timeout: 25000 });
  await page.getByTestId("commit-row").first().waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("commit-row").count(), 200);
  await assertStatusRange(page, "1–200");

  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("Commit 5", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("commit-row").count(), 5);
  await assertStatusRange(page, "201–205");

  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await page.getByText("Commit 205", { exact: true }).first().waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("commit-row").count(), 200);
  await assertStatusRange(page, "1–200");
  assert.deepEqual(await snapshotTree(repository), repositoryBeforeUI, "paging must be read-only");

  const oldSelected = page.getByTestId("commit-row").last();
  await oldSelected.click();
  const oldOid = await oldSelected.getAttribute("data-oid");
  const oldSummary = await oldSelected.locator("span.truncate").first().innerText();
  assert.ok(oldOid);
  assert.equal(oldSummary, "Commit 6");
  createCommit(repository, 206);
  const repositoryAfterExternalCommit = await snapshotTree(repository);
  const newHead = git(repository, "rev-parse", "HEAD");
  const anchorBeforeRefresh = await visibleAnchor(page);
  await page.getByRole("button", { name: "刷新仓库历史" }).click();
  await page.getByTestId("commit-row").first().waitFor({ state: "visible" });
  await page.getByText("Commit 206", { exact: true }).first().waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("commit-row").count(), 200);
  assert.equal(await page.getByTestId("commit-row").first().getAttribute("data-oid"), newHead);
  await assertStatusRange(page, "1–200");
  await page.getByText(oldSummary, { exact: true }).last().waitFor({ state: "visible" });
  await page.getByText(/刷新前的观察/).waitFor({ state: "visible" });
  await page.getByText(/它不在当前页，不能据此判断是否已不可达/).waitFor({ state: "visible" });
  if (anchorBeforeRefresh) {
    try { await page.waitForFunction(({ oid, offset }) => {
      const row = document.querySelector(`[data-testid="commit-row"][data-oid="${CSS.escape(oid)}"]`);
      const container = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
      return Boolean(row && container && Math.abs(row.getBoundingClientRect().top - container.getBoundingClientRect().top - offset) <= 4);
    }, anchorBeforeRefresh, { timeout: 5000 }); }
    catch (error) {
      const detail = await page.evaluate(oid => ({
        expected: document.querySelector(`[data-testid="commit-row"][data-oid="${CSS.escape(oid)}"]`)?.textContent,
        rows: [...document.querySelectorAll('[data-testid="commit-row"]')].slice(185, 200).map(row => ({ oid: row.getAttribute("data-oid"), text: row.textContent })),
        anchorMissing: document.body.innerText.includes("刷新后，原列表位置不在当前页。"),
      }), anchorBeforeRefresh.oid);
      process.stderr.write(`Anchor restore diagnostic: expected ${JSON.stringify(anchorBeforeRefresh)}, actual ${JSON.stringify(await visibleAnchor(page))}, detail ${JSON.stringify(detail)}\n`);
      throw error;
    }
  }
  assert.deepEqual(await snapshotTree(repository), repositoryAfterExternalCommit, "refresh must not write to the viewed repository");
  await page.screenshot({ path: resolve(screenshotDir, "p1-02-history-pagination.png") });

  for (let index = 207; index <= 236; index += 1) createCommit(repository, index);
  const repositoryAfterMoreExternalCommits = await snapshotTree(repository);
  const secondAnchor = await visibleAnchor(page);
  await page.getByRole("button", { name: "刷新仓库历史" }).click();
  const newestHead = git(repository, "rev-parse", "HEAD");
  await page.waitForFunction(expected => document.querySelector('[data-testid="commit-row"]')?.getAttribute("data-oid") === expected,
    newestHead, { timeout: 20000 });
  await page.getByText("刷新后，原列表位置不在当前页。", { exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.getByTestId("commit-row").first().getAttribute("data-oid"), git(repository, "rev-parse", "HEAD"));
  if (secondAnchor) {
    const loaded = await page.getByTestId("commit-row").evaluateAll((rows, oid) => rows.some(row => row.getAttribute("data-oid") === oid), secondAnchor.oid);
    assert.equal(loaded, false, "the old anchor must be outside the refreshed first page");
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
  process.stdout.write(`History pagination UI smoke passed. Screenshot: output/playwright/p1-02-history-pagination.png\n`);
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
  execFileSync("git", ["-C", path, "commit", "--allow-empty", "-qm", `Commit ${index}`]);
}

function git(path, ...args) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}

async function assertStatusRange(page, range) {
  await page.waitForFunction(expected => document.querySelector('[data-testid="preview-state"]')?.textContent?.includes(expected), range, { timeout: 15000 });
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
