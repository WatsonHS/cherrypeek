import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CommitDetailsDaemonClient, createDaemonEnvironment, projectChangedFiles, projectCommitDetails, projectMergeCommits, projectBranchesContaining, projectRefreshed, projectSession } from "./daemon-client.mjs";
import { git } from "./fixture.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const fixture = JSON.parse(await readFile(resolve(process.env.COMMITSCOPE_DETAILS_FIXTURE), "utf8"));
const daemonPath = resolve(process.env.COMMITSCOPE_DAEMON_PATH);
const dataRoot = resolve(process.env.COMMITSCOPE_DETAILS_DATA_ROOT);
const gitWrapper = process.env.COMMITSCOPE_DETAILS_GIT_WRAPPER ? resolve(process.env.COMMITSCOPE_DETAILS_GIT_WRAPPER) : null;
const gatePath = process.env.COMMITSCOPE_DETAILS_GATE_FILE ? resolve(process.env.COMMITSCOPE_DETAILS_GATE_FILE) : null;
const startedPath = process.env.COMMITSCOPE_DETAILS_GATE_STARTED ? resolve(process.env.COMMITSCOPE_DETAILS_GATE_STARTED) : null;

test("commit detail preserves raw message, trailer parse, identities, parents, captured refs and SHA formats", async () => {
  const before = await snapshotTree(fixture.repository);
  const client = await openAllBranches("details-full-message");
  try {
    const details = projectCommitDetails(await client.getCommit(client.session, fixture.merge.toUpperCase()));
    assert.equal(details.commit.oid, fixture.merge, "an uppercase full OID resolves and returns canonical lowercase");
    assert.deepEqual(details.commit.parents, [fixture.main, fixture.side]);
    assert.equal(details.commit.author.name, "Merge Author");
    assert.equal(details.commit.author.email, "merge@example.invalid");
    assert.equal(details.commit.committer.name, "Merge Committer");
    assert.notEqual(details.commit.author.timestamp, details.commit.committer.timestamp);
    assert.equal(details.message, fixture.trailerMessage, "the complete stored message is preserved byte-for-text");
    assert.equal(details.message.includes("Reviewed-by: Body Text <body@example.invalid>"), true);
    assert.equal(details.messageWithoutTrailers.includes("Reviewed-by: Body Text <body@example.invalid>"), true,
      "a trailer-looking line in a body paragraph stays in the body");
    assert.equal(details.messageWithoutTrailers.includes("Ada Reviewer"), false, "recognized final trailers are not duplicated in body text");
    const expectedTrailers = await git(fixture.repository, ["-c", "trailer.separators=:", "-c", "trailer.reviewed-by.command=", "-c", "trailer.reviewed-by.cmd=", "interpret-trailers", "--parse", "--no-divider"], { input: Buffer.from(fixture.trailerMessage) });
    assert.deepEqual(details.trailers, expectedTrailers.split("\n").filter(Boolean).map(parseTrailer),
      "trailer parsing follows Git, retaining repeated keys and unfolding continuations");
    assert.equal(details.refs.some(ref => ref.name === "refs/tags/detail-merge"), true, "the captured direct tag is included");
    assert.equal(details.refs.some(ref => ref.name === "refs/tags/detail-annotated" && ref.peeledOid === fixture.merge), true,
      "annotated tags preserve their peeled commit identity");
    assert.equal(details.update.state, "unaffected");
    assert.equal(details.observedAtUnixMs > 0, true);
    assert.equal(await exists(fixture.trailerSentinel), false, "poisoned trailer command configuration is never executed");
    assert.equal(await exists(fixture.externalSentinel), false, "external diff/textconv sentinels remain untouched");

    const root = projectCommitDetails(await client.getCommit(client.session, fixture.root));
    assert.deepEqual(root.commit.parents, [], "root commits retain an empty ordered parent list");
    assert.equal(root.message, "Root detail fixture\n\nRoot body with Unicode: 根提交\n");
    const currentHead = projectCommitDetails(await client.getCommit(client.session, fixture.head));
    assert.ok(currentHead.refs.some(ref => ref.name === "refs/heads/main" && ref.oid === fixture.head));
    assert.ok(currentHead.worktrees.some(worktree => worktree.isCurrent && worktree.headOid === fixture.head),
      "worktree location is tied to the captured current worktree HEAD");
  } finally {
    await client.stop();
  }
  assert.deepEqual(await snapshotTree(fixture.repository), before, "detail reads do not write the fixture repository");

  if (fixture.sha256) {
    const shaClient = await openClient("details-sha256", fixture.sha256.repository, "head");
    try {
      const session = projectSession(await shaClient.open(fixture.sha256.repository));
      const details = projectCommitDetails(await shaClient.getCommit(session, fixture.sha256.oid.toUpperCase()));
      assert.equal(details.commit.oid.length, 64);
      assert.equal(details.commit.oid, fixture.sha256.oid);
      assert.equal(details.message, "SHA-256 detail OID\n");
      const shaRootFiles = projectChangedFiles(await shaClient.listChangedFiles(session, fixture.sha256.oid, null));
      assert.equal(shaRootFiles.files.length, 1);
      assert.equal(shaRootFiles.files[0].oldOid, null);
      assert.equal(shaRootFiles.files[0].newOid.length, 64, "root file object IDs use the repository's SHA-256 format");
    } finally { await shaClient.stop(); }
  }
});

