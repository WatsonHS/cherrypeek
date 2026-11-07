import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { access, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SearchDaemonClient, createDaemonEnvironment, projectMetadataStatus, projectPage, projectSearchIdentities, projectSearchPage, projectSession } from "./daemon-client.mjs";
import { createSearchFixture, git, snapshotTree } from "./fixture.mjs";
import { createMetadataLruFixture } from "../indexing/fixture.mjs";

const repository = resolve(process.env.COMMITSCOPE_SEARCH_REPOSITORY);
const dataRoot = resolve(process.env.COMMITSCOPE_SEARCH_DATA_ROOT);
const daemonPath = resolve(process.env.COMMITSCOPE_DAEMON_PATH);
const sha256Repository = process.env.COMMITSCOPE_SEARCH_SHA256_REPOSITORY ? resolve(process.env.COMMITSCOPE_SEARCH_SHA256_REPOSITORY) : null;
const expected = JSON.parse(await readFile(resolve(process.env.COMMITSCOPE_SEARCH_EXPECTED), "utf8"));
const records = expected.records;
const byOid = new Map(records.map(record => [record.oid, record]));

test("metadata search matches independent Git metadata, full messages, field logic, stable ordering and complete paging", async () => {
  const before = await snapshotTree(repository);
  const client = await startClient("search-correctness");
  try {
    const session = projectSession(await client.open(repository));
    const history = projectPage(await client.readPage(session, null, 8));
    assert.ok(history.commits.length > 0, "ordinary history remains available before the index is complete");
    const complete = await waitForIndex(client, session, status => status.state === "complete");
    assert.equal(complete.coverage.complete, true);

    const allQuery = query({ message: "common searchable marker", caseSensitive: true });
    const gitInvocationsBeforeSearch = Number(await readFile(resolve(process.env.COMMITSCOPE_SEARCH_GIT_COUNT_FILE), "utf8"));
    const all = await collectAll(client, session, allQuery, 375);
    const gitInvocationsAfterSearch = Number(await readFile(resolve(process.env.COMMITSCOPE_SEARCH_GIT_COUNT_FILE), "utf8"));
    assert.equal(gitInvocationsAfterSearch, gitInvocationsBeforeSearch, "search scans the SQLite snapshot prefix without launching a second Git searcher");
    assert.deepEqual(all.map(commit => commit.oid), oracle(records, allQuery).map(record => record.oid));
    assert.equal(all.length, records.length);
    assert.ok(all.length >= 2_500, "fixture has enough hits to cover deep result pages and a bounded renderer window");
    assert.equal(new Set(all.map(commit => commit.oid)).size, all.length, "multi-tip merge reachability is de-duplicated by full OID");
    const equalTimeOids = records.filter(record => record.committer.timestamp === 1_700_100_000).map(record => record.oid).sort();
    assert.equal(equalTimeOids.length, 2, "fixture contains a timestamp tie");
    const equalTimePositions = equalTimeOids.map(oid => all.findIndex(commit => commit.oid === oid));
    assert.ok(equalTimePositions[0] < equalTimePositions[1], "equal timestamps use complete OID ASCII ascending as the stable tie break");
    assert.deepEqual(await snapshotTree(repository), before, "search does not mutate Git refs, worktree or index");

    const cursorProbe = projectSearchPage(await client.searchCommits(session, allQuery, { pageSize: 10 }));
    assert.ok(cursorProbe.nextCursor);
    const cursorPageTwo = projectSearchPage(await client.searchCommits(session, allQuery, { cursor: cursorProbe.nextCursor, pageSize: 10 }));
    const cursorPageThree = projectSearchPage(await client.searchCommits(session, allQuery, { cursor: cursorPageTwo.nextCursor, pageSize: 10 }));
    assert.ok(cursorPageThree.previousCursor);
    const cursorBack = projectSearchPage(await client.searchCommits(session, allQuery, { cursor: cursorPageThree.previousCursor, pageSize: 10 }));
    assert.equal(cursorBack.pageOffset, 10);
    assert.deepEqual(cursorBack.commits.map(commit => commit.oid), cursorPageTwo.commits.map(commit => commit.oid),
      "forward and backward cursors round-trip the prior search page exactly");
    await assert.rejects(client.searchCommits(session, allQuery, { cursor: cursorProbe.nextCursor, pageSize: 11 }), error => error.code === "INVALID_CURSOR",
      "search cursors are bound to their page size");

    const cases = [
      [query({ message: "STRASSE", caseSensitive: false }), expected.unicode.casefold],
      [query({ message: "STRASSE", caseSensitive: true }), expected.unicode.uppercaseOnly],
      [query({ message: "σ", caseSensitive: false }), expected.unicode.sigma],
      [query({ message: "turkish i", caseSensitive: false }), expected.unicode.turkishI],
      [query({ message: "composed café", caseSensitive: false }), expected.unicode.composed],
      [query({ message: "composed café", caseSensitive: false }), expected.unicode.decomposed],
      [query({ message: "中文", caseSensitive: true }), expected.unicode.chinese],
      [query({ message: "，。", caseSensitive: true }), expected.unicode.punctuation],
      [query({ message: "deadbeef", caseSensitive: false }), expected.unicode.hashLikeMessage],
    ];
    for (const [searchQuery, expectedOids] of cases) {
      const page = projectSearchPage(await client.searchCommits(session, searchQuery, { pageSize: 20 }));
      assert.equal(page.coverage.complete, true);
      assert.deepEqual(page.commits.map(commit => commit.oid), expectedOids, `message semantics for ${JSON.stringify(searchQuery.message)}`);
    }

    const ambiguous = projectSearchPage(await client.searchCommits(session, query({ oidPrefix: expected.ambiguousPrefix }), { pageSize: 20 }));
    assert.equal(ambiguous.coverage.complete, true);
    assert.deepEqual(ambiguous.commits.map(commit => commit.oid), expected.ambiguousOids,
      "ambiguous four-hex OID prefixes return every candidate without selecting one");
    const notHashMode = projectSearchPage(await client.searchCommits(session, query({ message: "deadbeef" }), { pageSize: 20 }));
    assert.deepEqual(notHashMode.commits.map(commit => commit.oid), expected.unicode.hashLikeMessage,
      "a hash-looking ordinary input remains a message search");

    const authorAlice = { name: "Alice Search", email: "alice-search@example.invalid" };
    const authorBob = { name: "Bob Search", email: "bob-search@example.invalid" };
    const xavier = { name: "Xavier Committer", email: "xavier-committer@example.invalid" };
    const combined = query({ message: "common", authors: [authorAlice, authorBob], committers: [xavier] });
    const combinedResult = await collectAll(client, session, combined, 80);
    assert.deepEqual(combinedResult.map(commit => commit.oid), oracle(records, combined).map(record => record.oid),
      "identity choices OR within Author and AND with Committer and message");
    assert.ok(combinedResult.length > 0);
    const normalizedChoicesA = projectSearchPage(await client.searchCommits(session, combined, { pageSize: 20 }));
    const normalizedChoicesB = projectSearchPage(await client.searchCommits(session,
      query({ message: "common", authors: [authorBob, authorAlice, authorAlice], committers: [xavier] }), { pageSize: 20 }));
    assert.equal(normalizedChoicesA.queryKey, normalizedChoicesB.queryKey, "identity choice ordering and duplicates normalize to one query identity");
    const authorOnly = await collectAll(client, session, query({ authors: [authorAlice] }), 100);
    assert.deepEqual(authorOnly.map(commit => commit.oid), oracle(records, query({ authors: [authorAlice] })).map(record => record.oid));
    assert.ok(authorOnly.every(commit => byOid.get(commit.oid).author.email === authorAlice.email),
      "an Author identity cannot accidentally match the same text in Committer");

    const from = 1_700_000_000;
    const to = 1_700_000_002;
    const committerRange = query({ fromTimestamp: from + 100, toTimestamp: from + 102, timeZone: "America/Los_Angeles" });
    const committerResults = await collectAll(client, session, committerRange, 20);
    assert.deepEqual(committerResults.map(commit => commit.oid), oracle(records, committerRange).map(record => record.oid),
      "time boundaries are half-open integer Unix seconds and use the selected time field");
    assert.deepEqual(committerResults.map(commit => byOid.get(commit.oid).committer.timestamp), [from + 101, from + 100]);
    const authorRange = query({ timeField: "author", fromTimestamp: from, toTimestamp: to, timeZone: "America/Los_Angeles" });
    const authorResults = await collectAll(client, session, authorRange, 20);
    assert.deepEqual(authorResults.map(commit => commit.oid), oracle(records, authorRange).map(record => record.oid));
    assert.notDeepEqual(authorResults.map(commit => commit.oid), committerResults.map(commit => commit.oid),
      "Author and Committer date filters use separate raw timestamps");
    const dstDay = query({ fromTimestamp: 1_772_956_800, toTimestamp: 1_773_039_600, timeZone: "America/Los_Angeles" });
    const dstRows = await collectAll(client, session, dstDay, 20);
    assert.deepEqual(dstRows.map(commit => commit.oid), oracle(records, dstDay).map(record => record.oid));
    assert.deepEqual(new Set(dstRows.map(commit => commit.oid)), new Set(expected.dstOids),
      "a local day crossing spring DST spans 23 hours and excludes commits at the next local midnight");
    const differentZone = projectSearchPage(await client.searchCommits(session, query({
      fromTimestamp: dstDay.fromTimestamp,
      toTimestamp: dstDay.toTimestamp,
      timeZone: "UTC",
    }), { pageSize: 20 }));
    const losAngelesZone = projectSearchPage(await client.searchCommits(session, dstDay, { pageSize: 20 }));
    assert.notEqual(differentZone.queryKey, losAngelesZone.queryKey, "IANA timezone participates in search identity");

    const identities = projectSearchIdentities(await client.listSearchIdentities(session, "author", "search", 20));
    const expectedIdentities = uniqueIdentities(records, "author").filter(identity => asciiFold(`${identity.name} ${identity.email}`).includes("search"));
    assert.deepEqual(identities.identities, expectedIdentities, "identity suggestions are raw pairs in deterministic name/email order");
    assert.equal(identities.coverage.complete, true);

    const preMergeResponse = await client.selectScope(session, { ref: "refs/heads/pre-merge" }, 8);
    const preMergeSession = projectSession(preMergeResponse);
    assert.ok(preMergeSession, "scope selection returns the new frozen branch session");
    await client.readPage(preMergeSession, null, 8);
    await waitForIndex(client, preMergeSession, status => status.state === "complete");
    const preMergeRows = await collectAll(client, preMergeSession, allQuery, 401);
    const preMergeExpected = oracle(records.filter(record => expected.preMergeOids.includes(record.oid)), allQuery);
    assert.deepEqual(preMergeRows.map(commit => commit.oid), preMergeExpected.map(record => record.oid),
      "cached metadata outside the selected branch snapshot cannot leak into search results");
    assert.equal(preMergeRows.length, expected.preMergeOids.length);

    const sideResponse = await client.selectScope(preMergeSession, { ref: "refs/heads/side" }, 8);
    const sideSession = projectSession(sideResponse);
    await client.readPage(sideSession, null, 8);
    await waitForIndex(client, sideSession, status => status.state === "complete");
    const sideRows = await collectAll(client, sideSession, allQuery, 31);
    assert.deepEqual(sideRows.map(commit => commit.oid), oracle(records.filter(record => expected.sideOids.includes(record.oid)), allQuery).map(record => record.oid),
      "search scope follows the selected branch tips without checkout");
  } finally {
    await client.stop();
  }
  assert.deepEqual(await snapshotTree(repository), before, "the entire search session remains read-only");
});

