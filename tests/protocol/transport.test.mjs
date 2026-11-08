import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { loadBuilt, context, daemonPath, waitFor, waitForProcessExit } from "./test-utils.mjs";

const { CoreProcess } = await loadBuilt("core-process");
const { ProtocolTransport } = await loadBuilt("protocol-transport");
const peerPath = resolve(import.meta.dirname, "fixtures/fake-peer.mjs");

async function startFake(mode, options = {}) {
  const core = new CoreProcess(process.execPath, {
    args: [peerPath, mode],
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 1500,
    startRetryDelaysMs: options.startRetryDelaysMs,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    transport: options.transport,
  });
  await core.start();
  return core;
}

function runtimeInfo(core, options = {}) {
  return core.request("getRuntimeInfo", {}, context, options);
}

async function stopQuietly(core) {
  await core.stop().catch(() => undefined);
}

test("real daemon negotiates and returns core plus real Git runtime chunks", async () => {
  const core = new CoreProcess(daemonPath);
  const chunks = [];
  try {
    await core.start();
    assert.equal(core.getStatus().state, "ready");
    process.kill(core.getStatus().core.pid, 0);
    assert.equal(core.getStatus().core.capabilities.includes("getRuntimeInfo"), true);
    assert.equal(typeof core.getStatus().core.git.available, "boolean");

    const completion = await core.request("getRuntimeInfo", {}, context, { onChunk: chunk => chunks.push(chunk) });
    assert.deepEqual(chunks.map(chunk => chunk.sequence), [0, 1]);
    assert.equal(chunks[0].data.section, "core");
    assert.equal(chunks[0].data.pid, core.getStatus().core.pid);
    assert.equal(chunks[1].data.section, "git");
    assert.equal(typeof chunks[1].data.git.available, "boolean");
    assert.deepEqual(completion.coverage, { complete: true, processed: 2 });
    assert.equal(completion.nextCursor, null);
  } finally { await stopQuietly(core); }
});

test("split UTF-8 handshake is accepted; duplicate hello and incompatible version fail visibly", async () => {
  const split = await startFake("split-handshake");
  try {
    assert.equal(split.getStatus().state, "ready");
    assert.equal(split.getStatus().core.coreVersion, "0.1.0-test");
  } finally { await stopQuietly(split); }

  for (const [mode, code] of [["duplicate-hello", "PROTOCOL_ERROR"], ["mismatch-version", "PROTOCOL_MISMATCH"]]) {
    const core = await startFake(mode);
    try {
      assert.equal(core.getStatus().state, "error");
      assert.match(core.getStatus().message, new RegExp(code));
    } finally { await stopQuietly(core); }
  }
});

test("handshake timeout and malformed JSON, invalid UTF-8, oversized, sequence, and context faults reject pending work", async () => {
  const timedOut = await startFake("no-hello", { handshakeTimeoutMs: 40, startRetryDelaysMs: [] });
  try {
    assert.equal(timedOut.getStatus().state, "error");
    assert.match(timedOut.getStatus().message, /TIMEOUT/);
  } finally { await stopQuietly(timedOut); }

  const requestFaults = ["bad-json", "invalid-utf8", "oversized", "wrong-sequence", "wrong-context"];
  for (const mode of requestFaults) {
    const core = await startFake(mode);
    try {
      await assert.rejects(runtimeInfo(core), error => error.code === "PROTOCOL_ERROR");
      assert.equal(core.getStatus().state, "error", `${mode} must end the protocol session`);
    } finally { await stopQuietly(core); }
  }
});

