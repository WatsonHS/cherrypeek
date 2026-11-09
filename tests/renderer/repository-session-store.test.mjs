import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { RepositorySessionStore } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "repository-session-store.mjs")));

const METHODS = ["openRepositorySession", "getRepositorySession", "readHistoryPage", "locateCommit", "locateHistoryDate", "recordRepositoryView", "closeRepositorySession", "refreshRepositorySession", "getRepositoryNavigation", "selectRepositoryScope", "getRefMergeStatus", "getMetadataIndexStatus", "controlMetadataIndex"];

/** Session API whose every call waits until the test answers it. */
function fakeApi() {
  const calls = [];
  const pending = Object.fromEntries(METHODS.map(name => [name, []]));
  const api = Object.fromEntries(METHODS.map(name => [name, (...args) => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push({ name, args });
    pending[name].push({ resolve, reject, args });
    return promise;
  }]));
  api.cancelHistoryRead = async () => ok({ cancelled: true });
  api.cancelRefMergeStatus = async () => ok({ cancelled: true });
  return {
    api,
    calls,
    pending,
    queue(name, args = []) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      calls.push({ name, args });
      pending[name].push({ resolve, reject, args });
      return promise;
    },
    names: () => calls.map(call => call.name),
    async answer(name, value) {
      await settled();
      const call = pending[name].shift();
      assert.ok(call, `expected a pending ${name} call`);
      if (name === "readHistoryPage" && call.args[2] === true && value.ok) {
        const { repository, refs, refsTruncated, ...content } = value.value;
        value = ok(content);
      }
      call.resolve(value);
      await settled();
    },
    async fail(name, error) {
      await settled();
      const call = pending[name].shift();
      assert.ok(call, `expected a pending ${name} call`);
      call.reject(error);
      await settled();
    },
  };
}

async function settled() {
  for (let index = 0; index < 10; index += 1) await new Promise(resolve => setImmediate(resolve));
}

const ok = value => ({ ok: true, value });
const err = (code, message = code) => ({ ok: false, error: { code, message, retryable: false } });

function makeSession(id, previousView = null) {
  const path = `/repos/${id}`;
  return {
    repoId: `repo-${id}`,
    generation: `gen-${id}`,
    repositoryKey: `key-${id}`,
    worktreeId: `wt-${id}`,
    scope: "head",
    observedAtUnixMs: 1_700_000_000_000,
    previousView,
    persistence: { recent: "ok", lastSeen: "ok" },
    repository: {
      path, gitDir: `${path}/.git`, commonDir: `${path}/.git`, worktreePath: path, isBare: false, isShallow: false,
      objectFormat: "sha1", headOid: id.padEnd(40, "0"), headReference: "refs/heads/main",
    },
  };
}

function makePreview(session) {
  const oid = session.repository.headOid;
  return {
    repository: session.repository,
    refs: [],
    refsTruncated: false,
    commits: [{
      oid, parents: [], summary: `summary ${session.repoId}`, summaryTruncated: false, textLossy: false, isNewSinceLastSeen: false,
      author: { name: "A", email: "a@example.invalid", timestamp: "1", offset: "+0000" },
      committer: { name: "C", email: "c@example.invalid", timestamp: "2", offset: "+0000" },
    }],
    hasMore: false,
  };
}

function makeHistoryPage(session, { offset = 0, cursor = `cursor-${offset}`, previousCursor = null, nextCursor = null, count = 1, commits, status = "firstView", divider = null } = {}) {
  const preview = makePreview(session);
  const pageCommits = commits ?? (offset === 0 && count === 1 ? preview.commits : Array.from({ length: count }, (_, index) => ({
    ...preview.commits[0],
    oid: `${(offset + index + 1).toString(16).padStart(2, "0")}`.repeat(20),
    summary: `summary ${offset + index + 1}`,
  })));
  return {
    ...preview,
    commits: pageCommits.map(commit => ({ ...commit, graph: commit.graph ?? {
      lane: 0, color: 0, parents: commit.parents, boundary: false, above: 0, below: 0, hiddenLaneCount: 0, hiddenThroughRanges: [], segments: [],
    } })),
    offset,
    pageSize: 200,
    cursor,
    previousCursor,
    nextCursor,
    hasMore: nextCursor !== null,
    newSinceLastSeenStatus: status,
    lastSeenDividerOid: divider,
  };
}

function makeDateLocation(page, oid, includePage = true) {
  const { repository, refs, refsTruncated, ...content } = page;
  return {
    oid,
    cursor: page.cursor,
    offset: page.offset,
    pageSize: page.pageSize,
    page: includePage ? content : null,
  };
}

function makePageCommits(session, start, count) {
  const base = makePreview(session).commits[0];
  return Array.from({ length: count }, (_, index) => ({
    ...base,
    oid: (start + index + 1).toString(16).padStart(40, "0"),
    summary: `summary ${start + index + 1}`,
  }));
}

/** Opens `id` and answers every call so the store ends ready. */
async function openReady(fake, store, id, pageOptions = {}) {
  const session = makeSession(id);
  const done = store.open(`/repos/${id}`);
  if (store.getView().session) await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await fake.answer("openRepositorySession", ok(session));
  await fake.answer("readHistoryPage", ok(makeHistoryPage(session, pageOptions)));
  await done;
  return session;
}

