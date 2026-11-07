import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";
import { createMetadataFixture } from "../indexing/fixture.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-index-smoke-"));
const fixture = await createMetadataFixture(join(temporaryRoot, "fixtures"), { count: 180 });
const repositoryBefore = await snapshotTree(fixture.repository);
const profile = join(temporaryRoot, "electron-user-data");
const helperDirectory = join(temporaryRoot, "git-wrapper");
const gateFile = join(temporaryRoot, "index-batch.gate");
const pidFile = join(temporaryRoot, "index-batch.pid");
const countFile = join(temporaryRoot, "index-batch.count");
await mkdir(profile, { recursive: true });
await mkdir(resolve(root, "output/playwright"), { recursive: true });
await createGitWrapper(helperDirectory);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.PATH = `${helperDirectory}:${process.env.PATH ?? ""}`;
env.COMMITSCOPE_INDEX_GATE_REPOSITORY = fixture.repository;
env.COMMITSCOPE_INDEX_GATE_FILE = gateFile;
env.COMMITSCOPE_INDEX_BLOCK_PID_FILE = pidFile;
env.COMMITSCOPE_INDEX_BATCH_COUNT_FILE = countFile;
env.COMMITSCOPE_INDEX_BLOCK_BATCH_AFTER = "2";
env.COMMITSCOPE_APP_DATA_DIR = join(profile, "repository-state");

let app;
let page;
let closed = false;
let appStderr = "";
const diagnostics = [];