test("selected-parent file pages match Git path bytes, statuses, modes, numstat and overview", async () => {
  const before = await snapshotTree(fixture.repository);
  const client = await openAllBranches("details-file-pages");
  try {
    for (const parentIndex of [0, 1]) {
      const page = projectChangedFiles(await client.listChangedFiles(client.session, fixture.merge.toUpperCase(), parentIndex));
      assert.equal(page.oid, fixture.merge);
      assert.equal(page.parentIndex, parentIndex);
      const parentOid = [fixture.main, fixture.side][parentIndex];
      assert.equal(page.parentOid, parentOid);
      const expected = await gitNameStatus(fixture.repository, parentOid, fixture.merge);
      assert.deepEqual(fileSignatures(page.files), expected, `parent ${parentIndex} changed paths match Git's independent diff-tree result`);
      assert.equal(page.totalFiles, expected.length);
      assert.equal(page.overview.totalFiles, expected.length);
      assert.equal(Object.values(page.overview.counts).reduce((sum, value) => sum + value, 0), expected.length);
      assert.ok(page.overview.directories.some(directory => directory.path === null), "root-level paths are grouped under null");
      assert.ok(page.overview.directories.some(directory => directory.path?.display === "side-only" || directory.path?.display === "rename-new"));
      const numstat = await gitNumstat(fixture.repository, parentOid, fixture.merge);
      const parentTree = await git(fixture.repository, ["rev-parse", `${parentOid}^{tree}`]);
      const commitTree = await git(fixture.repository, ["rev-parse", `${fixture.merge}^{tree}`]);
      const oldEntries = await readTreeEntries(fixture.repository, parentTree);
      const newEntries = await readTreeEntries(fixture.repository, commitTree);
      for (const file of page.files) assertTreeEntrySides(file, oldEntries, newEntries);
      assertFileNumstat(page.files, numstat, `merge parent ${parentIndex}`);
      assertOverviewStats(page, numstat, `merge parent ${parentIndex}`);
      assertDirectoryOverview(page, numstat, `merge parent ${parentIndex}`);
    }

    const fromMain = projectChangedFiles(await client.listChangedFiles(client.session, fixture.merge, 0));
    assert.ok(fromMain.files.some(file => file.status === "added" && file.newPath?.display === "vendor/module" && file.gitlink && file.newMode === "160000"));
    const fromSide = projectChangedFiles(await client.listChangedFiles(client.session, fixture.merge, 1));
    assert.ok(fromSide.files.some(file => file.status === "renamed" && file.oldPath?.display === "rename-old.txt" && file.newPath?.display === "rename-new/renamed.txt"));
    assert.ok(fromSide.files.some(file => file.status === "deleted" && file.oldPath?.display === "delete-me.txt"));
    assert.ok(fromSide.files.some(file => file.status === "typeChanged" && file.oldPath?.display === "type-change" && file.oldMode === "100644" && file.newMode === "120000"));
    assert.ok(fromSide.files.some(file => file.status === "modified" && file.newPath?.display === "binary.dat" && file.binary && file.additions === null && file.deletions === null));
    const invalidPaths = fromSide.files.filter(file => [fixture.rawPathHex, fixture.rawPath2Hex].includes(file.newPath?.rawHex));
    assert.deepEqual(new Set(invalidPaths.map(file => file.newPath.rawHex)), new Set([fixture.rawPathHex, fixture.rawPath2Hex]));
    assert.equal(new Set(invalidPaths.map(file => file.newPath.display)).size, 1, "different invalid UTF-8 byte paths may share a lossy display but keep distinct rawHex");
    assert.ok(fromSide.files.some(file => file.newPath?.display === " spaced\tpath "));
    assert.ok(fromSide.files.some(file => file.newPath?.display === "--option-looking"));

    const rootPage = projectChangedFiles(await client.listChangedFiles(client.session, fixture.root, null));
    assert.equal(rootPage.parentOid, null);
    const rootOracle = await gitRootAddedPaths(fixture.repository, fixture.root);
    assert.deepEqual(fileSignatures(rootPage.files), rootOracle, "root changes match Git's --root against the empty tree");
  } finally { await client.stop(); }
  assert.deepEqual(await snapshotTree(fixture.repository), before, "file change queries remain read-only, including hostile config and attributes");
});

