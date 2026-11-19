import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const {
  batchFilterQuery,
  batchRecordFromOperation,
  latestUpdateBatch,
  loadUpdateBatches,
  saveUpdateBatch,
  unseenBatchFromSession,
  zoomRangeForBatch,
} = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "update-batch.mjs")));

const oid = ch => ch.repeat(40);

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
  };
}

test("saveUpdateBatch persists at most 5 deduplicated batches per repository and worktree", () => {
  const storage = memoryStorage();
  for (let index = 1; index <= 7; index++) {
    const rec = {
      id: `b-${index}`,
      kind: "update",
      label: "快进更新",
      branchName: "main",
      oldTips: [oid(String(index % 10))],
      newTips: [oid("f")],
      addedCount: index * 10,
      minUnix: 1_700_000_000,
      maxUnix: 1_700_000_000 + index * 60,
      recordedAtUnixMs: 1_700_000_000_000 + index,
    };
    saveUpdateBatch("repo-1", "wt-1", rec, storage);
  }
  const saved = loadUpdateBatches("repo-1", "wt-1", storage);
  assert.equal(saved.length, 5);
  assert.equal(saved[0].addedCount, 70);
  assert.equal(saved[4].addedCount, 30);
  assert.equal(latestUpdateBatch("repo-1", "wt-1", storage)?.id, "b-7");
  assert.equal(latestUpdateBatch("repo-2", "wt-1", storage), null);
});

test("batchRecordFromOperation builds update batch only when head moved", () => {
  const unchanged = batchRecordFromOperation({
    label: "快进更新",
    branchName: "main",
    updatedRef: { refName: "refs/heads/main", oldOid: oid("a"), newOid: oid("a") },
    run: { outcome: "done", headOid: oid("a"), headReference: "refs/heads/main", updatedRef: null, untracked: null },
  });
  assert.equal(unchanged, null);

  const moved = batchRecordFromOperation({
    label: "快进更新",
    branchName: "main",
    updatedRef: { refName: "refs/heads/main", oldOid: oid("a"), newOid: oid("b") },
    run: {
      outcome: "done",
      headOid: oid("b"),
      headReference: "refs/heads/main",
      updatedRef: { refName: "refs/heads/main", oldOid: oid("a"), newOid: oid("b") },
      untracked: null,
      addedCount: 245,
      addedMinUnix: 1_700_001_000,
      addedMaxUnix: 1_700_009_000,
    },
    nowMs: 12345,
  });
  assert.equal(moved?.addedCount, 245);
  assert.deepEqual(moved?.oldTips, [oid("a")]);
  assert.deepEqual(moved?.newTips, [oid("b")]);
  assert.deepEqual(zoomRangeForBatch(moved), { startUnix: 1_700_001_000, endUnix: 1_700_009_040 });
  assert.deepEqual(zoomRangeForBatch({ minUnix: 1_700_000_990, maxUnix: 1_700_009_000 }), { startUnix: 1_700_000_940, endUnix: 1_700_009_040 });
});

test("unseenBatchFromSession and batchFilterQuery preserve topological oldTips", () => {
  const session = {
    repoId: "r1",
    generation: "g2",
    repositoryKey: "rk",
    worktreeId: "wt",
    scope: "head",
    tips: [oid("e")],
    previousView: { tips: [oid("a"), oid("b")], viewedAtUnixMs: 1_700_000_000_000 },
    observedAtUnixMs: 1_700_005_000_000,
    repository: { path: "/tmp/repo", gitDir: "/tmp/repo/.git", commonDir: "/tmp/repo/.git", worktreePath: "/tmp/repo", isBare: false, isShallow: false, objectFormat: "sha1", headOid: oid("e"), headReference: "refs/heads/main" },
    persistence: { recent: "ok", lastSeen: "ok" },
  };
  const unseen = unseenBatchFromSession({
    session,
    status: "ready",
    count: 320,
    minUnix: 1_700_001_000,
    maxUnix: 1_700_004_000,
  });
  assert.equal(unseen?.kind, "unseen");
  assert.equal(unseen?.addedCount, 320);
  assert.deepEqual(unseen?.oldTips, [oid("a"), oid("b")]);

  const query = batchFilterQuery({
    message: "old",
    caseSensitive: true,
    authors: [{ name: "A", email: "a@test" }],
    committers: [],
    oidPrefix: "1234",
    timeField: "author",
    fromTimestamp: 10,
    toTimestamp: 20,
    path: null,
    timeZone: "Asia/Shanghai",
  }, unseen.oldTips);
  assert.equal(query.message, "");
  assert.deepEqual(query.authors, []);
  assert.equal(query.timeZone, "Asia/Shanghai");
  assert.deepEqual(query.excludeTips, [oid("a"), oid("b")]);
});
