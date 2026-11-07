#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";
import { createDetailsFixture, git } from "../details/fixture.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const screenshotDirectory = resolve(root, "output/playwright");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-details-smoke-"));
const fixture = await createDetailsFixture(join(temporaryRoot, "fixture"));
const repository = fixture.repository;
const profile = join(temporaryRoot, "user-data");
let app;
let page;
let closed = false;

try {
  await mkdir(screenshotDirectory, { recursive: true });
  const before = await snapshotTree(repository);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: require("electron"),
    args: [appEntry, `--repository=${repository}`, `--user-data-dir=${profile}`],
    cwd: root,
    env,
    chromiumSandbox: true,
    timeout: 30_000,
  });
  page = await app.firstWindow();
  await page.bringToFront();
  await page.locator('[data-testid="preview-state"][data-state="ready"]').waitFor({ state: "visible", timeout: 30_000 });
  const list = page.locator('[aria-label="提交列表"] [role="listbox"]');
  await list.waitFor({ state: "visible" });
  await page.getByTestId("commit-row").first().waitFor({ state: "visible" });
  const initialBudget = await readSummaryBudget(page);
  assert.ok(initialBudget.loaded <= 1_800, `main summary window exceeds its reservation: ${JSON.stringify(initialBudget)}`);

  const mergeRow = page.locator(`[data-testid="commit-row"][data-oid="${fixture.merge}"]`);
  if (await mergeRow.count() === 0) {
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await mergeRow.waitFor({ state: "visible", timeout: 15_000 });
  }
  await mergeRow.click();
  await page.getByTestId("commit-detail-message").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("commit-detail-trailers").waitFor({ state: "visible", timeout: 10_000 });
  assert.match(await page.getByTestId("commit-detail-message").textContent(), /This is still body text\./u,
    "the full message keeps body text outside the trailer block");
  const trailerSection = page.getByTestId("commit-detail-trailers");
  assert.equal(await trailerSection.getByText("Reviewed-by", { exact: true }).count(), 2, "duplicate final trailers remain visible");
  assert.equal(await trailerSection.getByText(/Ada Reviewer/).count(), 2);
  assert.equal(await trailerSection.getByText(/Body Text/).count(), 0, "middle body trailer-looking text is not moved into the trailer section");
  assert.equal(await page.getByTestId("commit-update-hint").count(), 0,
    "an unchanged commit does not display the affected-scope hint");

  const visibleParent = page.locator('[data-testid="overview-parent-selector"]:visible').first();
  await visibleParent.selectOption("0");
  await page.getByRole("tab", { name: /文件改动/ }).click();
  const fileRows = page.getByTestId("changed-file-row");
  await fileRows.first().waitFor({ state: "visible" });
  assert.ok(await fileRows.filter({ hasText: "vendor/module" }).count());
  const previousParent = await page.locator('[data-testid="file-parent-selector"]:visible').first().inputValue();
  await page.locator('[data-testid="file-parent-selector"]:visible').first().selectOption("1");
  await page.getByText("main-added.txt", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  assert.notEqual(await page.locator('[data-testid="file-parent-selector"]:visible').first().inputValue(), previousParent, "switching parent changes the selected baseline");
  assert.ok(await page.getByTestId("changed-file-row").count() < 200, "the UI shows only the current bounded file page");

  await page.getByRole("tab", { name: "概览", exact: true }).click();
  await list.evaluate(element => { element.scrollTop = 0; });
  const octopusRow = page.locator(`[data-testid="commit-row"][data-oid="${fixture.octopus}"]`);
  await octopusRow.waitFor({ state: "visible", timeout: 15_000 });
  await octopusRow.click();
  await page.getByRole("heading", { name: "Octopus release", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  const mergeGroup = page.getByTestId("merge-parent-selector");
  await mergeGroup.waitFor({ state: "visible" });
  await mergeGroup.selectOption("1");
  await page.getByText("本组 205 个提交。", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
  const mergePage = page.getByTestId("merge-commit-page");
  await mergePage.waitFor({ state: "visible" });
  assert.equal(await mergePage.getByTestId("merge-commit-row").count(), 200, "a merge group is limited to one 200-summary page");
  const budgetDuringMerge = await readSummaryBudget(page);
  assert.ok(budgetDuringMerge.loaded <= 1_800 && budgetDuringMerge.merge <= 200 && budgetDuringMerge.loaded + budgetDuringMerge.merge <= 2_000,
    `history plus merge summaries exceed the shared 2000-summary budget: ${JSON.stringify(budgetDuringMerge)}`);
  await page.getByTestId("merge-page-next").click();
  await waitForDom(page, () => document.querySelectorAll('[data-testid="merge-commit-row"]').length === 5);
  assert.equal(await mergePage.getByTestId("merge-commit-row").count(), 5, "the next parent-group page replaces the prior 200 rows");
  await page.getByTestId("merge-page-previous").click();
  await waitForDom(page, () => document.querySelectorAll('[data-testid="merge-commit-row"]').length === 200);
  assert.equal(await mergePage.getByTestId("merge-commit-row").count(), 200);
  const groupTwo = await git(repository, ["rev-parse", "refs/heads/topic/b"]);
  await mergeGroup.selectOption("2");
  await mergePage.getByTestId("merge-commit-row").filter({ hasText: groupTwo.slice(0, 8) })
    .waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await mergePage.getByTestId("merge-commit-row").count(), 1, "the second octopus parent has an independent group");

  const includeButton = page.getByTestId("branches-containing-button");
  await includeButton.click();
  const containing = page.getByTestId("branches-containing-result");
  await containing.waitFor({ state: "visible", timeout: 20_000 });
  await containing.getByText("main", { exact: true }).waitFor({ state: "visible" });
  await containing.getByText("origin/main", { exact: true }).waitFor({ state: "visible" });

  // Switch the selected OID rapidly, then require detail, file baseline and merge data to identify the final selection.
  await list.evaluate(element => { element.scrollTop = 0; });
  const headRow = page.locator(`[data-testid="commit-row"][data-oid="${fixture.head}"]`);
  const wideRow = page.locator(`[data-testid="commit-row"][data-oid="${fixture.wideFiles}"]`);
  await Promise.all([headRow.waitFor({ state: "visible" }), wideRow.waitFor({ state: "visible" }), octopusRow.waitFor({ state: "visible" })]);
  await headRow.click();
  await octopusRow.click();
  await wideRow.click();
  await waitForDom(page, expectedOid => {
    const selected = document.querySelector('[aria-label="提交列表"] [role="listbox"] [data-testid="commit-row"][aria-selected="true"]');
    const title = document.querySelector('[aria-label="提交详情"] h1');
    return selected?.getAttribute("data-oid") === expectedOid && title?.textContent?.includes("Commit with more than one file page");
  }, 15_000, fixture.wideFiles);
  assert.equal(await page.locator('[aria-label="提交详情"] button[aria-label^="复制完整 OID"]').getAttribute("aria-label"),
    `复制完整 OID ${fixture.wideFiles}`, "rapid A→B→C selection leaves the final OID and detail aligned");
  await page.getByRole("tab", { name: /文件改动/ }).click();
  await page.getByRole("heading", { name: "Commit with more than one file page", exact: true })
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("file-page-next").waitFor({ state: "visible", timeout: 15_000 });
  const widePageRows = page.getByTestId("changed-file-row");
  await widePageRows.first().waitFor({ state: "visible" });
  assert.equal(await widePageRows.count(), 200);
  await page.getByTestId("file-page-next").click();
  await waitForDom(page, () => document.querySelectorAll('[data-testid="changed-file-row"]').length === 5);
  assert.equal(await widePageRows.count(), 5, "file pagination replaces the prior page rather than accumulating rows");

  await page.getByTestId("search-input").fill("Commit with more than one file page");
  const searchResult = page.getByTestId(`search-result-${fixture.wideFiles}`);
  await searchResult.waitFor({ state: "visible", timeout: 45_000 });
  await searchResult.click();
  await page.getByRole("heading", { name: "Commit with more than one file page", exact: true })
    .waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await page.locator('[aria-label="提交详情"] button[aria-label^="复制完整 OID"]').getAttribute("aria-label"),
    `复制完整 OID ${fixture.wideFiles}`, "choosing a search result opens matching commit details");
  await page.emulateMedia({ colorScheme: "light" });
  await waitForDom(page, () => document.documentElement.dataset.theme === "light", 5_000);
  await page.screenshot({ path: resolve(screenshotDirectory, "p2-02-commit-details-light.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await waitForDom(page, () => document.documentElement.dataset.theme === "dark", 5_000);
  await page.screenshot({ path: resolve(screenshotDirectory, "p2-02-commit-details-dark.png"), fullPage: true });

  await snapshotReadOnly(page, repository, before);
  const navigationBudget = await readSummaryBudget(page);
  assert.ok(navigationBudget.loaded <= 1_800 && navigationBudget.merge <= 200 && navigationBudget.loaded + navigationBudget.merge <= 2_000);
  const status = await page.evaluate(() => window.commitScope.getCoreStatus());
  assert.equal(status.state, "ready");
  const electronPid = app.process().pid;
  const daemonPid = status.core.pid;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await Promise.all([waitForExit(electronPid), waitForExit(daemonPid)]);
  await app.close();
  closed = true;
  process.stdout.write(`Commit detail Electron smoke passed: full message/trailers, parent changes, octopus groups, branchesContaining, bounded pages, rapid selection, search result detail and read-only fixture. Screenshots: output/playwright/p2-02-commit-details-{light,dark}.png\n`);
} catch (error) {
  if (page) {
    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: resolve(screenshotDirectory, "p2-02-commit-details-failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  if (!closed && app) await app.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function readSummaryBudget(currentPage) {
  return currentPage.evaluate(() => {
    const list = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
    return {
      loaded: Number(list?.dataset.loadedCount ?? 0),
      merge: document.querySelectorAll('[data-testid="merge-commit-row"]').length,
    };
  });
}

async function waitForDom(currentPage, predicate, timeoutMs = 10_000, argument) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await currentPage.evaluate(predicate, argument)) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for expected synchronous DOM state");
}

async function snapshotReadOnly(currentPage, path, expected) {
  const actual = await snapshotTree(path);
  assert.deepEqual(actual, expected, "all detail/file/merge/containing requests leave the viewed repository unchanged");
}

async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await delay(50);
  }
  throw new Error(`Process ${pid} is still alive`);
}
