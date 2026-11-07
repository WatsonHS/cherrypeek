#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-sessions-test-"));
const fixtureRoot = join(temporaryRoot, "fixtures");
const helperDirectory = join(temporaryRoot, "helpers");
const slowGitDirectory = join(helperDirectory, "slow-bin");
const daemonBinary = join(root, "target", "debug", process.platform === "win32" ? "commitscope-daemon.exe" : "commitscope-daemon");
let failed = false;

try {
  await run(process.execPath, [join(root, "scripts/generate-fixtures.mjs"), "--output", fixtureRoot], { cwd: root, timeoutMs: 120_000 });
  await run("cargo", ["build", "--locked", "-p", "commitscope-daemon"], { cwd: root, timeoutMs: 300_000 });
  const realGit = await findGitExecutable();
  await createSlowGitWrapper(slowGitDirectory, realGit);
  const testEnv = cleanEnvironment({
    COMMITSCOPE_FIXTURE_ROOT: fixtureRoot,
    COMMITSCOPE_FIXTURE_PARENT: temporaryRoot,
    COMMITSCOPE_FIXTURE_MANIFEST: join(fixtureRoot, "manifest.json"),
    COMMITSCOPE_DAEMON_PATH: daemonBinary,
    COMMITSCOPE_SESSION_DATA_DIR: join(temporaryRoot, "data-main"),
    COMMITSCOPE_SESSION_EMPTY_DATA_DIR: join(temporaryRoot, "data-empty"),
    COMMITSCOPE_SESSION_WORKTREE_DATA_DIR: join(temporaryRoot, "data-worktree"),
    COMMITSCOPE_SESSION_WORKTREE_VIEW_DATA_DIR: join(temporaryRoot, "data-worktree-view"),
    COMMITSCOPE_SESSION_DISCOVERY_DATA_DIR: join(temporaryRoot, "data-discovery"),
    COMMITSCOPE_SESSION_CORRUPT_DATA_DIR: join(temporaryRoot, "data-corrupt"),
    COMMITSCOPE_SESSION_SYMLINK_DATA_DIR: join(temporaryRoot, "data-symlink"),
    COMMITSCOPE_SESSION_SYMLINK_TARGET: join(temporaryRoot, "outside-state.json"),
    COMMITSCOPE_SESSION_RACE_DATA_DIR: join(temporaryRoot, "data-race"),
    COMMITSCOPE_SESSION_PERMISSION_DATA_DIR: join(temporaryRoot, "data-permission"),
    COMMITSCOPE_SESSION_UNKNOWN_VERSION_DATA_DIR: join(temporaryRoot, "data-unknown-version"),
    COMMITSCOPE_SESSION_OVERSIZE_DATA_DIR: join(temporaryRoot, "data-oversize"),
    COMMITSCOPE_SESSION_DENIED_REPOSITORY: join(temporaryRoot, "denied-repository"),
    COMMITSCOPE_SESSION_DENIED_DATA_DIR: join(temporaryRoot, "data-denied"),
    COMMITSCOPE_SESSION_SLOW_GIT_DIRECTORY: slowGitDirectory,
    COMMITSCOPE_SESSION_SLOW_PID_FILE: join(temporaryRoot, "slow-git.pid"),
  });
  await run(process.execPath, ["--test", "--test-timeout=30000", join(root, "tests/sessions/repository-session.test.mjs")], {
    cwd: root,
    env: testEnv,
    timeoutMs: 300_000,
    inherit: true,
  });
  process.stdout.write("Repository session tests passed; temporary fixtures and app data were removed.\n");
} catch (error) {
  failed = true;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  if (failed) process.stderr.write("Temporary fixture, app-data, and process-control files were cleaned.\n");
}

async function createSlowGitWrapper(directory, realGit) {
  await mkdir(directory, { recursive: true });
  const wrapper = join(directory, process.platform === "win32" ? "git.cmd" : "git");
  if (process.platform === "win32") {
    throw new Error("Controlled slow Git lifecycle tests currently require a Unix-like shell");
  }
  const quotedGit = shellQuote(realGit);
  const body = `#!/bin/sh
target=''
previous=''
has_rev_parse=0
has_rev_list=0
for argument in "$@"; do
  if [ "$previous" = "-C" ]; then target="$argument"; fi
  [ "$argument" = "rev-parse" ] && has_rev_parse=1
  [ "$argument" = "rev-list" ] && has_rev_list=1
  previous="$argument"
done
if [ "$target" = "$COMMITSCOPE_SESSION_SLOW_OPEN_REPOSITORY" ] && [ "$has_rev_parse" = 1 ]; then
  printf '%s\\n' "$$" > "$COMMITSCOPE_SESSION_SLOW_PID_FILE"
  exec /bin/sleep 30
fi
if [ "$target" = "$COMMITSCOPE_SESSION_SLOW_QUERY_REPOSITORY" ] && [ "$has_rev_list" = 1 ]; then
  printf '%s\\n' "$$" > "$COMMITSCOPE_SESSION_SLOW_PID_FILE"
  exec /bin/sleep 30
fi
exec ${quotedGit} "$@"
`;
  await writeFile(wrapper, body, { mode: 0o700 });
  await chmod(wrapper, 0o700);
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

async function findGitExecutable() {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory, "git");
    try { if ((await stat(candidate)).isFile()) return candidate; } catch {}
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
      cwd,
      env,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-32 * 1024); });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32 * 1024); });
    }
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      const hardStop = setTimeout(() => killGroup(child, "SIGKILL"), 1000);
      hardStop.unref();
      child.once("close", () => clearTimeout(hardStop));
    }, timeoutMs);
    child.once("error", error => { clearTimeout(timeout); rejectRun(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) return rejectRun(new Error(`${command} timed out after ${timeoutMs}ms`));
      if (code !== 0) return rejectRun(new Error(`${command} exited with ${code ?? signal}\n${stderr}`));
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
