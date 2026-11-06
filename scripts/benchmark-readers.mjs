#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { ReaderBenchClient, runGitOracle } from "./reader-bench-client.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const binaryPath = join(root, "target/release/examples/reader_bench");
const sourcePath = fileURLToPath(import.meta.url);
const clientPath = join(root, "scripts/reader-bench-client.mjs");
const samplerPath = join(root, "scripts/process-tree-observation.mjs");
const args = parseArgs(process.argv.slice(2));

if (process.platform !== "darwin") throw new Error("benchmark:readers requires macOS process-tree sampling");
if (!args.output) throw new Error("Usage: pnpm benchmark:readers --repository=<large-fixture> --output=<new-json> [--git-executable=<absolute-git>] [--preflight]");

const outputPath = resolve(args.output);
const fixturePath = resolve(args.repository);
const fixtureRoot = dirname(fixturePath);
const manifestPath = join(fixtureRoot, "manifest.json");
const gitExecutable = args.gitExecutable ? resolve(args.gitExecutable) : await findGitExecutable();
const runsPerCell = args.preflight ? 1 : args.runs;
const output = {
  schemaVersion: 1,
  benchmark: "p0-04-reader-comparison",
  runKind: args.preflight ? "preflight" : "formal-matrix",
  startedAt: new Date().toISOString(),
  targetRunsPerCell: runsPerCell,
  matrix: {
    backends: ["cli", "gix"],
    pageOffsets: [0, 10_000, 50_000, 90_000],
    pageLimit: 200,
    pageRunsPerBackendOffset: runsPerCell,
    objectOffsets: [0, 10_000, 50_000, 90_000],
    objectLimit: 200,
    objectRunsPerBackendOffset: runsPerCell,
    gixObjectCacheBytes: 8 * 1024 * 1024,
    gixPackCacheBytes: 8 * 1024 * 1024,
    scanCancelRunsPerBackend: runsPerCell,
    scanCancellationDelayMs: 10,
  },
  environment: await collectEnvironment(),
  artifacts: {},
  measurement: {
    operationWallMs: "reader_bench job write through result event; distinct from the example's Rust internal phase/total timers",
    postResultSampling: "An additional process-tree sample is awaited after result and before the pure exit line. Its duration is recorded separately and not added to jobWallMs.",
    exitWallMs: "Result-to-process-close and cancel-to-process-close are recorded separately; cleanup latency is not included in Rust totalMs.",
    processTree: "100 ms macOS ps samples include reader_bench and observed descendants. RSS sums may double-count shared pages; short-lived Git may be missed. CPU from ps is a separate estimate; primary CPU uses nullable getrusage self+waited-child fields from reader_bench.",
    cache: "Each job starts a new reader_bench process and gix handle. The gix handle starts with empty bounded in-memory caches (8 MiB decoded-object cache and 8 MiB pack cache); no persistent application index/cache is reused. OS page cache is not cleared. Independent Git oracles run before measurements and touch the same fixture; this is not a cold-cache result.",
  },
  fixture: {},
  oracles: [],
  jobs: [],
  failures: [],
};

