import assert from "node:assert/strict";
import test from "node:test";
import { loadBuilt, waitFor } from "./test-utils.mjs";

const { RepositorySessionController } = await loadBuilt("repository-session-controller");

const NULL_CONTEXT = { repoId: null, generation: null };

function session(path, suffix) {
  const oid = suffix.repeat(40);
  return {
    repoId: `repo-${suffix}`,
    generation: `generation-${suffix}`,
    repositoryKey: `key-${suffix}`,
    worktreeId: `worktree-${suffix}`,
    scope: "head",
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

function makeCommit(sessionInfo) {
  return {
    oid: sessionInfo.repository.headOid,
    parents: [], summary: "summary", summaryTruncated: false, textLossy: false,
    author: { name: "Author", email: "author@example.invalid", timestamp: "1", offset: "+0000" },
    committer: { name: "Committer", email: "committer@example.invalid", timestamp: "2", offset: "+0000" },
  };
}

function makeCore({ rejectOnAbort = false } = {}) {
  const listeners = new Set();
  const requests = [];
  const core = {
    status: { state: "ready", revision: 1, core: { capabilities: ["repositorySessions", "historyPagination"] } },
    currentContext: NULL_CONTEXT,
    getStatus() { return this.status; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emitStatus(status) {
      this.status = status;
      for (const listener of listeners) listener(status);
    },
    observeLatestContext(context) { this.latestContext = { ...context }; },
    switchCurrentContext(context) { this.currentContext = { ...context }; },
    request(method, params, context, options = {}) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      promise.catch(() => {});
      const request = { method, params, context, options, resolve, reject };
      requests.push(request);
      if (rejectOnAbort) options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "CANCELLED" })), { once: true });
      return promise;
    },
    requests,
  };
  return core;
}

function send(request, data, { done = true } = {}) {
  const processed = data.section === "historyPage" ? data.commits.length : data.section === "commits" ? data.commits.length : 1;
  request.options.onChunk?.({ data, done, sequence: 0, repoId: request.context.repoId, generation: request.context.generation,
    coverage: { complete: done, processed }, nextCursor: null });
  request.resolve({ coverage: { complete: true, processed }, nextCursor: null });
}

test("open binds the session context; get, preview, record, and close use it", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opening = controller.open("/tmp/repo-a");
  const openRequest = await waitFor(() => core.requests[0]);
  assert.equal(openRequest.method, "openRepository");
  assert.deepEqual(openRequest.context, NULL_CONTEXT);
  assert.equal(openRequest.params.path, "/tmp/repo-a");
  const opened = session("/tmp/repo-a", "a");
  send(openRequest, { section: "repositorySession", session: opened });
  assert.deepEqual(await opening, opened);
  assert.deepEqual(core.currentContext, { repoId: opened.repoId, generation: opened.generation });

  const getting = controller.get();
  const getRequest = await waitFor(() => core.requests[1]);
  assert.equal(getRequest.method, "getRepositorySession");
  assert.deepEqual(getRequest.context, core.currentContext);
  send(getRequest, { section: "repositorySession", session: opened });
  assert.deepEqual(await getting, opened);

  const reading = controller.readPreview();
  const previewRequest = await waitFor(() => core.requests[2]);
  assert.equal(previewRequest.method, "readSessionPreview");
  assert.deepEqual(previewRequest.context, core.currentContext);
  previewRequest.options.onChunk({
    data: {
      section: "repository",
      repository: opened.repository,
      refs: [],
      refsTruncated: false,
    },
    done: false,
    sequence: 0,
  });
  previewRequest.options.onChunk({ data: { section: "commits", commits: [], hasMore: false }, done: true, sequence: 1 });
  previewRequest.resolve({ coverage: { complete: true, processed: 0 }, nextCursor: null });
  assert.deepEqual(await reading, { repository: opened.repository, refs: [], refsTruncated: false, commits: [], hasMore: false });

  const recording = controller.recordView(opened.generation);
  const recordRequest = await waitFor(() => core.requests[3]);
  assert.deepEqual(recordRequest.context, core.currentContext);
  send(recordRequest, { section: "repositoryViewRecorded", saved: true, status: "ok" });
  assert.deepEqual(await recording, { saved: true, status: "ok" });

  const closing = controller.close();
  const closeRequest = await waitFor(() => core.requests[4]);
  assert.equal(closeRequest.method, "closeRepository");
  assert.deepEqual(closeRequest.context, core.currentContext);
  send(closeRequest, { section: "repositoryClosed", closed: true });
  assert.deepEqual(await closing, { closed: true });
  assert.deepEqual(core.currentContext, NULL_CONTEXT);
  controller.dispose();
});

