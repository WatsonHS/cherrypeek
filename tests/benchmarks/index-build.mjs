// node tests/benchmarks/index-build.mjs <daemon> <fixture> <new-app-data> <result.json>
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import {
  MetadataIndexDaemonClient,
  createDaemonEnvironment,
  projectSession,
} from "../indexing/daemon-client.mjs";
const exec = promisify(execFile);
const [daemon, repo, data, output] = process.argv
  .slice(2)
  .map((p) => resolve(p));
await mkdir(data, { recursive: false });
const client = new MetadataIndexDaemonClient(daemon, {
  cwd: repo,
  env: createDaemonEnvironment(data),
});
let running = true;
const samples = [];
let maxRssKiB = 0;
let maxProcesses = 0;
const sampler = (async () => {
  while (running) {
    const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,rss="]);
    const all = stdout
      .trim()
      .split("\n")
      .map((s) => s.trim().split(/\s+/).map(Number));
    const ids = new Set([client.child.pid]);
    let last;
    do {
      last = ids.size;
      for (const [pid, ppid] of all) if (ids.has(ppid)) ids.add(pid);
    } while (last !== ids.size);
    const tree = all.filter(([pid]) => ids.has(pid));
    const rss = tree.reduce((s, p) => s + p[2], 0);
    maxRssKiB = Math.max(maxRssKiB, rss);
    maxProcesses = Math.max(maxProcesses, tree.length);
    samples.push({ elapsedMs: performance.now() - started, rssKiB: rss, tree });
    await delay(100);
  }
})();
const started = performance.now();
let status;
try {
  await client.start();
  const session = projectSession(await client.open(repo));
  await client.readPage(session, null, 20);
  for (let n = 0; n < 18000; n++) {
    status = (await client.getMetadataIndexStatus(session)).chunks[0].data
      .status;
    if (status.state === "complete") break;
    if (["failed", "quotaLimited", "unavailable"].includes(status.state))
      throw Error(JSON.stringify(status));
    await delay(100);
  }
  if (status.state !== "complete") throw Error("benchmark timed out");
  const elapsedMs = performance.now() - started;
  running = false;
  await sampler;
  await client.stop();
  let diskBytes = 0;
  let databaseBytes = 0;
  async function scan(path) {
    for (const e of await readdir(path, { withFileTypes: true })) {
      const p = join(path, e.name);
      if (e.isDirectory()) await scan(p);
      else {
        const s = await stat(p);
        diskBytes += s.size;
        if (e.name === "index.sqlite3") databaseBytes += s.size;
      }
    }
  }
  await scan(data);
  const result = {
    daemon,
    repo,
    data,
    elapsedMs,
    databaseBytes,
    diskBytes,
    maxTreeRssKiB: maxRssKiB,
    maxTreeProcesses: maxProcesses,
    sampleIntervalMs: 100,
    coverage: status.coverage,
    samples,
  };
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ ...result, samples: samples.length }));
} finally {
  running = false;
  await sampler;
  await client.stop();
}
