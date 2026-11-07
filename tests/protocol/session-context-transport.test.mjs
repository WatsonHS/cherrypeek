import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { loadBuilt, context as nullContext } from "./test-utils.mjs";

const { ProtocolTransport, ProtocolClientError } = await loadBuilt("protocol-transport");
const { ViewContextGate } = await loadBuilt("view-context-gate");

test("control and legacy null-context requests bypass the session gate; session calls remain bound", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const requests = [];
  const gate = new ViewContextGate();
  const transport = new ProtocolTransport(stdout, stdin, { contextGate: gate, maxPendingRequests: 8 });
  const ready = {
    protocolVersion: 1,
    coreVersion: "0.1.0-test",
    pid: 8123,
    git: { available: true, version: "git version fixture", error: null },
      capabilities: ["getRuntimeInfo", "readRepositoryPreview", "repositorySessions", "historyPagination", "historyNewSinceLastSeen", "historyGraph"],
  };
  stdin.on("data", bytes => {
    for (const line of bytes.toString("utf8").trim().split("\n")) {
      const message = JSON.parse(line);
      if (message.type === "hello") stdout.write(`${JSON.stringify({ type: "hello", core: ready })}\n`);
      if (message.type === "request") requests.push(message);
    }
  });
  const respond = (request, data, { done = true, sequence = 0, processed = 1 } = {}) => {
    stdout.write(`${JSON.stringify({
      type: "response",
      requestId: request.requestId,
      repoId: request.repoId,
      generation: request.generation,
      sequence,
      done,
      coverage: { complete: done, processed },
      nextCursor: null,
      data,
    })}\n`);
  };

  try {
    await transport.handshake(8123);
    const firstSession = { repoId: "repo-a", generation: "generation-a" };
    gate.switchCurrent(firstSession);

    const listRecent = transport.request("listRecentRepositories", {}, nullContext);
    const legacyRuntime = transport.request("getRuntimeInfo", {}, nullContext);
    const legacyPreview = transport.request("readRepositoryPreview", { path: "/tmp/repo" }, nullContext);
    const sessionBound = transport.request("getRepositorySession", {}, firstSession);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests.map(request => request.method), [
      "listRecentRepositories", "getRuntimeInfo", "readRepositoryPreview", "getRepositorySession",
    ]);

    gate.switchCurrent({ repoId: "repo-b", generation: "generation-b" });
    await assert.rejects(sessionBound, error => error.code === "STALE_CONTEXT");

    respond(requests[0], { section: "recentRepositories", repositories: [], status: "disabled" }, { processed: 0 });
    respond(requests[1], { section: "core", coreVersion: "0.1.0-test", pid: 8123 });
    respond(requests[2], {
      section: "repository",
      repository: {
        path: "/tmp/repo", gitDir: "/tmp/repo/.git", commonDir: "/tmp/repo/.git", worktreePath: null,
        isBare: false, isShallow: false, objectFormat: "sha1", headOid: null, headReference: null,
      },
      refs: [], refsTruncated: false,
    });
    assert.deepEqual((await listRecent).coverage, { complete: true, processed: 0 });
    assert.deepEqual((await legacyRuntime).coverage, { complete: true, processed: 1 });
    assert.deepEqual((await legacyPreview).coverage, { complete: true, processed: 1 });

    await assert.rejects(transport.request("getRepositorySession", {}, nullContext), error => error.code === "STALE_CONTEXT");
    await assert.rejects(transport.request("listRecentRepositories", {}, firstSession), error => error.code === "INVALID_REQUEST");
  } finally {
    transport.close(new ProtocolClientError("CORE_EXITED", "test cleanup", true));
    stdout.destroy();
    stdin.destroy();
  }
});

