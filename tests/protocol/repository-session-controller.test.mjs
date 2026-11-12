import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { daemonPath, loadBuilt, waitFor } from "./test-utils.mjs";

const { RepositorySessionController } = await loadBuilt("repository-session-controller");
const { CoreProcess } = await loadBuilt("core-process");
const execFileAsync = promisify(execFile);

const NULL_CONTEXT = { repoId: null, generation: null };

function session(path, suffix) {
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

function makeCommit(sessionInfo) {
  return {
    oid: sessionInfo.repository.headOid,
    parents: [], summary: "summary", summaryTruncated: false, textLossy: false,
    isNewSinceLastSeen: false,
    graph: { lane: 0, color: 0, parents: [], boundary: false, above: 0, below: 0, hiddenLaneCount: 0, hiddenThroughRanges: [], segments: [] },
    author: { name: "Author", email: "author@example.invalid", timestamp: "1", offset: "+0000" },
    committer: { name: "Committer", email: "committer@example.invalid", timestamp: "2", offset: "+0000" },
  };
}

function makeCore({ rejectOnAbort = false } = {}) {
  const listeners = new Set();
  const requests = [];
  const core = {
    status: { state: "ready", revision: 1, core: { capabilities: ["repositorySessions", "repositoryScopes", "historyPagination", "historyNewSinceLastSeen", "historyGraph", "metadataIndex", "activityStats", "commitDetails"] } },
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
  const processed = data.section === "historyPage" ? data.commits.length : data.section === "commits" ? data.commits.length
    : data.section === "repositoryNavigation" ? data.navigation.refs.length + data.navigation.worktrees.length
      : data.section === "refMergeStatus" ? data.result.statuses.length : 1;
  request.options.onChunk?.({ data, done, sequence: 0, repoId: request.context.repoId, generation: request.context.generation,
    coverage: { complete: done, processed }, nextCursor: null });
  request.resolve({ coverage: { complete: true, processed }, nextCursor: null });
}

function sendScopeTransaction(request, nextSession, page) {
  request.options.onChunk?.({ data: { section: "repositorySession", session: nextSession }, done: false, sequence: 0,
    coverage: { complete: false, processed: 0 }, nextCursor: null });
  request.options.onChunk?.({ data: { section: "repository", repository: page.repository, refs: page.refs, refsTruncated: page.refsTruncated },
    done: false, sequence: 1, coverage: { complete: false, processed: 0 }, nextCursor: null });
  request.options.onChunk?.({ data: { section: "historyPage", commits: page.commits, offset: 0, pageSize: page.pageSize,
    cursor: page.cursor, previousCursor: null, hasMore: false, newSinceLastSeenStatus: "firstView", lastSeenDividerOid: null },
  done: true, sequence: 2, coverage: { complete: true, processed: page.commits.length }, nextCursor: null });
  request.resolve({ coverage: { complete: true, processed: page.commits.length }, nextCursor: null });
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

test("scope selection uses the current window session and commits only after the first page", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opening = controller.open("/tmp/repo-a");
  const openRequest = await waitFor(() => core.requests[0]);
  const opened = session("/tmp/repo-a", "a");
  send(openRequest, { section: "repositorySession", session: opened });
  await opening;

  const scope = { ref: "refs/heads/dev" };
  const switching = controller.selectScope(scope, 200);
  const request = await waitFor(() => core.requests[1]);
  assert.equal(request.method, "selectRepositoryScope");
  assert.deepEqual(request.params, { pageSize: 200, scope });
  assert.deepEqual(request.context, { repoId: opened.repoId, generation: opened.generation });
  const next = { ...opened, repoId: "repo-a-next", generation: "generation-a-next", scope, tips: [opened.repository.headOid] };
  const page = { repository: opened.repository, refs: [], refsTruncated: false, commits: [], offset: 0, pageSize: 200,
    cursor: "scope-cursor", previousCursor: null, nextCursor: null, hasMore: false,
    newSinceLastSeenStatus: "firstView", lastSeenDividerOid: null };
  sendScopeTransaction(request, next, page);
  assert.deepEqual(await switching, { session: next, page });
  assert.deepEqual(core.currentContext, { repoId: next.repoId, generation: next.generation });
  controller.dispose();
});

test("navigation and merge status are bound to the current session and bounded", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opening = controller.open("/tmp/repo-a");
  const openRequest = await waitFor(() => core.requests[0]);
  const opened = session("/tmp/repo-a", "a");
  send(openRequest, { section: "repositorySession", session: opened });
  await opening;

  const navigationPromise = controller.getNavigation();
  const navigationRequest = await waitFor(() => core.requests[1]);
  assert.equal(navigationRequest.method, "getRepositoryNavigation");
  assert.deepEqual(navigationRequest.context, { repoId: opened.repoId, generation: opened.generation });
  const navigation = { refs: [], refsTruncated: false, worktrees: [], worktreesTruncated: false, defaultBase: null, observedAtUnixMs: 100,
    remotes: [], branchUpstreams: [], lastFetchUnixMs: null };
  send(navigationRequest, { section: "repositoryNavigation", navigation });
  assert.deepEqual(await navigationPromise, navigation);

  const names = ["refs/heads/main"];
  const statusPromise = controller.getRefMergeStatus(names);
  const statusRequest = await waitFor(() => core.requests[2]);
  assert.equal(statusRequest.method, "refMergeStatus");
  assert.deepEqual(statusRequest.params, { refNames: names });
  assert.deepEqual(statusRequest.context, { repoId: opened.repoId, generation: opened.generation });
  const result = { defaultBase: null, statuses: [{ name: names[0], oid: opened.repository.headOid, status: "unavailable" }] };
  send(statusRequest, { section: "refMergeStatus", result });
  assert.deepEqual(await statusPromise, result);
  await assert.rejects(controller.getRefMergeStatus([names[0], names[0]]), error => error.code === "INVALID_REQUEST");
  await assert.rejects(controller.getRefMergeStatus(Array.from({ length: 51 }, (_, index) => `refs/heads/b${index}`)), error => error.code === "INVALID_REQUEST");
  controller.dispose();
});

test("the real controller accepts daemon navigation and merge-status coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "commitscope-controller-navigation-"));
  const repository = join(root, "repo");
  const core = new CoreProcess(daemonPath, {
    env: { ...process.env, COMMITSCOPE_APP_DATA_DIR: join(root, "app-data"), GIT_OPTIONAL_LOCKS: "0" },
  });
  const controller = new RepositorySessionController(core);
  const git = args => execFileAsync("git", args, { cwd: repository, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  try {
    await execFileAsync("git", ["init", "-b", "main", repository]);
    await git(["config", "user.name", "Controller Test"]);
    await git(["config", "user.email", "controller@example.invalid"]);
    await writeFile(join(repository, "README.txt"), "scope navigation fixture\n");
    await git(["add", "README.txt"]);
    await git(["commit", "-m", "initial"]);
    await git(["checkout", "-b", "feature/merged"]);
    await writeFile(join(repository, "feature.txt"), "feature side\n");
    await git(["add", "feature.txt"]);
    await git(["commit", "-m", "feature change"]);
    await git(["checkout", "main"]);
    await writeFile(join(repository, "main.txt"), "main side\n");
    await git(["add", "main.txt"]);
    await git(["commit", "-m", "main change"]);
    await git(["merge", "--no-ff", "feature/merged", "-m", "merge feature"]);
    await core.start();

    const opened = await controller.open(repository);
    assert.ok(opened.tips.length > 0);
    const navigation = await controller.getNavigation();
    assert.ok(navigation.refs.length >= 2);
    assert.ok(navigation.worktrees.length >= 1);
    assert.equal(navigation.defaultBase?.name, "refs/heads/main");

    const localBranchNames = navigation.refs.filter(ref => ref.kind === "localBranch").map(ref => ref.name);
    const result = await controller.getRefMergeStatus(localBranchNames);
    assert.deepEqual(result.statuses.map(status => status.name).sort(), [...localBranchNames].sort());
    assert.ok(result.statuses.length >= 2);

    const headOid = opened.repository.headOid;
    const details = await controller.getCommit({ oid: headOid.toUpperCase() });
    assert.equal(details.commit.oid, headOid);
    assert.equal(details.commit.parents.length, 2);
    assert.equal(details.observedAtUnixMs, opened.observedAtUnixMs);
    const filePage = await controller.listChangedFiles({ oid: headOid, parentIndex: 0, offset: 0, pageSize: 200 });
    assert.equal(filePage.oid, headOid);
    assert.equal(filePage.parentOid, details.commit.parents[0]);
    const mergePage = await controller.readMergeCommits({ oid: headOid, parentIndex: 1, offset: 0, pageSize: 200 });
    assert.equal(mergePage.oid, headOid);
    assert.equal(mergePage.parentOid, details.commit.parents[1]);
    const containing = await controller.branchesContaining({ oid: headOid });
    assert.equal(containing.observedAtUnixMs, opened.observedAtUnixMs);
    assert.ok(containing.branches.some(ref => ref.name === "refs/heads/main"));

    const located = await controller.locateHistoryDate(4_102_444_800, 200, []);
    assert.ok(located.page.commits.some(commit => commit.oid === located.oid));
    assert.equal("refs" in located.page, false, "date pages reuse the existing snapshot references");
    const reused = await controller.locateHistoryDate(4_102_444_800, 200, [located.cursor]);
    assert.deepEqual(reused, { ...located, page: null }, "a real transport round trip reuses the retained page");

    const selected = await controller.selectScope({ ref: "refs/heads/feature/merged" }, 50);
    assert.equal(selected.session.scope.ref, "refs/heads/feature/merged");
    assert.deepEqual(selected.session.tips, [selected.page.commits[0]?.oid].filter(Boolean));
    const current = await controller.get();
    assert.equal(current.scope.ref, "refs/heads/feature/merged", "the committed scope is now the context for later session reads");

    const indexStatus = await controller.getMetadataIndexStatus();
    assert.ok(["idle", "queued", "running", "paused", "cancelled", "complete", "quotaLimited", "unavailable", "failed"].includes(indexStatus.state));
    assert.equal(indexStatus.coverage.complete, indexStatus.state === "complete");
    assert.equal(typeof indexStatus.coverage.processed, "number");
    assert.ok(indexStatus.snapshotKey === null || typeof indexStatus.snapshotKey === "string");

    const controlledIndexStatus = await controller.controlMetadataIndex("pause");
    assert.ok(["idle", "queued", "running", "paused", "cancelled", "complete", "quotaLimited", "unavailable", "failed"].includes(controlledIndexStatus.state));
    assert.equal(controlledIndexStatus.coverage.complete, controlledIndexStatus.state === "complete");
    await assert.rejects(controller.controlMetadataIndex("invalid"), error => error.code === "INVALID_REQUEST");
  } finally {
    controller.dispose();
    await core.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata index status and control stay bound to the open session", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opening = controller.open("/tmp/repo-a");
  const openRequest = await waitFor(() => core.requests[0]);
  const opened = session("/tmp/repo-a", "a");
  send(openRequest, { section: "repositorySession", session: opened });
  await opening;

  const reading = controller.getMetadataIndexStatus();
  const statusRequest = await waitFor(() => core.requests[1]);
  assert.equal(statusRequest.method, "getMetadataIndexStatus");
  assert.deepEqual(statusRequest.params, {});
  assert.deepEqual(statusRequest.context, { repoId: opened.repoId, generation: opened.generation });
  const status = { snapshotKey: "snapshot-a", state: "running", coverage: { processed: 3, complete: false }, diskBytes: 120, quotaBytes: 1000, error: null };
  send(statusRequest, { section: "metadataIndex", status });
  assert.deepEqual(await reading, status);

  const controlling = controller.controlMetadataIndex("pause");
  const controlRequest = await waitFor(() => core.requests[2]);
  assert.equal(controlRequest.method, "controlMetadataIndex");
  assert.deepEqual(controlRequest.params, { action: "pause" });
  assert.deepEqual(controlRequest.context, { repoId: opened.repoId, generation: opened.generation });
  const paused = { ...status, state: "paused" };
  send(controlRequest, { section: "metadataIndex", status: paused });
  assert.deepEqual(await controlling, paused);
  await assert.rejects(controller.controlMetadataIndex("invalid"), error => error.code === "INVALID_REQUEST");
  controller.dispose();
});

test("a core without repositoryScopes is rejected before opening a session", async () => {
  const core = makeCore();
  core.status.core.capabilities = ["repositorySessions", "historyPagination", "historyNewSinceLastSeen"];
  const controller = new RepositorySessionController(core);
  await assert.rejects(controller.open("/tmp/repo-a"), error => error.code === "UNKNOWN_METHOD" && /只读范围导航/.test(error.message));
  assert.equal(core.requests.length, 0);
  controller.dispose();
});

test("a core without historyGraph is rejected before opening a session", async () => {
  const core = makeCore();
  core.status.core.capabilities = ["repositorySessions", "repositoryScopes", "historyPagination", "historyNewSinceLastSeen"];
  const controller = new RepositorySessionController(core);
  await assert.rejects(controller.open("/tmp/repo-a"), error => error.code === "UNKNOWN_METHOD" && /历史图布局/.test(error.message));
  assert.equal(core.requests.length, 0);
  controller.dispose();
});

test("a core without commitDetails is rejected before opening a session", async () => {
  const core = makeCore();
  core.status.core.capabilities = ["repositorySessions", "repositoryScopes", "historyPagination", "historyNewSinceLastSeen", "historyGraph"];
  const controller = new RepositorySessionController(core);
  await assert.rejects(controller.open("/tmp/repo-a"), error => error.code === "UNKNOWN_METHOD" && /提交详情/.test(error.message));
  assert.equal(core.requests.length, 0);
  controller.dispose();
});

test("commit details requests validate inputs, preserve captured time, and drain cancelled late success", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opening = controller.open("/tmp/repo-a");
  const openRequest = await waitFor(() => core.requests[0]);
  const opened = session("/tmp/repo-a", "a");
  send(openRequest, { section: "repositorySession", session: opened });
  await opening;

  await assert.rejects(controller.getCommit({ oid: "abcd" }), error => error.code === "INVALID_REQUEST");
  await assert.rejects(controller.listChangedFiles({ oid: opened.repository.headOid, parentIndex: -1, offset: 0, pageSize: 20 }), error => error.code === "INVALID_REQUEST");
  assert.equal(core.requests.length, 1);

  const oid = opened.repository.headOid;
  const parents = ["b".repeat(40), "c".repeat(40)];
  const commitDetails = {
    commit: { oid, parents, summary: "merge title", summaryTruncated: false, textLossy: false,
      author: { name: "Author", email: "author@example.invalid", timestamp: "1", offset: "+0000" },
      committer: { name: "Committer", email: "committer@example.invalid", timestamp: "2", offset: "+0000" } },
    message: "merge title\nbody", messageWithoutTrailers: "merge title\nbody", trailers: [], refs: [], worktrees: [],
    observedAtUnixMs: opened.observedAtUnixMs, refsTruncated: false, worktreesTruncated: false,
    update: { state: "unaffected", reason: null, checkedAtUnixMs: 200 },
  };
  const pending = controller.getCommit({ oid: oid.toUpperCase() });
  const lateRequest = await waitFor(() => core.requests[1]);
  assert.equal(lateRequest.method, "getCommit");
  assert.deepEqual(lateRequest.params, { oid });
  assert.equal(lateRequest.options.drainAfterAbort, true);
  const cancel = controller.cancelCommitDetails();
  assert.equal(lateRequest.options.signal.aborted, true);
  lateRequest.options.onChunk({ data: { section: "commitDetails", details: commitDetails }, done: true, sequence: 0,
    repoId: opened.repoId, generation: opened.generation, coverage: { complete: true, processed: 1 }, nextCursor: null });
  lateRequest.resolve({ coverage: { complete: true, processed: 1 }, nextCursor: null });
  await assert.rejects(pending, error => error.code === "CANCELLED");
  assert.deepEqual(await cancel, { cancelled: true });

  const reading = controller.getCommit({ oid });
  const detailsRequest = await waitFor(() => core.requests[2]);
  detailsRequest.options.onChunk({ data: { section: "commitDetails", details: commitDetails }, done: true, sequence: 0,
    repoId: opened.repoId, generation: opened.generation, coverage: { complete: true, processed: 1 }, nextCursor: null });
  detailsRequest.resolve({ coverage: { complete: true, processed: 1 }, nextCursor: null });
  assert.deepEqual(await reading, commitDetails);

  const fileParams = { oid, parentIndex: 0, offset: 0, pageSize: 200 };
  const filePromise = controller.listChangedFiles(fileParams);
  const filesRequest = await waitFor(() => core.requests[3]);
  assert.equal(filesRequest.method, "listChangedFiles");
  const filePage = { oid, parentIndex: 0, parentOid: parents[0], offset: 0, pageSize: 200, totalFiles: 0, hasMore: false, files: [],
    overview: { totalFiles: 0, counts: { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, typeChanged: 0 }, additions: 0, deletions: 0, binaryFiles: 0, gitlinkFiles: 0, directories: [] } };
  filesRequest.options.onChunk({ data: { section: "changedFiles", page: filePage }, done: true, sequence: 0,
    repoId: opened.repoId, generation: opened.generation, coverage: { complete: true, processed: 0 }, nextCursor: null });
  filesRequest.resolve({ coverage: { complete: true, processed: 0 }, nextCursor: null });
  assert.deepEqual(await filePromise, filePage);

  const mergePromise = controller.readMergeCommits({ oid, parentIndex: 1, offset: 0, pageSize: 200 });
  const mergeRequest = await waitFor(() => core.requests[4]);
  const mergePage = { oid, parentIndex: 1, parentOid: parents[1], firstParentOid: parents[0], offset: 0, pageSize: 200,
    totalCommits: 0, hasMore: false, commits: [], authors: [] };
  mergeRequest.options.onChunk({ data: { section: "mergeCommits", page: mergePage }, done: true, sequence: 0,
    repoId: opened.repoId, generation: opened.generation, coverage: { complete: true, processed: 0 }, nextCursor: null });
  mergeRequest.resolve({ coverage: { complete: true, processed: 0 }, nextCursor: null });
  assert.deepEqual(await mergePromise, mergePage);

  const containingPromise = controller.branchesContaining({ oid });
  const containingRequest = await waitFor(() => core.requests[5]);
  const containing = { oid, branches: [], observedAtUnixMs: opened.observedAtUnixMs, complete: true, refsTruncated: false, boundaryLimited: false };
  containingRequest.options.onChunk({ data: { section: "branchesContaining", result: containing }, done: true, sequence: 0,
    repoId: opened.repoId, generation: opened.generation, coverage: { complete: true, processed: 0 }, nextCursor: null });
  containingRequest.resolve({ coverage: { complete: true, processed: 0 }, nextCursor: null });
  assert.deepEqual(await containingPromise, containing);
  controller.dispose();
});

test("foreground details cancel and drain activity stats before taking the request slot", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opening = controller.open("/tmp/repo-a");
  const openRequest = await waitFor(() => core.requests[0]);
  const opened = session("/tmp/repo-a", "a");
  send(openRequest, { section: "repositorySession", session: opened });
  openRequest.terminal = true;
  await opening;

  const query = { authors: [], caseSensitive: false, committers: [], fromTimestamp: null, message: "",
    oidPrefix: "", path: null, timeField: "author", timeZone: "UTC", toTimestamp: null };
  const statsRead = controller.getActivityStats({ query });
  const statsRequest = await waitFor(() => core.requests[1]);
  assert.equal(statsRequest.method, "getActivityStats");

  const oid = opened.repository.headOid;
  const detailsRead = controller.getCommit({ oid });
  assert.equal(statsRequest.options.signal.aborted, true, "the passive stats request is cancelled first");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(core.requests.length, 2, "details must wait for the cancelled stats request's terminal drain");

  const stats = { authors: [], authorsTruncated: false, coverage: { processed: 1, complete: true }, days: [], daysTruncated: false,
    index: { snapshotKey: "snapshot-a", state: "complete", coverage: { processed: 1, complete: true }, diskBytes: 1, quotaBytes: 1000, error: null },
    matchedCount: 1, queryKey: "query-a", timeField: "author", timeZone: "UTC" };
  send(statsRequest, { section: "activityStats", stats });
  statsRequest.terminal = true;
  await assert.rejects(statsRead, error => error.code === "CANCELLED");

  const detailsRequest = await waitFor(() => core.requests[2]);
  assert.equal(detailsRequest.method, "getCommit");
  assert.equal(detailsRequest.options.signal.aborted, false);
  assert.equal(core.requests.filter(request => !request.terminal).length, 1, "only the foreground request remains in flight");
  const value = {
    commit: { oid, parents: [], summary: "summary", summaryTruncated: false, textLossy: false,
      author: { name: "Author", email: "author@example.invalid", timestamp: "1", offset: "+0000" },
      committer: { name: "Committer", email: "committer@example.invalid", timestamp: "2", offset: "+0000" } },
    message: "summary", messageWithoutTrailers: "summary", trailers: [], refs: [], worktrees: [],
    observedAtUnixMs: opened.observedAtUnixMs, refsTruncated: false, worktreesTruncated: false,
    update: { state: "unaffected", reason: null, checkedAtUnixMs: 200 },
  };
  send(detailsRequest, { section: "commitDetails", details: value });
  detailsRequest.terminal = true;
  assert.deepEqual(await detailsRead, value);
  controller.dispose();
});

test("merge-status generations cancel and drain superseded and explicitly cancelled requests", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opening = controller.open("/tmp/repo-a");
  const openRequest = await waitFor(() => core.requests[0]);
  const opened = session("/tmp/repo-a", "a");
  send(openRequest, { section: "repositorySession", session: opened });
  await opening;

  const first = assert.rejects(controller.getRefMergeStatus(["refs/heads/first"]), error => error.code === "CANCELLED");
  const firstRequest = await waitFor(() => core.requests[1]);
  const second = assert.rejects(controller.getRefMergeStatus(["refs/heads/second"]), error => error.code === "CANCELLED");
  assert.equal(firstRequest.options.signal.aborted, true);
  send(firstRequest, { section: "refMergeStatus", result: { defaultBase: null, statuses: [
    { name: "refs/heads/first", oid: opened.repository.headOid, status: "unavailable" },
  ] } });
  await first;
  const secondRequest = await waitFor(() => core.requests[2]);
  assert.deepEqual(secondRequest.params, { refNames: ["refs/heads/second"] });
  const cancelling = controller.cancelRefMergeStatus();
  assert.equal(secondRequest.options.signal.aborted, true);
  send(secondRequest, { section: "refMergeStatus", result: { defaultBase: null, statuses: [
    { name: "refs/heads/second", oid: opened.repository.headOid, status: "unavailable" },
  ] } });
  await second;
  assert.deepEqual(await cancelling, { cancelled: true });
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
  const hiddenParent = "b".repeat(40);
  commit.parents = [hiddenParent];
  commit.graph = {
    lane: 8, color: 2, parents: [hiddenParent], boundary: false, above: 0, below: 0, hiddenLaneCount: 5,
    hiddenThroughRanges: [{ startLane: 6, endLane: 7 }],
    segments: [
      { kind: "incoming", fromLane: 9, toLane: 8, color: 3 },
      { kind: "outgoing", fromLane: 8, toLane: 10, color: 4 },
    ],
  };
  request.options.onChunk({ data: { section: "historyPage", commits: [commit], offset: 0, pageSize: 100,
    cursor: "cursor-0", previousCursor: null, hasMore: true, newSinceLastSeenStatus: "firstView", lastSeenDividerOid: null }, done: true, sequence: 1,
    repoId: opened.repoId, generation: opened.generation, coverage: { complete: true, processed: 1 }, nextCursor: "cursor-1" });
  request.resolve({ coverage: { complete: true, processed: 1 }, nextCursor: "cursor-1" });
  const page = await read;
  assert.deepEqual(page.commits, [commit]);
  assert.equal(page.cursor, "cursor-0");
  assert.equal(page.nextCursor, "cursor-1");
  assert.equal(page.newSinceLastSeenStatus, "firstView");
  assert.equal(page.lastSeenDividerOid, null);
  controller.dispose();
});

