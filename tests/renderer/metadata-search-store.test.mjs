import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { DEFAULT_SEARCH_QUERY, MetadataSearchStore } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "metadata-search-store.mjs")));

const ok = value => ({ ok: true, value });
const commit = oid => ({ oid, parents: [], summary: `commit ${oid}`, summaryTruncated: false, textLossy: false,
  author: { name: "A", email: "a@example.invalid", timestamp: "2", offset: "+0000" },
  committer: { name: "C", email: "c@example.invalid", timestamp: "1", offset: "+0000" } });
const page = ({ version, commits, complete = false, offset = 0, previousCursor = null, nextCursor = null, pathMatches = [] }) => ({
  queryKey: "query-key", snapshotKey: "snapshot-key", resultVersion: version, commits,
  pathMatches,
  pageOffset: offset, previousCursor, nextCursor, matchedCount: commits.length,
  coverage: { processed: 10, complete }, anchorFound: null,
  index: { snapshotKey: "snapshot-key", state: "running", coverage: { processed: 10, complete: false }, diskBytes: 1, quotaBytes: 100, error: null },
});

test("a newer partial version of the same query preserves the selected commit and viewport anchor", async () => {
  const responses = [
    ok(page({ version: "v1", commits: [commit("a"), commit("b")], nextCursor: "next" })),
    ok(page({ version: "v2", commits: [commit("c"), commit("a")], nextCursor: "next2" })),
  ];
  const store = new MetadataSearchStore({
    searchCommits: async () => responses.shift(), listSearchIdentities: async () => ok({ identities: [], truncated: false, coverage: { processed: 0, complete: true } }),
    cancelSearch: async () => ok({ cancelled: true }),
  });
  const query = { ...DEFAULT_SEARCH_QUERY, message: "fix" };
  store.updateQuery(query);
  await new Promise(resolve => setTimeout(resolve, 275));
  assert.equal(store.getView().window.resultVersion, "v1");
  store.setSelectedOid("b");
  store.setHistoryAnchor({ oid: "b", offset: -13 });

  await store.refreshPartial();
  const view = store.getView();
  assert.equal(view.window.resultVersion, "v2");
  assert.equal(view.selectedOid, "b");
  assert.equal(view.oldSelectedCommit.oid, "b");
  assert.deepEqual([view.anchorOid, view.anchorOffset], ["b", -13]);
});

test("changing query clears old results and detail selection before the new response arrives", () => {
  const store = new MetadataSearchStore({
    searchCommits: async () => new Promise(() => {}), listSearchIdentities: async () => new Promise(() => {}),
    cancelSearch: async () => ok({ cancelled: true }),
  });
  store.setSelectedOid("old-query-commit");
  store.updateQuery({ ...DEFAULT_SEARCH_QUERY, message: "new query" });
  const view = store.getView();
  assert.equal(view.window, null);
  assert.equal(view.selectedOid, undefined);
  assert.equal(view.oldSelectedCommit, null);
  assert.equal(view.loading, false);
});