test("partial search versions remain pageable after growth; latest anchor reflects reordered complete results", async () => {
  const gateFile = resolve(process.env.COMMITSCOPE_SEARCH_GATE_FILE);
  const pidFile = resolve(process.env.COMMITSCOPE_SEARCH_GATE_PID_FILE);
  await rm(pidFile, { force: true });
  await writeFile(resolve(process.env.COMMITSCOPE_SEARCH_GATE_COUNT_FILE), "0\n");
  await writeFile(gateFile, "hold second metadata batch\n");
  const client = await startClient("search-partial", repository, {
    COMMITSCOPE_INDEX_GATE_FILE: gateFile,
    COMMITSCOPE_INDEX_BLOCK_PID_FILE: pidFile,
    COMMITSCOPE_INDEX_BATCH_COUNT_FILE: resolve(process.env.COMMITSCOPE_SEARCH_GATE_COUNT_FILE),
    COMMITSCOPE_INDEX_GATE_REPOSITORY: repository,
    COMMITSCOPE_INDEX_BLOCK_BATCH_AFTER: "1",
  });
  try {
    const session = projectSession(await client.open(repository));
    const firstHistory = projectPage(await client.readPage(session, null, 8));
    assert.ok(firstHistory.commits.length > 0);
    await waitForFile(pidFile);
    const partialStatus = await waitForIndex(client, session, status => status.coverage.processed >= 64 && status.state === "running");
    assert.equal(partialStatus.coverage.complete, false);

    const searchQuery = query({ message: "common searchable marker" });
    const first = projectSearchPage(await client.searchCommits(session, searchQuery, { pageSize: 17 }));
    assert.equal(first.coverage.complete, false, "search labels the indexed prefix as partial");
    assert.equal(first.coverage.processed, partialStatus.coverage.processed);
    assert.equal(first.matchedCount, first.coverage.processed, "all members in this frozen prefix match the marker");
    const pendingEmpty = projectSearchPage(await client.searchCommits(session, query({ message: "not-yet-indexed marker" }), { pageSize: 17 }));
    assert.equal(pendingEmpty.coverage.complete, false);
    assert.equal(pendingEmpty.matchedCount, 0, "an empty partial prefix is not a final empty result");
    const partialExpected = oracle(records.filter(record => new Set(expected.snapshotPrefix.slice(0, first.coverage.processed)).has(record.oid)), searchQuery);
    assert.deepEqual(first.commits.map(commit => commit.oid), partialExpected.slice(0, 17).map(record => record.oid));

    const oldVersionRows = await collectVersion(client, session, searchQuery, first, first.resultVersion);
    assert.equal(oldVersionRows.length, first.matchedCount);
    assert.deepEqual(oldVersionRows.map(commit => commit.oid), partialExpected.map(record => record.oid),
      "the old watermark cursor walks the complete captured partial result without duplicates or omissions");
    assert.equal(new Set(oldVersionRows.map(commit => commit.oid)).size, oldVersionRows.length);

    await client.controlMetadataIndex(session, "pause");
    const pausedStatus = await waitForIndex(client, session, status => status.state === "paused");
    assert.equal(pausedStatus.coverage.complete, false);
    const pausedNoHit = projectSearchPage(await client.searchCommits(session, query({ message: "not-yet-indexed marker" }), { pageSize: 17 }));
    assert.equal(pausedNoHit.coverage.complete, false);
    assert.equal(pausedNoHit.matchedCount, 0);
    assert.equal(pausedNoHit.index.state, "paused", "a zero-hit partial page reports the actual stopped index state");
    const pausedHits = projectSearchPage(await client.searchCommits(session, searchQuery, { pageSize: 17 }));
    assert.equal(pausedHits.coverage.complete, false);
    assert.equal(pausedHits.index.state, "paused");

    await rm(gateFile, { force: true });
    await client.controlMetadataIndex(session, "resume");
    const completeStatus = await waitForIndex(client, session, status => status.state === "complete", 90_000);
    assert.equal(completeStatus.coverage.processed, records.length);
    const latestExpected = oracle(records, searchQuery);
    assert.equal(latestExpected[0].oid, expected.rootOid, "the late-indexed root has the greatest selected timestamp");
    const anchorOid = first.commits[7].oid;
    const anchorPage = projectSearchPage(await client.searchCommits(session, searchQuery, { anchorOid, pageSize: 31 }));
    assert.equal(anchorPage.anchorFound, true);
    assert.equal(anchorPage.coverage.complete, true);
    assert.notEqual(anchorPage.resultVersion, first.resultVersion, "latest anchor request moves to the grown result version");
    assert.equal(anchorPage.pageOffset, latestExpected.findIndex(record => record.oid === anchorOid),
      "new anchor requests use the latest result rank after the delayed future-time commit appears");
    assert.deepEqual(anchorPage.commits.map(commit => commit.oid),
      latestExpected.slice(anchorPage.pageOffset, anchorPage.pageOffset + 31).map(record => record.oid));
    assert.equal(anchorPage.commits[0].oid, anchorOid);
    const rootAnchor = projectSearchPage(await client.searchCommits(session, searchQuery, { anchorOid: expected.rootOid, pageSize: 31 }));
    assert.equal(rootAnchor.anchorFound, true);
    assert.equal(rootAnchor.pageOffset, 0, "a late-indexed future-time root anchors at rank zero after reordering");
    assert.equal(rootAnchor.commits[0].oid, expected.rootOid);
    const middleAnchorOid = latestExpected[1_300].oid;
    const middleAnchor = projectSearchPage(await client.searchCommits(session, searchQuery, { anchorOid: middleAnchorOid, pageSize: 31 }));
    assert.equal(middleAnchor.anchorFound, true);
    assert.equal(middleAnchor.pageOffset, 1_300, "middle anchor rank uses the search sort order, not Git traversal ordinal");
    assert.equal(middleAnchor.commits[0].oid, middleAnchorOid);

    const resumedOldRows = await collectVersion(client, session, searchQuery, first, first.resultVersion);
    assert.deepEqual(resumedOldRows.map(commit => commit.oid), oldVersionRows.map(commit => commit.oid),
      "a cursor for the captured watermark remains stable after later index batches commit");
    const currentRows = await collectAll(client, session, searchQuery, 401);
    assert.deepEqual(currentRows.map(commit => commit.oid), latestExpected.map(record => record.oid),
      "the latest complete query equals the independent full Git oracle");
    assert.ok(currentRows.findIndex(commit => commit.oid === expected.rootOid) === 0);
  } finally {
    await rm(gateFile, { force: true });
    await client.stop();
  }
});

