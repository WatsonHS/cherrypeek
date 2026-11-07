import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, realpath, symlink, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionDaemonClient, createDaemonEnvironment } from "./daemon-client.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const execFileAsync = promisify(execFile);
const fixtureRoot = await realpath(resolve(process.env.COMMITSCOPE_FIXTURE_ROOT));
const manifest = JSON.parse(await readFile(resolve(process.env.COMMITSCOPE_FIXTURE_MANIFEST), "utf8"));
const daemonPath = resolve(process.env.COMMITSCOPE_DAEMON_PATH);

test("session freezes the displayed HEAD, records recent on open, and records tips only on explicit view", async () => {
  const repositoryPath = join(fixtureRoot, "topology");
  const appData = resolve(process.env.COMMITSCOPE_SESSION_DATA_DIR);
  const fixtureBefore = await snapshotTree(fixtureRoot);
  let fixtureAfterExternalAdvance;
  const client = await startClient(appData);
  let opened;
  let firstSession;
  try {
    opened = await openSession(client, join(repositoryPath, "nested", "deep"));
    firstSession = opened;
    assert.equal(opened.repository.path, repositoryPath);
    assert.equal(opened.scope, "head");
    assert.equal(opened.repository.headOid, manifest.fixtures.topology.headOid);
    assert.equal(opened.previousView, null, "first open has no previous view");
    assert.equal(opened.persistence.recent, "ok");
    assert.equal(opened.persistence.lastSeen, "ok");
    const recent = await recentRepositories(client);
    assert.equal(recent.status, "ok");
    assert.equal(recent.repositories.length, 1);
    assert.equal(recent.repositories[0].path, repositoryPath);
    assert.equal(await exists(join(appData, "recent-repositories-v1.json")), true);
    assert.equal(await exists(join(appData, "last-viewed-tips-v1.json")), false, "opening alone must not mark the snapshot viewed");

    const beforeAdvance = await readSessionPreview(client, opened);
    assert.equal(beforeAdvance.repository.headOid, opened.repository.headOid);
    assert.deepEqual(await snapshotTree(fixtureRoot), fixtureBefore, "opening and reading must not change the fixture");
    const displayedTip = opened.repository.headOid;
    const newTip = await createEmptyCommit(repositoryPath, "external advance");
    assert.notEqual(newTip, displayedTip);
    fixtureAfterExternalAdvance = await snapshotTree(fixtureRoot);

    const stillOpen = await getSession(client, opened);
    assert.equal(stillOpen.repository.headOid, displayedTip, "the active session stays on its captured tip");
    const frozenPreview = await readSessionPreview(client, opened);
    assert.equal(frozenPreview.repository.headOid, displayedTip);
    assert.equal(frozenPreview.commits[0].oid, displayedTip);

    const recorded = await client.recordView(opened);
    assert.deepEqual(recorded.data, { section: "repositoryViewRecorded", saved: true, status: "ok" });
    await client.closeSession(opened);
    opened = null;
  } finally {
    await client.stop();
  }

  const clientAfterRestart = await startClient(appData);
  try {
    await assert.rejects(clientAfterRestart.getSession(firstSession), error => error.code === "STALE_CONTEXT");
    await assert.rejects(clientAfterRestart.recordView(firstSession), error => error.code === "STALE_CONTEXT");
    const reopened = await openSession(clientAfterRestart, repositoryPath);
    assert.notEqual(reopened.repository.headOid, manifest.fixtures.topology.headOid);
    assert.deepEqual(reopened.previousView.tips, [manifest.fixtures.topology.headOid], "the saved tips come from the displayed old snapshot, not the current HEAD");
    assert.equal(reopened.previousView.viewedAtUnixMs > 0, true);
    await readSessionPreview(clientAfterRestart, reopened);
    await clientAfterRestart.closeSession(reopened);
  } finally {
    await clientAfterRestart.stop();
  }
  assert.deepEqual(await snapshotTree(fixtureRoot), fixtureAfterExternalAdvance, "the application must write state outside the viewed repositories and commonDir");
});

