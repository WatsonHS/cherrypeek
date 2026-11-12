import assert from "node:assert/strict";
import test from "node:test";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PagesDaemonClient, createDaemonEnvironment, projectSession } from "./daemon-client.mjs";
import { commit, indexed, query } from "./stats-git.test.mjs";
import { git } from "./fixture.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const params = {
  query: { ...query, timeZone: "UTC" },
  range: { startUnix: 1699999900, endUnix: 1700001000 },
  bucket: "day",
};
const statistics = [
  ["getActivityOverview", params],
  ["getChangeStats", { ...params, directoryPrefix: "" }],
  ["getNotableStats", params],
  ["getStatsCommits", { query: params.query, range: params.range, selection: { kind: "untested" }, offset: 0, limit: 200 }],
];

async function until(predicate, message) {
  for (let n = 0; n < 500; n++) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}
async function gateStarted(path) {
  await until(async () => {
    try { return (await readFile(path, "utf8")).trim(); } catch { return false; }
  }, `gate not reached: ${path}`);
}
async function startClient(t, f, data, extra = {}) {
  const client = new PagesDaemonClient(process.env.COMMITSCOPE_DAEMON_PATH, {
    cwd: f.repo,
    env: createDaemonEnvironment(data, { HOME: process.env.COMMITSCOPE_PAGES_HOME, ...extra }),
  });
  t.after(() => client.stop());
  await client.start();
  client.session = projectSession(await client.open(f.repo));
  return client;
}

test("statistics survive repeated interactive reads and retain explicit lifecycle cancellation", async (t) => {
  const f = await indexed(t, "statistics-scheduling", async (repo) => {
    await commit(repo, "a.rs", "one\n", 1700000000, "feat: one");
    await commit(repo, "a.rs", "two\n", 1700000100, "fix: two");
  });
  const before = await snapshotTree(f.repo);
  const baselines = [];
  for (const [method, p] of statistics) baselines.push((await f.client.call(method, p)).data);
  await f.client.stop();
  const gate = join(f.base, "stats.gate"), started = join(f.base, "stats.started");
  t.after(() => rm(gate, { force: true }));
  const client = await startClient(t, f, join(f.base, "data"), { COMMITSCOPE_TEST_STATS_GATE: gate });
  for (const [index, [method, p]] of statistics.entries()) {
    await rm(started, { force: true });
    await writeFile(gate, "hold");
    const job = client.begin(method, p);
    await gateStarted(started);
    // Two interactive slots remain usable while the statistics worker is held.
    for (let n = 0; n < 3; n++) {
      await Promise.all([client.workspaceStatus(), client.readPage(client.session)]);
      await client.call("observeRepository", {});
      assert.ok(client.pending.has(job.requestId), `${method} must remain active`);
    }
    await assert.rejects(client.call("getActivityOverview", params), e => e.code === "BUSY");
    await rm(gate, { force: true });
    assert.deepEqual((await job.result).data, baselines[index]);
  }
  for (const action of ["cancel", "refresh", "open", "close"]) {
    await rm(started, { force: true });
    await writeFile(gate, "hold");
    const job = client.begin("getActivityOverview", params);
    const failed = assert.rejects(job.result, e => e.code === "CANCELLED");
    await gateStarted(started);
    const at = performance.now();
    if (action === "cancel") client.cancel(job.requestId);
    if (action === "refresh") client.session = projectSession(await client.refresh(client.session));
    if (action === "open") client.session = projectSession(await client.open(f.repo));
    if (action === "close") await client.close(client.session);
    await failed;
    assert.ok(performance.now() - at < 2000, `${action} cancels the held statistics`);
    await rm(gate, { force: true });
  }
  client.session = projectSession(await client.open(f.repo));
  await rm(started, { force: true });
  await writeFile(gate, "hold");
  const job = client.begin("getActivityOverview", params);
  const stopped = assert.rejects(job.result); // Shutdown may close output before the terminal frame.
  await gateStarted(started);
  const at = performance.now();
  assert.deepEqual(await client.stop(), { code: 0, signal: null });
  await stopped;
  assert.ok(performance.now() - at < 2000);
  assert.deepEqual(await snapshotTree(f.repo), before);
});