test("rebuild and snapshot-member eviction reject search cursors from obsolete result identities", async () => {
  const client = await startClient("search-rebuild");
  try {
    const session = projectSession(await client.open(repository));
    await client.readPage(session, null, 8);
    await waitForIndex(client, session, status => status.state === "complete");
    const first = projectSearchPage(await client.searchCommits(session, query({ message: "common" }), { pageSize: 5 }));
    assert.ok(first.nextCursor);
    const rebuiltRequest = await client.controlMetadataIndex(session, "rebuild");
    assert.ok(rebuiltRequest.chunks.some(chunk => chunk.data.section === "metadataIndex"));
    await waitForIndex(client, session, status => status.state === "complete", 90_000);
    await assert.rejects(client.searchCommits(session, query({ message: "common" }), { cursor: first.nextCursor, pageSize: 5 }),
      error => ["INVALID_CURSOR", "STALE_CONTEXT", "SNAPSHOT_CHANGED"].includes(error.code), "rebuild changes DB file identity and invalidates old cursors");
  } finally { await client.stop(); }
});

test("an LRU-evicted snapshot rejects its old cursor even while the original session stays open", async () => {
  const lru = await createMetadataLruFixture(join(dataRoot, "search-lru-fixture"), { branchCount: 9 });
  const originalClient = await startClient("search-lru-original", lru.repository);
  let evictionClient;
  try {
    let originalSession = projectSession(await originalClient.open(lru.repository));
    originalSession = projectSession(await originalClient.selectScope(originalSession, { ref: "refs/heads/lru-01" }, 2));
    await originalClient.readPage(originalSession, null, 2);
    await waitForIndex(originalClient, originalSession, status => status.state === "complete");
    const first = projectSearchPage(await originalClient.searchCommits(originalSession, query({ message: "snapshot cache" }), { pageSize: 1 }));
    assert.ok(first.nextCursor, "the initial snapshot search has an old-version cursor to invalidate");

    evictionClient = await startClient("search-lru-eviction-worker", lru.repository, {}, originalClient.appDataDir);
    let session = projectSession(await evictionClient.open(lru.repository));
    session = projectSession(await evictionClient.selectScope(session, { ref: "refs/heads/lru-01" }, 2));
    await evictionClient.readPage(session, null, 2);
    await waitForIndex(evictionClient, session, status => status.state === "complete");
    for (const branch of lru.branches) {
      const selected = await evictionClient.selectScope(session, { ref: `refs/heads/${branch.name}` }, 2);
      session = projectSession(selected);
      assert.ok(session, `scope ${branch.name} was selected`);
      await evictionClient.readPage(session, null, 2);
      await waitForIndex(evictionClient, session, status => status.state === "complete");
    }

    await assert.rejects(originalClient.searchCommits(originalSession, query({ message: "snapshot cache" }), { cursor: first.nextCursor, pageSize: 1 }),
      error => ["INVALID_CURSOR", "SNAPSHOT_CHANGED"].includes(error.code), "LRU eviction removes the bound snapshot membership and invalidates its old cursor");
  } finally {
    await evictionClient?.stop();
    await originalClient.stop();
  }
});