test("an explicitly viewed empty HEAD remains an empty previous tip set after its first commit", async () => {
  const repositoryPath = join(fixtureRoot, "empty");
  const appData = resolve(process.env.COMMITSCOPE_SESSION_EMPTY_DATA_DIR);
  const client = await startClient(appData);
  try {
    const empty = await openSession(client, repositoryPath);
    assert.equal(empty.repository.headOid, null);
    assert.equal(empty.previousView, null);
    const preview = await readSessionPreview(client, empty);
    assert.deepEqual(preview.commits, []);
    assert.equal((await client.recordView(empty)).data.saved, true);
    await client.closeSession(empty);
  } finally {
    await client.stop();
  }

  await createEmptyCommit(repositoryPath, "first commit after viewed empty head");
  const nextClient = await startClient(appData);
  try {
    const session = await openSession(nextClient, repositoryPath);
    assert.ok(session.repository.headOid);
    assert.deepEqual(session.previousView.tips, [], "empty viewed history differs from never-viewed null");
    await nextClient.closeSession(session);
  } finally {
    await nextClient.stop();
  }
});

test("linked worktree identity is separate while commonDir is shared, and failed opens retain current session", async () => {
  const appData = resolve(process.env.COMMITSCOPE_SESSION_WORKTREE_DATA_DIR);
  await mkdir(join(fixtureRoot, "not-a-repository"), { recursive: true });
  const client = await startClient(appData);
  try {
    const primary = await openSession(client, join(fixtureRoot, "topology", "nested"));
    const linkedPath = join(fixtureRoot, "linked-worktree");
    const linkedHead = await gitText(linkedPath, ["rev-parse", "HEAD"]);
    const expectedCommonDir = await gitText(linkedPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    assert.equal(primary.repository.commonDir, expectedCommonDir);

    await assert.rejects(client.open(join(fixtureRoot, "not-a-repository")), error => error.code === "NOT_A_REPOSITORY");
    assert.equal((await getSession(client, primary)).repoId, primary.repoId, "failed discovery must not replace an open session");

    const linked = await openSession(client, linkedPath);
    assert.equal(linked.repository.headOid, linkedHead);
    assert.equal(linked.repository.commonDir, primary.repository.commonDir);
    assert.equal(linked.repositoryKey, primary.repositoryKey);
    assert.notEqual(linked.worktreeId, primary.worktreeId);
    await assert.rejects(client.closeSession(primary), error => error.code === "STALE_CONTEXT");
    assert.equal((await getSession(client, linked)).repoId, linked.repoId, "a stale close must not close the replacement session");

    const canonicalAgain = await openSession(client, join(fixtureRoot, "topology", "nested", "deep"));
    assert.equal(canonicalAgain.repositoryKey, primary.repositoryKey);
    assert.equal(canonicalAgain.worktreeId, primary.worktreeId, "subdirectory opens resolve to the same worktree identity");
    const recent = await recentRepositories(client);
    assert.equal(recent.repositories.length, 2, "recent entries dedupe the main worktree but retain the linked one");
  } finally {
    await client.stop();
  }
});

test("main and linked worktrees persist independent last-viewed tips", async () => {
  const appData = resolve(process.env.COMMITSCOPE_SESSION_WORKTREE_VIEW_DATA_DIR);
  const primaryPath = join(fixtureRoot, "topology");
  const linkedPath = join(fixtureRoot, "linked-worktree");
  const primaryHead = await gitText(primaryPath, ["rev-parse", "HEAD"]);
  const linkedHead = await gitText(linkedPath, ["rev-parse", "HEAD"]);
  const client = await startClient(appData);
  try {
    const primaryFirst = await openSession(client, primaryPath);
    assert.equal(primaryFirst.previousView, null);
    assert.equal((await client.recordView(primaryFirst)).data.saved, true);
    await client.closeSession(primaryFirst);

    const linkedFirst = await openSession(client, linkedPath);
    assert.equal(linkedFirst.previousView, null, "the primary worktree record must not leak to its linked worktree");
    assert.equal((await client.recordView(linkedFirst)).data.saved, true);
    await client.closeSession(linkedFirst);

    const primaryAgain = await openSession(client, primaryPath);
    assert.deepEqual(primaryAgain.previousView.tips, [primaryHead]);
    await client.closeSession(primaryAgain);

    const linkedAgain = await openSession(client, linkedPath);
    assert.deepEqual(linkedAgain.previousView.tips, [linkedHead]);
    await client.closeSession(linkedAgain);
  } finally {
    await client.stop();
  }
});

test("bare, symlink-entered, and SHA-256 repositories resolve into valid sessions", async () => {
  const appData = resolve(process.env.COMMITSCOPE_SESSION_DISCOVERY_DATA_DIR);
  const client = await startClient(appData);
  const topologyPath = join(fixtureRoot, "topology");
  const aliasPath = join(resolve(process.env.COMMITSCOPE_FIXTURE_PARENT), "topology-alias");
  if (process.platform !== "win32") await symlink(topologyPath, aliasPath);
  try {
    const normal = await openSession(client, topologyPath);
    const bare = await openSession(client, join(fixtureRoot, "bare"));
    assert.equal(bare.repository.isBare, true);
    assert.equal(bare.repository.worktreePath, null);
    assert.equal(bare.repository.path, bare.repository.gitDir);
    assert.notEqual(bare.worktreeId, normal.worktreeId);

    if (process.platform !== "win32") {
      const symlinkOpened = await openSession(client, aliasPath);
      assert.equal(symlinkOpened.repository.path, topologyPath);
      assert.equal(symlinkOpened.repositoryKey, normal.repositoryKey);
      assert.equal(symlinkOpened.worktreeId, normal.worktreeId);
    }
    if (manifest.capabilities.sha256) {
      const sha256 = await openSession(client, join(fixtureRoot, "sha256"));
      assert.equal(sha256.repository.objectFormat, "sha256");
      assert.equal(sha256.repository.headOid.length, 64);
      assert.equal(sha256.previousView, null);
    }
  } finally {
    await client.stop();
  }
});

test("superseding/cancelling opens and closing during a query reject stale work and reap Git", async () => {
  if (process.platform === "win32") return;
  const dataDir = resolve(process.env.COMMITSCOPE_SESSION_RACE_DATA_DIR);
  const slowBin = resolve(process.env.COMMITSCOPE_SESSION_SLOW_GIT_DIRECTORY);
  const slowPath = join(fixtureRoot, "topology");
  const pidFile = resolve(process.env.COMMITSCOPE_SESSION_SLOW_PID_FILE);
  const env = createDaemonEnvironment(dataDir, {
    PATH: `${slowBin}:${process.env.PATH}`,
    COMMITSCOPE_SESSION_SLOW_OPEN_REPOSITORY: slowPath,
    COMMITSCOPE_SESSION_SLOW_QUERY_REPOSITORY: join(fixtureRoot, "detached"),
    COMMITSCOPE_SESSION_SLOW_PID_FILE: pidFile,
  });
  const client = new SessionDaemonClient(daemonPath, { cwd: process.cwd(), env });
  await client.start();
  try {
    const slowOpen = client.beginOpen(slowPath);
    const slowOpenPid = await waitForFileNumber(pidFile);
    const fastOpen = await openSession(client, join(fixtureRoot, "detached"));
    await assert.rejects(slowOpen.result, error => error.code === "CANCELLED");
    await waitForProcessExit(slowOpenPid);
    assert.equal((await getSession(client, fastOpen)).repoId, fastOpen.repoId, "late open A must not replace open B");

    await removeFileIfPresent(pidFile);
    const cancelledOpen = client.beginOpen(slowPath);
    const cancelledPid = await waitForFileNumber(pidFile);
    client.cancel(cancelledOpen.requestId);
    await assert.rejects(cancelledOpen.result, error => error.code === "CANCELLED");
    await waitForProcessExit(cancelledPid);
    assert.equal((await getSession(client, fastOpen)).repoId, fastOpen.repoId, "cancelled candidate must leave the current session intact");
    const recentAfterCancellation = await recentRepositories(client);
    assert.equal(recentAfterCancellation.repositories.some(item => item.path === slowPath), false, "cancelled opens must not enter recent repositories");

    await removeFileIfPresent(pidFile);
    const pendingPreview = client.beginReadPreview(fastOpen);
    const queryPid = await waitForFileNumber(pidFile, 5000);
    await client.closeSession(fastOpen);
    await assert.rejects(pendingPreview.result, error => error.code === "CANCELLED");
    await waitForProcessExit(queryPid);
    await assert.rejects(client.recordView(fastOpen), error => error.code === "STALE_CONTEXT");
  } finally {
    await client.stop();
  }
});

test("corrupt or symlinked last-viewed state disables marking without blocking repository browsing", async () => {
  const repositoryPath = join(fixtureRoot, "topology");
  const corruptDir = resolve(process.env.COMMITSCOPE_SESSION_CORRUPT_DATA_DIR);
  await mkdir(corruptDir, { recursive: true });
  const corruptFile = join(corruptDir, "last-viewed-tips-v1.json");
  const corruptBytes = "{invalid json";
  await writeFile(corruptFile, corruptBytes);
  const corruptClient = await startClient(corruptDir);
  try {
    const session = await openSession(corruptClient, repositoryPath);
    assert.equal(session.persistence.recent, "ok");
    assert.equal(session.persistence.lastSeen, "corrupt");
    assert.equal(session.previousView, null);
    await readSessionPreview(corruptClient, session);
    const recorded = await corruptClient.recordView(session);
    assert.equal(recorded.data.saved, false);
    assert.equal(recorded.data.status, "corrupt");
    assert.equal(await readFile(corruptFile, "utf8"), corruptBytes, "corrupt input must not be replaced with an empty store");
    await corruptClient.closeSession(session);
  } finally {
    await corruptClient.stop();
  }

  if (process.platform !== "win32") {
    const symlinkDir = resolve(process.env.COMMITSCOPE_SESSION_SYMLINK_DATA_DIR);
    await mkdir(symlinkDir, { recursive: true });
    const outside = resolve(process.env.COMMITSCOPE_SESSION_SYMLINK_TARGET);
    const outsideBytes = JSON.stringify({ schemaVersion: 1, entries: [] });
    await writeFile(outside, outsideBytes);
    await symlink(outside, join(symlinkDir, "last-viewed-tips-v1.json"));
    const symlinkClient = await startClient(symlinkDir);
    try {
      const session = await openSession(symlinkClient, repositoryPath);
      assert.equal(session.persistence.lastSeen, "corrupt");
      assert.equal(session.persistence.recent, "ok");
      await readSessionPreview(symlinkClient, session);
      assert.equal((await symlinkClient.recordView(session)).data.saved, false);
      assert.equal(await readFile(outside, "utf8"), outsideBytes, "state reads must not follow file symlinks");
      await symlinkClient.closeSession(session);
    } finally {
      await symlinkClient.stop();
    }
  }
});

test("unsafe or unavailable app-data locations never block the fixed session preview", async () => {
  const repositoryPath = join(fixtureRoot, "topology");
  const insideRepository = join(repositoryPath, ".commitscope-session-data");
  const client = await startClient(insideRepository);
  try {
    const session = await openSession(client, repositoryPath);
    assert.equal(session.persistence.recent, "unavailable");
    assert.equal(session.persistence.lastSeen, "unavailable");
    const preview = await readSessionPreview(client, session);
    assert.equal(preview.repository.headOid, session.repository.headOid);
    assert.equal(await exists(insideRepository), false, "unsafe app-data path must not be created");
    await client.closeSession(session);
  } finally {
    await client.stop();
  }

  const relativeClient = new SessionDaemonClient(daemonPath, {
    cwd: process.cwd(),
    env: createDaemonEnvironment("relative-session-store"),
  });
  await relativeClient.start();
  try {
    const session = await openSession(relativeClient, repositoryPath);
    assert.equal(session.persistence.recent, "unavailable");
    assert.equal(session.persistence.lastSeen, "unavailable");
    await readSessionPreview(relativeClient, session);
    await relativeClient.closeSession(session);
  } finally {
    await relativeClient.stop();
  }
});

test("unknown versions, oversized files, and permission failures degrade persistence without blocking browse", async () => {
  const repositoryPath = join(fixtureRoot, "topology");
  const cases = [
    { dataDir: resolve(process.env.COMMITSCOPE_SESSION_UNKNOWN_VERSION_DATA_DIR), bytes: JSON.stringify({ schemaVersion: 99, entries: [] }) },
    { dataDir: resolve(process.env.COMMITSCOPE_SESSION_OVERSIZE_DATA_DIR), bytes: " ".repeat(1024 * 1024 + 1) },
  ];
  for (const scenario of cases) {
    await mkdir(scenario.dataDir, { recursive: true });
    const stateFile = join(scenario.dataDir, "last-viewed-tips-v1.json");
    await writeFile(stateFile, scenario.bytes);
    const client = await startClient(scenario.dataDir);
    try {
      const session = await openSession(client, repositoryPath);
      assert.equal(session.persistence.lastSeen, "corrupt");
      assert.equal(session.previousView, null);
      await readSessionPreview(client, session);
      assert.equal((await client.recordView(session)).data.saved, false);
      assert.equal(await readFile(stateFile, "utf8"), scenario.bytes, "unrecognized state is not overwritten");
      await client.closeSession(session);
    } finally {
      await client.stop();
    }
  }

  if (process.platform !== "win32" && process.geteuid?.() !== 0) {
    const dataDir = resolve(process.env.COMMITSCOPE_SESSION_PERMISSION_DATA_DIR);
    await mkdir(dataDir, { recursive: true });
    await chmod(dataDir, 0o500);
    const client = await startClient(dataDir);
    try {
      const session = await openSession(client, repositoryPath);
      assert.equal(session.persistence.recent, "unavailable");
      assert.equal(session.persistence.lastSeen, "ok", "reading a missing last-viewed file does not require write permission");
      await readSessionPreview(client, session);
      const recorded = await client.recordView(session);
      assert.equal(recorded.data.saved, false);
      assert.equal(recorded.data.status, "unavailable");
      await client.closeSession(session);
    } finally {
      await client.stop();
      await chmod(dataDir, 0o700);
    }
  }
});

test("an inaccessible repository reports PERMISSION_DENIED without affecting another session", async () => {
  if (process.platform === "win32" || process.geteuid?.() === 0) return;
  const deniedPath = resolve(process.env.COMMITSCOPE_SESSION_DENIED_REPOSITORY);
  await mkdir(deniedPath, { recursive: true });
  await chmod(deniedPath, 0);
  const client = await startClient(resolve(process.env.COMMITSCOPE_SESSION_DENIED_DATA_DIR));
  try {
    await assert.rejects(client.open(deniedPath), error => error.code === "PERMISSION_DENIED");
    const recent = await recentRepositories(client);
    assert.equal(recent.repositories.some(entry => entry.path === deniedPath), false);
  } finally {
    await client.stop();
    await chmod(deniedPath, 0o700);
  }
});

async function startClient(dataDir) {
  const client = new SessionDaemonClient(daemonPath, { cwd: process.cwd(), env: createDaemonEnvironment(dataDir) });
  try {
    await client.start();
    return client;
  } catch (error) {
    await client.stop().catch(() => {});
    throw error;
  }
}

async function openSession(client, path) {
  const result = await client.open(path);
  assert.equal(result.data.section, "repositorySession");
  return result.data.session;
}

async function getSession(client, session) {
  const result = await client.getSession(session);
  assert.equal(result.data.section, "repositorySession");
  return result.data.session;
}

async function recentRepositories(client) {
  const result = await client.listRecent();
  assert.equal(result.data.section, "recentRepositories");
  return result.data;
}

async function readSessionPreview(client, session) {
  const result = await client.readPreview(session);
  const repositoryChunk = result.chunks.find(chunk => chunk.data.section === "repository");
  assert.ok(repositoryChunk);
  const commits = result.chunks.filter(chunk => chunk.data.section === "commits").flatMap(chunk => chunk.data.commits);
  return { repository: repositoryChunk.data.repository, refs: repositoryChunk.data.refs, commits, completion: result.completion };
}

async function createEmptyCommit(repository, message) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_AUTHOR_NAME: "Session Test",
    GIT_AUTHOR_EMAIL: "session-test@example.invalid",
    GIT_COMMITTER_NAME: "Session Test",
    GIT_COMMITTER_EMAIL: "session-test@example.invalid",
    GIT_AUTHOR_DATE: "2026-11-07T12:00:00+0800",
    GIT_COMMITTER_DATE: "2026-11-07T12:00:00+0800",
  });
  await execFileAsync("git", ["-C", repository, "-c", "user.name=Session Test", "-c", "user.email=session-test@example.invalid", "commit", "--allow-empty", "-m", message], { env, timeout: 10000 });
  return gitText(repository, ["rev-parse", "HEAD"]);
}

async function gitText(repository, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const { stdout } = await execFileAsync("git", ["--no-pager", "-C", repository, ...args], { env, timeout: 5000 });
  return stdout.trim();
}

async function waitForFileNumber(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(value) && value > 0) return value;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Timed out waiting for slow Git PID file ${path}`);
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Git child ${pid} remained alive after cancellation or close`);
}

async function removeFileIfPresent(path) {
  const { unlink } = await import("node:fs/promises");
  try { await unlink(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
