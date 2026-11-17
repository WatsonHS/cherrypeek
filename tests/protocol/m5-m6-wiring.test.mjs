import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { loadBuilt, waitFor } from "./test-utils.mjs";

const { RepositorySessionController } = await loadBuilt("repository-session-controller");
const transportModule = await loadBuilt("protocol-transport");
const { ProtocolTransport, ProtocolClientError } = transportModule;
const { ViewContextGate } = await loadBuilt("view-context-gate");
const { buildRemotePageUrl, normalizeWebUrl } = await loadBuilt("remote-page-url");

const OID = "a".repeat(40);
const OID2 = "b".repeat(40);
const QUERY = {
  authors: [], caseSensitive: false, committers: [], fromTimestamp: null, message: "", oidPrefix: "", path: null,
  timeField: "author", timeZone: "UTC", toTimestamp: null,
};
const RANGE = { startUnix: 1000, endUnix: 2000 };
const CAPABILITIES = ["repositorySessions", "repositoryScopes", "historyPagination", "historyNewSinceLastSeen", "historyGraph", "metadataIndex",
  "commitDetails", "repositoryOperations", "activityOverview", "changeStats", "notableStats", "evolution"];

function sessionInfo() {
  return {
    repoId: "repo-a", generation: "generation-a", repositoryKey: "key-a", worktreeId: "worktree-a", scope: "head", tips: [OID], observedAtUnixMs: 100,
    repository: { path: "/tmp/repo-a", gitDir: "/tmp/repo-a/.git", commonDir: "/tmp/repo-a/.git", worktreePath: null, isBare: false, isShallow: false,
      objectFormat: "sha1", headOid: OID, headReference: "refs/heads/main" },
    previousView: null, persistence: { recent: "disabled", lastSeen: "disabled" },
  };
}

function makeCore(capabilities = CAPABILITIES) {
  const requests = [];
  return {
    status: { state: "ready", revision: 1, core: { capabilities } },
    currentContext: { repoId: null, generation: null },
    getStatus() { return this.status; },
    subscribe() { return () => {}; },
    observeLatestContext() {},
    switchCurrentContext(context) { this.currentContext = { ...context }; },
    request(method, params, context, options = {}) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      promise.catch(() => {});
      const request = { method, params, context, options, resolve, reject };
      requests.push(request);
      options.signal?.addEventListener("abort", () => reject(new ProtocolClientError("CANCELLED", "aborted", true)), { once: true });
      return promise;
    },
    requests,
  };
}

function chunk(request, data, done = true) {
  request.options.onChunk?.({ data, done, sequence: 0, repoId: request.context.repoId, generation: request.context.generation,
    coverage: { complete: done, processed: 1 }, nextCursor: null });
}

function finish(request) { request.resolve({ coverage: { complete: true, processed: 1 }, nextCursor: null }); }

async function openController(core) {
  const controller = new RepositorySessionController(core);
  const opening = controller.open("/tmp/repo-a");
  const request = await waitFor(() => core.requests[0]);
  chunk(request, { section: "repositorySession", session: sessionInfo() });
  finish(request);
  await opening;
  core.requests.length = 0;
  return controller;
}