test("a short hash location accepts the canonical commit returned by the core", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const session = await openReady(fake, store, "a");
  const target = { ...makePreview(session).commits[0], oid: "abcd".repeat(10) };
  const locating = store.locateCommit("ABCDABCD");
  await fake.answer("locateCommit", ok(makeHistoryPage(session, { commits: [target] })));
  assert.equal(await locating, true);
  assert.equal(store.getView().commits[0].oid, target.oid);
  assert.equal(store.getView().pageError, null);
});

test("open shows the session once its first page arrives", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });

  const done = store.open("/repos/a");
  assert.equal(store.getView().state, "loading");
  assert.equal(store.getView().opening, "/repos/a");
  assert.equal(store.getView().repository, null);

  const session = makeSession("a");
  await fake.answer("openRepositorySession", ok(session));
  assert.equal(store.getView().state, "loading");
  assert.equal(store.getView().opening, null);
  assert.equal(store.getView().session, session);
  assert.equal(store.getView().repository.path, "/repos/a");

  await fake.answer("readHistoryPage", ok(makeHistoryPage(session)));
  await done;
  const view = store.getView();
  assert.equal(view.state, "ready");
  assert.equal(view.commits.length, 1);
  assert.equal(view.commits[0].summary, "summary repo-a");
  assert.deepEqual(fake.calls[0], { name: "openRepositorySession", args: ["/repos/a"] });
  assert.ok(notifications >= 3);
});

test("cancelling a date location ignores its late page and keeps the current window", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const session = await openReady(fake, store, "locate-cancel");
  const originalCommits = store.getView().commits;
  const target = { ...originalCommits[0], oid: "ab".repeat(20) };
  const locating = store.locateHistoryDate(150);
  await settled();
  assert.equal(fake.pending.locateHistoryDate.length, 1);

  const cancelling = store.cancelPage();
  const page = makeHistoryPage(session, {
    offset: 400, cursor: "cursor-400", previousCursor: "cursor-200", nextCursor: "cursor-600",
    commits: [target],
  });
  await fake.answer("locateHistoryDate", ok(makeDateLocation(page, target.oid)));
  await cancelling;
  assert.equal(await locating, null);
  assert.equal(store.getView().pageLoading, false);
  assert.strictEqual(store.getView().commits, originalCommits);
});

test("a newer open wins; late results from the older open are dropped", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const first = store.open("/repos/a");
  const second = store.open("/repos/b");
  assert.equal(store.getView().opening, "/repos/b");

  // Main answers the superseded open late, after B is already on screen.
  const sessionB = makeSession("b");
  await settled();
  fake.pending.openRepositorySession[1].resolve(ok(sessionB));
  await fake.answer("readHistoryPage", ok(makeHistoryPage(sessionB)));
  await second;
  assert.equal(store.getView().session, sessionB);

  await fake.answer("openRepositorySession", ok(makeSession("a")));
  await first;
  assert.equal(store.getView().session, sessionB);
  assert.equal(store.getView().commits[0].summary, "summary repo-b");
  assert.equal(fake.pending.readHistoryPage.length, 0, "the superseded open must not read its preview");
});

test("a page that arrives after a newer open started does not replace the newer view", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const sessionA = makeSession("a");
  const first = store.open("/repos/a");
  await fake.answer("openRepositorySession", ok(sessionA));
  assert.equal(fake.pending.readHistoryPage.length, 1);

  const second = store.open("/repos/b");
  await fake.answer("readHistoryPage", ok(makeHistoryPage(sessionA)));
  await first;
  assert.equal(store.getView().state, "loading");
  assert.equal(store.getView().opening, "/repos/b");
  assert.equal(store.getView().commits.length, 0);

  const sessionB = makeSession("b");
  await fake.answer("openRepositorySession", ok(sessionB));
  await fake.answer("readHistoryPage", ok(makeHistoryPage(sessionB)));
  await second;
  assert.equal(store.getView().session, sessionB);
});

test("switching records the shown repository first, and a failed switch keeps it on screen", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const sessionA = await openReady(fake, store, "a");

  const done = store.open("/not/a/repo");
  assert.equal(store.getView().state, "ready", "the current repository stays visible while the next one opens");
  assert.equal(store.getView().opening, "/not/a/repo");
  assert.deepEqual(fake.names().slice(-1), ["recordRepositoryView"]);
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  assert.deepEqual(fake.names().slice(-1), ["openRepositorySession"]);

  await fake.answer("openRepositorySession", err("NOT_A_REPOSITORY", "not a repository"));
  await fake.answer("getRepositorySession", ok(sessionA));
  await done;
  const view = store.getView();
  assert.equal(view.state, "ready");
  assert.equal(view.session, sessionA);
  assert.equal(view.opening, null);
  assert.deepEqual(view.notice, { code: "NOT_A_REPOSITORY", message: "not a repository", retryable: false, path: "/not/a/repo" });

  store.dismissNotice();
  assert.equal(store.getView().notice, null);
});

test("opening while a page read is pending cancels and drains it before a failed open keeps the session", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const session = await openReady(fake, store, "a", { nextCursor: "cursor-1" });
  let cancellations = 0;
  fake.api.cancelHistoryRead = async () => { cancellations += 1; return ok({ cancelled: true }); };

  const reading = store.readPage("cursor-1");
  await settled();
  assert.equal(store.getView().pageLoading, true);
  const opening = store.open("/missing");
  assert.equal(store.getView().pageLoading, false, "the old page loading state clears immediately");
  assert.equal(store.getView().opening, "/missing");
  assert.equal(cancellations, 1);

  await fake.fail("readHistoryPage", err("CANCELLED"));
  await reading;
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await fake.answer("openRepositorySession", err("NOT_A_REPOSITORY"));
  await fake.answer("getRepositorySession", ok(session));
  await opening;
  assert.equal(store.getView().state, "ready");
  assert.equal(store.getView().session, session);
  assert.equal(store.getView().pageLoading, false);
  assert.equal(store.getView().pageRequestDirection, null);
  assert.equal(store.getView().notice.code, "NOT_A_REPOSITORY");
});