test("search cancellation returns CANCELLED; invalid prefixes and incompatible cursor parameters are rejected", async () => {
  const client = await startClient("search-cancel");
  try {
    const session = projectSession(await client.open(repository));
    await client.readPage(session, null, 8);
    await waitForIndex(client, session, status => status.state === "complete");
    const databasePath = await locateDatabase(client.appDataDir);
    const originalStat = await stat(databasePath);
    const lockDb = new DatabaseSync(databasePath);
    try {
      lockDb.exec("BEGIN EXCLUSIVE;");
      const pending = client.beginSearchCommits(session, query({ message: "common searchable marker" }), { pageSize: 500 }, 30_000);
      await delay(75);
      client.cancel(pending.requestId);
      await delay(75);
      lockDb.exec("ROLLBACK;");
      await assert.rejects(pending.result, error => error.code === "CANCELLED");

      lockDb.exec("BEGIN EXCLUSIVE;");
      const identities = client.beginRequest("listSearchIdentities", session.repoId, session.generation,
        { field: "author", text: "search", limit: 50 }, 30_000);
      await delay(75);
      client.cancel(identities.requestId);
      await delay(75);
      lockDb.exec("ROLLBACK;");
      await assert.rejects(identities.result, error => error.code === "CANCELLED");
    } finally {
      try { lockDb.exec("ROLLBACK;"); } catch {}
      lockDb.close();
    }
    const finalStat = await stat(databasePath);
    assert.equal(finalStat.size, originalStat.size, "exclusive read gate did not modify the index database");
    assert.equal(finalStat.mtimeMs, originalStat.mtimeMs, "exclusive read gate left the index file unmodified");
    const retry = projectSearchPage(await client.searchCommits(session, query({ message: "common searchable marker" }), { pageSize: 10 }));
    assert.equal(retry.commits.length, 10, "cancel does not poison a later search");
    assert.equal(retry.coverage.complete, true);

    await assert.rejects(client.searchCommits(session, query({ oidPrefix: "abc" }), { pageSize: 10 }), error => error.code === "INVALID_REQUEST",
      "OID prefix shorter than four hex digits is rejected");
    await assert.rejects(client.searchCommits(session, query({ oidPrefix: "gggg" }), { pageSize: 10 }), error => error.code === "INVALID_REQUEST",
      "non-hexadecimal OID prefix is rejected");
    await assert.rejects(client.searchCommits(session, query({ fromTimestamp: 10, toTimestamp: 10 }), { pageSize: 10 }), error => error.code === "INVALID_REQUEST",
      "empty or reversed half-open time intervals are rejected");
  } finally { await client.stop(); }
});

