import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { NavigationDaemonClient, createDaemonEnvironment, projectMergeStatus, projectNavigation, projectPage, projectRefreshed, projectSession } from "./daemon-client.mjs";
import { git } from "./fixture.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const fixture = {
  repository: resolve(process.env.COMMITSCOPE_NAVIGATION_REPOSITORY),
  remote: resolve(process.env.COMMITSCOPE_NAVIGATION_REMOTE),
  linkedPath: resolve(process.env.COMMITSCOPE_NAVIGATION_LINKED),
  detachedPath: resolve(process.env.COMMITSCOPE_NAVIGATION_DETACHED),
  sha256Repository: process.env.COMMITSCOPE_NAVIGATION_SHA256 ? resolve(process.env.COMMITSCOPE_NAVIGATION_SHA256) : null,
  dataRoot: resolve(process.env.COMMITSCOPE_NAVIGATION_DATA_ROOT),
  daemonPath: resolve(process.env.COMMITSCOPE_DAEMON_PATH),
};
const oid = JSON.parse(await readFile(resolve(process.env.COMMITSCOPE_NAVIGATION_OIDS), "utf8"));

test("HEAD, ref, worktree, and allBranches scopes paginate exactly the independently reachable Git set", async () => {
  const before = await snapshotRepositories();
  const client = await startClient("multi-scope");
  try {
    const opened = projectSession(await client.open(fixture.repository));
    assert.equal(opened.scope, "head");
    assert.deepEqual(opened.tips, [oid.mainTip]);
    const headPages = await walk(client, opened, 2);
    assert.deepEqual(commitIds(headPages), await revList([oid.mainTip]));

    const allResponse = await client.selectScope(opened, "allBranches", 2);
    const all = projectRefreshed(allResponse);
    const branchTipRows = (await git(fixture.repository, ["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes/origin"])).split("\n").filter(Boolean);
    const independentlyUniqueTips = [...new Set(branchTipRows)];
    assert.deepEqual(new Set(all.session.tips), new Set(independentlyUniqueTips));
    assert.ok(all.session.tips.length >= 2, "fixture has multiple distinct branch tips");
    assert.ok(all.session.tips.includes(oid.diverged));
    assert.ok(all.session.tips.includes(oid.linkedTip));
    const allPages = await walk(client, all.session, 2);
    const allCommitIds = commitIds(allPages);
    const expectedAll = await revList(all.session.tips);
    assert.deepEqual(allCommitIds, expectedAll, "paged multi-root history follows stock Git topo order");
    assert.equal(new Set(allCommitIds).size, allCommitIds.length, "shared ancestry is emitted once");
    assert.ok(!allCommitIds.includes(oid.tagOnly), "tag-only history is outside allBranches");
    const reflogReachable = (await git(fixture.repository, ["rev-list", "--reflog", "--all"])).split("\n");
    assert.ok(reflogReachable.includes(oid.reflogOnly), "fixture commit is reachable through a reflog for the independent exclusion check");
    assert.ok(!allCommitIds.includes(oid.reflogOnly), "reflog-only history is outside allBranches");
    assert.ok(!allCommitIds.includes(oid.stashTip), "stash-only history is outside allBranches");
    const stashOnlyHistory = (await git(fixture.repository, ["rev-list", "refs/stash", "--not", "--branches", "--remotes"])).split("\n").filter(Boolean);
    assert.ok(stashOnlyHistory.includes(oid.stashTip), "fixture has stash-exclusive history for the independent exclusion check");
    assert.ok(stashOnlyHistory.every(commit => !allCommitIds.includes(commit)), "no commit reachable only through refs/stash leaks into allBranches");
    assert.ok(allCommitIds.includes(oid.remoteOnly), "remote-tracking roots are included");

    const annotated = projectRefreshed(await client.selectScope(all.session, { ref: "refs/tags/release/annotated" }, 3));
    assert.deepEqual(annotated.session.tips, [oid.mainTip], "annotated tags recursively peel to their commit");
    assert.deepEqual(commitIds(await walk(client, annotated.session, 3)), await revList([oid.mainTip]));

    const lightweight = projectRefreshed(await client.selectScope(annotated.session, { ref: "refs/tags/tag-only-history" }, 3));
    assert.deepEqual(lightweight.session.tips, [oid.tagOnly]);
    assert.deepEqual(commitIds(await walk(client, lightweight.session, 3)), [oid.tagOnly]);
    const remoteScope = projectRefreshed(await client.selectScope(lightweight.session, { ref: "refs/remotes/origin/remote-only" }, 3));
    assert.deepEqual(remoteScope.session.tips, [oid.remoteOnly]);
    assert.deepEqual(commitIds(await walk(client, remoteScope.session, 3)), await revList([oid.remoteOnly]));

    const navigation = projectNavigation(await client.getNavigation(remoteScope.session));
    const linked = navigation.worktrees.find(worktree => worktree.path === fixture.linkedPath);
    assert.ok(linked, "NUL-delimited worktree parsing retains a path containing spaces and a newline");
    assert.equal(linked.headOid, oid.linkedTip);
    const windowIdentity = { path: remoteScope.session.repository.path, key: remoteScope.session.repositoryKey, worktreeId: remoteScope.session.worktreeId };
    const otherWorktree = projectRefreshed(await client.selectScope(remoteScope.session, { worktree: linked.id }, 2));
    assert.deepEqual(otherWorktree.session.tips, [oid.linkedTip]);
    assert.deepEqual({
      path: otherWorktree.session.repository.path,
      key: otherWorktree.session.repositoryKey,
      worktreeId: otherWorktree.session.worktreeId,
    }, windowIdentity, "browsing a linked worktree does not replace this window's repository identity");
    assert.deepEqual(commitIds(await walk(client, otherWorktree.session, 2)), await revList([oid.linkedTip]));

    const detached = projectSession(await client.open(fixture.detachedPath));
    assert.equal(detached.scope, "head");
    assert.equal(detached.repository.headReference, null);
    assert.equal(detached.repository.headOid, oid.diverged);
    assert.deepEqual(detached.tips, [oid.diverged]);
    const detachedNavigation = projectNavigation(await client.getNavigation(detached));
    assert.equal(detachedNavigation.worktrees.find(item => item.isCurrent).isDetached, true);
  } finally {
    await client.stop();
  }
  assert.deepEqual(await snapshotRepositories(), before, "navigation and history reads preserve repository/index/worktree files by SHA-256");
});

