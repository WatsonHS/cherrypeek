import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as flush } from "node:timers/promises";
import { daemonPath, loadBuilt, waitFor } from "./test-utils.mjs";
import { git } from "../pages/fixture.mjs";
import { createDaemonEnvironment } from "../pages/daemon-client.mjs";

const { ProtocolTransport } = await loadBuilt("protocol-transport");
const { ViewContextGate } = await loadBuilt("view-context-gate");
const session = { repoId: "repo", generation: "generation" };
const evolution = { commit: "a".repeat(40), pathHex: "", range: null };
const query = { authors: [], caseSensitive: false, committers: [], fromTimestamp: null, message: "", oidPrefix: "", path: null, timeField: "author", timeZone: "UTC", toTimestamp: null };
const params = { query, range: { startUnix: 1000, endUnix: 2000 }, bucket: "day" };
const statistics = [
  ["getActivityOverview", params], ["getChangeStats", params], ["getNotableStats", params],
  ["getStatsCommits", { query, range: params.range, selection: { kind: "untested" }, offset: 0, limit: 50 }],
  ["getStatsExclusions", {}], ["setStatsExclusions", { patterns: [] }],
];
const tracked = promise => { promise.catch(() => {}); return promise; };

async function harness(t) {
  const stdout = new PassThrough(), stdin = new PassThrough(), gate = new ViewContextGate();
  const messages = [], fatal = [];
  const transport = new ProtocolTransport(stdout, stdin, { contextGate: gate, onFatal: e => fatal.push(e) });
  const send = message => stdout.write(JSON.stringify(message) + "\n");
  stdin.on("data", bytes => {
    for (const line of bytes.toString("utf8").trim().split("\n")) {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.type === "hello") send({ type: "hello", core: {
        protocolVersion: 1, coreVersion: "0.1.0-test", pid: 8300,
        git: { available: true, version: "git fixture", error: null }, capabilities: ["repositorySessions", "evolution"],
      } });
    }
  });
  t.after(() => { transport.close(); stdout.destroy(); stdin.destroy(); });
  await transport.handshake(8300);
  gate.switchCurrent(session);
  const request = (method, p, options = {}) => tracked(transport.request(method, p, gate.getCurrent(), options));
  const requests = () => messages.filter(m => m.type === "request");
  const error = (r, code = "CANCELLED") => send({ type: "error", requestId: r.requestId, repoId: r.repoId, generation: r.generation, code, message: code, retryable: false });
  const progress = (r, done, sequence = 0) => send({
    type: "response", requestId: r.requestId, repoId: r.repoId, generation: r.generation, sequence, done,
    coverage: { processed: done ? 1 : 0, complete: done }, nextCursor: null,
    data: { section: "evolutionChunk", chunk: {
      progress: { filesDone: done ? 1 : 0, filesTotal: 1, currentPath: null },
      result: { asOfUnix: 1, age: { within7d: 0, within30d: 0, within90d: 0, within1y: 0, older: 0 }, ownership: [],
        survival: { coverage: { processed: 1, complete: true }, weeks: [], byAuthor: [] },
        covered: { files: done ? 1 : 0, lines: 0 }, skipped: [], complete: done },
    } },
  });
  return { transport, gate, messages, fatal, request, requests, error, progress };
}

test("statistics and evolution have independent bounded slots beside both interactive slots and the operation slot", async t => {
  const h = await harness(t);
  const analysis = h.request("analyzeEvolution", evolution, { timeoutMs: null, drainAfterAbort: true });
  const interactive = [h.request("readWorkspaceStatus", { maxEntries: 20 }), h.request("readHistoryPage", { cursor: null, pageSize: 20 })];
  const operation = h.request("fetchRepository", { remote: null, prune: false });
  await flush();
  await assert.rejects(h.request("estimateEvolution", evolution), e => e.code === "BUSY");
  await assert.rejects(h.request("analyzeEvolution", evolution), e => e.code === "BUSY");
  await assert.rejects(h.request("getActivityStats", { query }), e => e.code === "BUSY", "old top-bar statistics stay interactive");
  await assert.rejects(h.request("fetchRepository", { remote: null, prune: false }), e => e.code === "BUSY");
  for (const [method, p] of statistics) {
    const reading = h.request(method, p);
    await flush();
    const sent = h.requests().at(-1);
    assert.equal(sent.method, method);
    await assert.rejects(h.request("getActivityOverview", params), e => e.code === "BUSY");
    h.error(sent);
    await assert.rejects(reading, e => e.code === "CANCELLED");
  }
  assert.equal(h.requests().length, 4 + statistics.length, "rejected requests never reach the daemon");
  assert.equal(h.messages.some(m => m.type === "cancel"), false, "admission never preempts auxiliaries");
  for (const r of h.requests().slice(0, 4)) h.error(r);
  await Promise.all([analysis, ...interactive, operation].map(p => assert.rejects(p, e => e.code === "CANCELLED")));
  // The evolution estimate uses the same slot, independent of an active statistic.
  const estimate = h.request("estimateEvolution", evolution);
  const stats = h.request("getActivityOverview", params);
  await flush();
  await assert.rejects(h.request("analyzeEvolution", evolution), e => e.code === "BUSY");
  for (const r of h.requests().slice(-2)) h.error(r);
  await Promise.all([estimate, stats].map(p => assert.rejects(p)));
  assert.deepEqual(h.fatal, []);
});