test("latest open wins when earlier open resolves late", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const openA = controller.open("/tmp/repo-a");
  const requestA = await waitFor(() => core.requests[0]);
  const openAResult = assert.rejects(openA, error => error.code === "CANCELLED");

  const openB = controller.open("/tmp/repo-b");
  assert.equal(requestA.options.signal.aborted, true);
  requestA.reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
  await openAResult;
  const requestB = await waitFor(() => core.requests[1]);
  const sessionB = session("/tmp/repo-b", "b");
  send(requestB, { section: "repositorySession", session: sessionB });
  assert.deepEqual(await openB, sessionB);

  requestA.options.onChunk({ data: { section: "repositorySession", session: session("/tmp/repo-a", "a") }, done: true, sequence: 0 });
  assert.deepEqual(core.currentContext, { repoId: sessionB.repoId, generation: sessionB.generation });
  controller.dispose();
});

test("a committed open terminal is reconciled before a later open failure", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const openA = controller.open("/tmp/repo-a");
  const requestA = await waitFor(() => core.requests[0]);
  const openAResult = assert.rejects(openA, error => error.code === "CANCELLED");

  const openB = controller.open("/tmp/repo-b");
  assert.equal(requestA.options.signal.aborted, true);
  const committedA = session("/tmp/repo-a", "a");
  send(requestA, { section: "repositorySession", session: committedA });
  await openAResult;
  const requestB = await waitFor(() => core.requests[1]);
  requestB.reject(Object.assign(new Error("not a repository"), { code: "NOT_A_REPOSITORY" }));
  await assert.rejects(openB, error => error.code === "NOT_A_REPOSITORY");
  assert.deepEqual(core.currentContext, { repoId: committedA.repoId, generation: committedA.generation });

  const getting = controller.get();
  const getRequest = await waitFor(() => core.requests[2]);
  assert.deepEqual(getRequest.context, core.currentContext);
  send(getRequest, { section: "repositorySession", session: committedA });
  assert.deepEqual(await getting, committedA);

  const closing = controller.close();
  const closeRequest = await waitFor(() => core.requests[3]);
  assert.deepEqual(closeRequest.context, core.currentContext);
  send(closeRequest, { section: "repositoryClosed", closed: true });
  assert.deepEqual(await closing, { closed: true });
  controller.dispose();
});

test("late close cannot clear a newer session; daemon exit clears the current gate", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const openingA = controller.open("/tmp/repo-a");
  const requestA = await waitFor(() => core.requests[0]);
  const sessionA = session("/tmp/repo-a", "a");
  send(requestA, { section: "repositorySession", session: sessionA });
  await openingA;

  const closingA = controller.close();
  const closeRequest = await waitFor(() => core.requests[1]);
  const closeResult = assert.rejects(closingA, error => error.code === "STALE_CONTEXT");

  const openingB = controller.open("/tmp/repo-b");
  const requestB = await waitFor(() => core.requests[2]);
  const sessionB = session("/tmp/repo-b", "b");
  send(requestB, { section: "repositorySession", session: sessionB });
  await openingB;
  closeRequest.reject(Object.assign(new Error("old session"), { code: "STALE_CONTEXT" }));
  await closeResult;
  assert.deepEqual(core.currentContext, { repoId: sessionB.repoId, generation: sessionB.generation });

  core.emitStatus({ state: "error", revision: 2, message: "daemon exited" });
  assert.deepEqual(core.currentContext, NULL_CONTEXT);
  await assert.rejects(controller.get(), error => error.code === "CORE_EXITED");
  controller.dispose();
});

test("closing during a pending open drains its terminal and closes the current session", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const initialOpen = controller.open("/tmp/repo-a");
  const initialRequest = await waitFor(() => core.requests[0]);
  const sessionA = session("/tmp/repo-a", "a");
  send(initialRequest, { section: "repositorySession", session: sessionA });
  await initialOpen;

  const openingB = controller.open("/tmp/repo-b");
  const openBRejected = assert.rejects(openingB, error => error.code === "CANCELLED");
  const openRequest = await waitFor(() => core.requests[1]);
  const closing = controller.close();
  assert.equal(openRequest.options.signal.aborted, true);
  openRequest.reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
  await openBRejected;
  const closeRequest = await waitFor(() => core.requests[2]);
  assert.deepEqual(closeRequest.context, { repoId: sessionA.repoId, generation: sessionA.generation });
  send(closeRequest, { section: "repositoryClosed", closed: true });
  assert.deepEqual(await closing, { closed: true });
  controller.dispose();
});

