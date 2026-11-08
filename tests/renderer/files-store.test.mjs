import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { FilesStore, blameLineIndex, blameHeat } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "files-store.mjs")));

const hex = text => Buffer.from(text, "utf8").toString("hex");
const path = text => ({ display: text, rawHex: hex(text), textLossy: false });
const oid = char => char.repeat(40);
const ok = value => ({ ok: true, value });
const fail = (code, message = code) => ({ ok: false, error: { code, message, retryable: true } });
const identity = { name: "W", email: "w@example.com", timestamp: 1, offsetMinutes: 0 };
const summary = (id, parents = [oid("0")]) => ({ oid: id, parents, summary: `commit ${id.slice(0, 4)}`, summaryTruncated: false, author: identity, committer: identity, textLossy: false });
const historyEntry = (id, extra = {}) => ({ commit: summary(id, extra.parents), change: { status: "modified", oldPath: null, additions: 1, deletions: 1, binary: false, files: 1, ...extra.change } });
const flush = () => new Promise(resolve => setImmediate(resolve));

function fakeApi() {
  const pending = [];
  let blameListener = null;
  const call = kind => params => new Promise(resolve => pending.push({ kind, params, resolve }));
  return {
    pending,
    listTree: call("tree"),
    readFileContent: call("content"),
    readFileHistory: call("history"),
    readFileChange: call("change"),
    readBlame: (params, streamId) => new Promise(resolve => pending.push({ kind: "blame", params, streamId, resolve })),
    onBlameChunk(listener) { blameListener = listener; return () => { blameListener = null; }; },
    cancelFiles: async () => ok({ cancelled: true }),
    emitBlame(event) { blameListener?.(event); },
    async answer(kind, value, match = () => true) {
      await flush();
      const index = pending.findIndex(item => item.kind === kind && match(item));
      assert.ok(index >= 0, `a pending ${kind} request`);
      const [item] = pending.splice(index, 1);
      item.resolve(value);
      await flush();
      await flush();
      return item;
    },
  };
}

const capabilities = { files: true, blame: true, fullFile: false };
const version = { commit: oid("a"), label: "main" };

test("the root directory loads for the tree version, and a nested file expands its parents", async () => {
  const api = fakeApi();
  const store = new FilesStore(api);
  store.bind("repo", capabilities);
  store.setVersion(version);
  const root = await api.answer("tree", ok({ commit: version.commit, path: null, entries: [], offset: 0, total: 0, hasMore: false }));
  assert.deepEqual(root.params, { commit: version.commit, pathHex: null, offset: 0, limit: 500 });
  store.select({ path: path("apps/desktop/a.ts"), kind: "file" });
  assert.deepEqual(Object.keys(store.getView().expanded).sort(), [hex("apps"), hex("apps/desktop")].sort());
  const content = await api.answer("content", ok({ commit: version.commit, path: path("apps/desktop/a.ts"), kind: "text", text: "x\n", lines: 1, totalLines: 1, truncated: false, size: 2, textLossy: false, symlinkTarget: null, blobOid: oid("b") }));
  assert.equal(content.params.maxLines, 5000);
  assert.equal(store.getView().content.state, "ready");
  assert.equal(api.pending.filter(item => item.kind === "tree").length, 1, "parent directories are read one after another");
  const first = await api.answer("tree", ok({ commit: version.commit, path: path("apps"), entries: [], offset: 0, total: 0, hasMore: false }));
  assert.equal(first.params.pathHex, hex("apps"));
  const second = api.pending.find(item => item.kind === "tree");
  assert.equal(second?.params.pathHex, hex("apps/desktop"));
  store.dispose();
});

test("directories open on history; a file's history selects its newest change and loads that diff", async () => {
  const api = fakeApi();
  const store = new FilesStore(api);
  store.bind("repo", capabilities);
  store.setVersion(version);
  await api.answer("tree", ok({ commit: version.commit, path: null, entries: [], offset: 0, total: 0, hasMore: false }));
  store.select({ path: path("src"), kind: "directory" });
  assert.equal(store.getView().tab, "history");
  const dir = await api.answer("history", ok({ commit: version.commit, path: path("src"), entries: [historyEntry(oid("c"))], nextCursor: null }));
  assert.equal(dir.params.kind, "directory");
  assert.equal(api.pending.filter(item => item.kind === "change").length, 0, "directories have no single-file diff");

  store.select({ path: path("src/a.ts"), kind: "file" }, { tab: "history" });
  await api.answer("tree", ok({ commit: version.commit, path: path("src"), entries: [], offset: 0, total: 0, hasMore: false }));
  await api.answer("history", ok({ commit: version.commit, path: path("src/a.ts"), entries: [historyEntry(oid("d"), { change: { status: "renamed", oldPath: path("src/old.ts") } }), historyEntry(oid("e"), { parents: [] })], nextCursor: "next" }));
  assert.equal(store.getView().selectedCommit, oid("d"));
  const change = await api.answer("change", ok({ oid: oid("d") }));
  assert.deepEqual(change.params, { oid: oid("d"), parentIndex: 0, pathHex: hex("src/a.ts"), oldPathHex: hex("src/old.ts") });
  store.selectCommit(oid("e"));
  const root = await api.answer("change", ok({ oid: oid("e") }));
  assert.equal(root.params.parentIndex, null, "a root commit compares with the empty tree");
  store.dispose();
});