test("a failed switch falls back to the error screen when the old session is gone", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  await openReady(fake, store, "a");
  const done = store.open("/missing");
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await fake.answer("openRepositorySession", err("REPOSITORY_UNAVAILABLE"));
  await fake.answer("getRepositorySession", err("STALE_CONTEXT"));
  await done;
  const view = store.getView();
  assert.equal(view.state, "error");
  assert.equal(view.repository, null);
  assert.equal(view.session, null);
  assert.equal(view.error.code, "REPOSITORY_UNAVAILABLE");
  assert.equal(view.error.path, "/missing");
});

test("a failed first open shows the error without asking for the old session", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const done = store.open("/missing");
  await fake.answer("openRepositorySession", err("PERMISSION_DENIED", "denied"));
  await done;
  assert.equal(store.getView().state, "error");
  assert.equal(store.getView().error.code, "PERMISSION_DENIED");
  assert.equal(fake.pending.getRepositorySession.length, 0);
  assert.ok(!fake.names().includes("getRepositorySession"));
});

test("cancel closes the session and ignores the open that was in flight", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const done = store.open("/repos/a");
  const cancelled = store.cancel();
  assert.equal(store.getView().state, "cancelled");
  await fake.answer("closeRepositorySession", ok({ closed: true }));
  await cancelled;
  await fake.answer("openRepositorySession", ok(makeSession("a")));
  await done;
  assert.equal(store.getView().state, "cancelled");
  assert.equal(store.getView().session, null);
  assert.equal(fake.pending.readHistoryPage.length, 0);
});

test("cancel is a no-op when nothing is loading", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  await openReady(fake, store, "a");
  await store.cancel();
  assert.equal(store.getView().state, "ready");
  assert.ok(!fake.names().includes("closeRepositorySession"));
});

test("a failed read keeps the repository and retry reads the same session again", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const session = makeSession("a");
  const done = store.open("/repos/a");
  await fake.answer("openRepositorySession", ok(session));
  await fake.answer("readHistoryPage", err("MISSING_OBJECT", "missing"));
  await done;
  assert.equal(store.getView().state, "error");
  assert.equal(store.getView().repository.path, "/repos/a");
  assert.equal(store.getView().error.code, "MISSING_OBJECT");

  const retried = store.retry();
  assert.equal(store.getView().state, "loading");
  assert.equal(store.getView().error, null);
  await fake.answer("readHistoryPage", ok(makeHistoryPage(session)));
  await retried;
  assert.equal(store.getView().state, "ready");
  assert.equal(fake.names().filter(name => name === "openRepositorySession").length, 1);
});

test("IPC rejections become protocol errors", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const done = store.open("/repos/a");
  await fake.fail("openRepositorySession", new Error("Untrusted IPC sender"));
  await done;
  assert.equal(store.getView().state, "error");
  assert.equal(store.getView().error.code, "PROTOCOL_ERROR");
  assert.match(store.getView().error.message, /Untrusted IPC sender/);
});

test("only content that reached the screen is recorded, and markShown records once per session", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  await store.recordView();
  await store.markShown();
  assert.equal(fake.calls.length, 0, "nothing is shown yet");

  const session = makeSession("a");
  const done = store.open("/repos/a");
  await fake.answer("openRepositorySession", ok(session));
  await store.recordView();
  assert.ok(!fake.names().includes("recordRepositoryView"), "a loading view is not recorded");
  await fake.answer("readHistoryPage", ok(makeHistoryPage(session)));
  await done;

  const shown = store.markShown();
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await shown;
  assert.deepEqual(store.getView().record, { saved: true, status: "ok", error: null });
  await store.markShown();
  assert.equal(fake.names().filter(name => name === "recordRepositoryView").length, 1);

  // Concurrent records for the same session share one call.
  const first = store.recordView();
  const second = store.recordView();
  await fake.answer("recordRepositoryView", ok({ saved: false, status: "corrupt" }));
  await Promise.all([first, second]);
  assert.equal(fake.names().filter(name => name === "recordRepositoryView").length, 2);
  assert.deepEqual(store.getView().record, { saved: false, status: "corrupt", error: null });
});

test("a record answered after a switch is not attached to the new session", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  await openReady(fake, store, "a");
  const recording = store.recordView();
  const switching = store.open("/repos/b");
  const sessionB = makeSession("b");
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await recording;
  await fake.answer("openRepositorySession", ok(sessionB));
  await fake.answer("readHistoryPage", ok(makeHistoryPage(sessionB)));
  await switching;
  assert.equal(store.getView().session, sessionB);
  assert.equal(store.getView().record, null);
  assert.equal(fake.names().filter(name => name === "recordRepositoryView").length, 1, "the switch reuses the in-flight record");
});

test("a record answered after the view moved on is dropped", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  await openReady(fake, store, "a");
  const switching = store.open("/repos/b");
  const cancelled = store.cancel();
  assert.equal(store.getView().state, "cancelled");
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await fake.answer("closeRepositorySession", ok({ closed: true }));
  await Promise.all([switching, cancelled]);
  assert.equal(store.getView().record, null);
  assert.equal(store.getView().state, "cancelled");
  assert.equal(fake.names().filter(name => name === "openRepositorySession").length, 1, "the cancelled switch never opens B");
});

