import assert from "node:assert/strict";
import test from "node:test";
import { loadBuilt, waitFor } from "./test-utils.mjs";

const { RepositorySessionController } = await loadBuilt("repository-session-controller");
const NULL_CONTEXT = { repoId: null, generation: null };

function makeSession(path, suffix) {
  const oid = suffix.repeat(40);
  return {
    repoId: `repo-${suffix}`,
    generation: `generation-${suffix}`,
    repositoryKey: `key-${suffix}`,
    worktreeId: `worktree-${suffix}`,
    scope: "head",
    tips: [oid],
    observedAtUnixMs: 100,
    repository: {
      path,
      gitDir: `${path}/.git`,
      commonDir: `${path}/.git`,
      worktreePath: null,
      isBare: false,
      isShallow: false,
      objectFormat: "sha1",
      headOid: oid,
      headReference: "refs/heads/main",
    },
    previousView: null,
    persistence: { recent: "disabled", lastSeen: "disabled" },
  };
}

function makeCore() {
  const listeners = new Set();
  const requests = [];
  return {
    status: {
      state: "ready",
      revision: 1,
      core: {
        capabilities: ["repositorySessions", "repositoryScopes", "historyPagination", "historyNewSinceLastSeen", "historyGraph", "metadataIndex", "metadataSearch", "commitDetails"],
      },
    },
    currentContext: NULL_CONTEXT,
    getStatus() { return this.status; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    switchCurrentContext(context) { this.currentContext = { ...context }; },
    observeLatestContext(context) { this.latestContext = { ...context }; },
    request(method, params, context, options = {}) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      promise.catch(() => undefined);
      const request = { method, params, context, options, resolve, reject };
      requests.push(request);
      return promise;
    },
    requests,
  };
}

function deliver(request, data, {
  done = true,
  sequence = 0,
  processed = 1,
  nextCursor = null,
} = {}) {
  request.options.onChunk?.({
    data,
    done,
    sequence,
    repoId: request.context.repoId,
    generation: request.context.generation,
    coverage: { complete: done, processed },
    nextCursor,
  });
  if (done) request.resolve({ coverage: { complete: true, processed }, nextCursor });
}

function searchParams(overrides = {}) {
  return {
    anchorOid: null,
    cursor: null,
    pageSize: 2,
    query: {
      authors: [],
      caseSensitive: false,
      committers: [],
      fromTimestamp: null,
      message: "",
      oidPrefix: "",
      timeField: "committer",
      timeZone: "UTC",
      toTimestamp: null,
    },
    ...overrides,
  };
}

function commit(oid) {
  return {
    oid,
    parents: [],
    summary: `summary ${oid}`,
    summaryTruncated: false,
    textLossy: false,
    author: { name: "Author", email: "author@example.test", timestamp: "1", offset: "+0000" },
    committer: { name: "Committer", email: "committer@example.test", timestamp: "2", offset: "+0000" },
  };
}

function indexStatus(state = "queued") {
  const complete = state === "complete";
  return {
    snapshotKey: "snapshot-a",
    state,
    coverage: { processed: complete ? 3 : 0, complete },
    diskBytes: 0,
    quotaBytes: 1024,
    error: null,
  };
}

function page(session, commits, overrides = {}) {
  return {
    queryKey: "query-key",
    snapshotKey: "snapshot-a",
    resultVersion: "result-version",
    commits,
    pageOffset: 0,
    previousCursor: null,
    nextCursor: "next-cursor",
    matchedCount: 3,
    coverage: { processed: 3, complete: true },
    anchorFound: null,
    index: indexStatus("queued"),
    ...overrides,
  };
}

async function openController(controller, core, opened = makeSession("/tmp/repo-a", "a")) {
  const opening = controller.open(opened.repository.path);
  const request = await waitFor(() => core.requests[0]);
  assert.equal(request.method, "openRepository");
  deliver(request, { section: "repositorySession", session: opened });
  assert.deepEqual(await opening, opened);
  return opened;
}

