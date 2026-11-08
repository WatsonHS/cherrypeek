import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { WorkspaceStore, workspaceItems, workspaceIndicatorFor } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "workspace-store.mjs")));

const hex = text => Buffer.from(text, "utf8").toString("hex");
const path = text => ({ display: text, rawHex: hex(text), textLossy: false });
const change = (status = "modified") => ({ status, additions: 1, deletions: 0, binary: false, gitlink: false });
const entry = (name, extra = {}) => ({ path: path(name), originalPath: null, staged: null, unstaged: null, untracked: false, untrackedSize: null, conflict: null, ...extra });
const status = (entries, extra = {}) => ({
  observedAtUnixMs: 1_000, headReference: "refs/heads/main", headOid: "a".repeat(40), operation: "none",
  entries, complete: true, totalPaths: entries.length, conflictCount: entries.filter(item => item.conflict).length, ...extra,
});
const ok = value => ({ ok: true, value });
const fail = (code, message = code) => ({ ok: false, error: { code, message, retryable: true } });

function fakeApi() {
  const calls = [];
  const pending = [];
  const api = {
    calls,
    readWorkspaceStatus: params => { calls.push(["status", params]); return new Promise(resolve => pending.push({ kind: "status", resolve })); },
    readWorkspaceDiff: params => { calls.push(["diff", params]); return new Promise(resolve => pending.push({ kind: "diff", resolve, params })); },
    readWorkspaceFile: params => { calls.push(["file", params]); return new Promise(resolve => pending.push({ kind: "file", resolve, params })); },
    cancelWorkspace: async () => ok({ cancelled: true }),
    async resolveNext(kind, value) {
      const index = pending.findIndex(item => item.kind === kind);
      assert.ok(index >= 0, `a pending ${kind} request`);
      const [item] = pending.splice(index, 1);
      item.resolve(value);
      await new Promise(resolve => setImmediate(resolve));
      return item;
    },
    pending,
  };
  return api;
}

test("a path with staged and unstaged changes is listed in both groups, conflicts and untracked files in their own", () => {
  const items = workspaceItems(status([
    entry("both.rs", { staged: change(), unstaged: change() }),
    entry("new.md", { untracked: true, untrackedSize: 38 }),
    entry("clash.rs", { conflict: "bothModified", staged: change(), unstaged: change() }),
    entry("gone.rs", { unstaged: change("deleted") }),
  ]));
  assert.deepEqual(items.map(item => `${item.group}:${item.entry.path.display}:${item.alsoIn ?? "-"}`), [
    "conflict:clash.rs:-", "staged:both.rs:unstaged", "unstaged:both.rs:staged", "unstaged:gone.rs:-", "untracked:new.md:-",
  ]);
});

test("the badge is clean only after a complete, current read with no entries", () => {
  const base = { supported: true, bare: false, repoKey: "r", loading: false, error: null, stale: false, selection: null, content: null, previewLines: 200 };
  assert.equal(workspaceIndicatorFor({ ...base, status: status([]) }).state, "clean");
  assert.equal(workspaceIndicatorFor({ ...base, status: status([]), stale: true }).state, "loading", "a change hint after a clean read is not shown as clean");
  assert.equal(workspaceIndicatorFor({ ...base, status: null }).state, "loading");
  assert.equal(workspaceIndicatorFor({ ...base, status: status([], { complete: false, totalPaths: 2001 }) }).state, "changes");
  assert.equal(workspaceIndicatorFor({ ...base, status: null, error: { code: "GIT_FAILED", message: "x" } }).state, "error");
  assert.equal(workspaceIndicatorFor({ ...base, supported: false, status: null }).state, "unavailable");
  assert.equal(workspaceIndicatorFor({ ...base, bare: true, status: null }).state, "bare");
  const stale = workspaceIndicatorFor({ ...base, status: status([entry("a", { unstaged: change() })]), stale: true });
  assert.deepEqual([stale.state, stale.files, stale.stale], ["changes", 1, true]);
});

