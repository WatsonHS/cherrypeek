import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const root = resolve(import.meta.dirname, "../..");
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const screenshotDir = resolve(root, "output/playwright");
await access(appEntry);
await mkdir(screenshotDir, { recursive: true });

function cleanElectronEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function launch(mode) {
  const args = [appEntry];
  if (mode) args.push(`--smoke-mode=${mode}`);
  return electron.launch({ executablePath: electronBinary, args, env: cleanElectronEnv(), chromiumSandbox: true });
}

async function waitForText(page, text) {
  await page.getByText(text, { exact: true }).waitFor({ state: "visible", timeout: 10000 });
}

const normal = await launch();
let daemonPid;
let normalClosed = false;
try {
  const page = await normal.firstWindow();
  await waitForText(page, "核心已就绪");
  const readyStatus = await page.evaluate(() => window.commitScope.getCoreStatus());
  daemonPid = readyStatus.state === "ready" ? readyStatus.core.pid : NaN;
  const coreVersion = readyStatus.state === "ready" ? readyStatus.core.coreVersion : "";
  assert.match(coreVersion ?? "", /^\d+\.\d+\.\d+/);
  assert.ok(Number.isInteger(daemonPid) && daemonPid > 0, "UI must display the real Rust child PID");
  process.kill(daemonPid, 0);

  const diagnostics = await page.evaluate(async () => {
    const win = window;
    let inlineScriptRan = false;
    const script = document.createElement("script");
    script.textContent = "window.__inlineCspProbe = true";
    document.head.append(script);
    inlineScriptRan = win.__inlineCspProbe === true;
    const iframe = document.createElement("iframe");
    iframe.srcdoc = "<!doctype html><html><body>child frame</body></html>";
    document.body.append(iframe);
    await new Promise(resolve => {
      iframe.addEventListener("load", () => resolve(), { once: true });
      setTimeout(resolve, 1500);
    });
    let childFrameApiAvailable = false;
    try { childFrameApiAvailable = Boolean(iframe.contentWindow?.commitScope); } catch { }
    return {
      nodeRequire: typeof win.require,
      nodeProcess: typeof win.process,
      windowRequire: typeof win.require,
      ipcRenderer: typeof win.ipcRenderer,
      apiKeys: Object.keys(win.commitScope).sort(),
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
      inlineScriptRan,
      childFrameApiAvailable,
      href: location.href,
    };
  });
  assert.equal(diagnostics.nodeRequire, "undefined");
  assert.equal(diagnostics.nodeProcess, "undefined");
  assert.equal(diagnostics.windowRequire, "undefined");
  assert.equal(diagnostics.ipcRenderer, "undefined");
  assert.deepEqual(diagnostics.apiKeys, [
    "branchesContaining", "cancelCommitDetails", "cancelHistoryRead", "cancelRefMergeStatus", "cancelSearch", "chooseRepository", "closeRepositorySession", "controlMetadataIndex", "copyText", "getCommit", "getCoreStatus", "getLaunchRepository",
    "getMetadataIndexStatus", "getRefMergeStatus", "getRepositoryNavigation", "getRepositorySession", "listChangedFiles", "listRecentRepositories", "listSearchIdentities", "locateCommit", "onCoreStatusChanged", "openRepositorySession",
    "readDiff", "readHistoryPage", "readMergeCommits", "readSessionPreview", "recordRepositoryView", "refreshRepositorySession", "searchCommits", "selectRepositoryScope",
  ]);
  assert.equal(diagnostics.inlineScriptRan, false, "CSP must block inline scripts");
  assert.equal(diagnostics.childFrameApiAvailable, false, "preload API must not be exposed to child frames");
  assert.match(diagnostics.csp ?? "", /default-src 'none'/);
  assert.match(diagnostics.csp ?? "", /connect-src 'none'/);
  assert.equal(new URL(diagnostics.href).protocol, "file:");

  const electronSecurity = await normal.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win.webContents.getLastWebPreferences();
  });
  assert.equal(electronSecurity.nodeIntegration, false);
  assert.equal(electronSecurity.contextIsolation, true);
  assert.equal(electronSecurity.sandbox, true);
  assert.equal(electronSecurity.webSecurity, true);
  assert.equal(electronSecurity.webviewTag, false);
  assert.equal(normal.process().spawnargs.some(arg => arg === "--no-sandbox"), false);
  await page.screenshot({ path: resolve(screenshotDir, "p0-01-ready.png") });

  process.kill(daemonPid, "SIGTERM");
  await waitForText(page, "核心不可用");
  await page.getByRole("alert").waitFor({ state: "visible" });
  assert.match(await page.getByRole("alert").textContent(), /CORE_EXITED/);
  await waitForExit(daemonPid);
  const electronPid = normal.process().pid;
  await normal.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await waitForExit(electronPid);
  await normal.close().catch(() => undefined);
  normalClosed = true;
  await waitForExit(daemonPid);
  process.stdout.write(JSON.stringify({ ready: true, coreVersion, daemonPid, electronPid, security: electronSecurity, runtimeExitVisible: true, screenshot: "output/playwright/p0-01-ready.png" }, null, 2) + "\n");
} finally {
  if (!normalClosed) await normal.close().catch(() => undefined);
}

