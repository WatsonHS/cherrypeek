import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { access, copyFile, link, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { MetadataIndexDaemonClient, createDaemonEnvironment, projectMetadataStatus, projectPage, projectSession } from "./daemon-client.mjs";
import { createLooseMissingFixture, createMetadataLruFixture, git } from "./fixture.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const repository = resolve(process.env.COMMITSCOPE_INDEX_REPOSITORY);
const dataRoot = resolve(process.env.COMMITSCOPE_INDEX_DATA_ROOT);
const daemonPath = resolve(process.env.COMMITSCOPE_DAEMON_PATH);
const sha256Repository = process.env.COMMITSCOPE_INDEX_SHA256_REPOSITORY ? resolve(process.env.COMMITSCOPE_INDEX_SHA256_REPOSITORY) : null;
const expected = JSON.parse(await readFile(resolve(process.env.COMMITSCOPE_INDEX_EXPECTED), "utf8"));
const execFileAsync = promisify(execFile);

test("SQLite metadata and snapshot membership exactly match independent Git objects", async () => {
  const before = await snapshotTree(repository);
  const client = await startClient("metadata-exact");
  try {
    const session = projectSession(await client.open(repository));
    const firstPage = projectPage(await client.readPage(session, null, 20));
    assert.ok(firstPage.commits.length > 0, "history is readable before the metadata index completes");
    const complete = await waitForStatus(client, session, status => status.state === "complete");
    assert.equal(complete.coverage.complete, true);

    const databasePath = await locateDatabase(client.appDataDir);
    assert.ok(databasePath.startsWith(join(client.appDataDir, "metadata-index")), "SQLite is stored under application data");
    const db = openReadOnlyDatabase(databasePath);
    try {
      const snapshot = db.prepare("SELECT snapshot_key, tips_json, graph_fingerprint, processed, complete, state FROM snapshots WHERE snapshot_key = ?").get(complete.snapshotKey);
      assert.ok(snapshot, "status snapshotKey identifies a persisted snapshot row");
      assert.equal(Boolean(snapshot.complete), true);
      assert.equal(snapshot.state, "complete");
      assert.ok(snapshot.graph_fingerprint.length > 0, "the stored snapshot binds the graph boundary fingerprint");
      assert.equal(Number(snapshot.processed), complete.coverage.processed, "status and persisted transaction checkpoint agree");
      const tips = JSON.parse(snapshot.tips_json);
      assert.deepEqual(tips, [expected.mainTip]);
      const members = db.prepare("SELECT ordinal, oid FROM snapshot_commits WHERE snapshot_key = ? ORDER BY ordinal").all(complete.snapshotKey);
      const expectedOids = await revList(repository, tips);
      assert.deepEqual(members.map(row => row.oid), expectedOids, "snapshot membership and stable order match stock Git's frozen-tip walk");
      assert.equal(members.length, expectedOids.length);
      assert.equal(complete.coverage.processed, expectedOids.length, "coverage counts unique committed snapshot members, not response envelopes");

      const rows = db.prepare(`SELECT oid, parents_json, summary, summary_truncated, message,
        author_name, author_email, author_timestamp, author_offset,
        committer_name, committer_email, committer_timestamp, committer_offset, text_lossy
        FROM commits ORDER BY oid`).all();
      assert.equal(rows.length, expectedOids.length, "this isolated object database indexes every reachable commit");
      assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok", "SQLite transaction and index files are structurally valid");
      const byOid = new Map(rows.map(row => [row.oid, row]));
      assert.deepEqual(new Set(byOid.keys()), new Set(expectedOids));
      for (const oid of expectedOids) assertCommitRow(byOid.get(oid), await readGitCommit(repository, oid));
      const merge = byOid.get(expected.mergeTip);
      assert.deepEqual(JSON.parse(merge.parents_json), expected.mergeParents, "merge parent order is preserved");
      const special = byOid.get(expected.specialOid);
      assert.equal(special.message, expected.specialMessage, "full body, Unicode, punctuation and trailers are retained");
      assert.equal(special.author_name, "作者甲");
      assert.equal(special.author_email, "author-special@example.invalid");
      assert.equal(special.committer_name, "提交者乙");
      assert.equal(special.committer_email, "committer-special@example.invalid");
      assert.notEqual(special.author_name, special.committer_name);
      assert.notEqual(special.author_offset, special.committer_offset);
    } finally {
      db.close();
    }
  } finally {
    await client.stop();
  }
  assert.deepEqual(await snapshotTree(repository), before, "metadata indexing did not write into the viewed repository");
});

test("allBranches uses its own fixed multi-tip snapshot and SHA-256 metadata retains full OIDs", async () => {
  const client = await startClient("metadata-multi-tip");
  try {
    let session = projectSession(await client.open(repository));
    const selected = client.selectScope(session, "allBranches", 8);
    const switched = await selected;
    session = projectSession(switched);
    const sessionData = switched.chunks.find(chunk => chunk.data.section === "repositorySession")?.data.session;
    assert.ok(sessionData?.tips?.length >= 2, "fixture has incomparable branch roots in allBranches");
    const status = await waitForStatus(client, session, value => value.state === "complete");
    assert.equal(status.coverage.complete, true);
    const db = openReadOnlyDatabase(await locateDatabase(client.appDataDir));
    try {
      const snapshot = db.prepare("SELECT tips_json FROM snapshots WHERE snapshot_key = ?").get(status.snapshotKey);
      const tips = JSON.parse(snapshot.tips_json);
      assert.deepEqual(new Set(tips), new Set(sessionData.tips));
      const members = db.prepare("SELECT oid FROM snapshot_commits WHERE snapshot_key = ? ORDER BY ordinal").all(status.snapshotKey).map(row => row.oid);
      assert.deepEqual(members, await revList(repository, tips));
      assert.equal(status.coverage.processed, members.length);
    } finally {
      db.close();
    }
  } finally {
    await client.stop();
  }

  if (sha256Repository) {
    const hashClient = await startClient("metadata-sha256");
    try {
      const hashSession = projectSession(await hashClient.open(sha256Repository));
      await hashClient.readPage(hashSession, null, 5);
      const hashStatus = await waitForStatus(hashClient, hashSession, value => value.state === "complete");
      const hashDb = openReadOnlyDatabase(await locateDatabase(hashClient.appDataDir));
      try {
        const rows = hashDb.prepare("SELECT oid FROM commits WHERE length(oid) = 64").all();
        assert.deepEqual(rows.map(row => row.oid), [expected.sha256Tip]);
        const members = hashDb.prepare("SELECT oid FROM snapshot_commits WHERE snapshot_key = ?").all(hashStatus.snapshotKey);
        assert.deepEqual(members.map(row => row.oid), [expected.sha256Tip]);
      } finally {
        hashDb.close();
      }
    } finally {
      await hashClient.stop();
    }
  }
});

test("an empty repository reaches complete zero coverage and the eight-snapshot LRU rebuilds evicted membership", async () => {
  const emptyRepository = join(dataRoot, "empty-repository");
  await mkdir(emptyRepository, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", emptyRepository]);
  const emptyClient = await startClient("metadata-empty", dataRoot);
  try {
    const emptySession = projectSession(await emptyClient.open(emptyRepository));
    const emptyPage = projectPage(await emptyClient.readPage(emptySession, null, 10));
    assert.deepEqual(emptyPage.commits, [], "an unborn repository returns an empty history page");
    const emptyStatus = await waitForStatus(emptyClient, emptySession, status => status.state === "complete");
    assert.deepEqual(emptyStatus.coverage, { processed: 0, complete: true });
    const db = openReadOnlyDatabase(await locateDatabase(emptyClient.appDataDir));
    try {
      const snapshot = db.prepare("SELECT tips_json, processed, complete FROM snapshots WHERE snapshot_key = ?").get(emptyStatus.snapshotKey);
      assert.deepEqual(JSON.parse(snapshot.tips_json), []);
      assert.equal(Number(snapshot.processed), 0);
      assert.equal(Boolean(snapshot.complete), true);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM snapshot_commits WHERE snapshot_key = ?").get(emptyStatus.snapshotKey).count, 0);
    } finally { db.close(); }
  } finally { await emptyClient.stop(); }

  const lru = await createMetadataLruFixture(join(dataRoot, "lru-fixture"));
  const lruClient = await startClient("metadata-lru", join(dataRoot, "lru-cache"));
  try {
    let session = projectSession(await lruClient.open(lru.repository));
    await lruClient.readPage(session, null, 5);
    const original = await waitForStatus(lruClient, session, status => status.state === "complete");
    const lruPath = await locateDatabase(lruClient.appDataDir);
    for (const branch of lru.branches.slice(0, 8)) {
      const switched = await lruClient.selectScope(session, { ref: `refs/heads/${branch.name}` }, 5);
      session = projectSession(switched);
      const page = projectPage(switched);
      assert.equal(page.commits[0]?.oid, branch.tip);
      const status = await waitForStatus(lruClient, session, value => value.state === "complete");
      assert.equal(status.coverage.processed, 2, "each branch scope indexes its own commit plus shared base membership");
      await delay(3);
    }

    const afterEightScopes = openReadOnlyDatabase(lruPath);
    try {
      const snapshots = afterEightScopes.prepare("SELECT snapshot_key, complete FROM snapshots ORDER BY last_used_unix_ms DESC").all();
      assert.equal(snapshots.length, 8, "the index retains at most eight snapshot membership sets");
      assert.equal(snapshots.some(row => row.snapshot_key === original.snapshotKey), false, "the oldest HEAD membership was evicted");
      assert.ok(snapshots.every(row => Boolean(row.complete)));
      assert.equal(afterEightScopes.prepare("SELECT COUNT(*) AS count FROM commits").get().count, 9,
        "object metadata remains globally reusable while one snapshot membership is evicted");
    } finally { afterEightScopes.close(); }

    const returned = await lruClient.selectScope(session, "head", 5);
    session = projectSession(returned);
    assert.equal(session.tips[0], lru.baseTip);
    const recreated = await waitForStatus(lruClient, session, status => status.state === "complete");
    assert.equal(recreated.snapshotKey, original.snapshotKey, "the same frozen tips produce the same snapshot identity");
    assert.equal(recreated.coverage.processed, 1, "the evicted snapshot is walked again rather than inheriting global commit row count");
    const restored = openReadOnlyDatabase(lruPath);
    try {
      const members = restored.prepare("SELECT oid FROM snapshot_commits WHERE snapshot_key = ? ORDER BY ordinal").all(recreated.snapshotKey).map(row => row.oid);
      assert.deepEqual(members, [lru.baseTip]);
      assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM snapshots").get().count, 8);
      assert.ok(restored.prepare("SELECT oid FROM commits WHERE oid = ?").get(lru.branches[0].tip),
        "a commit row cached for another scope does not imply this snapshot contains its tip");
      assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM snapshot_commits WHERE snapshot_key = ? AND oid = ?")
        .get(recreated.snapshotKey, lru.branches[0].tip).count, 0);
    } finally { restored.close(); }
  } finally { await lruClient.stop(); }
});

test("shallow boundaries index only Git-reachable commits and a missing object leaves browsing available but incomplete", async () => {
  const shallowRepository = join(dataRoot, "shallow-repository");
  await mkdir(shallowRepository, { recursive: true });
  await execFileAsync("git", ["clone", "--quiet", "--depth", "2", "--no-tags", pathToFileURL(repository).href, shallowRepository]);
  assert.equal(await git(shallowRepository, ["rev-parse", "--is-shallow-repository"]), "true");
  const shallowClient = await startClient("metadata-shallow", dataRoot);
  try {
    const session = projectSession(await shallowClient.open(shallowRepository));
    const firstPage = projectPage(await shallowClient.readPage(session, null, 5));
    assert.ok(firstPage.commits.length > 0, "shallow history is available before indexing");
    const status = await waitForStatus(shallowClient, session, value => value.state === "complete");
    const db = openReadOnlyDatabase(await locateDatabase(shallowClient.appDataDir));
    try {
      const members = db.prepare("SELECT oid FROM snapshot_commits WHERE snapshot_key = ? ORDER BY ordinal").all(status.snapshotKey).map(row => row.oid);
      assert.deepEqual(members, await revList(shallowRepository, [session.tips[0]]));
      assert.equal(status.coverage.processed, members.length);
    } finally { db.close(); }
  } finally {
    await shallowClient.stop();
  }

  const brokenRepository = join(dataRoot, "missing-object-repository");
  const missingFixture = await createLooseMissingFixture(brokenRepository, 90);
  const missingOid = missingFixture.missingOid;
  const gateFile = resolve(process.env.COMMITSCOPE_INDEX_GATE_FILE);
  const pidFile = resolve(process.env.COMMITSCOPE_INDEX_BLOCK_PID_FILE);
  const countFile = resolve(process.env.COMMITSCOPE_INDEX_BATCH_COUNT_FILE);
  const brokenClient = await startClient("metadata-missing-object", dataRoot, {
    COMMITSCOPE_INDEX_GATE_REPOSITORY: missingFixture.repository,
    COMMITSCOPE_INDEX_BLOCK_BATCH_AFTER: "0",
  });
  try {
    await rm(pidFile, { force: true });
    await writeFile(countFile, "0\n");
    await writeFile(gateFile, "hold first metadata batch after history is readable\n");
    const session = projectSession(await brokenClient.open(missingFixture.repository));
    const firstPage = projectPage(await brokenClient.readPage(session, null, 5));
    assert.equal(firstPage.commits.length, 5, "Git history is read before the object is removed");
    await waitForFile(pidFile);
    const beforeRemoval = await waitForStatus(brokenClient, session, status => status.state === "running");
    assert.equal(beforeRemoval.coverage.processed, 0, "the index is held before its first metadata batch commits");
    await access(missingFixture.objectPath);
    await rm(missingFixture.objectPath);
    await rm(gateFile, { force: true });
    const status = await waitForStatus(brokenClient, session, value => ["failed", "unavailable", "quotaLimited"].includes(value.state));
    assert.equal(status.coverage.complete, false, "a walk that encounters a missing object cannot claim complete coverage");
    assert.ok(["failed", "unavailable"].includes(status.state));
    assert.ok(["MISSING_OBJECT", "GIT_ERROR", "INDEX_CORRUPT"].includes(status.error?.code));
    assert.ok(status.coverage.processed > 0, "the committed prefix before the missing object remains useful");
    assert.ok(status.coverage.processed < missingFixture.commitCount);
    const stillReadable = projectPage(await brokenClient.readPage(session, null, 5));
    assert.deepEqual(stillReadable.commits.map(commit => commit.oid), firstPage.commits.map(commit => commit.oid),
      "an index object error does not replace or disable the readable history page");
  } finally {
    await rm(gateFile, { force: true });
    await brokenClient.stop();
  }
});

test("ordinary ref movement does not restart an older frozen snapshot and old controls cannot affect the new session", async () => {
  const gateFile = resolve(process.env.COMMITSCOPE_INDEX_GATE_FILE);
  const pidFile = resolve(process.env.COMMITSCOPE_INDEX_BLOCK_PID_FILE);
  const countFile = resolve(process.env.COMMITSCOPE_INDEX_BATCH_COUNT_FILE);
  const client = await startClient("metadata-frozen-ref", dataRoot, {
    COMMITSCOPE_INDEX_GATE_REPOSITORY: repository,
    COMMITSCOPE_INDEX_BLOCK_BATCH_AFTER: "1",
  });
  let previousTip = null;
  try {
    await rm(pidFile, { force: true });
    await writeFile(countFile, "0\n");
    await writeFile(gateFile, "hold second metadata batch while refs move\n");
    const oldSession = projectSession(await client.open(repository));
    await client.readPage(oldSession, null, 5);
    await waitForFile(pidFile);
    const oldStatus = await waitForStatus(client, oldSession, value => value.state === "running" && value.coverage.processed === 64);
    previousTip = await git(repository, ["rev-parse", "HEAD"]);
    await git(repository, ["-c", "user.name=External", "-c", "user.email=external@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "outside frozen snapshot"]);
    const externalOid = await git(repository, ["rev-parse", "HEAD"]);
    await rm(gateFile, { force: true });
    const oldComplete = await waitForStatus(client, oldSession, value => value.state === "complete");
    assert.equal(oldComplete.snapshotKey, oldStatus.snapshotKey, "normal ref movement leaves the running snapshot key stable");
    const oldDb = openReadOnlyDatabase(await locateDatabase(client.appDataDir));
    try {
      const memberOids = oldDb.prepare("SELECT oid FROM snapshot_commits WHERE snapshot_key = ? ORDER BY ordinal").all(oldComplete.snapshotKey).map(row => row.oid);
      assert.deepEqual(memberOids, await revList(repository, [previousTip]), "old index completes exactly the old frozen tip set");
      assert.ok(!memberOids.includes(externalOid));
    } finally {
      oldDb.close();
    }

    const refreshed = await client.refresh(oldSession, 5);
    const newSession = projectSession(refreshed);
    await client.readPage(newSession, null, 5);
    const newStatus = await waitForStatus(client, newSession, value => value.state === "complete");
    assert.notEqual(newStatus.snapshotKey, oldComplete.snapshotKey, "refresh produces a separately indexed snapshot");
    await assert.rejects(client.controlMetadataIndex(oldSession, "pause"), error => /STALE|GENERATION/iu.test(error.code ?? ""),
      "a control carrying the superseded session is rejected");
    const newAgain = projectMetadataStatus(await client.getMetadataIndexStatus(newSession));
    assert.equal(newAgain.snapshotKey, newStatus.snapshotKey);
    assert.equal(newAgain.state, "complete", "a stale pause did not affect the new snapshot");
  } finally {
    const currentHead = await git(repository, ["rev-parse", "HEAD"]).catch(() => null);
    if (currentHead && currentHead !== expected.mainTip) await git(repository, ["update-ref", "HEAD", previousTip ?? expected.mainTip]).catch(() => undefined);
    await client.stop();
    await rm(gateFile, { force: true });
  }
});

test("missing and corrupt or unsupported caches leave history browseable and require explicit recovery", async () => {
  const missingData = join(dataRoot, "missing-cache");
  const initialClient = await startClient("metadata-cache", missingData);
  let dbPath;
  try {
    const session = projectSession(await initialClient.open(repository));
    const page = projectPage(await initialClient.readPage(session, null, 6));
    assert.ok(page.commits.length > 0);
    await waitForStatus(initialClient, session, value => value.state === "complete");
    dbPath = await locateDatabase(initialClient.appDataDir);
  } finally {
    await initialClient.stop();
  }

  await rm(dbPath);
  const missingClient = await startClient("metadata-cache", missingData);
  try {
    const missingSession = projectSession(await missingClient.open(repository));
    const missing = projectMetadataStatus(await missingClient.getMetadataIndexStatus(missingSession));
    assert.notEqual(missing.state, "complete", "a missing database cannot retain stale complete status");
    assert.equal(missing.coverage.complete, false);
    const stillReadable = projectPage(await missingClient.readPage(missingSession, null, 6));
    assert.ok(stillReadable.commits.length > 0, "missing cache does not block history");
    assert.equal((await waitForStatus(missingClient, missingSession, value => value.state === "complete")).coverage.complete, true,
      "the missing cache is rebuilt from the same frozen snapshot");
    dbPath = await locateDatabase(missingClient.appDataDir);
  } finally {
    await missingClient.stop();
  }

  await writeFile(dbPath, Buffer.from("not a SQLite database"));
  const originalCorruptBytes = await readFile(dbPath);
  const corruptClient = await startClient("metadata-cache", missingData);
  try {
    const reopened = projectSession(await corruptClient.open(repository));
    const retained = projectPage(await corruptClient.readPage(reopened, null, 6));
    assert.ok(retained.commits.length > 0, "a corrupt cache does not block history");
    const corrupt = await waitForStatus(corruptClient, reopened, status => ["failed", "unavailable"].includes(status.state));
    assert.ok(["failed", "unavailable"].includes(corrupt.state), `corrupt cache must be surfaced without replacement: ${JSON.stringify(corrupt)}`);
    assert.equal(corrupt.coverage.complete, false);
    assert.ok(["INDEX_CORRUPT", "INDEX_VERSION_UNSUPPORTED"].includes(corrupt.error?.code));
    assert.deepEqual(await readFile(dbPath), originalCorruptBytes, "corruption is preserved until the user explicitly requests rebuild");
    const adjacentSentinel = join((await locateDatabase(corruptClient.appDataDir)).replace(/index\.sqlite3$/u, ""), "adjacent-sentinel.txt");
    await writeFile(adjacentSentinel, "rebuild may only remove known SQLite files\n");
    const adjacentBytes = await readFile(adjacentSentinel);
    const rebuilt = projectMetadataStatus(await corruptClient.controlMetadataIndex(reopened, "rebuild"));
    assert.ok(["queued", "running", "complete"].includes(rebuilt.state));
    const afterRebuild = await waitForStatus(corruptClient, reopened, status => status.state === "complete");
    assert.equal(afterRebuild.coverage.complete, true);
    assert.deepEqual(await readFile(adjacentSentinel), adjacentBytes, "rebuild preserves an adjacent non-cache sentinel");
  } finally {
    await corruptClient.stop();
  }

  const versionClient = await startClient("metadata-cache", missingData);
  try {
    const versionSession = projectSession(await versionClient.open(repository));
    await versionClient.readPage(versionSession, null, 6);
    const versionStatus = await waitForStatus(versionClient, versionSession, value => value.state === "complete");
    const versionPath = await locateDatabase(versionClient.appDataDir);
    const db = new DatabaseSync(versionPath);
    try { db.exec("PRAGMA user_version = 999;"); } finally { db.close(); }
    const unsupportedBytes = await readFile(versionPath);
    await versionClient.stop();

    const unsupported = await startClient("metadata-cache", missingData);
    try {
      const sessionAgain = projectSession(await unsupported.open(repository));
      const readable = projectPage(await unsupported.readPage(sessionAgain, null, 6));
      assert.ok(readable.commits.length > 0);
      const status = await waitForStatus(unsupported, sessionAgain, value => ["failed", "unavailable"].includes(value.state));
      assert.ok(["failed", "unavailable"].includes(status.state));
      assert.equal(status.coverage.complete, false);
      assert.equal(status.error?.code, "INDEX_VERSION_UNSUPPORTED");
      const sameFile = await locateDatabase(unsupported.appDataDir);
      assert.equal(sameFile, versionPath, "unsupported schema is reported in place and not silently replaced");
      assert.equal(status.snapshotKey, versionStatus.snapshotKey);
      assert.deepEqual(await readFile(versionPath), unsupportedBytes, "unsupported schema stays intact without explicit rebuild");
    } finally {
      await unsupported.stop();
    }
  } finally {
    await versionClient.stop().catch(() => undefined);
  }

  if (process.platform !== "win32") {
    const safeClient = await startClient("metadata-cache", missingData);
    const indexPath = await locateDatabase(safeClient.appDataDir);
    const retainedTarget = join(safeClient.appDataDir, "outside-index-target.txt");
    await writeFile(retainedTarget, "must not be removed or opened as SQLite\n");
    const retainedBytes = await readFile(retainedTarget);
    await safeClient.stop();
    const hardlinkPath = `${indexPath}-wal`;
    const databaseBytes = await readFile(indexPath);
    await link(indexPath, hardlinkPath);
    const hardlinkClient = await startClient("metadata-cache", missingData);
    try {
      const linkedSession = projectSession(await hardlinkClient.open(repository));
      assert.ok(projectPage(await hardlinkClient.readPage(linkedSession, null, 5)).commits.length > 0);
      const linkedStatus = await waitForStatus(hardlinkClient, linkedSession, status => status.state === "unavailable");
      assert.equal(linkedStatus.state, "unavailable", "a multiply linked known sidecar is rejected");
      assert.equal(linkedStatus.error?.code, "INDEX_UNAVAILABLE");
      const refusedHardlinkRebuild = projectMetadataStatus(await hardlinkClient.controlMetadataIndex(linkedSession, "rebuild"));
      assert.ok(["unavailable", "failed"].includes(refusedHardlinkRebuild.state));
      assert.equal(refusedHardlinkRebuild.coverage.complete, false);
      assert.equal(refusedHardlinkRebuild.error?.code, "INDEX_UNAVAILABLE");
      await access(hardlinkPath);
      await access(indexPath);
      assert.deepEqual(await readFile(indexPath), databaseBytes, "refused rebuild leaves the linked cache bytes unchanged");
      assert.deepEqual(await readFile(hardlinkPath), databaseBytes, "refused rebuild leaves the outside hardlink target unchanged");
    } finally {
      await hardlinkClient.stop();
      await rm(hardlinkPath, { force: true });
    }

    await rm(indexPath);
    await symlink(retainedTarget, indexPath);
    const unsafeClient = await startClient("metadata-cache", missingData);
    try {
      const unsafeSession = projectSession(await unsafeClient.open(repository));
      const readable = projectPage(await unsafeClient.readPage(unsafeSession, null, 6));
      assert.ok(readable.commits.length > 0, "unsafe cache path does not block history");
      const unsafe = await waitForStatus(unsafeClient, unsafeSession, status => status.state === "unavailable");
      assert.equal(unsafe.state, "unavailable");
      assert.equal(unsafe.error?.code, "INDEX_UNAVAILABLE");
      const refusedRebuild = projectMetadataStatus(await unsafeClient.controlMetadataIndex(unsafeSession, "rebuild"));
      assert.ok(["unavailable", "failed"].includes(refusedRebuild.state));
      assert.equal(refusedRebuild.coverage.complete, false);
      assert.equal(refusedRebuild.error?.code, "INDEX_UNAVAILABLE");
      assert.equal(refusedRebuild.error?.code, "INDEX_UNAVAILABLE");
      assert.deepEqual(await readFile(retainedTarget), retainedBytes, "rebuild refuses to delete or mutate a symlink target");
      const link = await import("node:fs/promises").then(fs => fs.lstat(indexPath));
      assert.equal(link.isSymbolicLink(), true, "unsafe linked cache remains untouched after the refused rebuild");
    } finally {
      await unsafeClient.stop();
      await rm(indexPath, { force: true });
      await rm(retainedTarget, { force: true });
    }
  }

  const repositoryDataPath = join(repository, "metadata-index-must-not-exist");
  const inRepositoryData = await startClient("metadata-in-repository-data", dataRoot, {
    COMMITSCOPE_APP_DATA_DIR: repositoryDataPath,
  });
  try {
    const session = projectSession(await inRepositoryData.open(repository));
    assert.ok(projectPage(await inRepositoryData.readPage(session, null, 5)).commits.length > 0);
    const status = await waitForStatus(inRepositoryData, session, value => value.state === "unavailable");
    assert.equal(status.state, "unavailable");
    assert.equal(status.error?.code, "INDEX_UNAVAILABLE");
    await assert.rejects(access(repositoryDataPath), error => error.code === "ENOENT",
      "an unsafe in-repository app-data path is rejected before creating any directory");
  } finally {
    await inRepositoryData.stop();
  }
});

test("replacing the live database inode during a gated batch cannot continue or claim complete", async () => {
  const root = join(dataRoot, "database-replacement");
  const gateFile = resolve(process.env.COMMITSCOPE_INDEX_GATE_FILE);
  const pidFile = resolve(process.env.COMMITSCOPE_INDEX_BLOCK_PID_FILE);
  const countFile = resolve(process.env.COMMITSCOPE_INDEX_BATCH_COUNT_FILE);
  const client = await startClient("metadata-replaced-db", root, {
    COMMITSCOPE_INDEX_GATE_REPOSITORY: repository,
    COMMITSCOPE_INDEX_BLOCK_BATCH_AFTER: "1",
  });
  const oldPath = `${join(root, "metadata-replaced-db", "metadata-index")}/old-index.sqlite3`;
  const replacementPath = `${join(root, "metadata-replaced-db", "metadata-index")}/replacement.sqlite3`;
  let dbPath;
  try {
    await rm(pidFile, { force: true });
    await writeFile(countFile, "0\n");
    await writeFile(gateFile, "hold second transaction before database replacement\n");
    const session = projectSession(await client.open(repository));
    const historyBefore = projectPage(await client.readPage(session, null, 5));
    assert.ok(historyBefore.commits.length > 0);
    await waitForFile(pidFile);
    const partial = await waitForStatus(client, session, status => status.state === "running" && status.coverage.processed === 64);
    dbPath = await locateDatabase(client.appDataDir);
    const oldBytes = await readFile(dbPath);
    const originalStat = await stat(dbPath);
    await copyFile(dbPath, replacementPath);
    const replacementStat = await stat(replacementPath);
    assert.notEqual(replacementStat.ino, originalStat.ino, "replacement is a distinct inode with a valid SQLite copy");
    const replacementBytes = await readFile(replacementPath);
    await rename(dbPath, oldPath);
    await rename(replacementPath, dbPath);
    assert.notEqual((await stat(dbPath)).ino, originalStat.ino);
    await rm(gateFile, { force: true });

    const invalidated = await waitForStatus(client, session,
      status => status.state === "unavailable" || status.state === "failed", 15_000);
    assert.notEqual(invalidated.state, "complete", "a new inode cannot inherit the old writer's complete claim");
    assert.equal(invalidated.coverage.complete, false);
    assert.ok(["INDEX_UNAVAILABLE", "INDEX_CORRUPT"].includes(invalidated.error?.code));
    assert.ok(partial.coverage.processed > 0);
    assert.deepEqual(await readFile(dbPath), replacementBytes, "the task does not write into the replacement database");
    assert.deepEqual(await readFile(oldPath), oldBytes, "the renamed original database retains its committed prefix");
    const originalDb = openReadOnlyDatabase(oldPath);
    try {
      const snapshot = originalDb.prepare("SELECT processed, complete FROM snapshots WHERE snapshot_key = ?").get(partial.snapshotKey);
      assert.equal(Number(snapshot.processed), partial.coverage.processed);
      assert.equal(Boolean(snapshot.complete), false);
      assert.equal(Number(originalDb.prepare("SELECT COUNT(*) AS count FROM snapshot_commits WHERE snapshot_key = ?").get(partial.snapshotKey).count), partial.coverage.processed);
    } finally { originalDb.close(); }
    const historyAfter = projectPage(await client.readPage(session, null, 5));
    assert.deepEqual(historyAfter.commits.map(commit => commit.oid), historyBefore.commits.map(commit => commit.oid),
      "cache replacement does not disturb the frozen Git history page");
  } finally {
    await rm(gateFile, { force: true });
    await client.stop();
  }
});

test("quota exhaustion and cancellation never claim complete coverage, and committed prefixes survive restart", async () => {
  const quotaData = join(dataRoot, "quota-limited");
  const quotaClient = await startClient("metadata-quota", quotaData, { COMMITSCOPE_INDEX_QUOTA_BYTES: "262144" });
  try {
    const session = projectSession(await quotaClient.open(repository));
    const history = projectPage(await quotaClient.readPage(session, null, 5));
    assert.ok(history.commits.length > 0);
    const limited = await waitForStatus(quotaClient, session, status => status.state === "quotaLimited" || status.state === "complete");
    if (limited.state === "quotaLimited") {
      assert.equal(limited.coverage.complete, false);
      assert.ok(limited.coverage.processed < expected.headCommitCount, "quota stop keeps incomplete coverage explicit");
      assert.ok(Number.isInteger(limited.diskBytes) && limited.diskBytes >= 0);
      const path = await locateDatabase(quotaClient.appDataDir);
      assert.equal(limited.diskBytes, await actualIndexBytes(path), "status reports the SQLite database and known sidecar bytes");
      assert.ok(limited.diskBytes <= limited.quotaBytes, "quota rollback keeps actual cache files within the configured limit");
      assert.ok((await stat(path)).size <= limited.quotaBytes / 3, "the database file stays within its reserved page budget");
      const db = openReadOnlyDatabase(path);
      try {
        const persisted = db.prepare("SELECT processed, complete FROM snapshots WHERE snapshot_key = ?").get(limited.snapshotKey);
        const members = db.prepare("SELECT COUNT(*) AS count FROM snapshot_commits WHERE snapshot_key = ?").get(limited.snapshotKey);
        assert.equal(Number(persisted.processed), Number(members.count), "transaction checkpoint and committed membership remain equal after quota rollback");
        assert.equal(Boolean(persisted.complete), false);
        assert.equal(limited.coverage.processed, Number(members.count));
      } finally { db.close(); }
    }
  } finally {
    await quotaClient.stop();
  }

  const restartData = join(dataRoot, "restart-recovery");
  const gateFile = resolve(process.env.COMMITSCOPE_INDEX_GATE_FILE);
  const pidFile = resolve(process.env.COMMITSCOPE_INDEX_BLOCK_PID_FILE);
  const countFile = resolve(process.env.COMMITSCOPE_INDEX_BATCH_COUNT_FILE);
  const client = await startClient("metadata-restart", restartData, {
    COMMITSCOPE_INDEX_GATE_REPOSITORY: repository,
    COMMITSCOPE_INDEX_BLOCK_BATCH_AFTER: "1",
  });
  let killed = false;
  let committedPrefix = [];
  try {
    await rm(pidFile, { force: true });
    await writeFile(countFile, "0\n");
    await writeFile(gateFile, "block second 64-commit metadata batch\n");
    const session = projectSession(await client.open(repository));
    await client.readPage(session, null, 5);
    await waitForFile(pidFile);
    const partial = await waitForStatus(client, session, value => value.coverage.processed >= 64 && value.state === "running");
    assert.equal(partial.coverage.processed, 64, "the first transaction is durable before daemon crash");
    const dbPath = await locateDatabase(client.appDataDir);
    const beforeDb = openReadOnlyDatabase(dbPath);
    let priorRows;
    try {
      committedPrefix = beforeDb.prepare("SELECT ordinal, oid FROM snapshot_commits WHERE snapshot_key = ? ORDER BY ordinal").all(partial.snapshotKey);
      priorRows = beforeDb.prepare("SELECT oid, message, parents_json FROM commits WHERE oid IN (SELECT oid FROM snapshot_commits WHERE snapshot_key = ?) ORDER BY oid").all(partial.snapshotKey);
    } finally { beforeDb.close(); }
    assert.equal(committedPrefix.length, partial.coverage.processed);
    assert.equal(priorRows.length, committedPrefix.length, "every committed member has its metadata row before exit");

    const childPid = client.child.pid;
    process.kill(process.platform === "win32" ? childPid : -childPid, "SIGKILL");
    const closed = await client.closed;
    assert.equal(closed.signal, "SIGKILL", "the daemon exits abruptly rather than performing a graceful shutdown");
    killed = true;
    await waitForPidExit(Number((await readFile(pidFile, "utf8")).trim()));
    await rm(gateFile, { force: true });

    const afterCrashDb = openReadOnlyDatabase(dbPath);
    try {
      const membersAfterCrash = afterCrashDb.prepare("SELECT ordinal, oid FROM snapshot_commits WHERE snapshot_key = ? ORDER BY ordinal").all(partial.snapshotKey);
      const rowsAfterCrash = afterCrashDb.prepare("SELECT oid, message, parents_json FROM commits WHERE oid IN (SELECT oid FROM snapshot_commits WHERE snapshot_key = ?) ORDER BY oid").all(partial.snapshotKey);
      assert.deepEqual(membersAfterCrash, committedPrefix, "strong exit leaves the already committed checkpoint intact");
      assert.deepEqual(rowsAfterCrash, priorRows, "strong exit leaves committed full metadata intact");
    } finally { afterCrashDb.close(); }
  } finally {
    await rm(gateFile, { force: true });
    if (!killed) await client.stop();
  }

  const resumed = await startClient("metadata-restart", restartData);
  try {
    const session = projectSession(await resumed.open(repository));
    const page = projectPage(await resumed.readPage(session, null, 5));
    assert.ok(page.commits.length > 0, "restart recovery does not gate history");
    const complete = await waitForStatus(resumed, session, value => value.state === "complete");
    assert.equal(complete.coverage.processed, expected.headCommitCount);
    const db = openReadOnlyDatabase(await locateDatabase(resumed.appDataDir));
    try {
      const snapshot = db.prepare("SELECT processed, complete FROM snapshots WHERE snapshot_key = ?").get(complete.snapshotKey);
      const members = db.prepare("SELECT oid FROM snapshot_commits WHERE snapshot_key = ? ORDER BY ordinal").all(complete.snapshotKey).map(row => row.oid);
      assert.equal(Number(snapshot.processed), members.length);
      assert.equal(Boolean(snapshot.complete), true);
      assert.deepEqual(members, await revList(repository, [expected.mainTip]));
      assert.deepEqual(members.slice(0, committedPrefix.length), committedPrefix.map(row => row.oid),
        "resume continues the durable prefix and does not rebuild membership from an empty database");
    } finally { db.close(); }
  } finally {
    await resumed.stop();
  }
});

test("pause waits for its Git child and resume continues; cancel is terminal until explicit resume", async () => {
  const client = await startClient("metadata-controls", join(dataRoot, "controls"), {
    COMMITSCOPE_INDEX_GATE_REPOSITORY: repository,
    COMMITSCOPE_INDEX_BLOCK_BATCH_AFTER: "1",
  });
  const gateFile = resolve(process.env.COMMITSCOPE_INDEX_GATE_FILE);
  const pidFile = resolve(process.env.COMMITSCOPE_INDEX_BLOCK_PID_FILE);
  const countFile = resolve(process.env.COMMITSCOPE_INDEX_BATCH_COUNT_FILE);
  try {
    await rm(pidFile, { force: true });
    await writeFile(countFile, "0\n");
    await writeFile(gateFile, "hold second metadata batch\n");
    const head = projectSession(await client.open(repository));
    await client.readPage(head, null, 5);
    await waitForFile(pidFile);
    const running = await waitForStatus(client, head, status => status.state === "running" && status.coverage.processed === 64);
    const paused = projectMetadataStatus(await client.controlMetadataIndex(head, "pause"));
    assert.equal(paused.state, "paused");
    assert.equal(paused.coverage.processed, 64);
    await waitForPidExit(Number((await readFile(pidFile, "utf8")).trim()));
    await delay(100);
    const stable = projectMetadataStatus(await client.getMetadataIndexStatus(head));
    assert.deepEqual(stable.coverage, paused.coverage, "paused coverage stays stable after the control response");
    assert.equal(stable.state, "paused");

    await rm(gateFile, { force: true });
    await writeFile(countFile, "0\n");
    const resumed = projectMetadataStatus(await client.controlMetadataIndex(head, "resume"));
    assert.ok(["queued", "running", "complete"].includes(resumed.state));
    const completed = await waitForStatus(client, head, status => status.state === "complete");
    assert.equal(completed.coverage.processed, expected.headCommitCount);
    assert.ok(completed.coverage.processed > running.coverage.processed);

    await writeFile(countFile, "1\n");
    await writeFile(gateFile, "hold first side-scope batch\n");
    await rm(pidFile, { force: true });
    const sideResponse = await client.selectScope(head, { ref: "refs/heads/side" }, 5);
    const side = projectSession(sideResponse);
    const sidePage = projectPage(sideResponse);
    assert.ok(sidePage.commits.length > 0, "scope history remains readable while the new index is gated");
    await waitForFile(pidFile);
    const sideRunning = await waitForStatus(client, side, status => status.state === "running");
    assert.equal(sideRunning.coverage.processed, 0);
    const cancelled = projectMetadataStatus(await client.controlMetadataIndex(side, "cancel"));
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.coverage.complete, false);
    await waitForPidExit(Number((await readFile(pidFile, "utf8")).trim()));
    const pageAfterCancel = projectPage(await client.readPage(side, null, 5));
    assert.ok(pageAfterCancel.commits.length > 0, "cancelled indexing does not disable history pages");

    await rm(gateFile, { force: true });
    await writeFile(countFile, "0\n");
    await client.controlMetadataIndex(side, "resume");
    const sideComplete = await waitForStatus(client, side, status => status.state === "complete");
    assert.equal(sideComplete.coverage.processed, await revList(repository, [expected.sideTip]).then(ids => ids.length));
  } finally {
    await rm(gateFile, { force: true });
    await client.stop();
  }
});

async function startClient(name, root = dataRoot, extra = {}) {
  const ownData = join(root, name);
  const client = new MetadataIndexDaemonClient(daemonPath, {
    cwd: repository,
    env: createDaemonEnvironment(ownData, extra),
  });
  client.appDataDir = ownData;
  await client.start();
  return client;
}

async function actualIndexBytes(databasePath) {
  let total = 0;
  for (const path of [databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try { total += (await stat(path)).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return total;
}


async function waitForFile(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch {}
    await delay(10);
  }
  throw new Error(`Timed out waiting for process gate file ${path}`);
}

async function waitForPidExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await delay(20);
  }
  throw new Error(`Git wrapper child ${pid} remained alive after daemon termination`);
}



async function waitForStatus(client, session, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = projectMetadataStatus(await client.getMetadataIndexStatus(session));
    if (predicate(latest)) return latest;
    await delay(40);
  }
  throw new Error(`Timed out waiting for metadata index state; last status=${JSON.stringify(latest)}`);
}

async function locateDatabase(root) {
  const indexRoot = join(root, "metadata-index");
  const repositories = await readdir(indexRoot, { withFileTypes: true });
  const paths = repositories.filter(entry => entry.isDirectory()).map(entry => join(indexRoot, entry.name, "index.sqlite3"));
  const existing = [];
  for (const path of paths) try { await access(path); existing.push(path); } catch {}
  assert.equal(existing.length, 1, `expected one exact repository index DB under ${indexRoot}, found ${existing.length}`);
  return existing[0];
}

function openReadOnlyDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA query_only = ON;");
  return db;
}