test("search chunks merge under stable page metadata with cumulative coverage and terminal cursor", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opened = await openController(controller, core);
  const searching = controller.searchCommits(searchParams());
  const request = await waitFor(() => core.requests[1]);
  assert.equal(request.method, "searchCommits");

  const commits = [commit("a".repeat(40)), commit("b".repeat(40))];
  const metadata = page(opened, []);
  deliver(request, { section: "searchPage", page: { ...metadata, commits: [commits[0]] } }, {
    done: false, sequence: 0, processed: 1, nextCursor: null,
  });
  deliver(request, { section: "searchPage", page: { ...metadata, commits: [commits[1]] } }, {
    done: true, sequence: 1, processed: 2, nextCursor: metadata.nextCursor,
  });

  const result = await searching;
  assert.deepEqual(result.commits, commits);
  assert.equal(result.nextCursor, metadata.nextCursor);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.index.state, "queued");
  assert.equal(result.index.coverage.complete, false);
  controller.dispose();
});

test("search rejects a chunk whose page metadata changes mid-response", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  await openController(controller, core);
  const searching = controller.searchCommits(searchParams());
  const rejected = assert.rejects(searching, error => error.code === "PROTOCOL_ERROR");
  const request = await waitFor(() => core.requests[1]);
  const first = page(undefined, [commit("a".repeat(40))]);
  deliver(request, { section: "searchPage", page: first }, { done: false, processed: 1 });
  const corrupt = { ...first, resultVersion: "different-version", commits: [commit("b".repeat(40))] };
  let thrown;
  try {
    deliver(request, { section: "searchPage", page: corrupt }, { done: true, processed: 2 });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, "PROTOCOL_ERROR");
  request.reject(thrown);
  await rejected;
  controller.dispose();
});

test("a replacement query waits for abort drain and a late old result cannot replace it", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  await openController(controller, core);
  const oldSearch = controller.searchCommits(searchParams({ query: { ...searchParams().query, message: "old" } }));
  const oldRequest = await waitFor(() => core.requests[1]);
  const oldRejected = assert.rejects(oldSearch, error => error.code === "CANCELLED");

  const latestSearch = controller.searchCommits(searchParams({ query: { ...searchParams().query, message: "latest" } }));
  assert.equal(oldRequest.options.signal.aborted, true);
  assert.equal(core.requests.length, 2, "the next search starts only after the prior request drains");
  oldRequest.reject(Object.assign(new Error("cancelled and drained"), { code: "CANCELLED" }));
  await oldRejected;
  const latestRequest = await waitFor(() => core.requests[2]);

  // A transport must drain late frames without delivering them to the superseded search callback.
  const staleDeliveryCount = { value: 0 };
  const staleCallback = oldRequest.options.onChunk;
  oldRequest.options.onChunk = chunk => { staleDeliveryCount.value += 1; staleCallback?.(chunk); };
  oldRequest.options.onChunk({ data: { section: "searchPage", page: page(undefined, [commit("c".repeat(40))]) },
    done: true, sequence: 1, coverage: { complete: true, processed: 1 }, nextCursor: "stale" });
  assert.equal(staleDeliveryCount.value, 1);

  const latestPage = page(undefined, [commit("d".repeat(40))], { nextCursor: null, matchedCount: 1 });
  deliver(latestRequest, { section: "searchPage", page: latestPage }, {
    done: true, processed: 1, nextCursor: null,
  });
  assert.equal((await latestSearch).commits[0].oid, "d".repeat(40));
  controller.dispose();
});