test("when the core goes away, shown data stays but is no longer recorded, and loading stops", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  await openReady(fake, store, "a");
  store.coreUnavailable();
  assert.equal(store.getView().state, "ready");
  assert.equal(store.getView().session, null);
  assert.equal(store.getView().commits.length, 1);
  await store.recordView();
  assert.ok(!fake.names().includes("recordRepositoryView"));

  const other = new RepositorySessionStore(fakeApi().api);
  void other.open("/repos/b");
  other.coreUnavailable();
  assert.equal(other.getView().state, "error");
  assert.equal(other.getView().error.code, "CORE_EXITED");
  assert.equal(other.getView().opening, null);
});

test("failed next page keeps the current page and retries the failed cursor", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const session = await openReady(fake, store, "a", { nextCursor: "cursor-200", count: 200 });
  const firstPage = store.getView().commits;
  const snapshotRefs = store.getView().refs;
  const snapshotRepository = store.getView().repository;

  const next = store.nextPage();
  await settled();
  assert.deepEqual(fake.pending.readHistoryPage[0].args, ["cursor-200", 200, true]);
  await fake.answer("readHistoryPage", err("GIT_ERROR", "temporary"));
  await next;
  assert.equal(store.getView().state, "ready");
  assert.deepEqual(store.getView().commits, firstPage);
  assert.equal(store.getView().pageErrorKind, "read");

  const retry = store.retryPage();
  await settled();
  assert.deepEqual(fake.pending.readHistoryPage[0].args, ["cursor-200", 200, true]);
  await fake.answer("readHistoryPage", ok(makeHistoryPage(session, { offset: 200, cursor: "cursor-200", previousCursor: "cursor-0", count: 200 })));
  await retry;
  assert.equal(store.getView().pageOffset, 0);
  assert.equal(store.getView().commits.length, 400);
  assert.equal(store.getView().commits[0].summary, "summary 1");
  assert.equal(store.getView().commits[200].summary, "summary 201");
  assert.equal(store.getView().refs, snapshotRefs, "appended pages keep the frozen reference array");
  assert.equal(store.getView().repository, snapshotRepository);
  assert.deepEqual(fake.pending.readHistoryPage, []);

  const previousLoadedPage = await store.previousPage();
  assert.equal(previousLoadedPage, store.getView().commits[199].oid);
  assert.equal(store.getView().pageCursor, "cursor-0");
  assert.equal(store.getView().canNavigateNext, true);
  assert.deepEqual(fake.pending.readHistoryPage, [], "previous on a retained page must not issue another RPC");
});

test("selecting a commit after scrolling back moves the active page without another read", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const session = await openReady(fake, store, "active-page", { count: 200, nextCursor: "cursor-200" });

  const nextPage = store.nextPage();
  await settled();
  await fake.answer("readHistoryPage", ok(makeHistoryPage(session, {
    offset: 200, count: 200, cursor: "cursor-200", previousCursor: "cursor-0", nextCursor: "cursor-400",
  })));
  await nextPage;
  const prefetch = store.readPage("cursor-400");
  await settled();
  await fake.answer("readHistoryPage", ok(makeHistoryPage(session, {
    offset: 400, count: 200, cursor: "cursor-400", previousCursor: "cursor-200",
  })));
  await prefetch;

  const firstPageOid = store.getView().commits[0].oid;
  store.setSelectedOid(firstPageOid);
  assert.equal(store.getView().pageCursor, "cursor-0");
  assert.equal(store.getView().canNavigatePrevious, false);
  assert.equal(store.getView().canNavigateNext, true);

  const loadedNext = await store.nextPage();
  assert.equal(loadedNext, store.getView().commits[200].oid);
  assert.equal(store.getView().pageCursor, "cursor-200");
  assert.deepEqual(fake.pending.readHistoryPage, [], "navigating to a retained page issues no RPC");
});

test("the renderer retains at most 1,800 commits for the detail-page budget and can reread a trimmed edge", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const session = await openReady(fake, store, "window", { count: 200, nextCursor: "cursor-200" });

  for (let offset = 200; offset <= 1_800; offset += 200) {
    const loading = store.nextPage();
    await settled();
    await fake.answer("readHistoryPage", ok(makeHistoryPage(session, {
      offset, count: 200, cursor: `cursor-${offset}`, previousCursor: `cursor-${offset - 200}`,
      nextCursor: offset === 1_800 ? null : `cursor-${offset + 200}`,
    })));
    await loading;
  }
  assert.equal(store.getView().commits.length, 1_800);
  assert.equal(store.getView().pageOffset, 200);
  assert.equal(store.getView().windowPageCount, 9);
  assert.equal(store.getView().commits[0].summary, "summary 201");

  for (let index = 0; index < 8; index += 1) await store.previousPage();
  assert.equal(store.getView().pageCursor, "cursor-200");
  const previous = store.previousPage();
  await settled();
  assert.deepEqual(fake.pending.readHistoryPage[0].args, ["cursor-0", 200, true]);
  await fake.answer("readHistoryPage", ok(makeHistoryPage(session, { count: 200, cursor: "cursor-0", nextCursor: "cursor-200" })));
  const selected = await previous;
  assert.equal(selected, store.getView().commits[199].oid);
  assert.equal(store.getView().commits.length, 1_800);
  assert.equal(store.getView().pageOffset, 0);
  assert.equal(store.getView().windowPageCount, 9);
  assert.equal(store.getView().commits.at(-1).summary, "summary 1800");
});

