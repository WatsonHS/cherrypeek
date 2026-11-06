import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DaemonClient } from "./daemon-client.mjs";
import { snapshotTree } from "./snapshot.mjs";

const fixtureRoot = await realpath(resolve(process.env.COMMITSCOPE_FIXTURE_ROOT));
const manifest = JSON.parse(await readFile(resolve(process.env.COMMITSCOPE_FIXTURE_MANIFEST), "utf8"));
const daemonPath = resolve(process.env.COMMITSCOPE_DAEMON_PATH);
const helperDirectory = resolve(process.env.COMMITSCOPE_REMOTE_HELPER_DIR);
const sentinelPath = resolve(process.env.COMMITSCOPE_FETCH_SENTINEL);
const executionSentinel = resolve(process.env.COMMITSCOPE_EXEC_SENTINEL);
const sentinelProgram = resolve(process.env.COMMITSCOPE_EXEC_SENTINEL_PROGRAM);
const hooksDirectory = resolve(process.env.COMMITSCOPE_HOOKS_DIR);
const gitEnvironment = cleanGitEnvironment({ GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });

test("daemon returns the real HEAD preview matching independent Git output", async () => {
  const client = await startDaemon();
  const before = await snapshotTree(fixtureRoot);
  try {
    const { chunks, completion } = await withReadOnlySnapshot(() => client.readRepositoryPreview(join(fixtureRoot, "topology")));
    const preview = collectPreview(chunks);
    const expected = manifest.fixtures.topology;
    assert.equal(preview.repository.path, join(fixtureRoot, "topology"));
    assert.equal(preview.repository.gitDir, join(fixtureRoot, expected.gitDir));
    assert.equal(preview.repository.commonDir, join(fixtureRoot, expected.commonDir));
    assert.equal(preview.repository.objectFormat, expected.objectFormat);
    assert.equal(preview.repository.isBare, false);
    assert.equal(preview.repository.isShallow, false);
    assert.equal(preview.repository.headOid, expected.headOid);
    assert.equal(preview.repository.headReference, "refs/heads/main");
    assert.deepEqual(preview.commits.map(commit => commit.oid), expected.expectedCommits.map(commit => commit.oid));
    assert.equal(preview.commits.length, expected.commitCount);
    assert.deepEqual(preview.commits.map(projectCommit), expected.expectedCommits.map(projectExpectedCommit));
    assert.equal(preview.hasMore, false);
    assert.equal(preview.refsTruncated, false);
    assert.deepEqual(preview.refs.map(projectRef), expected.refs.map(projectExpectedRef));
    assert.equal(completion.done, true);
    assert.equal(completion.coverage.complete, true);
    assert.equal(completion.coverage.processed, expected.commitCount);
    assert.equal(completion.nextCursor, null);
  } finally {
    await client.stop();
  }
  assert.deepEqual(await snapshotTree(fixtureRoot), before, "opening the repository must not change content, modes or symlinks");
  assert.equal(await exists(sentinelPath), false, "a configured promisor helper must not run during a normal preview");
});

test("length-framed commit parsing preserves NUL, marks invalid UTF-8, and truncates at a UTF-8 boundary", async () => {
  const client = await startDaemon();
  try {
    const preview = await readPreview(client, join(fixtureRoot, "boundary"));
    const expected = manifest.fixtures.boundary.expectedCommits;
    assert.deepEqual(preview.commits.map(projectCommit), expected.map(projectExpectedCommit));
    assert.equal(preview.commits.length, 3);
    assert.equal(preview.commits[0].textLossy, true);
    assert.equal(preview.commits[0].summary, "invalid-�-utf8 headline");
    assert.equal(preview.commits[1].summary, "NUL\0headline");
    assert.equal(Buffer.byteLength(preview.commits[2].summary), 4095);
    assert.equal(preview.commits[2].summaryTruncated, true);
    assert.equal(preview.commits[2].summary.endsWith("\uFFFD"), false);
  } finally {
    await client.stop();
  }
});

test("repository recognition covers subdirectories, detached, bare, worktree, shallow and SHA-256", async () => {
  const client = await startDaemon();
  try {
    const nested = await readPreview(client, join(fixtureRoot, "topology", "nested", "deep"));
    assert.equal(nested.repository.path, join(fixtureRoot, "topology"));
    assert.equal(nested.repository.headOid, manifest.fixtures.subdirectory.headOid);

    const detached = await readPreview(client, join(fixtureRoot, "detached"));
    assert.equal(detached.repository.headOid, manifest.fixtures.detached.headOid);
    assert.equal(detached.repository.headReference, null);

    const bare = await readPreview(client, join(fixtureRoot, "bare"));
    assert.equal(bare.repository.isBare, true);
    assert.equal(bare.repository.worktreePath, null);
    assert.equal(bare.repository.headOid, manifest.fixtures.bare.headOid);

    const linkedPath = join(fixtureRoot, "linked-worktree");
    const linked = await readPreview(client, linkedPath);
    assert.equal(linked.repository.worktreePath, linkedPath);
    assert.equal(linked.repository.gitDir, join(fixtureRoot, manifest.fixtures.linkedWorktree.gitDir));
    assert.equal(linked.repository.commonDir, join(fixtureRoot, manifest.fixtures.linkedWorktree.commonDir));
    assert.equal(linked.repository.commonDir, join(fixtureRoot, "topology", ".git"));

    const shallow = await readPreview(client, join(fixtureRoot, "shallow"));
    assert.equal(shallow.repository.isShallow, true);
    assert.equal(shallow.repository.headOid, manifest.fixtures.shallow.headOid);

    if (manifest.capabilities.sha256) {
      const sha256 = await readPreview(client, join(fixtureRoot, "sha256"));
      assert.equal(sha256.repository.objectFormat, "sha256");
      assert.equal(sha256.repository.headOid.length, 64);
      assert.equal(sha256.commits[0].oid.length, 64);
    } else {
      assert.equal(manifest.fixtures.sha256.supported, false, "unsupported SHA-256 must be stated in the manifest");
    }
  } finally {
    await client.stop();
  }
});