test("navigation chooses default base in order and proves merge ancestry in the required argument direction", async () => {
  const client = await startClient("merge-base-order");
  try {
    const session = projectSession(await client.open(fixture.repository));
    const navigation = projectNavigation(await client.getNavigation(session));
    assert.deepEqual(navigation.defaultBase, { name: "refs/remotes/origin/main", oid: oid.mainTip });
    assert.equal(await ancestor("refs/heads/feature/merged", "refs/remotes/origin/main"), true);
    assert.equal(await ancestor("refs/remotes/origin/main", "refs/heads/feature/merged"), false,
      "fixture catches an accidental reversal of merge-base --is-ancestor arguments");
    assert.equal(await ancestor("refs/heads/feature/diverged", "refs/remotes/origin/main"), false);
    const result = projectMergeStatus(await client.mergeStatus(session, ["refs/heads/feature/merged", "refs/heads/feature/diverged"]));
    assert.deepEqual(result.defaultBase, navigation.defaultBase);
    assert.deepEqual(result.statuses, [
      { name: "refs/heads/feature/merged", oid: oid.merged, status: "merged" },
      { name: "refs/heads/feature/diverged", oid: oid.diverged, status: "notMerged" },
    ]);
  } finally {
    await client.stop();
  }
});

test("default base follows origin/HEAD, origin/main, origin/master, local main, local master, then no base", async () => {
  const client = await startClient("default-base-priority");
  const saved = {
    originMain: await git(fixture.repository, ["rev-parse", "refs/remotes/origin/main"]),
    originMaster: null,
    localMain: await git(fixture.repository, ["rev-parse", "refs/heads/main"]),
    localMaster: null,
  };
  try {
    await git(fixture.repository, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature/merged"]);
    let session = projectSession(await client.open(fixture.repository));
    assert.deepEqual(projectNavigation(await client.getNavigation(session)).defaultBase,
      { name: "refs/remotes/origin/feature/merged", oid: oid.merged }, "valid origin/HEAD target wins over origin/main");

    await git(fixture.repository, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    session = projectSession(await client.open(fixture.repository));
    assert.deepEqual(projectNavigation(await client.getNavigation(session)).defaultBase,
      { name: "refs/remotes/origin/main", oid: saved.originMain });

    await git(fixture.repository, ["update-ref", "refs/remotes/origin/master", oid.remoteOnly]);
    await git(fixture.repository, ["update-ref", "-d", "refs/remotes/origin/main"]);
    session = projectSession(await client.open(fixture.repository));
    assert.deepEqual(projectNavigation(await client.getNavigation(session)).defaultBase,
      { name: "refs/remotes/origin/master", oid: oid.remoteOnly });

    await git(fixture.repository, ["update-ref", "-d", "refs/remotes/origin/master"]);
    session = projectSession(await client.open(fixture.repository));
    assert.deepEqual(projectNavigation(await client.getNavigation(session)).defaultBase,
      { name: "refs/heads/main", oid: saved.localMain });

    await git(fixture.repository, ["update-ref", "refs/heads/master", oid.base]);
    saved.localMaster = oid.base;
    await git(fixture.repository, ["update-ref", "-d", "refs/heads/main"]);
    session = projectSession(await client.open(fixture.repository));
    assert.deepEqual(projectNavigation(await client.getNavigation(session)).defaultBase,
      { name: "refs/heads/master", oid: oid.base });

    await git(fixture.repository, ["update-ref", "-d", "refs/heads/master"]);
    session = projectSession(await client.open(fixture.repository));
    assert.equal(projectNavigation(await client.getNavigation(session)).defaultBase, null);
  } finally {
    await git(fixture.repository, ["update-ref", "refs/remotes/origin/main", saved.originMain]);
    if (saved.originMaster) await git(fixture.repository, ["update-ref", "refs/remotes/origin/master", saved.originMaster]);
    else await git(fixture.repository, ["update-ref", "-d", "refs/remotes/origin/master"]).catch(() => undefined);
    await git(fixture.repository, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await git(fixture.repository, ["update-ref", "refs/heads/main", saved.localMain]);
    if (saved.localMaster) await git(fixture.repository, ["update-ref", "-d", "refs/heads/master"]);
    await client.stop();
  }
});

test("last-viewed tips stay isolated by complete scope and include every allBranches root", async () => {
  const client = await startClient("last-viewed-by-scope");
  try {
    const head = projectSession(await client.open(fixture.repository));
    const all = projectRefreshed(await client.selectScope(head, "allBranches", 5)).session;
    const tipsRecorded = [...all.tips];
    assert.ok(tipsRecorded.length >= 2);
    assert.equal(await ancestor("refs/heads/feature/diverged", "refs/heads/linked/topic"), false);
    assert.equal(await ancestor("refs/heads/linked/topic", "refs/heads/feature/diverged"), false,
      "the persisted allBranches snapshot includes at least two independent roots");
    assert.equal((await client.recordView(all)).data.saved, true);
    const headAgain = projectRefreshed(await client.selectScope(all, "head", 5)).session;
    assert.equal(headAgain.previousView, null, "allBranches history is not presented as the HEAD scope's prior view");
    assert.equal((await client.recordView(headAgain)).data.saved, true);
    const allAgain = projectRefreshed(await client.selectScope(headAgain, "allBranches", 5)).session;
    assert.deepEqual(new Set(allAgain.previousView.tips), new Set(tipsRecorded));
    assert.equal(allAgain.previousView.tips.length, tipsRecorded.length, "persisted multi-tip scopes are not silently truncated");
    const headThird = projectRefreshed(await client.selectScope(allAgain, "head", 5)).session;
    assert.deepEqual(headThird.previousView.tips, [oid.mainTip]);
  } finally {
    await client.stop();
  }
});

test("unavailable, deleted, and non-commit scopes fail without replacing the previous frozen scope", async () => {
  const client = await startClient("scope-failures");
  try {
    let session = projectSession(await client.open(fixture.repository));
    session = projectRefreshed(await client.selectScope(session, { ref: "refs/heads/feature/merged" }, 3)).session;
    const original = { generation: session.generation, scope: session.scope, tips: session.tips };
    await assert.rejects(client.selectScope(session, { ref: "refs/heads/missing" }, 3), error => error.code === "SCOPE_UNAVAILABLE");
    await assert.rejects(client.selectScope(session, { ref: "refs/tags/non-commit-tag" }, 3), error =>
      error.code === "SCOPE_UNAVAILABLE" && /commit|标签/iu.test(error.message));
    const afterFailures = projectSession(await client.getSession(session));
    assert.deepEqual({ generation: afterFailures.generation, scope: afterFailures.scope, tips: afterFailures.tips }, original);

    await git(fixture.repository, ["update-ref", "-d", "refs/heads/feature/merged"]);
    await assert.rejects(client.refresh(session, 3), error => error.code === "SCOPE_UNAVAILABLE");
    const afterRefreshFailure = projectSession(await client.getSession(session));
    assert.deepEqual({ generation: afterRefreshFailure.generation, scope: afterRefreshFailure.scope, tips: afterRefreshFailure.tips }, original,
      "refreshing a removed ref retains the old readable snapshot and does not fall back to HEAD");
    const retainedPage = projectPage(await client.readPage(afterRefreshFailure, null, 3));
    assert.equal(retainedPage.commits[0].oid, oid.merged, "the previous scope remains readable after refresh failure");
  } finally {
    await git(fixture.repository, ["update-ref", "refs/heads/feature/merged", oid.merged]);
    await client.stop();
  }
});

test("SHA-256 OIDs, if supported by Git, are preserved as complete scope tips", { skip: !fixture.sha256Repository }, async () => {
  const client = await startClient("sha256");
  try {
    const session = projectSession(await client.open(fixture.sha256Repository));
    assert.equal(session.repository.objectFormat, "sha256");
    assert.equal(session.repository.headOid.length, 64);
    assert.deepEqual(session.tips, [oid.sha256Tip]);
    assert.deepEqual(commitIds(await walk(client, session, 1)), await revList([oid.sha256Tip], fixture.sha256Repository));
    const scoped = projectRefreshed(await client.selectScope(session, { ref: "refs/heads/main" }, 1));
    assert.equal(scoped.session.scope.ref, "refs/heads/main");
    assert.deepEqual(scoped.session.tips, [oid.sha256Tip]);
    assert.deepEqual(commitIds(await walk(client, scoped.session, 1)), [oid.sha256Tip]);
  } finally {
    await client.stop();
  }
});

test("an unborn HEAD can still browse existing branches, while truly empty scopes return no commits", async () => {
  const emptyRoot = await mkdtemp(join(tmpdir(), "commitscope-navigation-empty-"));
  const repository = join(emptyRoot, "unborn-head-with-refs");
  const trulyEmpty = join(emptyRoot, "truly-empty");
  const client = await startClient("empty-scopes");
  const savedLinkedHead = await git(fixture.linkedPath, ["symbolic-ref", "HEAD"]);
  try {
    await git(emptyRoot, ["init", "--quiet", "--initial-branch=main", repository]);
    await git(repository, ["config", "user.name", "Navigation Test"]);
    await git(repository, ["config", "user.email", "navigation@example.invalid"]);
    await writeFile(join(repository, "main.txt"), "reachable despite an unborn worktree HEAD\n");
    await git(repository, ["add", "main.txt"]);
    await git(repository, ["commit", "--quiet", "-m", "branch remains reachable"]);
    const branchTip = await git(repository, ["rev-parse", "refs/heads/main"]);
    await git(repository, ["symbolic-ref", "HEAD", "refs/heads/unborn"]);
    const head = projectSession(await client.open(repository));
    assert.equal(head.repository.headOid, null);
    assert.deepEqual(head.tips, []);
    assert.deepEqual(commitIds(await walk(client, head, 5)), []);
    const all = projectRefreshed(await client.selectScope(head, "allBranches", 5));
    assert.deepEqual(all.session.tips, [branchTip], "allBranches does not inherit the empty current HEAD and still reads another branch");
    assert.deepEqual(commitIds(await walk(client, all.session, 5)), await revList([branchTip], repository));

    await git(emptyRoot, ["init", "--quiet", "--initial-branch=main", trulyEmpty]);
    const noRefs = projectSession(await client.open(trulyEmpty));
    const noRefsAll = projectRefreshed(await client.selectScope(noRefs, "allBranches", 5));
    assert.deepEqual(noRefsAll.session.tips, []);
    assert.deepEqual(commitIds(await walk(client, noRefsAll.session, 5)), []);
    assert.equal(projectNavigation(await client.getNavigation(noRefsAll.session)).defaultBase, null);

    // An empty linked worktree HEAD is a valid scope while this window stays on a committed main worktree.
    await git(fixture.linkedPath, ["symbolic-ref", "HEAD", "refs/heads/unborn-linked"]);
    const mainWindow = projectSession(await client.open(fixture.repository));
    assert.equal(mainWindow.repository.headOid, oid.mainTip);
    const listed = projectNavigation(await client.getNavigation(mainWindow));
    const emptyWorktree = listed.worktrees.find(item => item.path === fixture.linkedPath);
    assert.ok(emptyWorktree);
    assert.equal(emptyWorktree.headOid, null);
    const selectedEmpty = projectRefreshed(await client.selectScope(mainWindow, { worktree: emptyWorktree.id }, 5));
    assert.deepEqual(selectedEmpty.session.tips, []);
    assert.deepEqual(commitIds(await walk(client, selectedEmpty.session, 5)), []);
  } finally {
    await git(fixture.linkedPath, ["symbolic-ref", "HEAD", savedLinkedHead]).catch(() => undefined);
    await client.stop();
    await rm(emptyRoot, { recursive: true, force: true });
  }
});

test("a prunable linked worktree remains listed but cannot be selected as a live scope", async () => {
  const client = await startClient("prunable-worktree");
  try {
    const session = projectSession(await client.open(fixture.repository));
    const navigation = projectNavigation(await client.getNavigation(session));
    const linked = navigation.worktrees.find(item => item.path === fixture.linkedPath);
    assert.ok(linked);
    await rm(fixture.linkedPath, { recursive: true, force: true });
    const refreshed = projectSession(await client.refresh(session, 5));
    const updated = projectNavigation(await client.getNavigation(refreshed));
    const prunable = updated.worktrees.find(item => item.id === linked.id);
    assert.ok(prunable?.prunableReason);
    assert.equal(prunable.available, false);
    await assert.rejects(client.selectScope(refreshed, { worktree: linked.id }, 5), error => error.code === "SCOPE_UNAVAILABLE");
    const stillCurrent = projectSession(await client.getSession(refreshed));
    assert.equal(stillCurrent.scope, "head");
    assert.deepEqual(stillCurrent.tips, [oid.mainTip]);
  } finally {
    await client.stop();
  }
});

test("a cancelled scope preparation cannot publish a late generation over the current scope", async () => {
  const gateFile = resolve(process.env.COMMITSCOPE_NAVIGATION_BLOCK_GATE_FILE);
  const pidFile = resolve(process.env.COMMITSCOPE_NAVIGATION_BLOCK_PID_FILE);
  const client = await startClient("cancel-scope-race", {
    PATH: `${resolve(process.env.COMMITSCOPE_NAVIGATION_SLOW_GIT_DIR)}:${process.env.PATH ?? ""}`,
    COMMITSCOPE_NAVIGATION_SLOW_REPOSITORY: fixture.repository,
    COMMITSCOPE_NAVIGATION_BLOCK_GATE_FILE: resolve(process.env.COMMITSCOPE_NAVIGATION_BLOCK_GATE_FILE),
    COMMITSCOPE_NAVIGATION_BLOCK_PID_FILE: resolve(process.env.COMMITSCOPE_NAVIGATION_BLOCK_PID_FILE),
  });
  try {
    const session = projectSession(await client.open(fixture.repository));
    await rm(pidFile, { force: true });
    await writeFile(gateFile, "block\n");
    const request = client.beginSelectScope(session, "allBranches", 10);
    await waitForFile(pidFile, 5000);
    client.cancel(request.requestId);
    await assert.rejects(request.result, error => ["CANCELLED", "REQUEST_CANCELLED", "STALE_CONTEXT"].includes(error.code));
    await rm(gateFile, { force: true });
    await delay(100);
    const stillHead = projectSession(await client.getSession(session));
    assert.equal(stillHead.generation, session.generation);
    assert.equal(stillHead.scope, "head");
    assert.deepEqual(stillHead.tips, [oid.mainTip]);
  } finally {
    await rm(gateFile, { force: true });
    await client.stop();
  }
});

async function startClient(label, extraEnv = {}) {
  const dataDir = join(fixture.dataRoot, label);
  const client = new NavigationDaemonClient(fixture.daemonPath, { cwd: process.cwd(), env: createDaemonEnvironment(dataDir, extraEnv) });
  const ready = await client.start();
  assert.ok(ready.capabilities.includes("repositoryScopes"));
  return client;
}

async function walk(client, session, pageSize) {
  const pages = [];
  let cursor = null;
  while (true) {
    const page = projectPage(await client.readPage(session, cursor, pageSize));
    pages.push(page);
    if (!page.hasMore) break;
    cursor = page.nextCursor;
    assert.ok(cursor, "a non-terminal page supplies the next cursor");
  }
  return pages;
}

function commitIds(pages) { return pages.flatMap(page => page.commits.map(commit => commit.oid)); }

async function revList(tips, repository = fixture.repository) {
  if (tips.length === 0) return [];
  return (await git(repository, ["--no-lazy-fetch", "--no-replace-objects", "--no-optional-locks", "rev-list", "--topo-order", ...tips])).split("\n").filter(Boolean);
}

async function ancestor(candidate, base) {
  try { await git(fixture.repository, ["merge-base", "--is-ancestor", candidate, base]); return true; }
  catch (error) { if (error.code === 1) return false; throw error; }
}

async function snapshotRepositories() {
  return {
    main: await snapshotTree(fixture.repository),
    remote: await snapshotTree(fixture.remote),
    linked: await snapshotTree(fixture.linkedPath),
    detached: await snapshotTree(fixture.detachedPath),
  };
}

async function waitForFile(path, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if ((await stat(path)).isFile()) return; } catch {}
    await delay(20);
  }
  throw new Error(`Timed out waiting for slow Git marker ${path}`);
}