test("SHA-256 search preserves complete OIDs and accepts valid prefixes", { skip: !sha256Repository }, async () => {
  const client = await startClient("search-sha256", sha256Repository);
  try {
    const session = projectSession(await client.open(sha256Repository));
    await client.readPage(session, null, 1);
    await waitForIndex(client, session, status => status.state === "complete");
    const full = projectSearchPage(await client.searchCommits(session, query({ message: "SHA-256 search fixture" }), { pageSize: 5 }));
    assert.equal(full.commits.length, 1);
    assert.equal(full.commits[0].oid, expected.sha256Tip);
    assert.equal(full.commits[0].oid.length, 64);
    const prefix = projectSearchPage(await client.searchCommits(session, query({ oidPrefix: expected.sha256Tip.slice(0, 4) }), { pageSize: 5 }));
    assert.deepEqual(prefix.commits.map(commit => commit.oid), [expected.sha256Tip]);
  } finally { await client.stop(); }
});

function query(overrides = {}) {
  return {
    message: "",
    caseSensitive: false,
    authors: [],
    committers: [],
    oidPrefix: "",
    path: null,
    timeField: "committer",
    fromTimestamp: null,
    toTimestamp: null,
    timeZone: "Asia/Shanghai",
    ...overrides,
  };
}

async function startClient(name, cwd = repository, extra = {}, sharedDataDir = null) {
  const ownData = sharedDataDir ?? join(dataRoot, name);
  const client = new SearchDaemonClient(daemonPath, { cwd, env: createDaemonEnvironment(ownData, extra) });
  client.appDataDir = ownData;
  await client.start();
  return client;
}