test("scope and session transitions cancel and drain search before issuing the transition", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opened = await openController(controller, core);
  const searching = controller.searchCommits(searchParams());
  const request = await waitFor(() => core.requests[1]);
  const rejected = assert.rejects(searching, error => error.code === "CANCELLED");

  const switching = controller.selectScope({ ref: "refs/heads/dev" }, 20);
  assert.equal(request.options.signal.aborted, true);
  assert.equal(core.requests.length, 2);
  request.reject(Object.assign(new Error("cancelled and drained"), { code: "CANCELLED" }));
  await rejected;
  const scopeRequest = await waitFor(() => core.requests[2]);
  assert.equal(scopeRequest.method, "selectRepositoryScope");
  const next = { ...opened, repoId: "repo-next", generation: "generation-next", scope: { ref: "refs/heads/dev" } };
  scopeRequest.options.onChunk?.({ data: { section: "repositorySession", session: next }, done: false, sequence: 0,
    coverage: { complete: false, processed: 0 }, nextCursor: null });
  scopeRequest.options.onChunk?.({ data: { section: "repository", repository: next.repository, refs: [], refsTruncated: false },
    done: false, sequence: 1, coverage: { complete: false, processed: 0 }, nextCursor: null });
  scopeRequest.options.onChunk?.({ data: { section: "historyPage", commits: [], offset: 0, pageSize: 20, cursor: "scope-cursor",
    previousCursor: null, nextCursor: null, hasMore: false, newSinceLastSeenStatus: "firstView", lastSeenDividerOid: null },
  done: true, sequence: 2, coverage: { complete: true, processed: 0 }, nextCursor: null });
  scopeRequest.resolve({ coverage: { complete: true, processed: 0 }, nextCursor: null });
  await switching;
  assert.deepEqual(core.currentContext, { repoId: next.repoId, generation: next.generation });

  const sessionSearch = controller.searchCommits(searchParams());
  const sessionRequest = await waitFor(() => core.requests[3]);
  const sessionRejected = assert.rejects(sessionSearch, error => error.code === "CANCELLED");
  const opening = controller.open("/tmp/repo-b");
  assert.equal(sessionRequest.options.signal.aborted, true);
  assert.equal(core.requests.length, 4);
  sessionRequest.reject(Object.assign(new Error("cancelled and drained"), { code: "CANCELLED" }));
  await sessionRejected;
  const openRequest = await waitFor(() => core.requests[4]);
  const reopened = makeSession("/tmp/repo-b", "b");
  deliver(openRequest, { section: "repositorySession", session: reopened });
  await opening;
  assert.deepEqual(core.currentContext, { repoId: reopened.repoId, generation: reopened.generation });
  controller.dispose();
});

test("index rebuild cancels and drains search before control; queued index status is independent", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  await openController(controller, core);
  const searching = controller.searchCommits(searchParams());
  const searchRequest = await waitFor(() => core.requests[1]);
  const rejected = assert.rejects(searching, error => error.code === "CANCELLED");

  const rebuilding = controller.controlMetadataIndex("rebuild");
  assert.equal(searchRequest.options.signal.aborted, true);
  assert.equal(core.requests.length, 2);
  searchRequest.reject(Object.assign(new Error("cancelled and drained"), { code: "CANCELLED" }));
  await rejected;
  const rebuildRequest = await waitFor(() => core.requests[2]);
  assert.equal(rebuildRequest.method, "controlMetadataIndex");
  deliver(rebuildRequest, { section: "metadataIndex", status: indexStatus("queued") });
  assert.equal((await rebuilding).state, "queued");
  controller.dispose();
});

test("search IPC rejects extra fields, mixed cursor and anchor, invalid OIDs, dates, and oversized bytes", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const invalid = [
    searchParams({ unexpected: true }),
    searchParams({ cursor: "cursor", anchorOid: "a".repeat(40) }),
    searchParams({ anchorOid: "zzzz" }),
    searchParams({ cursor: "c".repeat(1025) }),
    searchParams({ query: { ...searchParams().query, fromTimestamp: 20, toTimestamp: 10 } }),
    searchParams({ query: { ...searchParams().query, message: "é".repeat(2049) } }),
  ];
  for (const params of invalid) {
    await assert.rejects(controller.searchCommits(params), error => error.code === "INVALID_REQUEST");
  }
  assert.equal(core.requests.length, 0);

  const opened = await openController(controller, core);
  const shortAnchor = controller.searchCommits(searchParams({ anchorOid: "abcd" }));
  const shortAnchorResult = shortAnchor.then(
    value => ({ value }),
    error => ({ error }),
  );
  await Promise.resolve();
  if (core.requests.length > 1) {
    const request = core.requests[1];
    const draining = controller.cancelSearch();
    request.reject(Object.assign(new Error("cancelled and drained"), { code: "CANCELLED" }));
    await draining;
  }
  const outcome = await shortAnchorResult;
  assert.equal(outcome.error?.code, "INVALID_REQUEST", `short anchor was sent from ${opened.repository.objectFormat}`);
  assert.equal(core.requests.length, 1);
  controller.dispose();
});