test("parameter validation rejects malformed getBranchSync, runOperation and getChangeStats input", async () => {
  const { validBranchSyncParams, validOperationParams, validChangeStatsParams } = transportModule;
  assert.equal(validBranchSyncParams({ refNames: ["refs/heads/main"] }), true);
  for (const bad of [{ refNames: [] }, { refNames: Array.from({ length: 51 }, (_, i) => `refs/heads/b${i}`) }, { refNames: [1] },
    { refNames: ["-x"] }, { refNames: ["a\0b"] }, { refNames: ["refs/heads/main"], extra: 1 }, {}, null]) {
    assert.equal(validBranchSyncParams(bad), false, JSON.stringify(bad));
  }

  const fastForward = { kind: "fastForward", refName: "refs/heads/main", expectedOid: OID, upstreamOid: OID2 };
  assert.equal(validOperationParams({ operation: fastForward }), true);
  for (const choice of ["replaceUntracked", "discardUntracked"]) {
    assert.equal(validOperationParams({ operation: { ...fastForward, [choice]: "a".repeat(64) } }), true);
  }
  assert.equal(validOperationParams({ operation: { kind: "switch", target: { remoteRefName: "refs/remotes/origin/x" }, expectedHeadOid: OID, expectedOid: OID2 } }), true);
  assert.equal(validOperationParams({ operation: { kind: "createBranch", name: "topic", startOid: OID, switchAfter: false, expectedHeadOid: OID } }), true);
  for (const bad of [
    { ...fastForward, expectedOid: "zz" }, { ...fastForward, extra: true }, { kind: "reset", refName: "refs/heads/main" },
    { ...fastForward, replaceUntracked: ["local.txt"] }, { ...fastForward, replaceUntracked: "" },
    { ...fastForward, replaceUntracked: "a".repeat(257) }, { ...fastForward, discardUntracked: "" },
    { ...fastForward, replaceUntracked: "token", discardUntracked: "token" },
    { kind: "switch", target: { refName: "a", remoteRefName: "b" }, expectedHeadOid: OID, expectedOid: OID },
    { kind: "createBranch", name: "--force", startOid: OID, switchAfter: false, expectedHeadOid: OID },
    { kind: "createBranch", name: "topic", startOid: OID, switchAfter: "no", expectedHeadOid: OID },
    { kind: "createBranch", name: "topic", startOid: OID, switchAfter: false },
  ]) {
    assert.equal(validOperationParams({ operation: bad }), false, JSON.stringify(bad));
  }
  assert.equal(validOperationParams({ operation: fastForward, extra: 1 }), false);

  const change = { query: QUERY, range: RANGE, bucket: "day" };
  assert.equal(validChangeStatsParams(change), true);
  assert.equal(validChangeStatsParams({ ...change, directoryPrefix: "" }), true);
  assert.equal(validChangeStatsParams({ ...change, directoryPrefix: "7372" }), true);
  for (const bad of [{ ...change, bucket: "year" }, { ...change, range: { startUnix: 5, endUnix: 5 } }, { ...change, range: { startUnix: 1 } },
    { ...change, directoryPrefix: "abc" }, { ...change, directoryPrefix: "00" }, { ...change, query: { ...QUERY, extra: 1 } }, { ...change, extra: 1 }]) {
    assert.equal(validChangeStatsParams(bad), false, JSON.stringify(bad));
  }

  const core = makeCore();
  const controller = await openController(core);
  await assert.rejects(controller.getBranchSync({ refNames: [] }), error => error.code === "INVALID_REQUEST");
  await assert.rejects(controller.runOperation({ kind: "fastForward" }), error => error.code === "INVALID_REQUEST");
  await assert.rejects(controller.getChangeStats({ ...change, bucket: "year" }), error => error.code === "INVALID_REQUEST");
  assert.equal(core.requests.length, 0, "nothing malformed reaches the core");
  controller.dispose();
});

test("missing capabilities are reported in Chinese before any request", async () => {
  const core = makeCore(CAPABILITIES.filter(name => name !== "evolution" && name !== "repositoryOperations"));
  const controller = await openController(core);
  await assert.rejects(controller.estimateEvolution({ commit: OID, pathHex: "" }), error => error.code === "UNKNOWN_METHOD" && /核心还不能/u.test(error.message));
  await assert.rejects(controller.getBranchSync({ refNames: ["refs/heads/main"] }), error => error.code === "UNKNOWN_METHOD" && /P5-01/u.test(error.message));
  assert.equal(core.requests.length, 0);
  controller.dispose();
});

test("runOperation takes the operation slot: a pending fetch means BUSY while reads still go through", async () => {
  const core = makeCore();
  const controller = await openController(core);
  const fetching = controller.fetchRepository({ remote: null, prune: false });
  const fetchRequest = await waitFor(() => core.requests[0]);
  const operation = { kind: "fastForward", refName: "refs/heads/main", expectedOid: OID, upstreamOid: OID2 };
  await assert.rejects(controller.runOperation(operation), error => error.code === "BUSY");

  const reading = controller.getBranchSync({ refNames: ["refs/heads/main"] });
  const readRequest = await waitFor(() => core.requests[1]);
  assert.equal(readRequest.method, "getBranchSync");
  chunk(readRequest, { section: "branchSync", result: { branches: [], lastFetchUnixMs: null } });
  finish(readRequest);
  assert.deepEqual(await reading, { branches: [], lastFetchUnixMs: null });

  chunk(fetchRequest, { section: "repositoryFetched", result: { remotes: [] } });
  finish(fetchRequest);
  await fetching;

  const running = controller.runOperation(operation);
  const runRequest = await waitFor(() => core.requests.find(request => request.method === "runOperation"));
  assert.deepEqual(runRequest.params, { operation });
  assert.equal(runRequest.options.timeoutMs, 120_000);
  await assert.rejects(controller.fetchRepository({ remote: null, prune: false }), error => error.code === "BUSY");
  await assert.rejects(controller.runOperation(operation), error => error.code === "BUSY");
  assert.deepEqual(await controller.cancelRepositoryOperation(), { cancelled: false }, "a started operation is not cancelled");
  const run = { outcome: "done", headOid: OID, headReference: "refs/heads/main", updatedRef: null };
  chunk(runRequest, { section: "operationRun", result: run });
  finish(runRequest);
  assert.deepEqual(await running, run);
  controller.dispose();
});