async function collectAll(client, session, searchQuery, pageSize) {
  let page = projectSearchPage(await client.searchCommits(session, searchQuery, { pageSize }));
  assert.equal(page.coverage.complete, true);
  const rows = [...page.commits];
  const seenCursors = new Set();
  while (page.nextCursor) {
    assert.ok(!seenCursors.has(page.nextCursor), "search cursor advances and cannot loop");
    seenCursors.add(page.nextCursor);
    const next = projectSearchPage(await client.searchCommits(session, searchQuery, { cursor: page.nextCursor, pageSize }));
    assert.equal(next.resultVersion, page.resultVersion);
    assert.equal(next.queryKey, page.queryKey);
    assert.equal(next.snapshotKey, page.snapshotKey);
    assert.equal(next.coverage.complete, true);
    assert.equal(next.pageOffset, rows.length);
    rows.push(...next.commits);
    page = next;
  }
  assert.equal(rows.length, page.matchedCount, "complete traversal reaches the exact result count");
  assert.equal(new Set(rows.map(row => row.oid)).size, rows.length, "complete result paging has no duplicate OIDs");
  return rows;
}

async function collectVersion(client, session, searchQuery, firstPage, resultVersion) {
  const rows = [...firstPage.commits];
  let page = firstPage;
  while (page.nextCursor) {
    page = projectSearchPage(await client.searchCommits(session, searchQuery, { cursor: page.nextCursor, pageSize: firstPage.commits.length || 17 }));
    assert.equal(page.resultVersion, resultVersion, "watermark cursor stays on its original version");
    assert.deepEqual(page.coverage, firstPage.coverage);
    assert.equal(page.matchedCount, firstPage.matchedCount);
    assert.equal(page.pageOffset, rows.length);
    rows.push(...page.commits);
  }
  assert.equal(rows.length, firstPage.matchedCount);
  assert.equal(new Set(rows.map(row => row.oid)).size, rows.length);
  return rows;
}