test("empty HEAD is distinct from invalid paths, missing objects fail, and newline paths stay intact", async () => {
  const client = await startDaemon();
  try {
    const empty = await readPreview(client, join(fixtureRoot, "empty"));
    assert.equal(empty.repository.headOid, null);
    assert.deepEqual(empty.commits, []);
    assert.equal(empty.hasMore, false);

    await mkdir(join(fixtureRoot, "not-a-repository"), { recursive: true });
    await assert.rejects(withReadOnlySnapshot(() => client.readRepositoryPreview(join(fixtureRoot, "not-a-repository"))), error => error.code === "NOT_A_REPOSITORY");

    const unusual = manifest.fixtures.unusualPath.path;
    const unusualPreview = await readPreview(client, join(fixtureRoot, unusual));
    assert.equal(unusualPreview.repository.headOid, manifest.fixtures.unusualPath.headOid);

    assert.ok(manifest.fixtures.missingPromisor.headOid, "missing-object fixture has a real branch target, not an unborn HEAD");
    const missing = await assert.rejects(withReadOnlySnapshot(() => client.readRepositoryPreview(join(fixtureRoot, "missing-promisor"))), error => error.code === "MISSING_OBJECT");
    assert.equal(missing, undefined);
    assert.equal(await exists(sentinelPath), false, "missing promisor objects must not invoke the configured helper or fetch");
    assert.equal(await exists(executionSentinel), false, "pager, fsmonitor, diff, textconv and hook sentinels must not execute");
  } finally {
    await client.stop();
  }
});

test("inherited GIT_DIR, GIT_WORK_TREE and GIT_CONFIG_COUNT cannot redirect repository reads", async () => {
  const decoy = join(fixtureRoot, "detached");
  const client = await startDaemon({
    GIT_DIR: join(decoy, ".git"),
    GIT_WORK_TREE: decoy,
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_KEY_1: "core.pager",
    GIT_CONFIG_VALUE_1: sentinelProgram,
    GIT_CONFIG_KEY_2: "core.fsmonitor",
    GIT_CONFIG_VALUE_2: sentinelProgram,
    GIT_CONFIG_KEY_3: "diff.external",
    GIT_CONFIG_VALUE_3: sentinelProgram,
    GIT_CONFIG_KEY_4: "diff.sentinel.textconv",
    GIT_CONFIG_VALUE_4: sentinelProgram,
    GIT_CONFIG_KEY_5: "core.hooksPath",
    GIT_CONFIG_VALUE_5: hooksDirectory,
  });
  try {
    const preview = await readPreview(client, join(fixtureRoot, "topology"));
    assert.equal(preview.repository.headOid, manifest.fixtures.topology.headOid);
    assert.equal(preview.repository.headReference, "refs/heads/main");
    assert.equal(preview.repository.isBare, false, "GIT_CONFIG_COUNT must not mark the inspected working tree bare");
    assert.equal(preview.repository.worktreePath, join(fixtureRoot, "topology"));
  } finally {
    await client.stop();
  }
  assert.equal(await exists(sentinelPath), false);
  assert.equal(await exists(executionSentinel), false);
});

test("cancelling a blocked rev-list reaps the Git child process", async () => {
  if (process.platform === "win32") return;
  const slowPidFile = process.env.COMMITSCOPE_SLOW_GIT_PID_FILE;
  const slowGitDirectory = process.env.COMMITSCOPE_SLOW_GIT_DIRECTORY;
  assert.ok(slowPidFile && slowGitDirectory, "test runner must provide a controlled slow Git wrapper");
  const client = await startDaemon({ PATH: `${slowGitDirectory}:${process.env.PATH}`, COMMITSCOPE_SLOW_GIT_PID_FILE: slowPidFile });
  try {
    const operation = client.startRepositoryPreview(join(fixtureRoot, "topology"), 10_000);
    const childPid = await waitForFileNumber(slowPidFile, 4000);
    client.cancel(operation.requestId);
    await assert.rejects(operation.result, error => error.code === "CANCELLED");
    await waitForProcessExit(childPid, 4000);
  } finally {
    await client.stop();
  }
});

