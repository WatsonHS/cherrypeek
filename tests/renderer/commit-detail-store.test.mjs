import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { CommitDetailStore } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "commit-detail-store.mjs")));

const ok = value => ({ ok: true, value });
const err = code => ({ ok: false, error: { code, message: code, retryable: false } });
const commit = (oid, parents = []) => ({ oid, parents, summary: `commit ${oid}`, summaryTruncated: false, textLossy: false,
  author: { name: "Author", email: "author@example.invalid", timestamp: "2", offset: "+0000" },
  committer: { name: "Committer", email: "committer@example.invalid", timestamp: "1", offset: "+0000" } });
const details = (oid = "a", parents = ["p0", "p1"]) => ({ commit: commit(oid, parents), message: "title\nbody\n\nReviewed-by: A",
  messageWithoutTrailers: "title\nbody", trailers: [{ key: "Reviewed-by", value: "A" }], refs: [], worktrees: [],
  observedAtUnixMs: 1, refsTruncated: false, worktreesTruncated: false,
  update: { state: "unaffected", reason: null, checkedAtUnixMs: 2 } });
const files = (oid = "a", parentIndex = 0, offset = 0) => ({ oid, parentIndex, parentOid: "parent", offset, pageSize: 200,
  totalFiles: 1, hasMore: false, files: [], overview: { totalFiles: 1, counts: { added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, typeChanged: 0 },
    additions: 1, deletions: 0, binaryFiles: 0, gitlinkFiles: 0, directories: [] } });
const merge = (oid = "a", parentIndex = 1, offset = 0) => ({ oid, parentIndex, parentOid: "p1", firstParentOid: "p0", offset,
  pageSize: 200, totalCommits: 1, hasMore: false, commits: [], authors: [] });
const changedFile = path => ({ status: "modified", oldPath: { display: path, rawHex: Buffer.from(path).toString("hex"), textLossy: false },
  newPath: { display: path, rawHex: Buffer.from(path).toString("hex"), textLossy: false }, oldOid: "1", newOid: "2", oldMode: "100644", newMode: "100644",
  similarity: null, additions: 1, deletions: 0, binary: false, gitlink: false });
const diffFor = (file, patch) => ({ oid: "a", parentIndex: 0, parentOid: "p0", file, kind: "text", patch,
  truncated: false, textLossy: false, oldSize: 1, newSize: 2 });

function deferredApi() {
  const calls = [];
  let active;
  const api = {
    getCommit(params) { return request("getCommit", params); },
    listChangedFiles(params) { return request("listChangedFiles", params); },
    readMergeCommits(params) { return request("readMergeCommits", params); },
    branchesContaining(params) { return request("branchesContaining", params); },
    readDiff(params) { return request("readDiff", params); },
    async cancelCommitDetails() {
      if (active) { const pending = active; active = undefined; pending.resolve(err("CANCELLED")); pending.resolve = null; }
      return ok({ cancelled: true });
    },
  };
  function request(name, params) {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const call = { name, params, resolve };
    calls.push(call);
    active = call;
    return promise;
  }
  async function reply(name, result) {
    await settled();
    const call = calls.find(item => item.name === name && item.resolve);
    assert.ok(call, `expected pending ${name}`);
    const resolve = call.resolve;
    call.resolve = null;
    if (active === call) active = undefined;
    resolve(result);
    await settled();
  }
  return {
    api, calls,
    async answer(name, value) {
      await reply(name, ok(value));
    },
    async answerResult(name, result) {
      await reply(name, result);
    },
  };
}

async function settled() {
  for (let index = 0; index < 12; index += 1) await new Promise(resolve => setImmediate(resolve));
}

async function waitForCall(api, predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const call = api.calls.find(predicate);
    if (call) return call;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for the expected detail request");
}

async function loadDefault(api, oid = "a") {
  const store = new CommitDetailStore(api.api);
  store.bind("repo:g1:head", oid, true);
  await api.answer("getCommit", details(oid));
  assert.equal(api.calls.at(-1).name, "listChangedFiles");
  await api.answer("listChangedFiles", files(oid));
  assert.equal(api.calls.at(-1).name, "readMergeCommits");
  assert.equal(api.calls.at(-1).params.parentIndex, 1);
  await api.answer("readMergeCommits", merge(oid));
  return store;
}

test("selection loads details, one file page, and default non-first merge page; containing is explicit", async () => {
  const api = deferredApi();
  const store = new CommitDetailStore(api.api);
  store.bind("repo:g1:head", "a", true);
  await api.answer("getCommit", details());
  assert.equal(api.calls.at(-1).name, "listChangedFiles");
  assert.deepEqual(api.calls.at(-1).params, { oid: "a", parentIndex: 0, offset: 0, pageSize: 200 });
  await api.answer("listChangedFiles", files());
  assert.equal(api.calls.at(-1).name, "readMergeCommits");
  assert.equal(api.calls.at(-1).params.parentIndex, 1);
  await api.answer("readMergeCommits", merge());
  assert.deepEqual(api.calls.map(call => call.name), ["getCommit", "listChangedFiles", "readMergeCommits"]);
  assert.equal(store.getView().detailsSessionKey, "repo:g1:head");
  assert.equal(store.getView().containing.state, "idle");
});

