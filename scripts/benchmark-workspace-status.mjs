#!/usr/bin/env node
// Measures readWorkspaceStatus while the metadata index is being built, against reads once it is idle,
// and whether the reads slow the build. Two runs from empty app-data directories:
//   A  build only;  B  build with one status read per interval, then idle reads.
// RSS is sampled for the whole daemon process tree, Git children included.
//
//   node scripts/benchmark-workspace-status.mjs --repository <path> [--daemon <path>] [--interval 1000] [--idle 10]
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { HistoryDaemonClient, createDaemonEnvironment, projectSession } from "../tests/history/daemon-client.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).map(argument => argument.replace(/^--/u, "").split("=")));
if (!args.repository) throw new Error("--repository=<path> is required");
const repository = resolve(args.repository);
const daemonPath = resolve(args.daemon ?? join(root, "target/release/commitscope-daemon"));
const interval = Number(args.interval ?? 1000);
const idleReads = Number(args.idle ?? 10);

const runA = await run("A: build only", false);
const runB = await run("B: build with status reads", true);
const summary = {
  repository,
  daemonPath,
  intervalMs: interval,
  buildMs: { buildOnly: runA.buildMs, withReads: runB.buildMs },
  statusMs: { duringBuild: stats(runB.during), idle: stats(runB.idle) },
  treeRssPeakMiB: { buildOnly: runA.peakRssMiB, withReads: runB.peakRssMiB },
  indexedCommits: runB.processed,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

async function run(label, withReads) {
  const dataDir = await mkdtemp(join(tmpdir(), "commitscope-workspace-bench-"));
  const client = new HistoryDaemonClient(daemonPath, { cwd: repository, env: createDaemonEnvironment(dataDir) });
  let peakRss = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      peakRss = Math.max(peakRss, await treeRss(client.child.pid));
      await delay(100);
    }
  })();
  try {
    await client.start(15_000);
    const session = projectSession(await client.open(repository));
    const call = (method, params, timeoutMs = 60_000) => client.request(method, session.repoId, session.generation, params, timeoutMs);
    const indexStatus = async () => (await call("getMetadataIndexStatus", {})).chunks.find(chunk => chunk.data.section === "metadataIndex").data.status;
    const readStatus = async () => {
      const started = performance.now();
      await call("readWorkspaceStatus", { maxEntries: 2000 });
      return performance.now() - started;
    };
    const started = performance.now();
    await client.readPage(session, null, 200, 60_000);
    const during = [];
    let status = await indexStatus();
    let nextRead = performance.now();
    while (!["complete", "failed", "unavailable", "quotaLimited"].includes(status.state)) {
      if (withReads && performance.now() >= nextRead) {
        during.push(await readStatus());
        nextRead += interval;
      }
      await delay(100);
      status = await indexStatus();
      if (performance.now() - started > 30 * 60_000) throw new Error(`${label}: the index did not finish in 30 minutes`);
    }
    const buildMs = performance.now() - started;
    if (status.state !== "complete") throw new Error(`${label}: index ended ${status.state}`);
    const idle = [];
    if (withReads) for (let index = 0; index < idleReads; index += 1) { idle.push(await readStatus()); await delay(200); }
    sampling = false;
    await sampler;
    process.stderr.write(`${label}: index ${status.coverage.processed} commits in ${(buildMs / 1000).toFixed(1)} s; ${during.length} reads during the build\n`);
    return { buildMs: Math.round(buildMs), during, idle, processed: status.coverage.processed, peakRssMiB: Math.round(peakRss * 10) / 10 };
  } finally {
    sampling = false;
    await sampler;
    await client.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
}

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { count: values.length, median: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(sorted.at(-1)), min: Math.round(sorted[0]) };
}

/** RSS in MiB of a process and all its descendants. */
async function treeRss(rootPid) {
  if (!rootPid) return 0;
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,rss="]);
  const rows = stdout.trim().split("\n").map(line => line.trim().split(/\s+/u).map(Number));
  const children = new Map();
  for (const [pid, ppid] of rows) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const rss = new Map(rows.map(([pid, , kib]) => [pid, kib]));
  let total = 0;
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    total += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total / 1024;
}
