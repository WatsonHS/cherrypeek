import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { NavigationDaemonClient, projectRefreshed } from "../navigation/daemon-client.mjs";
import { HistoryDaemonClient, createDaemonEnvironment, projectPage, projectSession } from "../history/daemon-client.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";
import { gitParentMap, gitText } from "./fixture.mjs";

const fixture = JSON.parse(await readFile(resolve(process.env.COMMITSCOPE_GRAPH_FIXTURE), "utf8"));
const daemonPath = resolve(process.env.COMMITSCOPE_DAEMON_PATH);
const dataRoot = resolve(process.env.COMMITSCOPE_GRAPH_DATA_ROOT);
const realGit = process.env.COMMITSCOPE_GRAPH_REAL_GIT;

test("graph rows match independent Git parents and connected lane routes across page sizes", async () => {
  const before = await snapshotTree(fixture.small.repository);
  const baseline = await walkAtSize(fixture.small.repository, 200, "graph-page-size-baseline");
  const expected = await gitParentMap(fixture.small.repository, [baseline.session.repository.headOid]);
  assertGraphOracle(baseline.commits, expected, "main HEAD");
  assert.equal(baseline.commits.length, expected.length);
  assert.equal(new Set(baseline.commits.map(commit => commit.oid)).size, expected.length, "reachable commits are de-duplicated");
  assert.ok(Math.max(...baseline.commits.map(commit => commit.graph.lane)) >= 6, "fixture must exercise hidden lanes");
  assert.ok(baseline.commits.some(commit => commit.graph.parents.length >= 3), "fixture must contain an octopus merge");
  assert.ok(maxParentSpan(baseline.commits) > 200, "fixture must contain a parent edge spanning a 200-row checkpoint");

  for (const pageSize of [1, 2, 7, 500]) {
    const current = await walkAtSize(fixture.small.repository, pageSize, `graph-page-size-${pageSize}`);
    assert.deepEqual(graphSignatures(current.commits), graphSignatures(baseline.commits), `same OIDs must have stable graph layout at pageSize=${pageSize}`);
    assertGraphOracle(current.commits, expected, `pageSize=${pageSize}`);
  }
  assert.deepEqual(await snapshotTree(fixture.small.repository), before, "layout reads and paging do not write the repository");
});

test("all-branches graph includes independent roots and uses frozen Git tips", async () => {
  const before = await snapshotTree(fixture.small.repository);
  const client = await startClient("graph-all-branches", fixture.small.repository);
  try {
    const opened = projectSession(await client.open(fixture.small.repository));
    assert.ok(opened);
    const selected = projectRefreshed(await client.selectScope(opened, "allBranches", 7));
    const session = selected.session;
    assert.equal(session.scope, "allBranches");
    assert.ok(session.tips.length >= 2);
    const pages = await walk(client, session, 7, selected.page);
    const expected = await gitParentMap(fixture.small.repository, session.tips);
    assertGraphOracle(pages.commits, expected, "allBranches");
    assert.equal(pages.commits.length, expected.length);
    assert.ok(pages.commits.some(commit => commit.graph.parents.length === 0), "allBranches must include the independent root");
    assert.deepEqual(new Set(session.tips), new Set((await gitText(fixture.small.repository, ["for-each-ref", "--format=%(objectname)", "refs/heads"])).split("\n").filter(Boolean)));
  } finally {
    await client.stop();
  }
  assert.deepEqual(await snapshotTree(fixture.small.repository), before, "multi-tip graph reads remain read-only");
});