test("history pages reject missing graphs and graph fields inconsistent with masks or parent boundaries", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opening = controller.open("/tmp/repo-a");
  const openRequest = await waitFor(() => core.requests[0]);
  const opened = session("/tmp/repo-a", "a");
  send(openRequest, { section: "repositorySession", session: opened });
  await opening;

  for (const mutate of [
    commit => { delete commit.graph; },
    commit => { commit.graph.above = 1; },
    commit => { commit.graph.boundary = true; },
    commit => { commit.graph.segments = [{ kind: "through", fromLane: 6, toLane: 7, color: 0 }]; },
    commit => { commit.graph.above = 1; commit.graph.below = 2; commit.graph.segments = [{ kind: "through", fromLane: 0, toLane: 1, color: 0 }]; },
    commit => { commit.graph.above = 1; commit.graph.below = 1; commit.graph.segments = [
      { kind: "through", fromLane: 0, toLane: 0, color: 0 }, { kind: "through", fromLane: 0, toLane: 0, color: 0 },
    ]; },
  ]) {
    const requestStart = core.requests.length;
    const rejected = assert.rejects(controller.readHistoryPage(null, 100), error => error.code === "PROTOCOL_ERROR");
    const request = await waitFor(() => core.requests.slice(requestStart).find(item => item.method === "readHistoryPage"));
    request.options.onChunk({ data: { section: "repository", repository: opened.repository, refs: [], refsTruncated: false },
      done: false, sequence: 0, repoId: opened.repoId, generation: opened.generation,
      coverage: { complete: false, processed: 0 }, nextCursor: null });
    const commit = makeCommit(opened);
    mutate(commit);
    let thrown;
    try {
      request.options.onChunk({ data: { section: "historyPage", commits: [commit], offset: 0, pageSize: 100,
        cursor: "cursor-0", previousCursor: null, hasMore: false, newSinceLastSeenStatus: "firstView", lastSeenDividerOid: null },
      done: true, sequence: 1, repoId: opened.repoId, generation: opened.generation,
      coverage: { complete: true, processed: 1 }, nextCursor: null });
    } catch (error) { thrown = error; }
    assert.equal(thrown?.code, "PROTOCOL_ERROR");
    request.reject(thrown);
    await rejected;
  }
  controller.dispose();
});

