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
const changedFile = text => ({ status: "modified", oldPath: path(text), newPath: path(text), oldOid: null, newOid: null, oldMode: "100644", newMode: "100644",
  similarity: null, additions: 1, deletions: 1, binary: false, gitlink: false });
const pathPage = (commit, files) => ({ oid: commit, parentIndex: 0, parentOid: oid("0"), offset: 0, pageSize: 200, totalFiles: files.length, hasMore: false, files,
  overview: { totalFiles: files.length, counts: { added: 0, modified: files.length, deleted: 0, renamed: 0, copied: 0, typeChanged: 0 }, additions: files.length, deletions: files.length,
    binaryFiles: 0, gitlinkFiles: 0, directories: [] } });

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
    listPathChanges: call("pathChanges"),
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

test("expanding and reopening a directory keeps the current file and reuses its entries", async () => {
  const api = fakeApi();
  const store = new FilesStore(api);
  store.bind("repo", capabilities);
  store.setVersion(version);
  await api.answer("tree", ok({ commit: version.commit, path: null, entries: [], offset: 0, total: 0, hasMore: false }));
  store.select({ path: path("README.md"), kind: "file" });
  const selection = store.getView().selection;
  store.toggleDirectory(hex("src"));
  await api.answer("tree", ok({ commit: version.commit, path: path("src"), entries: [], offset: 0, total: 0, hasMore: false }));
  store.toggleDirectory(hex("src"));
  store.toggleDirectory(hex("src"));
  await flush();
  assert.equal(store.getView().selection, selection);
  assert.equal(store.getView().tab, "content");
  assert.equal(store.getView().directories[hex("src")].state, "ready");
  assert.deepEqual(api.pending.map(item => item.kind), ["content"], "expansion does not request history or reread cached entries");
  store.dispose();
});

test("revealing a folder from the path expands it in the tree and leaves the right side alone", async () => {
  const api = fakeApi();
  const store = new FilesStore(api);
  store.bind("repo", capabilities);
  store.setVersion(version);
  await api.answer("tree", ok({ commit: version.commit, path: null, entries: [], offset: 0, total: 0, hasMore: false }));
  store.select({ path: path("apps/desktop/a.ts"), kind: "file" }, { tab: "history" });
  await api.answer("history", ok({ commit: version.commit, path: path("apps/desktop/a.ts"), entries: [historyEntry(oid("c"))], nextCursor: null }));
  await api.answer("tree", ok({ commit: version.commit, path: path("apps"), entries: [], offset: 0, total: 0, hasMore: false }));
  await api.answer("tree", ok({ commit: version.commit, path: path("apps/desktop"), entries: [], offset: 0, total: 0, hasMore: false }));
  store.toggleDirectory(hex("apps"));
  const before = store.getView();
  assert.equal(before.expanded[hex("apps")], undefined, "the folder was collapsed");

  store.revealDirectory(path("apps"));
  const after = store.getView();
  assert.equal(after.expanded[hex("apps")], true, "the folder is expanded again");
  for (const key of ["selection", "tab", "selectedCommit", "history", "change", "content"]) {
    assert.equal(after[key], before[key], `${key} is unchanged`);
  }
  store.revealDirectory(path("apps/desktop"));
  assert.equal(store.getView().expanded[hex("apps/desktop")], true);
  assert.equal(store.getView().selection, before.selection, "revealing never selects the folder");
  assert.ok(!api.pending.some(item => item.kind === "history" && item.params.kind === "directory"), "no directory history is read");
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
  // The directory's newest commit lists the files it changed under the directory; each opens its own diff.
  const changes = await api.answer("pathChanges", ok(pathPage(oid("c"), [changedFile("src/x.ts"), changedFile("src/deep/y.ts")])));
  assert.deepEqual(changes.params, { oid: oid("c"), parentIndex: 0, pathHex: hex("src"), offset: 0, pageSize: 200 });
  assert.deepEqual(store.getView().pathChanges.files.map(file => file.newPath.display), ["src/x.ts", "src/deep/y.ts"]);
  store.togglePathFile(store.getView().pathChanges.files[1]);
  const fileDiff = await api.answer("change", ok({ oid: oid("c") }));
  assert.deepEqual(fileDiff.params, { oid: oid("c"), parentIndex: 0, pathHex: hex("src/deep/y.ts"), oldPathHex: null });
  assert.deepEqual([store.getView().pathOpen, store.getView().pathChange.state], [hex("src/deep/y.ts"), "ready"]);
  store.togglePathFile(store.getView().pathChanges.files[1]);
  assert.deepEqual([store.getView().pathOpen, store.getView().pathChange], [null, null], "opening it again closes it");

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
  let view = store.getView();
  assert.deepEqual([view.tab, view.historyOpen, view.selection.path.display], ["history", true, "src/new.ts"], "the file stays selected and the history column opens");
  assert.deepEqual([view.focus.line, view.focus.originalLine, view.selectedCommit], [2, 11, oid("1")]);
  const first = await api.answer("change", fail("INVALID_REQUEST", "Root commits require parentIndex=null"));
  assert.deepEqual([first.params.pathHex, first.params.parentIndex], [hex("src/old.ts"), 0], "a line from before the rename reads its change under the old path");
  const retried = await api.answer("change", ok({ oid: oid("1") }));
  assert.equal(retried.params.parentIndex, null, "with the parents unknown, a root commit is read again against the empty tree");
  assert.equal(store.getView().change.state, "ready");
  const history = await api.answer("history", ok({ commit: version.commit, path: path("src/new.ts"), entries: [historyEntry(oid("2"))], nextCursor: null }));
  assert.equal(history.params.pathHex, hex("src/new.ts"), "the column lists this file's own history");

  store.openOriginalHistory();
  view = store.getView();
  assert.deepEqual([view.selection.path.display, view.selectedCommit, view.tab, view.focus.line], ["src/old.ts", oid("1"), "history", 2]);
  assert.equal(api.pending.filter(item => item.kind === "change").length, 0, "the change already shown is not read again");
  assert.equal(store.closeChange(), 2);
  view = store.getView();
  assert.deepEqual([view.selection.path.display, view.tab, view.focus], ["src/new.ts", "content", null], "going back returns to the file the blame was shown for");
  store.dispose();
});