test("file pages over 200 items replace the requested window and validate page bounds", async () => {
  const before = await snapshotTree(fixture.repository);
  const client = await openAllBranches("details-wide-files");
  try {
    const first = projectChangedFiles(await client.listChangedFiles(client.session, fixture.wideFiles.toUpperCase(), 0, { offset: 0, pageSize: 200 }));
    assert.equal(first.oid, fixture.wideFiles);
    assert.equal(first.totalFiles, 205);
    assert.equal(first.files.length, 200);
    assert.equal(first.hasMore, true);
    const last = projectChangedFiles(await client.listChangedFiles(client.session, fixture.wideFiles, 0, { offset: 200, pageSize: 200 }));
    assert.equal(last.files.length, 5);
    assert.equal(last.offset, 200);
    assert.equal(last.hasMore, false);
    const replay = projectChangedFiles(await client.listChangedFiles(client.session, fixture.wideFiles, 0, { offset: 0, pageSize: 200 }));
    assert.deepEqual(fileSignatures(replay.files), fileSignatures(first.files), "back navigation returns the same first page");
    for (const request of [
      () => client.listChangedFiles(client.session, fixture.wideFiles, 0, { pageSize: 0 }),
      () => client.listChangedFiles(client.session, fixture.wideFiles, 0, { pageSize: 201 }),
      () => client.listChangedFiles(client.session, fixture.wideFiles, 1),
      () => client.listChangedFiles(client.session, fixture.wideFiles, null),
      () => client.listChangedFiles(client.session, fixture.wideFiles, 0, { offset: 206 }),
      () => client.getCommit(client.session, "not-a-full-object-id"),
    ]) await assertRequestRejected(request, "invalid file-page request must not return a page");
  } finally { await client.stop(); }
  assert.deepEqual(await snapshotTree(fixture.repository), before);
});

