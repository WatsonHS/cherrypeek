#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-history-test-"));
const fixtureRoot = join(temporaryRoot, "fixtures");
const helperDirectory = join(temporaryRoot, "helpers", "bin");
const cacheRepository = join(temporaryRoot, "cache-history");
const longRepository = join(temporaryRoot, "long-history");
const daemonBinary = join(root, "target", "debug", process.platform === "win32" ? "commitscope-daemon.exe" : "commitscope-daemon");
let failed = false;

try {
  await run(process.execPath, [join(root, "scripts/generate-fixtures.mjs"), "--output", fixtureRoot], { cwd: root, timeoutMs: 120_000 });
  await createCacheRepository(cacheRepository);
  await createLongRepository(longRepository);
  await run("cargo", ["build", "--locked", "-p", "commitscope-daemon"], { cwd: root, timeoutMs: 300_000 });
  const realGit = await findGitExecutable();
  await createGitWrapper(helperDirectory, realGit);
  const testEnv = cleanEnvironment({
    COMMITSCOPE_HISTORY_FIXTURE_ROOT: fixtureRoot,
    COMMITSCOPE_DAEMON_PATH: daemonBinary,
    COMMITSCOPE_HISTORY_REAL_GIT: realGit,
    COMMITSCOPE_HISTORY_DATA_ROOT: join(temporaryRoot, "data"),
    COMMITSCOPE_HISTORY_SLOW_GIT_DIRECTORY: helperDirectory,
    COMMITSCOPE_HISTORY_COUNT_GIT_DIRECTORY: helperDirectory,
    COMMITSCOPE_HISTORY_GIT_DIRECTORY: helperDirectory,
    COMMITSCOPE_HISTORY_FETCH_SENTINEL: join(temporaryRoot, "fetch-helper-invoked.txt"),
    COMMITSCOPE_HISTORY_GIT_LOG: join(temporaryRoot, "git-commands.log"),
    COMMITSCOPE_HISTORY_CACHE_REPOSITORY: cacheRepository,
    COMMITSCOPE_HISTORY_MISSING_TIP_REPOSITORY: cacheRepository,
    COMMITSCOPE_HISTORY_LONG_REPOSITORY: longRepository,
    COMMITSCOPE_HISTORY_PID_FILE: join(temporaryRoot, "history-git.pid"),
    COMMITSCOPE_HISTORY_SLOW_PID_FILE: join(temporaryRoot, "history-slow-git.pid"),
    COMMITSCOPE_HISTORY_BLOCK_GATE_FILE: join(temporaryRoot, "block-git.gate"),
  });
  await run(process.execPath, ["--test", "--test-timeout=45000", join(root, "tests/history/history-pagination.test.mjs")], {
    cwd: root, env: testEnv, timeoutMs: 420_000, inherit: true,
  });
  process.stdout.write("History pagination tests passed; temporary fixtures and app data were removed.\n");
} catch (error) {
  failed = true;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  if (failed) process.stderr.write("Temporary fixtures, app data, process markers, and Git wrapper were cleaned.\n");
}

