#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDetailsFixture } from "../tests/details/fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const testNamePattern = process.argv.slice(2).find(argument => argument.startsWith("--test-name-pattern="))?.slice("--test-name-pattern=".length);
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-commit-details-"));
const fixtureRoot = join(temporaryRoot, "fixtures");
const dataRoot = join(temporaryRoot, "app-data");
const wrapperDirectory = join(temporaryRoot, "git-wrapper");
const fixtureFile = join(temporaryRoot, "fixture.json");
const gateFile = join(temporaryRoot, "git.gate");
const gateStarted = join(temporaryRoot, "git.gate.started");
const configuredDaemonPath = process.env.COMMITSCOPE_DAEMON_PATH ? resolve(process.env.COMMITSCOPE_DAEMON_PATH) : null;
const daemonPath = configuredDaemonPath ?? resolve(root, "target", "debug", process.platform === "win32" ? "commitscope-daemon.exe" : "commitscope-daemon");

try {
  if (!configuredDaemonPath) await run("cargo", ["build", "--locked", "-p", "commitscope-daemon"], { cwd: root, timeoutMs: 300_000 });
  await access(daemonPath);
  const fixture = await createDetailsFixture(fixtureRoot);
  await writeFile(fixtureFile, JSON.stringify(fixture, null, 2));
  await mkdir(dataRoot, { recursive: true });
  if (process.platform !== "win32") await createGitWrapper(wrapperDirectory);
  await run(process.execPath, [join(root, "tests/details/fixture-preflight.mjs")], {
    cwd: root, env: cleanEnvironment({ COMMITSCOPE_DETAILS_FIXTURE: fixtureFile }), timeoutMs: 120_000,
  });
  const env = cleanEnvironment({
    COMMITSCOPE_DAEMON_PATH: daemonPath,
    COMMITSCOPE_DETAILS_FIXTURE: fixtureFile,
    COMMITSCOPE_DETAILS_DATA_ROOT: dataRoot,
    COMMITSCOPE_DETAILS_GIT_WRAPPER: process.platform === "win32" ? "" : wrapperDirectory,
    COMMITSCOPE_DETAILS_GATE_FILE: gateFile,
    COMMITSCOPE_DETAILS_GATE_STARTED: gateStarted,
    PATH: process.platform === "win32" ? process.env.PATH : `${wrapperDirectory}:${process.env.PATH ?? ""}`,
  });
  const testArgs = ["--test", "--test-concurrency=1", "--test-timeout=90000"];
  if (testNamePattern) testArgs.push(`--test-name-pattern=${testNamePattern}`);
  testArgs.push(join(root, "tests/details/commit-details.test.mjs"));
  await run(process.execPath, testArgs, {
    cwd: root, env, timeoutMs: 900_000, inherit: true,
  });
  process.stdout.write("Commit detail Git integration tests passed; temporary repositories and app data were removed.\n");
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function createGitWrapper(directory) {
  await mkdir(directory, { recursive: true });
  const realGit = await findGitExecutable();
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const body = [
    "#!/bin/sh",
    "target=''; previous=''; is_diff_tree='false'",
    "for argument in \"$@\"; do",
    "  if [ \"$previous\" = '-C' ]; then target=\"$argument\"; fi",
    "  if [ \"$argument\" = 'diff-tree' ]; then is_diff_tree='true'; fi",
    "  previous=\"$argument\"",
    "done",
    "if [ \"$is_diff_tree\" = 'true' ] && [ \"$target\" = \"$COMMITSCOPE_DETAILS_GATE_REPOSITORY\" ] && [ -e \"$COMMITSCOPE_DETAILS_GATE_FILE\" ]; then",
    "  printf '%s\\n' \"$$\" > \"$COMMITSCOPE_DETAILS_GATE_STARTED\"",
    "  while [ -e \"$COMMITSCOPE_DETAILS_GATE_FILE\" ]; do /bin/sleep 0.02; done",
    "fi",
    `exec ${quote(realGit)} \"$@\"`,
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
    let stdout = ""; let stderr = ""; let timedOut = false;
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
      clearTimeout(timeout); clearTimeout(hardStop);
      if (timedOut) return rejectRun(new Error(`${command} timed out after ${timeoutMs}ms`));
      if (code !== 0) return rejectRun(new Error(`${command} exited with ${code ?? signal}\n${stderr}`));
      resolveRun({ stdout, stderr });
    });
  });
}

function killGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  } else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
