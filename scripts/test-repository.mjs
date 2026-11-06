#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-repository-test-"));
const keepDirectory = args.keepOutput ? resolve(args.keepOutput) : null;
let fixtureRoot = join(keepDirectory ?? temporaryRoot, "fixtures");
const helperDirectory = join(temporaryRoot, "helpers");
const slowGitDirectory = join(helperDirectory, "slow-bin");
const unavailableGitDirectory = join(helperDirectory, "unavailable-bin");
const fetchSentinel = join(temporaryRoot, "fetch-helper-invoked.txt");
const daemonBinary = join(root, "target", "debug", process.platform === "win32" ? "commitscope-daemon.exe" : "commitscope-daemon");

try {
  if (keepDirectory) {
    await mkdir(keepDirectory, { recursive: false }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    if ((await readdir(keepDirectory)).length > 0) throw new Error(`Refusing to overwrite non-empty --keep-output directory: ${keepDirectory}`);
    await mkdir(fixtureRoot, { recursive: false });
  }
  await run(process.execPath, [join(root, "scripts/generate-fixtures.mjs"), "--output", fixtureRoot], { cwd: root, timeoutMs: 120_000 });
  fixtureRoot = await realpath(fixtureRoot);
  await run("cargo", ["build", "--locked", "-p", "commitscope-daemon"], { cwd: root, timeoutMs: 300_000 });
  const executableSentinel = await createRemoteHelper(helperDirectory);
  await createSlowGitWrapper(slowGitDirectory, temporaryRoot);
  await createUnavailableGit(unavailableGitDirectory);

  const testEnv = cleanEnvironment({
    COMMITSCOPE_FIXTURE_ROOT: fixtureRoot,
    COMMITSCOPE_FIXTURE_MANIFEST: join(fixtureRoot, "manifest.json"),
    COMMITSCOPE_DAEMON_PATH: daemonBinary,
    COMMITSCOPE_REMOTE_HELPER_DIR: helperDirectory,
    COMMITSCOPE_FETCH_SENTINEL: fetchSentinel,
    COMMITSCOPE_EXEC_SENTINEL: join(temporaryRoot, "exec-sentinel-invoked.txt"),
    COMMITSCOPE_EXEC_SENTINEL_PROGRAM: executableSentinel,
    COMMITSCOPE_HOOKS_DIR: join(helperDirectory, "hooks"),
    COMMITSCOPE_SLOW_GIT_DIRECTORY: slowGitDirectory,
    COMMITSCOPE_SLOW_GIT_PID_FILE: join(temporaryRoot, "slow-git.pid"),
    COMMITSCOPE_UNAVAILABLE_GIT_DIRECTORY: unavailableGitDirectory,
  });
  await run(process.execPath, ["--test", "--test-timeout=30000", join(root, "tests/repository/preview.test.mjs")], { cwd: root, env: testEnv, timeoutMs: 180_000, inherit: true });

  if (args.uiSmoke) {
    const smokeScript = join(root, "tests/smoke/repository-smoke.mjs");
    const desktopEntry = join(root, "apps/desktop/dist/main/index.cjs");
    try {
      await stat(desktopEntry);
      await stat(smokeScript);
    } catch {
      throw new Error("--ui-smoke requires `pnpm build` and tests/smoke/repository-smoke.mjs");
    }
    await run(process.execPath, [smokeScript, `--repository=${join(fixtureRoot, "topology")}`], { cwd: root, env: cleanEnvironment(), timeoutMs: 120_000, inherit: true });
  }

  process.stdout.write(`Repository tests passed.${keepDirectory ? ` Fixture output retained at ${fixtureRoot}` : " Temporary fixture removed."}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  if (keepDirectory) process.stderr.write(`Fixture and failure evidence retained at ${fixtureRoot}\n`);
  process.exitCode = 1;
} finally {
  if (!args.keepOutput) await rm(temporaryRoot, { recursive: true, force: true });
}

function parseArgs(argv) {
  let uiSmoke = false;
  let keepOutput;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--ui-smoke") uiSmoke = true;
    else if (argument === "--keep-output") keepOutput = argv[++index];
    else if (argument.startsWith("--keep-output=")) keepOutput = argument.slice("--keep-output=".length);
    else if (argument === "--help") {
      process.stdout.write("Usage: node scripts/test-repository.mjs [--ui-smoke] [--keep-output <new-directory>]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (keepOutput && !keepOutput.trim()) throw new Error("--keep-output requires a new directory");
  return { uiSmoke, keepOutput };
}

async function createRemoteHelper(directory) {
  if (process.platform === "win32") return;
  await mkdir(directory, { recursive: true });
  const sentinelProgram = join(directory, "commitscope-sentinel");
  await writeFile(sentinelProgram, "#!/bin/sh\nif [ -n \"$COMMITSCOPE_EXEC_SENTINEL\" ]; then printf 'invoked\\n' >> \"$COMMITSCOPE_EXEC_SENTINEL\"; fi\nexit 1\n", { mode: 0o700 });
  await chmod(sentinelProgram, 0o700);
  const hooksDirectory = join(directory, "hooks");
  await mkdir(hooksDirectory, { recursive: true });
  await writeFile(join(hooksDirectory, "pre-commit"), "#!/bin/sh\nif [ -n \"$COMMITSCOPE_EXEC_SENTINEL\" ]; then printf 'hook\\n' >> \"$COMMITSCOPE_EXEC_SENTINEL\"; fi\nexit 1\n", { mode: 0o700 });
  await chmod(join(hooksDirectory, "pre-commit"), 0o700);
  const helperPath = join(directory, "git-remote-sentinel");
  await writeFile(helperPath, "#!/bin/sh\nif [ -n \"$COMMITSCOPE_FETCH_SENTINEL\" ]; then printf 'invoked\\n' >> \"$COMMITSCOPE_FETCH_SENTINEL\"; fi\nexit 1\n", { mode: 0o700 });
  await chmod(helperPath, 0o700);
  return sentinelProgram;
}

async function createSlowGitWrapper(directory, outputRoot) {
  if (process.platform === "win32") return;
  await mkdir(directory, { recursive: true });
  const realGit = await findGitExecutable();
  const pidFile = join(outputRoot, "slow-git.pid");
  const wrapper = join(directory, "git");
  const body = `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "rev-list" ]; then printf '%s\\n' "$$" > '${pidFile}'; exec /bin/sleep 30; fi\ndone\nexec '${realGit}' "$@"\n`;
  await writeFile(wrapper, body, { mode: 0o700 });
  await chmod(wrapper, 0o700);
}

async function createUnavailableGit(directory) {
  if (process.platform === "win32") return;
  await mkdir(directory, { recursive: true });
  const invalidExecutable = join(directory, "git");
  await writeFile(invalidExecutable, "#!/commitscope-test/missing-interpreter\n", { mode: 0o700 });
  await chmod(invalidExecutable, 0o700);
}

async function findGitExecutable() {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory, "git");
    try {
      const metadata = await stat(candidate);
      if (metadata.isFile()) return candidate;
    } catch {}
  }
  throw new Error("Could not locate system Git for the controlled cancellation wrapper");
}

function cleanEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, ...extra };
}

function run(command, commandArgs, { cwd, env = cleanEnvironment(), timeoutMs, inherit = false }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, { cwd, env, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-32 * 1024); });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32 * 1024); });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      const hardStop = setTimeout(() => killGroup(child, "SIGKILL"), 1000);
      hardStop.unref();
      child.once("close", () => clearTimeout(hardStop));
    }, timeoutMs);
    const finish = (code, signal, error) => {
      clearTimeout(timer);
      if (error) return rejectRun(error);
      if (timedOut) return rejectRun(new Error(`${command} ${commandArgs.join(" ")} timed out after ${timeoutMs}ms`));
      if (code !== 0) return rejectRun(new Error(`${command} exited with ${code ?? signal}\n${stderr}`));
      if (!inherit && stdout) process.stdout.write(stdout);
      resolveRun();
    };
    child.once("error", error => { clearTimeout(timer); rejectRun(error); });
    child.once("close", (code, signal) => finish(code, signal));
  });
}

function killGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  } else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