test("an executable Git candidate that cannot be launched is reported as unavailable", async () => {
  if (process.platform === "win32") return;
  const unavailablePath = process.env.COMMITSCOPE_UNAVAILABLE_GIT_DIRECTORY;
  const client = await startDaemon({ PATH: `${unavailablePath}:${process.env.PATH}` });
  try {
    assert.equal(client.core.git.available, false);
    await assert.rejects(withReadOnlySnapshot(() => client.readRepositoryPreview(join(fixtureRoot, "topology"))), error => error.code === "GIT_UNAVAILABLE");
  } finally {
    await client.stop();
  }
});

function collectPreview(chunks) {
  const preview = { repository: null, refs: null, refsTruncated: null, commits: [], hasMore: null };
  for (const chunk of chunks) {
    assert.equal(chunk.repoId, null);
    assert.equal(chunk.generation, null);
    assert.equal(chunk.data.section === "repository" || chunk.data.section === "commits", true);
    if (chunk.data.section === "repository") {
      assert.equal(preview.repository, null, "repository header must be sent once and before commits");
      preview.repository = chunk.data.repository;
      preview.refs = chunk.data.refs;
      preview.refsTruncated = chunk.data.refsTruncated;
    } else {
      assert.ok(preview.repository, "repository header must precede commits");
      preview.commits.push(...chunk.data.commits);
      preview.hasMore = chunk.data.hasMore;
    }
  }
  assert.ok(preview.repository);
  assert.notEqual(preview.hasMore, null, "completion must include a commits section, including empty HEAD");
  return preview;
}

async function readPreview(client, path) {
  const result = await withReadOnlySnapshot(() => client.readRepositoryPreview(path));
  return collectPreview(result.chunks);
}

async function withReadOnlySnapshot(operation) {
  const before = await snapshotTree(fixtureRoot);
  try {
    return await operation();
  } finally {
    assert.deepEqual(await snapshotTree(fixtureRoot), before, "repository query changed content, file modes, symlinks or commonDir metadata");
  }
}

async function startDaemon(extraEnvironment = {}) {
  const basePath = extraEnvironment.PATH ?? process.env.PATH;
  const path = process.platform === "win32" ? basePath : `${helperDirectory}:${basePath}`;
  const client = new DaemonClient(daemonPath, {
    cwd: fixtureRoot,
    env: {
      ...gitEnvironment,
      ...extraEnvironment,
      PATH: path,
      COMMITSCOPE_FETCH_SENTINEL: sentinelPath,
      COMMITSCOPE_EXEC_SENTINEL: executionSentinel,
    COMMITSCOPE_SLOW_GIT_PID_FILE: process.env.COMMITSCOPE_SLOW_GIT_PID_FILE,
      GIT_CONFIG_COUNT: "6",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CONFIG_KEY_1: "core.pager",
      GIT_CONFIG_VALUE_1: sentinelProgram,
      GIT_CONFIG_KEY_2: "core.fsmonitor",
      GIT_CONFIG_VALUE_2: sentinelProgram,
      GIT_CONFIG_KEY_3: "diff.external",
      GIT_CONFIG_VALUE_3: sentinelProgram,
      GIT_CONFIG_KEY_4: "diff.sentinel.textconv",
      GIT_CONFIG_VALUE_4: sentinelProgram,
      GIT_CONFIG_KEY_5: "core.hooksPath",
      GIT_CONFIG_VALUE_5: hooksDirectory,
    },
  });
  try {
    client.core = await client.start();
    return client;
  } catch (error) {
    await client.stop().catch(() => {});
    throw error;
  }
}

function projectCommit(commit) {
  return { oid: commit.oid, parents: commit.parents, summary: commit.summary, summaryTruncated: commit.summaryTruncated, author: commit.author, committer: commit.committer, textLossy: commit.textLossy };
}

function projectExpectedCommit(commit) {
  const identity = item => ({ name: item.name, email: item.email, timestamp: item.timestamp, offset: item.offset });
  return { oid: commit.oid, parents: commit.parents, summary: commit.summary, summaryTruncated: commit.summaryTruncated ?? false, author: identity(commit.author), committer: identity(commit.committer), textLossy: commit.textLossy ?? false };
}

function projectRef(ref) {
  return { name: ref.name, oid: ref.oid, peeledOid: ref.peeledOid, symbolicTarget: ref.symbolicTarget, kind: ref.kind };
}

function projectExpectedRef(ref) {
  return { name: ref.name, oid: ref.oid, peeledOid: ref.peeledOid, symbolicTarget: null, kind: ref.name.startsWith("refs/heads/") ? "localBranch" : ref.name.startsWith("refs/remotes/") ? "remoteBranch" : "tag" };
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function waitForFileNumber(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(value) && value > 0) return value;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 20));
  }
  assert.fail(`slow Git wrapper did not record its PID within ${timeoutMs}ms`);
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 20));
  }
  assert.fail(`Git child PID ${pid} remained alive after cancellation`);
}

function cleanGitEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, ...extra };
}
