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
    capabilities: ["getRuntimeInfo", "readRepositoryPreview", "repositorySessions"],
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