test("analysis can remain silent beyond 615 seconds, resumes with cumulative chunks, and still receives daemon TIMEOUT", async t => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const chunks = [];
  const analysis = h.request("analyzeEvolution", evolution, { timeoutMs: null, drainAfterAbort: true, onChunk: m => chunks.push(m) });
  await flush();
  const r = h.requests()[0];
  h.progress(r, false);
  t.mock.timers.tick(700_000);
  await flush();
  assert.equal(h.messages.some(m => m.type === "cancel"), false);
  assert.equal(chunks.length, 1, "already delivered results remain available during the long wait");
  h.progress(r, true, 1);
  assert.equal((await analysis).coverage.complete, true);
  assert.equal(chunks.length, 2);
  const timedOut = h.request("analyzeEvolution", evolution, { timeoutMs: null, drainAfterAbort: true });
  await flush();
  h.error(h.requests().at(-1), "TIMEOUT");
  await assert.rejects(timedOut, e => e.code === "TIMEOUT");
  for (const [method, p] of [["getActivityOverview", params], ["estimateEvolution", evolution]]) {
    await assert.rejects(h.request(method, p, { timeoutMs: null, drainAfterAbort: true }), e => e.code === "INVALID_REQUEST");
  }
  await assert.rejects(h.request("analyzeEvolution", evolution, { timeoutMs: null }), e => e.code === "INVALID_REQUEST");
  const ordinary = h.request("getActivityOverview", params, { timeoutMs: 20 });
  await flush();
  t.mock.timers.tick(20);
  await assert.rejects(ordinary, e => e.code === "TIMEOUT", "other requests keep their local deadlines");
  assert.deepEqual(h.fatal, []);
});

test("cancel and context replacement drain analysis terminal frames without exposing stale results or leaking its slot", async t => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const reason of ["cancel", "context"]) {
    const abort = new AbortController(), chunks = [];
    const analysis = h.request("analyzeEvolution", evolution, { timeoutMs: null, drainAfterAbort: true, signal: abort.signal, onChunk: m => chunks.push(m) });
    await flush();
    const r = h.requests().at(-1);
    h.progress(r, false);
    if (reason === "cancel") abort.abort();
    else h.gate.switchCurrent({ ...session, generation: "new-generation" });
    await flush();
    assert.equal(h.messages.filter(m => m.type === "cancel" && m.requestId === r.requestId).length, 1);
    await assert.rejects(h.request("estimateEvolution", evolution), e => e.code === "BUSY", "slot is retained until terminal drain");
    // A completion already in flight must drain even after its context was replaced.
    h.progress(r, true, 1);
    await assert.rejects(analysis, e => e.code === (reason === "cancel" ? "CANCELLED" : "STALE_CONTEXT"));
    assert.equal(chunks.length, 1);
    t.mock.timers.tick(6000);
    assert.deepEqual(h.fatal, [], "completed cancellation clears its watchdog");
  }
});

test("an unresponsive cancelled analysis fails the connection after five seconds; core exit also settles it", async t => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const abort = new AbortController();
  const analysis = h.request("analyzeEvolution", evolution, { timeoutMs: null, drainAfterAbort: true, signal: abort.signal });
  await flush();
  abort.abort();
  t.mock.timers.tick(4999);
  assert.deepEqual(h.fatal, []);
  t.mock.timers.tick(1);
  await assert.rejects(analysis, e => e.code === "TIMEOUT");
  assert.equal(h.fatal.length, 1);
  const other = await harness(t);
  const pending = other.request("analyzeEvolution", evolution, { timeoutMs: null, drainAfterAbort: true });
  other.transport.close();
  await assert.rejects(pending, e => e.code === "CORE_EXITED");
});

