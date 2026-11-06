import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const screenshotDir = resolve(root, "output/playwright");
const repository = process.argv.find(arg => arg.startsWith("--repository="))?.slice("--repository=".length);
if (!repository || !repository.startsWith("/")) throw new Error("Usage: node tests/smoke/repository-smoke.mjs --repository=<absolute-path>");
const expectedRepositoryPath = await realpath(repository);
await mkdir(screenshotDir, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: require("electron"),
  args: [appEntry, `--repository=${repository}`],
  env,
  chromiumSandbox: true,
});
let closed = false;
try {
  const page = await app.firstWindow();
  const previewState = page.getByTestId("preview-state");
  await previewState.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-state"]')?.getAttribute("data-state") === "ready", { timeout: 20000 });
  assert.equal(await page.locator("#repository-path").inputValue(), expectedRepositoryPath);
  const row = page.getByTestId("commit-row").first();
  await row.waitFor({ state: "visible" });
  const oid = await row.getAttribute("data-oid");
  assert.ok(oid && /^[0-9a-f]{40,64}$/i.test(oid), `expected full object id, got ${oid}`);
  assert.equal(await page.getByTestId("commit-row").count() > 0, true);
  assert.equal((await page.locator("img").count()), 0, "untrusted commit text must not create DOM elements");
  const hostileSummary = "literal <img src=x onerror=alert(1)> <script>fixture</script> & text";
  const hostileRow = page.getByTestId("commit-row").filter({ hasText: hostileSummary });
  await page.getByText(hostileSummary, { exact: true }).waitFor({ state: "visible" });
  assert.equal(await hostileRow.locator("img, script").count(), 0, "HTML-like commit summary must remain a text node");
  await row.click();
  await page.getByText(oid, { exact: true }).last().waitFor({ state: "visible" });
  assert.equal(await row.getAttribute("aria-selected"), "true");
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

  const emptyPath = resolve(expectedRepositoryPath, "../empty");
  await page.locator("#repository-path").fill(emptyPath);
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-state"]')?.getAttribute("data-state") === "ready", { timeout: 15000 });
  await page.getByText("当前 HEAD 尚无提交。", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("commit-row").count(), 0);
  await page.screenshot({ path: resolve(screenshotDir, "p0-03-empty-repository.png") });

  await page.locator("#repository-path").fill(resolve(repository, "does-not-exist"));
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await page.getByRole("alert").waitFor({ state: "visible" });
  assert.equal(await previewState.getAttribute("data-state"), "error");
  assert.match(await page.getByRole("alert").textContent() ?? "", /NOT_A_REPOSITORY|REPOSITORY_UNAVAILABLE/);

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
  process.stdout.write(`Repository UI smoke passed: ${repository}\n`);
} finally {
  if (!closed) await app.close().catch(() => undefined);
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