test("an opened graph stays bound to its tip after a branch ref moves", async () => {
  const repository = join(resolve(dataRoot), "frozen-ref-repository");
  await mkdir(dataRoot, { recursive: true });
  await gitText(fixture.small.repository, ["clone", "--quiet", "--shared", fixture.small.repository, repository]);
  const before = await snapshotTree(fixture.small.repository);
  const client = await startClient("graph-frozen-ref", repository);
  try {
    const session = projectSession(await client.open(repository));
    const oldTip = session.tips[0];
    const oldExpected = await gitParentMap(repository, [oldTip]);
    await gitText(repository, ["config", "user.name", "Graph Fixture"]);
    await gitText(repository, ["config", "user.email", "graph@example.invalid"]);
    const tree = await gitText(repository, ["rev-parse", "HEAD^{tree}"]);
    const newTip = await gitText(repository, ["commit-tree", tree, "-p", oldTip, "-m", "external ref update"]);
    await gitText(repository, ["update-ref", "refs/heads/main", newTip]);
    const pages = await walk(client, session, 7);
    assert.equal(session.tips[0], oldTip);
    assert.deepEqual(pages.commits.map(commit => commit.oid), oldExpected.map(row => row.oid), "existing graph does not absorb a moved ref");
    assertGraphOracle(pages.commits, oldExpected, "frozen ref snapshot");
    assert.notEqual(await gitText(repository, ["rev-parse", "refs/heads/main"]), oldTip);
  } finally {
    await client.stop();
    await rm(repository, { recursive: true, force: true });
  }
  assert.deepEqual(await snapshotTree(fixture.small.repository), before, "ref movement in the disposable clone does not touch source fixture");
});

test("the 64-checkpoint cache can evict old graph state and replay a stable page", async () => {
  const repository = fixture.large.repository;
  const before = await snapshotTree(repository);
  const client = await startClient("graph-checkpoint-eviction", repository);
  try {
    const session = projectSession(await client.open(repository));
    const pages = await walk(client, session, 200);
    assert.ok(pages.pages.length > 64, "fixture traversal must produce more than 64 200-row checkpoints");
    assert.ok(pages.commits.length > 12_800);
    const firstEvictedCandidate = pages.pages[1];
    const oldReplayStartedAt = performance.now();
    const replay = projectPage(await client.readPage(session, firstEvictedCandidate.cursor, 200));
    const oldReplayMs = performance.now() - oldReplayStartedAt;
    assert.deepEqual(graphSignatures(replay.commits), graphSignatures(firstEvictedCandidate.commits), "replay after checkpoint eviction preserves per-OID graph state");
    assert.equal(replay.offset, firstEvictedCandidate.offset);
    const back = projectPage(await client.readPage(session, firstEvictedCandidate.previousCursor, 200));
    assert.deepEqual(graphSignatures(back.commits), graphSignatures(pages.pages[0].commits), "reverse navigation restores the preceding page graph");
    const forward = projectPage(await client.readPage(session, back.nextCursor, 200));
    assert.deepEqual(graphSignatures(forward.commits), graphSignatures(firstEvictedCandidate.commits), "forward navigation restores the same boundary checkpoint");
    const latePage = pages.pages.at(-3);
    const lateReplayStartedAt = performance.now();
    const lateReplay = projectPage(await client.readPage(session, latePage.cursor, 200));
    const lateReplayMs = performance.now() - lateReplayStartedAt;
    assert.deepEqual(graphSignatures(lateReplay.commits), graphSignatures(latePage.commits), "recent checkpoint replay is also stable");
    assertGraphOracle(pages.commits, await gitParentMap(repository, [session.repository.headOid]), "large checkpoint fixture");
    process.stdout.write(`Graph replay end-to-end (Git replay + layout + IPC; not pure layout): first evicted page ${oldReplayMs.toFixed(2)} ms, late page ${lateReplayMs.toFixed(2)} ms.\n`);
  } finally {
    await client.stop();
  }
  assert.deepEqual(await snapshotTree(repository), before, "checkpoint creation, eviction and replay do not write Git data");
});

test("shallow and graft boundaries use effective Git parents without fabricating raw edges", async () => {
  for (const [name, repository] of [["shallow", fixture.small.shallowRepository], ["grafts", fixture.small.graftRepository]]) {
    const before = await snapshotTree(repository);
    const client = await startClient(`graph-${name}`, repository);
    try {
      const session = projectSession(await client.open(repository));
      const pages = await walk(client, session, 2);
      const expected = await gitParentMap(repository, [session.repository.headOid]);
      assertGraphOracle(pages.commits, expected, name);
      const boundaryRows = pages.commits.filter(commit => commit.graph.boundary);
      assert.ok(boundaryRows.length > 0, `${name} fixture must expose at least one effective-parent boundary`);
      assert.ok(boundaryRows.some(commit => JSON.stringify(commit.parents) !== JSON.stringify(commit.graph.parents)), `${name} must distinguish raw object parents from effective graph parents`);
    } finally {
      await client.stop();
    }
    assert.deepEqual(await snapshotTree(repository), before, `${name} graph reads do not change boundary metadata`);
  }
});