test("merge commits are grouped by parent, paginate in Git order and carry each group's Author distribution", async () => {
  const before = await snapshotTree(fixture.repository);
  const client = await openAllBranches("details-merge-groups");
  try {
    const octopusParents = (await git(fixture.repository, ["show", "-s", "--format=%P", fixture.octopus])).split(" ").filter(Boolean);
    assert.deepEqual(octopusParents, [fixture.merge, fixture.topicA, fixture.topicB]);
    const firstGroupExpected = await git(fixture.repository, ["rev-list", "--topo-order", octopusParents[1], "--not", octopusParents[0]]).then(value => value.split("\n").filter(Boolean));
    const secondGroupExpected = await git(fixture.repository, ["rev-list", "--topo-order", octopusParents[2], "--not", octopusParents[0]]).then(value => value.split("\n").filter(Boolean));
    assert.equal(firstGroupExpected.length, 205);
    assert.deepEqual(secondGroupExpected, [fixture.topicB]);
    const first = projectMergeCommits(await client.readMergeCommits(client.session, fixture.octopus.toUpperCase(), 1, { offset: 0, pageSize: 200 }));
    assert.equal(first.oid, fixture.octopus);
    assert.equal(first.parentIndex, 1);
    assert.equal(first.parentOid, octopusParents[1]);
    assert.equal(first.firstParentOid, octopusParents[0]);
    assert.equal(first.totalCommits, 205);
    assert.equal(first.commits.length, 200);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.commits.map(commit => commit.oid), firstGroupExpected.slice(0, 200));
    const next = projectMergeCommits(await client.readMergeCommits(client.session, fixture.octopus, 1, { offset: 200, pageSize: 200 }));
    assert.equal(next.commits.length, 5);
    assert.equal(next.hasMore, false);
    assert.deepEqual(next.commits.map(commit => commit.oid), firstGroupExpected.slice(200));
    assert.deepEqual(first.authors, await authorDistribution(fixture.repository, firstGroupExpected));
    assert.deepEqual(next.authors, first.authors, "group Author distribution is stable across page requests");
    const second = projectMergeCommits(await client.readMergeCommits(client.session, fixture.octopus, 2, { pageSize: 200 }));
    assert.deepEqual(second.commits.map(commit => commit.oid), secondGroupExpected);
    assert.deepEqual(second.authors, await authorDistribution(fixture.repository, secondGroupExpected));
    for (const request of [
      () => client.readMergeCommits(client.session, fixture.octopus, 0),
      () => client.readMergeCommits(client.session, fixture.octopus, 3),
      () => client.readMergeCommits(client.session, fixture.octopus, 1, { pageSize: 0 }),
      () => client.readMergeCommits(client.session, fixture.octopus, 1, { pageSize: 201 }),
      () => client.readMergeCommits(client.session, fixture.octopus, 1, { offset: 206 }),
    ]) await assertRequestRejected(request, "invalid merge group/page request must not return data");
  } finally { await client.stop(); }
  assert.deepEqual(await snapshotTree(fixture.repository), before, "merge set and Author queries are read-only");
});

test("branchesContaining matches Git and stays on captured tips after refs move", async () => {
  const before = await snapshotTree(fixture.repository);
  const client = await openAllBranches("details-frozen-containing");
  const frozenRefs = await captureBranchRefs(fixture.repository);
  try {
    const expectedLive = await gitBranchesContaining(fixture.repository, fixture.topicA);
    const initial = projectBranchesContaining(await client.branchesContaining(client.session, fixture.topicA.toUpperCase()));
    assert.equal(initial.oid, fixture.topicA);
    assert.equal(initial.complete, true);
    assert.deepEqual(branchNames(initial.branches), expectedLive, "local and remote containing refs match Git branch --contains commands");
    assert.deepEqual(await snapshotTree(fixture.repository), before, "initial branchesContaining query is read-only");

    const oldTopicTip = frozenRefs.get("refs/heads/topic/a");
    await git(fixture.repository, ["update-ref", "refs/heads/topic/a", fixture.unrelated, oldTopicTip]);
    const afterExternalMove = await snapshotTree(fixture.repository);
    const frozenExpected = await capturedBranchesContaining(fixture.repository, fixture.topicA, frozenRefs);
    const afterMove = projectBranchesContaining(await client.branchesContaining(client.session, fixture.topicA));
    assert.deepEqual(branchNames(afterMove.branches), frozenExpected, "same session uses tips captured before the ref moved");
    assert.ok(branchNames(afterMove.branches).includes("refs/heads/topic/a"));
    assert.deepEqual(await snapshotTree(fixture.repository), afterExternalMove, "frozen query does not add writes beyond the intentional ref update");
  } finally {
    await git(fixture.repository, ["update-ref", "refs/heads/topic/a", frozenRefs.get("refs/heads/topic/a")]);
    await client.stop();
  }
});