test("history page rejects marker metadata that changes within one chunked page", async () => {
  const core = makeCore();
  const controller = new RepositorySessionController(core);
  const opening = controller.open("/tmp/repo-a");
  const openRequest = await waitFor(() => core.requests[0]);
  const opened = session("/tmp/repo-a", "a");
  send(openRequest, { section: "repositorySession", session: opened });
  await opening;

  const read = controller.readHistoryPage(null, 100);
  const rejected = assert.rejects(read, error => error.code === "PROTOCOL_ERROR");
  const request = await waitFor(() => core.requests[1]);
  request.options.onChunk({ data: { section: "repository", repository: opened.repository, refs: [], refsTruncated: false },
    done: false, sequence: 0, repoId: opened.repoId, generation: opened.generation,
    coverage: { complete: false, processed: 0 }, nextCursor: null });
  request.options.onChunk({ data: { section: "historyPage", commits: [], offset: 0, pageSize: 100, cursor: "cursor-0",
    previousCursor: null, hasMore: false, newSinceLastSeenStatus: "ready", lastSeenDividerOid: null },
  done: false, sequence: 1, repoId: opened.repoId, generation: opened.generation,
  coverage: { complete: false, processed: 0 }, nextCursor: null });
  let thrown;
  try {
    request.options.onChunk({ data: { section: "historyPage", commits: [], offset: 0,
      pageSize: 100, cursor: "cursor-0", previousCursor: null, hasMore: false,
      newSinceLastSeenStatus: "unavailable", lastSeenDividerOid: null }, done: true, sequence: 2,
    repoId: opened.repoId, generation: opened.generation,
    coverage: { complete: true, processed: 0 }, nextCursor: null });
  } catch (error) { thrown = error; }
  assert.equal(thrown?.code, "PROTOCOL_ERROR");
  request.reject(thrown);
  await rejected;
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
    { section: "historyPage", commits: [commit], offset: 0, pageSize: 100, cursor: "fresh-0", previousCursor: null, hasMore: false,
      newSinceLastSeenStatus: "firstView", lastSeenDividerOid: null },
  ];
  chunks.forEach((data, sequence) => request.options.onChunk({ data, sequence, done: sequence === 2,
    repoId: oldSession.repoId, generation: oldSession.generation,
    coverage: { complete: sequence === 2, processed: sequence === 2 ? 1 : 0 }, nextCursor: null }));
  request.resolve({ coverage: { complete: true, processed: 1 }, nextCursor: null });
  const value = await refreshing;
  assert.equal(value.session, refreshed);
  assert.deepEqual(value.page.commits, [commit]);
  assert.equal(value.page.newSinceLastSeenStatus, "firstView");
  assert.equal(value.page.lastSeenDividerOid, null);
  assert.deepEqual(core.currentContext, { repoId: refreshed.repoId, generation: refreshed.generation });
  controller.dispose();
});
