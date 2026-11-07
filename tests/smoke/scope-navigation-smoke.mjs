import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";
import { createNavigationFixture, git } from "../navigation/fixture.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-scope-smoke-"));
const screenshotDir = resolve(root, "output/playwright");
const fixture = await createNavigationFixture(join(temporaryRoot, "fixtures"));
await mkdir(screenshotDir, { recursive: true });
const profile = join(temporaryRoot, "electron-user-data");
await mkdir(profile, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: require("electron"),
  args: [appEntry, "--repository=" + fixture.repository, "--user-data-dir=" + profile],
  env,
  chromiumSandbox: true,
});
let closed = false;
let page;
const diagnostics = [];
let appStderr = "";
const appProcess = app.process();
appProcess.stderr?.setEncoding("utf8");
appProcess.stderr?.on("data", chunk => { appStderr = (appStderr + chunk).slice(-64 * 1024); });

try {
  page = await app.firstWindow();
  page.on("console", message => diagnostics.push("console " + message.type() + ": " + message.text()));
  page.on("pageerror", error => diagnostics.push("pageerror: " + error.stack));
  await page.evaluate(async () => {
    window.__scopeSmokeCoreEvents = [];
    window.__scopeSmokeCoreEvents.push({ at: Date.now(), status: await window.commitScope.getCoreStatus() });
    window.__scopeSmokeUnsubscribe = window.commitScope.onCoreStatusChanged(status => {
      window.__scopeSmokeCoreEvents.push({ at: Date.now(), status });
    });
  });
  const initial = await waitScope(page, { scope: "head", tip: fixture.commits.mainTip, labelPrefix: "浏览范围：HEAD · main" });
  const identity = { path: initial.repository.path, repositoryKey: initial.repositoryKey, worktreeId: initial.worktreeId };
  const linkedBefore = await snapshotTree(fixture.linkedPath);
  const bounds = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { bounds: window.getBounds(), content: window.getContentBounds() };
  });
  assert.equal(bounds.content.x, bounds.bounds.x, "the renderer content remains aligned to the native window edge");
  assert.equal(bounds.content.y, bounds.bounds.y, "no system title-bar strip was reintroduced above the app content");

  await page.getByTestId("scope-picker").click();
  await page.getByTestId("scope-option-allBranches").click();
  const allSession = await waitScope(page, { scope: "allBranches", labelPrefix: "浏览范围：全部分支" });
  assert.equal(allSession.scope, "allBranches");
  assert.ok(allSession.tips.length >= 2, "allBranches uses multiple distinct branch roots");
  const allBranchOrder = (await git(fixture.repository, ["--no-lazy-fetch", "--no-replace-objects", "--no-optional-locks", "rev-list", "--topo-order", ...allSession.tips])).split("\n").filter(Boolean);
  await waitScope(page, { scope: "allBranches", tip: allBranchOrder[0], labelPrefix: "浏览范围：全部分支" });

  await page.getByTestId("scope-picker").click();
  const remoteSnapshotLabel = page.getByText("本地引用快照 · fetch 时间未知 · 未 fetch", { exact: true });
  await remoteSnapshotLabel.scrollIntoViewIfNeeded();
  await remoteSnapshotLabel.waitFor({ state: "visible" });
  const mergedOption = page.getByTestId("scope-option-ref-refs/heads/feature/merged");
  await mergedOption.scrollIntoViewIfNeeded();
  await mergedOption.getByText("已合入", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("scope-options").getByText("本地分支 · 基准 origin/main", { exact: true }).waitFor({ state: "visible" });
  await page.screenshot({ path: join(screenshotDir, "p1-04-scope-picker.png") });
  const linkedOption = page.locator('[data-testid^="scope-option-worktree-"]').filter({ hasText: "linked worktree" }).first();
  await linkedOption.waitFor({ state: "visible" });
  const selectedWorktreeId = (await linkedOption.getAttribute("data-testid")).slice("scope-option-worktree-".length);
  await linkedOption.click();
  const worktreeSession = await waitScope(page, { scopeKey: "worktree", scopeValue: selectedWorktreeId, tip: fixture.commits.linkedTip, labelPrefix: "浏览范围：worktree ·" });
  assert.deepEqual({ path: worktreeSession.repository.path, repositoryKey: worktreeSession.repositoryKey, worktreeId: worktreeSession.worktreeId }, identity,
    "choosing another worktree changes only browsing scope, not this window's repository identity");
  assert.equal(typeof worktreeSession.scope.worktree, "string");
  assert.equal(worktreeSession.scope.worktree, selectedWorktreeId);
  assert.ok(worktreeSession.scope.worktree.length > 0);
  assert.match(await page.getByTestId("scope-picker").getAttribute("aria-label"), /^浏览范围：/);

  await page.getByTestId("scope-picker").click();
  await page.getByTestId("scope-option-ref-refs/heads/feature/merged").click();
  const refSession = await waitScope(page, { scopeKey: "ref", scopeValue: "refs/heads/feature/merged", tip: fixture.commits.merged, labelPrefix: "浏览范围：feature/merged" });
  assert.equal(refSession.scope.ref, "refs/heads/feature/merged");

  await page.getByTestId("scope-picker").click();
  await page.getByTestId("scope-option-ref-refs/tags/non-commit-tag").click();
  await page.getByTestId("scope-error").waitFor({ state: "visible", timeout: 15000 });
  const invalidTagError = await page.getByTestId("scope-error").innerText();
  assert.ok(invalidTagError.includes("non-commit-tag") && invalidTagError.includes("仍在查看") && invalidTagError.includes("feature/merged"),
    "the closed-picker error names the invalid tag and states that the prior scope remains selected");
  const afterInvalidTag = await waitScope(page, { scopeKey: "ref", scopeValue: "refs/heads/feature/merged", tip: fixture.commits.merged, labelPrefix: "浏览范围：feature/merged" });
  assert.equal(afterInvalidTag.scope.ref, "refs/heads/feature/merged", "a tag that does not peel to a commit leaves the old scope selected");

  await page.getByTestId("scope-picker").click();
  await page.getByTestId("scope-option-head").click();
  await waitScope(page, { scope: "head", tip: fixture.commits.mainTip, labelPrefix: "浏览范围：HEAD · main" });
  await page.getByTestId("scope-picker").click();
  await page.getByTestId("scope-option-ref-refs/heads/feature/merged").click();
  await waitScope(page, { scopeKey: "ref", scopeValue: "refs/heads/feature/merged", tip: fixture.commits.merged, labelPrefix: "浏览范围：feature/merged" });

  // External ref deletion is part of the post-action baseline; the app must retain the selected scope on refresh failure.
  await git(fixture.repository, ["update-ref", "-d", "refs/heads/feature/merged"]);
  const expectedAfterExternalChange = {
    repository: await snapshotTree(fixture.repository),
    remote: await snapshotTree(fixture.remote),
    linked: await snapshotTree(fixture.linkedPath),
    detached: await snapshotTree(fixture.detachedPath),
  };
  await page.getByRole("button", { name: "刷新仓库历史", exact: true }).click();
  await page.getByTestId("scope-error").waitFor({ state: "visible", timeout: 15000 });
  const refreshScopeError = await page.getByTestId("scope-error").innerText();
  assert.ok(refreshScopeError.includes("feature/merged") && refreshScopeError.includes("仍在查看"),
    "the refresh error names the removed ref and confirms the old scope remains selected");
  await page.screenshot({ path: join(screenshotDir, "p1-04-scope-error.png") });
  const afterFailure = await waitScope(page, { scopeKey: "ref", scopeValue: "refs/heads/feature/merged", tip: fixture.commits.merged, labelPrefix: "浏览范围：feature/merged" });
  assert.equal(afterFailure.scope.ref, "refs/heads/feature/merged");
  assert.deepEqual({ path: afterFailure.repository.path, repositoryKey: afterFailure.repositoryKey, worktreeId: afterFailure.worktreeId }, identity);
  await page.getByTestId("scope-picker").click();
  await page.getByTestId("scope-option-head").click();
  const headAgain = await waitScope(page, { scope: "head", tip: fixture.commits.mainTip, labelPrefix: "浏览范围：HEAD · main" });
  assert.equal(headAgain.scope, "head", "selecting HEAD after a missing ref is explicit and does not happen as refresh fallback");

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await app.close();
  closed = true;
  assert.deepEqual(await snapshotTree(fixture.repository), expectedAfterExternalChange.repository,
    "opening, changing scopes, and refreshing did not mutate repository objects/index/refs beyond the explicit external deletion");
  assert.deepEqual(await snapshotTree(fixture.remote), expectedAfterExternalChange.remote, "the app did not fetch or write the configured remote");
  assert.deepEqual(await snapshotTree(fixture.linkedPath), expectedAfterExternalChange.linked,
    "browsing the linked worktree did not write to its worktree or Git administrative files");
  assert.deepEqual(await snapshotTree(fixture.detachedPath), expectedAfterExternalChange.detached,
    "browsing detached worktree facts did not mutate its files");
  assert.deepEqual(await snapshotTree(fixture.linkedPath), linkedBefore, "linked worktree content remained unchanged by UI navigation");
  process.stdout.write("Electron scope navigation smoke passed with a real repository/worktree fixture.\n");
} catch (error) {
  diagnostics.unshift("smoke error: " + (error.stack ?? error.message));
  if (page) {
    try {
      const status = await page.evaluate(() => window.commitScope.getCoreStatus());
      diagnostics.push("core status: " + JSON.stringify(status));
      const events = await page.evaluate(() => window.__scopeSmokeCoreEvents ?? []);
      diagnostics.push("core status events: " + JSON.stringify(events));
    } catch (diagnosticError) {
      diagnostics.push("core status query failed: " + String(diagnosticError));
    }
    try {
      const session = await page.evaluate(() => window.commitScope.getRepositorySession());
      diagnostics.push("repository session: " + JSON.stringify(session));
    } catch (diagnosticError) {
      diagnostics.push("repository session query failed: " + String(diagnosticError));
    }
    try {
      const navigation = await page.evaluate(() => window.commitScope.getRepositoryNavigation());
      diagnostics.push("repository navigation: " + JSON.stringify(navigation));
    } catch (diagnosticError) {
      diagnostics.push("repository navigation query failed: " + String(diagnosticError));
    }
    try {
      const navigationError = await page.locator('[data-testid="navigation-error"]').allTextContents();
      diagnostics.push("navigation error DOM: " + JSON.stringify(navigationError));
    } catch (diagnosticError) {
      diagnostics.push("navigation error DOM query failed: " + String(diagnosticError));
    }
    try {
      const pickerLabel = await page.getByTestId("scope-picker").getAttribute("aria-label");
      diagnostics.push("scope picker label: " + pickerLabel);
    } catch (diagnosticError) {
      diagnostics.push("scope picker label query failed: " + String(diagnosticError));
    }
    try { await page.screenshot({ path: join(screenshotDir, "p1-04-scope-failure.png") }); }
    catch (diagnosticError) { diagnostics.push("failure screenshot failed: " + String(diagnosticError)); }
  }
  diagnostics.push("app process: " + JSON.stringify({ pid: appProcess.pid, exitCode: appProcess.exitCode, signalCode: appProcess.signalCode }));
  diagnostics.push("app/daemon stderr:\n" + appStderr);
  await writeFile(resolve(root, "output/test/p1-04-scope-diagnostics.log"), diagnostics.join("\n") + "\n");
  throw error;
} finally {
  if (!closed) await app.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function currentSession(page) {
  return page.evaluate(async () => {
    const result = await window.commitScope.getRepositorySession();
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  });
}

async function waitScope(page, expected) {
  const deadline = Date.now() + 20_000;
  let lastState = "no session";
  while (Date.now() < deadline) {
    try {
      const session = await currentSession(page);
      const ui = await page.evaluate(() => {
        const picker = document.querySelector('[data-testid="scope-picker"]');
        const list = document.querySelector('[aria-label="提交列表"] [role="listbox"]');
        return {
          pickerEnabled: picker instanceof HTMLButtonElement && !picker.disabled,
          pickerLabel: picker?.getAttribute("aria-label") ?? "",
          state: document.querySelector('[data-testid="preview-state"]')?.dataset.state ?? "",
          firstOid: list?.querySelector('[data-testid="commit-row"]')?.getAttribute("data-oid") ?? null,
        };
      });
      const scopeMatches = expected.scope !== undefined ? session.scope === expected.scope : session.scope?.[expected.scopeKey] === expected.scopeValue;
      if (scopeMatches && ui.pickerEnabled && ui.pickerLabel.startsWith(expected.labelPrefix) &&
        ui.state === "ready" && (!expected.tip || ui.firstOid === expected.tip)) return session;
      lastState = JSON.stringify({ scope: session.scope, ui });
    } catch (error) {
      lastState = String(error.message ?? error);
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for committed scope and matching visible history: " + lastState);
}