test("detail update hint distinguishes fast-forward, unrelated changes, rewrite and deleted scope", async () => {
  const client = await openAllBranches("details-update-state");
  const originalMain = await git(fixture.repository, ["rev-parse", "refs/heads/main"]);
  const originalUnrelated = await git(fixture.repository, ["rev-parse", "refs/heads/unrelated"]);
  const originalTopic = await git(fixture.repository, ["rev-parse", "refs/heads/topic/a"]);
  try {
    let session = client.session;
    assert.equal(await git(fixture.repository, ["cat-file", "-t", "refs/tags/detail-annotated"]), "tag");
    const tagSession = projectRefreshed(await client.selectScope(session, { ref: "refs/tags/detail-annotated" }, 10)).session;
    const taggedCommit = projectCommitDetails(await client.getCommit(tagSession, fixture.merge));
    assert.equal(taggedCommit.update.state, "unaffected", "annotated tag scope compares its peeled commit, not the tag object OID");
    session = projectRefreshed(await client.selectScope(tagSession, "allBranches", 20)).session;
    client.session = session;
    const tree = await git(fixture.repository, ["rev-parse", `${originalMain}^{tree}`]);
    const fastForward = await git(fixture.repository, ["commit-tree", tree, "-p", originalMain, "-m", "external fast-forward"]);
    await git(fixture.repository, ["update-ref", "refs/heads/main", fastForward, originalMain]);
    const unrelatedTree = await git(fixture.repository, ["rev-parse", `${fixture.unrelated}^{tree}`]);
    const unrelatedUpdate = await git(fixture.repository, ["commit-tree", unrelatedTree, "-p", fixture.unrelated, "-m", "unrelated branch update"]);
    await git(fixture.repository, ["update-ref", "refs/heads/unrelated", unrelatedUpdate, originalUnrelated]);
    const afterExternalAdvances = await snapshotTree(fixture.repository);
    const stillReachable = projectCommitDetails(await client.getCommit(session, fixture.head));
    assert.equal(stillReachable.update.state, "unaffected", "fast-forward and unrelated branch updates do not mark an old commit affected");
    assert.ok(stillReachable.refs.some(ref => ref.name === "refs/heads/main" && ref.oid === originalMain), "details retain captured refs rather than merging live labels");
    assert.deepEqual(await snapshotTree(fixture.repository), afterExternalAdvances, "detail recheck does not alter externally advanced refs or metadata");

    await git(fixture.repository, ["update-ref", "refs/heads/main", fixture.unrelated, fastForward]);
    const afterRewrite = await snapshotTree(fixture.repository);
    const rewritten = projectCommitDetails(await client.getCommit(session, fixture.head));
    assert.equal(rewritten.update.state, "affected");
    assert.equal(rewritten.update.reason, "noLongerReachable");
    assert.deepEqual(await snapshotTree(fixture.repository), afterRewrite, "rewrite detail recheck performs no repository writes");

    const topicScope = projectRefreshed(await client.selectScope(session, { ref: "refs/heads/topic/a" }, 10)).session;
    await git(fixture.repository, ["update-ref", "-d", "refs/heads/topic/a", originalTopic]);
    const afterDelete = await snapshotTree(fixture.repository);
    const unavailable = projectCommitDetails(await client.getCommit(topicScope, originalTopic));
    assert.equal(unavailable.update.state, "affected");
    assert.equal(unavailable.update.reason, "scopeUnavailable");
    assert.deepEqual(await snapshotTree(fixture.repository), afterDelete, "deleted-scope recheck does not recreate the reference");
  } finally {
    await git(fixture.repository, ["update-ref", "refs/heads/main", originalMain]);
    await git(fixture.repository, ["update-ref", "refs/heads/unrelated", originalUnrelated]);
    if (!await refExists(fixture.repository, "refs/heads/topic/a")) await git(fixture.repository, ["update-ref", "refs/heads/topic/a", originalTopic]);
    await client.stop();
  }
});