test("a newer reverse intent drains and supersedes a pending forward prefetch", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const session = await openReady(fake, store, "reverse", {
    offset: 200, count: 200, cursor: "cursor-200", previousCursor: "cursor-0", nextCursor: "cursor-400",
  });
  const selected = store.getView().commits[0].oid;
  store.setSelectedOid(selected);

  const forward = store.readPage("cursor-400");
  await settled();
  assert.equal(store.getView().pageRequestDirection, "after");
  const reverse = store.readPage("cursor-0");
  await settled();
  assert.deepEqual(fake.pending.readHistoryPage[0].args, ["cursor-400", 200, true]);
  await fake.answer("readHistoryPage", err("CANCELLED", "superseded"));
  await settled();
  assert.deepEqual(fake.pending.readHistoryPage[0].args, ["cursor-0", 200, true]);
  await fake.answer("readHistoryPage", ok(makeHistoryPage(session, {
    offset: 0, count: 200, cursor: "cursor-0", nextCursor: "cursor-200",
  })));
  await Promise.all([forward, reverse]);

  assert.equal(store.getView().pageOffset, 0);
  assert.equal(store.getView().commits.length, 400);
  assert.equal(store.getView().commits[200].oid, selected);
  assert.equal(store.getView().pageLoading, false);
});

test("marker metadata can add a divider across pages, while unavailable disables the whole window", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const session = makeSession("markers");
  const opening = store.open(session.repository.path);
  await fake.answer("openRepositorySession", ok(session));
  await fake.answer("readHistoryPage", ok(makeHistoryPage(session, {
    count: 1, nextCursor: "cursor-1", status: "ready", divider: "01".repeat(20),
    commits: [{ ...makePreview(session).commits[0], oid: "01".repeat(20), isNewSinceLastSeen: false }],
  })));
  await opening;
  assert.equal(store.getView().lastSeenDividerOid, "01".repeat(20));

  const next = store.nextPage();
  await settled();
  await fake.answer("readHistoryPage", ok(makeHistoryPage(session, {
    offset: 1, cursor: "cursor-1", previousCursor: "cursor-0", nextCursor: "cursor-2", status: "ready",
    count: 1, commits: [{ ...makePreview(session).commits[0], oid: "02".repeat(20), isNewSinceLastSeen: true }],
  })));
  await next;
  assert.equal(store.getView().commits[1].isNewSinceLastSeen, true);
  assert.equal(store.getView().lastSeenDividerOid, "01".repeat(20));

  const unavailable = store.nextPage();
  await settled();
  await fake.answer("readHistoryPage", ok(makeHistoryPage(session, {
    offset: 2, cursor: "cursor-2", previousCursor: "cursor-1", status: "unavailable",
    count: 1, commits: [{ ...makePreview(session).commits[0], oid: "03".repeat(20), isNewSinceLastSeen: true }],
  })));
  await unavailable;
  assert.equal(store.getView().newSinceLastSeenStatus, "unavailable");
  assert.equal(store.getView().lastSeenDividerOid, null);
  assert.ok(store.getView().commits.every(commit => !commit.isNewSinceLastSeen));
});

test("cancelling a page read drains it without replacing the visible page", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  await openReady(fake, store, "a", { nextCursor: "cursor-200" });
  const firstPage = store.getView().commits;
  const next = store.nextPage();
  await settled();
  const cancelled = store.cancelPage();
  await fake.answer("readHistoryPage", err("CANCELLED", "cancelled"));
  await Promise.all([next, cancelled]);
  assert.equal(store.getView().pageLoading, false);
  assert.deepEqual(store.getView().commits, firstPage);
  assert.equal(store.getView().state, "ready");
});

test("refresh failure preserves the old session and page", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const session = await openReady(fake, store, "a");
  const page = store.getView().commits;
  const refreshing = store.refresh(page[0].oid, { oid: page[0].oid, offset: 0 });
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await settled();
  assert.deepEqual(fake.pending.refreshRepositorySession[0].args, [200]);
  await fake.answer("refreshRepositorySession", err("GIT_ERROR", "refresh failed"));
  await refreshing;
  assert.equal(store.getView().session, session);
  assert.deepEqual(store.getView().commits, page);
  assert.equal(store.getView().refreshing, false);
  assert.equal(store.getView().pageErrorKind, "refresh");
});

test("refresh reports a deleted selected scope while retaining the previous history", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const session = await openReady(fake, store, "a");
  session.scope = { ref: "refs/heads/feature/gone" };
  const commits = store.getView().commits;
  const refreshing = store.refresh();
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await fake.answer("refreshRepositorySession", err("SCOPE_UNAVAILABLE", "所选分支已不存在"));
  await refreshing;
  assert.equal(store.getView().session, session);
  assert.deepEqual(store.getView().commits, commits);
  assert.equal(store.getView().scopeError.code, "SCOPE_UNAVAILABLE");
  assert.deepEqual(store.getView().scopeErrorTarget, { ref: "refs/heads/feature/gone" });
});

