// node tests/benchmarks/evolution.mjs <daemon> <repo> <path> <new-app-data> <result.json>
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  PagesDaemonClient,
  createDaemonEnvironment,
  projectSession,
} from "../pages/daemon-client.mjs";
const exec = promisify(execFile);
const [binary, repository, path, data, out] = process.argv.slice(2);
const repo = resolve(repository),
  appData = resolve(data);
await mkdir(appData, { recursive: false });
const client = new PagesDaemonClient(resolve(binary), {
  cwd: repo,
  env: createDaemonEnvironment(appData),
});
let run = true,
  phase = "index";
const samples = [];
const sampler = (async () => {
  while (run) {
    const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,rss="]);
    const rows = stdout
      .trim()
      .split("\n")
      .map((s) => s.trim().split(/\s+/).map(Number));
    const ids = new Set([client.child.pid]);
    let n;
    do {
      n = ids.size;
      for (const [pid, ppid] of rows) if (ids.has(ppid)) ids.add(pid);
    } while (n !== ids.size);
    const tree = rows.filter(([pid]) => ids.has(pid));
    samples.push({
      phase,
      at: performance.now(),
      rssKiB: tree.reduce((s, p) => s + p[2], 0),
      processes: tree.length,
    });
    await delay(100);
  }
})();
try {
  await client.start();
  client.session = projectSession(await client.open(repo));
  await client.readPage(client.session);
  for (let i = 0; i < 2000; i++) {
    const s = (await client.call("getMetadataIndexStatus", {})).chunks[0].data
      .status;
    if (s.state === "complete") break;
    if (["failed", "quotaLimited", "unavailable"].includes(s.state))
      throw Error(JSON.stringify(s));
    await delay(100);
  }
  const { stdout } = await exec("git", ["-C", repo, "rev-parse", "HEAD"]);
  const params = {
    commit: stdout.trim(),
    pathHex: Buffer.from(path).toString("hex"),
    range: null,
  };
  const measures = {};
  for (const name of ["estimate", "cold", "warm"]) {
    phase = name;
    const at = performance.now();
    const response = await client.call(
      name === "estimate" ? "estimateEvolution" : "analyzeEvolution",
      params,
      650000,
    );
    const elapsedMs = performance.now() - at;
    const final = response.chunks.at(-1).data;
    measures[name] = {
      elapsedMs,
      chunks: response.chunks.length,
      ...(name === "estimate"
        ? { estimate: final.estimate }
        : {
            covered: final.chunk.result.covered,
            skipped: final.chunk.result.skipped,
            denominatorCoverage: final.chunk.result.survival.coverage,
          }),
    };
  }
  run = false;
  await sampler;
  for (const name of Object.keys(measures)) {
    const points = samples.filter((s) => s.phase === name);
    measures[name].maxTreeRssKiB = Math.max(0, ...points.map((s) => s.rssKiB));
    measures[name].maxTreeProcesses = Math.max(
      0,
      ...points.map((s) => s.processes),
    );
  }
  const result = {
    date: "2026-11-12",
    repository: repo,
    commit: params.commit,
    path,
    sampleIntervalMs: 100,
    measures,
    samples,
  };
  await writeFile(resolve(out), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ ...result, samples: samples.length }));
} finally {
  run = false;
  await sampler;
  await client.stop();
}
