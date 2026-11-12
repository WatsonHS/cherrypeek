// node tests/benchmarks/stats-scheduling.mjs <release-daemon> <repo> <app-data> <result.json> [end-ISO]
// Measures the real daemon and every descendant; does not launch Electron.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { PagesDaemonClient, createDaemonEnvironment, projectSession } from "../pages/daemon-client.mjs";

const exec = promisify(execFile);
const [binaryArg, repoArg, dataArg, outArg, endISO = "2026-11-13T00:00:00+08:00"] = process.argv.slice(2);
if (!outArg) throw Error("Expected daemon, repository, app-data and result.json paths");
const binary = resolve(binaryArg), repo = resolve(repoArg), data = resolve(dataArg), out = resolve(outArg);
await mkdir(data, { recursive: true });
await mkdir(dirname(out), { recursive: true });
const command = async (cmd, args) => (await exec(cmd, args)).stdout.trim();
const sha256 = value => createHash("sha256").update(value).digest("hex");
const report = {
  date: "2026-11-12", repository: repo,
  head: await command("git", ["-C", repo, "rev-parse", "HEAD"]),
  commits: Number(await command("git", ["-C", repo, "rev-list", "--count", "HEAD"])),
  binarySha256: sha256(await readFile(binary)),
  environment: { platform: process.platform, release: os.release(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, memoryGiB: os.totalmem() / 1024 ** 3, git: await command("git", ["--version"]), node: process.version },
  sampleIntervalMs: 50,
  processScope: "daemon plus all descendants, excluding test Node and Electron; ps sampling may miss short-lived children; CPU is sum of ps lifetime-average %CPU, not integrated CPU time",
  endUnix: Date.parse(endISO) / 1000,
  measurements: [], history: [], samples: [],
};
const client = new PagesDaemonClient(binary, { cwd: repo, env: createDaemonEnvironment(data) });
let running = true, phase = "index";
const sampler = (async () => {
  while (running) {
    const samplePhase = phase;
    const rows = (await command("ps", ["-axo", "pid=,ppid=,rss=,%cpu="]))
      .split("\n").map(s => s.trim().split(/\s+/).map(Number));
    const ids = new Set([client.child.pid]);
    let size;
    do {
      size = ids.size;
      for (const [pid, ppid] of rows) if (ids.has(ppid)) ids.add(pid);
    } while (ids.size !== size);
    const tree = rows.filter(([pid]) => ids.has(pid));
    report.samples.push({ phase: samplePhase, atMs: performance.now(), rssKiB: tree.reduce((s, r) => s + r[2], 0), cpuPercent: tree.reduce((s, r) => s + r[3], 0), processes: tree.length });
    await delay(50);
  }
})();
// A sampler error is reported through the final await, never an unhandled rejection.
sampler.catch(() => {});
const query = { message: "", caseSensitive: false, authors: [], committers: [], oidPrefix: "", timeField: "committer", fromTimestamp: null, toTimestamp: null, timeZone: "Asia/Shanghai", path: null };
const statsParams = (method, days) => ({ query, range: { startUnix: report.endUnix - days * 86400, endUnix: report.endUnix }, bucket: "day", ...(method === "getChangeStats" ? { directoryPrefix: "" } : {}) });
async function measured(method, params, name) {
  phase = name;
  const at = performance.now();
  try {
    const response = await client.call(method, params, 30000);
    return { method, elapsedMs: performance.now() - at, success: true, coverage: response.data.stats?.coverage, resultSha256: sha256(JSON.stringify(response.data)), totals: response.data.stats?.totals };
  } catch (error) {
    return { method, elapsedMs: performance.now() - at, success: false, code: error.code, message: error.message };
  }
}
try {
  await client.start();
  client.session = projectSession(await client.open(repo));
  await client.readPage(client.session);
  const indexStart = performance.now();
  let complete = false;
  for (let n = 0; n < 7200; n++) {
    const status = (await client.call("getMetadataIndexStatus", {})).data.status;
    if (n % 40 === 0) console.log(`Index ${status.state}: ${status.coverage.processed}`);
    if (status.state === "complete") {
      report.index = { elapsedMs: performance.now() - indexStart, status };
      complete = true;
      break;
    }
    if (["failed", "quotaLimited", "unavailable"].includes(status.state)) throw Error(JSON.stringify(status));
    await delay(250);
  }
  assert.ok(complete, "metadata and file index must complete before measuring");
  for (const days of [30, 90, 730]) {
    for (const method of ["getActivityOverview", "getChangeStats", "getNotableStats"]) {
      const name = `${method}-${days}`;
      const result = { phase: name, days, ...await measured(method, statsParams(method, days), name) };
      report.measurements.push(result);
      console.log(JSON.stringify(result));
    }
  }
  // Equal warm-page conditions, five paired observations; no synthetic gate or
  // priority override. Require statistics to remain active throughout the read.
  const historyParams = { cursor: null, pageSize: 200 };
  await client.call("readHistoryPage", historyParams);
  for (let pair = 1; pair <= 5; pair++) {
    for (const loaded of [false, true]) {
      phase = `history-${pair}-${loaded ? "loaded" : "idle"}`;
      let statistics, finished = false;
      if (loaded) {
        statistics = client.begin("getChangeStats", statsParams("getChangeStats", 90), 30000);
        statistics.result.then(() => { finished = true; }, () => { finished = true; });
        await delay(5);
        assert.equal(finished, false, "statistics must be active when history starts");
      }
      const at = performance.now();
      const response = await client.call("readHistoryPage", historyParams);
      const result = { pair, loaded, phase, elapsedMs: performance.now() - at, statisticsActiveAtCompletion: loaded && !finished, historySha256: sha256(JSON.stringify(response.chunks.map(m => m.data))) };
      report.history.push(result);
      if (loaded) {
        assert.equal(finished, false, "statistics must overlap the entire history request");
        const stats = await statistics.result;
        result.statisticsResultSha256 = sha256(JSON.stringify(stats.data));
        assert.equal(result.statisticsResultSha256, report.measurements.find(m => m.method === "getChangeStats" && m.days === 90).resultSha256);
      }
      console.log(JSON.stringify(result));
    }
  }
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  running = false;
  await sampler;
  report.stderr = client.stderr;
  await client.stop();
  const phases = [...new Set(report.samples.map(s => s.phase))];
  report.processTrees = Object.fromEntries(phases.map(p => {
    const samples = report.samples.filter(s => s.phase === p);
    return [p, { samples: samples.length, maxRssMiB: Math.max(...samples.map(s => s.rssKiB)) / 1024, maxCpuPercent: Math.max(...samples.map(s => s.cpuPercent)), maxProcesses: Math.max(...samples.map(s => s.processes)) }];
  }));
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`Evidence: ${out}`);
}
