#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSearchFixture, git, snapshotTree } from "../tests/search/fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const testNamePattern = process.argv.slice(2).find(argument => argument.startsWith("--test-name-pattern="))?.slice("--test-name-pattern=".length);
const debugBuild = process.argv.includes("--debug");
const realRepositoryOnly = process.argv.includes("--real-repository");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-metadata-search-"));
const fixtureRoot = join(temporaryRoot, "fixtures");
const dataRoot = join(temporaryRoot, "app-data");
const helperDirectory = join(temporaryRoot, "git-wrapper");
const expectedPath = join(temporaryRoot, "search-oracle.json");
const daemonBinary = join(root, "target", debugBuild ? "debug" : "release", process.platform === "win32" ? "commitscope-daemon.exe" : "commitscope-daemon");
const gateFile = join(temporaryRoot, "index-batch.gate");
const gatePidFile = join(temporaryRoot, "index-batch.pid");
const gateCountFile = join(temporaryRoot, "index-batch.count");
const gitInvocationCountFile = join(temporaryRoot, "repository-git-invocation.count");
let failed = false;

try {
  const fixture = await createSearchFixture(fixtureRoot, { count: 2_600 });
  if (fixture.oids.length < 2_500) throw new Error(`Search fixture preflight has only ${fixture.oids.length} commits`);
  if (fixture.ambiguousOids.length < 2) throw new Error("Search fixture preflight lacks a real four-hex OID collision");
  if (fixture.oids.at(-1) !== fixture.rootOid) throw new Error("Search fixture preflight does not put the future-time root last in the Git topology walk");
  if (fixture.commits.get(fixture.rootOid).committer.timestamp <= fixture.commits.get(fixture.oids[0]).committer.timestamp) {
    throw new Error("Search fixture preflight lacks a late-indexed commit that sorts before earlier indexed hits");
  }
  if (JSON.stringify(await snapshotTree(fixture.repository)) !== JSON.stringify(fixture.snapshot)) {
    throw new Error("Search fixture preflight detected a Git worktree or ref mutation");
  }
  process.stdout.write(`Search fixture preflight: ${fixture.oids.length} commits, collision ${fixture.ambiguousPrefix} (${fixture.ambiguousOids.length} OIDs), ${fixture.framePageBytes} byte page, delayed high-time root, unchanged repository.\n`);

  await createGitWrapper(helperDirectory);
  await writeFile(expectedPath, JSON.stringify({
    records: [...fixture.commits.values()],
    snapshotPrefix: fixture.oids,
    mainTip: fixture.mainTip,
    sideTip: fixture.sideTip,
    sha256Tip: fixture.sha256Tip,
    preMergeTip: fixture.preMergeTip,
    preMergeOids: fixture.preMergeOids,
    sideOids: (await git(fixture.repository, ["rev-list", "--topo-order", fixture.sideTip])).split("\n").filter(Boolean),
    rootOid: fixture.rootOid,
    dstOids: [...fixture.commits.values()].filter(record => record.committer.timestamp >= 1_772_956_800 && record.committer.timestamp < 1_773_039_600)
      .sort((left, right) => right.committer.timestamp - left.committer.timestamp || (left.oid < right.oid ? -1 : left.oid > right.oid ? 1 : 0))
      .map(record => record.oid),
    ambiguousPrefix: fixture.ambiguousPrefix,
    ambiguousOids: fixture.ambiguousOids,
    unicode: fixture.unicodeOids,
  }));
  await writeFile(gateCountFile, "0\n");
  await writeFile(gitInvocationCountFile, "0\n");
  const buildArgs = ["build", "--locked", "-p", "commitscope-daemon"];
  if (!debugBuild) buildArgs.push("--release");
  await run("cargo", buildArgs, { cwd: root, timeoutMs: 300_000 });
  await access(daemonBinary);

  const env = cleanEnvironment({
    COMMITSCOPE_SEARCH_REPOSITORY: fixture.repository,
    COMMITSCOPE_SEARCH_SHA256_REPOSITORY: fixture.sha256Repository ?? "",
    COMMITSCOPE_SEARCH_DATA_ROOT: dataRoot,
    COMMITSCOPE_SEARCH_EXPECTED: expectedPath,
    COMMITSCOPE_SEARCH_GATE_FILE: gateFile,
    COMMITSCOPE_SEARCH_GATE_PID_FILE: gatePidFile,
    COMMITSCOPE_SEARCH_GATE_COUNT_FILE: gateCountFile,
    COMMITSCOPE_SEARCH_GIT_COUNT_FILE: gitInvocationCountFile,
    COMMITSCOPE_DAEMON_PATH: daemonBinary,
    COMMITSCOPE_INDEX_GATE_FILE: join(temporaryRoot, "unused-gate"),
    COMMITSCOPE_INDEX_BLOCK_PID_FILE: gatePidFile,
    COMMITSCOPE_INDEX_BATCH_COUNT_FILE: gateCountFile,
    COMMITSCOPE_INDEX_GATE_REPOSITORY: fixture.repository,
    COMMITSCOPE_INDEX_BLOCK_BATCH_AFTER: "999999",
    PATH: `${helperDirectory}:${process.env.PATH ?? ""}`,
  });
  if (!realRepositoryOnly) {
    const testArgs = ["--test", "--test-concurrency=1", "--test-timeout=120000"];
    if (testNamePattern) testArgs.push(`--test-name-pattern=${testNamePattern}`);
    testArgs.push(join(root, "tests/search/metadata-search.test.mjs"));
    await run(process.execPath, testArgs, { cwd: root, env, timeoutMs: 1_200_000, inherit: true });
  }
  if (realRepositoryOnly || process.argv.includes("--include-real-repository")) {
    await run(process.execPath, [join(root, "tests/search/project-repository-trial.mjs")], {
      cwd: root,
      env: cleanEnvironment({
        COMMITSCOPE_PROJECT_REPOSITORY: root,
        COMMITSCOPE_DAEMON_PATH: daemonBinary,
        COMMITSCOPE_DAEMON_PROFILE: debugBuild ? "debug" : "release",
      }),
      timeoutMs: 180_000,
      inherit: true,
    });
  }
  process.stdout.write("Metadata search integration tests passed; temporary Git fixture and application data were removed.\n");
} catch (error) {
  failed = true;
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  if (failed) process.stderr.write("Temporary search fixtures, SQLite caches and process markers were cleaned.\n");
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
    "if [ \"$target\" = \"$COMMITSCOPE_INDEX_GATE_REPOSITORY\" ] && [ -n \"$COMMITSCOPE_SEARCH_GIT_COUNT_FILE\" ]; then",
    "  git_count=0; [ ! -f \"$COMMITSCOPE_SEARCH_GIT_COUNT_FILE\" ] || git_count=$(cat \"$COMMITSCOPE_SEARCH_GIT_COUNT_FILE\")",
    "  git_count=$((git_count + 1)); printf '%s\\n' \"$git_count\" > \"$COMMITSCOPE_SEARCH_GIT_COUNT_FILE\"",
    "fi",
    "input_file=''",
    "if [ \"$is_metadata_batch\" = 'true' ] && [ \"$target\" = \"$COMMITSCOPE_INDEX_GATE_REPOSITORY\" ]; then",
    "  input_file=$(mktemp); cat > \"$input_file\"",
    "  batch_limit=$(wc -l < \"$input_file\" | tr -d ' ') ",
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