test("shallow ancestry stays explicitly incomplete; invalid OIDs and oversized detail responses fail clearly", async () => {
  const shallowRepository = join(resolve(process.env.COMMITSCOPE_DETAILS_DATA_ROOT), "shallow-copy");
  await mkdir(resolve(process.env.COMMITSCOPE_DETAILS_DATA_ROOT), { recursive: true });
  await git(fixture.repository, ["clone", "--quiet", "--no-checkout", "--no-hardlinks", fixture.repository, shallowRepository]);
  const shallowFile = await git(shallowRepository, ["rev-parse", "--path-format=absolute", "--git-path", "shallow"]);
  await writeFile(shallowFile, `${fixture.merge}\n`);
  const client = await openClient("details-shallow", shallowRepository, "allBranches");
  try {
    const branches = projectBranchesContaining(await client.branchesContaining(client.session, fixture.side));
    assert.equal(branches.boundaryLimited, true);
    assert.equal(branches.complete, false, "negative ancestry through a shallow boundary is not reported complete");
    assert.ok(branches.branches.some(ref => ref.oid === fixture.side), `a direct captured tip remains a positive result across the boundary; got ${JSON.stringify(branches.branches)}`);
    await assert.rejects(client.readMergeCommits(client.session, fixture.octopus, 1), error => error.code === "UNSUPPORTED_REPOSITORY");
    await assert.rejects(client.getCommit(client.session, "f".repeat(40)), error => error.code === "MISSING_OBJECT");
    await assert.rejects(client.getCommit(client.session, fixture.resourceLimit), error => error.code === "RESOURCE_LIMIT");
  } finally {
    await client.stop();
    await rm(shallowRepository, { recursive: true, force: true });
  }
});

test("a cancelled file query drains its Git child and a later request succeeds", { skip: process.platform === "win32" }, async () => {
  assert.ok(gitWrapper && gatePath && startedPath, "runner must configure the deterministic Git command gate");
  const before = await snapshotTree(fixture.repository);
  const client = await openAllBranches("details-cancel", fixture.repository, true);
  try {
    await writeFile(gatePath, "hold\n");
    const request = client.beginListChangedFiles(client.session, fixture.merge, 0, { pageSize: 200 }, 20_000);
    await waitForFile(startedPath, 10_000);
    client.cancel(request.requestId);
    await rm(gatePath, { force: true });
    await assert.rejects(request.result, error => error.code === "CANCELLED");
    const retry = projectChangedFiles(await client.listChangedFiles(client.session, fixture.merge, 0));
    assert.equal(retry.totalFiles > 0, true, "a new user request succeeds after cancellation");
  } finally {
    await rm(gatePath, { force: true });
    await client.stop();
  }
  assert.deepEqual(await snapshotTree(fixture.repository), before, "cancel and retry do not mutate repository state");
});

async function openAllBranches(name, repository = fixture.repository, useGate = false) {
  return openClient(name, repository, "allBranches", useGate);
}

async function openClient(name, repository, scope, useGate = false) {
  const client = new CommitDetailsDaemonClient(daemonPath, {
    cwd: repository,
    env: createDaemonEnvironment(join(dataRoot, name), useGate ? {
      PATH: `${gitWrapper}:${process.env.PATH ?? ""}`,
      COMMITSCOPE_DETAILS_GATE_REPOSITORY: repository,
      COMMITSCOPE_DETAILS_GATE_FILE: gatePath,
      COMMITSCOPE_DETAILS_GATE_STARTED: startedPath,
    } : {}),
  });
  await client.start();
  const session = projectSession(await client.open(repository));
  if (!session) throw new Error("openRepository did not return a session");
  const selected = projectRefreshed(await client.selectScope(session, scope, 20)).session;
  client.session = selected;
  return client;
}

function parseTrailer(line) {
  const colon = line.indexOf(":");
  assert.ok(colon > 0, `Git trailer line must contain key:value: ${line}`);
  return { key: line.slice(0, colon), value: line.slice(colon + 1).trimStart() };
}

function splitNul(buffer) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    parts.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