test("refresh preserves an old selection and anchor status, then records the new shown session", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const oldSession = await openReady(fake, store, "a");
  const oldCommit = store.getView().commits[0];
  store.setSelectedOid(oldCommit.oid);
  const newSession = {
    ...makeSession("a"),
    repositoryKey: oldSession.repositoryKey,
    worktreeId: oldSession.worktreeId,
    observedAtUnixMs: oldSession.observedAtUnixMs + 10_000,
    repository: { ...oldSession.repository, headOid: "b".repeat(40) },
  };
  const refreshing = store.refresh(oldCommit.oid, { oid: "not-on-first-page", offset: 24 });
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await settled();
  await fake.answer("refreshRepositorySession", ok({ session: newSession, page: makeHistoryPage(newSession) }));
  await refreshing;
  assert.equal(store.getView().session, newSession);
  assert.equal(store.getView().oldSelectedCommit, oldCommit);
  assert.equal(store.getView().oldSelectedObservedAtUnixMs, oldSession.observedAtUnixMs);
  assert.equal(store.getView().selectionMissingOnPage, true);
  assert.equal(store.getView().anchorMissing, true);

  const shown = store.markShown();
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await shown;
  assert.deepEqual(fake.pending.recordRepositoryView, []);
  assert.equal(fake.calls.filter(call => call.name === "recordRepositoryView").length, 2);
});

test("a committed refresh stays visible when the following open fails", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const oldSession = await openReady(fake, store, "a");
  const newSession = { ...makeSession("a"), repositoryKey: oldSession.repositoryKey, worktreeId: oldSession.worktreeId,
    repository: { ...oldSession.repository, headOid: "b".repeat(40) } };
  const refreshing = store.refresh();
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await settled();

  const opening = store.open("/repos/b");
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await settled();
  await fake.answer("refreshRepositorySession", ok({ session: newSession, page: makeHistoryPage(newSession) }));
  await refreshing;
  assert.equal(store.getView().session, newSession);
  await fake.answer("openRepositorySession", err("NOT_A_REPOSITORY", "failed"));
  await settled();
  await fake.answer("getRepositorySession", ok(newSession));
  await opening;
  assert.equal(store.getView().session, newSession);
  assert.equal(store.getView().commits[0].summary, "summary repo-a");
  assert.equal(store.getView().notice.code, "NOT_A_REPOSITORY");
});

test("a newer open intent prevents a refresh still recording the old view from starting", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  await openReady(fake, store, "a");
  const refreshing = store.refresh();
  assert.equal(store.getView().refreshing, true);
  const duplicateRefresh = store.refresh();
  const opening = store.open("/repos/b");
  assert.equal(store.getView().refreshing, false);

  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await Promise.all([refreshing, duplicateRefresh]);
  await settled();
  assert.equal(fake.names().includes("refreshRepositorySession"), false);
  const sessionB = makeSession("b");
  await fake.answer("openRepositorySession", ok(sessionB));
  await fake.answer("readHistoryPage", ok(makeHistoryPage(sessionB)));
  await opening;
  assert.equal(store.getView().session, sessionB);
});

test("scope switch keeps window identity and preserves an in-window selection and anchor", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const original = await openReady(fake, store, "a");
  const selected = store.getView().commits[0].oid;
  const switching = store.switchScope({ ref: "refs/heads/dev" }, selected, { oid: selected, offset: 13 });
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  const next = { ...original, repoId: "repo-a-scope", generation: "gen-a-scope", scope: { ref: "refs/heads/dev" }, tips: [selected] };
  const page = makeHistoryPage(next, { commits: [{ ...store.getView().commits[0] }] });
  await fake.answer("selectRepositoryScope", ok({ session: next, page }));
  const result = await switching;
  assert.deepEqual(result, { selectedOid: selected, anchor: { oid: selected, offset: 13 } });
  assert.equal(store.getView().session.scope.ref, "refs/heads/dev");
  assert.equal(store.getView().session.worktreeId, original.worktreeId);
  assert.equal(store.getView().repository.path, original.repository.path);
  assert.equal(store.getView().selectionMissingOnPage, false);
  assert.equal(store.getView().anchorMissing, false);
  assert.deepEqual(store.getView().commits.map(commit => commit.oid), [selected]);
});

test("scope switch retains old detail and reports only the loaded-window boundary", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const original = await openReady(fake, store, "a");
  const selectedCommit = store.getView().commits[0];
  const switching = store.switchScope("allBranches", selectedCommit.oid, { oid: selectedCommit.oid, offset: 8 });
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  const next = { ...original, repoId: "repo-a-all", generation: "gen-a-all", scope: "allBranches", tips: [selectedCommit.oid] };
  const other = { ...selectedCommit, oid: "b".repeat(40), summary: "other range" };
  await fake.answer("selectRepositoryScope", ok({ session: next, page: makeHistoryPage(next, { commits: [other] }) }));
  const result = await switching;
  assert.deepEqual(result, { selectedOid: selectedCommit.oid, anchor: undefined });
  assert.equal(store.getView().oldSelectedCommit.oid, selectedCommit.oid);
  assert.equal(store.getView().selectionMissingOnPage, true);
  assert.equal(store.getView().anchorMissing, true);
  assert.equal(store.getView().session.scope, "allBranches");
});

test("failed scope switch keeps the old snapshot and history visible", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const original = await openReady(fake, store, "a");
  const previousCommits = store.getView().commits;
  const switching = store.switchScope({ ref: "refs/heads/deleted" });
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await fake.answer("selectRepositoryScope", err("SCOPE_UNAVAILABLE", "该分支已不存在"));
  assert.equal(await switching, undefined);
  assert.equal(store.getView().session, original);
  assert.deepEqual(store.getView().commits, previousCommits);
  assert.equal(store.getView().scopeSwitching, false);
  assert.equal(store.getView().scopeError.code, "SCOPE_UNAVAILABLE");
});

