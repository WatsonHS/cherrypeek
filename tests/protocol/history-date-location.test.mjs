import assert from "node:assert/strict";
import test from "node:test";
import { loadBuilt, waitFor } from "./test-utils.mjs";

const { RepositorySessionController } = await loadBuilt("repository-session-controller");

const NULL_CONTEXT = { repoId: null, generation: null };

function makeSession(path) {
  const oid = "a".repeat(40);
  return {
    repoId: "date-repo",
    generation: "date-generation",
    repositoryKey: "date-key",
    worktreeId: "date-worktree",
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
  const requests = [];
  return {
    status: { state: "ready", revision: 1, core: { capabilities: [
      "repositorySessions", "repositoryScopes", "historyPagination", "historyNewSinceLastSeen", "historyGraph", "metadataIndex", "activityStats", "commitDetails",
    ] } },
    currentContext: NULL_CONTEXT,
    getStatus() { return this.status; },
    subscribe() { return () => {}; },
    observeLatestContext(context) { this.latestContext = { ...context }; },
    switchCurrentContext(context) { this.currentContext = { ...context }; },
    request(method, params, context, options = {}) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      promise.catch(() => {});
      requests.push({ method, params, context, options, resolve, reject });
      return promise;
    },
    requests,
  };
}

function send(request, data, { done = true, sequence = 0, coverage = { complete: true, processed: 1 }, nextCursor = null } = {}) {
  request.options.onChunk?.({
    data,
    done,
    sequence,
    repoId: request.context.repoId,
    generation: request.context.generation,
    coverage,
    nextCursor,
  });
  if (done) request.resolve({ coverage, nextCursor });
}

function makeCommit(oid) {
  return {
    oid,
    parents: [],
    summary: "located commit",
    summaryTruncated: false,
    textLossy: false,
    isNewSinceLastSeen: false,
    graph: { lane: 0, color: 0, parents: [], boundary: false, above: 0, below: 0, hiddenLaneCount: 0, hiddenThroughRanges: [], segments: [] },
    author: { name: "Author", email: "author@example.invalid", timestamp: "10", offset: "+0000" },
    committer: { name: "Committer", email: "committer@example.invalid", timestamp: "20", offset: "+0000" },
  };
}

async function openController() {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opening = controller.open("/tmp/date-location-repo");
  const request = await waitFor(() => core.requests[0]);
  assert.equal(request.method, "openRepository");
  const opened = makeSession("/tmp/date-location-repo");
  send(request, { section: "repositorySession", session: opened });
  await opening;
  return { core, controller, opened };
}

test("date location sends known cursors and handles compact hits and streamed misses", async () => {
  const { core, controller, opened } = await openController();
  try {
    const hitPromise = controller.locateHistoryDate(1_800_000_000, 100, ["cached-cursor"]);
    const hitRequest = await waitFor(() => core.requests[1]);
    assert.equal(hitRequest.method, "locateHistoryDate");
    assert.deepEqual(hitRequest.params, {
      beforeTimestamp: 1_800_000_000,
      pageSize: 100,
      knownCursors: ["cached-cursor"],
    });
    send(hitRequest, {
      section: "historyDateLocation",
      location: { oid: "b".repeat(40), cursor: "cached-cursor", offset: 100, pageSize: 100 },
    }, { coverage: { complete: true, processed: 0 } });
    assert.deepEqual(await hitPromise, {
      oid: "b".repeat(40), cursor: "cached-cursor", offset: 100, pageSize: 100, page: null,
    });

    const missPromise = controller.locateHistoryDate(1_700_000_000, 100);
    const missRequest = await waitFor(() => core.requests[2]);
    assert.deepEqual(missRequest.params, {
      beforeTimestamp: 1_700_000_000,
      pageSize: 100,
      knownCursors: [],
    });
    send(missRequest, {
      section: "historyDateLocation",
      location: { oid: opened.repository.headOid, cursor: "fresh-cursor", offset: 200, pageSize: 100 },
    }, { done: false, sequence: 0, coverage: { complete: false, processed: 0 } });

    const commit = makeCommit(opened.repository.headOid);
    send(missRequest, {
      section: "historyPage",
      commits: [commit],
      offset: 200,
      pageSize: 100,
      cursor: "fresh-cursor",
      previousCursor: "previous-cursor",
      hasMore: false,
      newSinceLastSeenStatus: "ready",
      lastSeenDividerOid: null,
    }, { sequence: 1, coverage: { complete: true, processed: 1 } });

    const located = await missPromise;
    assert.deepEqual(located, {
      oid: opened.repository.headOid,
      cursor: "fresh-cursor",
      offset: 200,
      pageSize: 100,
      page: {
        commits: [commit],
        offset: 200,
        pageSize: 100,
        cursor: "fresh-cursor",
        previousCursor: "previous-cursor",
        hasMore: false,
        newSinceLastSeenStatus: "ready",
        lastSeenDividerOid: null,
        nextCursor: null,
      },
    });
  } finally {
    controller.dispose();
  }
});
