#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNavigationFixture } from "../tests/navigation/fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-navigation-test-"));
const daemonBinary = join(root, "target/debug", process.platform === "win32" ? "commitscope-daemon.exe" : "commitscope-daemon");
const fixtureRoot = join(temporaryRoot, "fixtures");
const slowGitDirectory = join(temporaryRoot, "helpers");
const gateFile = join(temporaryRoot, "scope-query.gate");
const pidFile = join(temporaryRoot, "scope-query.pid");
let failed = false;

try {
  const fixture = await createNavigationFixture(fixtureRoot);
  const idsFile = join(temporaryRoot, "fixture-oids.json");
  await writeFile(idsFile, JSON.stringify(fixture.commits, null, 2) + "\n");
  const realGit = await findGitExecutable();
  await createSlowGitWrapper(slowGitDirectory, realGit);
  await run("cargo", ["build", "--locked", "-p", "commitscope-daemon"], { cwd: root, timeoutMs: 300_000 });
  const env = cleanEnvironment({
    COMMITSCOPE_DAEMON_PATH: daemonBinary,
    COMMITSCOPE_NAVIGATION_REPOSITORY: fixture.repository,
    COMMITSCOPE_NAVIGATION_REMOTE: fixture.remote,
    COMMITSCOPE_NAVIGATION_LINKED: fixture.linkedPath,
    COMMITSCOPE_NAVIGATION_DETACHED: fixture.detachedPath,
    COMMITSCOPE_NAVIGATION_SHA256: fixture.sha256Repository ?? "",
    COMMITSCOPE_NAVIGATION_OIDS: idsFile,
    COMMITSCOPE_NAVIGATION_DATA_ROOT: join(temporaryRoot, "app-data"),
    COMMITSCOPE_NAVIGATION_SLOW_GIT_DIR: slowGitDirectory,
    COMMITSCOPE_NAVIGATION_SLOW_REPOSITORY: fixture.repository,
    COMMITSCOPE_NAVIGATION_BLOCK_GATE_FILE: gateFile,
    COMMITSCOPE_NAVIGATION_BLOCK_PID_FILE: pidFile,
  });
  await run(process.execPath, ["--test", "--test-timeout=45000", join(root, "tests/navigation/repository-navigation.test.mjs")], {
    cwd: root, env, timeoutMs: 420_000, inherit: true,
  });
  process.stdout.write("Repository scope navigation tests passed; temporary Git repositories and app data were removed.\n");
} catch (error) {
  failed = true;
  process.stderr.write(String(error.message) + "\n");
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  if (failed) process.stderr.write("Temporary navigation fixtures, app data, and process-control files were cleaned.\n");
}

async function createSlowGitWrapper(directory, realGit) {
  if (process.platform === "win32") throw new Error("Navigation cancellation lifecycle test currently requires a Unix-like shell");
  await mkdir(directory, { recursive: true });
  const wrapper = join(directory, "git");
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const body = [
    "#!/bin/sh",
    "target=''",
    "previous=''",
    "is_rev_list='false'",
    "for argument in \"$@\"; do",
    "  if [ \"$previous\" = '-C' ]; then target=\"$argument\"; fi",
    "  [ \"$argument\" = 'rev-list' ] && is_rev_list='true'",
    "  previous=\"$argument\"",
    "done",
    "if [ \"$target\" = \"$COMMITSCOPE_NAVIGATION_SLOW_REPOSITORY\" ] && [ \"$is_rev_list\" = 'true' ] && [ -e \"$COMMITSCOPE_NAVIGATION_BLOCK_GATE_FILE\" ]; then",
    "  printf '%s\\n' \"$$\" > \"$COMMITSCOPE_NAVIGATION_BLOCK_PID_FILE\"",
    "  while [ -e \"$COMMITSCOPE_NAVIGATION_BLOCK_GATE_FILE\" ]; do /bin/sleep 0.02; done",
    "fi",
    "exec " + quote(realGit) + " \"$@\"",
  ].join("\n") + "\n";
  await writeFile(wrapper, body, { mode: 0o700 });
  await chmod(wrapper, 0o700);
}

async function findGitExecutable() {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory, "git");
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error("Could not find system Git executable");
}

function cleanEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}

function run(command, args, { cwd, env = cleanEnvironment(), timeoutMs, inherit = false }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd, env, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let hardStop;
    if (!inherit) {
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-32 * 1024); });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32 * 1024); });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      hardStop = setTimeout(() => killGroup(child, "SIGKILL"), 1000);
    }, timeoutMs);
    child.once("error", error => { clearTimeout(timeout); clearTimeout(hardStop); rejectRun(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(hardStop);
      if (timedOut) return rejectRun(new Error(command + " timed out after " + timeoutMs + "ms"));
      if (code !== 0) return rejectRun(new Error(command + " exited with " + (code ?? signal) + "\n" + stderr));
      if (!inherit && stdout) process.stdout.write(stdout);
      resolveRun();
    });
  });
}

function killGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  } else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