function oracle(source, searchQuery) {
  let matches = source.filter(record => {
    if (searchQuery.message) {
      // The general oracle uses ASCII-only fixture markers; full Unicode fold cases are asserted by frozen OID sets.
      const haystack = searchQuery.caseSensitive ? record.message : asciiFold(record.message);
      const needle = searchQuery.caseSensitive ? searchQuery.message : asciiFold(searchQuery.message);
      if (!haystack.includes(needle)) return false;
    }
    if (searchQuery.authors.length && !searchQuery.authors.some(identity => sameIdentity(identity, record.author))) return false;
    if (searchQuery.committers.length && !searchQuery.committers.some(identity => sameIdentity(identity, record.committer))) return false;
    if (searchQuery.oidPrefix && !record.oid.toLowerCase().startsWith(searchQuery.oidPrefix.toLowerCase())) return false;
    const timestamp = searchQuery.timeField === "author" ? record.author.timestamp : record.committer.timestamp;
    if (searchQuery.fromTimestamp !== null && timestamp < searchQuery.fromTimestamp) return false;
    if (searchQuery.toTimestamp !== null && timestamp >= searchQuery.toTimestamp) return false;
    return true;
  });
  matches = matches.slice().sort((left, right) => {
    const leftTime = searchQuery.timeField === "author" ? left.author.timestamp : left.committer.timestamp;
    const rightTime = searchQuery.timeField === "author" ? right.author.timestamp : right.committer.timestamp;
    return rightTime - leftTime || (left.oid < right.oid ? -1 : left.oid > right.oid ? 1 : 0);
  });
  return matches;
}