test("the transport gives runOperation the operation slot and leaves reads alone", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const requests = [];
  const gate = new ViewContextGate();
  const transport = new ProtocolTransport(stdout, stdin, { contextGate: gate, maxPendingRequests: 1 });
  const ready = { protocolVersion: 1, coreVersion: "0.1.0-test", pid: 8140, git: { available: true, version: "git version fixture", error: null },
    capabilities: ["repositorySessions", "repositoryOperations"] };
  stdin.on("data", bytes => {
    for (const line of bytes.toString("utf8").trim().split("\n")) {
      const message = JSON.parse(line);
      if (message.type === "hello") stdout.write(`${JSON.stringify({ type: "hello", core: ready })}\n`);
      if (message.type === "request") requests.push(message);
    }
  });
  try {
    await transport.handshake(8140);
    const session = { repoId: "repo-a", generation: "generation-a" };
    gate.switchCurrent(session);
    const fetching = transport.request("fetchRepository", { prune: false, remote: null }, session);
    fetching.catch(() => {});
    const read = transport.request("getBranchSync", { refNames: ["refs/heads/main"] }, session);
    read.catch(() => {});
    const operation = { kind: "createBranch", name: "topic", startOid: OID, switchAfter: false, expectedHeadOid: OID };
    await assert.rejects(transport.request("runOperation", { operation }, session), error => error.code === "BUSY");
    await assert.rejects(transport.request("getBranchSync", { refNames: [] }, session), error => error.code === "INVALID_REQUEST");
    await waitFor(() => requests.length >= 2);
    assert.deepEqual(requests.map(request => request.method), ["fetchRepository", "getBranchSync"]);
  } finally {
    transport.close(new ProtocolClientError("CORE_EXITED", "test cleanup", true));
    stdout.destroy();
    stdin.destroy();
  }
});

test("a newer statistics request replaces the older one on the same channel, other channels are independent", async () => {
  const core = makeCore();
  const controller = await openController(core);
  const params = { query: QUERY, range: RANGE, bucket: "day" };
  const first = controller.getActivityOverview(params);
  first.catch(() => {});
  const firstRequest = await waitFor(() => core.requests[0]);
  const notable = controller.getNotableStats(params);
  notable.catch(() => {});
  const notableRequest = await waitFor(() => core.requests.find(request => request.method === "getNotableStats"));
  assert.equal(firstRequest.options.signal.aborted, false, "a different channel does not replace it");

  const second = controller.getActivityOverview({ ...params, bucket: "week" });
  const secondRequest = await waitFor(() => core.requests.find(request => request.method === "getActivityOverview" && request !== firstRequest));
  assert.equal(firstRequest.options.signal.aborted, true);
  await assert.rejects(first, error => error.code === "CANCELLED");
  assert.equal(secondRequest.options.timeoutMs, 60_000);
  const stats = { coverage: { processed: 1, complete: true } };
  chunk(secondRequest, { section: "activityOverview", stats });
  finish(secondRequest);
  assert.deepEqual(await second, stats);

  assert.deepEqual(await controller.cancelStats(), { cancelled: true });
  assert.equal(notableRequest.options.signal.aborted, true);
  await assert.rejects(notable, error => error.code === "CANCELLED");
  controller.dispose();
});

