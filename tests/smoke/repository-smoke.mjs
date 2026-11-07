import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const screenshotDir = resolve(root, "output/playwright");
const repository = process.argv.find(arg => arg.startsWith("--repository="))?.slice("--repository=".length);
if (!repository || !repository.startsWith("/")) throw new Error("Usage: node tests/smoke/repository-smoke.mjs --repository=<absolute-path>");
const expectedRepositoryPath = await realpath(repository);
const emptyPath = resolve(expectedRepositoryPath, "../empty");
await mkdir(screenshotDir, { recursive: true });
// A throwaway profile keeps recent / last-viewed records out of the real app data directory.
const profile = await mkdtemp(join(tmpdir(), "commitscope-smoke-profile-"));
const stateDir = join(profile, "repository-state");
const repositoriesBefore = await Promise.all([expectedRepositoryPath, emptyPath].map(snapshotTree));
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
  const previewState = page.getByTestId("preview-state");
  await previewState.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-state"]')?.getAttribute("data-state") === "ready", { timeout: 20000 });
  // The path field lives in the repository switcher popover once a repository is open.
  const switcher = page.getByRole("button", { name: /^切换仓库/ });
  await switcher.click();
  assert.equal(await page.locator("#repository-path").inputValue(), expectedRepositoryPath);
  assert.match(await page.getByTestId("previous-view").innerText(), /第一次在这个 worktree 查看/);
  await page.keyboard.press("Escape");
  const row = page.getByTestId("commit-row").first();
  await row.waitFor({ state: "visible" });
  const oid = await row.getAttribute("data-oid");
  assert.ok(oid && /^[0-9a-f]{40,64}$/i.test(oid), `expected full object id, got ${oid}`);
  assert.equal(await page.getByTestId("commit-row").count() > 0, true);
  assert.equal((await page.locator("img").count()), 0, "untrusted commit text must not create DOM elements");
  const hostileSummary = "literal <img src=x onerror=alert(1)> <script>fixture</script> & text";
  const hostileRow = page.getByTestId("commit-row").filter({ hasText: hostileSummary });
  await page.getByText(hostileSummary, { exact: true }).first().waitFor({ state: "visible" });
  assert.equal(await hostileRow.locator("img, script").count(), 0, "HTML-like commit summary must remain a text node");
  await row.click();
  await page.getByText(oid, { exact: true }).last().waitFor({ state: "visible" });
  assert.equal(await row.getAttribute("aria-selected"), "true");
  await page.getByRole("button", { name: `复制完整 OID ${oid}` }).click();
  await page.getByText("已复制", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), oid);
  const mergeRow = page.getByTestId("commit-row").filter({ hasText: "merge side into main" });
  await mergeRow.click();
  const mergeOid = await mergeRow.getAttribute("data-oid");
  const detail = page.locator('[aria-label="提交详情"]');
  await detail.getByText(mergeOid, { exact: true }).waitFor({ state: "visible" });
  assert.match(await detail.innerText(), /Merge Author/);
  assert.match(await detail.innerText(), /Merge Committer/);
  assert.match(await detail.innerText(), /Git 原始偏移 \+0000/);
  const expectedParents = execFileSync("git", ["-C", expectedRepositoryPath, "show", "-s", "--format=%P", mergeOid], { encoding: "utf8" }).trim().split(" ").filter(Boolean);
  for (const parent of expectedParents) assert.ok((await detail.innerText()).includes(parent), `selected commit details must include parent ${parent}`);
  await page.screenshot({ path: resolve(screenshotDir, "p0-03-repository-preview.png") });

  // Switching away records the HEAD that was on screen, in the app data directory only.
  const topologyHead = git(expectedRepositoryPath, "rev-parse", "HEAD");
  await switcher.click();
  await page.locator("#repository-path").fill(emptyPath);
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await page.getByText("当前 HEAD 尚无提交。", { exact: true }).waitFor({ state: "visible" });
  await waitForState(page, "ready");
  assert.equal(await page.getByTestId("commit-row").count(), 0);
  await page.screenshot({ path: resolve(screenshotDir, "p0-03-empty-repository.png") });
  const lastViewed = JSON.parse(await readFile(join(stateDir, "last-viewed-tips-v1.json"), "utf8"));
  assert.ok(lastViewed.entries.some(entry => entry.snapshot.tips.length === 1 && entry.snapshot.tips[0] === topologyHead),
    "switching away must record the topology HEAD that was shown");

  // A failed open keeps the current repository on screen and explains why.
  await page.getByRole("button", { name: /^切换仓库/ }).click();
  await page.locator("#repository-path").fill(resolve(repository, "does-not-exist"));
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await page.getByRole("alert").waitFor({ state: "visible" });
  assert.match(await page.getByRole("alert").textContent() ?? "", /NOT_A_REPOSITORY|REPOSITORY_UNAVAILABLE/);
  await waitForState(page, "ready");
  await page.getByRole("button", { name: "切换仓库：empty" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "关闭提示" }).click();
  assert.equal(await page.getByRole("alert").count(), 0);

  // Reopen from the recent list; the session now carries the earlier visit.
  await page.getByRole("button", { name: /^切换仓库/ }).click();
  const popover = page.getByRole("dialog");
  await popover.getByText("最近打开", { exact: true }).waitFor({ state: "visible" });
  await popover.getByRole("button", { name: /^topology/ }).click();
  await page.getByTestId("commit-row").first().waitFor({ state: "visible" });
  await waitForState(page, "ready");
  await page.getByRole("button", { name: "切换仓库：topology" }).click();
  assert.match(await page.getByTestId("previous-view").innerText(), new RegExp(`上次查看 .+ · 当时 HEAD ${topologyHead.slice(0, 8)}，与现在相同`));
  await page.keyboard.press("Escape");
  const recent = JSON.parse(await readFile(join(stateDir, "recent-repositories-v1.json"), "utf8"));
  assert.deepEqual(new Set(recent.repositories.map(entry => entry.path)), new Set([expectedRepositoryPath, emptyPath]));

  const security = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(security.sandbox, true);
  assert.equal(security.contextIsolation, true);
  assert.equal(app.process().spawnargs.includes("--no-sandbox"), false);
  const core = await page.evaluate(() => window.commitScope.getCoreStatus());
  assert.equal(core.state, "ready");
  const electronPid = app.process().pid;
  const daemonPid = core.core.pid;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await waitForExit(electronPid);
  await waitForExit(daemonPid);
  await app.close().catch(() => undefined);
  closed = true;
  const repositoriesAfter = await Promise.all([expectedRepositoryPath, emptyPath].map(snapshotTree));
  assert.deepEqual(repositoriesAfter, repositoriesBefore, "viewing must not write to the viewed repositories");
  process.stdout.write(`Repository UI smoke passed: ${repository}\n`);
} finally {
  if (!closed) await app.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function waitForState(page, state) {
  await page.waitForFunction(expected => document.querySelector('[data-testid="preview-state"]')?.getAttribute("data-state") === expected, state, { timeout: 15000 });
}

/** Every file and directory under `dir` with size and modification time. */
async function snapshotTree(dir) {
  const entries = [];
  const walk = async current => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      const info = await lstat(path);
      entries.push(`${path.slice(dir.length)} ${entry.isDirectory() ? "d" : info.size} ${info.mtimeMs}`);
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(dir);
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