test("history location releases search rows and resumes by the saved query and anchor", async () => {
  const requests = [];
  let calls = 0;
  const store = new MetadataSearchStore({
    searchCommits: async params => {
      requests.push(params);
      calls += 1;
      return ok(page({ version: `v${calls}`, commits: [commit("a"), commit("b")], nextCursor: `next-${calls}`,
        pathMatches: params.query.path ? [{ oid: "a", parentIndices: [0] }, { oid: "b", parentIndices: [null] }] : [] }));
    },
    listSearchIdentities: async () => ok({ identities: [], truncated: false, coverage: { processed: 0, complete: true } }),
    cancelSearch: async () => ok({ cancelled: true }),
  });
  store.bindSession("repo:generation", true);
  const query = { ...DEFAULT_SEARCH_QUERY, message: "fix", oidPrefix: "abc", path: { rawHex: "7372632f612e7473", kind: "file", includeDescendants: false } };
  store.updateQuery(query);
  await new Promise(resolve => setTimeout(resolve, 275));
  store.setSelectedOid("b");
  store.setHistoryAnchor({ oid: "a", offset: -12 });

  const point = await store.suspendForHistoryLocation("repo:generation");
  assert.equal(store.getView().active, false);
  assert.equal(store.getView().window, null);
  assert.equal(point.query, query);
  assert.equal(point.matchedCount, 2);
  assert.deepEqual(point.anchor, { oid: "a", offset: -12 });

  assert.equal(await store.resumeAfterHistoryLocation("repo:generation"), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.at(-1), { query, cursor: null, anchorOid: "a", pageSize: 200 });
  assert.equal(store.getView().selectedOid, "b");
  assert.deepEqual([store.getView().anchorOid, store.getView().anchorOffset], ["a", -12]);
  assert.equal(store.getView().window.commits[0].oid, "a");
  assert.deepEqual(store.getView().window.pathMatches, { a: [0], b: [null] });
  assert.equal(store.getLocationReturn(), null);
});

test("path suggestions keep pending responses from a replaced repository session", async () => {
  let resolvePaths;
  const store = new MetadataSearchStore({
    searchCommits: async () => new Promise(() => {}),
    listSearchIdentities: async () => ok({ identities: [], truncated: false, coverage: { processed: 0, complete: true } }),
    listSearchPaths: async () => new Promise(resolve => { resolvePaths = resolve; }),
    cancelSearch: async () => ok({ cancelled: true }),
  });
  store.bindSession("repo:old", false);
  const pending = store.loadPaths(" src ");
  await new Promise(resolve => setImmediate(resolve));
  store.bindSession("repo:new", false);
  resolvePaths(ok({ entries: [{ kind: "file", path: { display: " src ", rawHex: "2073726320", textLossy: false } }], truncated: false }));
  await pending;
  assert.equal(store.getView().pathSuggestions.loading, false);
  assert.deepEqual(store.getView().pathSuggestions.entries, []);
});

test("path suggestions preserve the repository's raw path identity", async () => {
  const path = { display: "src/名字.ts", rawHex: "7372632fe5908de5ad972e7473", textLossy: false };
  const store = new MetadataSearchStore({
    searchCommits: async () => ok(page({ version: "v1", commits: [] })),
    listSearchIdentities: async () => ok({ identities: [], truncated: false, coverage: { processed: 0, complete: true } }),
    listSearchPaths: async params => {
      assert.deepEqual(params, { text: "src/", limit: 100 });
      return ok({ entries: [{ kind: "file", path }], truncated: false });
    },
    cancelSearch: async () => ok({ cancelled: true }),
  });
  await store.loadPaths("src/");
  assert.equal(store.getView().pathSuggestions.entries[0].path.rawHex, path.rawHex);
  assert.equal(store.getView().pathSuggestions.entries[0].path.display, path.display);
});