test("abort and timeout ignore late frames and allow a later request", async () => {
  const cancelled = await startFake("late-cancel");
  try {
    const controller = new AbortController();
    const request = runtimeInfo(cancelled, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(request, error => error.code === "CANCELLED");
    const completion = await runtimeInfo(cancelled);
    assert.equal(completion.coverage.complete, true);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(cancelled.getStatus().state, "ready");
  } finally { await stopQuietly(cancelled); }

  const timedOut = await startFake("timeout-late");
  try {
    await assert.rejects(runtimeInfo(timedOut, { timeoutMs: 20 }), error => error.code === "TIMEOUT");
    const completion = await runtimeInfo(timedOut);
    assert.equal(completion.coverage.processed, 2);
  } finally { await stopQuietly(timedOut); }
});

test("current-view changes cancel only replaced requests; latest observation alone does not", async () => {
  const temp = await mkdtemp(join(tmpdir(), "commitscope-context-"));
  const countFile = join(temp, "requests.count");
  const core = new CoreProcess(process.execPath, {
    args: [peerPath, "context"],
    env: { ...process.env, COMMITSCOPE_PEER_COUNT_FILE: countFile },
  });
  const older = { repoId: "repo-a", generation: "generation-1" };
  const newer = { repoId: "repo-a", generation: "generation-2" };
  const sessionInfo = (target, options = {}) => core.request("getRepositorySession", {}, target, options);
  try {
    await core.start();
    core.switchCurrentContext(older);
    const observedOnly = sessionInfo(older);
    core.observeLatestContext(newer);
    assert.equal((await observedOnly).coverage.complete, true);

    const chunksDeliveredAfterSwitch = [];
    const stale = sessionInfo(older, { onChunk: chunk => chunksDeliveredAfterSwitch.push(chunk) });
    const staleRejected = assert.rejects(stale, error => error.code === "STALE_CONTEXT");
    await waitFor(async () => Number((await readFile(countFile, "utf8")).trim()) === 2);
    core.switchCurrentContext(newer);
    await staleRejected;
    await new Promise(resolve => setTimeout(resolve, 110));
    assert.deepEqual(chunksDeliveredAfterSwitch, []);
    assert.equal(core.getStatus().state, "ready");

    await assert.rejects(sessionInfo(older), error => error.code === "STALE_CONTEXT");
    assert.equal(Number((await readFile(countFile, "utf8")).trim()), 2, "stale local request must not be written to stdin");

    core.switchCurrentContext(older);
    assert.equal((await sessionInfo(older)).coverage.complete, true);
    assert.equal(Number((await readFile(countFile, "utf8")).trim()), 3);
  } finally {
    await stopQuietly(core);
    await rm(temp, { recursive: true, force: true });
  }
});

test("a throwing chunk callback cancels only its request and another pending request completes", async () => {
  const core = await startFake("callback");
  try {
    const broken = runtimeInfo(core, { onChunk: () => { throw new Error("consumer failed"); } });
    const healthy = runtimeInfo(core);
    await assert.rejects(broken, error => error.code === "PROTOCOL_ERROR");
    const completion = await healthy;
    assert.equal(completion.coverage.complete, true);
    assert.equal(core.getStatus().state, "ready");
  } finally { await stopQuietly(core); }
});

test("a start that times out is retried after a pause and the error shows only if every attempt fails", async () => {
  const temp = await mkdtemp(join(tmpdir(), "commitscope-start-retry-"));
  const countFile = join(temp, "starts.count");
  const states = core => {
    const seen = [];
    core.subscribe(status => seen.push(status.state === "starting" && status.retry ? `retry ${status.retry.attempt}/${status.retry.limit}` : status.state));
    return seen;
  };
  try {
    const recovering = new CoreProcess(process.execPath, {
      args: [peerPath, "no-hello-first"], handshakeTimeoutMs: 150, startRetryDelaysMs: [30, 30],
      env: { ...process.env, COMMITSCOPE_PEER_START_COUNT_FILE: countFile, COMMITSCOPE_PEER_FAIL_STARTS: "1" },
    });
    const recoveringStates = states(recovering);
    try {
      await recovering.start();
      assert.equal(recovering.getStatus().state, "ready", "the second launch answers the handshake");
      assert.equal((await readFile(countFile, "utf8")).trim(), "2");
      assert.deepEqual(recoveringStates, ["starting", "retry 1/2", "ready"], "a retried start says so and never shows an error");
      assert.deepEqual((await runtimeInfo(recovering)).coverage, { complete: true, processed: 2 });
    } finally { await stopQuietly(recovering); }

    await rm(countFile, { force: true });
    const failing = new CoreProcess(process.execPath, {
      args: [peerPath, "no-hello-first"], handshakeTimeoutMs: 80, startRetryDelaysMs: [20, 20],
      env: { ...process.env, COMMITSCOPE_PEER_START_COUNT_FILE: countFile, COMMITSCOPE_PEER_FAIL_STARTS: "99" },
    });
    try {
      await failing.start();
      assert.equal(failing.getStatus().state, "error");
      assert.match(failing.getStatus().message, /TIMEOUT/);
      assert.equal((await readFile(countFile, "utf8")).trim(), "3", "one start plus two retries");
    } finally { await stopQuietly(failing); }

    await rm(countFile, { force: true });
    const mismatched = new CoreProcess(process.execPath, {
      args: [peerPath, "mismatch-version"], startRetryDelaysMs: [20, 20],
      env: { ...process.env, COMMITSCOPE_PEER_START_COUNT_FILE: countFile },
    });
    try {
      await mismatched.start();
      assert.equal(mismatched.getStatus().state, "error");
      assert.equal((await readFile(countFile, "utf8")).trim(), "1", "a version mismatch is not retried");
    } finally { await stopQuietly(mismatched); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("restart brings back a core that crashed after it was ready", async () => {
  const core = await startFake("exit-on-request");
  try {
    const firstPid = core.getStatus().core.pid;
    await assert.rejects(runtimeInfo(core), error => error.code === "CORE_EXITED");
    assert.equal(core.getStatus().state, "error", "a crash after start is shown, not retried by itself");
    await Promise.all([core.restart(), core.restart()]);
    assert.equal(core.getStatus().state, "ready");
    assert.notEqual(core.getStatus().core.pid, firstPid);
    await waitForProcessExit(firstPid);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(core.getStatus().state, "ready", "the old process's exit does not end the new one");
    await core.restart();
    assert.equal(core.getStatus().state, "ready", "restart does nothing while the core is ready");
  } finally { await stopQuietly(core); }
});

test("pending requests reject on daemon crash, stdout EOF and stop", async () => {
  const crashed = await startFake("exit-on-request");
  try {
    await assert.rejects(runtimeInfo(crashed), error => error.code === "CORE_EXITED");
    assert.equal(crashed.getStatus().state, "error");
  } finally { await stopQuietly(crashed); }

  const stdoutClosed = await startFake("stdout-close");
  try {
    const request = runtimeInfo(stdoutClosed);
    await assert.rejects(request, error => error.code === "CORE_EXITED");
    assert.equal(stdoutClosed.getStatus().state, "error");
  } finally { await stopQuietly(stdoutClosed); }

  const stopped = await startFake("stall");
  try {
    const request = runtimeInfo(stopped);
    const rejected = assert.rejects(request, error => error.code === "CORE_EXITED");
    await new Promise(resolve => setTimeout(resolve, 20));
    await stopped.stop();
    await rejected;
    assert.equal(stopped.getStatus().state, "stopped");
  } finally { await stopQuietly(stopped); }
});

test("queue limits reject excess writes and drain listeners are removed on close", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const transport = new ProtocolTransport(stdout, stdin, { maxQueuedFrames: 1, maxQueuedBytes: 4096 });
  const serverReady = {
    type: "hello",
    core: {
      protocolVersion: 1,
      coreVersion: "0.1.0-test",
      pid: 8123,
      git: { available: false, version: null, error: "fixture" },
      capabilities: ["getRuntimeInfo"],
    },
  };
  stdin.on("data", buffer => {
    for (const line of buffer.toString("utf8").trim().split("\n")) {
      const message = JSON.parse(line);
      if (message.type === "hello") stdout.write(`${JSON.stringify(serverReady)}\n`);
      if (message.type === "request") {
        const base = {
          requestId: message.requestId,
          repoId: null,
          generation: null,
          coverage: { complete: true, processed: 2 },
          nextCursor: null,
        };
        stdout.write(`${JSON.stringify({ type: "response", ...base, sequence: 0, done: false, coverage: { complete: false, processed: 1 }, data: { section: "core", coreVersion: "0.1.0-test", pid: 8123 } })}\n`);
        stdout.write(`${JSON.stringify({ type: "response", ...base, sequence: 1, done: true, data: { section: "git", git: serverReady.core.git } })}\n`);
      }
    }
  });
  await transport.handshake(8123, 1000);
  const originalWrite = stdin.write.bind(stdin);
  let heldCallback;
  let delayNextRequest = true;
  stdin.write = (chunk, callback) => {
    if (JSON.parse(Buffer.from(chunk).toString("utf8")).type === "request") {
      if (delayNextRequest) {
        delayNextRequest = false;
        setTimeout(() => {
          originalWrite(chunk, callback);
          stdin.emit("drain");
        }, 5);
        return false;
      }
      heldCallback = callback;
      return false;
    }
    return originalWrite(chunk, callback);
  };
  assert.equal((await transport.request("getRuntimeInfo", {}, context)).coverage.complete, true, "write completion must wait for drain");
  await waitFor(() => !transport.pumpingWrites);
  const first = transport.request("getRuntimeInfo", {}, context).catch(error => error);
  await waitFor(() => heldCallback);
  const second = transport.request("getRuntimeInfo", {}, context);
  await assert.rejects(second, error => error.code === "BUSY");
  transport.close();
  const firstError = await first;
  assert.equal(firstError.code, "CORE_EXITED");
  assert.equal(stdin.listenerCount("drain"), 0);
  stdin.destroy();
  stdout.destroy();
});

test("CoreProcess.stop cancels a real slow Git probe and daemon SIGKILL reaps its process group", async () => {
  const temp = await mkdtemp(join(tmpdir(), "commitscope-slow-git-"));
  const bin = join(temp, "bin");
  const countFile = join(temp, "count");
  const gitPidFile = join(temp, "git.pid");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  const fakeGit = join(bin, "git");
  await writeFile(fakeGit, `#!/bin/sh\ncount=0\nif [ -f "${countFile}" ]; then read count < "${countFile}"; fi\ncount=$((count + 1))\nprintf '%s\\n' "$count" > "${countFile}"\nif [ "$count" -ge 2 ]; then printf '%s\\n' "$$" > "${gitPidFile}"; exec /bin/sleep 30; fi\nprintf 'git version 2.54.0\\n'\n`);
  await chmod(fakeGit, 0o755);
  const env = { PATH: bin };
  let stopped;
  let crashed;
  try {
    stopped = new CoreProcess(daemonPath, { env });
    await stopped.start();
    const pending = runtimeInfo(stopped, { timeoutMs: 10000 });
    const pendingRejected = assert.rejects(pending, error => error.code === "CORE_EXITED");
    await waitFor(async () => {
      try { return (await readFile(gitPidFile, "utf8")).trim(); } catch { return undefined; }
    }, 5000);
    const gitPid = Number((await readFile(gitPidFile, "utf8")).trim());
    await stopped.stop();
    await pendingRejected;
    await waitForProcessExit(gitPid);

    await rm(countFile, { force: true });
    await rm(gitPidFile, { force: true });
    crashed = new CoreProcess(daemonPath, { env });
    await crashed.start();
    const secondPending = runtimeInfo(crashed, { timeoutMs: 10000 });
    const secondPendingRejected = assert.rejects(secondPending, error => error.code === "CORE_EXITED");
    await waitFor(async () => {
      try { return (await readFile(gitPidFile, "utf8")).trim(); } catch { return undefined; }
    }, 5000);
    const secondGitPid = Number((await readFile(gitPidFile, "utf8")).trim());
    const daemonPid = crashed.getStatus().core.pid;
    process.kill(daemonPid, "SIGKILL");
    await secondPendingRejected;
    await waitForProcessExit(secondGitPid);
    assert.equal(crashed.getStatus().state, "error");
    await stopQuietly(crashed);
  } finally {
    await stopQuietly(stopped);
    await stopQuietly(crashed);
    await rm(temp, { recursive: true, force: true });
  }
});