test("metadata index status and controls use session context and strict parameters", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const requests = [];
  const gate = new ViewContextGate();
  const transport = new ProtocolTransport(stdout, stdin, { contextGate: gate });
  const ready = {
    protocolVersion: 1, coreVersion: "0.1.0-test", pid: 8125,
    git: { available: true, version: "git version fixture", error: null },
    capabilities: ["metadataIndex"],
  };
  stdin.on("data", bytes => {
    for (const line of bytes.toString("utf8").trim().split("\n")) {
      const message = JSON.parse(line);
      if (message.type === "hello") stdout.write(`${JSON.stringify({ type: "hello", core: ready })}\n`);
      if (message.type === "request") requests.push(message);
    }
  });
  const respond = request => stdout.write(`${JSON.stringify({
    type: "response", requestId: request.requestId, repoId: request.repoId, generation: request.generation,
    sequence: 0, done: true,
    coverage: { complete: true, processed: 1 }, nextCursor: null,
    data: { section: "metadataIndex", status: { snapshotKey: null, state: "idle",
      coverage: { processed: 0, complete: false }, diskBytes: 0, quotaBytes: 1000, error: null } },
  })}\n`);

  try {
    await transport.handshake(8125);
    const session = { repoId: "repo-a", generation: "generation-a" };
    gate.switchCurrent(session);
    const reading = transport.request("getMetadataIndexStatus", {}, session, { drainAfterAbort: true });
    const controlling = transport.request("controlMetadataIndex", { action: "pause" }, session);
    await assert.rejects(transport.request("getMetadataIndexStatus", { unexpected: true }, session), error => error.code === "INVALID_REQUEST");
    await assert.rejects(transport.request("controlMetadataIndex", { action: "drop" }, session), error => error.code === "INVALID_REQUEST");
    await assert.rejects(transport.request("controlMetadataIndex", { action: "pause", extra: true }, session), error => error.code === "INVALID_REQUEST");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests.map(request => [request.method, request.params, request.repoId, request.generation]), [
      ["getMetadataIndexStatus", {}, "repo-a", "generation-a"],
      ["controlMetadataIndex", { action: "pause" }, "repo-a", "generation-a"],
    ]);
    respond(requests[0]);
    respond(requests[1]);
    assert.equal((await reading).coverage.processed, 1);
    assert.equal((await controlling).coverage.processed, 1);
  } finally {
    transport.close(new ProtocolClientError("CORE_EXITED", "test cleanup", true));
    stdout.destroy();
    stdin.destroy();
  }
});

test("cancelled open drains its terminal response; uncertain open timeout is fatal", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const requests = [];
  const fatalErrors = [];
  const transport = new ProtocolTransport(stdout, stdin, { onFatal: error => fatalErrors.push(error) });
  const ready = {
    protocolVersion: 1,
    coreVersion: "0.1.0-test",
    pid: 8124,
    git: { available: true, version: "git version fixture", error: null },
    capabilities: ["getRuntimeInfo", "readRepositoryPreview", "repositorySessions"],
  };
  stdin.on("data", bytes => {
    for (const line of bytes.toString("utf8").trim().split("\n")) {
      const message = JSON.parse(line);
      if (message.type === "hello") stdout.write(`${JSON.stringify({ type: "hello", core: ready })}\n`);
      if (message.type === "request") requests.push(message);
    }
  });
  try {
    await transport.handshake(8124);
    const abort = new AbortController();
    const opening = transport.request("openRepository", { path: "/tmp/repo" }, nullContext, {
      signal: abort.signal,
      retainResultAfterAbort: true,
      timeoutMs: 1000,
    });
    await new Promise(resolve => setImmediate(resolve));
    abort.abort();
    const request = requests[0];
    assert.ok(request);
    stdout.write(`${JSON.stringify({
      type: "response",
      requestId: request.requestId,
      repoId: null,
      generation: null,
      sequence: 0,
      done: true,
      coverage: { complete: true, processed: 1 },
      nextCursor: null,
      data: { section: "repositoryClosed", closed: true },
    })}\n`);
    assert.deepEqual(await opening, { coverage: { complete: true, processed: 1 }, nextCursor: null });

    const timed = transport.request("openRepository", { path: "/tmp/slow" }, nullContext, {
      timeoutMs: 20,
      fatalOnTimeout: true,
    });
    await assert.rejects(timed, error => error.code === "TIMEOUT");
    assert.equal(fatalErrors.length, 1);
    assert.equal(fatalErrors[0].code, "TIMEOUT");
    await assert.rejects(transport.request("listRecentRepositories", {}, nullContext), error => error.code === "CORE_EXITED");
  } finally {
    transport.close(new ProtocolClientError("CORE_EXITED", "test cleanup", true));
    stdout.destroy();
    stdin.destroy();
  }
});