function uniqueIdentities(source, field) {
  const identities = new Map();
  for (const record of source) {
    const identity = record[field];
    identities.set(`${identity.name}\0${identity.email}`, { name: identity.name, email: identity.email });
  }
  return [...identities.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.email < b.email ? -1 : a.email > b.email ? 1 : 0);
}

function sameIdentity(left, right) { return left.name === right.name && left.email === right.email; }
function asciiFold(text) { return text.replace(/[A-Z]/gu, character => character.toLowerCase()); }

async function waitForIndex(client, session, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = projectMetadataStatus(await client.getMetadataIndexStatus(session));
    if (predicate(latest)) return latest;
    await delay(50);
  }
  throw new Error(`Timed out waiting for metadata index: ${JSON.stringify(latest)}`);
}

async function waitForFile(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch {}
    await delay(10);
  }
  throw new Error(`Timed out waiting for Git batch gate ${path}`);
}

async function locateDatabase(appDataDir) {
  const indexRoot = join(appDataDir, "metadata-index");
  const repositories = await readdir(indexRoot, { withFileTypes: true });
  const paths = repositories.filter(entry => entry.isDirectory()).map(entry => join(indexRoot, entry.name, "index.sqlite3"));
  const existing = [];
  for (const path of paths) try { await access(path); existing.push(path); } catch {}
  assert.equal(existing.length, 1, `expected one search cache under ${indexRoot}`);
  return existing[0];
}