test("scope and refresh mutations are mutually exclusive", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  await openReady(fake, store, "a");
  const refreshing = store.refresh();
  assert.equal(store.getView().refreshing, true);
  assert.equal(await store.switchScope("allBranches"), undefined);
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  const refreshed = { ...makeSession("a-refresh"), repositoryKey: "key-a", worktreeId: "wt-a" };
  await fake.answer("refreshRepositorySession", ok({ session: refreshed, page: makeHistoryPage(refreshed) }));
  await refreshing;

  const switching = store.switchScope("allBranches");
  assert.equal(store.getView().scopeSwitching, true);
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  assert.equal(await store.refresh(), undefined);
  const allBranches = { ...refreshed, repoId: "repo-a-all", generation: "gen-a-all", scope: "allBranches", tips: [refreshed.repository.headOid] };
  await fake.answer("selectRepositoryScope", ok({ session: allBranches, page: makeHistoryPage(allBranches) }));
  await switching;
});

test("failed scope switch clears stale navigation and merge loading state", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  await openReady(fake, store, "a");
  const navigation = store.loadNavigation();
  const merge = store.loadRefMergeStatus(["refs/heads/main"]);
  await settled();
  assert.equal(store.getView().navigationLoading, true);
  assert.equal(store.getView().mergeStatusLoading, true);

  const switching = store.switchScope("allBranches");
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await fake.answer("selectRepositoryScope", err("SCOPE_UNAVAILABLE"));
  await switching;
  assert.equal(store.getView().navigationLoading, false);
  assert.equal(store.getView().mergeStatusLoading, false);

  const navData = { refs: [], refsTruncated: false, worktrees: [], worktreesTruncated: false, defaultBase: null, observedAtUnixMs: 1 };
  await fake.answer("getRepositoryNavigation", ok(navData));
  await fake.answer("getRefMergeStatus", ok({ defaultBase: null, statuses: [{ name: "refs/heads/main", oid: "a".repeat(40), status: "merged" }] }));
  await Promise.all([navigation, merge]);
  assert.equal(store.getView().navigation, null);
  assert.deepEqual(store.getView().mergeStatuses, {});
});

test("navigation that finds the core busy is asked again instead of left empty", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  await openReady(fake, store, "a");
  const navData = { refs: [], refsTruncated: false, worktrees: [], worktreesTruncated: false, defaultBase: null, observedAtUnixMs: 1 };
  const loading = store.loadNavigation();
  await fake.answer("getRepositoryNavigation", err("BUSY", "读取暂时繁忙，请稍后重试"));
  assert.equal(store.getView().navigationLoading, true, "still loading during the short pause");
  assert.equal(store.getView().navigationError, null);
  await new Promise(resolve => setTimeout(resolve, 200));
  await fake.answer("getRepositoryNavigation", ok(navData));
  await loading;
  assert.deepEqual(store.getView().navigation, navData);

  const failing = store.loadNavigation();
  await fake.answer("getRepositoryNavigation", err("REPOSITORY_ERROR", "读取失败"));
  await failing;
  assert.equal(store.getView().navigationError?.message, "读取失败", "other failures are shown at once");
});

test("a merge-status query interrupted by another read is retried instead of reported", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  await openReady(fake, store, "a");
  const merged = ok({ defaultBase: null, statuses: [{ name: "refs/heads/main", oid: "a".repeat(40), status: "merged" }] });

  const first = store.loadRefMergeStatus(["refs/heads/main"]);
  await fake.answer("getRefMergeStatus", err("CANCELLED", "分支合入状态查询已取消"));
  assert.equal(store.getView().mergeStatusLoading, true, "the picker keeps showing progress during the short pause");
  assert.equal(store.getView().mergeStatusError, null);
  await first;
  assert.equal(store.getView().mergeStatusLoading, false, "loading clears so the picker asks again");
  assert.equal(store.getView().mergeStatusError, null, "commit details cancelling the query is not a failure");

  const second = store.loadRefMergeStatus(["refs/heads/main"]);
  await fake.answer("getRefMergeStatus", merged);
  await second;
  assert.equal(store.getView().mergeStatuses["refs/heads/main"], "merged");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const interrupted = store.loadRefMergeStatus(["refs/heads/other"]);
    await fake.answer("getRefMergeStatus", err(attempt % 2 ? "BUSY" : "CANCELLED"));
    await interrupted;
    assert.equal(store.getView().mergeStatusError, null, `interruption ${attempt + 1} is retried`);
  }
  const exhausted = store.loadRefMergeStatus(["refs/heads/other"]);
  await fake.answer("getRefMergeStatus", err("CANCELLED"));
  await exhausted;
  assert.equal(store.getView().mergeStatusLoading, false);
  assert.equal(store.getView().mergeStatusError?.message, "读取暂时繁忙，请稍后重试", "endless interruptions end in an error the user can retry");

  const failing = store.loadRefMergeStatus(["refs/heads/other"]);
  await fake.answer("getRefMergeStatus", err("REPOSITORY_ERROR", "读取失败"));
  await failing;
  assert.equal(store.getView().mergeStatusError?.message, "读取失败", "other failures are shown at once");
});