test("history page cancellation drains; scope transport validates requests and retains a committed terminal", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const requests = [];
  const gate = new ViewContextGate();
  const session = { repoId: "repo-a", generation: "generation-a" };
  gate.switchCurrent(session);
  const transport = new ProtocolTransport(stdout, stdin, { contextGate: gate, maxPendingRequests: 4 });
  const ready = {
    protocolVersion: 1, coreVersion: "0.1.0-test", pid: 8126,
    git: { available: true, version: "git version fixture", error: null },
      capabilities: ["getRuntimeInfo", "readRepositoryPreview", "repositorySessions", "repositoryScopes", "historyPagination", "historyNewSinceLastSeen", "historyGraph"],
  };
  stdin.on("data", bytes => {
    for (const line of bytes.toString("utf8").trim().split("\n")) {
      const message = JSON.parse(line);
      if (message.type === "hello") stdout.write(`${JSON.stringify({ type: "hello", core: ready })}\n`);
      if (message.type === "request") requests.push(message);
    }
  });
  const respond = (request, sequence, done, data, processed, nextCursor = null) => stdout.write(`${JSON.stringify({
    type: "response", requestId: request.requestId, repoId: request.repoId, generation: request.generation,
    sequence, done, coverage: { complete: done, processed }, nextCursor, data,
  })}\n`);

  try {
    await transport.handshake(8126);
    const navigation = transport.request("getRepositoryNavigation", {}, session, { timeoutMs: 1000 });
    await new Promise(resolve => setImmediate(resolve));
    const navigationRequest = requests.find(item => item.method === "getRepositoryNavigation");
    assert.ok(navigationRequest, "navigation uses the current session protocol route");
    respond(navigationRequest, 0, true, { section: "repositoryNavigation", navigation: {
      refs: [], refsTruncated: false, worktrees: [], worktreesTruncated: false, defaultBase: null, observedAtUnixMs: 100,
    } }, 0);
    assert.deepEqual((await navigation).coverage, { complete: true, processed: 0 });
    await assert.rejects(transport.request("getRepositoryNavigation", { unexpected: true }, session), error => error.code === "INVALID_REQUEST");
    await assert.rejects(transport.request("selectRepositoryScope", { pageSize: 200, scope: { ref: "", worktree: "x" } }, session), error => error.code === "INVALID_REQUEST");
    await assert.rejects(transport.request("refMergeStatus", { refNames: [] }, session), error => error.code === "INVALID_REQUEST");
    const abortMerge = new AbortController();
    const merge = transport.request("refMergeStatus", { refNames: ["refs/heads/main"] }, session, {
      signal: abortMerge.signal, drainAfterAbort: true, timeoutMs: 1000,
    });
    const mergeRejected = assert.rejects(merge, error => error.code === "CANCELLED");
    await new Promise(resolve => setImmediate(resolve));
    const mergeRequest = requests.find(item => item.method === "refMergeStatus");
    assert.ok(mergeRequest, "merge-status queries use the current session protocol route");
    abortMerge.abort();
    await new Promise(resolve => setImmediate(resolve));
    respond(mergeRequest, 0, true, { section: "refMergeStatus", result: { defaultBase: null, statuses: [
      { name: "refs/heads/main", oid: "a".repeat(40), status: "unavailable" },
    ] } }, 1);
    await mergeRejected;

    const abortPage = new AbortController();
    const delivered = [];
    const page = transport.request("readHistoryPage", { cursor: null, pageSize: 200 }, session, {
      signal: abortPage.signal, drainAfterAbort: true, fatalOnTimeout: true, timeoutMs: 1000,
      onChunk: chunk => delivered.push(chunk),
    });
    const pageRejected = assert.rejects(page, error => error.code === "CANCELLED");
    await new Promise(resolve => setImmediate(resolve));
    abortPage.abort();
    await new Promise(resolve => setImmediate(resolve));
    const pageRequest = requests.find(item => item.method === "readHistoryPage");
    assert.ok(pageRequest);
    respond(pageRequest, 0, true, { section: "historyPage", commits: [], offset: 0, pageSize: 200,
      cursor: "cursor-0", previousCursor: null, hasMore: false,
      newSinceLastSeenStatus: "firstView", lastSeenDividerOid: null }, 0);
    await pageRejected;
    assert.deepEqual(delivered, [], "a cancelled page drains framing without delivering payload chunks");

    const abortScope = new AbortController();
    const chunks = [];
    const scope = transport.request("selectRepositoryScope", { pageSize: 200, scope: "allBranches" }, session, {
      signal: abortScope.signal, retainResultAfterAbort: true, fatalOnTimeout: true, timeoutMs: 1000,
      onChunk: chunk => chunks.push(chunk),
    });
    await new Promise(resolve => setImmediate(resolve));
    abortScope.abort();
    await new Promise(resolve => setImmediate(resolve));
    const scopeRequest = requests.find(item => item.method === "selectRepositoryScope");
    assert.ok(scopeRequest);
    respond(scopeRequest, 0, true, { section: "repositoryClosed", closed: true }, 1);
    assert.deepEqual((await scope).coverage, { complete: true, processed: 1 });
    assert.equal(chunks.length, 1, "a committed scope mutation terminal remains visible after abort");

    const malformed = transport.request("readHistoryPage", { cursor: null, pageSize: 200 }, session, {
      timeoutMs: 1000, drainAfterAbort: true, fatalOnTimeout: true,
      onChunk: () => { throw new Error("malformed terminal consumer"); },
    });
    const malformedRejected = assert.rejects(malformed, error => error.code === "PROTOCOL_ERROR");
    await new Promise(resolve => setImmediate(resolve));
    const malformedRequest = requests.findLast(item => item.method === "readHistoryPage");
    respond(malformedRequest, 0, true, { section: "historyPage", commits: [], offset: 0, pageSize: 200,
      cursor: "cursor-0", previousCursor: null, hasMore: false }, 0);
    await malformedRejected;
  } finally {
    transport.close(new ProtocolClientError("CORE_EXITED", "test cleanup", true));
    stdout.destroy();
    stdin.destroy();
  }
});