test("binding reads once, selects the first file and loads its diff", async () => {
  const api = fakeApi();
  const store = new WorkspaceStore(api, () => 10_000);
  store.bind("repo", true, false);
  assert.equal(store.getView().loading, true);
  await api.resolveNext("status", ok(status([entry("a.rs", { staged: change("added") }), entry("b.md", { untracked: true })])));
  assert.deepEqual(store.getView().selection, { group: "staged", pathHex: hex("a.rs") });
  const diff = await api.resolveNext("diff", ok({ side: "staged", path: path("a.rs"), oldPath: null, kind: "text", patch: "", truncated: false, textLossy: false, oldSize: null, newSize: 1 }));
  assert.deepEqual(diff.params, { side: "staged", pathHex: hex("a.rs"), oldPathHex: null });
  assert.equal(store.getView().content.state, "ready");
  store.select({ group: "untracked", pathHex: hex("b.md") });
  const file = await api.resolveNext("file", ok({ path: path("b.md"), kind: "text", text: "x\n", lines: 1, truncated: false, size: 2, textLossy: false, symlinkTarget: null }));
  assert.deepEqual(file.params, { pathHex: hex("b.md"), maxLines: 200 });
  store.loadMorePreview();
  const more = await api.resolveNext("file", ok({ path: path("b.md"), kind: "text", text: "x\n", lines: 1, truncated: false, size: 2, textLossy: false, symlinkTarget: null }));
  assert.equal(more.params.maxLines, 700);
  store.dispose();
});

test("a later selection wins over a slower earlier one", async () => {
  const api = fakeApi();
  const store = new WorkspaceStore(api, () => 10_000);
  store.bind("repo", true, false);
  await api.resolveNext("status", ok(status([entry("a.rs", { unstaged: change() }), entry("b.rs", { unstaged: change() })])));
  store.select({ group: "unstaged", pathHex: hex("b.rs") });
  // The first diff (a.rs) arrives after b.rs was chosen and must not replace it.
  await api.resolveNext("diff", ok({ side: "unstaged", path: path("a.rs"), oldPath: null, kind: "text", patch: "a", truncated: false, textLossy: false, oldSize: 1, newSize: 1 }));
  assert.equal(store.getView().content.state, "loading");
  await api.resolveNext("diff", ok({ side: "unstaged", path: path("b.rs"), oldPath: null, kind: "text", patch: "b", truncated: false, textLossy: false, oldSize: 1, newSize: 1 }));
  assert.equal(store.getView().content.diff.patch, "b");
  store.dispose();
});

test("reads are throttled; change hints mark the numbers stale and re-read later", async () => {
  const api = fakeApi();
  let now = 10_000;
  const store = new WorkspaceStore(api, () => now);
  store.bind("repo", true, false);
  await api.resolveNext("status", ok(status([entry("a.rs", { unstaged: change() })])));
  await api.resolveNext("diff", ok({ side: "unstaged", path: path("a.rs"), oldPath: null, kind: "text", patch: "", truncated: false, textLossy: false, oldSize: 1, newSize: 1 }));
  const before = api.calls.filter(call => call[0] === "status").length;
  now += 500;
  await store.readStatus();
  assert.equal(api.pending.filter(item => item.kind === "status").length, 0);
  assert.equal(api.calls.filter(call => call[0] === "status").length, before, "a read within three seconds of the last is skipped");
  store.markChanged();
  assert.equal(store.getView().stale, true);
  assert.equal(workspaceIndicatorFor(store.getView()).stale, true);
  const reading = store.readStatus(true);
  await api.resolveNext("status", ok(status([entry("a.rs", { unstaged: change() })])));
  await reading;
  assert.equal(store.getView().stale, false);
  store.dispose();
});

test("a core without the workspace capability leaves the page in its placeholder state", async () => {
  const api = fakeApi();
  const store = new WorkspaceStore(api, () => 10_000);
  store.bind("repo", true, false);
  await api.resolveNext("status", fail("UNKNOWN_METHOD", "核心还不能读取工作区"));
  assert.equal(store.getView().supported, false);
  assert.equal(workspaceIndicatorFor(store.getView()).state, "unavailable");
  store.bind("repo", false, false);
  store.markChanged();
  assert.equal(api.calls.filter(call => call[0] === "status").length, 1, "no reads without the capability");
  store.dispose();
});

test("a bare repository never reads the working tree", () => {
  const api = fakeApi();
  const store = new WorkspaceStore(api, () => 10_000);
  store.bind("repo", true, true);
  assert.equal(api.calls.length, 0);
  assert.equal(workspaceIndicatorFor(store.getView()).state, "bare");
});