try {
  await rm(pidFile, { force: true });
  await writeFile(countFile, "0\n");
  await writeFile(gateFile, "hold third 64-commit index batch\n");
  app = await launchApp();
  page = await app.firstWindow();
  observePage(page);
  let headSession = await waitReady(page, fixture.mainTip, "浏览范围：HEAD");
  await waitStatus(page, status => status.state === "running" && status.coverage.processed > 0);
  await waitForFile(pidFile);
  let running = await statusInWindow(page);
  assert.equal(running.state, "running");
  assert.ok(running.coverage.processed >= 64, "the Electron surface sees a durable progress checkpoint");
  await openStatus(page);
  await page.getByTestId("index-status-label").getByText(/索引中 · 已处理/).waitFor({ state: "visible" });
  await page.screenshot({ path: resolve(root, "output/playwright/p1-05-index-running.png") });

  await page.getByTestId("index-action-pause").click();
  const paused = await waitStatus(page, status => status.state === "paused");
  assert.equal(paused.coverage.processed, running.coverage.processed, "pause response confirms the durable progress stopped");
  await waitForPidExit(Number((await readFile(pidFile, "utf8")).trim()));
  await openStatus(page);
  await page.getByTestId("index-status-label").getByText(/索引已暂停/).waitFor({ state: "visible" });
  await assertHistoryVisible(page, fixture.mainTip);
  await page.screenshot({ path: resolve(root, "output/playwright/p1-05-index-paused.png") });

  await rm(gateFile, { force: true });
  await writeFile(countFile, "0\n");
  await page.getByTestId("index-action-resume").click();
  const complete = await waitStatus(page, status => status.state === "complete");
  assert.equal(complete.coverage.complete, true);
  assert.equal(complete.coverage.processed, fixture.mainReachableCount);

  // A new fixed scope must get its own progress; block and cancel that task while its history stays visible.
  await writeFile(countFile, "0\n");
  await writeFile(gateFile, "hold side-scope index batch\n");
  await rm(pidFile, { force: true });
  await page.getByTestId("scope-picker").click();
  await page.getByTestId("scope-option-ref-refs/heads/side").click();
  const sideSession = await waitReady(page, fixture.sideTip, "浏览范围：side");
  assert.deepEqual({ repositoryKey: sideSession.repositoryKey, worktreeId: sideSession.worktreeId },
    { repositoryKey: headSession.repositoryKey, worktreeId: headSession.worktreeId }, "scope changes preserve the window's repository identity");
  const sideRunning = await waitStatus(page, status => status.state === "running" && status.coverage.processed >= 64);
  assert.notEqual(sideRunning.snapshotKey, complete.snapshotKey, "the new scope has its own indexed snapshot");
  assert.ok(sideRunning.coverage.processed >= 64 && sideRunning.coverage.processed < fixture.sideReachableCount,
    "the second scope reports its own durable partial progress instead of flashing the previous completed scope");
  await waitForFile(pidFile);
  await openStatus(page);
  await page.getByTestId("index-action-cancel").click();
  const cancelled = await waitStatus(page, status => status.state === "cancelled");
  assert.equal(cancelled.coverage.complete, false);
  await waitForPidExit(Number((await readFile(pidFile, "utf8")).trim()));
  await assertHistoryVisible(page, fixture.sideTip);
  await openStatus(page);
  await page.getByTestId("index-status-label").getByText(/索引已取消/).waitFor({ state: "visible" });
  await page.screenshot({ path: resolve(root, "output/playwright/p1-05-index-cancelled.png") });

  await rm(gateFile, { force: true });
  await writeFile(countFile, "0\n");
  await page.getByTestId("index-action-resume").click();
  await waitStatus(page, status => status.state === "complete");
  await assertHistoryVisible(page, fixture.sideTip);

  await app.close();
  app = null;
  const reopenedApp = await launchApp();
  app = reopenedApp;
  page = await app.firstWindow();
  observePage(page);
  headSession = await waitReady(page, fixture.mainTip, "浏览范围：HEAD");
  const persisted = await waitStatus(page, status => status.state === "complete");
  assert.equal(persisted.coverage.processed, fixture.mainReachableCount, "the per-snapshot complete state survives reopening the same application profile");
  await assertHistoryVisible(page, fixture.mainTip);
  await app.close();
  app = null;

  const databasePath = await locateDatabase(env.COMMITSCOPE_APP_DATA_DIR);
  await writeFile(databasePath, Buffer.from("corrupt metadata index fixture\n"));
  app = await launchApp();
  page = await app.firstWindow();
  observePage(page);
  headSession = await waitReady(page, fixture.mainTip, "浏览范围：HEAD");
  await assertHistoryVisible(page, fixture.mainTip);
  const unavailable = await waitStatus(page, status => ["failed", "unavailable"].includes(status.state));
  assert.equal(unavailable.coverage.complete, false);
  assert.equal(unavailable.error?.code, "INDEX_CORRUPT");
  await openStatus(page);
  const indexError = page.getByTestId("index-error");
  await indexError.waitFor({ state: "visible" });
  assert.match(await indexError.innerText(), /历史仍可浏览/u);
  await assertHistoryVisible(page, fixture.mainTip);
  await page.screenshot({ path: resolve(root, "output/playwright/p1-05-index-unavailable.png") });

  await page.getByTestId("index-action-rebuild").click();
  const rebuilt = await waitStatus(page, status => status.state === "complete");
  assert.equal(rebuilt.coverage.complete, true);
  assert.equal(rebuilt.coverage.processed, fixture.mainReachableCount);
  const rebuiltBytes = await readFile(databasePath);
  assert.equal(rebuiltBytes.subarray(0, 16).toString("utf8"), "SQLite format 3\0", "explicit rebuild replaces the corrupt cache with SQLite");
  await assertHistoryVisible(page, fixture.mainTip);
  await app.close();
  app = null;
  closed = true;
  assert.deepEqual(await snapshotTree(fixture.repository), repositoryBefore, "Electron indexing never modifies the viewed Git repository");
  process.stdout.write("Electron metadata index smoke passed: progress, pause/resume/cancel, scope isolation, corrupt-cache browsing and explicit rebuild.\n");
} catch (error) {
  diagnostics.unshift(`smoke error: ${error.stack ?? error.message}`);
  if (page) {
    try { diagnostics.push("session: " + JSON.stringify(await currentSession(page))); } catch (e) { diagnostics.push("session query: " + String(e)); }
    try { diagnostics.push("index status: " + JSON.stringify(await statusInWindow(page))); } catch (e) { diagnostics.push("index status query: " + String(e)); }
    try { diagnostics.push("index label: " + JSON.stringify(await page.getByTestId("index-status-trigger").innerText())); } catch (e) { diagnostics.push("index label query: " + String(e)); }
    try { diagnostics.push("index popover: " + JSON.stringify(await page.getByTestId("index-status-label").innerText())); } catch (e) { diagnostics.push("index popover query: " + String(e)); }
    try { await page.screenshot({ path: resolve(root, "output/playwright/p1-05-index-failure.png") }); } catch (e) { diagnostics.push("screenshot: " + String(e)); }
  }
  diagnostics.push("app/daemon stderr:\n" + appStderr);
  await writeFile(resolve(root, "output/test/p1-05-index-smoke-diagnostics.log"), diagnostics.join("\n") + "\n");
  throw error;
} finally {
  await rm(gateFile, { force: true });
  if (!closed && app) await app.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function launchApp() {
  const launched = await electron.launch({
    executablePath: require("electron"),
    args: [appEntry, `--repository=${fixture.repository}`, `--user-data-dir=${profile}`],
    env,
    chromiumSandbox: true,
  });
  const process = launched.process();
  process.stderr?.setEncoding("utf8");
  process.stderr?.on("data", chunk => { appStderr = (appStderr + chunk).slice(-64 * 1024); });
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

async function currentStatus(target) {
  const result = await target.evaluate(() => window.commitScope.getMetadataIndexStatus());
  if (!result?.ok) throw new Error(result?.error?.message ?? "metadata index status unavailable");
  return result.value;
}

async function waitReady(target, oid, labelPrefix, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no session";
  while (Date.now() < deadline) {
    try {
      const session = await currentSession(target);
      const ui = await target.evaluate(() => ({
        state: document.querySelector('[data-testid="preview-state"]')?.dataset.state ?? "",
        pickerLabel: document.querySelector('[data-testid="scope-picker"]')?.getAttribute("aria-label") ?? "",
        firstOid: document.querySelector('[aria-label="提交列表"] [role="listbox"] [data-testid="commit-row"]')?.getAttribute("data-oid") ?? null,
      }));
      const scopeMatches = labelPrefix.endsWith("HEAD") ? session.scope === "head" : session.scope?.ref === "refs/heads/side";
      if (scopeMatches && ui.state === "ready" && ui.pickerLabel.startsWith(labelPrefix) && ui.firstOid === oid) return session;
      last = JSON.stringify({ sessionScope: session.scope, ui });
    } catch (error) { last = String(error.message ?? error); }
    await delay(100);
  }
  throw new Error(`Timed out waiting for visible history/scope: ${last}`);
}

async function waitStatus(target, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await currentStatus(target);
      if (predicate(last)) return last;
    } catch (error) { last = { error: String(error.message ?? error) }; }
    await delay(50);
  }
  throw new Error(`Timed out waiting for index status: ${JSON.stringify(last)}`);
}

