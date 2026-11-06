#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const largeRepositoryArg = readLargeRepositoryArg();
const testRoot = await mkdtemp(join(tmpdir(), "commitscope-readers-"));
const fixtureRoot = join(testRoot, "fixtures");
const diagnosticsRoot = join(testRoot, "diagnostics");
const testFile = join(root, "tests/readers/reader-bench.test.mjs");
const binary = resolve(root, "target/release/examples", process.platform === "win32" ? "reader_bench.exe" : "reader_bench");
const largeFixture = resolve(largeRepositoryArg ?? process.env.COMMITSCOPE_READER_LARGE_REPO ?? join(root, "output/fixtures/p0-03-seed-20261107/large"));
let preserve = false;
let commandIndex = 0;

try {
  try {
    await access(largeFixture);
  } catch {
    throw new Error(`The fixed 100k reader fixture is missing at ${largeFixture}. Generate a new fixture with ` +
      `\`pnpm fixtures:generate --output output/fixtures/p0-04-reader-large --large --seed 20261107\`, then run ` +
      `\`node scripts/test-readers.mjs --large-repository="$PWD/output/fixtures/p0-04-reader-large/large"\`. Existing baseline data is never regenerated or modified by this test.`);
  }
  await run("cargo", ["build", "--release", "--locked", "-p", "commitscope-daemon", "--example", "reader_bench"], {
    cwd: root,
    timeoutMs: 300_000,
  });
  await run(process.execPath, [join(root, "scripts/generate-fixtures.mjs"), "--output", fixtureRoot], {
    cwd: root,
    timeoutMs: 180_000,
  });
  await access(testFile);

  const gitExecutable = await findGit();
  await mkdir(diagnosticsRoot, { recursive: true });
  const result = await run(process.execPath, ["--test", "--test-timeout=45000", testFile], {
    cwd: root,
    timeoutMs: 300_000,
    env: {
      ...cleanEnvironment(),
      COMMITSCOPE_READER_BENCH_PATH: binary,
      COMMITSCOPE_READER_FIXTURE_ROOT: fixtureRoot,
      COMMITSCOPE_READER_LARGE_REPO: largeFixture,
      COMMITSCOPE_READER_GIT_EXECUTABLE: gitExecutable,
      COMMITSCOPE_READER_TEMP_ROOT: testRoot,
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  process.stdout.write("Headless reader validation passed. No desktop assets were built.\n");
} catch (error) {
  preserve = true;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (!await exists(diagnosticsRoot)) await mkdir(diagnosticsRoot, { recursive: true });
  process.stderr.write(`Reader fixtures and diagnostics retained at ${testRoot}\n`);
  process.exitCode = 1;
} finally {
  if (!preserve) await rm(testRoot, { recursive: true, force: true });
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function readLargeRepositoryArg() {
  const argv = process.argv.slice(2);
  let repository;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--large-repository") {
      repository = argv[++index];
      if (!repository) throw new Error("--large-repository requires an absolute repository path");
    }
    else if (argument.startsWith("--large-repository=")) repository = argument.slice("--large-repository=".length);
    else throw new Error(`Unknown argument: ${argument}\nUsage: node scripts/test-readers.mjs [--large-repository=<absolute-100k-path>]`);
  }
  if (repository && !repository.startsWith("/")) throw new Error("--large-repository must be an absolute path");
  return repository;
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function findGit() {
  const executable = process.platform === "win32" ? "where" : "which";
  const result = await run(executable, ["git"], { cwd: root, timeoutMs: 5000 });
  const path = result.stdout.split(/\r?\n/).find(line => line.trim());
  if (!path || !path.startsWith("/")) throw new Error(`Could not resolve an absolute Git executable from ${executable}`);
  return path.trim();
}

function run(command, args, { cwd, env = cleanEnvironment(), timeoutMs }) {
  return new Promise((resolveRun, rejectRun) => {
    commandIndex += 1;
    const diagnosticPrefix = `${String(commandIndex).padStart(2, "02")}-${command.replace(/[^a-z0-9_-]/gi, "_")}`;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-64 * 1024); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      const hardStop = setTimeout(() => killGroup(child, "SIGKILL"), 1500);
      hardStop.unref();
      child.once("close", () => clearTimeout(hardStop));
    }, timeoutMs);
    child.once("error", error => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      void (async () => {
        await mkdir(diagnosticsRoot, { recursive: true });
        await writeFile(join(diagnosticsRoot, `${diagnosticPrefix}.stdout.log`), stdout);
        await writeFile(join(diagnosticsRoot, `${diagnosticPrefix}.stderr.log`), stderr);
        if (timedOut) return rejectRun(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs} ms\n${stderr}`));
        if (code !== 0) return rejectRun(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}\n${stdout}\n${stderr}`));
        resolveRun({ code, signal, stdout, stderr });
      })().catch(rejectRun);
    });
  });
}

function killGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  } else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
