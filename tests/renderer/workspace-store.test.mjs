import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { WorkspaceStore, workspaceItems, workspaceIndicatorFor, workspaceIsClean } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "workspace-store.mjs")));

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
    /** Answers the nth still-pending request of a kind (0 = oldest), so reads can be answered out of order. */
    async resolveNth(kind, nth, value) {
      const ofKind = pending.filter(item => item.kind === kind);
      assert.ok(nth < ofKind.length, `a pending ${kind} request #${nth}`);
      return api.resolveItem(ofKind[nth], value);
    },
    async resolveItem(item, value) {
      const index = pending.indexOf(item);
      assert.ok(index >= 0, "the request is still pending");
      pending.splice(index, 1);
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

test("slow reads stretch the gap and hint reads that find nothing new back off further", async () => {
  const api = fakeApi();
  let now = 10_000;
  const store = new WorkspaceStore(api, () => now);
  store.bind("repo", true, false);
  now += 2_000; // the read takes two seconds
  await api.resolveNext("status", ok(status([entry("a.rs", { unstaged: change() })])));
  await api.resolveNext("diff", ok({ side: "unstaged", path: path("a.rs"), oldPath: null, kind: "text", patch: "", truncated: false, textLossy: false, oldSize: 1, newSize: 1 }));
  assert.equal(store.readGap, 20_000, "ten times a two-second read");
  const same = status([entry("a.rs", { unstaged: change() })]);
  const gaps = [];
  for (let round = 0; round < 6; round += 1) {
    const reading = store.readStatus(true, "hint");
    await api.resolveNext("status", ok(same));
    await reading;
    gaps.push(store.readGap);
  }
  assert.deepEqual(gaps, [6_000, 9_000, 15_000, 27_000, 51_000, 60_000], "quiet hint reads double the gap up to sixty seconds");
  const explicit = store.readStatus(true);
  await api.resolveNext("status", ok(same));
  await explicit;
  assert.equal(store.readGap, 3_000, "an explicit read drops the backoff");
  store.dispose();
});

test("a hidden window only marks the status stale on change hints", async () => {
  const api = fakeApi();
  let visible = true;
  const store = new WorkspaceStore(api, () => 10_000, () => false, () => visible);
  store.bind("repo", true, false);
  await api.resolveNext("status", ok(status([])));
  visible = false;
  store.markChanged();
  assert.equal(store.getView().stale, true);
  assert.equal(store.hasScheduledRead, false);
  visible = true;
  store.markChanged();
  assert.equal(store.hasScheduledRead, true);
  store.dispose();
});

const shownPaths = view => workspaceItems(view.status).map(item => `${item.group}:${item.entry.path.display}`);

test("an older status read that answers after a newer one cannot replace it", async () => {
  const api = fakeApi();
  const store = new WorkspaceStore(api, () => 10_000);
  store.bind("repo", true, false);
  await api.resolveNext("status", ok(status([entry("a.rs", { unstaged: change() })], { observedAtUnixMs: 1_000 })));
  const older = store.readStatus(true);
  const newer = store.readStatus(true);
  const newest = status([entry("c.rs", { untracked: true, untrackedSize: 3 })], { observedAtUnixMs: 3_000 });
  await api.resolveNth("status", 1, ok(newest));
  await newer;
  assert.equal(store.getView().status, newest);
  await api.resolveNth("status", 0, ok(status([entry("b.rs", { staged: change("added") })], { observedAtUnixMs: 2_000 })));
  await older;
  const view = store.getView();
  assert.equal(view.status, newest, "the older answer is dropped");
  assert.equal(view.status.observedAtUnixMs, 3_000);
  assert.equal(workspaceIndicatorFor(view).observedAtUnixMs, 3_000, "the badge keeps the newer observation time");
  assert.deepEqual(shownPaths(view), ["untracked:c.rs"]);
  assert.deepEqual(view.selection, { group: "untracked", pathHex: hex("c.rs") });
  assert.deepEqual([view.loading, view.error, view.stale], [false, null, false]);
  assert.equal(api.calls.some(([kind, params]) => kind !== "status" && params.pathHex === hex("b.rs")), false, "nothing is read for the older answer's files");
  store.dispose();
});

test("a status read for the previous repository never shows up for the next one", async () => {
  const api = fakeApi();
  const store = new WorkspaceStore(api, () => 10_000);
  store.bind("repo-a", true, false);
  store.bind("repo-b", true, false);
  await api.resolveNth("status", 0, ok(status([entry("only-in-a.rs", { unstaged: change() })])));
  let view = store.getView();
  assert.equal(view.repoKey, "repo-b");
  assert.deepEqual([view.status, view.selection, view.content, view.loading], [null, null, null, true], "B is still waiting for its own read");
  assert.equal(workspaceIndicatorFor(view).state, "loading", "the badge shows no count from A");
  assert.equal(api.calls.filter(([kind]) => kind !== "status").length, 0, "no diff is read for A's file");
  const forB = status([entry("only-in-b.rs", { staged: change("added") })], { observedAtUnixMs: 2_000 });
  await api.resolveNth("status", 0, ok(forB));
  view = store.getView();
  assert.equal(view.status, forB);
  assert.deepEqual(view.selection, { group: "staged", pathHex: hex("only-in-b.rs") });

  // A failing re-read and a late diff for B do not show up for C either.
  const rereadB = store.readStatus(true);
  store.bind("repo-c", true, false);
  await api.resolveNth("status", 0, fail("GIT_FAILED", "B failed"));
  await rereadB;
  await api.resolveNext("diff", ok({ side: "staged", path: path("only-in-b.rs"), oldPath: null, kind: "text", patch: "b", truncated: false, textLossy: false, oldSize: null, newSize: 1 }));
  view = store.getView();
  assert.equal(view.repoKey, "repo-c");
  assert.deepEqual([view.status, view.error, view.selection, view.content, view.loading], [null, null, null, null, true]);
  store.dispose();
});

test("repeated file changes: re-reads answered out of order leave only the newest result on screen", async () => {
  const api = fakeApi();
  const store = new WorkspaceStore(api, () => 10_000);
  store.bind("repo", true, false);
  const first = status([entry("a.rs", { unstaged: change() })], { observedAtUnixMs: 1_000 });
  await api.resolveNext("status", ok(first));
  const reads = [];
  const answers = [];
  for (let round = 1; round <= 4; round += 1) {
    store.markChanged();
    reads.push(store.readStatus(true, "hint"));
    answers.push(status([entry("a.rs", { unstaged: { ...change(), additions: round } }), ...Array.from({ length: round - 1 }, (_, index) => entry(`new-${index}.md`, { untracked: true, untrackedSize: 1 }))],
      { observedAtUnixMs: 1_000 + round * 1_000 }));
  }
  const inFlight = api.pending.filter(item => item.kind === "status");
  assert.equal(inFlight.length, 4);
  await api.resolveItem(inFlight[1], ok(answers[1]));
  await api.resolveItem(inFlight[0], ok(answers[0]));
  let view = store.getView();
  assert.equal(view.status, first, "older re-reads do not replace the shown result");
  assert.deepEqual([view.stale, view.loading], [true, true], "the numbers stay marked as out of date until the newest read lands");
  await api.resolveItem(inFlight[3], ok(answers[3]));
  await api.resolveItem(inFlight[2], ok(answers[2]));
  await Promise.all(reads);
  view = store.getView();
  assert.equal(view.status, answers[3]);
  assert.deepEqual([view.stale, view.loading, view.error], [false, false, null]);
  assert.deepEqual(shownPaths(view), ["unstaged:a.rs", "untracked:new-0.md", "untracked:new-1.md", "untracked:new-2.md"]);
  const badge = workspaceIndicatorFor(view);
  assert.deepEqual([badge.state, badge.files, badge.observedAtUnixMs, badge.stale], ["changes", 4, 5_000, false]);
  store.dispose();
});

test("the page says clean only while the latest finished read was clean and has not failed or gone stale", async () => {
  const api = fakeApi();
  const store = new WorkspaceStore(api, () => 10_000);
  store.bind("repo", true, false);
  assert.equal(workspaceIsClean(store.getView()), false, "nothing read yet");
  await api.resolveNext("status", ok(status([])));
  assert.equal(workspaceIsClean(store.getView()), true);

  const focusRead = store.readStatus(true);
  assert.equal(store.getView().loading, true);
  assert.equal(workspaceIsClean(store.getView()), true, "a running re-read (e.g. on focus) keeps the confirmed result instead of flashing");
  assert.equal(workspaceIndicatorFor(store.getView()).state, "loading", "the badge shows the re-read");
  await api.resolveNext("status", fail("GIT_FAILED", "git status failed"));
  await focusRead;
  let view = store.getView();
  assert.equal(view.status.entries.length, 0, "the previous empty result is kept");
  assert.equal(workspaceIndicatorFor(view).state, "error");
  assert.equal(workspaceIsClean(view), false, "a failed re-read after a clean one is not shown as clean");

  const retry = store.readStatus(true);
  assert.equal(workspaceIsClean(store.getView()), false, "still not clean while retrying after the failure");
  await api.resolveNext("status", ok(status([], { observedAtUnixMs: 2_000 })));
  await retry;
  view = store.getView();
  assert.equal(view.error, null);
  assert.equal(workspaceIsClean(view), true, "a successful re-read confirms it again");
  store.markChanged();
  assert.equal(workspaceIsClean(store.getView()), false, "a change hint makes it unconfirmed");
  assert.equal(workspaceIsClean({ ...view, status: status([], { complete: false, totalPaths: 2001 }) }), false, "an incomplete read is never clean");
  store.dispose();
});

test("a workspace file over the whole-file limit falls back to the changes-only diff", async () => {
  const api = fakeApi();
  const store = new WorkspaceStore(api, () => 10_000, () => true);
  store.bind("repo", true, false);
  await api.resolveNext("status", ok(status([entry("big.rs", { unstaged: change() })])));
  const full = await api.resolveNext("diff", fail("RESOURCE_LIMIT", "内容超出读取上限"));
  assert.deepEqual(full.params, { side: "unstaged", pathHex: hex("big.rs"), oldPathHex: null, fullFile: true });
  assert.equal(store.getView().content.state, "loading", "the limit is not shown as an error");
  const diff = { side: "unstaged", path: path("big.rs"), oldPath: null, kind: "text", patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, textLossy: false, oldSize: 1, newSize: 1 };
  const fallback = await api.resolveNext("diff", ok(diff));
  assert.deepEqual(fallback.params, { side: "unstaged", pathHex: hex("big.rs"), oldPathHex: null }, "read again without fullFile");
  const content = store.getView().content;
  assert.deepEqual([content.state, content.error, content.diff], ["ready", null, diff]);
  assert.equal(content.fullFileLimited, true, "the page is told the file is over the whole-file limit");
  store.dispose();
});