async function statusInWindow(target) {
  const locator = target.getByTestId("index-status-label");
  if (await locator.count()) {
    // The popover may be open; the authoritative IPC status remains the assertion source.
  }
  return currentStatus(target);
}

async function openStatus(target) {
  if (!(await target.getByTestId("index-status-label").count())) await target.getByTestId("index-status-trigger").click();
  await target.getByTestId("index-status-label").waitFor({ state: "visible" });
}

async function assertHistoryVisible(target, oid) {
  const deadline = Date.now() + 10_000;
  let visible = false;
  while (Date.now() < deadline) {
    const rows = await target.getByTestId("commit-row").evaluateAll(items => items.map(item => item.getAttribute("data-oid")));
    if (rows.includes(oid)) { visible = true; break; }
    await delay(50);
  }
  assert.equal(visible, true, `history row ${oid} remains visible while indexing is controlled`);
}

async function waitForFile(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch {}
    await delay(10);
  }
  throw new Error(`Timed out waiting for Git gate ${path}`);
}

async function locateDatabase(appDataDir) {
  const directories = [appDataDir];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile() && entry.name === "index.sqlite3") return path;
    }
  }
  throw new Error(`No metadata index database found under ${appDataDir}`);
}

async function waitForPidExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await delay(20);
  }
  throw new Error(`Git wrapper process ${pid} remained alive after pause/cancel`);
}

async function createGitWrapper(directory) {
  if (process.platform === "win32") throw new Error("Metadata indexing smoke process gates require a Unix-like shell");
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
    "  if [ \"$batch_limit\" -ge 64 ]; then",
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
