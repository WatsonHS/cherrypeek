#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMetadataFixture } from "../tests/indexing/fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const testNamePattern = process.argv.slice(2).find(argument => argument.startsWith("--test-name-pattern="))?.slice("--test-name-pattern=".length);
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-metadata-index-"));
const fixtureRoot = join(temporaryRoot, "fixtures");
const dataRoot = join(temporaryRoot, "app-data");
const helperDirectory = join(temporaryRoot, "git-wrapper");
const daemonBinary = join(root, "target", "debug", process.platform === "win32" ? "commitscope-daemon.exe" : "commitscope-daemon");
let failed = false;

try {
  const fixture = await createMetadataFixture(fixtureRoot, { count: 130, sha256: true });
  await createGitWrapper(helperDirectory);
  const specialMessage = "中文 metadata · punctuation !?\n\n正文保留多行、标点：，。！？ and Unicode 🔎\nCo-authored-by: Second Person <second@example.invalid>";
  const expected = {
    mainTip: fixture.mainTip,
    sideTip: fixture.sideTip,
    mergeTip: fixture.mergeTip,
    mergeParents: fixture.mergeParents,
    specialOid: fixture.specialOid,
    specialMessage,
    headCommitCount: fixture.mainReachableCount,
    allBranchCommitCount: fixture.commitCount,
    sideCommitCount: fixture.sideReachableCount,
    sha256Tip: fixture.sha256Tip,
  };
  await writeFile(join(temporaryRoot, "expected.json"), JSON.stringify(expected));
  await run("cargo", ["build", "--locked", "-p", "commitscope-daemon"], { cwd: root, timeoutMs: 300_000 });
  await access(daemonBinary);
  const env = cleanEnvironment({
    COMMITSCOPE_INDEX_REPOSITORY: fixture.repository,
    COMMITSCOPE_INDEX_SHA256_REPOSITORY: fixture.sha256Repository ?? "",
    COMMITSCOPE_INDEX_DATA_ROOT: dataRoot,
    COMMITSCOPE_INDEX_EXPECTED: join(temporaryRoot, "expected.json"),
    COMMITSCOPE_INDEX_GIT_WRAPPER: helperDirectory,
    COMMITSCOPE_INDEX_GATE_FILE: join(temporaryRoot, "index-batch.gate"),
    COMMITSCOPE_INDEX_BLOCK_PID_FILE: join(temporaryRoot, "index-batch.pid"),
    COMMITSCOPE_INDEX_BATCH_COUNT_FILE: join(temporaryRoot, "index-batch.count"),
    COMMITSCOPE_INDEX_GATE_REPOSITORY: fixture.repository,
    PATH: `${helperDirectory}:${process.env.PATH ?? ""}`,
    COMMITSCOPE_DAEMON_PATH: daemonBinary,
  });
  const testArgs = ["--test", "--test-concurrency=1", "--test-timeout=90000"];
  if (testNamePattern) testArgs.push(`--test-name-pattern=${testNamePattern}`);
  testArgs.push(join(root, "tests/indexing/metadata-index.test.mjs"));
  await run(process.execPath, testArgs, {
    cwd: root, env, timeoutMs: 720_000, inherit: true,
  });
  process.stdout.write("Metadata index integration tests passed; temporary Git fixtures and app data were removed.\n");
} catch (error) {
  failed = true;
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  if (failed) process.stderr.write("Temporary Git fixtures, SQLite caches, and process markers were cleaned.\n");
}

async function createGitWrapper(directory) {
  if (process.platform === "win32") return;
  await mkdir(directory, { recursive: true });
  const wrapperPath = join(directory, "git");
  const realGit = await findGitExecutable();
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const body = [
    "#!/bin/sh",
    "target=''",
    "previous=''",
    "is_metadata_batch='false'",
    "for argument in \"$@\"; do",
    "  if [ \"$previous\" = '-C' ]; then target=\"$argument\"; fi",
    "  case \"$argument\" in --batch=*) is_metadata_batch='true' ;; esac",
    "  previous=\"$argument\"",
    "done",
    "input_file=''",
    "if [ \"$is_metadata_batch\" = 'true' ] && [ \"$target\" = \"$COMMITSCOPE_INDEX_GATE_REPOSITORY\" ] && [ -n \"$COMMITSCOPE_INDEX_BATCH_COUNT_FILE\" ]; then",
    "  input_file=$(mktemp)",
    "  cat > \"$input_file\"",
    "  batch_limit=$(wc -l < \"$input_file\" | tr -d ' ')",
    "  if [ \"$batch_limit\" -ge 64 ]; then",
    "    count=0; [ ! -f \"$COMMITSCOPE_INDEX_BATCH_COUNT_FILE\" ] || count=$(cat \"$COMMITSCOPE_INDEX_BATCH_COUNT_FILE\")",
    "    count=$((count + 1)); printf '%s\\n' \"$count\" > \"$COMMITSCOPE_INDEX_BATCH_COUNT_FILE\"",
    "    if [ -e \"$COMMITSCOPE_INDEX_GATE_FILE\" ] && [ \"$count\" -gt \"${COMMITSCOPE_INDEX_BLOCK_BATCH_AFTER:-999999}\" ]; then",
    "      printf '%s\\n' \"$$\" > \"$COMMITSCOPE_INDEX_BLOCK_PID_FILE\"",
    "      while [ -e \"$COMMITSCOPE_INDEX_GATE_FILE\" ]; do /bin/sleep 0.02; done",
    "    fi",
    "  fi",
    "fi",
    "if [ -n \"$input_file\" ]; then " + quote(realGit) + " \"$@\" < \"$input_file\"; status=$?; rm -f \"$input_file\"; exit $status; fi",
    "exec " + quote(realGit) + " \"$@\"",
  ].join("\n") + "\n";
  await writeFile(wrapperPath, body, { mode: 0o700 });
  await chmod(wrapperPath, 0o700);
}

async function findGitExecutable() {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory, "git");
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error("Could not find the real Git executable");
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
      clearTimeout(timeout); clearTimeout(hardStop);
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
