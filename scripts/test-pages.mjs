#!/usr/bin/env node
// Acceptance tests for the workspace, files page, full-file diff and blame reads: the real daemon is
// compared with independent Git commands on throwaway repositories.
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPagesFixtures } from "../tests/pages/fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const testNamePattern = process.argv.slice(2).find(argument => argument.startsWith("--test-name-pattern="))?.slice("--test-name-pattern=".length);
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-pages-"));
const configuredDaemonPath = process.env.COMMITSCOPE_DAEMON_PATH ? resolve(process.env.COMMITSCOPE_DAEMON_PATH) : null;
const daemonPath = configuredDaemonPath ?? resolve(root, "target", "debug", process.platform === "win32" ? "commitscope-daemon.exe" : "commitscope-daemon");

try {
  if (!configuredDaemonPath) await run("cargo", ["build", "--locked", "-p", "commitscope-daemon"], { cwd: root, timeoutMs: 600_000 });
  await access(daemonPath);
  const fixtures = await createPagesFixtures(join(temporaryRoot, "fixtures"));
  const fixtureFile = join(temporaryRoot, "fixture.json");
  await writeFile(fixtureFile, JSON.stringify({ ...fixtures, files: { ...fixtures.files, invalidPath: undefined, invalidPathHex: fixtures.files.invalidPath.toString("hex") } }, null, 2));
  // The daemon reads user Git config for the working tree; an empty HOME keeps this machine's config out of the comparison.
  const home = join(temporaryRoot, "home");
  await mkdir(join(home, ".config"), { recursive: true });
  await writeFile(join(home, ".gitconfig"), "");
  const wrapperDirectory = join(temporaryRoot, "git-wrapper");
  if (process.platform !== "win32") await createGitWrapper(wrapperDirectory);
  const env = cleanEnvironment({
    COMMITSCOPE_DAEMON_PATH: daemonPath,
    COMMITSCOPE_PAGES_FIXTURE: fixtureFile,
    COMMITSCOPE_PAGES_DATA_ROOT: join(temporaryRoot, "app-data"),
    COMMITSCOPE_PAGES_HOME: home,
    COMMITSCOPE_PAGES_GIT_WRAPPER: process.platform === "win32" ? "" : wrapperDirectory,
    COMMITSCOPE_PAGES_GATE_FILE: join(temporaryRoot, "git.gate"),
    COMMITSCOPE_PAGES_GATE_STARTED: join(temporaryRoot, "git.gate.started"),
  });
  const testArgs = ["--test", "--test-concurrency=1", "--test-timeout=180000"];
  if (testNamePattern) testArgs.push(`--test-name-pattern=${testNamePattern}`);
  testArgs.push(join(root, "tests/pages/pages-git.test.mjs"));
  await run(process.execPath, testArgs, { cwd: root, env, timeoutMs: 900_000, inherit: true });
  process.stdout.write("Workspace, files and blame acceptance tests passed; temporary repositories and app data were removed.\n");
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

/**
 * A git stand-in that holds any invocation carrying the argument named in the gate file until the file is
 * removed. It records its own PID first, so a test can cancel the read and check the daemon reaped it.
 */
async function createGitWrapper(directory) {
  await mkdir(directory, { recursive: true });
  const realGit = await findGitExecutable();
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const body = [
    "#!/bin/sh",
    "hold_git() {",
    "  gate=$1; started=$2",
    "  if [ -n \"$gate\" ] && [ -e \"$gate\" ]; then",
    "    hold=$(cat \"$gate\" 2>/dev/null)",
    "    shift 2",
    "    for argument in \"$@\"; do",
    "      if [ -n \"$hold\" ] && [ \"$argument\" = \"$hold\" ]; then",
    "        printf '%s\\n' \"$$\" > \"$started\"",
    "        while [ -e \"$gate\" ]; do /bin/sleep 0.02; done",
    "        break",
    "      fi",
    "    done",
    "  fi",
    "}",
    'hold_git "$COMMITSCOPE_PAGES_GATE_FILE" "$COMMITSCOPE_PAGES_GATE_STARTED" "$@"',
    'hold_git "$COMMITSCOPE_PAGES_READ_GATE_FILE" "$COMMITSCOPE_PAGES_READ_GATE_STARTED" "$@"',
    `exec ${quote(realGit)} "$@"`,
  ].join("\n") + "\n";
  const wrapperPath = join(directory, "git");
  await writeFile(wrapperPath, body, { mode: 0o700 });
  await chmod(wrapperPath, 0o700);
}

async function findGitExecutable() {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory, "git");
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error("Could not locate the real Git executable for the test wrapper");
}

function cleanEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}

function run(command, args, { cwd, env = cleanEnvironment(), timeoutMs, inherit = false }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let stderr = ""; let timedOut = false; let hardStop;
    if (!inherit) {
      child.stdout.resume();
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32 * 1024); });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      hardStop = setTimeout(() => killGroup(child, "SIGKILL"), 1000);
    }, timeoutMs);
    child.once("error", error => { clearTimeout(timeout); clearTimeout(hardStop); rejectRun(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout); clearTimeout(hardStop);
      if (timedOut) return rejectRun(new Error(`${command} timed out after ${timeoutMs}ms`));
      if (code !== 0) return rejectRun(new Error(`${command} exited with ${code ?? signal}\n${stderr}`));
      resolveRun();
    });
  });
}

function killGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  } else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