test("analyzeEvolution forwards chunks in order, rejects backwards progress, and keeps delivered chunks on cancel", async () => {
  const core = makeCore();
  const controller = await openController(core);
  const params = { commit: OID, pathHex: "", range: null };
  const result = progress => ({ asOfUnix: 1, progress });
  const evolutionChunk = (filesDone, filesTotal) => ({ progress: { filesDone, filesTotal, currentPath: null }, result: { marker: filesDone } });

  const delivered = [];
  const analysis = controller.analyzeEvolution(params, item => delivered.push(item.progress.filesDone));
  const request = await waitFor(() => core.requests[0]);
  assert.equal(request.method, "analyzeEvolution");
  assert.equal(request.options.timeoutMs, null, "the daemon owns the pause-aware work budget");
  assert.equal(request.options.drainAfterAbort, true);
  chunk(request, { section: "evolutionChunk", chunk: evolutionChunk(1, 3) }, false);
  chunk(request, { section: "evolutionChunk", chunk: evolutionChunk(2, 3) }, false);
  chunk(request, { section: "evolutionChunk", chunk: evolutionChunk(3, 3) }, true);
  finish(request);
  assert.deepEqual(await analysis, { marker: 3 });
  assert.deepEqual(delivered, [1, 2, 3]);

  const backwards = controller.analyzeEvolution(params, () => {});
  backwards.catch(() => {});
  const backwardsRequest = await waitFor(() => core.requests[1]);
  chunk(backwardsRequest, { section: "evolutionChunk", chunk: evolutionChunk(2, 3) }, false);
  assert.throws(() => chunk(backwardsRequest, { section: "evolutionChunk", chunk: evolutionChunk(1, 3) }, false), error => error.code === "PROTOCOL_ERROR");
  backwardsRequest.reject(new ProtocolClientError("PROTOCOL_ERROR", "bad", false));
  await assert.rejects(backwards);

  const kept = [];
  const cancelled = controller.analyzeEvolution(params, item => kept.push(item.progress.filesDone));
  cancelled.catch(() => {});
  const cancelRequest = await waitFor(() => core.requests[2]);
  chunk(cancelRequest, { section: "evolutionChunk", chunk: evolutionChunk(1, 5) }, false);
  assert.deepEqual(await controller.cancelEvolution(), { cancelled: true });
  assert.equal(cancelRequest.options.signal.aborted, true);
  await assert.rejects(cancelled, error => error.code === "CANCELLED");
  assert.deepEqual(kept, [1]);
  void result;
  controller.dispose();
});

test("openRemotePage URLs come from the navigation remotes of the current session only", async () => {
  const core = makeCore();
  const controller = await openController(core);
  assert.equal(controller.remotePageUrl({ commit: OID }), null, "no navigation read yet");
  const navigation = { refs: [], refsTruncated: false, worktrees: [], worktreesTruncated: false, defaultBase: null, observedAtUnixMs: 100,
    remotes: [{ name: "fork", webUrl: "https://example.test/me/repo" }, { name: "origin", webUrl: "https://example.test/team/repo" }],
    branchUpstreams: [], lastFetchUnixMs: null };
  const reading = controller.getNavigation();
  const request = await waitFor(() => core.requests[0]);
  chunk(request, { section: "repositoryNavigation", navigation });
  request.resolve({ coverage: { complete: true, processed: 0 }, nextCursor: null });
  await reading;
  assert.equal(controller.remotePageUrl({ commit: OID }), `https://example.test/team/repo/commit/${OID}`);
  assert.equal(controller.remotePageUrl({ branch: "refs/heads/feature/x y" }), "https://example.test/team/repo/tree/feature/x%20y");
  assert.throws(() => controller.remotePageUrl({ url: "https://evil.test" }), error => error.code === "INVALID_REQUEST");
  assert.throws(() => controller.remotePageUrl({ commit: OID, branch: "x" }), error => error.code === "INVALID_REQUEST");
  controller.dispose();
});