test("evolution pauses between files, keeps cumulative results, resumes and cancels while paused", async (t) => {
  const f = await indexed(t, "evolution-scheduling", async (repo) => {
    for (const name of ["a.txt", "b.txt", "c.txt"])
      await commit(repo, name, `${name}\n`, 1700000000, `feat: ${name}`);
  });
  const p = { commit: await git(f.repo, ["rev-parse", "HEAD"]), pathHex: "", range: null };
  await f.client.stop();
  const before = await snapshotTree(f.repo);
  // Independent app caches prevent the baseline from warming the gated blame.
  const baselineData = join(f.base, "baseline");
  await cp(join(f.base, "data"), baselineData, { recursive: true });
  const baselineClient = await startClient(t, f, baselineData);
  const baseline = (await baselineClient.call("analyzeEvolution", p)).chunks;
  await baselineClient.stop();
  const gate = join(f.base, "blame.gate"), started = join(f.base, "blame.started");
  const readGate = join(f.base, "read.gate"), readStarted = join(f.base, "read.started");
  t.after(async () => { await rm(gate, { force: true }); await rm(readGate, { force: true }); });
  const client = await startClient(t, f, join(f.base, "data"), {
    PATH: `${process.env.COMMITSCOPE_PAGES_GIT_WRAPPER}:${process.env.PATH}`,
    COMMITSCOPE_PAGES_GATE_FILE: gate, COMMITSCOPE_PAGES_GATE_STARTED: started,
    COMMITSCOPE_PAGES_READ_GATE_FILE: readGate, COMMITSCOPE_PAGES_READ_GATE_STARTED: readStarted,
  });
  await writeFile(gate, "blame");
  const seen = [];
  const job = client.begin("analyzeEvolution", p, 30000, m => { seen.push(m); });
  await gateStarted(started);
  const blamePid = Number(await readFile(started, "utf8"));
  // Analysis owns its slot; another analysis is bounded but statistics complete.
  await assert.rejects(client.call("analyzeEvolution", p), e => e.code === "BUSY");
  await client.call("getActivityOverview", params);
  await writeFile(readGate, "status");
  const interactive = client.begin("readWorkspaceStatus", { maxEntries: 2000 });
  await gateStarted(readStarted);
  await rm(gate, { force: true });
  await until(() => seen.some(m => m.data.chunk.result.covered.files === 1), "first file did not complete");
  const paused = structuredClone(seen);
  await delay(200);
  assert.deepEqual(seen, paused, "no next file or terminal response while interactive read is held");
  assert.equal(seen.at(-1).data.chunk.progress.currentPath, null);
  assert.equal(seen.at(-1).data.chunk.result.complete, false);
  await until(() => { try { process.kill(blamePid, 0); return false; } catch (e) { return e.code === "ESRCH"; } }, "completed blame was not reaped");
  await client.call("getActivityOverview", params); // No BUSY from the paused analysis or interactive read.
  await rm(readGate, { force: true });
  await interactive.result;
  const complete = (await job.result).chunks;
  const withoutClock = chunks => chunks.map(m => {
    const chunk = structuredClone(m.data.chunk);
    delete chunk.result.asOfUnix;
    return chunk;
  });
  assert.deepEqual(withoutClock(complete), withoutClock(baseline));
  assert.equal(complete.at(-1).data.chunk.result.complete, true);

  // Start an analysis while an interactive read is already active: it is admitted
  // and waits instead of returning BUSY, even with warm blame caches.
  await rm(readStarted, { force: true });
  await writeFile(readGate, "status");
  const heldRead = client.begin("readWorkspaceStatus", { maxEntries: 2000 });
  await gateStarted(readStarted);
  const cancelledSeen = [];
  const cancelled = client.begin("analyzeEvolution", p, 30000, m => { cancelledSeen.push(m); });
  const failed = assert.rejects(cancelled.result, e => e.code === "CANCELLED");
  await delay(100);
  assert.ok(client.pending.has(cancelled.requestId));
  assert.deepEqual(cancelledSeen, []);
  const at = performance.now();
  client.cancel(cancelled.requestId);
  await failed;
  assert.ok(performance.now() - at < 1000, "paused cancellation completes without releasing the interactive read");
  assert.ok(client.pending.has(heldRead.requestId));
  await rm(readGate, { force: true });
  await heldRead.result;
  assert.deepEqual(await snapshotTree(f.repo), before);
});