test("a late detail response for A cannot replace the newer selection B", async () => {
  const api = deferredApi();
  const store = new CommitDetailStore(api.api);
  store.bind("repo:g1:head", "a", true);
  await settled();
  const selectionA = api.calls[0];
  store.bind("repo:g1:head", "b", true);
  await settled();
  assert.equal(selectionA.name, "getCommit");
  assert.equal(selectionA.resolve, null);
  assert.equal(store.getView().oid, "b");
  assert.equal(api.calls.at(-1).name, "getCommit");
  assert.deepEqual(api.calls.at(-1).params, { oid: "b" });

  await api.answer("getCommit", details("b", []));
  await api.answer("listChangedFiles", files("b", null));
  assert.equal(store.getView().details.value.commit.oid, "b");
  assert.equal(store.getView().detailsSessionKey, "repo:g1:head");
});

test("a transient BUSY detail request retries automatically while the loading state stays visible", async () => {
  const api = deferredApi();
  const store = new CommitDetailStore(api.api);
  const observedStates = [];
  store.subscribe(() => observedStates.push(store.getView().details.state));
  store.bind("repo:g1:head", "a", true);
  await waitForCall(api, call => call.name === "getCommit");
  await api.answerResult("getCommit", { ok: false, error: { code: "BUSY", message: "BUSY", retryable: true } });

  assert.equal(store.getView().details.state, "loading");
  assert.equal(store.getView().details.error, null);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(store.getView().details.state, "loading", "the backoff must not turn a temporary BUSY into an error state");
  const retry = await waitForCall(api, call => call.name === "getCommit" && api.calls.indexOf(call) > 0);
  assert.deepEqual(retry.params, { oid: "a" });
  await api.answer("getCommit", details("a", []));
  assert.equal(store.getView().details.state, "ready");
  assert.equal(store.getView().details.error, null);
  assert.ok(observedStates.includes("loading"));

  await api.answer("listChangedFiles", files("a", null));
});

test("selecting B during A's BUSY backoff starts B and prevents another A attempt", async () => {
  const api = deferredApi();
  const store = new CommitDetailStore(api.api);
  store.bind("repo:g1:head", "a", true);
  const firstA = await waitForCall(api, call => call.name === "getCommit");
  await api.answerResult("getCommit", { ok: false, error: { code: "BUSY", message: "BUSY", retryable: true } });
  assert.equal(store.getView().details.state, "loading");

  store.bind("repo:g1:head", "b", true);
  const requestB = await waitForCall(api, call => call.name === "getCommit" && call.params.oid === "b", 200);
  assert.notEqual(requestB, firstA, "the new selection must not wait through A's retry delay");
  await new Promise(resolve => setTimeout(resolve, 320));
  assert.equal(api.calls.some(call => call.name === "getCommit" && call.params.oid === "a" && call !== firstA), false,
    "A must not retry after selection changes");

  await api.answer("getCommit", details("b", []));
  assert.equal(store.getView().oid, "b");
  assert.equal(store.getView().details.value.commit.oid, "b");
  await api.answer("listChangedFiles", files("b", null));
});

test("an unloaded retained selection preserves every old slice and cannot query it in a new session", async () => {
  const api = deferredApi();
  const store = await loadDefault(api);
  const before = store.getView();
  const callsBefore = api.calls.length;

  store.bind("repo:g2:head", "a", false);
  await settled();
  let view = store.getView();
  assert.equal(view.sessionKey, "repo:g2:head");
  assert.equal(view.detailsSessionKey, "repo:g1:head");
  assert.equal(view.details.value, before.details.value);
  assert.equal(view.files.value, before.files.value);
  assert.equal(view.merge.value, before.merge.value);
  assert.equal(api.calls.length, callsBefore);

  await store.loadFiles(1);
  await store.loadMerge(1);
  await store.loadContaining();
  await store.refreshUpdate();
  assert.equal(api.calls.length, callsBefore);
});

test("a retained selection present in the new loaded window reloads under the new context", async () => {
  const api = deferredApi();
  const store = await loadDefault(api);
  store.bind("repo:g2:head", "a", true);
  await api.answer("getCommit", details());
  assert.equal(store.getView().detailsSessionKey, "repo:g2:head");
  await api.answer("listChangedFiles", files());
  await api.answer("readMergeCommits", merge());
  assert.equal(store.getView().detailsSessionKey, "repo:g2:head");
});