test("a committed response continuation cannot revive a session after core exit or dispose", async () => {
  for (const invalidation of ["core-exit", "dispose"]) {
    const core = makeCore();
    const controller = new RepositorySessionController(core);
    const opening = controller.open("/tmp/repo-a");
    const openRequest = await waitFor(() => core.requests[0]);
    const openResult = assert.rejects(opening, error => error.code === "CORE_EXITED");
    send(openRequest, { section: "repositorySession", session: session("/tmp/repo-a", "a") });
    if (invalidation === "core-exit") core.emitStatus({ state: "error", revision: 2, message: "daemon exited" });
    else controller.dispose();
    await openResult;
    assert.deepEqual(core.currentContext, NULL_CONTEXT);
    await assert.rejects(controller.get(), error => error.code === (invalidation === "core-exit" ? "CORE_EXITED" : "STALE_CONTEXT"));
    controller.dispose();
  }
});

test("history pages validate headers, cursor metadata, and page-local coverage", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opening = controller.open("/tmp/repo-a");
  const openRequest = await waitFor(() => core.requests[0]);
  const opened = session("/tmp/repo-a", "a");
  send(openRequest, { section: "repositorySession", session: opened });
  await opening;

  const read = controller.readHistoryPage(null, 100);
  const request = await waitFor(() => core.requests[1]);
  assert.equal(request.method, "readHistoryPage");
  assert.deepEqual(request.params, { cursor: null, pageSize: 100 });
  request.options.onChunk({ data: { section: "repository", repository: opened.repository, refs: [], refsTruncated: false },
    done: false, sequence: 0, repoId: opened.repoId, generation: opened.generation,
    coverage: { complete: false, processed: 0 }, nextCursor: null });
  const commit = makeCommit(opened);
  request.options.onChunk({ data: { section: "historyPage", commits: [commit], offset: 0, pageSize: 100,
    cursor: "cursor-0", previousCursor: null, hasMore: true }, done: true, sequence: 1,
    repoId: opened.repoId, generation: opened.generation, coverage: { complete: true, processed: 1 }, nextCursor: "cursor-1" });
  request.resolve({ coverage: { complete: true, processed: 1 }, nextCursor: "cursor-1" });
  const page = await read;
  assert.deepEqual(page.commits, [commit]);
  assert.equal(page.cursor, "cursor-0");
  assert.equal(page.nextCursor, "cursor-1");
  controller.dispose();
});

test("refresh publishes only a complete first page and switches context after terminal", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opening = controller.open("/tmp/repo-a");
  const openRequest = await waitFor(() => core.requests[0]);
  const oldSession = session("/tmp/repo-a", "a");
  send(openRequest, { section: "repositorySession", session: oldSession });
  await opening;

  const refreshed = { ...session("/tmp/repo-a", "b"), repositoryKey: oldSession.repositoryKey, worktreeId: oldSession.worktreeId };
  const refreshing = controller.refreshRepository(100);
  const request = await waitFor(() => core.requests[1]);
  assert.equal(request.method, "refreshRepository");
  assert.deepEqual(request.context, { repoId: oldSession.repoId, generation: oldSession.generation });
  const commit = makeCommit(refreshed);
  const chunks = [
    { section: "repositorySession", session: refreshed },
    { section: "repository", repository: refreshed.repository, refs: [], refsTruncated: false },
    { section: "historyPage", commits: [commit], offset: 0, pageSize: 100, cursor: "fresh-0", previousCursor: null, hasMore: false },
  ];
  chunks.forEach((data, sequence) => request.options.onChunk({ data, sequence, done: sequence === 2,
    repoId: oldSession.repoId, generation: oldSession.generation,
    coverage: { complete: sequence === 2, processed: sequence === 2 ? 1 : 0 }, nextCursor: null }));
  request.resolve({ coverage: { complete: true, processed: 1 }, nextCursor: null });
  const value = await refreshing;
  assert.equal(value.session, refreshed);
  assert.deepEqual(value.page.commits, [commit]);
  assert.deepEqual(core.currentContext, { repoId: refreshed.repoId, generation: refreshed.generation });
  controller.dispose();
});