test("scope response retains the latest user selection made while it was pending", async () => {
  const fake = fakeApi();
  const originalPage = makeHistoryPage(makeSession("a"), { commits: [
    makePreview(makeSession("a")).commits[0],
    { ...makePreview(makeSession("a")).commits[0], oid: "d".repeat(40), summary: "selection B" },
  ] });
  const store = new RepositorySessionStore(fake.api);
  const original = await openReady(fake, store, "a", { commits: originalPage.commits });
  const oidA = store.getView().commits[0].oid;
  const oidB = store.getView().commits[1].oid;
  store.setSelectedOid(oidA);
  const switching = store.switchScope("allBranches", oidA);
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  store.setSelectedOid(oidB);
  const next = { ...original, repoId: "repo-a-all", generation: "gen-a-all", scope: "allBranches", tips: [oidA] };
  const other = { ...store.getView().commits[0], oid: "e".repeat(40), summary: "new scope" };
  await fake.answer("selectRepositoryScope", ok({ session: next, page: makeHistoryPage(next, { commits: [other] }) }));
  assert.deepEqual(await switching, { selectedOid: oidB, anchor: undefined });
  assert.equal(store.getView().oldSelectedCommit.oid, oidB);
});

test("status polling invalidation cannot discard an in-flight index control response", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  await openReady(fake, store, "a");
  const control = store.controlMetadataIndex("pause");
  await settled();
  assert.equal(store.getView().metadataIndexAction, "pause");

  store.invalidateMetadataIndexStatus();
  assert.equal(store.getView().metadataIndexAction, "pause");
  const paused = { snapshotKey: "snapshot-a", state: "paused", coverage: { processed: 7, complete: false }, diskBytes: 100, quotaBytes: 1000, error: null };
  await fake.answer("controlMetadataIndex", ok(paused));
  assert.equal(await control, true);
  assert.deepEqual(store.getView().metadataIndex, paused);
  assert.equal(store.getView().metadataIndexAction, null);
});

test("cancel closes and drains a pending scope transaction", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const original = await openReady(fake, store, "a");
  const switching = store.switchScope("allBranches");
  await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  const next = { ...original, repoId: "repo-a-all", generation: "gen-a-all", scope: "allBranches", tips: [original.repository.headOid] };
  const selection = fake.pending.selectRepositoryScope[0];
  assert.ok(selection);

  const cancelling = store.cancel();
  await fake.answer("closeRepositorySession", ok({ closed: true }));
  await cancelling;
  selection.resolve(ok({ session: next, page: makeHistoryPage(next) }));
  await switching;
  assert.equal(store.getView().state, "cancelled");
  assert.equal(store.getView().session, null);
});

test("a prefetch waits for a running date jump instead of cancelling it", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const session = await openReady(fake, store, "a", { nextCursor: "cursor-200" });
  const prior = store.getView();
  const base = makePreview(session).commits[0];
  const target = { ...base, oid: "ab".repeat(20), summary: "target", committer: { ...base.committer, timestamp: "100" } };
  const locating = store.locateHistoryDate(150);
  await settled();
  assert.equal(store.getView().pageRequestKind, "dateLocation");
  assert.deepEqual(fake.pending.locateHistoryDate[0].args, [150, 200, ["cursor-0"]]);
  // Scrolling right after a jump asks for the next page; it must not cancel the jump.
  await store.readPage("cursor-200");
  assert.equal(fake.pending.readHistoryPage.length, 0, "no page read starts while the date jump runs");
  const page = makeHistoryPage(session, { offset: 200, cursor: "cursor-200", previousCursor: "cursor-0", nextCursor: "cursor-400", commits: [target] });
  await fake.answer("locateHistoryDate", ok(makeDateLocation(page, target.oid)));
  assert.equal(await locating, target.oid);
  assert.equal(store.getView().commits[0].oid, target.oid);
  assert.strictEqual(store.getView().repository, prior.repository);
  assert.strictEqual(store.getView().refs, prior.refs);
  assert.equal(store.getView().pageOffset, 200);
  assert.equal(store.getView().windowPreviousCursor, "cursor-0");
});

test("date location reuses a known page and keeps the bounded window objects", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const session = makeSession("date-same-page");
  const opening = store.open(session.repository.path);
  await fake.answer("openRepositorySession", ok(session));
  await fake.answer("readHistoryPage", ok(makeHistoryPage(session, {
    nextCursor: "cursor-200", count: 200, commits: makePageCommits(session, 0, 200),
  })));
  await opening;
  const reading = store.readPage("cursor-200");
  await settled();
  const secondPage = makeHistoryPage(session, {
    offset: 200, cursor: "cursor-200", previousCursor: "cursor-0", nextCursor: "cursor-400",
    count: 200, commits: makePageCommits(session, 200, 200),
  });
  await fake.answer("readHistoryPage", ok(secondPage));
  await reading;
  const before = store.getView();
  const targetOid = secondPage.commits[0].oid;
  const locating = store.locateHistoryDate(150);
  await settled();
  assert.deepEqual(fake.pending.locateHistoryDate[0].args, [150, 200, ["cursor-0", "cursor-200"]]);
  await fake.answer("locateHistoryDate", ok(makeDateLocation(secondPage, targetOid, false)));

  assert.equal(await locating, targetOid);
  const after = store.getView();
  assert.strictEqual(after.commits, before.commits);
  assert.strictEqual(after.refs, before.refs);
  assert.strictEqual(after.repository, before.repository);
  assert.equal(after.pageCursor, "cursor-200");
  assert.equal(after.previousCursor, "cursor-0");
  assert.equal(after.nextCursor, "cursor-400");
  assert.equal(after.windowPreviousCursor, null);
  assert.equal(after.windowNextCursor, "cursor-400");
  assert.equal(after.pageOffset, 0);
  assert.equal(after.canNavigatePrevious, true);
  assert.equal(after.canNavigateNext, true);
  assert.equal(after.windowPageCount, 2);
  assert.equal(after.windowRevision, before.windowRevision);
});