test("main controller and transport keep real daemon history readable alongside held statistics and paused evolution", { skip: process.platform === "win32" }, async t => {
  const { CoreProcess } = await loadBuilt("core-process");
  const { RepositorySessionController } = await loadBuilt("repository-session-controller");
  const root = await mkdtemp(join(tmpdir(), "commitscope-main-stats-"));
  const repo = join(root, "repo"), wrapper = join(root, "wrapper"), home = join(root, "home");
  const statusGate = join(root, "status.gate"), statusStarted = join(root, "status.started");
  const statsGate = join(root, "stats.gate"), statsStarted = join(root, "stats.started");
  let core, controller;
  t.after(async () => {
    await rm(statusGate, { force: true });
    await rm(statsGate, { force: true });
    controller?.dispose();
    await core?.stop();
    await rm(root, { recursive: true, force: true });
  });
  await git(root, ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "file.txt"), "line\n");
  await git(repo, ["add", "."]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  await mkdir(wrapper);
  await mkdir(home);
  await writeFile(join(home, ".gitconfig"), "");
  let realGit;
  for (const directory of process.env.PATH.split(delimiter)) {
    try { const path = join(directory, "git"); await access(path, constants.X_OK); realGit = path; break; } catch {}
  }
  assert.ok(realGit);
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  await writeFile(join(wrapper, "git"), `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = status ] && [ -e ${quote(statusGate)} ]; then
    printf started > ${quote(statusStarted)}
    while [ -e ${quote(statusGate)} ]; do /bin/sleep 0.02; done
  fi
done
exec ${quote(realGit)} "$@"
`, { mode: 0o700 });
  core = new CoreProcess(daemonPath, { cwd: repo, env: createDaemonEnvironment(join(root, "data"), {
    HOME: home, PATH: `${wrapper}${delimiter}${process.env.PATH}`, COMMITSCOPE_TEST_STATS_GATE: statsGate,
  }) });
  await core.start();
  assert.equal(core.getStatus().state, "ready");
  controller = new RepositorySessionController(core);
  const opened = await controller.open(repo);
  const context = { repoId: opened.repoId, generation: opened.generation };
  const baselinePage = await controller.readHistoryPage(null);
  await waitFor(async () => (await controller.getMetadataIndexStatus()).state === "complete", 10_000);
  const baselineStats = await controller.getActivityOverview(params);
  const p = { commit: opened.repository.headOid, pathHex: "", range: null };
  const exists = async path => { try { return Boolean(await readFile(path)); } catch { return false; } };

  await writeFile(statusGate, "hold");
  const status = tracked(core.request("readWorkspaceStatus", { maxEntries: 20 }, context));
  await waitFor(() => exists(statusStarted));
  let analysisFinished = false;
  const chunks = [];
  const analysis = tracked(controller.analyzeEvolution(p, c => chunks.push(c)));
  analysis.then(() => { analysisFinished = true; }, () => { analysisFinished = true; });
  await writeFile(statsGate, "hold");
  const stats = tracked(controller.getActivityOverview(params));
  await waitFor(() => exists(statsStarted));
  const page = await controller.readHistoryPage(null);
  assert.deepEqual(page, baselinePage);
  assert.equal(analysisFinished, false);
  assert.deepEqual(chunks, [], "the held interactive read pauses analysis before any file");
  await rm(statsGate);
  assert.deepEqual(await stats, baselineStats);
  await rm(statusGate);
  await status;
  assert.equal((await analysis).complete, true);
  assert.equal(chunks.at(-1).result.covered.files, 1);

  await rm(statusStarted);
  await writeFile(statusGate, "hold");
  const held = tracked(core.request("readWorkspaceStatus", { maxEntries: 20 }, context));
  await waitFor(() => exists(statusStarted));
  const cancelled = tracked(controller.analyzeEvolution(p, () => {}));
  assert.deepEqual(await controller.cancelEvolution(), { cancelled: true });
  await assert.rejects(cancelled, e => e.code === "CANCELLED");
  await rm(statusGate);
  await held;
  assert.equal(core.getStatus().state, "ready");
});