async function revList(repo, tips) {
  const output = await git(repo, ["rev-list", "--topo-order", ...tips]);
  return output.split("\n").filter(Boolean);
}

async function readGitCommit(repo, oid) {
  const raw = await git(repo, ["cat-file", "commit", oid], { encoding: "buffer" });
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const boundary = buffer.indexOf(Buffer.from("\n\n"));
  assert.ok(boundary >= 0, `commit ${oid} has a header/body boundary`);
  const headers = buffer.subarray(0, boundary).toString("utf8").split("\n");
  const parents = headers.filter(line => line.startsWith("parent ")).map(line => line.slice(7));
  const author = parseIdentity(headers.find(line => line.startsWith("author ")).slice(7));
  const committer = parseIdentity(headers.find(line => line.startsWith("committer ")).slice(10));
  const message = buffer.subarray(boundary + 2).toString("utf8");
  return {
    oid,
    parents,
    summary: message.split("\n", 1)[0],
    message,
    author,
    committer,
  };
}

function parseIdentity(value) {
  const match = /^(.*) <(.*)> (-?\d+) ([+-]\d{4})$/u.exec(value);
  assert.ok(match, `Git identity parses: ${value}`);
  return { name: match[1], email: match[2], timestamp: Number(match[3]), offset: match[4] };
}

function assertCommitRow(row, commit) {
  assert.ok(row, `SQLite includes ${commit.oid}`);
  assert.deepEqual(JSON.parse(row.parents_json), commit.parents, `ordered parents for ${commit.oid}`);
  assert.equal(row.summary, commit.summary, `summary for ${commit.oid}`);
  assert.equal(row.summary_truncated, 0, `fixture summary for ${commit.oid} is short and untruncated`);
  assert.equal(row.message, commit.message, `complete message for ${commit.oid}`);
  assert.equal(row.author_name, commit.author.name);
  assert.equal(row.author_email, commit.author.email);
  assert.equal(Number(row.author_timestamp), commit.author.timestamp);
  assert.equal(row.author_offset, commit.author.offset);
  assert.equal(row.committer_name, commit.committer.name);
  assert.equal(row.committer_email, commit.committer.email);
  assert.equal(Number(row.committer_timestamp), commit.committer.timestamp);
  assert.equal(row.committer_offset, commit.committer.offset);
  assert.equal(row.text_lossy, 0);
}