let temporaryFailure = null;
try {
  await access(binaryPath);
  await access(fixturePath);
  await access(manifestPath);
  await ensureOutputDoesNotExist(outputPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const gitMetadata = await readFixtureMetadata(fixturePath, gitExecutable);
  if (gitMetadata.commitCount !== 100_000) throw new Error(`Expected 100000 commits, Git counted ${gitMetadata.commitCount}`);
  if (manifest.fixtures?.large?.headOid !== gitMetadata.headOid) throw new Error(`Fixture manifest HEAD ${manifest.fixtures?.large?.headOid} differs from Git HEAD ${gitMetadata.headOid}`);
  if (gitMetadata.objectFormat !== "sha1" && gitMetadata.objectFormat !== "sha256") throw new Error(`Unsupported object format ${gitMetadata.objectFormat}`);
  output.fixture = {
    path: fixturePath,
    manifestPath,
    manifestSha256: await sha256File(manifestPath),
    generatorVersion: manifest.generatorVersion,
    seed: manifest.seed,
    gitVersion: gitMetadata.gitVersion,
    objectFormat: gitMetadata.objectFormat,
    headOid: gitMetadata.headOid,
    commitCount: gitMetadata.commitCount,
    packState: gitMetadata.packState,
    cacheDisclosure: "Each measurement starts a new reader_bench process and gix handle. gix's 8 MiB decoded-object cache and 8 MiB pack cache start empty for each job; no persistent index/cache is reused. OS page cache is not cleared; independent Git oracle reads each range before timing.",
  };
  output.artifacts = {
    binaryPath,
    binarySha256: await sha256File(binaryPath),
    scriptPath: sourcePath,
    scriptSha256: await sha256File(sourcePath),
    clientPath,
    clientSha256: await sha256File(clientPath),
    samplerPath,
    samplerSha256: await sha256File(samplerPath),
    gitExecutable,
  };
  const oraclePages = new Map();
  for (const offset of output.matrix.pageOffsets) {
    const oracle = await runGitOracle({ repository: fixturePath, gitExecutable, headOid: gitMetadata.headOid, operation: "page", offset, limit: output.matrix.pageLimit });
    oraclePages.set(offset, oracle);
    output.oracles.push({ operation: "page", offset, limit: output.matrix.pageLimit, oids: oracle.oids, hasMore: oracle.hasMore, visitedCount: oracle.visitedCount, rawBytes: oracle.rawBytes, objectsDigest: oracle.objectsDigest });
  }
  const objectOracles = new Map();
  for (const offset of output.matrix.objectOffsets) {
    const objectOracle = await runGitOracle({ repository: fixturePath, gitExecutable, headOid: gitMetadata.headOid, operation: "objects", oids: oraclePages.get(offset).oids });
    objectOracles.set(offset, objectOracle);
    output.oracles.push({ operation: "objects", offset, limit: output.matrix.objectLimit, oids: objectOracle.oids, rawBytes: objectOracle.rawBytes, objectsDigest: objectOracle.objectsDigest });
  }

  const matrixRuns = runsPerCell;
  for (const offset of output.matrix.pageOffsets) {
    for (let runIndex = 0; runIndex < matrixRuns; runIndex += 1) {
      for (const backend of backendOrder(runIndex)) {
        const job = makeJob({ backend, operation: "page", fixturePath, gitExecutable, headOid: gitMetadata.headOid, offset, limit: 200, oids: [] });
        const expected = oraclePages.get(offset);
        output.jobs.push(await measureJob(job, expected, { runIndex: runIndex + 1, cell: `page:${offset}`, cancelAfterMs: null }));
      }
    }
  }
  for (const offset of output.matrix.objectOffsets) {
    for (let runIndex = 0; runIndex < matrixRuns; runIndex += 1) {
      for (const backend of backendOrder(runIndex)) {
        const job = makeJob({ backend, operation: "objects", fixturePath, gitExecutable, headOid: gitMetadata.headOid, offset, limit: 200, oids: objectOracles.get(offset).oids });
        output.jobs.push(await measureJob(job, objectOracles.get(offset), { runIndex: runIndex + 1, cell: `objects:${offset}`, cancelAfterMs: null }));
      }
    }
  }
  for (let runIndex = 0; runIndex < matrixRuns; runIndex += 1) {
    for (const backend of backendOrder(runIndex)) {
      const job = makeJob({ backend, operation: "scan", fixturePath, gitExecutable, headOid: gitMetadata.headOid, offset: 0, limit: 200, oids: [] });
      output.jobs.push(await measureJob(job, null, { runIndex: runIndex + 1, cell: "scan:cancel", cancelAfterMs: 10 }));
    }
  }

  output.summary = summarizeJobs(output.jobs);
  output.finishedAt = new Date().toISOString();
  await writeNewJson(outputPath, output);
  process.stdout.write(`Wrote ${args.preflight ? "preflight" : "reader matrix"} with ${output.jobs.length} jobs to ${outputPath}\n`);
  if (output.failures.length > 0) process.exitCode = 1;
} catch (error) {
  temporaryFailure = error;
  output.failure = { message: error.message, stack: error.stack };
  output.finishedAt = new Date().toISOString();
  output.summary = summarizeJobs(output.jobs);
  try {
    await writeNewJson(outputPath, output);
  } catch (writeError) {
    process.stderr.write(`Could not save failure JSON: ${writeError.message}\n`);
  }
  process.stderr.write(`Reader benchmark failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryFailure) process.stderr.write("Failure details are retained in the new output JSON when it could be created.\n");
}

function parseArgs(argv) {
  let repository;
  let output;
  let gitExecutable;
  let preflight = false;
  let runs = 10;
  for (const argument of argv) {
    if (argument.startsWith("--repository=")) repository = argument.slice("--repository=".length);
    else if (argument.startsWith("--output=")) output = argument.slice("--output=".length);
    else if (argument.startsWith("--git-executable=")) gitExecutable = argument.slice("--git-executable=".length);
    else if (argument.startsWith("--runs=")) runs = Number(argument.slice("--runs=".length));
    else if (argument === "--preflight") preflight = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!repository || !repository.startsWith("/")) throw new Error("--repository must be an absolute path");
  if (output && !output.trim()) throw new Error("--output must not be empty");
  if (!Number.isInteger(runs) || runs < 1 || runs > 100) throw new Error("--runs must be an integer from 1 through 100");
  return { repository, output, gitExecutable, preflight, runs };
}

function makeJob({ backend, operation, fixturePath, gitExecutable, headOid, offset, limit, oids }) {
  return { backend, operation, repository: fixturePath, gitExecutable, headOid, offset, limit, oids };
}

async function measureJob(job, oracle, { runIndex, cell, cancelAfterMs }) {
  const record = { job: { ...job }, cell, runIndex, oracle: oracle ? projectOracle(oracle) : null, failures: [], semanticComparable: false };
  let client;
  try {
    client = await ReaderBenchClient.launch(binaryPath, { cwd: root, env: cleanEnvironment(), sampleIntervalMs: 100, readyTimeoutMs: 10_000 });
    record.ready = client.ready;
    client.sendJob(job);
    record.started = await client.waitForStarted(5000);
    if (cancelAfterMs !== null) {
      await delay(cancelAfterMs);
      record.cancelSent = client.sendCancel();
    }
    const result = await client.waitForResult(35_000);
    record.result = result;
    record.shutdown = await client.shutdownAfterResult({ exitTimeoutMs: 3000, reapTimeoutMs: 2000 });
    record.cpu = {
      selfMs: typeof result.cpuSelfMs === "number" ? result.cpuSelfMs : null,
      childrenMs: typeof result.cpuChildrenMs === "number" ? result.cpuChildrenMs : null,
      totalMs: typeof result.cpuSelfMs === "number" && typeof result.cpuChildrenMs === "number" ? result.cpuSelfMs + result.cpuChildrenMs : null,
      source: "getrusage fields from reader_bench; ps cumulative CPU remains a separate sampled estimate",
      psCumulativeSecondsEstimate: record.shutdown.sampler.cpuSecondsEstimate,
    };
    if (record.shutdown.sampler.sampleErrors.length > 0) record.failures.push(`process sampler had ${record.shutdown.sampler.sampleErrors.length} error(s)`);
    if (!record.shutdown.sampler.processIdentities.some(identity => identity.pid === client.child.pid)) record.failures.push("process sampler never observed the reader_bench root PID");
    record.semanticComparable = compareResult(result, oracle, job, record.failures);
    if (!record.shutdown.normalExit) record.failures.push("reader_bench or a descendant required forced cleanup or did not exit normally");
    if (job.operation === "scan" && result.status !== "cancelled") record.failures.push(`scan cancellation returned status=${result.status}`);
    if (job.operation === "scan" && (record.shutdown.cancelToResultMs === null || record.shutdown.cancelToExitMs === null)) record.failures.push("scan cancellation latency was not observable");
  } catch (error) {
    record.failures.push(error.message);
    if (client) record.cleanup = await client.cancelAndReap({ cancelResultTimeoutMs: 1500, exitTimeoutMs: 1000, reapTimeoutMs: 2000 }).catch(cleanupError => ({ cleanupError: cleanupError.message }));
  }
  if (record.failures.length > 0) output.failures.push({ cell, runIndex, backend: job.backend, operation: job.operation, failures: [...record.failures] });
  return record;
}

function compareResult(result, oracle, job, failures) {
  if (job.operation === "scan") {
    if (result.status !== "cancelled") failures.push(`scan expected cancelled status, got ${result.status}`);
    if (!Number.isInteger(result.visitedCount) || result.visitedCount < 0) failures.push("scan returned invalid visitedCount");
    if (!Number.isInteger(result.completedScans) || result.completedScans < 0) failures.push("scan returned invalid completedScans");
    return false;
  }
  if (result.status !== "ok") {
    failures.push(`expected status=ok, got ${result.status}${result.errorCode ? `/${result.errorCode}` : ""}`);
    return false;
  }
  if (!oracle) {
    failures.push("missing independent Git oracle");
    return false;
  }
  let comparable = true;
  if (JSON.stringify(result.oids) !== JSON.stringify(oracle.oids)) {
    failures.push("returned OID order differs from independent Git oracle");
    comparable = false;
  }
  if (result.hasMore !== oracle.hasMore) {
    failures.push(`hasMore differs from independent Git oracle (${result.hasMore} vs ${oracle.hasMore})`);
    comparable = false;
  }
  if (result.rawBytes !== oracle.rawBytes) {
    failures.push(`rawBytes differs from independent Git oracle (${result.rawBytes} vs ${oracle.rawBytes})`);
    comparable = false;
  }
  if (result.objectsDigest !== oracle.objectsDigest) {
    failures.push("raw object SHA-256 digest differs from independent Git oracle");
    comparable = false;
  }
  return comparable;
}

function projectOracle(oracle) {
  return { operation: oracle.operation, oids: oracle.oids, hasMore: oracle.hasMore, visitedCount: oracle.visitedCount, rawBytes: oracle.rawBytes, objectsDigest: oracle.objectsDigest };
}

function backendOrder(index) {
  return index % 2 === 0 ? ["cli", "gix"] : ["gix", "cli"];
}

function summarizeJobs(jobs) {
  const grouped = new Map();
  for (const job of jobs) {
    const key = `${job.job.operation}:${job.job.offset ?? 0}:${job.job.backend}`;
    const group = grouped.get(key) ?? [];
    group.push(job);
    grouped.set(key, group);
  }
  const cells = {};
  for (const [key, values] of grouped) {
    const isScan = values[0]?.job.operation === "scan";
    const successful = isScan
      ? values.filter(value => value.failures.length === 0 && value.result?.status === "cancelled" && value.shutdown?.cancelToResultMs !== null && value.shutdown?.cancelToExitMs !== null && value.shutdown?.normalExit)
      : values.filter(value => value.failures.length === 0 && value.result?.status === "ok" && value.semanticComparable && value.shutdown?.normalExit);
    const timings = successful.map(value => value.result.totalMs).filter(Number.isFinite).sort((a, b) => a - b);
    cells[key] = {
      attempts: values.length,
      successfulComparableRuns: isScan ? null : successful.length,
      successfulCancelRuns: isScan ? successful.length : null,
      failedOrNonComparableRuns: values.length - successful.length,
      internalTotalMs: { values: timings, median: median(timings), p95: nearestRank(timings, 0.95) },
      internalStageMs: {
        open: successful.map(value => value.result.openMs),
        walk: successful.map(value => value.result.walkMs),
        objects: successful.map(value => value.result.objectsMs),
      },
      getrusageCpuTotalMs: successful.map(value => value.cpu?.totalMs ?? null),
      sampledPeakTreeRssKB: successful.map(value => peakTreeRss(value.shutdown.sampler.samples)),
      ...(isScan ? {
        cancelToResultMs: successful.map(value => value.shutdown.cancelToResultMs),
        cancelToExitMs: successful.map(value => value.shutdown.cancelToExitMs),
        visitedCount: successful.map(value => value.result.visitedCount),
        completedScans: successful.map(value => value.result.completedScans),
      } : {}),
    };
  }
  return { percentileMethod: "nearest-rank p95", cells };
}

function peakTreeRss(samples) {
  return samples.reduce((peak, sample) => Math.max(peak, sample.tree.reduce((sum, processInfo) => sum + processInfo.rssKB, 0)), 0);
}

function median(values) {
  if (!values.length) return null;
  const index = Math.floor(values.length / 2);
  return values.length % 2 ? values[index] : (values[index - 1] + values[index]) / 2;
}

function nearestRank(values, percentile) {
  if (!values.length) return null;
  return values[Math.max(0, Math.ceil(percentile * values.length) - 1)];
}

async function readFixtureMetadata(repository, gitExecutable) {
  const [head, count, objectFormat, pack, gitVersion] = await Promise.all([
    gitText(gitExecutable, repository, ["rev-parse", "--verify", "HEAD"]),
    gitText(gitExecutable, repository, ["rev-list", "--count", "HEAD"]),
    gitText(gitExecutable, repository, ["rev-parse", "--show-object-format"]),
    gitText(gitExecutable, repository, ["count-objects", "-v"]),
    execFileAsync(gitExecutable, ["--version"], { env: cleanEnvironment(), timeout: 3000 }).then(result => result.stdout.trim()),
  ]);
  return { headOid: head.trim(), commitCount: Number(count.trim()), objectFormat: objectFormat.trim(), packState: parsePackState(pack), gitVersion };
}

async function gitText(gitExecutable, repository, args) {
  const result = await execFileAsync(gitExecutable, ["--no-lazy-fetch", "--no-pager", "--no-replace-objects", "--no-optional-locks", "-c", "protocol.allow=never", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-C", repository, ...args], { env: cleanEnvironment(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}

function parsePackState(text) {
  const state = {};
  for (const line of text.split("\n")) {
    const match = /^(count|size|in-pack|packs|size-pack|prune-packable|garbage|size-garbage):\s+(\d+)/.exec(line);
    if (match) state[match[1]] = Number(match[2]);
  }
  return state;
}

async function collectEnvironment() {
  const [mac, model, physical, logical, memory, rust] = await Promise.all([
    execFileAsync("sw_vers", ["-productVersion"], { timeout: 3000 }).then(result => result.stdout.trim()),
    execFileAsync("sysctl", ["-n", "hw.model"], { timeout: 3000 }).then(result => result.stdout.trim()),
    execFileAsync("sysctl", ["-n", "hw.physicalcpu"], { timeout: 3000 }).then(result => Number(result.stdout.trim())),
    execFileAsync("sysctl", ["-n", "hw.logicalcpu"], { timeout: 3000 }).then(result => Number(result.stdout.trim())),
    execFileAsync("sysctl", ["-n", "hw.memsize"], { timeout: 3000 }).then(result => Number(result.stdout.trim())),
    execFileAsync("rustc", ["--version"], { timeout: 3000 }).then(result => result.stdout.trim()),
  ]);
  return { platform: process.platform, macOS: mac, model, physicalCpuCount: physical, logicalCpuCount: logical, memoryBytes: memory, node: process.version, rust };
}

async function findGitExecutable() {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, process.platform === "win32" ? "git.exe" : "git");
    try { await access(candidate); return resolve(candidate); } catch {}
  }
  throw new Error("Could not find Git executable in PATH; pass --git-executable=/absolute/path/to/git");
}

async function ensureOutputDoesNotExist(path) {
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing benchmark output: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}

async function writeNewJson(path, value) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}
