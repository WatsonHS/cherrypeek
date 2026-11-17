import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { StatsStore } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "stats-store.mjs")));

const ok = value => ({ ok: true, value });
const fail = (code, message = code) => ({ ok: false, error: { code, message, retryable: true } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const query = { authors: [], caseSensitive: false, committers: [], fromTimestamp: null, message: "", oidPrefix: "", path: null, timeField: "author", timeZone: "UTC", toTimestamp: null };
const caps = { activity: true, changes: true, notable: true, evolution: true };
const NOW = new Date(2026, 5, 15, 12);
const overview = tag => ({ tag, coverage: { complete: true, processed: 5 } });

function fakeApi() {
  const pending = [];
  const calls = [];
  let chunkListener = null;
  const defer = (kind, params) => {
    calls.push({ kind, params });
    return new Promise(resolve => pending.push({ kind, params, resolve }));
  };
  const api = {
    calls, pending,
    getActivityOverview: params => defer("activity", params),
    getChangeStats: params => defer("changes", params),
    getNotableStats: params => defer("notable", params),
    getStatsCommits: params => defer("commits", params),
    cancelStats: async () => { calls.push({ kind: "cancelStats" }); return ok({ cancelled: true }); },
    getStatsExclusions: () => defer("exclusions", {}),
    setStatsExclusions: patterns => defer("setExclusions", patterns),
    estimateEvolution: params => defer("estimate", params),
    analyzeEvolution: (params, streamId) => defer("analyze", { ...params, streamId }),
    onEvolutionChunk: listener => { chunkListener = listener; return () => { chunkListener = null; }; },
    cancelEvolution: async () => { calls.push({ kind: "cancelEvolution" }); return ok({ cancelled: true }); },
    emitChunk: (streamId, chunk) => chunkListener?.({ streamId, chunk }),
    resolve(kind, value, nth = 0) {
      const matching = pending.filter(item => item.kind === kind);
      const target = matching[nth];
      assert.ok(target, `a pending ${kind} request`);
      pending.splice(pending.indexOf(target), 1);
      target.resolve(value);
    },
    count: kind => calls.filter(call => call.kind === kind).length,
  };
  return api;
}

function setup(options = {}) {
  const api = fakeApi();
  const store = new StatsStore(api, { now: () => NOW, debounceMs: 0, retryDelaysMs: [60_000], ...options });
  const binding = (extra = {}) => ({ sessionKey: "r:1", query, capabilities: caps, active: true, indexKey: "i1", evolutionCommit: "c".repeat(40), ...extra });
  return { api, store, binding };
}

test("only the visible section loads, and only while the page is active", async () => {
  const { api, store, binding } = setup();
  store.bind(binding({ active: false }));
  await tick();
  assert.equal(api.calls.length, 0);
  store.bind(binding());
  await tick();
  assert.deepEqual(api.calls.map(call => call.kind), ["activity"]);
  assert.equal(api.calls[0].params.bucket, "day");
  assert.equal(api.calls[0].params.range.endUnix - api.calls[0].params.range.startUnix, 30 * 86_400);
  store.setSection("changes");
  await tick();
  assert.equal(api.count("changes"), 1);
  assert.equal(api.count("notable"), 0);
  store.dispose();
});

test("a late answer for an old range is dropped", async () => {
  const { api, store, binding } = setup();
  store.bind(binding());
  await tick();
  store.setPreset("7d");
  await tick();
  assert.equal(api.count("activity"), 2);
  api.resolve("activity", ok(overview("seven days")), 1);
  await tick();
  assert.equal(store.getView().activity.value.tag, "seven days");
  api.resolve("activity", ok(overview("thirty days")), 0);
  await tick();
  assert.equal(store.getView().activity.value.tag, "seven days", "the old answer must not overwrite the newer one");
  assert.equal(store.getView().activity.loaded.range.endUnix - store.getView().activity.loaded.range.startUnix, 7 * 86_400 - 0, "label range is the request's");
  store.dispose();
});

test("a late answer after the session changed is dropped", async () => {
  const { api, store, binding } = setup();
  store.bind(binding());
  await tick();
  store.bind(binding({ sessionKey: "r:2" }));
  await tick();
  api.resolve("activity", ok(overview("old session")), 0);
  await tick();
  assert.equal(store.getView().activity.value, null);
  assert.equal(api.count("activity"), 2);
  api.resolve("activity", ok(overview("new session")), 0);
  await tick();
  assert.equal(store.getView().activity.value.tag, "new session");
  store.dispose();
});

test("BUSY keeps the previous result and marks it as updating", async () => {
  const { api, store, binding } = setup();
  store.bind(binding());
  await tick();
  api.resolve("activity", ok(overview("first")));
  await tick();
  store.setBucket("week");
  await tick();
  api.resolve("activity", fail("BUSY"));
  await tick();
  const slot = store.getView().activity;
  assert.equal(slot.value.tag, "first");
  assert.equal(slot.updating, true);
  assert.equal(slot.error, null);
  assert.equal(slot.loading, false);
  store.dispose();
});

test("after the retries are used up the previous result stays with a busy note", async () => {
  const { api, store, binding } = setup({ retryDelaysMs: [] });
  store.bind(binding());
  await tick();
  api.resolve("activity", ok(overview("first")));
  await tick();
  store.setBucket("week");
  await tick();
  api.resolve("activity", fail("CANCELLED"));
  await tick();
  const slot = store.getView().activity;
  assert.equal(slot.value.tag, "first");
  assert.equal(slot.error.code, "BUSY");
  store.dispose();
});

test("RESOURCE_LIMIT and INDEX_UNAVAILABLE clear the card and keep the code", async () => {
  const { api, store, binding } = setup();
  store.bind(binding());
  await tick();
  api.resolve("activity", ok(overview("first")));
  await tick();
  store.setPreset("90d");
  await tick();
  api.resolve("activity", fail("RESOURCE_LIMIT", "too large"));
  await tick();
  assert.equal(store.getView().activity.value, null);
  assert.equal(store.getView().activity.error.code, "RESOURCE_LIMIT");
  store.setSection("changes");
  await tick();
  api.resolve("changes", fail("INDEX_UNAVAILABLE"));
  await tick();
  assert.equal(store.getView().changes.error.code, "INDEX_UNAVAILABLE");
  assert.equal(store.getView().changes.value, null);
  store.dispose();
});

test("unchanged bindings do not read again, a failed read is retried only on request", async () => {
  const { api, store, binding } = setup();
  store.bind(binding());
  await tick();
  api.resolve("activity", fail("GIT_ERROR", "boom"));
  await tick();
  store.bind(binding());
  await tick();
  assert.equal(api.count("activity"), 1);
  store.retry();
  await tick();
  assert.equal(api.count("activity"), 2);
  store.dispose();
});

test("an invalid custom range sends nothing; a valid one does", async () => {
  const { api, store, binding } = setup();
  store.bind(binding());
  await tick();
  api.resolve("activity", ok(overview("first")));
  await tick();
  store.setCustom({ from: "2026-06-10", to: "2026-06-01" });
  store.setPreset("custom");
  await tick();
  assert.equal(store.getView().range, null);
  assert.equal(api.count("activity"), 1);
  store.setCustom({ from: "2026-06-01", to: "2026-06-10" });
  await tick();
  assert.equal(api.count("activity"), 2);
  assert.equal(api.calls.filter(call => call.kind === "activity")[1].params.bucket, "day");
  store.dispose();
});

test("directory drill-down sends directoryPrefix and exclusions reload the change section", async () => {
  const { api, store, binding } = setup();
  store.bind(binding());
  store.setSection("changes");
  await tick();
  api.resolve("changes", ok({ coverage: { complete: true, processed: 1 } }));
  await tick();
  store.setPrefix([{ display: "src", rawHex: "737263", textLossy: false }]);
  await tick();
  assert.equal(api.calls.filter(call => call.kind === "changes")[1].params.directoryPrefix, "737263");
  api.resolve("changes", ok({ coverage: { complete: true, processed: 1 } }));
  await tick();
  const saved = store.saveExclusions(["a.lock"]);
  await tick();
  api.resolve("setExclusions", ok({ patterns: ["a.lock"], defaults: [] }));
  assert.equal(await saved, true);
  await tick();
  assert.equal(api.count("changes"), 3);
  store.dispose();
});

test("evolution: estimate, stream chunks, cancel keeps what arrived", async () => {
  const { api, store, binding } = setup();
  store.bind(binding());
  store.setSection("evolution");
  store.setEvolutionPath("src");
  const estimating = store.estimateEvolution();
  await tick();
  assert.equal(api.calls.find(call => call.kind === "estimate").params.pathHex, Buffer.from("src").toString("hex"));
  api.resolve("estimate", ok({ files: 2, totalFiles: 2, lines: 10, bytes: 100, fileLimit: 200, skipped: [] }));
  await estimating;
  assert.equal(store.getView().evolution.phase, "ready");
  const analyzing = store.analyzeEvolution();
  await tick();
  const analyze = api.calls.find(call => call.kind === "analyze");
  const result = { complete: false, covered: { files: 1, lines: 5 }, skipped: [], asOfUnix: 1, age: {}, ownership: [], survival: { weeks: [], byAuthor: [], coverage: { complete: true, processed: 1 } } };
  api.emitChunk("someone-else", { progress: { filesDone: 9, filesTotal: 9 }, result });
  assert.equal(store.getView().evolution.chunk, null, "chunks of another stream are ignored");
  api.emitChunk(analyze.params.streamId, { progress: { filesDone: 1, filesTotal: 2, currentPath: null }, result });
  assert.equal(store.getView().evolution.chunk.progress.filesDone, 1);
  const cancelled = store.cancelEvolution();
  await cancelled;
  assert.equal(store.getView().evolution.phase, "cancelled");
  assert.equal(store.getView().evolution.chunk.progress.filesDone, 1);
  api.resolve("analyze", fail("CANCELLED"));
  await analyzing;
  assert.equal(store.getView().evolution.phase, "cancelled", "a late CANCELLED does not change the outcome");
  assert.equal(store.getView().evolution.chunk.progress.filesDone, 1);
  store.setEvolutionPath("docs");
  assert.equal(store.getView().evolution.phase, "idle");
  assert.equal(store.getView().evolution.chunk, null);
  store.dispose();
});

test("changing the evolution commit drops the estimate", async () => {
  const { api, store, binding } = setup();
  store.bind(binding());
  const estimating = store.estimateEvolution();
  await tick();
  api.resolve("estimate", ok({ files: 1, totalFiles: 1, lines: 1, bytes: 1, fileLimit: 200, skipped: [] }));
  await estimating;
  assert.equal(store.getView().evolution.phase, "ready");
  store.bind(binding({ evolutionCommit: "d".repeat(40) }));
  assert.equal(store.getView().evolution.phase, "idle");
  assert.equal(store.getView().evolution.estimate, null);
  store.dispose();
});

test("zoomRange refines bucket granularity and clearZoom / setPreset restores", async () => {
  const { api, store, binding } = setup();
  store.bind(binding());
  await tick();
  api.resolve("activity", ok(overview("thirty days")));
  await tick();
  assert.equal(store.getView().bucket, "day");
  assert.equal(store.getView().zoomedRange, null);

  const start = Math.floor(NOW.getTime() / 1_000) - 6 * 3_600;
  const end = Math.floor(NOW.getTime() / 1_000);
  store.zoomRange({ startUnix: start, endUnix: end });
  await tick();
  assert.deepEqual(store.getView().zoomedRange, { startUnix: start, endUnix: end });
  assert.equal(store.getView().bucket, "tenMinutes");
  assert.deepEqual(api.calls.at(-1).params.range, { startUnix: start, endUnix: end });
  api.resolve("activity", ok(overview("zoomed")));
  await tick();

  store.clearZoom();
  await tick();
  assert.equal(store.getView().zoomedRange, null);
  assert.equal(store.getView().bucket, "day");
  api.resolve("activity", ok(overview("restored")));
  await tick();

  store.zoomRange({ startUnix: start, endUnix: end });
  await tick();
  store.setPreset("7d");
  await tick();
  assert.equal(store.getView().zoomedRange, null);
  assert.equal(store.getView().preset, "7d");
  assert.equal(store.getView().bucket, "day");
  store.dispose();
});