test("an uncertain close timeout also fails the transport", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const gate = new ViewContextGate();
  const fatalErrors = [];
  const requests = [];
  const session = { repoId: "repo-a", generation: "generation-a" };
  gate.switchCurrent(session);
  const transport = new ProtocolTransport(stdout, stdin, { contextGate: gate, onFatal: error => fatalErrors.push(error) });
  const ready = {
    protocolVersion: 1,
    coreVersion: "0.1.0-test",
    pid: 8125,
    git: { available: true, version: "git version fixture", error: null },
    capabilities: ["getRuntimeInfo", "readRepositoryPreview", "repositorySessions"],
  };
  stdin.on("data", bytes => {
    for (const line of bytes.toString("utf8").trim().split("\n")) {
      const message = JSON.parse(line);
      if (message.type === "hello") stdout.write(`${JSON.stringify({ type: "hello", core: ready })}\n`);
      if (message.type === "request") requests.push(message);
    }
  });
  try {
    await transport.handshake(8125);
    await assert.rejects(
      transport.request("closeRepository", {}, session, { timeoutMs: 20, fatalOnTimeout: true }),
      error => error.code === "TIMEOUT",
    );
    assert.equal(requests[0].method, "closeRepository");
    assert.equal(fatalErrors.length, 1);
    assert.equal(fatalErrors[0].code, "TIMEOUT");
  } finally {
    transport.close(new ProtocolClientError("CORE_EXITED", "test cleanup", true));
    stdout.destroy();
    stdin.destroy();
  }
});
