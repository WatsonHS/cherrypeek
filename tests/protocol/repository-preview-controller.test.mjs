import test from "node:test";
import assert from "node:assert/strict";
import { loadBuilt, waitFor } from "./test-utils.mjs";

const { RepositoryPreviewController } = await loadBuilt("repository-preview-controller");

function makeCore({ rejectOnAbort = true } = {}) {
  const listeners = new Set();
  const requests = [];
  const core = {
    status: { state: "ready", revision: 1, core: { capabilities: ["readRepositoryPreview"] } },
    getStatus() { return this.status; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emitStatus(status) {
      this.status = status;
      for (const listener of listeners) listener(status);
    },
    request(method, params, context, options) {
      assert.equal(method, "readRepositoryPreview");
      assert.match(params.path, /^\/tmp\/repository(?:-[ab])?$/);
      assert.deepEqual(context, { repoId: null, generation: null });
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      promise.catch(() => {});
      const request = { options, params, resolve, reject };
      if (rejectOnAbort) {
        const onAbort = () => reject(Object.assign(new Error("aborted"), { code: "CANCELLED" }));
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      requests.push(request);
      return promise;
    },
    requests,
  };
  return core;
}

function repositoryData(path = "/tmp/repository", marker = "a") {
  return {
    section: "repository",
    repository: { path, gitDir: `${path}/.git`, commonDir: `${path}/.git`, worktreePath: null, isBare: false, isShallow: false, objectFormat: "sha1", headOid: marker.repeat(40), headReference: "refs/heads/main" },
    refs: [],
    refsTruncated: false,
  };
}
function commitsData(marker = "a") {
  return {
  section: "commits",
  commits: [{ oid: marker.repeat(40), parents: [], summary: `root-${marker}`, summaryTruncated: false, textLossy: false,
    author: { name: "Author", email: "a@example.invalid", timestamp: "1", offset: "+0000" },
    committer: { name: "Committer", email: "c@example.invalid", timestamp: "2", offset: "+0000" } }],
  hasMore: false,
  };
}

test("controller publishes ready only after ordered preview chunks and matching complete coverage", async () => {
  const core = makeCore();
  const controller = new RepositoryPreviewController(core);
  const opening = controller.open("/tmp/repository");
  const request = await waitFor(() => core.requests[0]);
  request.options.onChunk({ data: repositoryData(), done: false });
  request.options.onChunk({ data: commitsData(), done: true });
  request.resolve({ coverage: { complete: true, processed: 1 }, nextCursor: null });
  await opening;
  assert.equal(controller.getState().state, "ready");
  assert.equal(controller.getState().commits[0].author.name, "Author");
  assert.equal(controller.getState().commits[0].committer.name, "Committer");
  controller.dispose();
});

test("unexpected sections and incomplete final metadata remain errors instead of ready", async () => {
  for (const scenario of ["section", "coverage"]) {
    const core = makeCore();
    const controller = new RepositoryPreviewController(core);
    const opening = controller.open("/tmp/repository");
    const request = await waitFor(() => core.requests[0]);
    if (scenario === "section") {
      request.options.onChunk({ data: repositoryData(), done: false });
      try { request.options.onChunk({ data: { section: "core", coreVersion: "x", pid: 1 }, done: true }); }
      catch (error) { request.reject(error); }
    } else {
      request.options.onChunk({ data: repositoryData(), done: false });
      request.options.onChunk({ data: commitsData(), done: true });
      request.resolve({ coverage: { complete: false, processed: 1 }, nextCursor: null });
    }
    await opening;
    assert.equal(controller.getState().state, "error");
    controller.dispose();
  }
});

test("cancelled request ignores late chunks from the prior repository operation", async () => {
  const core = makeCore();
  const controller = new RepositoryPreviewController(core);
  const opening = controller.open("/tmp/repository");
  const request = await waitFor(() => core.requests[0]);
  controller.cancel();
  request.options.onChunk({ data: repositoryData(), done: false });
  await opening;
  assert.equal(controller.getState().state, "cancelled");
  assert.equal(controller.getState().repository, null);
  controller.dispose();
});

test("opening B supersedes A; A late chunks, rejection, and finally cannot overwrite B ready", async () => {
  const core = makeCore({ rejectOnAbort: false });
  const controller = new RepositoryPreviewController(core);
  const openingA = controller.open("/tmp/repository-a");
  const requestA = await waitFor(() => core.requests[0]);
  const openingB = controller.open("/tmp/repository-b");
  const requestB = await waitFor(() => core.requests[1]);

  requestB.options.onChunk({ data: repositoryData("/tmp/repository-b", "b"), done: false });
  requestB.options.onChunk({ data: commitsData("b"), done: true });
  requestB.resolve({ coverage: { complete: true, processed: 1 }, nextCursor: null });
  await openingB;
  assert.equal(controller.getState().state, "ready");
  assert.equal(controller.getState().repository.path, "/tmp/repository-b");
  assert.equal(controller.getState().commits[0].summary, "root-b");

  requestA.options.onChunk({ data: repositoryData("/tmp/repository-a", "a"), done: false });
  requestA.reject(Object.assign(new Error("late A failure"), { code: "CORE_EXITED" }));
  await openingA;
  assert.equal(controller.getState().state, "ready");
  assert.equal(controller.getState().repository.path, "/tmp/repository-b");
  assert.deepEqual(controller.getState().commits.map(commit => commit.summary), ["root-b"]);
  controller.dispose();
});

test("core exit after partial chunks retains observed data and leaves loading", async () => {
  const core = makeCore();
  const controller = new RepositoryPreviewController(core);
  const opening = controller.open("/tmp/repository");
  const request = await waitFor(() => core.requests[0]);
  request.options.onChunk({ data: repositoryData(), done: false });
  request.options.onChunk({ data: commitsData(), done: true });
  assert.equal(controller.getState().state, "loading");

  core.emitStatus({ state: "error", revision: 2, message: "daemon stopped" });
  await opening;
  assert.equal(controller.getState().state, "error");
  assert.equal(controller.getState().repository.path, "/tmp/repository");
  assert.equal(controller.getState().commits[0].summary, "root-a");
  assert.equal(controller.getState().error.code, "CORE_EXITED");
  controller.dispose();
});