const failed = await launch("missing-core");
try {
  const page = await failed.firstWindow();
  await waitForText(page, "核心不可用");
  await page.getByRole("alert").waitFor({ state: "visible" });
  assert.ok((await page.getByRole("alert").textContent())?.trim(), "spawn failure must be visible in the UI");
} finally { await failed.close(); }

await verifyLauncherSignal("SIGTERM");
await verifyLauncherSignal("SIGINT");
const graceful = await launch();
let gracefulClosed = false;
try {
  const page = await graceful.firstWindow();
  await waitForText(page, "核心已就绪");
  const gracefulStatus = await page.evaluate(() => window.commitScope.getCoreStatus());
  const gracefulPid = gracefulStatus.state === "ready" ? gracefulStatus.core.pid : NaN;
  const gracefulElectronPid = graceful.process().pid;
  process.kill(gracefulPid, 0);
  await graceful.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await Promise.all([waitForExit(gracefulPid), waitForExit(gracefulElectronPid)]);
  await graceful.close().catch(() => undefined);
  gracefulClosed = true;
} finally {
  if (!gracefulClosed) await graceful.close().catch(() => undefined);
}

process.stdout.write("Smoke passed: real core ready, security boundaries, failure states, window cleanup, SIGTERM and SIGINT cleanup.\n");

async function verifyLauncherSignal(signal) {
  const child = spawn(process.execPath, [resolve(root, "scripts/launch.mjs")], {
    cwd: root,
    env: cleanElectronEnv(),
    stdio: "ignore",
  });
  assert.ok(child.pid);
  const descendants = await waitForDescendants(child.pid, 10000);
  assert.ok(descendants.some(row => row.comm.includes("commitscope-daemon")), "expected this launch's Rust daemon in captured process tree");
  child.kill(signal);
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error(`launcher did not exit after ${signal}`)), 10000);
    child.once("close", () => { clearTimeout(timer); resolveExit(); });
  });
  await Promise.all([child.pid, ...descendants.map(row => row.pid)].map(pid => waitForExit(pid)));
}

async function waitForDescendants(rootPid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const descendants = processTree(rootPid);
    if (descendants.some(row => row.comm.includes("commitscope-daemon"))) return descendants;
    await delay(100);
  }
  throw new Error(`launcher ${rootPid} did not create expected Electron and daemon children`);
}

function processTree(rootPid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .trim().split("\n").map(row => {
      const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] } : undefined;
    }).filter(Boolean);
  const result = [];
  const parents = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (parents.has(row.ppid) && !parents.has(row.pid)) {
        parents.add(row.pid);
        result.push(row);
        changed = true;
      }
    }
  }
  return result;
}

async function waitForExit(pid, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`Process ${pid} is still alive`);
}