test("SHA-256 OIDs retain parent and edge correctness", { skip: !fixture.small.sha256Repository }, async () => {
  const repository = fixture.small.sha256Repository;
  const before = await snapshotTree(repository);
  const client = await startClient("graph-sha256", repository);
  try {
    const session = projectSession(await client.open(repository));
    const pages = await walk(client, session, 3);
    const expected = await gitParentMap(repository, [session.repository.headOid]);
    assert.ok(session.repository.headOid.length === 64);
    assertGraphOracle(pages.commits, expected, "SHA-256");
  } finally {
    await client.stop();
  }
  assert.deepEqual(await snapshotTree(repository), before, "SHA-256 graph reads remain read-only");
});

test("cancelling graph page construction discards its checkpoint and allows an identical retry", async () => {
  const repository = fixture.small.repository;
  const gate = resolve(process.env.COMMITSCOPE_GRAPH_BLOCK_GATE_FILE);
  const pidPath = resolve(process.env.COMMITSCOPE_GRAPH_BLOCK_PID_FILE);
  const before = await snapshotTree(repository);
  const client = await startClient("graph-cancel", repository);
  try {
    const session = projectSession(await client.open(repository));
    await writeFile(gate, "block\n");
    const pending = client.beginReadPage(session, null, 200, 20_000);
    const blockedPid = await waitForPid(pidPath);
    client.cancel(pending.requestId);
    await assert.rejects(pending.result, error => error.code === "CANCELLED");
    await waitForExit(blockedPid);
    await rm(gate, { force: true });
    const retried = projectPage(await client.readPage(session, null, 200));
    const expected = (await gitParentMap(repository, [session.repository.headOid])).slice(0, 200);
    assertGraphOracle(retried.commits, expected, "cancel retry");
    assert.equal(retried.commits.length, expected.length);
  } finally {
    await rm(gate, { force: true });
    await client.stop();
  }
  assert.deepEqual(await snapshotTree(repository), before, "cancel and retry do not mutate the Git fixture");
});

async function walkAtSize(repository, pageSize, name) {
  const client = await startClient(name, repository);
  try {
    const session = projectSession(await client.open(repository));
    const result = await walk(client, session, pageSize);
    return { ...result, session };
  } finally {
    await client.stop();
  }
}

async function walk(client, session, pageSize, firstPage = null) {
  const pages = [];
  let page = firstPage ?? projectPage(await client.readPage(session, null, pageSize));
  pages.push(page);
  while (page.nextCursor) {
    const previous = page;
    page = projectPage(await client.readPage(session, page.nextCursor, pageSize));
    assert.equal(page.previousCursor, previous.cursor, "page cursors preserve their bidirectional link");
    assert.equal(previous.commits.at(-1)?.graph.below, page.commits[0]?.graph.above, "active lane mask is continuous across a page boundary");
    pages.push(page);
    if (pages.length > 100_000) throw new Error("History graph test exceeded its page guard");
  }
  return { pages, commits: pages.flatMap(item => item.commits) };
}

async function startClient(name, repository) {
  const client = new NavigationDaemonClient(daemonPath, {
    cwd: repository,
    env: createDaemonEnvironment(join(dataRoot, name)),
  });
  const hello = await client.start();
  assert.ok(hello.capabilities.includes("historyGraph"), "daemon must advertise the graph response contract");
  return client;
}

function graphSignatures(commits) {
  return commits.map(commit => ({
    oid: commit.oid,
    graph: commit.graph,
  }));
}