test("a retained old selection is reloaded when paging makes that OID part of the new window", async () => {
  const api = deferredApi();
  const store = await loadDefault(api);
  store.bind("repo:g2:head", "a", false);
  await settled();
  assert.equal(store.getView().detailsSessionKey, "repo:g1:head");
  const callsBefore = api.calls.length;

  store.bind("repo:g2:head", "a", true);
  await settled();
  assert.equal(api.calls.length, callsBefore + 1);
  assert.equal(api.calls.at(-1).name, "getCommit");
  await api.answer("getCommit", details());
  await api.answer("listChangedFiles", files());
  await api.answer("readMergeCommits", merge());
  assert.equal(store.getView().detailsSessionKey, "repo:g2:head");
});

test("a merge action cancels an in-flight file page and preserves its displayed page baseline", async () => {
  const api = deferredApi();
  const store = await loadDefault(api);
  const previousFiles = store.getView().files.value;
  const fileRequest = store.loadFiles(1, 0);
  await settled();
  assert.equal(api.calls.at(-1).name, "listChangedFiles");
  const mergeRequest = store.loadMerge(1, 0);
  await settled();
  assert.equal(api.calls.at(-1).name, "readMergeCommits");
  await api.answer("readMergeCommits", merge("a", 1, 0));
  await Promise.all([fileRequest, mergeRequest]);
  const view = store.getView();
  assert.equal(view.files.value, previousFiles);
  assert.equal(view.files.value.parentIndex, 0);
  assert.equal(view.fileParentIndex, 1);
  assert.equal(view.merge.value.parentIndex, 1);
});

test("focus refresh rechecks only the selected commit and preserves file and merge pages", async () => {
  const api = deferredApi();
  const store = await loadDefault(api);
  const before = store.getView();
  const refresh = store.refreshUpdate();
  await settled();
  assert.equal(api.calls.at(-1).name, "getCommit");
  await api.answer("getCommit", { ...details(), update: { state: "affected", reason: "noLongerReachable", checkedAtUnixMs: 3 } });
  await refresh;
  const after = store.getView();
  assert.equal(after.details.value.update.state, "affected");
  assert.equal(after.files.value, before.files.value);
  assert.equal(after.merge.value, before.merge.value);
  assert.deepEqual(api.calls.map(call => call.name), ["getCommit", "listChangedFiles", "readMergeCommits", "getCommit"]);
});

test("diff loads only on file activation; switching files cancels the old patch and accepts only the latest", async () => {
  const api = deferredApi();
  const store = await loadDefault(api);
  assert.equal(api.calls.some(call => call.name === "readDiff"), false);
  const first = changedFile("first.txt");
  const second = changedFile("second.txt");
  const firstRead = store.toggleDiff(first, 0);
  await settled();
  assert.equal(api.calls.at(-1).name, "readDiff");
  assert.deepEqual(api.calls.at(-1).params, { oid: "a", parentIndex: 0, oldPathHex: first.oldPath.rawHex, newPathHex: first.newPath.rawHex });

  const secondRead = store.toggleDiff(second, 0);
  await settled();
  assert.equal(api.calls.at(-1).name, "readDiff");
  await api.answer("readDiff", diffFor(second, "@@ -1 +1 @@\n-new\n+newer"));
  await Promise.all([firstRead, secondRead]);
  assert.equal(store.getView().diff.value.file.newPath.display, "second.txt");
  assert.equal(store.getView().diff.value.patch.includes("newer"), true);
});

test("changing the file parent clears its patch, while an old-context patch remains readable", async () => {
  const api = deferredApi();
  const store = await loadDefault(api);
  const file = changedFile("scope.txt");
  const loadingDiff = store.toggleDiff(file, 0);
  await settled();
  await api.answer("readDiff", diffFor(file, "@@ -1 +1 @@\n-old\n+new"));
  await loadingDiff;

  const loadingFiles = store.loadFiles(1, 0);
  assert.equal(store.getView().diff.value, null);
  await settled();
  await api.answer("listChangedFiles", files("a", 1));
  await loadingFiles;

  const reloadDiff = store.toggleDiff(file, 1);
  await settled();
  await api.answer("readDiff", { ...diffFor(file, "@@ -1 +1 @@\n-old\n+side"), parentIndex: 1, parentOid: "p1" });
  await reloadDiff;
  const currentDiff = store.getView().diff.value;
  store.bind("repo:g2:head", "a", false);
  await settled();
  assert.equal(store.getView().diff.value, currentDiff);
  const callsBefore = api.calls.length;
  await store.toggleDiff(file, 1);
  assert.equal(api.calls.length, callsBefore);
  assert.equal(store.getView().diff.value, null, "the retained patch can be collapsed without a new-context query");
});