test("buildRemotePageUrl is strict about the address it opens", () => {
  const origin = { name: "origin", webUrl: "https://git.example.test/team/repo/" };
  assert.equal(buildRemotePageUrl([origin], { commit: OID.toUpperCase() }), `https://git.example.test/team/repo/commit/${OID}`);
  assert.equal(buildRemotePageUrl([origin], { commit: "abc" }), null);
  assert.equal(buildRemotePageUrl([origin], { commit: "b".repeat(64) }), `https://git.example.test/team/repo/commit/${"b".repeat(64)}`);
  // origin wins when usable, otherwise the first usable remote
  const other = { name: "upstream", webUrl: "https://other.example.test/o/r" };
  assert.equal(buildRemotePageUrl([other, origin], { commit: OID }), `https://git.example.test/team/repo/commit/${OID}`);
  assert.equal(buildRemotePageUrl([{ name: "origin", webUrl: "http://git.example.test/a/b" }, { name: "x", webUrl: null }, other], { commit: OID }),
    `https://other.example.test/o/r/commit/${OID}`);
  assert.equal(buildRemotePageUrl([{ name: "origin", webUrl: null }], { commit: OID }), null);
  assert.equal(buildRemotePageUrl([], { commit: OID }), null);
  // branches: prefixes stripped, segments percent-encoded
  assert.equal(buildRemotePageUrl([origin], { branch: "refs/heads/feat/a#b?c" }), "https://git.example.test/team/repo/tree/feat/a%23b%3Fc");
  assert.equal(buildRemotePageUrl([origin, other], { branch: "refs/remotes/upstream/dev/x" }), "https://other.example.test/o/r/tree/dev/x");
  assert.equal(buildRemotePageUrl([origin], { branch: "refs/remotes/gone/dev" }), null);
  assert.equal(buildRemotePageUrl([{ name: "a/b", webUrl: "https://h.test/o/r" }, { name: "a", webUrl: "https://z.test/o/r" }], { branch: "refs/remotes/a/b/dev" }),
    "https://h.test/o/r/tree/dev");
  for (const bad of ["refs/tags/v1", "main", "refs/heads/", "refs/heads/a/../b", "refs/heads//x", "refs/heads/a\u0001b"]) {
    assert.equal(buildRemotePageUrl([origin], { branch: bad }), null, bad);
  }
  // addresses that must never be opened
  for (const bad of ["http://h.test/o/r", "https://u:p@h.test/o/r", "https://h.test/", "https://h.test", "https://h.test/o/r?x=1", "https://h.test/o/r#f",
    "https://h.test/o\\r", "javascript:alert(1)", "https:///o/r", "https://h.test/o r", "", null, 5]) {
    assert.equal(normalizeWebUrl(bad), null, String(bad));
  }
  assert.equal(normalizeWebUrl("https://h.test:8443/o/r.git"), "https://h.test:8443/o/r.git");
});