async function gitNameStatus(repository, parentOid, oid) {
  const output = await git(repository, [`--attr-source=${oid}`, "diff-tree", "--no-ext-diff", "--no-textconv", "-r", "--no-commit-id", "--name-status", "-z", "-M", parentOid, oid], { binary: true });
  const tokens = splitNul(output);
  const result = [];
  for (let index = 0; index < tokens.length;) {
    const statusToken = tokens[index++].toString("ascii");
    if (statusToken.startsWith("R") || statusToken.startsWith("C")) {
      const oldPath = tokens[index++]; const newPath = tokens[index++];
      result.push(`${statusToken[0]}:${oldPath.toString("hex")}:${newPath.toString("hex")}`);
    } else {
      const path = tokens[index++];
      const hex = path.toString("hex");
      result.push(`${statusToken}:${statusToken === "A" ? "" : hex}:${statusToken === "D" ? "" : hex}`);
    }
  }
  return result.sort();
}

async function gitRootAddedPaths(repository, oid) {
  const output = await git(repository, ["diff-tree", "--root", "-r", "--no-commit-id", "--name-status", "-z", oid], { binary: true });
  const tokens = splitNul(output);
  const result = [];
  for (let index = 0; index < tokens.length; index += 2) {
    assert.equal(tokens[index].toString("ascii"), "A");
    const path = tokens[index + 1];
    result.push(`A::${path.toString("hex")}`);
  }
  return result.sort();
}

