#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGraphFixture } from "../tests/graph/fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-graph-test-"));
const daemonPath = join(root, "target/debug", process.platform === "win32" ? "commitscope-daemon.exe" : "commitscope-daemon");
const helperDirectory = join(temporaryRoot, "helpers", "bin");
const fixturePath = join(temporaryRoot, "fixture.json");
const gateFile = join(temporaryRoot, "graph-page.gate");
const pidFile = join(temporaryRoot, "graph-page.pid");
const gitLogPath = join(root, "output/test/p2-01-graph-git.log");
const testNamePattern = process.argv.slice(2).find(argument => argument.startsWith("--test-name-pattern="))?.slice("--test-name-pattern=".length);
let failed = false;

try {
  const small = await createGraphFixture(join(temporaryRoot, "small"), { mainCommitCount: 240 });
  const large = await createGraphFixture(join(temporaryRoot, "large"), { mainCommitCount: 13_050, includeBoundaries: false });
  await writeFile(fixturePath, `${JSON.stringify({ small, large }, null, 2)}\n`);
  const realGit = await findGitExecutable();
  await rm(gitLogPath, { force: true });
  await createGitWrapper(helperDirectory, realGit);
  await run("cargo", ["build", "--locked", "-p", "commitscope-daemon"], { cwd: root, timeoutMs: 300_000 });
  await access(daemonPath);
  const env = cleanEnvironment({
    COMMITSCOPE_DAEMON_PATH: daemonPath,
    COMMITSCOPE_GRAPH_FIXTURE: fixturePath,
    COMMITSCOPE_GRAPH_DATA_ROOT: join(temporaryRoot, "app-data"),
    COMMITSCOPE_GRAPH_REAL_GIT: realGit,
    COMMITSCOPE_GRAPH_BLOCK_REPOSITORY: await realpath(small.repository),
    COMMITSCOPE_GRAPH_BLOCK_GATE_FILE: gateFile,
    COMMITSCOPE_GRAPH_BLOCK_PID_FILE: pidFile,
    COMMITSCOPE_GRAPH_GIT_LOG: gitLogPath,
    PATH: `${helperDirectory}:${process.env.PATH ?? ""}`,
  });
  const testArgs = ["--test", "--test-timeout=120000"];
  if (testNamePattern) testArgs.push(`--test-name-pattern=${testNamePattern}`);
  testArgs.push(join(root, "tests/graph/history-graph.test.mjs"));
  await run(process.execPath, testArgs, {
    cwd: root, env, timeoutMs: 900_000, inherit: true,
  });
  process.stdout.write("History graph integration tests passed; temporary Git fixtures and app data were removed.\n");
} catch (error) {
  failed = true;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  if (failed) process.stderr.write("Temporary graph fixtures, app data, and process-control files were cleaned.\n");
}

async function createGitWrapper(directory, realGit) {
  if (process.platform === "win32") throw new Error("Graph process-control tests currently require a Unix-like shell");
  await mkdir(directory, { recursive: true });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const wrapper = join(directory, "git");
  const body = `#!/bin/sh
target=''
previous=''
command_name=''
for argument in "$@"; do
  if [ "$previous" = '-C' ]; then target="$argument"; fi
  if [ "$argument" = 'cat-file' ]; then command_name='cat-file'; fi
  previous="$argument"
done
if [ -n "$target" ]; then target=$(cd "$target" 2>/dev/null && pwd -P); else target=$(pwd -P); fi
if [ -n "$COMMITSCOPE_GRAPH_GIT_LOG" ] && [ "$command_name" = 'cat-file' ]; then printf '%s %s gate=%s\\n' "$command_name" "$target" "$(test -e "$COMMITSCOPE_GRAPH_BLOCK_GATE_FILE" && echo yes || echo no)" >> "$COMMITSCOPE_GRAPH_GIT_LOG"; fi
if [ "$command_name" = 'cat-file' ] && [ "$target" = "$COMMITSCOPE_GRAPH_BLOCK_REPOSITORY" ] && [ -e "$COMMITSCOPE_GRAPH_BLOCK_GATE_FILE" ]; then
  IFS= read -r consumed || true
  printf '%s\\n' "$$" > "$COMMITSCOPE_GRAPH_BLOCK_PID_FILE"
  exec /bin/sleep 30
fi
exec ${quote(realGit)} "$@"
`;
  await writeFile(wrapper, body, { mode: 0o700 });
  await chmod(wrapper, 0o700);
}

async function findGitExecutable() {
  for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
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

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env ?? cleanEnvironment(), detached: process.platform !== "win32", windowsHide: true,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!options.inherit) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-32 * 1024); });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 1000).unref();
    }, options.timeoutMs);
    child.once("error", error => { clearTimeout(timer); rejectRun(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return rejectRun(new Error(`${command} timed out after ${options.timeoutMs}ms\n${stderr}`));
      if (code !== 0) return rejectRun(new Error(`${command} exited with ${code ?? signal}\n${stderr}`));
      if (stdout) process.stdout.write(stdout);
      resolveRun();
    });
  });
}

function killGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  } else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