test("M7 parameter validation checks pushRepository and all six new RepositoryOperation kinds", async () => {
  const { validPushRepositoryParams, validOperationParams } = transportModule;
  const OID3 = "c".repeat(40);
  const HEX_FILE = Buffer.from("src/app.ts").toString("hex");
  const HEX_OLD = Buffer.from("src/old.ts").toString("hex");

  assert.equal(validPushRepositoryParams({ refName: "refs/heads/main", expectedOid: OID, remote: null, setUpstream: false }), true);
  assert.equal(validPushRepositoryParams({ refName: "refs/heads/feat/x", expectedOid: OID, remote: "origin", setUpstream: true }), true);
  for (const bad of [
    null,
    {},
    { refName: "main", expectedOid: OID, remote: null, setUpstream: false },
    { refName: "refs/remotes/origin/main", expectedOid: OID, remote: null, setUpstream: false },
    { refName: "refs/heads/main", expectedOid: "xyz", remote: null, setUpstream: false },
    { refName: "refs/heads/main", expectedOid: OID, remote: "-origin", setUpstream: true },
    { refName: "refs/heads/main", expectedOid: OID, remote: "origin", setUpstream: "yes" },
    { refName: "refs/heads/main", expectedOid: OID, remote: null, setUpstream: false, extra: 1 },
  ]) {
    assert.equal(validPushRepositoryParams(bad), false, JSON.stringify(bad));
  }

  for (const good of [
    { kind: "deleteBranch", refName: "refs/heads/feat", expectedOid: OID, baseRefName: "refs/heads/main" },
    { kind: "deleteBranch", refName: "refs/heads/feat", expectedOid: OID, baseRefName: "refs/remotes/origin/main" },
    { kind: "fastForwardMerge", targetRef: "refs/heads/main", expectedTargetOid: OID, sourceRef: "refs/heads/feat", expectedSourceOid: OID2, switchToTarget: true },
    { kind: "fastForwardMerge", targetRef: "refs/heads/main", expectedTargetOid: OID, sourceRef: "refs/remotes/origin/feat", expectedSourceOid: OID3, switchToTarget: false },
    { kind: "workspaceStage", pathsHex: [HEX_FILE], all: false },
    { kind: "workspaceStage", pathsHex: [], all: true },
    { kind: "workspaceUnstage", pathsHex: [HEX_FILE, HEX_OLD], all: false },
    { kind: "workspaceUnstage", pathsHex: [], all: true },
    { kind: "workspaceDiscard", pathHex: HEX_FILE, untracked: false, expectedHeadOid: OID },
    { kind: "workspaceDiscard", pathHex: HEX_FILE, untracked: true, expectedHeadOid: null },
    { kind: "workspaceCommit", message: "feat: gate", expectedHeadOid: OID },
    { kind: "workspaceCommit", message: "init", expectedHeadOid: null },
  ]) {
    assert.equal(validOperationParams({ operation: good }), true, JSON.stringify(good));
  }

  for (const bad of [
    { kind: "deleteBranch", refName: "feat", expectedOid: OID, baseRefName: "refs/heads/main" },
    { kind: "deleteBranch", refName: "refs/heads/feat", expectedOid: "bad", baseRefName: "refs/heads/main" },
    { kind: "fastForwardMerge", targetRef: "refs/remotes/origin/main", expectedTargetOid: OID, sourceRef: "refs/heads/feat", expectedSourceOid: OID2, switchToTarget: false },
    { kind: "fastForwardMerge", targetRef: "refs/heads/main", expectedTargetOid: OID, sourceRef: "feat", expectedSourceOid: OID2, switchToTarget: false },
    { kind: "workspaceStage", pathsHex: [], all: false },
    { kind: "workspaceStage", pathsHex: ["abc"], all: false },
    { kind: "workspaceUnstage", pathsHex: [], all: false },
    { kind: "workspaceUnstage", pathsHex: [""], all: false },
    { kind: "workspaceDiscard", pathHex: "", untracked: true, expectedHeadOid: null },
    { kind: "workspaceDiscard", pathHex: "ab", untracked: "yes", expectedHeadOid: null },
    { kind: "workspaceCommit", message: "", expectedHeadOid: OID },
    { kind: "workspaceCommit", message: "x".repeat(65537), expectedHeadOid: OID },
    { kind: "workspaceCommit", message: "ok", expectedHeadOid: "bad" },
  ]) {
    assert.equal(validOperationParams({ operation: bad }), false, JSON.stringify(bad));
  }

  const core = makeCore();
  const controller = await openController(core);
  await assert.rejects(controller.pushRepository({ refName: "main", expectedOid: OID, remote: null, setUpstream: false }), error => error.code === "INVALID_REQUEST");
  assert.equal(core.requests.length, 0);
  controller.dispose();
});

test("pushRepository shares the operation slot and supports cancelRepositoryOperation with drainAfterAbort", async () => {
  const core = makeCore();
  const controller = await openController(core);
  const pushing = controller.pushRepository({ refName: "refs/heads/main", expectedOid: OID, remote: "origin", setUpstream: false });
  const pushReq = await waitFor(() => core.requests[0]);
  assert.equal(pushReq.method, "pushRepository");
  assert.equal(pushReq.options.timeoutMs, 615_000);
  assert.equal(pushReq.options.drainAfterAbort, true);

  await assert.rejects(controller.fetchRepository({ remote: null, prune: false }), error => error.code === "BUSY");
  await assert.rejects(controller.runOperation({ kind: "workspaceStage", pathsHex: [], all: true }), error => error.code === "BUSY");

  const pushDone = {
    outcome: "done",
    refName: "refs/heads/main",
    remote: "origin",
    remoteRefName: "refs/remotes/origin/main",
    newOid: OID,
    setUpstream: false,
    finishedAtUnixMs: 123,
  };
  chunk(pushReq, { section: "repositoryPushed", result: pushDone });
  finish(pushReq);
  assert.deepEqual(await pushing, pushDone);

  const pushing2 = controller.pushRepository({ refName: "refs/heads/feat", expectedOid: OID2, remote: "origin", setUpstream: true });
  pushing2.catch(() => {});
  const pushReq2 = await waitFor(() => core.requests[1]);
  assert.deepEqual(await controller.cancelRepositoryOperation(), { cancelled: true });
  assert.equal(pushReq2.options.signal.aborted, true);
  await assert.rejects(pushing2, error => error.code === "CANCELLED");
  controller.dispose();
});