test("search paging slides a bounded 1,800-row window in both directions without losing selection", async () => {
  const pageSize = 200;
  const pageAt = offset => ({
    queryKey: "query-key", snapshotKey: "snapshot-key", resultVersion: "v1",
    commits: Array.from({ length: pageSize }, (_, index) => commit(`oid-${String(offset + index).padStart(4, "0")}`)),
    pageOffset: offset, previousCursor: offset > 0 ? `at-${offset - pageSize}` : null,
    nextCursor: offset < 2_800 ? `at-${offset + pageSize}` : null,
    matchedCount: 3_000, coverage: { processed: 3_000, complete: false }, anchorFound: null,
    index: { snapshotKey: "snapshot-key", state: "running", coverage: { processed: 3_000, complete: false }, diskBytes: 1, quotaBytes: 100, error: null },
  });
  const api = {
    async searchCommits({ cursor }) {
      const offset = cursor ? Number(cursor.slice(3)) : 0;
      return ok(pageAt(offset));
    },
    async listSearchIdentities() { return ok({ identities: [], truncated: false, coverage: { processed: 0, complete: true } }); },
    async cancelSearch() { return ok({ cancelled: true }); },
  };
  const store = new MetadataSearchStore(api);
  store.updateQuery({ ...DEFAULT_SEARCH_QUERY, message: "needle" });
  await new Promise(resolve => setTimeout(resolve, 275));
  store.setSelectedOid("oid-0000");
  store.setHistoryAnchor({ oid: "oid-0000", offset: -7 });

  for (let index = 0; index < 9; index += 1) await store.loadNext();
  let view = store.getView();
  assert.equal(view.window.commits.length, 1_800);
  assert.equal(view.window.pageOffset, 200);
  assert.equal(view.oldSelectedCommit.oid, "oid-0000");
  assert.equal(view.anchorOid, view.window.commits[0].oid);

  await store.loadPrevious();
  view = store.getView();
  assert.equal(view.window.commits.length, 1_800);
  assert.equal(view.window.pageOffset, 0);
  assert.equal(view.window.commits[0].oid, "oid-0000");
  assert.equal(view.selectedOid, "oid-0000");
  assert.equal(view.oldSelectedCommit, null);
});

test("canceling hidden search clears a pending debounce and prevents a late request", async () => {
  let calls = 0;
  const store = new MetadataSearchStore({
    searchCommits: async () => { calls += 1; return ok(page({ version: "v1", commits: [commit("a")] })); },
    listSearchIdentities: async () => ok({ identities: [], truncated: false, coverage: { processed: 0, complete: true } }),
    cancelSearch: async () => ok({ cancelled: true }),
  });
  store.updateQuery({ ...DEFAULT_SEARCH_QUERY, message: "pending" });
  await store.cancelPending();
  await new Promise(resolve => setTimeout(resolve, 275));
  assert.equal(calls, 0);
});

test("IME composition suppresses partial refresh until composition ends", async () => {
  let calls = 0;
  const store = new MetadataSearchStore({
    searchCommits: async () => { calls += 1; return ok(page({ version: `v${calls}`, commits: [commit("a")] })); },
    listSearchIdentities: async () => ok({ identities: [], truncated: false, coverage: { processed: 0, complete: true } }),
    cancelSearch: async () => ok({ cancelled: true }),
  });
  store.updateQuery({ ...DEFAULT_SEARCH_QUERY, message: "partial" });
  await new Promise(resolve => setTimeout(resolve, 275));
  assert.equal(calls, 1);
  store.beginComposition();
  store.updateQuery({ ...DEFAULT_SEARCH_QUERY, message: "partial中文" }, true);
  await store.refreshPartial();
  await new Promise(resolve => setTimeout(resolve, 275));
  assert.equal(calls, 1);
  store.finishComposition();
  await new Promise(resolve => setTimeout(resolve, 275));
  assert.equal(calls, 2);
});

test("identity suggestions supersede an in-flight page without persisting CANCELLED and the query can resume", async () => {
  let resolveFirst;
  let searchCalls = 0;
  const store = new MetadataSearchStore({
    searchCommits: async () => {
      searchCalls += 1;
      if (searchCalls === 1) return new Promise(resolve => { resolveFirst = resolve; });
      return ok(page({ version: "v2", commits: [commit("resumed")] }));
    },
    listSearchIdentities: async () => ok({ field: "author", identities: [{ name: "A", email: "a@example.invalid" }], truncated: false,
      coverage: { processed: 1, complete: true }, index: page({ version: "v1", commits: [commit("a")] }).index }),
    cancelSearch: async () => ok({ cancelled: true }),
  });
  store.updateQuery({ ...DEFAULT_SEARCH_QUERY, message: "needle" });
  await new Promise(resolve => setTimeout(resolve, 275));
  assert.equal(searchCalls, 1);
  await store.loadIdentities("author", "A");
  resolveFirst({ ok: false, error: { code: "CANCELLED", message: "superseded", retryable: true } });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(store.getView().error, null);
  assert.equal(store.getView().loading, false);
  assert.equal(searchCalls, 2);
  assert.equal(store.getView().window.commits[0].oid, "resumed");
  assert.equal(store.getView().error, null);
});

