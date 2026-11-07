import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { RepositorySessionStore } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "repository-session-store.mjs")));

const METHODS = ["openRepositorySession", "getRepositorySession", "readSessionPreview", "recordRepositoryView", "closeRepositorySession"];

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
  return {
    api,
    calls,
    pending,
    names: () => calls.map(call => call.name),
    async answer(name, value) {
      await settled();
      const call = pending[name].shift();
      assert.ok(call, `expected a pending ${name} call`);
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
      oid, parents: [], summary: `summary ${session.repoId}`, summaryTruncated: false, textLossy: false,
      author: { name: "A", email: "a@example.invalid", timestamp: "1", offset: "+0000" },
      committer: { name: "C", email: "c@example.invalid", timestamp: "2", offset: "+0000" },
    }],
    hasMore: false,
  };
}

/** Opens `id` and answers every call so the store ends ready. */
async function openReady(fake, store, id) {
  const session = makeSession(id);
  const done = store.open(`/repos/${id}`);
  if (store.getView().session) await fake.answer("recordRepositoryView", ok({ saved: true, status: "ok" }));
  await fake.answer("openRepositorySession", ok(session));
  await fake.answer("readSessionPreview", ok(makePreview(session)));
  await done;
  return session;
}

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

  await fake.answer("readSessionPreview", ok(makePreview(session)));
  await done;
  const view = store.getView();
  assert.equal(view.state, "ready");
  assert.equal(view.commits.length, 1);
  assert.equal(view.commits[0].summary, "summary repo-a");
  assert.deepEqual(fake.calls[0], { name: "openRepositorySession", args: ["/repos/a"] });
  assert.ok(notifications >= 3);
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
  await fake.answer("readSessionPreview", ok(makePreview(sessionB)));
  await second;
  assert.equal(store.getView().session, sessionB);

  await fake.answer("openRepositorySession", ok(makeSession("a")));
  await first;
  assert.equal(store.getView().session, sessionB);
  assert.equal(store.getView().commits[0].summary, "summary repo-b");
  assert.equal(fake.pending.readSessionPreview.length, 0, "the superseded open must not read its preview");
});

test("a page that arrives after a newer open started does not replace the newer view", async () => {
  const fake = fakeApi();
  const store = new RepositorySessionStore(fake.api);
  const sessionA = makeSession("a");
  const first = store.open("/repos/a");
  await fake.answer("openRepositorySession", ok(sessionA));
  assert.equal(fake.pending.readSessionPreview.length, 1);

  const second = store.open("/repos/b");
  await fake.answer("readSessionPreview", ok(makePreview(sessionA)));
  await first;
  assert.equal(store.getView().state, "loading");
  assert.equal(store.getView().opening, "/repos/b");
  assert.equal(store.getView().commits.length, 0);

  const sessionB = makeSession("b");
  await fake.answer("openRepositorySession", ok(sessionB));
  await fake.answer("readSessionPreview", ok(makePreview(sessionB)));
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
  assert.equal(fake.pending.readSessionPreview.length, 0);
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
  await fake.answer("readSessionPreview", err("MISSING_OBJECT", "missing"));
  await done;
  assert.equal(store.getView().state, "error");
  assert.equal(store.getView().repository.path, "/repos/a");
  assert.equal(store.getView().error.code, "MISSING_OBJECT");

  const retried = store.retry();
  assert.equal(store.getView().state, "loading");
  assert.equal(store.getView().error, null);
  await fake.answer("readSessionPreview", ok(makePreview(session)));
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
  await fake.answer("readSessionPreview", ok(makePreview(session)));
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
  await fake.answer("readSessionPreview", ok(makePreview(sessionB)));
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