async function createGitWrapper(directory, realGit) {
  if (process.platform === "win32") throw new Error("History process-control tests currently require a Unix-like shell");
  await mkdir(directory, { recursive: true });
  const wrapper = join(directory, "git");
  const body = `#!/bin/sh
command_name=''
target=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '-C' ]; then target="$argument"; fi
  case "$argument" in rev-list|cat-file) command_name="$argument" ;; esac
  previous="$argument"
done
if [ -n "$COMMITSCOPE_HISTORY_LOG_FILE" ] && { [ "$command_name" = 'rev-list' ] || [ "$command_name" = 'cat-file' ]; }; then
  printf '%s %s ' "$command_name" "$target" >> "$COMMITSCOPE_HISTORY_LOG_FILE"
  printf '<%s> ' "$@" >> "$COMMITSCOPE_HISTORY_LOG_FILE"
  printf '\\n' >> "$COMMITSCOPE_HISTORY_LOG_FILE"
fi
if [ "$command_name" = "$COMMITSCOPE_HISTORY_BLOCK_COMMAND" ] && [ -n "$COMMITSCOPE_HISTORY_BLOCK_GATE_FILE" ] && [ -e "$COMMITSCOPE_HISTORY_BLOCK_GATE_FILE" ]; then
  if [ "$command_name" = 'cat-file' ]; then IFS= read -r consumed || true; fi
  printf '%s\\n' "$$" > "$COMMITSCOPE_HISTORY_PID_FILE"
  exec /bin/sleep 30
fi
if [ -n "$COMMITSCOPE_HISTORY_TRUNCATE_REPOSITORY" ] && [ "$command_name" = 'rev-list' ]; then
  printf 'deadbeef'
  exit 0
fi
if [ -n "$COMMITSCOPE_HISTORY_IDLE_PID_FILE" ] && [ "$command_name" = 'rev-list' ]; then
  printf '%s\\n' "$$" > "$COMMITSCOPE_HISTORY_IDLE_PID_FILE"
  '${realGit.replaceAll("'", "'\\''")}' "$@"
  exec /bin/sleep 30
fi
exec '${realGit.replaceAll("'", "'\\''")}' "$@"
`;
  await writeFile(wrapper, body, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  const helper = join(directory, "git-remote-sentinel");
  await writeFile(helper, "#!/bin/sh\nprintf 'invoked\\n' >> \"$COMMITSCOPE_HISTORY_FETCH_SENTINEL\"\nexit 1\n", { mode: 0o700 });
  await chmod(helper, 0o700);
}

async function createCacheRepository(repository) {
  await mkdir(repository, { recursive: false });
  await run("git", ["init", "--quiet", repository], { cwd: root, timeoutMs: 5000 });
  for (let index = 0; index < 12; index += 1) {
    const env = cleanEnvironment({ GIT_AUTHOR_DATE: `2026-11-07T00:00:${String(index).padStart(2, "0")}+0000`, GIT_COMMITTER_DATE: `2026-11-07T00:00:${String(index).padStart(2, "0")}+0000` });
    await run("git", ["-C", repository, "-c", "user.name=History Test", "-c", "user.email=history@example.invalid", "commit", "--allow-empty", "--quiet", "-m", `cache page ${index}`], { cwd: root, env, timeoutMs: 5000 });
  }
  const count = Number((await runCapture("git", ["-C", repository, "rev-list", "--count", "HEAD"], { cwd: root, timeoutMs: 5000 })).trim());
  if (count !== 12) throw new Error(`Expected the cache fixture to have 12 commits, got ${count}`);
}

async function createLongRepository(repository) {
  await mkdir(repository, { recursive: false });
  await run("git", ["init", "--quiet", repository], { cwd: root, timeoutMs: 5000 });
  const stream = [];
  for (let index = 1; index <= 1001; index += 1) {
    const previous = index > 1 ? `from :${index - 1}\n` : "";
    const timestamp = 1_800_000_000 + index;
    const message = `long page summary ${String(index).padStart(3, "0")} ${"x".repeat(2048)}\nbody ${index}`;
    stream.push(`commit refs/heads/main\nmark :${index}\nauthor History Test <history@example.invalid> ${timestamp} +0000\ncommitter History Test <history@example.invalid> ${timestamp} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${previous}\n`);
  }
  stream.push("done\n");
  await runFastImport(repository, stream.join(""));
  const count = Number((await runCapture("git", ["-C", repository, "rev-list", "--count", "HEAD"], { cwd: root, timeoutMs: 10_000 })).trim());
  if (count !== 1001) throw new Error(`Expected the long fixture to have 1001 commits, got ${count}`);
}

function runFastImport(repository, input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", ["-C", repository, "-c", "core.commitGraph=false", "fast-import", "--quiet"], { cwd: root, env: cleanEnvironment(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let stderr = "";
    let inputError = null;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32 * 1024); });
    child.stdin.on("error", error => { inputError = error; });
    const timeout = setTimeout(() => killGroup(child, "SIGKILL"), 30_000);
    child.once("error", error => { clearTimeout(timeout); rejectRun(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || inputError) return rejectRun(new Error(`git fast-import exited with ${code ?? signal}${inputError ? ` (${inputError.message})` : ""}\n${stderr}`));
      resolveRun();
    });
    child.stdin.end(input);
  });
}

async function findGitExecutable() {
  for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
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

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let stdout = "";
    let stderr = "";
    if (!options.inherit) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-64 * 1024); });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
    }
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      const hardStop = setTimeout(() => killGroup(child, "SIGKILL"), 1000);
      hardStop.unref();
      child.once("close", () => clearTimeout(hardStop));
    }, options.timeoutMs);
    child.once("error", error => { clearTimeout(timeout); rejectRun(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) return rejectRun(new Error(`${command} timed out after ${options.timeoutMs}ms`));
      if (code !== 0) return rejectRun(new Error(`${command} exited with ${code ?? signal}\n${stderr}`));
      if (!options.inherit && stdout) process.stdout.write(stdout);
      resolveRun();
    });
  });
}

function runCapture(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? cleanEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32 * 1024); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.once("error", error => { clearTimeout(timeout); rejectRun(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) return rejectRun(new Error(`${command} exited with ${code ?? signal}\n${stderr}`));
      resolveRun(stdout);
    });
  });
}

function killGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  } else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
