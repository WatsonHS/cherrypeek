import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const root = resolve(import.meta.dirname, "..");
const desktop = resolve(root, "apps/desktop");
const appEntry = resolve(desktop, "dist/main/index.cjs");
const build = process.argv.includes("--build");
let activeChild;
let activeGroup;
let requestedSignal;
let cleanupPromise;

function cleanup(signal) {
  if (cleanupPromise) return cleanupPromise;
  requestedSignal = signal;
  cleanupPromise = new Promise(resolveExit => {
    const child = activeChild;
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolveExit();
    child.once("close", resolveExit);
    if (activeGroup && process.platform !== "win32") {
      try { process.kill(-activeGroup, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
    } else child.kill(signal);
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        if (activeGroup && process.platform !== "win32") {
          try { process.kill(-activeGroup, "SIGKILL"); } catch { }
        } else child.kill("SIGKILL");
      }
    }, 5000);
    timer.unref();
  });
  return cleanupPromise;
}

process.on("SIGINT", () => { void cleanup("SIGINT"); });
process.on("SIGTERM", () => { void cleanup("SIGTERM"); });

async function runChild(command, args, options = {}) {
  if (requestedSignal) return 1;
  const child = spawn(command, args, options);
  activeChild = child;
  activeGroup = options.detached ? child.pid : undefined;
  const result = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  if (activeChild === child) {
    activeChild = undefined;
    activeGroup = undefined;
  }
  if (requestedSignal) return 1;
  return result.code ?? (result.signal ? 1 : 0);
}

if (build) {
  const buildExit = await runChild(process.execPath, [resolve(root, "scripts/build.mjs")], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  if (buildExit !== 0) process.exitCode = buildExit;
}

if (!process.exitCode && !requestedSignal) {
  try {
    await access(appEntry);
  } catch (error) {
    process.stderr.write(`Desktop build is missing at ${appEntry}. Run pnpm build first.\n`);
    process.exitCode = 1;
  }
}

if (!process.exitCode && !requestedSignal) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  process.exitCode = await runChild(electronBinary, [appEntry, ...process.argv.slice(2).filter(arg => arg !== "--build")], {
    cwd: desktop,
    env,
    stdio: "inherit",
    windowsHide: false,
  });
}