function assertGraphOracle(commits, expectedRows, label) {
  assert.deepEqual(commits.map(commit => commit.oid), expectedRows.map(row => row.oid), `${label}: Git topo order`);
  const indexByOid = new Map(commits.map((commit, index) => [commit.oid, index]));
  const expectedByOid = new Map(expectedRows.map(row => [row.oid, row.parents]));
  for (const [rowIndex, commit] of commits.entries()) {
    const graph = commit.graph;
    const effectiveParents = expectedByOid.get(commit.oid);
    assert.deepEqual(graph.parents, effectiveParents, `${label}: effective parents for ${commit.oid}`);
    assert.equal(graph.boundary, JSON.stringify(commit.parents) !== JSON.stringify(effectiveParents), `${label}: boundary marker for ${commit.oid}`);
    assert.ok(Number.isInteger(graph.lane) && graph.lane >= 0 && graph.lane <= 16_383, `${label}: lane range`);
    assert.equal(graph.color, graph.lane % 6, `${label}: stable six-color lane mapping`);
    assert.ok(Number.isInteger(graph.above) && graph.above >= 0 && graph.above <= 63, `${label}: above mask`);
    assert.ok(Number.isInteger(graph.below) && graph.below >= 0 && graph.below <= 63, `${label}: below mask`);
    assert.ok(Number.isInteger(graph.hiddenLaneCount) && graph.hiddenLaneCount >= 0 && graph.hiddenLaneCount <= 16_384, `${label}: hidden lane count`);
    assert.ok(Array.isArray(graph.segments) && graph.segments.length <= 256, `${label}: bounded segments`);
    for (const segment of graph.segments) {
      assert.ok(["through", "incoming", "outgoing"].includes(segment.kind), `${label}: recognized graph segment`);
      assert.ok(segment.fromLane >= 0 && segment.fromLane <= 16_383 && segment.toLane >= 0 && segment.toLane <= 16_383);
      assert.ok(segment.fromLane < 6 || segment.toLane < 6, `${label}: fully hidden segments are omitted`);
      const expectedColor = segment.kind === "outgoing" ? segment.toLane % 6 : segment.fromLane % 6;
      assert.equal(segment.color, expectedColor, `${label}: segment color follows its continuous lane`);
      if (segment.kind === "through") {
        assert.equal(segment.fromLane, segment.toLane, `${label}: through edge preserves a target slot`);
        assert.ok(maskContains(graph.above, segment.fromLane) && maskContains(graph.below, segment.toLane), `${label}: through edge agrees with active masks`);
      } else if (segment.kind === "incoming") {
        assert.equal(segment.toLane, graph.lane, `${label}: incoming edge reaches this commit node`);
        if (segment.fromLane < 6) assert.ok(maskContains(graph.above, segment.fromLane), `${label}: visible incoming edge starts in the above mask`);
      } else {
        assert.equal(segment.fromLane, graph.lane, `${label}: outgoing edge leaves this commit node`);
        if (segment.toLane < 6) assert.ok(maskContains(graph.below, segment.toLane), `${label}: visible outgoing edge ends in the below mask`);
      }
    }

    const outgoing = graph.segments.filter(segment => segment.kind === "outgoing");
    if (graph.lane < 6) {
      assert.equal(outgoing.length, effectiveParents.length, `${label}: every parent edge from a visible node is represented`);
      for (let parentIndex = 0; parentIndex < effectiveParents.length; parentIndex += 1) {
        const targetLane = outgoing[parentIndex].toLane;
        const parentOid = effectiveParents[parentIndex];
        const parentRow = indexByOid.get(parentOid);
        if (parentRow === undefined) continue;
        assert.ok(parentRow > rowIndex, `${label}: parent appears later in topo order`);
        assert.equal(commits[parentRow].graph.lane, targetLane, `${label}: outgoing lane reaches the actual Git parent`);
        for (let between = rowIndex + 1; targetLane < 6 && between < parentRow; between += 1) {
          assert.ok(commits[between].graph.segments.some(segment => segment.kind === "through" && segment.fromLane === targetLane && segment.toLane === targetLane),
            `${label}: edge ${commit.oid} -> ${parentOid} stays connected through row ${commits[between].oid}`);
        }
      }
    }
  }
}

function maskContains(mask, lane) { return lane < 6 && (mask & (1 << lane)) !== 0; }

function maxParentSpan(commits) {
  const indices = new Map(commits.map((commit, index) => [commit.oid, index]));
  let maximum = 0;
  for (let index = 0; index < commits.length; index += 1) {
    for (const parent of commits[index].graph.parents) maximum = Math.max(maximum, (indices.get(parent) ?? index) - index);
  }
  return maximum;
}

async function waitForPid(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
    await delay(20);
  }
  throw new Error(`Timed out waiting for blocked Git PID at ${path}`);
}

async function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await delay(25);
  }
  throw new Error(`Blocked Git process ${pid} did not exit after cancellation`);
}