test("a search that comes due while identity suggestions load waits for them instead of dropping them", async () => {
  let searchCalls = 0;
  let answerIdentities;
  const store = new MetadataSearchStore({
    searchCommits: async () => {
      searchCalls += 1;
      return ok(page({ version: "v1", commits: [commit("a")], complete: true }));
    },
    listSearchIdentities: () => new Promise(resolve => { answerIdentities = resolve; }),
    cancelSearch: async () => ok({ cancelled: true }),
  });
  // Choosing an Author schedules a search; typing a Committer name right after asks for suggestions.
  store.updateQuery({ ...DEFAULT_SEARCH_QUERY, message: "needle" });
  const loading = store.loadIdentities("committer", "Committer");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(searchCalls, 0, "the due search waits for the suggestions");
  assert.equal(store.getView().committerIdentities.loading, true, "the picker keeps showing that suggestions are loading");

  answerIdentities(ok({ field: "committer", identities: [{ name: "Xavier Committer", email: "x@example.invalid" }], truncated: false,
    coverage: { processed: 1, complete: true } }));
  await loading;
  const names = () => store.getView().committerIdentities.values.map(identity => identity.name);
  assert.deepEqual(names(), ["Xavier Committer"]);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(searchCalls, 1, "the search runs once the suggestions are in");
  assert.equal(store.getView().window.commits[0].oid, "a");
  assert.deepEqual(names(), ["Xavier Committer"], "the search keeps the suggestions");
});

test("a search interrupted by suggestions resumes even when a newer suggestion request replaces the first", async () => {
  let searchCalls = 0;
  const store = new MetadataSearchStore({
    searchCommits: async () => {
      searchCalls += 1;
      if (searchCalls === 1) return new Promise(() => {});
      return ok(page({ version: "v2", commits: [commit("resumed")], complete: true }));
    },
    listSearchIdentities: async params => ok({ field: params.field, identities: [{ name: params.text, email: "a@example.invalid" }], truncated: false,
      coverage: { processed: 1, complete: true } }),
    cancelSearch: async () => ok({ cancelled: true }),
  });
  store.updateQuery({ ...DEFAULT_SEARCH_QUERY, message: "needle" });
  await new Promise(resolve => setTimeout(resolve, 275));
  assert.equal(searchCalls, 1);
  await Promise.all([store.loadIdentities("author", "A"), store.loadIdentities("author", "Al")]);
  assert.deepEqual(store.getView().authorIdentities.values.map(identity => identity.name), ["Al"]);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(searchCalls, 2, "the interrupted search runs again");
  assert.equal(store.getView().window.commits[0].oid, "resumed");
});

test("a new query during leave keeps the saved deep-history return point", async () => {
  let resolveCancel;
  const point = { cursor: "deep-history-cursor", selectedOid: "history-oid", selectedCommit: null,
    anchor: { oid: "history-anchor", offset: -9 } };
  const store = new MetadataSearchStore({
    searchCommits: async () => new Promise(() => {}),
    listSearchIdentities: async () => ok({ identities: [], truncated: false, coverage: { processed: 0, complete: true } }),
    cancelSearch: async () => new Promise(resolve => { resolveCancel = resolve; }),
  });
  store.setHistoryReturn(point);
  store.updateQuery({ ...DEFAULT_SEARCH_QUERY, message: "old query" });
  await new Promise(resolve => setTimeout(resolve, 275));
  const leaving = store.leave();
  store.updateQuery({ ...DEFAULT_SEARCH_QUERY, message: "new query" });
  assert.equal(store.getHistoryReturn(), point);
  resolveCancel(ok({ cancelled: true }));
  await leaving;
  assert.equal(store.getView().active, true);
  assert.equal(store.getView().query.message, "new query");
  assert.equal(store.getHistoryReturn(), point);
});
