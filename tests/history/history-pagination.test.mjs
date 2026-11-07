import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { HistoryDaemonClient, createDaemonEnvironment, projectPage, projectSession } from "./daemon-client.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const execFileAsync = promisify(execFile);
const fixtureRoot = resolve(process.env.COMMITSCOPE_HISTORY_FIXTURE_ROOT);
const daemonPath = resolve(process.env.COMMITSCOPE_DAEMON_PATH);
const gitPath = resolve(process.env.COMMITSCOPE_HISTORY_REAL_GIT);
const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));

test("topology history pages preserve Git topo order, merge ancestry, retry handles, and repository immutability", async () => {
  for (const pageSize of [1, 2, 3, 7, 200, 500]) {
    const repositoryPath = join(fixtureRoot, "topology");
    const before = await snapshotTree(repositoryPath);
    const client = await startClient(`topology-${pageSize}`);
    try {
      const session = await openSession(client, repositoryPath);
      const expected = await gitRevList(repositoryPath, session.repository.headOid);
      const pages = await walk(client, session, pageSize);
      assert.deepEqual(pages.flatMap(page => page.commits.map(commit => commit.oid)), expected, `all pages must match Git topo order at pageSize=${pageSize}`);
      assert.equal(new Set(pages.flatMap(page => page.commits.map(commit => commit.oid))).size, expected.length, "merge ancestors appear once");
      assert.equal(pages[0].offset, 0);
      assert.equal(pages.at(-1).hasMore, false);
      assert.equal(pages.at(-1).nextCursor, null);
      assert.equal(pages.every(page => page.coverage.complete && page.done), true);
      if (pages.length > 1) assert.equal(pages[1].previousCursor, pages[0].cursor);

      const firstAgain = projectPage(await client.readPage(session, pages[0].cursor, pageSize));
      assert.deepEqual(firstAgain.commits.map(commit => commit.oid), pages[0].commits.map(commit => commit.oid), "the current page cursor is an idempotent retry handle");
      assert.equal(firstAgain.cursor, pages[0].cursor);
      assert.equal(firstAgain.nextCursor, pages[0].nextCursor);
      assert.equal(firstAgain.offset, pages[0].offset);
      assert.deepEqual(await snapshotTree(repositoryPath), before, "history reads and cursor retries are read-only");
    } finally {
      await client.stop();
    }
  }
});

test("empty, detached, bare, linked, shallow, and optional SHA-256 snapshots paginate against independent Git", async () => {
  const cases = [
    ["empty", join(fixtureRoot, "empty")],
    ["detached", join(fixtureRoot, "detached")],
    ["bare", join(fixtureRoot, "bare")],
    ["linked", join(fixtureRoot, "linked-worktree")],
    ["shallow", join(fixtureRoot, "shallow")],
  ];
  if (manifest.fixtures.sha256?.supported) cases.push(["sha256", join(fixtureRoot, "sha256")]);
  const client = await startClient("repo-shapes");
  try {
    for (const [label, repositoryPath] of cases) {
      const before = await snapshotTree(repositoryPath);
      const session = await openSession(client, repositoryPath);
      const pages = await walk(client, session, 2);
      const expected = session.repository.headOid ? await gitRevList(repositoryPath, session.repository.headOid) : [];
      assert.deepEqual(pages.flatMap(page => page.commits.map(commit => commit.oid)), expected, `${label} matches Git`);
      assert.deepEqual(await snapshotTree(repositoryPath), before, `${label} remains read-only`);
      await client.close(session);
    }
  } finally {
    await client.stop();
  }
});