function fileSignatures(files) {
  return files.map(file => {
    const status = ({ added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", typeChanged: "T" })[file.status];
    return `${status}:${file.oldPath?.rawHex ?? ""}:${file.newPath?.rawHex ?? ""}`;
  }).sort();
}

function assertTreeEntrySides(file, oldEntries, newEntries) {
  const oldPath = file.oldPath?.rawHex;
  const newPath = file.newPath?.rawHex;
  if (oldPath) {
    const entry = oldEntries.get(oldPath);
    assert.ok(entry, `parent tree has old path ${oldPath}`);
    assert.equal(file.oldMode, entry.mode);
    assert.equal(file.oldOid, entry.oid);
  } else {
    assert.equal(file.oldMode, "000000");
    assert.equal(file.oldOid, null);
  }
  if (newPath) {
    const entry = newEntries.get(newPath);
    assert.ok(entry, `commit tree has new path ${newPath}`);
    assert.equal(file.newMode, entry.mode);
    assert.equal(file.newOid, entry.oid);
  } else {
    assert.equal(file.newMode, "000000");
    assert.equal(file.newOid, null);
  }
}

async function readTreeEntries(repository, treeOid) {
  const output = await git(repository, ["ls-tree", "-rz", "-r", treeOid], { binary: true });
  const result = new Map();
  for (const record of splitNul(output)) {
    const tab = record.indexOf(0x09);
    if (tab < 0) continue;
    const [mode, _type, oid] = record.subarray(0, tab).toString("ascii").split(" ");
    result.set(record.subarray(tab + 1).toString("hex"), { mode, oid });
  }
  return result;
}

async function gitNumstat(repository, parentOid, oid) {
  const output = await git(repository, [`--attr-source=${oid}`, "diff-tree", "--no-ext-diff", "--no-textconv", "-r", "--no-commit-id", "--numstat", "-z", "-M", parentOid, oid], { binary: true });
  const tokens = splitNul(output);
  const result = new Map();
  for (let index = 0; index < tokens.length;) {
    const record = tokens[index++];
    const firstTab = record.indexOf(0x09);
    const secondTab = record.indexOf(0x09, firstTab + 1);
    const additionsText = record.subarray(0, firstTab).toString("ascii");
    const deletionsText = record.subarray(firstTab + 1, secondTab).toString("ascii");
    let path = record.subarray(secondTab + 1);
    if (path.length === 0) {
      index += 1; // old path in rename/copy numstat record
      path = tokens[index++];
    }
    result.set(path.toString("hex"), {
      additions: additionsText === "-" ? null : Number(additionsText),
      deletions: deletionsText === "-" ? null : Number(deletionsText),
    });
  }
  return result;
}

function assertFileNumstat(files, oracle, label) {
  for (const file of files) {
    const path = file.newPath ?? file.oldPath;
    const expected = oracle.get(path.rawHex);
    assert.ok(expected, `${label} independent numstat includes ${path.rawHex}`);
    assert.equal(file.additions, expected.additions, `${label} additions for ${path.display}`);
    assert.equal(file.deletions, expected.deletions, `${label} deletions for ${path.display}`);
    assert.equal(file.binary, expected.additions === null, `${label} binary flag for ${path.display}`);
  }
}

function assertOverviewStats(page, oracle, label) {
  const known = [...oracle.values()].filter(value => value.additions !== null);
  assert.equal(page.overview.additions, known.reduce((sum, value) => sum + value.additions, 0), `${label} overview additions match Git numstat`);
  assert.equal(page.overview.deletions, known.reduce((sum, value) => sum + value.deletions, 0), `${label} overview deletions match Git numstat`);
  assert.equal(page.overview.binaryFiles, [...oracle.values()].filter(value => value.additions === null).length, `${label} binary overview matches Git numstat`);
}

function assertDirectoryOverview(page, numstat, label) {
  const expected = new Map();
  for (const file of page.files) {
    const path = file.newPath ?? file.oldPath;
    const bytes = Buffer.from(path.rawHex, "hex");
    const separator = bytes.indexOf(0x2f);
    const key = separator < 0 ? null : bytes.subarray(0, separator).toString("hex");
    const value = expected.get(key) ?? { totalFiles: 0, additions: 0, deletions: 0 };
    const stats = numstat.get(path.rawHex);
    value.totalFiles += 1;
    if (stats?.additions !== null) value.additions += stats?.additions ?? 0;
    if (stats?.deletions !== null) value.deletions += stats?.deletions ?? 0;
    expected.set(key, value);
  }
  const actual = new Map(page.overview.directories.map(item => [item.path?.rawHex ?? null, {
    totalFiles: item.totalFiles, additions: item.additions, deletions: item.deletions,
  }]));
  assert.deepEqual([...actual.entries()].sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")),
    [...expected.entries()].sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")), `${label} first-level directory totals match independent Git file/numstat entries`);
}

async function authorDistribution(repository, oids) {
  const counts = new Map();
  for (const oid of oids) {
    const [name, email] = (await git(repository, ["show", "-s", "--format=%an%x00%ae", oid])).split("\0");
    const key = `${name}\0${email}`;
    const item = counts.get(key) ?? { name, email, count: 0 };
    item.count += 1;
    counts.set(key, item);
  }
  return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
}

function branchNames(refs) { return refs.map(ref => ref.name).sort(); }

async function gitBranchesContaining(repository, oid) {
  const local = await git(repository, ["branch", "--format=%(refname)", "--contains", oid]);
  const remote = await git(repository, ["branch", "-r", "--format=%(refname)", "--contains", oid]);
  return [local, remote].flatMap(value => value.split("\n")).filter(Boolean).sort();
}

async function captureBranchRefs(repository) {
  const output = await git(repository, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/remotes"]);
  return new Map(output.split("\n").filter(Boolean).map(line => {
    const [name, oid] = line.split("\0");
    return [name, oid];
  }));
}

async function capturedBranchesContaining(repository, oid, refs) {
  const result = [];
  for (const [name, tip] of refs) {
    try {
      await git(repository, ["merge-base", "--is-ancestor", oid, tip]);
      result.push(name);
    } catch (error) {
      if (error.code === 1) continue;
      throw error;
    }
  }
  return result.sort();
}

async function assertRequestRejected(request, message) {
  await assert.rejects(request(), error => typeof error.code === "string" && error.code.length > 0, message);
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(path)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for Git gate marker: ${path}`);
}

async function refExists(repository, ref) {
  try { await git(repository, ["show-ref", "--verify", "--quiet", ref]); return true; }
  catch (error) { if (error.code === 1) return false; throw error; }
}

async function exists(path) {
  try { await (await import("node:fs/promises")).access(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