test("the history column sits beside the file: picking a commit opens its change, and closing it shows the file again", async () => {
  const api = fakeApi();
  const store = new FilesStore(api);
  store.bind("repo", capabilities);
  store.setVersion(version);
  await api.answer("tree", ok({ commit: version.commit, path: null, entries: [], offset: 0, total: 0, hasMore: false }));
  store.select({ path: path("a.ts"), kind: "file" });
  await api.answer("content", ok(textContent("a.ts", "x\n")));
  store.setHistoryOpen(true);
  await api.answer("history", ok({ commit: version.commit, path: path("a.ts"), entries: [historyEntry(oid("c")), historyEntry(oid("d"))], nextCursor: null }));
  let view = store.getView();
  assert.deepEqual([view.tab, view.selectedCommit, view.change], ["content", null, null], "opening the column picks nothing; the file stays");
  assert.ok(!api.pending.some(item => item.kind === "change"));
  store.selectCommit(oid("d"));
  assert.equal(store.getView().tab, "history");
  const change = await api.answer("change", ok({ oid: oid("d") }));
  assert.equal(change.params.oid, oid("d"));
  assert.equal(store.closeChange(), null);
  view = store.getView();
  assert.deepEqual([view.tab, view.historyOpen, view.content.state], ["content", true, "ready"], "the file is shown again, with the column still open");
  store.setHistoryOpen(false);
  assert.equal(store.getView().historyOpen, false);
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

const textContent = (file, text, commit = version.commit) => ({ commit, path: path(file), kind: "text", text, lines: 1, totalLines: 1, truncated: false, size: text.length, textLossy: false, symlinkTarget: null, blobOid: null });

test("a history answer for a path that is no longer selected is dropped", async () => {
  const api = fakeApi();
  const store = new FilesStore(api);
  store.bind("repo", capabilities);
  store.setVersion(version);
  store.select({ path: path("a.ts"), kind: "file" }, { tab: "history" });
  store.select({ path: path("b.ts"), kind: "file" }, { tab: "history" });
  await api.answer("history", ok({ commit: version.commit, path: path("a.ts"), entries: [historyEntry(oid("c"))], nextCursor: "more-of-a" }),
    item => item.params.pathHex === hex("a.ts"));
  let view = store.getView();
  assert.equal(view.selection.path.display, "b.ts");
  assert.ok(view.history.key.includes(hex("b.ts")));
  assert.deepEqual([view.history.state, view.history.entries, view.history.nextCursor], ["loading", [], null]);
  assert.equal(view.selectedCommit, null, "a.ts's newest commit is not selected for b.ts");
  assert.equal(api.pending.some(item => item.kind === "change"), false, "no diff is read for a.ts's commit");
  await api.answer("history", ok({ commit: version.commit, path: path("b.ts"), entries: [historyEntry(oid("d"))], nextCursor: null }));
  view = store.getView();
  assert.deepEqual(view.history.entries.map(entry => entry.commit.oid), [oid("d")]);
  assert.equal(view.selectedCommit, oid("d"));
  assert.deepEqual(api.pending.filter(item => item.kind === "change").map(item => item.params.pathHex), [hex("b.ts")]);
  store.dispose();
});

test("a change answer for a commit that is no longer selected is dropped", async () => {
  const api = fakeApi();
  const store = new FilesStore(api);
  store.bind("repo", capabilities);
  store.setVersion(version);
  store.select({ path: path("a.ts"), kind: "file" }, { tab: "history" });
  await api.answer("history", ok({ commit: version.commit, path: path("a.ts"), entries: [historyEntry(oid("d")), historyEntry(oid("e"))], nextCursor: null }));
  assert.equal(store.getView().selectedCommit, oid("d"));
  store.selectCommit(oid("e"));
  await api.answer("change", ok({ oid: oid("d"), kind: "text", patch: "D" }), item => item.params.oid === oid("d"));
  let view = store.getView();
  assert.equal(view.selectedCommit, oid("e"));
  assert.ok(view.change.key.startsWith(`${oid("e")}:`));
  assert.deepEqual([view.change.state, view.change.value], ["loading", null], "d's diff is not shown for e");
  await api.answer("change", ok({ oid: oid("e"), kind: "text", patch: "E" }));
  view = store.getView();
  assert.deepEqual([view.change.state, view.change.value.oid, view.change.value.patch], ["ready", oid("e"), "E"]);
  store.dispose();
});

test("switching the tree version drops content, history and directory answers for the old version", async () => {
  const api = fakeApi();
  const store = new FilesStore(api);
  store.bind("repo", capabilities);
  store.setVersion(version);
  store.select({ path: path("src/a.ts"), kind: "file" });
  store.setTab("history");
  await flush();
  assert.deepEqual(api.pending.map(item => item.kind).sort(), ["content", "history", "tree"], "content, history and the root directory are in flight");
  const next = { commit: oid("f"), label: "v2" };
  store.setVersion(next);
  const old = item => item.params.commit === version.commit;
  await api.answer("tree", ok({ commit: version.commit, path: null, entries: [{ name: "src" }], offset: 0, total: 1, hasMore: false }), old);
  await api.answer("content", ok(textContent("src/a.ts", "old\n")), old);
  await api.answer("history", ok({ commit: version.commit, path: path("src/a.ts"), entries: [historyEntry(oid("c"))], nextCursor: null }), old);
  let view = store.getView();
  assert.equal(view.version, next);
  assert.ok(view.content.key.startsWith(`${next.commit}:`), "the file is read again at the new version");
  assert.equal(view.content.state, "loading");
  assert.ok(view.history.key.startsWith(`${next.commit}:`));
  assert.deepEqual([view.history.state, view.history.entries], ["loading", []]);
  assert.deepEqual([view.selectedCommit, view.change], [null, null]);
  assert.deepEqual(view.directories[""], { state: "loading", entries: [], total: 0, hasMore: false, error: null });
  assert.equal(view.directories[hex("src")], undefined, "the old version's queued read of src does not land either");
  assert.equal(api.pending.some(item => item.kind === "change"), false);
  assert.deepEqual(api.pending.filter(item => item.kind === "tree").map(item => [item.params.commit, item.params.pathHex]), [[next.commit, null]],
    "only the new version's root is read");
  await api.answer("tree", ok({ commit: next.commit, path: null, entries: [], offset: 0, total: 0, hasMore: false }));
  await api.answer("history", ok({ commit: next.commit, path: path("src/a.ts"), entries: [historyEntry(oid("9"))], nextCursor: null }));
  view = store.getView();
  assert.equal(view.directories[""].state, "ready");
  assert.deepEqual(view.history.entries.map(entry => entry.commit.oid), [oid("9")]);
  store.setTab("content");
  const content = await api.answer("content", ok(textContent("src/a.ts", "new\n", next.commit)));
  assert.equal(content.params.commit, next.commit);
  assert.equal(store.getView().content.value.text, "new\n");
  store.dispose();
});

const blameCommit = id => ({ oid: id, summary: "s", summaryTruncated: false, authorName: "W", authorEmail: "w@x", authorTime: 1, textLossy: false });
const blameBlock = (line, id) => ({ startLine: line, lineCount: 1, oid: id, originalStartLine: line, originalPath: null });
const blameChunk = (file, totalLines, lines, id) => ({ commit: version.commit, path: path(file), totalLines, blocks: lines.map(line => blameBlock(line, id)), commits: [blameCommit(id)] });

for (const [what, leave, expectedKey] of [
  ["another file", store => store.select({ path: path("b.ts"), kind: "file" }), `${version.commit}:${hex("b.ts")}`],
  ["another tree version", store => store.setVersion({ commit: oid("f"), label: "v2" }), `${oid("f")}:${hex("a.ts")}`],
]) {
  test(`blame left mid-stream for ${what} cannot add blocks to, or complete, the next blame`, async () => {
    const api = fakeApi();
    const store = new FilesStore(api);
    store.bind("repo", capabilities);
    store.setVersion(version);
    store.select({ path: path("a.ts"), kind: "file" });
    store.setBlame(true);
    const first = api.pending.find(item => item.kind === "blame");
    api.emitBlame({ streamId: first.streamId, chunk: blameChunk("a.ts", 2, [1], oid("1")) });
    assert.equal(store.getView().blame.blocks.length, 1);

    leave(store);
    const second = api.pending.find(item => item.kind === "blame" && item !== first);
    assert.ok(second, "the next blame starts");
    assert.notEqual(second.streamId, first.streamId);
    assert.equal(store.getView().blame.key, expectedKey);
    api.emitBlame({ streamId: second.streamId, chunk: blameChunk("b.ts", 3, [1, 2], oid("b")) });
    // The first stream's remaining chunk and its final reply arrive late. Had the reply been taken,
    // it would declare two blocks and finish the second blame, which has two of its three.
    api.emitBlame({ streamId: first.streamId, chunk: blameChunk("a.ts", 2, [2], oid("2")) });
    await api.answer("blame", ok({ totalLines: 2, blocks: 2 }), item => item === first);
    let blame = store.getView().blame;
    assert.equal(blame.key, expectedKey);
    assert.equal(blame.state, "loading", "the first stream's reply does not complete the second");
    assert.equal(blame.totalLines, 3);
    assert.deepEqual(blame.blocks.map(block => [block.startLine, block.oid]), [[1, oid("b")], [2, oid("b")]]);
    assert.deepEqual(Object.keys(blame.commits), [oid("b")]);

    api.emitBlame({ streamId: second.streamId, chunk: blameChunk("b.ts", 3, [3], oid("b")) });
    await api.answer("blame", ok({ totalLines: 3, blocks: 3 }), item => item === second);
    blame = store.getView().blame;
    assert.equal(blame.state, "ready");
    assert.deepEqual(blame.blocks.map(block => block.oid), [oid("b"), oid("b"), oid("b")]);
    store.dispose();
  });
}

test("a file over the whole-file limit falls back to the changes-only diff in its history", async () => {
  const api = fakeApi();
  const store = new FilesStore(api, () => true);
  store.bind("repo", { ...capabilities, fullFile: true });
  store.setVersion(version);
  store.select({ path: path("big.ts"), kind: "file" }, { tab: "history" });
  await api.answer("history", ok({ commit: version.commit, path: path("big.ts"), entries: [historyEntry(oid("d"))], nextCursor: null }));
  const full = await api.answer("change", fail("RESOURCE_LIMIT", "内容超出读取上限"));
  assert.equal(full.params.fullFile, true);
  assert.equal(store.getView().change.state, "loading", "the limit is not shown as an error");
  const diff = { oid: oid("d"), kind: "text", patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false };
  const fallback = await api.answer("change", ok(diff));
  assert.deepEqual(fallback.params, { oid: oid("d"), parentIndex: 0, pathHex: hex("big.ts"), oldPathHex: null }, "read again without fullFile");
  const change = store.getView().change;
  assert.deepEqual([change.state, change.error, change.value], ["ready", null, diff]);
  assert.equal(change.fullFileLimited, true, "the page is told the file is over the whole-file limit");
  store.dispose();
});