test("an answer for a file that is no longer selected is dropped", async () => {
  const api = fakeApi();
  const store = new FilesStore(api);
  store.bind("repo", capabilities);
  store.setVersion(version);
  store.select({ path: path("a.ts"), kind: "file" });
  store.select({ path: path("b.ts"), kind: "file" });
  await api.answer("content", ok({ commit: version.commit, path: path("a.ts"), kind: "text", text: "A\n", lines: 1, totalLines: 1, truncated: false, size: 2, textLossy: false, symlinkTarget: null, blobOid: null }),
    item => item.params.pathHex === hex("a.ts"));
  assert.equal(store.getView().content.state, "loading");
  await api.answer("content", ok({ commit: version.commit, path: path("b.ts"), kind: "text", text: "B\n", lines: 1, totalLines: 1, truncated: false, size: 2, textLossy: false, symlinkTarget: null, blobOid: null }));
  assert.equal(store.getView().content.value.text, "B\n");
  store.dispose();
});

test("BUSY answers are retried while the read is still wanted", async () => {
  const api = fakeApi();
  const store = new FilesStore(api);
  store.bind("repo", capabilities);
  store.setVersion(version);
  await api.answer("tree", fail("BUSY"));
  assert.equal(store.getView().directories[""].state, "loading");
  await new Promise(resolve => setTimeout(resolve, 450));
  await api.answer("tree", ok({ commit: version.commit, path: null, entries: [], offset: 0, total: 0, hasMore: false }));
  assert.equal(store.getView().directories[""].state, "ready");
  store.dispose();
});

test("blame accumulates chunks of the current stream only; a line from before a rename opens the old path's history and returns", async () => {
  const api = fakeApi();
  const store = new FilesStore(api);
  store.bind("repo", capabilities);
  store.setVersion(version);
  store.select({ path: path("src/new.ts"), kind: "file" });
  store.setBlame(true);
  const request = api.pending.find(item => item.kind === "blame");
  api.emitBlame({ streamId: "someone-else", chunk: { commit: version.commit, path: path("src/new.ts"), totalLines: 99, blocks: [], commits: [] } });
  assert.equal(store.getView().blame.totalLines, 0);
  const commitTime = time => ({ oid: oid(time === 1 ? "1" : "2"), summary: "s", summaryTruncated: false, authorName: "W", authorEmail: "w@x", authorTime: time, textLossy: false });
  api.emitBlame({ streamId: request.streamId, chunk: { commit: version.commit, path: path("src/new.ts"), totalLines: 3,
    blocks: [{ startLine: 1, lineCount: 2, oid: oid("1"), originalStartLine: 10, originalPath: path("src/old.ts") }], commits: [commitTime(1)] } });
  api.emitBlame({ streamId: request.streamId, chunk: { commit: version.commit, path: path("src/new.ts"), totalLines: 3,
    blocks: [{ startLine: 3, lineCount: 1, oid: oid("2"), originalStartLine: 3, originalPath: null }], commits: [commitTime(2)] } });
  await api.answer("blame", ok({ totalLines: 3, blocks: 2 }));
  assert.equal(store.getView().blame.state, "ready");
  assert.equal(store.getView().blame.blocks.length, 2);

  store.locateFromBlame(2);
  const view = store.getView();
  assert.equal(view.tab, "history");
  assert.equal(view.selection.path.display, "src/old.ts");
  assert.deepEqual([view.focus.line, view.focus.originalLine, view.selectedCommit], [2, 11, oid("1")]);
  const history = await api.answer("history", ok({ commit: version.commit, path: path("src/old.ts"), entries: [historyEntry(oid("1"), { parents: [] })], nextCursor: null }));
  assert.equal(history.params.pathHex, hex("src/old.ts"));
  await flush();
  const change = api.pending.find(item => item.kind === "change");
  assert.equal(change.params.pathHex, hex("src/old.ts"));
  assert.equal(change.params.parentIndex, null, "a root commit found through blame compares with the empty tree");
  assert.equal(store.returnToLine(), 2);
  assert.equal(store.getView().selection.path.display, "src/new.ts");
  assert.equal(store.getView().tab, "content");
  store.dispose();
});

test("blame chunks that arrive after the final reply still complete the stream", async () => {
  const api = fakeApi();
  const store = new FilesStore(api);
  store.bind("repo", capabilities);
  store.setVersion(version);
  store.select({ path: path("a.ts"), kind: "file" });
  store.setBlame(true);
  const request = api.pending.find(item => item.kind === "blame");
  const commit = { oid: oid("1"), summary: "s", summaryTruncated: false, authorName: "W", authorEmail: "w@x", authorTime: 1, textLossy: false };
  api.emitBlame({ streamId: request.streamId, chunk: { commit: version.commit, path: path("a.ts"), totalLines: 2, blocks: [{ startLine: 1, lineCount: 1, oid: oid("1"), originalStartLine: 1, originalPath: null }], commits: [commit] } });
  await api.answer("blame", ok({ totalLines: 2, blocks: 2 }));
  assert.equal(store.getView().blame.state, "loading", "one block is still on its way");
  api.emitBlame({ streamId: request.streamId, chunk: { commit: version.commit, path: path("a.ts"), totalLines: 2, blocks: [{ startLine: 2, lineCount: 1, oid: oid("1"), originalStartLine: 2, originalPath: null }], commits: [] } });
  assert.equal(store.getView().blame.state, "ready");
  assert.equal(store.getView().blame.blocks.length, 2);
  store.dispose();
});

test("blame lines map to their blocks and age levels spread from oldest to newest", () => {
  const blocks = [{ startLine: 1, lineCount: 2, oid: "a" }, { startLine: 3, lineCount: 1, oid: "b" }];
  const lines = blameLineIndex(blocks, 4);
  assert.deepEqual([lines[1]?.oid, lines[2]?.oid, lines[3]?.oid, lines[4]], ["a", "a", "b", undefined]);
  const heat = blameHeat({ a: { authorTime: 10 }, b: { authorTime: 20 }, c: { authorTime: 30 } });
  assert.deepEqual([heat.a, heat.b, heat.c], [0, 2, 4]);
});