test("new-since-last-view matches independent Git for first view, an empty saved view, and multi-page fast-forward", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-history-markers-"));
  const repositoryPath = join(temporaryRoot, "repository");
  await mkdir(repositoryPath);
  await gitRun(["init", "--quiet", "--initial-branch=main", repositoryPath]);
  await gitRun(["-C", repositoryPath, "config", "user.name", "Marker Oracle"]);
  await gitRun(["-C", repositoryPath, "config", "user.email", "marker@example.invalid"]);
  const client = await startClient("new-since-last-view");
  try {
    const emptySession = await openSession(client, repositoryPath);
    const emptyFirstView = projectPage(await client.readPage(emptySession, null, 1));
    assert.equal(emptyFirstView.newSinceLastSeenStatus, "firstView");
    assert.equal(emptyFirstView.lastSeenDividerOid, null);
    assert.deepEqual(emptyFirstView.commits, []);
    const emptyRecord = await client.recordView(emptySession);
    assert.equal(emptyRecord.data.section, "repositoryViewRecorded");
    assert.equal(emptyRecord.data.saved, true);
    assert.equal(emptyRecord.data.status, "ok");
    await client.close(emptySession);

    for (let index = 1; index <= 5; index += 1) await createEmptyCommit(repositoryPath, `new after empty ${index}`);
    const afterEmptySession = await openSession(client, repositoryPath);
    assert.deepEqual(afterEmptySession.previousView?.tips, []);
    const afterEmptyPages = await walk(client, afterEmptySession, 2);
    const afterEmptyExpected = await gitRevList(repositoryPath, afterEmptySession.repository.headOid);
    assert.deepEqual(afterEmptyPages.flatMap(page => page.commits.map(commit => commit.oid)), afterEmptyExpected);
    assert.equal(afterEmptyPages.every(page => page.newSinceLastSeenStatus === "ready" && page.commits.every(commit => commit.isNewSinceLastSeen)), true, "a saved empty tips set makes all reachable commits new");
    assert.equal(afterEmptyPages.every(page => page.lastSeenDividerOid === null), true, "all-new histories have no divider");
    const oldTip = afterEmptySession.repository.headOid;
    const saved = await client.recordView(afterEmptySession);
    assert.equal(saved.data.saved, true);
    await client.close(afterEmptySession);

    for (let index = 1; index <= 5; index += 1) await createEmptyCommit(repositoryPath, `fast forward ${index}`);
    const advancedSession = await openSession(client, repositoryPath);
    assert.deepEqual(advancedSession.previousView?.tips, [oldTip]);
    const startedAt = performance.now();
    const pages = await walk(client, advancedSession, 1);
    const elapsedMs = performance.now() - startedAt;
    const currentTip = advancedSession.repository.headOid;
    const currentOrder = await gitRevList(repositoryPath, currentTip);
    const expectedNew = new Set(await gitRevListNot(repositoryPath, currentTip, oldTip));
    const commits = pages.flatMap(page => page.commits);
    assert.deepEqual(commits.map(commit => commit.oid), currentOrder);
    assert.deepEqual(commits.filter(commit => commit.isNewSinceLastSeen).map(commit => commit.oid), currentOrder.filter(oid => expectedNew.has(oid)));
    assert.equal(pages.every(page => page.newSinceLastSeenStatus === "ready"), true);
    assert.equal(pages.slice(0, 5).every(page => page.lastSeenDividerOid === null), true, "the divider remains unknown while every page so far is new");
    assert.equal(pages.slice(0, 5).every(page => page.commits.length === 1 && page.commits[0].isNewSinceLastSeen), true, "multiple complete all-new pages precede the divider");
    assert.equal(pages[5].commits[0].oid, oldTip, "the divider can land at the first row of the next page");
    assert.equal(pages[5].commits[0].isNewSinceLastSeen, false);
    assert.equal(pages[5].lastSeenDividerOid, oldTip, "the page that proves the first old commit publishes the divider OID");
    assert.equal(pages.slice(6).every(page => page.lastSeenDividerOid === oldTip), true, "once proven, the divider OID remains available to subsequent pages");
    const warmedFirstPage = projectPage(await client.readPage(advancedSession, pages[0].cursor, 1));
    assert.equal(warmedFirstPage.lastSeenDividerOid, oldTip, "replaying a cached first page receives the now-proven query metadata");
    assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0);

    const rebaseRecord = await client.recordView(advancedSession);
    assert.equal(rebaseRecord.data.saved, true);
    await client.close(advancedSession);
    const tree = (await gitOutput(["-C", repositoryPath, "rev-parse", `${currentTip}^{tree}`])).trim();
    const rewrittenTip = (await gitOutput(["-C", repositoryPath, "-c", "user.name=Marker Oracle", "-c", "user.email=marker@example.invalid", "commit-tree", tree, "-m", "rebased root"])).trim();
    await gitRun(["-C", repositoryPath, "update-ref", "refs/heads/main", rewrittenTip]);
    await gitRun(["-C", repositoryPath, "reflog", "expire", "--expire=now", "--all"]);
    await gitRun(["-C", repositoryPath, "-c", "gc.pruneExpire=now", "gc", "--prune=now"]);
    await assert.rejects(gitOutput(["-C", repositoryPath, "cat-file", "-e", `${currentTip}^{commit}`]), "rewritten old tip should be pruned from the isolated test repository");
    const rewrittenSession = await openSession(client, repositoryPath);
    const afterRewrite = projectPage(await client.readPage(rewrittenSession, null, 10));
    assert.deepEqual(rewrittenSession.previousView?.tips, [currentTip]);
    assert.equal(afterRewrite.newSinceLastSeenStatus, "unavailable", "a missing previous tip disables marking without blocking history");
    assert.equal(afterRewrite.commits.every(commit => !commit.isNewSinceLastSeen), true, "missing old objects must not produce partial positives");
    assert.equal(afterRewrite.commits[0].oid, rewrittenTip);
  } finally {
    await client.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("noncontiguous new commits follow topo-order reachability and never claim a divider", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-history-interleaved-markers-"));
  const repositoryPath = join(temporaryRoot, "repository");
  await mkdir(repositoryPath);
  await gitRun(["init", "--quiet", "--initial-branch=main", repositoryPath]);
  await gitRun(["-C", repositoryPath, "config", "user.name", "Marker Oracle"]);
  await gitRun(["-C", repositoryPath, "config", "user.email", "marker@example.invalid"]);
  const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const base = await createTreeCommit(repositoryPath, tree, [], "base", 100);
  const oldFirst = await createTreeCommit(repositoryPath, tree, [base], "old first", 200);
  const oldTip = await createTreeCommit(repositoryPath, tree, [oldFirst], "old tip", 300);
  const newFirst = await createTreeCommit(repositoryPath, tree, [base], "new first", 150);
  const newTip = await createTreeCommit(repositoryPath, tree, [newFirst], "new tip", 250);
  const merge = await createTreeCommit(repositoryPath, tree, [newTip, oldTip], "merge", 400);
  await gitRun(["-C", repositoryPath, "update-ref", "refs/heads/main", oldTip]);
  const client = await startClient("new-since-last-view-interleaved");
  try {
    const oldSession = await openSession(client, repositoryPath);
    assert.equal(oldSession.repository.headOid, oldTip);
    assert.equal((await client.recordView(oldSession)).data.saved, true);
    await client.close(oldSession);
    await gitRun(["-C", repositoryPath, "update-ref", "refs/heads/main", merge]);
    const session = await openSession(client, repositoryPath);
    const pages = await walk(client, session, 1);
    const actualOrder = pages.flatMap(page => page.commits);
    const expectedOrder = await gitRevList(repositoryPath, merge);
    const expectedNew = new Set(await gitRevListNot(repositoryPath, merge, oldTip));
    assert.deepEqual(actualOrder.map(commit => commit.oid), expectedOrder);
    assert.deepEqual(actualOrder.filter(commit => commit.isNewSinceLastSeen).map(commit => commit.oid), expectedOrder.filter(oid => expectedNew.has(oid)));
    const flags = actualOrder.map(commit => commit.isNewSinceLastSeen);
    assert.equal(flags.includes(true), true);
    assert.equal(flags.includes(false), true);
    assert.equal(flags.slice(flags.indexOf(false)).includes(true), true, `fixture must have a new commit after an old commit in topo order: ${JSON.stringify(expectedOrder)}`);
    assert.equal(pages.every(page => page.lastSeenDividerOid === null), true, "noncontiguous marker sets never claim a last-seen divider");
  } finally {
    await client.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("an old tip with a missing intermediate ancestor is unavailable even when Git exits successfully", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-history-marker-missing-ancestor-"));
  const repositoryPath = join(temporaryRoot, "repository");
  await mkdir(repositoryPath);
  await gitRun(["init", "--quiet", "--initial-branch=main", repositoryPath]);
  await gitRun(["-C", repositoryPath, "config", "user.name", "Marker Oracle"]);
  await gitRun(["-C", repositoryPath, "config", "user.email", "marker@example.invalid"]);
  const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const base = await createTreeCommit(repositoryPath, tree, [], "shared base", 100);
  const missingAncestor = await createTreeCommit(repositoryPath, tree, [base], "old middle", 200);
  const oldTip = await createTreeCommit(repositoryPath, tree, [missingAncestor], "old tip", 300);
  await gitRun(["-C", repositoryPath, "update-ref", "refs/heads/main", oldTip]);
  const client = await startClient("new-since-last-view-missing-intermediate");
  try {
    const oldSession = await openSession(client, repositoryPath);
    assert.equal((await client.recordView(oldSession)).data.saved, true);
    await client.close(oldSession);
    const currentTip = await createTreeCommit(repositoryPath, tree, [base], "current complete side", 400);
    await gitRun(["-C", repositoryPath, "update-ref", "refs/heads/main", currentTip]);
    const session = await openSession(client, repositoryPath);
    assert.deepEqual(session.previousView?.tips, [oldTip]);
    const first = projectPage(await client.readPage(session, null, 1));
    assert.deepEqual(first.commits.map(commit => commit.oid), [currentTip]);
    assert.equal(first.newSinceLastSeenStatus, "ready");
    assert.equal(first.commits[0].isNewSinceLastSeen, true, "the intact first page should be marked before the old chain changes");

    const objectPath = join(repositoryPath, ".git", "objects", missingAncestor.slice(0, 2), missingAncestor.slice(2));
    await rm(objectPath);
    await gitOutput(["-C", repositoryPath, "cat-file", "-e", `${oldTip}^{commit}`]);
    await assert.rejects(gitOutput(["-C", repositoryPath, "cat-file", "-e", `${missingAncestor}^{commit}`]));
    const naiveGitResult = await gitRevListNot(repositoryPath, currentTip, oldTip);
    assert.ok(naiveGitResult.includes(base), "fixture reproduces Git's successful but incomplete negative-revision result");

    const second = projectPage(await client.readPage(session, first.nextCursor, 1));
    assert.deepEqual(second.commits.map(commit => commit.oid), [base]);
    assert.equal(second.newSinceLastSeenStatus, "unavailable", "a missing old ancestor after the first page must invalidate the query");
    assert.equal(second.commits.every(commit => !commit.isNewSinceLastSeen), true, "incomplete old membership cannot create false positives");
    const replay = projectPage(await client.readPage(session, first.cursor, 1));
    assert.deepEqual(replay.commits.map(commit => commit.oid), [currentTip]);
    assert.equal(replay.newSinceLastSeenStatus, "unavailable", "a cached earlier page must reflect query-wide degradation");
    assert.equal(replay.commits.every(commit => !commit.isNewSinceLastSeen), true, "degradation clears markers from already-cached pages");
  } finally {
    await client.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("marker comparison cancellation rejects as CANCELLED; deadline degrades to unavailable and cached replay stays unmarked", { skip: process.platform === "win32" }, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-history-marker-cancel-"));
  const repositoryPath = join(temporaryRoot, "repository");
  await mkdir(repositoryPath);
  await gitRun(["init", "--quiet", "--initial-branch=main", repositoryPath]);
  await gitRun(["-C", repositoryPath, "config", "user.name", "Marker Cancel"]);
  await gitRun(["-C", repositoryPath, "config", "user.email", "marker-cancel@example.invalid"]);
  await createEmptyCommit(repositoryPath, "old base");
  const gateFile = resolve(process.env.COMMITSCOPE_HISTORY_BLOCK_GATE_FILE);
  const pidFile = resolve(process.env.COMMITSCOPE_HISTORY_PID_FILE);
  await rm(gateFile, { force: true });
  await rm(pidFile, { force: true });
  const client = await startClient("new-since-last-view-cancel", {
    PATH: `${resolve(process.env.COMMITSCOPE_HISTORY_SLOW_GIT_DIRECTORY)}:${process.env.PATH}`,
    COMMITSCOPE_HISTORY_BLOCK_COMMAND: "rev-list",
    COMMITSCOPE_HISTORY_BLOCK_MARKER_ONLY: "1",
  });
  let gateOpen = false;
  try {
    const first = await openSession(client, repositoryPath);
    const oldTip = first.repository.headOid;
    assert.equal((await client.recordView(first)).data.saved, true);
    await client.close(first);
    await createEmptyCommit(repositoryPath, "new commit");
    const session = await openSession(client, repositoryPath);
    assert.deepEqual(session.previousView?.tips, [oldTip]);

    await writeFile(gateFile, "block marker comparison\n");
    gateOpen = true;
    const cancelledRequest = client.beginReadPage(session, null, 2, 10_000);
    const cancelPid = await waitForFileNumber(pidFile);
    assert.equal(await isProcessAlive(cancelPid), true, "the marker-only rev-list helper is blocked before cancellation");
    client.cancel(cancelledRequest.requestId);
    await assert.rejects(cancelledRequest.result, error => error.code === "CANCELLED", "explicit cancel must remain a cancellation error");
    await waitForProcessExit(cancelPid);
    await rm(gateFile, { force: true });
    gateOpen = false;

    const retry = projectPage(await client.readPage(session, null, 2));
    assert.equal(retry.newSinceLastSeenStatus, "ready");
    assert.deepEqual(retry.commits.filter(commit => commit.isNewSinceLastSeen).map(commit => commit.oid), [session.repository.headOid]);
    await client.close(session);

    await rm(pidFile, { force: true });
    const timeoutSession = await openSession(client, repositoryPath);
    await writeFile(gateFile, "block marker comparison until budget\n");
    gateOpen = true;
    const timeoutStartedAt = performance.now();
    const timeoutRead = client.readPage(timeoutSession, null, 2, 10_000);
    const timeoutPid = await waitForFileNumber(pidFile);
    const beforeTimeoutSnapshot = await snapshotTree(repositoryPath);
    const timedOutPage = projectPage(await timeoutRead);
    const markerElapsedMs = performance.now() - timeoutStartedAt;
    assert.equal(timedOutPage.newSinceLastSeenStatus, "unavailable", "a marker deadline returns history with comparison unavailable");
    assert.equal(timedOutPage.commits.some(commit => commit.isNewSinceLastSeen), false, "deadline results clear all positive markers");
    assert.ok(markerElapsedMs >= 1_500 && markerElapsedMs < 10_000, `marker deadline should be bounded near 2 seconds, got ${markerElapsedMs.toFixed(1)}ms`);
    await waitForProcessExit(timeoutPid);
    const cached = projectPage(await client.readPage(timeoutSession, timedOutPage.cursor, 2));
    assert.equal(cached.newSinceLastSeenStatus, "unavailable");
    assert.equal(cached.commits.some(commit => commit.isNewSinceLastSeen), false, "cache replay preserves global unavailable state");
    assert.deepEqual(await snapshotTree(repositoryPath), beforeTimeoutSnapshot, "marker query, cancel and retry are read-only");
    process.stdout.write(`P1-03 marker timeout observation: ${JSON.stringify({ status: timedOutPage.newSinceLastSeenStatus, configuredBudgetMs: markerElapsedMs, retryStatus: retry.newSinceLastSeenStatus })}\n`);
  } finally {
    if (gateOpen) await rm(gateFile, { force: true });
    await client.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("positive old-tip stream cancellation stays CANCELLED and its deadline clears markers", { skip: process.platform === "win32" }, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-history-marker-old-stream-"));
  const repositoryPath = join(temporaryRoot, "repository");
  await mkdir(repositoryPath);
  await gitRun(["init", "--quiet", "--initial-branch=main", repositoryPath]);
  await gitRun(["-C", repositoryPath, "config", "user.name", "Marker Stream"]);
  await gitRun(["-C", repositoryPath, "config", "user.email", "marker-stream@example.invalid"]);
  const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const base = await createTreeCommit(repositoryPath, tree, [], "base", 100);
  const oldMiddle = await createTreeCommit(repositoryPath, tree, [base], "old middle", 200);
  const oldTip = await createTreeCommit(repositoryPath, tree, [oldMiddle], "old tip", 300);
  await gitRun(["-C", repositoryPath, "update-ref", "refs/heads/main", oldTip]);
  const gateFile = resolve(process.env.COMMITSCOPE_HISTORY_BLOCK_GATE_FILE);
  const pidFile = resolve(process.env.COMMITSCOPE_HISTORY_PID_FILE);
  await rm(gateFile, { force: true });
  await rm(pidFile, { force: true });
  const client = await startClient("new-since-last-view-old-stream", {
    PATH: `${resolve(process.env.COMMITSCOPE_HISTORY_SLOW_GIT_DIRECTORY)}:${process.env.PATH}`,
    COMMITSCOPE_HISTORY_BLOCK_COMMAND: "rev-list",
    COMMITSCOPE_HISTORY_BLOCK_OLD_STREAM: "1",
    COMMITSCOPE_HISTORY_BLOCK_OID: oldTip,
  });
  let gateOpen = false;
  try {
    const oldSession = await openSession(client, repositoryPath);
    assert.equal((await client.recordView(oldSession)).data.saved, true);
    await client.close(oldSession);
    const currentTip = await createTreeCommit(repositoryPath, tree, [base], "current new branch", 400);
    await gitRun(["-C", repositoryPath, "update-ref", "refs/heads/main", currentTip]);
    const session = await openSession(client, repositoryPath);
    assert.deepEqual(session.previousView?.tips, [oldTip]);

    await writeFile(gateFile, "block old membership stream\n");
    gateOpen = true;
    const cancelled = client.beginReadPage(session, null, 2, 10_000);
    const cancelledPid = await waitForFileNumber(pidFile);
    assert.equal(await isProcessAlive(cancelledPid), true, "positive old-tip rev-list is held before cancellation");
    client.cancel(cancelled.requestId);
    await assert.rejects(cancelled.result, error => error.code === "CANCELLED");
    await waitForProcessExit(cancelledPid);
    await rm(gateFile, { force: true });
    gateOpen = false;
    const retry = projectPage(await client.readPage(session, null, 2));
    assert.equal(retry.newSinceLastSeenStatus, "ready");
    assert.equal(retry.commits.some(commit => commit.isNewSinceLastSeen), true);
    await client.close(session);

    await rm(pidFile, { force: true });
    const timeoutSession = await openSession(client, repositoryPath);
    await writeFile(gateFile, "block old membership stream until marker deadline\n");
    gateOpen = true;
    const startedAt = performance.now();
    const timeoutRead = client.readPage(timeoutSession, null, 2, 10_000);
    const timeoutPid = await waitForFileNumber(pidFile);
    const timedOutPage = projectPage(await timeoutRead);
    const elapsedMs = performance.now() - startedAt;
    assert.equal(timedOutPage.newSinceLastSeenStatus, "unavailable");
    assert.equal(timedOutPage.commits.some(commit => commit.isNewSinceLastSeen), false);
    assert.ok(elapsedMs >= 1_500 && elapsedMs < 10_000, `old membership should be bounded by the marker deadline, got ${elapsedMs.toFixed(1)}ms`);
    await waitForProcessExit(timeoutPid);
    const replay = projectPage(await client.readPage(timeoutSession, timedOutPage.cursor, 2));
    assert.equal(replay.newSinceLastSeenStatus, "unavailable");
    assert.equal(replay.commits.some(commit => commit.isNewSinceLastSeen), false, "replay after a timed-out old stream remains unmarked");
  } finally {
    if (gateOpen) await rm(gateFile, { force: true });
    await client.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("100k synthetic saved-tip marker count is independently checked and its page latency is recorded", { skip: !process.env.COMMITSCOPE_HISTORY_LARGE_REPOSITORY }, async () => {
  const sourceRepository = resolve(process.env.COMMITSCOPE_HISTORY_LARGE_REPOSITORY);
  const before = await snapshotTree(sourceRepository);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-history-marker-large-"));
  const repositoryPath = join(temporaryRoot, "large-window");
  const client = await startClient("new-since-last-view-large-window");
  try {
    await gitRun(["clone", "--shared", "--no-hardlinks", "--quiet", "--no-checkout", sourceRepository, repositoryPath]);
    const currentTip = (await gitOutput(["-C", repositoryPath, "rev-parse", "refs/heads/main"])).trim();
    const oldTip = (await gitOutput(["-C", repositoryPath, "rev-parse", "refs/heads/main~100"])).trim();
    await gitRun(["-C", repositoryPath, "update-ref", "refs/heads/main", oldTip]);
    const oldSession = await openSession(client, repositoryPath);
    assert.equal(oldSession.repository.headOid, oldTip);
    const saved = await client.recordView(oldSession);
    assert.equal(saved.data.saved, true);
    await client.close(oldSession);
    await gitRun(["-C", repositoryPath, "update-ref", "refs/heads/main", currentTip]);

    const session = await openSession(client, repositoryPath);
    assert.deepEqual(session.previousView?.tips, [oldTip]);
    const startedAt = performance.now();
    const page = projectPage(await client.readPage(session, null, 200, 15_000));
    const elapsedMs = performance.now() - startedAt;
    const expectedOrder = await gitRevList(repositoryPath, currentTip);
    const expectedNew = new Set(await gitRevListNot(repositoryPath, currentTip, oldTip));
    assert.deepEqual(page.commits.map(commit => commit.oid), expectedOrder.slice(0, 200));
    assert.equal(expectedNew.size, 100);
    if (page.newSinceLastSeenStatus === "ready") {
      assert.deepEqual(page.commits.filter(commit => commit.isNewSinceLastSeen).map(commit => commit.oid), expectedOrder.filter(oid => expectedNew.has(oid)));
      assert.equal(page.lastSeenDividerOid, oldTip);
    } else {
      assert.equal(page.newSinceLastSeenStatus, "unavailable");
      assert.equal(page.commits.some(commit => commit.isNewSinceLastSeen), false, "a timed out comparison clears markers instead of returning partial positives");
      assert.ok(elapsedMs >= 1_500, `unavailable with a valid old tip should only occur after the bounded marker budget, got ${elapsedMs.toFixed(1)}ms`);
    }
    assert.deepEqual(await snapshotTree(sourceRepository), before, "the fixed 100k fixture remains unchanged; only a temporary shared clone ref moved");
    process.stdout.write(`P1-03 marker 100k observation: ${JSON.stringify({ elapsedMs, status: page.newSinceLastSeenStatus, expectedNewCount: expectedNew.size, returnedNewCount: page.commits.filter(commit => commit.isNewSinceLastSeen).length, dividerOid: page.lastSeenDividerOid })}\n`);
  } finally {
    await client.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("external HEAD movement leaves old cursor frozen; refresh publishes a new session and first page atomically", async () => {
  const repositoryPath = join(fixtureRoot, "topology");
  const client = await startClient("refresh");
  let renamed = false;
  const parkedPath = `${repositoryPath}.p1-02-parked`;
  try {
    const oldSession = await openSession(client, repositoryPath);
    const oldExpected = await gitRevList(repositoryPath, oldSession.repository.headOid);
    const first = projectPage(await client.readPage(oldSession, null, 2));
    assert.equal(first.offset, 0);
    const previousCount = await commitCount(repositoryPath);
    const newTip = await createEmptyCommit(repositoryPath, "P1-02 external advance");
    assert.notEqual(newTip, oldSession.repository.headOid);
    assert.equal(await commitCount(repositoryPath), previousCount + 1);
    const beforeRefresh = await snapshotTree(repositoryPath);

    const oldSecond = projectPage(await client.readPage(oldSession, first.nextCursor, 2));
    assert.equal(oldSecond.repository.headOid, oldSession.repository.headOid);
    const oldPages = [first, oldSecond];
    let page = oldSecond;
    while (page.nextCursor !== null) {
      page = projectPage(await client.readPage(oldSession, page.nextCursor, 2));
      oldPages.push(page);
    }
    assert.deepEqual(oldPages.flatMap(item => item.commits.map(commit => commit.oid)), oldExpected, "existing query never incorporates the new HEAD");

    const refreshed = await client.refresh(oldSession, 2);
    const newSession = projectSession(refreshed);
    const newPage = projectPage(refreshed);
    assert.ok(newSession);
    assert.notEqual(newSession.generation, oldSession.generation);
    assert.notEqual(newSession.repoId, oldSession.repoId);
    assert.equal(refreshed.chunks.every(chunk => chunk.repoId === oldSession.repoId && chunk.generation === oldSession.generation), true, "refresh envelopes echo the request context while session data carries the new context");
    assert.equal(newPage.repository.headOid, newTip);
    assert.equal(newPage.offset, 0);
    assert.deepEqual(newPage.commits.map(commit => commit.oid), (await gitRevList(repositoryPath, newTip)).slice(0, 2));
    assert.deepEqual(await snapshotTree(repositoryPath), beforeRefresh, "refresh reads the repository without writing it");
    await assert.rejects(client.readPage(oldSession, first.cursor, 2), error => error.code === "STALE_CONTEXT");

    const latest = projectPage(await client.readPage(newSession, newPage.nextCursor, 2));
    assert.equal(latest.repository.headOid, newTip, "new pages remain bound to refreshed HEAD");

    await client.close(newSession);

    const failedCandidate = await openSession(client, repositoryPath);
    const retainedPage = projectPage(await client.readPage(failedCandidate, null, 2));
    await rename(repositoryPath, parkedPath);
    renamed = true;
    await assert.rejects(client.refresh(failedCandidate, 2), error => error.code !== "CANCELLED");
    const retained = (await client.getSession(failedCandidate)).data.session;
    assert.equal(retained.repoId, failedCandidate.repoId);
    await rename(parkedPath, repositoryPath);
    renamed = false;
    assert.deepEqual(projectPage(await client.readPage(failedCandidate, retainedPage.cursor, 2)).commits.map(commit => commit.oid), retainedPage.commits.map(commit => commit.oid));
  } finally {
    if (renamed) await rename(parkedPath, repositoryPath);
    await client.stop();
  }
});

test("cursor syntax, page-size binding, future offsets, and stale generations are rejected", async () => {
  const client = await startClient("cursor-validation");
  try {
    const session = await openSession(client, join(fixtureRoot, "topology"));
    const first = projectPage(await client.readPage(session, null, 2));
    await assert.rejects(client.readPage(session, "not-a-cursor", 2), error => error.code === "INVALID_CURSOR");
    await assert.rejects(client.readPage(session, first.cursor, 3), error => error.code === "INVALID_CURSOR");
    const [version, queryId, firstOffset] = first.cursor.split(":");
    assert.equal(version, "v1");
    const futureCursor = `${version}:${queryId}:${Number(firstOffset) + 200_000}`;
    const signedCursor = `${version}:${queryId}:+${firstOffset}`;
    const paddedCursor = `${version}:${queryId}:0${firstOffset}`;
    await assert.rejects(client.readPage(session, futureCursor, 2), error => error.code === "INVALID_CURSOR");
    await assert.rejects(client.readPage(session, signedCursor, 2), error => error.code === "INVALID_CURSOR");
    await assert.rejects(client.readPage(session, paddedCursor, 2), error => error.code === "INVALID_CURSOR");
    await assert.rejects(client.readPage(session, null, 501), error => error.code === "INVALID_REQUEST" || error.code === "INVALID_CURSOR");
    await client.readPage(session, null, 3);
    await assert.rejects(client.readPage(session, first.cursor, 2), error => error.code === "INVALID_CURSOR", "a null-cursor query with a new page size invalidates the old query");
    const refreshed = await client.refresh(session, 2);
    const nextSession = projectSession(refreshed);
    await assert.rejects(client.readPage(nextSession, first.cursor, 2), error => error.code === "INVALID_CURSOR" || error.code === "STALE_CONTEXT");
    await assert.rejects(client.readPage(session, first.cursor, 2), error => error.code === "STALE_CONTEXT");
  } finally {
    await client.stop();
  }
});

test("cancel rev-list and cat-file streams, retry the same cursor, and reap children", { skip: process.platform === "win32" }, async () => {
  const slowDirectory = resolve(process.env.COMMITSCOPE_HISTORY_SLOW_GIT_DIRECTORY);
  const pidFile = resolve(process.env.COMMITSCOPE_HISTORY_PID_FILE);
  const repositoryPath = join(fixtureRoot, "topology");
  for (const blockedCommand of ["rev-list", "cat-file"]) {
    await rm(pidFile, { force: true });
    const gateFile = resolve(process.env.COMMITSCOPE_HISTORY_BLOCK_GATE_FILE);
    await rm(gateFile, { force: true });
    const client = await startClient(`cancel-${blockedCommand}`, {
      PATH: `${slowDirectory}:${process.env.PATH}`,
      COMMITSCOPE_HISTORY_BLOCK_REPOSITORY: repositoryPath,
      COMMITSCOPE_HISTORY_BLOCK_COMMAND: blockedCommand,
      COMMITSCOPE_HISTORY_BLOCK_GATE_FILE: gateFile,
      COMMITSCOPE_HISTORY_PID_FILE: pidFile,
    });
    try {
      const session = await openSession(client, repositoryPath);
      let retryCursor = null;
      if (blockedCommand === "cat-file") {
        retryCursor = projectPage(await client.readPage(session, null, 2)).nextCursor;
        assert.ok(retryCursor);
      }
      await writeFile(gateFile, "block\n");
      const query = client.beginReadPage(session, retryCursor, 2);
      const pid = await waitForFileNumber(pidFile);
      client.cancel(query.requestId);
      await assert.rejects(query.result, error => error.code === "CANCELLED");
      await waitForProcessExit(pid);
      await rm(gateFile, { force: true });
      const expected = await gitRevList(repositoryPath, session.repository.headOid);
      const retry = projectPage(await client.readPage(session, retryCursor, 2));
      assert.deepEqual(retry.commits.map(commit => commit.oid), expected.slice(retry.offset, retry.offset + 2), "retry reconstructs the same cursor after cancellation");
    } finally {
      await client.stop();
    }
  }
});

test("a completed page can be replayed after eight-page cache eviction without skip-based queries", { skip: process.platform === "win32" }, async () => {
  const logPath = resolve(process.env.COMMITSCOPE_HISTORY_GIT_LOG);
  await rm(logPath, { force: true });
  const wrapper = await startClient("cache-eviction", {
    PATH: `${resolve(process.env.COMMITSCOPE_HISTORY_COUNT_GIT_DIRECTORY)}:${process.env.PATH}`,
    COMMITSCOPE_HISTORY_LOG_FILE: logPath,
  });
  try {
    const repositoryPath = resolve(process.env.COMMITSCOPE_HISTORY_CACHE_REPOSITORY);
    const session = await openSession(wrapper, repositoryPath);
    const expected = await gitRevList(repositoryPath, session.repository.headOid);
    const pages = [];
    let cursor = null;
    while (cursor !== null || pages.length === 0) {
      const current = projectPage(await wrapper.readPage(session, cursor, 1));
      pages.push(current);
      cursor = current.nextCursor;
      if (cursor === null) break;
    }
    const countBefore = await readLogCount(logPath, "rev-list");
    const replay = projectPage(await wrapper.readPage(session, pages[0].cursor, 1));
    const deepReplay = projectPage(await wrapper.readPage(session, pages[10].cursor, 1));
    const countAfter = await readLogCount(logPath, "rev-list");
    assert.deepEqual(replay.commits.map(commit => commit.oid), expected.slice(0, 1));
    assert.deepEqual(deepReplay.commits.map(commit => commit.oid), expected.slice(10, 11), "a prior deep cursor remains valid after replaying an older page");
    assert.ok(countAfter > countBefore, "an evicted page is reconstructed from the frozen tip");
    const log = await readFile(logPath, "utf8");
    assert.equal(log.split("\n").filter(line => line.startsWith("rev-list ") && line.includes("--skip=")).length, 0, "continuations and replay must not use --skip=N");
  } finally {
    await wrapper.stop();
  }
});

test("closing or ending the daemon reaps idle history streams", { skip: process.platform === "win32" }, async () => {
  for (const closeSession of [true, false]) {
    const pidFile = resolve(process.env.COMMITSCOPE_HISTORY_PID_FILE);
    await rm(pidFile, { force: true });
    const client = await startClient(`idle-${closeSession}`, {
      PATH: `${resolve(process.env.COMMITSCOPE_HISTORY_SLOW_GIT_DIRECTORY)}:${process.env.PATH}`,
      COMMITSCOPE_HISTORY_IDLE_REPOSITORY: resolve(process.env.COMMITSCOPE_HISTORY_LONG_REPOSITORY),
      COMMITSCOPE_HISTORY_IDLE_PID_FILE: pidFile,
    });
    let stopped = false;
    try {
      const session = await openSession(client, resolve(process.env.COMMITSCOPE_HISTORY_LONG_REPOSITORY));
      const first = projectPage(await client.readPage(session, null, 1));
      const pid = await waitForFileNumber(pidFile);
      assert.equal(await isProcessAlive(pid), true, "the deliberately held rev-list child is alive before close/EOF");
      if (closeSession) await client.close(session);
      else { await client.stop(); stopped = true; }
      await waitForProcessExit(pid);
      if (closeSession) { await client.stop(); stopped = true; }
      assert.equal(first.offset, 0);
    } finally {
      if (!stopped) await client.stop().catch(() => {});
    }
  }
});

test("500 long summaries stream through bounded response chunks for both a page and refresh", async () => {
  const repositoryPath = resolve(process.env.COMMITSCOPE_HISTORY_LONG_REPOSITORY);
  const before = await snapshotTree(repositoryPath);
  const client = await startClient("chunk-pressure");
  try {
    const session = await openSession(client, repositoryPath);
    const firstResponse = await client.readPage(session, null, 500, 60_000);
    const first = projectPage(firstResponse);
    assert.equal(first.commits.length, 500);
    assert.equal(first.chunks.length > 1, true, "response is split across bounded frames");
    assert.equal(firstResponse.chunks.every(chunk => chunk.repoId === session.repoId && chunk.generation === session.generation), true);
    assert.equal(firstResponse.completion.coverage.processed, 500);
    assert.equal(firstResponse.completion.done, true);

    const refreshed = await client.refresh(session, 500, 60_000);
    const newSession = projectSession(refreshed);
    const refreshedPage = projectPage(refreshed);
    const refreshedSessionHeader = refreshed.chunks.find(chunk => chunk.data.section === "repositorySession");
    assert.notEqual(newSession.generation, session.generation);
    assert.equal(refreshed.chunks.every(chunk => chunk.repoId === session.repoId && chunk.generation === session.generation), true, "refresh response envelopes keep the old request context");
    assert.equal(refreshedSessionHeader.coverage.processed, 0, "refresh session header does not count as a commit");
    assert.equal(refreshedPage.commits.length, 500);
    assert.equal(refreshedPage.chunks.length > 1, true, "refresh page also drains all output frames");
    assert.equal(refreshed.chunks.at(-1).done, true);
    assert.equal(refreshed.chunks.at(-1).coverage.processed, 500);
    await client.close(newSession);
  } finally {
    await client.stop();
  }
  assert.deepEqual(await snapshotTree(repositoryPath), before, "long page and refresh do not mutate the test repository");
});

test("cancelling a multi-frame page after its first history chunk reaps streams and retries the full page", { skip: process.platform === "win32" }, async () => {
  const repositoryPath = resolve(process.env.COMMITSCOPE_HISTORY_LONG_REPOSITORY);
  const pidFile = resolve(process.env.COMMITSCOPE_HISTORY_PID_FILE);
  await rm(pidFile, { force: true });
  const client = await startClient("cancel-output-frames", {
    PATH: `${resolve(process.env.COMMITSCOPE_HISTORY_SLOW_GIT_DIRECTORY)}:${process.env.PATH}`,
    COMMITSCOPE_HISTORY_IDLE_PID_FILE: pidFile,
  });
  let resumeTimer;
  try {
    const session = await openSession(client, repositoryPath);
    let resolveFirstChunk;
    const firstChunkSeen = new Promise(resolveSeen => { resolveFirstChunk = resolveSeen; });
    const observedChunks = [];
    let paused = false;
    const query = client.beginReadPage(session, null, 500, 60_000, message => {
      if (message.type !== "response" || message.data.section !== "historyPage") return;
      observedChunks.push(message);
      if (!paused) {
        paused = true;
        resolveFirstChunk(message);
        return false;
      }
    });
    const firstChunk = await Promise.race([
      firstChunkSeen,
      delay(10_000).then(() => { throw new Error("No historyPage chunk arrived to cancel"); }),
    ]);
    assert.equal(firstChunk.done, false, "cancellation starts after a nonterminal historyPage chunk, not the repository header");
    const revListPid = await waitForFileNumber(pidFile);
    assert.equal(await isProcessAlive(revListPid), true, "the rev-list stream is still open while output is backpressured");
    client.cancel(query.requestId);
    resumeTimer = setTimeout(() => client.resumeOutput(), 150);
    await assert.rejects(query.result, error => error.code === "CANCELLED");
    clearTimeout(resumeTimer);
    resumeTimer = null;
    client.resumeOutput();
    await waitForProcessExit(revListPid);

    const expected = await gitRevList(repositoryPath, session.repository.headOid);
    const retry = projectPage(await client.readPage(session, null, 500, 60_000));
    assert.equal(retry.commits.length, 500);
    assert.equal(retry.chunks.length >= 20, true, "the retry drains all bounded output frames");
    assert.deepEqual(retry.commits.map(commit => commit.oid), expected.slice(0, 500), "no partially emitted commit is lost or duplicated");
  } finally {
    if (resumeTimer) clearTimeout(resumeTimer);
    client.resumeOutput();
    await client.stop();
  }
});

test("missing commit objects fail explicitly, and shallow boundary mutation never mixes pages", async () => {
  const client = await startClient("missing-and-boundary");
  try {
    const fetchSentinel = resolve(process.env.COMMITSCOPE_HISTORY_FETCH_SENTINEL);
    await rm(fetchSentinel, { force: true });
    await assert.rejects(async () => {
      const missing = await openSession(client, join(fixtureRoot, "missing-promisor"));
      await client.readPage(missing, null, 2);
    }, error => error.code === "MISSING_OBJECT");
    await assert.rejects(access(fetchSentinel), error => error.code === "ENOENT", "a missing promisor object must not invoke a remote helper");

    const shallowPath = join(fixtureRoot, "shallow");
    const shallow = await openSession(client, shallowPath);
    const initial = projectPage(await client.readPage(shallow, null, 1));
    const gitDir = shallow.repository.gitDir;
    const boundaryPath = join(gitDir, "shallow");
    const original = await readFile(boundaryPath);
    try {
      await appendFile(boundaryPath, "0000000000000000000000000000000000000000\n");
      await assert.rejects(client.readPage(shallow, initial.nextCursor, 1), error => error.code === "SNAPSHOT_CHANGED");
    } finally {
      await writeFile(boundaryPath, original);
    }

    const topologyPath = join(fixtureRoot, "topology");
    const topology = await openSession(client, topologyPath);
    const topologyPage = projectPage(await client.readPage(topology, null, 1));
    const parents = (await execFileAsync(gitPath, ["-C", topologyPath, "show", "-s", "--format=%P", topology.repository.headOid], { env: cleanEnvironment(), timeout: 5000 })).stdout.trim().split(" ").filter(Boolean);
    assert.ok(parents.length > 0);
    const graftsPath = join(topology.repository.gitDir, "info", "grafts");
    let originalGrafts = null;
    try { originalGrafts = await readFile(graftsPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    try {
      await mkdir(dirname(graftsPath), { recursive: true });
      await writeFile(graftsPath, `${topology.repository.headOid} ${parents[0]}\n`);
      await assert.rejects(client.readPage(topology, topologyPage.nextCursor, 1), error => error.code === "SNAPSHOT_CHANGED");
    } finally {
      if (originalGrafts) await writeFile(graftsPath, originalGrafts);
      else await rm(graftsPath, { force: true });
    }
  } finally {
    await client.stop();
  }
});

test("captured tip deletion and an unterminated rev-list OID line fail instead of completing", { skip: process.platform === "win32" }, async () => {
  const repositoryPath = resolve(process.env.COMMITSCOPE_HISTORY_MISSING_TIP_REPOSITORY);
  const client = await startClient("missing-captured-tip");
  let objectPath;
  let objectBytes;
  try {
    const session = await openSession(client, repositoryPath);
    const oid = session.repository.headOid;
    const objects = (await execFileAsync(gitPath, ["-C", repositoryPath, "rev-parse", "--git-path", "objects"], { env: cleanEnvironment(), timeout: 5000 })).stdout.trim();
    objectPath = join(repositoryPath, objects, oid.slice(0, 2), oid.slice(2));
    objectBytes = await readFile(objectPath);
    await rm(objectPath);
    await assert.rejects(client.readPage(session, null, 2), error => error.code === "MISSING_OBJECT");
  } finally {
    if (objectPath && objectBytes) {
      await mkdir(dirname(objectPath), { recursive: true });
      await writeFile(objectPath, objectBytes);
    }
    await client.stop();
  }

  const truncated = await startClient("truncated-rev-list", {
    PATH: `${resolve(process.env.COMMITSCOPE_HISTORY_COUNT_GIT_DIRECTORY)}:${process.env.PATH}`,
    COMMITSCOPE_HISTORY_TRUNCATE_REPOSITORY: repositoryPath,
  });
  try {
    const session = await openSession(truncated, repositoryPath);
    await assert.rejects(truncated.readPage(session, null, 2), error => error.code !== "CANCELLED");
  } finally {
    await truncated.stop();
  }
});

async function startClient(label, extra = {}) {
  const dataDir = join(resolve(process.env.COMMITSCOPE_HISTORY_DATA_ROOT), label);
  await mkdir(dataDir, { recursive: true });
  const env = createDaemonEnvironment(dataDir, {
    PATH: `${resolve(process.env.COMMITSCOPE_HISTORY_GIT_DIRECTORY)}:${process.env.PATH}`,
    COMMITSCOPE_HISTORY_FETCH_SENTINEL: process.env.COMMITSCOPE_HISTORY_FETCH_SENTINEL,
    ...extra,
  });
  const client = new HistoryDaemonClient(daemonPath, { cwd: process.cwd(), env });
  await client.start();
  return client;
}

async function openSession(client, path) {
  const response = await client.open(path);
  const session = projectSession(response);
  assert.ok(session, "openRepository returns a repositorySession chunk");
  return session;
}

async function walk(client, session, pageSize) {
  const pages = [];
  let cursor = null;
  do {
    const page = projectPage(await client.readPage(session, cursor, pageSize));
    assert.equal(page.offset, pages.reduce((count, previous) => count + previous.commits.length, 0));
    assert.equal(page.pageSize, pageSize);
    assert.equal(page.cursor.length > 0, true);
    assert.equal(page.commits.length <= pageSize, true);
    assert.equal(page.nextCursor !== null, page.hasMore);
    assert.equal(page.coverage.processed, page.commits.length);
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return pages;
}

async function gitRevList(repository, tip) {
  if (!tip) return [];
  const { stdout } = await execFileAsync(gitPath, ["--no-lazy-fetch", "--no-pager", "--no-replace-objects", "--no-optional-locks", "-c", "core.commitGraph=false", "-C", repository, "rev-list", "--topo-order", tip, "--"], {
    env: cleanEnvironment(), timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim().split("\n").filter(Boolean);
}

async function gitRevListNot(repository, currentTip, previousTip) {
  const { stdout } = await execFileAsync(gitPath, ["--no-lazy-fetch", "--no-pager", "--no-replace-objects", "--no-optional-locks", "-c", "core.commitGraph=false", "-C", repository, "rev-list", "--topo-order", currentTip, "--not", previousTip, "--"], {
    env: cleanEnvironment(), timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim().split("\n").filter(Boolean);
}

async function gitOutput(args) {
  const { stdout } = await execFileAsync(gitPath, args, { env: cleanEnvironment(), timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function gitRun(args) {
  await execFileAsync(gitPath, args, { env: cleanEnvironment(), timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
}

async function createTreeCommit(repository, tree, parents, message, timestamp) {
  const args = ["-C", repository, "-c", "user.name=Marker Oracle", "-c", "user.email=marker@example.invalid", "commit-tree", tree];
  for (const parent of parents) args.push("-p", parent);
  args.push("-m", message);
  const env = cleanEnvironment({
    GIT_AUTHOR_NAME: "Marker Oracle", GIT_AUTHOR_EMAIL: "marker@example.invalid",
    GIT_COMMITTER_NAME: "Marker Oracle", GIT_COMMITTER_EMAIL: "marker@example.invalid",
    GIT_AUTHOR_DATE: `@${timestamp} +0000`, GIT_COMMITTER_DATE: `@${timestamp} +0000`,
  });
  const { stdout } = await execFileAsync(gitPath, args, { env, timeout: 10_000 });
  return stdout.trim();
}

async function commitCount(repository) {
  const { stdout } = await execFileAsync(gitPath, ["-C", repository, "rev-list", "--count", "HEAD"], { env: cleanEnvironment(), timeout: 10_000 });
  return Number(stdout.trim());
}

async function createEmptyCommit(repository, message) {
  const env = cleanEnvironment({ GIT_AUTHOR_DATE: "2026-11-07T00:00:00+0000", GIT_COMMITTER_DATE: "2026-11-07T00:00:00+0000" });
  await execFileAsync(gitPath, ["-C", repository, "-c", "user.name=P1-02 test", "-c", "user.email=p1-02@example.invalid", "commit", "--allow-empty", "-m", message], { env, timeout: 10_000 });
  const { stdout } = await execFileAsync(gitPath, ["-C", repository, "rev-parse", "HEAD"], { env: cleanEnvironment(), timeout: 5000 });
  return stdout.trim();
}

async function waitForFileNumber(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(value) && value > 0) return value;
    } catch {}
    await delay(20);
  }
  throw new Error(`Timed out waiting for process marker ${path}`);
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await delay(25);
  }
  throw new Error(`Process ${pid} did not exit`);
}

async function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function readLogCount(path, command) {
  try { return (await readFile(path, "utf8")).split("\n").filter(line => line.startsWith(`${command} `)).length; }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
}

function cleanEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, ...extra };
}
