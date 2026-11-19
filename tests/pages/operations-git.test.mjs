import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, readFile, rename, rm, chmod, stat, symlink, readlink, realpath, truncate } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  PagesDaemonClient,
  createDaemonEnvironment,
  projectSession,
} from "./daemon-client.mjs";
import { git } from "./fixture.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const root = join(
  dirname(process.env.COMMITSCOPE_PAGES_DATA_ROOT),
  "operations",
);
const identity = {
  GIT_AUTHOR_NAME: "Operation Author",
  GIT_AUTHOR_EMAIL: "author@example.test",
  GIT_COMMITTER_NAME: "Operation Committer",
  GIT_COMMITTER_EMAIL: "committer@example.test",
};
async function commit(repo, path, text) {
  await writeFile(join(repo, path), text);
  await git(repo, ["add", "--", path]);
  await git(repo, ["commit", "-qm", path], { env: identity });
  return git(repo, ["rev-parse", "HEAD"]);
}
async function fixture(t, label, sha256 = false, extraEnv = {}) {
  const base = join(root, label),
    remote = join(base, "remote"),
    repo = join(base, "local");
  await mkdir(base, { recursive: true });
  await git(base, [
    "init",
    "-q",
    "-b",
    "main",
    ...(sha256 ? ["--object-format=sha256"] : []),
    remote,
  ]);
  const first = await commit(remote, "a.txt", "one\n");
  await git(remote, ["branch", "topic"]);
  await git(base, ["clone", "-q", remote, repo]);
  const second = await commit(remote, "a.txt", "two\n");
  await git(repo, ["fetch", "-q"]);
  const client = new PagesDaemonClient(process.env.COMMITSCOPE_DAEMON_PATH, {
    cwd: repo,
    env: createDaemonEnvironment(join(base, "data"), {
      HOME: process.env.COMMITSCOPE_PAGES_HOME,
      XDG_CONFIG_HOME: join(process.env.COMMITSCOPE_PAGES_HOME, ".config"),
      ...extraEnv,
    }),
  });
  await client.start();
  client.session = projectSession(await client.open(repo));
  t.after(() => client.stop());
  const call = async (method, operation) =>
    (await client.call(method, { operation })).chunks[0].data.result;
  return { base, remote, repo, first, second, client, call };
}
async function rejected(f, op, kind) {
  const before = await snapshotTree(f.repo);
  const check = await f.call("checkOperation", op);
  assert.equal(check.allowed, false);
  assert.ok(
    check.blockers.some((b) => b.kind === kind),
    JSON.stringify(check),
  );
  const run = await f.call("runOperation", op);
  assert.equal(run.outcome, "rejected");
  assert.ok(
    run.blockers.some((b) => b.kind === kind),
    JSON.stringify(run),
  );
  assert.deepEqual(
    await snapshotTree(f.repo),
    before,
    "rejection leaves every file, index, ref, config and hook unchanged",
  );
}

async function collisionOperation(f) {
  await git(f.remote, ["add", "-A"]);
  await git(f.remote, ["commit", "-qm", "upstream adds files"], { env: identity });
  await git(f.repo, ["fetch", "-q"]);
  return { kind: "fastForward", refName: "refs/heads/main", expectedOid: f.first, upstreamOid: await git(f.remote, ["rev-parse", "HEAD"]) };
}

test("P5-06 ignored directory, untracked executable and identical files survive a confirmed update", async t => {
  const f = await fixture(t, "confirmed-untracked");
  for (const dir of [f.repo, f.remote]) await mkdir(join(dir, "ignored"));
  await writeFile(join(f.repo, ".git/info/exclude"), "ignored/\n");
  for (const dir of [f.repo, f.remote]) {
    await writeFile(join(dir, "ignored/same.txt"), "same\n");
    await symlink("same.txt", join(dir, "ignored/link"));
  }
  await writeFile(join(f.repo, "ignored/local only.txt"), "unrelated\n");
  await writeFile(join(f.remote, "ignored/upstream only.txt"), "only upstream\n");
  const oldText = "shared\nold\n";
  const newText = "shared\nnew\nmore\n";
  await writeFile(join(f.repo, "ignored/草稿.txt"), oldText);
  await writeFile(join(f.remote, "ignored/草稿.txt"), newText);
  await writeFile(join(f.repo, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(f.remote, "run.sh"), "#!/bin/sh\n", { mode: 0o644 });
  await chmod(join(f.repo, "run.sh"), 0o750);
  await git(f.repo, ["config", "branch.main.mergeOptions", "--squash"]);
  const op = await collisionOperation(f);
  const before = await snapshotTree(f.repo);
  const check = await f.call("checkOperation", op);
  assert.equal(check.allowed, false);
  assert.equal(check.identicalUntrackedCount, 2);
  const [dirty] = check.blockers;
  assert.equal(dirty.kind, "dirty");
  assert.ok(dirty.replaceToken);
  assert.deepEqual(dirty.paths.map(p => p.path.display).sort(), ["ignored/草稿.txt", "run.sh"]);
  assert.deepEqual(dirty.paths.find(p => p.path.display === "ignored/草稿.txt").replace, { upstreamOnlyLines: 2, localOnlyLines: 1 });
  assert.equal((await f.call("runOperation", op)).outcome, "rejected");
  const approved = { ...op, replaceUntracked: dirty.replaceToken };
  assert.equal((await f.call("checkOperation", approved)).allowed, true);
  assert.deepEqual(await snapshotTree(f.repo), before, "no preflight or default rejection may write the index or objects");
  const run = await f.call("runOperation", approved);
  assert.equal(run.outcome, "done");
  const { backupDir, backedUpCount, identicalCount } = run.untracked;
  assert.equal(identicalCount, 2);
  assert.equal(backedUpCount, 2);
  assert.ok(backupDir.startsWith((await realpath(join(f.base, "data/backups"))) + "/"));
  assert.equal(await readFile(join(backupDir, "ignored/草稿.txt"), "utf8"), oldText);
  assert.equal(await readFile(join(backupDir, "run.sh"), "utf8"), "#!/bin/sh\n");
  assert.equal((await stat(join(backupDir, "run.sh"))).mode & 0o777, 0o750);
  assert.equal((await stat(join(f.repo, "run.sh"))).mode & 0o100, 0);
  await assert.rejects(stat(join(backupDir, "ignored/same.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.repo, "ignored/草稿.txt"), "utf8"), newText);
  assert.equal(await readFile(join(f.repo, "ignored/local only.txt"), "utf8"), "unrelated\n");
  assert.equal(await readlink(join(f.repo, "ignored/link")), "same.txt");
  assert.equal(await git(f.repo, ["rev-parse", "HEAD"]), op.upstreamOid);
});

test("P5-06 stale consent is rejected when either an identical or a differing local copy changes or disappears", async t => {
  const f = await fixture(t, "stale-untracked");
  for (const dir of [f.repo, f.remote]) await writeFile(join(dir, "same"), "same\n");
  await writeFile(join(f.repo, "draft"), "old\n");
  await writeFile(join(f.remote, "draft"), "new\n");
  const op = await collisionOperation(f);
  const { replaceToken } = (await f.call("checkOperation", op)).blockers[0];
  assert.ok(replaceToken);
  await assert.rejects(f.call("runOperation", { ...op, replaceUntracked: replaceToken, discardUntracked: replaceToken }),
    error => error.code === "INVALID_REQUEST");
  async function stale() {
    const before = await snapshotTree(f.repo);
    for (const choice of ["replaceUntracked", "discardUntracked"]) {
      const approved = { ...op, [choice]: replaceToken };
      assert.equal((await f.call("checkOperation", approved)).allowed, false);
      assert.equal((await f.call("runOperation", approved)).outcome, "rejected");
    }
    assert.deepEqual(await snapshotTree(f.repo), before);
  }
  await writeFile(join(f.repo, "same"), "changed since review\n");
  await stale();
  await writeFile(join(f.repo, "same"), "same\n");
  await writeFile(join(f.repo, "draft"), "changed again\n");
  await stale();
  await rm(join(f.repo, "draft"));
  await stale();
  const result = await f.call("runOperation", op);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.untracked, { identicalCount: 1, backedUpCount: 0, backupDir: null });
  assert.equal(await git(f.repo, ["rev-parse", "HEAD"]), op.upstreamOid);
});

test("P5-06 mixed tracked edits, unsafe index and path-type conflicts have no backup action", async t => {
  const f = await fixture(t, "unsafe-untracked");
  await writeFile(join(f.repo, "local"), "draft");
  await writeFile(join(f.remote, "local"), "upstream");
  const op = await collisionOperation(f);
  async function blocked() {
    const before = await snapshotTree(f.repo);
    const check = await f.call("checkOperation", op);
    assert.equal(check.allowed, false);
    assert.ok(check.blockers.every(b => !b.replaceToken));
    assert.equal((await f.call("runOperation", op)).outcome, "rejected");
    assert.deepEqual(await snapshotTree(f.repo), before);
  }
  await writeFile(join(f.repo, "a.txt"), "my edit");
  await blocked();
  await writeFile(join(f.repo, "a.txt"), "one\n");
  await git(f.repo, ["update-index", "--assume-unchanged", "a.txt"]);
  await blocked();
  await git(f.repo, ["update-index", "--no-assume-unchanged", "a.txt"]);
  await rm(join(f.repo, "local"));
  await mkdir(join(f.repo, "local"));
  await writeFile(join(f.repo, "local/child"), "child");
  await blocked();
});

test("P5-06 binary files in a SHA-256 repository can be backed up without text counts", async t => {
  const f = await fixture(t, "sha256-binary", true);
  const original = Buffer.from([0, 255, 2]);
  const upstream = Buffer.from([0, 9, 8, 7]);
  await writeFile(join(f.repo, "asset.bin"), original);
  await writeFile(join(f.remote, "asset.bin"), upstream);
  const op = await collisionOperation(f);
  const [dirty] = (await f.call("checkOperation", op)).blockers;
  assert.deepEqual(dirty.paths[0].replace, { upstreamOnlyLines: null, localOnlyLines: null });
  const run = await f.call("runOperation", { ...op, replaceUntracked: dirty.replaceToken });
  assert.equal(run.outcome, "done");
  assert.deepEqual(await readFile(join(run.untracked.backupDir, "asset.bin")), original);
  assert.deepEqual(await readFile(join(f.repo, "asset.bin")), upstream);
});

test("P5-06 target checkout conversions and nested repositories cannot be displaced", async t => {
  const f = await fixture(t, "unsafe-paths");
  await writeFile(join(f.remote, ".gitattributes"), "convert.txt text eol=crlf\n");
  for (const dir of [f.repo, f.remote]) {
    await writeFile(join(dir, "convert.txt"), "line\n");
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested/doc"), "inner document\n");
  }
  await git(join(f.repo, "nested"), ["init", "-q"]);
  await git(join(f.repo, "nested"), ["add", "doc"]);
  await git(join(f.repo, "nested"), ["commit", "-qm", "inner commit"], { env: identity });
  const op = await collisionOperation(f);
  const check = await f.call("checkOperation", op);
  assert.equal(check.identicalUntrackedCount, 0);
  assert.ok(check.blockers.every(b => !b.replaceToken));
  await rejected(f, op, "dirty");
});

test("P5-06 a failed Git fast-forward restores local files and executable permissions", async t => {
  const f = await fixture(t, "restore-untracked");
  await writeFile(join(f.repo, "draft"), "my version\n", { mode: 0o755 });
  await writeFile(join(f.remote, "draft"), "remote version\n");
  for (const dir of [f.repo, f.remote]) await writeFile(join(dir, "same"), "same\n");
  const op = await collisionOperation(f);
  const token = (await f.call("checkOperation", op)).blockers[0].replaceToken;
  assert.ok(token);
  // A second Git process owns the index lock. Preflight can read; Git cannot start the checkout.
  await writeFile(join(f.repo, ".git/index.lock"), "independent lock");
  for (const choice of ["replaceUntracked", "discardUntracked"]) {
    await assert.rejects(f.call("runOperation", { ...op, [choice]: token }), e => e.code === "GIT_ERROR");
  }
  assert.equal(await git(f.repo, ["rev-parse", "HEAD"]), f.first);
  assert.equal(await readFile(join(f.repo, "draft"), "utf8"), "my version\n");
  assert.ok((await stat(join(f.repo, "draft"))).mode & 0o100);
  assert.equal(await readFile(join(f.repo, "same"), "utf8"), "same\n");
  assert.equal(await readFile(join(f.repo, ".git/index.lock"), "utf8"), "independent lock");
});

test("P5-06 a new file appearing during checkout survives rollback alongside the original backup", async t => {
  const gate = process.env.COMMITSCOPE_PAGES_GATE_FILE;
  const started = process.env.COMMITSCOPE_PAGES_GATE_STARTED;
  const f = await fixture(t, "concurrent-untracked", false, {
    PATH: `${process.env.COMMITSCOPE_PAGES_GIT_WRAPPER}:${process.env.PATH}`,
    COMMITSCOPE_PAGES_GATE_FILE: gate,
    COMMITSCOPE_PAGES_GATE_STARTED: started,
  });
  await writeFile(join(f.repo, "draft"), "original\n");
  await writeFile(join(f.remote, "draft"), "upstream\n");
  await writeFile(join(f.repo, ".git/info/exclude"), "draft\n");
  const op = await collisionOperation(f);
  const token = (await f.call("checkOperation", op)).blockers[0].replaceToken;
  await rm(started, { force: true });
  await writeFile(gate, "merge");
  const result = f.call("runOperation", { ...op, replaceUntracked: token }).catch(error => error);
  try {
    for (let i = 0; i < 400; ++i) {
      if (await stat(started).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await stat(started);
    await writeFile(join(f.repo, "draft"), "concurrent edit\n", { flag: "wx" });
  } finally {
    await rm(gate, { force: true });
  }
  const failure = await result;
  assert.equal(failure.code, "GIT_ERROR");
  const backups = join(f.base, "data/backups");
  const entries = await snapshotTree(backups);
  const draft = entries.find(entry => entry.type === "file" && entry.path.endsWith("/draft"));
  assert.ok(draft);
  assert.ok(failure.message.includes(await realpath(dirname(join(backups, draft.path)))));
  assert.equal(await readFile(join(backups, draft.path), "utf8"), "original\n");
  assert.equal(await readFile(join(f.repo, "draft"), "utf8"), "concurrent edit\n");
  assert.equal(await git(f.repo, ["rev-parse", "HEAD"]), f.first);
});

test("P5-06 can check and update 200 identical additions within the desktop request budget", async t => {
  const f = await fixture(t, "boundary-identical");
  for (const dir of [f.repo, f.remote]) {
    await mkdir(join(dir, "files"));
    await Promise.all(Array.from({ length: 200 }, (_, n) => writeFile(join(dir, "files", String(n)), String(n))));
  }
  const op = await collisionOperation(f);
  const check = await f.call("checkOperation", op);
  assert.equal(check.allowed, true);
  assert.equal(check.identicalUntrackedCount, 200);
  const run = await f.call("runOperation", op);
  assert.equal(run.outcome, "done");
  assert.deepEqual(run.untracked, { identicalCount: 200, backedUpCount: 0, backupDir: null });
  assert.equal(await git(f.repo, ["rev-parse", "HEAD"]), op.upstreamOid);
});

test("P5-06 a local file over the byte limit blocks the whole replacement offer", async t => {
  const f = await fixture(t, "byte-limit");
  for (const dir of [f.remote, f.repo]) await writeFile(join(dir, "big"), "upstream");
  await truncate(join(f.repo, "big"), 64 * 1024 * 1024 + 1);
  await writeFile(join(f.repo, "draft"), "mine");
  await writeFile(join(f.remote, "draft"), "theirs");
  const op = await collisionOperation(f);
  const check = await f.call("checkOperation", op);
  assert.equal(check.allowed, false);
  assert.ok(check.blockers.every(b => !b.replaceToken));
  await rejected(f, op, "dirty");
});

test("P5-06 comparison limit inside one ignored directory refuses without a partial offer", async t => {
  const f = await fixture(t, "limited-ignored");
  for (const dir of [f.repo, f.remote]) await mkdir(join(dir, "ignored"));
  await writeFile(join(f.repo, ".git/info/exclude"), "ignored/\n");
  for (let i = 0; i < 201; i++) {
    await writeFile(join(f.repo, "ignored", String(i)), "local");
    await writeFile(join(f.remote, "ignored", String(i)), "upstream");
  }
  const op = await collisionOperation(f);
  const check = await f.call("checkOperation", op);
  assert.ok(check.blockers.some(b => b.kind === "dirty"));
  assert.ok(check.blockers.every(b => !b.replaceToken));
  await rejected(f, op, "dirty");
});

test("M5 large fast-forward checks thousands of paths within the desktop request budget and preserves local work", async t => {
  const f = await fixture(t, "large-preflight");
  const remoteDirectory = "upstream/new-files/with-a-long-component-for-path-comparison";
  const localDirectory = "local/unfinished-files/with-a-long-component-for-path-comparison";
  await mkdir(join(f.remote, remoteDirectory), { recursive: true });
  await mkdir(join(f.repo, localDirectory), { recursive: true });
  async function files(repo, directory, count) {
    for (let start = 0; start < count; start += 100) {
      await Promise.all(Array.from({ length: Math.min(100, count - start) }, (_, index) =>
        writeFile(join(repo, directory, `file-${start + index}.txt`), "preserve this content\n")));
    }
  }
  await files(f.remote, remoteDirectory, 8500);
  await git(f.remote, ["add", "."]);
  await git(f.remote, ["commit", "-qm", "many upstream paths"], { env: identity });
  const target = await git(f.remote, ["rev-parse", "HEAD"]);
  await git(f.repo, ["fetch", "-q"]);
  await files(f.repo, localDirectory, 700);
  const localBefore = await snapshotTree(join(f.repo, localDirectory));
  const operation = { kind: "fastForward", refName: "refs/heads/main", expectedOid: f.first, upstreamOid: target };
  const before = await snapshotTree(f.repo);
  // The client uses the same 20 s request deadline as the desktop. The previous nested path decoder times out here.
  const check = await f.call("checkOperation", operation);
  assert.equal(check.allowed, true);
  assert.equal(check.preservedDirtyCount, 700);
  assert.deepEqual(await snapshotTree(f.repo), before, "preflight is read-only");
  assert.equal((await f.call("runOperation", operation)).outcome, "done");
  assert.equal(await git(f.repo, ["rev-parse", "HEAD"]), target);
  assert.equal(await readFile(join(f.repo, remoteDirectory, "file-8499.txt"), "utf8"), "preserve this content\n");
  assert.equal(await readFile(join(f.repo, localDirectory, "file-699.txt"), "utf8"), "preserve this content\n");
  assert.deepEqual(await snapshotTree(join(f.repo, localDirectory)), localBefore, "all 700 local files are preserved");
});

test("M5 fast-forward preflight includes a renamed source and distinguishes sibling path prefixes", async t => {
  const f = await fixture(t, "rename-path-preflight");
  await git(f.remote, ["mv", "a.txt", "renamed.txt"]);
  await git(f.remote, ["commit", "-qm", "rename upstream file"], { env: identity });
  const target = await git(f.remote, ["rev-parse", "HEAD"]);
  await git(f.repo, ["fetch", "-q"]);
  const operation = { kind: "fastForward", refName: "refs/heads/main", expectedOid: f.first, upstreamOid: target };
  await writeFile(join(f.repo, "a.txt"), "local edits to renamed source\n");
  await rejected(f, operation, "dirty");
  await writeFile(join(f.repo, "a.txt"), "one\n");
  await writeFile(join(f.repo, "renamed.txt.local"), "safe sibling\n");
  assert.equal((await f.call("checkOperation", operation)).allowed, true);
  assert.equal((await f.call("runOperation", operation)).outcome, "done");
  assert.equal(await readFile(join(f.repo, "renamed.txt.local"), "utf8"), "safe sibling\n");
});
for (const sha256 of [false, true])
  test(`M5 fast-forward current and other branches, SHA-${sha256 ? 256 : 1}`, async (t) => {
    const f = await fixture(t, `ff-${sha256}`, sha256);
    const sync = (
      await f.client.call("getBranchSync", { refNames: ["refs/heads/main"] })
    ).chunks[0].data.result;
    assert.deepEqual(
      [sync.branches[0].ahead, sync.branches[0].behind, sync.branches[0].state],
      [0, 1, "behind"],
    );
    assert.ok(sync.lastFetchUnixMs > 0);
    const op = {
      kind: "fastForward",
      refName: "refs/heads/main",
      expectedOid: f.first,
      upstreamOid: f.second,
    };
    const oracle = join(f.base, "oracle");
    await git(f.base, ["clone", "-q", f.repo, oracle]);
    await git(oracle, ["merge", "--ff-only", f.second]);
    assert.equal((await f.call("checkOperation", op)).allowed, true);
    assert.equal((await f.call("runOperation", op)).outcome, "done");
    assert.equal(
      await git(f.repo, ["rev-parse", "HEAD"]),
      await git(oracle, ["rev-parse", "HEAD"]),
    );
    assert.deepEqual(
      await readFile(join(f.repo, "a.txt")),
      await readFile(join(oracle, "a.txt")),
    );
    await git(f.repo, ["branch", "--track", "other", "origin/main"]);
    await git(f.repo, ["update-ref", "refs/heads/other", f.first]);
    const index = await readFile(join(f.repo, ".git/index"));
    const head = await git(f.repo, ["rev-parse", "HEAD"]);
    assert.equal(
      (await f.call("runOperation", { ...op, refName: "refs/heads/other" }))
        .outcome,
      "done",
    );
    assert.equal(await git(f.repo, ["rev-parse", "other"]), f.second);
    assert.equal(await git(f.repo, ["rev-parse", "HEAD"]), head);
    assert.deepEqual(await readFile(join(f.repo, ".git/index")), index);
    // The old browse snapshot remains frozen until refresh.
    const frozen = (
      await f.client.call("getBranchSync", { refNames: ["refs/heads/main"] })
    ).chunks[0].data.result;
    assert.equal(frozen.branches[0].oid, f.first);
    assert.equal(frozen.branches[0].behind, 1);
  });
test("M5 rejected dirty, divergent, changed references, worktree, in-progress and missing upstream operations never write", async (t) => {
  const f = await fixture(t, "rejected");
  const op = {
    kind: "fastForward",
    refName: "refs/heads/main",
    expectedOid: f.first,
    upstreamOid: f.second,
  };
  await writeFile(join(f.repo, "a.txt"), "dirty\n");
  await rejected(f, op, "dirty");
  await writeFile(join(f.repo, "a.txt"), "one\n");
  await rejected(f, { ...op, expectedOid: f.second }, "refChanged");
  await writeFile(join(f.repo, ".git/MERGE_HEAD"), `${f.second}\n`);
  await rejected(f, op, "inProgress");
  await rm(join(f.repo, ".git/MERGE_HEAD"));
  await git(f.repo, ["branch", "local-only"]);
  await rejected(f, { ...op, refName: "refs/heads/local-only" }, "noUpstream");
  await git(f.repo, ["branch", "--track", "other", "origin/main"]);
  await git(f.repo, ["update-ref", "refs/heads/other", f.first]);
  await git(f.repo, ["worktree", "add", "-q", join(f.base, "linked"), "other"]);
  await rejected(
    f,
    { ...op, refName: "refs/heads/other" },
    "checkedOutElsewhere",
  );
  const local = await commit(f.repo, "a.txt", "local divergent\n");
  await rejected(f, { ...op, expectedOid: local }, "diverged");
  const result = await f.call("checkOperation", { ...op, expectedOid: local });
  const blocker = result.blockers[0];
  assert.deepEqual([blocker.ahead, blocker.behind], [1, 1]);
  assert.equal(blocker.localCommits[0].oid, local);
  assert.equal(blocker.upstreamCommits[0].oid, f.second);
  assert.equal(blocker.overlapPaths[0].display, "a.txt");
});
test("M5 switch preserves unrelated dirt, tracks remotes, runs hooks and validates creation names", async (t) => {
  const f = await fixture(t, "switch");
  await git(f.repo, ["branch", "target", "origin/main"]);
  await writeFile(join(f.repo, "unrelated.txt"), "keep\n");
  const hook = join(f.repo, ".git/hooks/post-checkout");
  await writeFile(hook, "#!/bin/sh\nprintf hook > hook-ran\n");
  await chmod(hook, 0o755);
  const op = {
    kind: "switch",
    target: { refName: "refs/heads/target" },
    expectedOid: f.second,
    expectedHeadOid: f.first,
  };
  assert.equal((await f.call("checkOperation", op)).preservedDirtyCount, 1);
  const oracle = join(f.base, "oracle");
  await git(f.base, ["clone", "-q", f.repo, oracle]);
  await git(oracle, ["switch", "-c", "target", "origin/target"]);
  assert.equal((await f.call("runOperation", op)).outcome, "done");
  assert.equal(
    await git(f.repo, ["rev-parse", "HEAD"]),
    await git(oracle, ["rev-parse", "HEAD"]),
  );
  assert.equal(await readFile(join(f.repo, "unrelated.txt"), "utf8"), "keep\n");
  assert.equal(await readFile(join(f.repo, "hook-ran"), "utf8"), "hook");
  const create = {
    kind: "createBranch",
    name: "new-branch",
    startOid: f.first,
    switchAfter: false,
    expectedHeadOid: f.second,
  };
  for (const name of ["bad..name", "-injected", "HEAD", "@{-1}"])
    await rejected(f, { ...create, name }, "nameInvalid");
  await rejected(f, { ...create, name: "main" }, "nameExists");
  await rejected(f, { ...create, name: "main/child" }, "nameExists");
  await git(f.repo, ["branch", "prefix/child"]);
  await rejected(f, { ...create, name: "prefix" }, "nameExists");
  assert.equal((await f.call("runOperation", create)).outcome, "done");
  assert.equal(await git(f.repo, ["rev-parse", "new-branch"]), f.first);
  assert.equal(
    await git(f.repo, ["symbolic-ref", "HEAD"]),
    "refs/heads/target",
  );
  assert.equal(
    (
      await f.call("runOperation", {
        ...create,
        name: "created-and-switched",
        switchAfter: true,
      })
    ).outcome,
    "done",
  );
  assert.equal(
    await git(f.repo, ["symbolic-ref", "HEAD"]),
    "refs/heads/created-and-switched",
  );
  assert.equal(
    (
      await f.call("runOperation", {
        kind: "switch",
        target: { remoteRefName: "refs/remotes/origin/topic" },
        expectedOid: f.first,
        expectedHeadOid: f.first,
      })
    ).outcome,
    "done",
  );
  assert.equal(await git(f.repo, ["symbolic-ref", "HEAD"]), "refs/heads/topic");
  assert.equal(
    await git(f.repo, ["rev-parse", "--symbolic-full-name", "@{upstream}"]),
    "refs/remotes/origin/topic",
  );
});
test("M5 navigation sanitizes URLs and switch rejects changed target and overlapping ignored files", async (t) => {
  const f = await fixture(t, "url-dirty");
  await git(f.repo, [
    "remote",
    "set-url",
    "origin",
    "https://name:secret@github.com/owner/repo.git",
  ]);
  f.client.session = projectSession(await f.client.refresh(f.client.session));
  const nav = (await f.client.call("getRepositoryNavigation", {})).chunks[0]
    .data.navigation;
  assert.equal(nav.remotes[0].webUrl, "https://github.com/owner/repo");
  assert.equal(JSON.stringify(nav).includes("secret"), false);
  await git(f.repo, ["branch", "target", f.second]);
  const op = {
    kind: "switch",
    target: { refName: "refs/heads/target" },
    expectedOid: f.second,
    expectedHeadOid: f.first,
  };
  await rejected(f, { ...op, expectedOid: f.first }, "refChanged");
  await writeFile(join(f.repo, "a.txt"), "dirty\n");
  await rejected(f, op, "dirty");
});

test("M5 global hook configuration is honored and ignored-file collisions are rejected before writes", async (t) => {
  const f = await fixture(t, "global-hooks");
  await f.client.stop();
  const customHome = join(f.base, "home"),
    hooks = join(f.base, "hooks");
  await mkdir(customHome);
  await mkdir(hooks);
  await writeFile(
    join(customHome, ".gitconfig"),
    `[core]\n\thooksPath = ${hooks}\n`,
  );
  await writeFile(
    join(hooks, "post-checkout"),
    "#!/bin/sh\nprintf global > global-hook-ran\n",
  );
  await chmod(join(hooks, "post-checkout"), 0o755);
  const client = new PagesDaemonClient(process.env.COMMITSCOPE_DAEMON_PATH, {
    cwd: f.repo,
    env: createDaemonEnvironment(join(f.base, "global-data"), {
      HOME: customHome,
      XDG_CONFIG_HOME: join(customHome, ".config"),
    }),
  });
  await client.start();
  client.session = projectSession(await client.open(f.repo));
  t.after(() => client.stop());
  const result = (
    await client.call("runOperation", {
      operation: {
        kind: "createBranch",
        name: "global-hook-branch",
        startOid: f.first,
        expectedHeadOid: f.first,
        switchAfter: true,
      },
    })
  ).chunks[0].data.result;
  assert.equal(result.outcome, "done");
  assert.equal(
    await readFile(join(f.repo, "global-hook-ran"), "utf8"),
    "global",
  );
  await writeFile(join(f.repo, ".git/info/exclude"), "benign.tmp\n");
  await writeFile(join(f.repo, "benign.tmp"), "ignored but safe\n");
  const safe = (
    await client.call("checkOperation", {
      operation: {
        kind: "createBranch",
        name: "safe",
        startOid: f.first,
        expectedHeadOid: f.first,
        switchAfter: true,
      },
    })
  ).chunks[0].data.result;
  assert.equal(safe.allowed, true);
  assert.equal(
    safe.preservedDirtyCount,
    1,
    "ignored entries do not inflate the preserved-file count",
  );
  const target = await commit(f.remote, "ignored.txt", "remote\n");
  await git(f.repo, ["fetch", "-q"]);
  await git(f.repo, ["branch", "ignored-target", target]);
  await writeFile(join(f.repo, ".git/info/exclude"), "ignored.txt\n");
  await writeFile(join(f.repo, "ignored.txt"), "local ignored\n");
  const call = async (method, operation) =>
    (await client.call(method, { operation })).chunks[0].data.result;
  await rejected(
    { ...f, call },
    {
      kind: "switch",
      target: { refName: "refs/heads/ignored-target" },
      expectedOid: target,
      expectedHeadOid: f.first,
    },
    "dirty",
  );
});

test("M5 two daemons sharing application data serialize operations on the object database", async (t) => {
  const f = await fixture(t, "cross-daemon");
  await f.client.stop();
  const gate = process.env.COMMITSCOPE_PAGES_GATE_FILE,
    started = process.env.COMMITSCOPE_PAGES_GATE_STARTED;
  await rm(started, { force: true });
  await writeFile(gate, "fetch");
  const env = createDaemonEnvironment(join(f.base, "shared-data"), {
    HOME: process.env.COMMITSCOPE_PAGES_HOME,
    PATH: `${process.env.COMMITSCOPE_PAGES_GIT_WRAPPER}:${process.env.PATH}`,
    COMMITSCOPE_PAGES_GATE_FILE: gate,
    COMMITSCOPE_PAGES_GATE_STARTED: started,
  });
  const clients = [];
  for (let i = 0; i < 2; i++) {
    const c = new PagesDaemonClient(process.env.COMMITSCOPE_DAEMON_PATH, {
      cwd: f.repo,
      env,
    });
    await c.start();
    c.session = projectSession(await c.open(f.repo));
    clients.push(c);
  }
  t.after(async () => {
    await rm(gate, { force: true });
    for (const c of clients) await c.stop();
  });
  const running = clients[0].begin("fetchRepository", {
    remote: "origin",
    prune: false,
  });
  const cancelled = assert.rejects(
    running.result,
    (e) => e.code === "CANCELLED",
  );
  for (let n = 0; n < 500; n++) {
    try {
      await readFile(started);
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 10));
  }
  await assert.rejects(
    clients[1].call("runOperation", {
      operation: {
        kind: "createBranch",
        name: "must-not-be-created",
        startOid: f.first,
        expectedHeadOid: f.first,
        switchAfter: false,
      },
    }),
    (e) => e.code === "BUSY",
  );
  assert.equal(
    await git(f.repo, ["branch", "--list", "must-not-be-created"]),
    "",
  );
  clients[0].cancel(running.requestId);
  await cancelled;
  await rm(gate, { force: true });
  const result = (
    await clients[1].call("runOperation", {
      operation: {
        kind: "createBranch",
        name: "after-cancel",
        startOid: f.first,
        expectedHeadOid: f.first,
        switchAfter: false,
      },
    })
  ).chunks[0].data.result;
  assert.equal(result.outcome, "done");
});

test("M5 switch preserves staged and unstaged changes to an unchanged tracked path", async (t) => {
  const f = await fixture(t, "tracked-dirt");
  const current = await commit(f.repo, "common.txt", "base\n");
  await git(f.repo, ["switch", "-qc", "target"]);
  const target = await commit(f.repo, "a.txt", "target\n");
  await git(f.repo, ["switch", "-q", "main"]);
  await writeFile(join(f.repo, "common.txt"), "staged\n");
  await git(f.repo, ["add", "common.txt"]);
  await writeFile(join(f.repo, "common.txt"), "unstaged\n");
  const op = {
    kind: "switch",
    target: { refName: "refs/heads/target" },
    expectedOid: target,
    expectedHeadOid: current,
  };
  assert.equal((await f.call("checkOperation", op)).preservedDirtyCount, 1);
  assert.equal((await f.call("runOperation", op)).outcome, "done");
  assert.equal(
    await readFile(join(f.repo, "common.txt"), "utf8"),
    "unstaged\n",
  );
  assert.equal(await git(f.repo, ["show", ":common.txt"]), "staged");
});

test("M7 pushRepository pushes ahead branch, publishes with setUpstream, and refuses diverged or stale non-ff remote", async (t) => {
  const base = join(root, "m7-push");
  const bareRemote = join(base, "origin.git");
  const repo = join(base, "local");
  const peer = join(base, "peer");
  await mkdir(base, { recursive: true });
  await git(base, ["init", "-q", "--bare", "-b", "main", bareRemote]);
  await git(base, ["clone", "-q", bareRemote, repo]);
  await commit(repo, "a.txt", "one\n");
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  await git(base, ["clone", "-q", bareRemote, peer]);

  const aheadTip = await commit(repo, "a.txt", "two\n");
  const client = new PagesDaemonClient(process.env.COMMITSCOPE_DAEMON_PATH, {
    cwd: repo,
    env: createDaemonEnvironment(join(base, "data"), {
      HOME: process.env.COMMITSCOPE_PAGES_HOME,
      XDG_CONFIG_HOME: join(process.env.COMMITSCOPE_PAGES_HOME, ".config"),
    }),
  });
  await client.start();
  client.session = projectSession(await client.open(repo));
  t.after(() => client.stop());

  const pushed = (await client.call("pushRepository", {
    refName: "refs/heads/main",
    expectedOid: aheadTip,
    remote: null,
    setUpstream: false,
  })).chunks[0].data.result;
  assert.equal(pushed.outcome, "done");
  assert.equal(pushed.setUpstream, false);
  assert.equal(await git(bareRemote, ["rev-parse", "refs/heads/main"]), aheadTip);

  // Branch without upstream: setUpstream publishes it and writes tracking config.
  await git(repo, ["switch", "-qc", "publish-me"]);
  const pubTip = await commit(repo, "pub.txt", "publish\n");
  client.session = projectSession(await client.refresh(client.session));
  const published = (await client.call("pushRepository", {
    refName: "refs/heads/publish-me",
    expectedOid: pubTip,
    remote: "origin",
    setUpstream: true,
  })).chunks[0].data.result;
  assert.equal(published.outcome, "done");
  assert.equal(published.setUpstream, true);
  assert.equal(await git(bareRemote, ["rev-parse", "refs/heads/publish-me"]), pubTip);
  assert.equal(await git(repo, ["config", "--get", "branch.publish-me.remote"]), "origin");
  assert.equal(await git(repo, ["config", "--get", "branch.publish-me.merge"]), "refs/heads/publish-me");
  client.session = projectSession(await client.refresh(client.session));
  const syncAfterPublish = (await client.call("getBranchSync", { refNames: ["refs/heads/publish-me"] })).chunks[0].data.result;
  assert.equal(syncAfterPublish.branches[0].state, "upToDate");

  // Remote advances in peer while local main moves independently -> rejected safely without --force.
  await git(peer, ["pull", "-q"]);
  const peerTip = await commit(peer, "peer.txt", "peer\n");
  await git(peer, ["push", "-q", "origin", "main"]);

  await git(repo, ["switch", "-q", "main"]);
  const localDivTip = await commit(repo, "local.txt", "local\n");
  client.session = projectSession(await client.refresh(client.session));
  const remoteSnapshot = await snapshotTree(bareRemote);
  const localSnapshot = await snapshotTree(repo);
  const rejectedUnfetched = (await client.call("pushRepository", {
    refName: "refs/heads/main",
    expectedOid: localDivTip,
    remote: null,
    setUpstream: false,
  })).chunks[0].data.result;
  assert.equal(rejectedUnfetched.outcome, "rejected");
  assert.ok(rejectedUnfetched.blockers.some(b => b.kind === "remoteRejected"));
  assert.deepEqual(await snapshotTree(bareRemote), remoteSnapshot);
  assert.deepEqual(await snapshotTree(repo), localSnapshot);

  // After fetch, local knows it diverged -> refused locally before touching remote.
  await git(repo, ["fetch", "-q", "origin"]);
  client.session = projectSession(await client.refresh(client.session));
  const rejectedDiverged = (await client.call("pushRepository", {
    refName: "refs/heads/main",
    expectedOid: localDivTip,
    remote: null,
    setUpstream: false,
  })).chunks[0].data.result;
  assert.equal(rejectedDiverged.outcome, "rejected");
  assert.ok(rejectedDiverged.blockers.some(b => b.kind === "diverged"));
  assert.equal(await git(bareRemote, ["rev-parse", "refs/heads/main"]), peerTip);
});

test("M7 fastForwardMerge and deleteBranch respect ancestor merge and worktree safety", async (t) => {
  const f = await fixture(t, "m7-merge-delete");
  const mainStart = await git(f.repo, ["rev-parse", "refs/heads/main"]);
  await git(f.repo, ["switch", "-qc", "feat"]);
  const featTip = await commit(f.repo, "feat.txt", "feat\n");

  // Fast-forward merge feat -> main without switching checkout first.
  const mergedNoSwitch = await f.call("runOperation", {
    kind: "fastForwardMerge",
    targetRef: "refs/heads/main",
    expectedTargetOid: mainStart,
    sourceRef: "refs/heads/feat",
    expectedSourceOid: featTip,
    switchToTarget: false,
  });
  assert.equal(mergedNoSwitch.outcome, "done");
  assert.equal(await git(f.repo, ["rev-parse", "refs/heads/main"]), featTip);
  assert.equal(await git(f.repo, ["symbolic-ref", "HEAD"]), "refs/heads/feat");

  // Advance feat again, merge into main WITH switchToTarget: true, then delete feat.
  const featTip2 = await commit(f.repo, "feat2.txt", "feat2\n");
  const mergedWithSwitch = await f.call("runOperation", {
    kind: "fastForwardMerge",
    targetRef: "refs/heads/main",
    expectedTargetOid: featTip,
    sourceRef: "refs/heads/feat",
    expectedSourceOid: featTip2,
    switchToTarget: true,
  });
  assert.equal(mergedWithSwitch.outcome, "done");
  assert.equal(mergedWithSwitch.headReference, "refs/heads/main");
  assert.equal(await git(f.repo, ["symbolic-ref", "HEAD"]), "refs/heads/main");
  assert.equal(await git(f.repo, ["rev-parse", "HEAD"]), featTip2);

  await git(f.repo, ["config", "branch.feat.description", "feature branch config"]);
  const deleted = await f.call("runOperation", {
    kind: "deleteBranch",
    refName: "refs/heads/feat",
    expectedOid: featTip2,
    baseRefName: "refs/heads/main",
  });
  assert.equal(deleted.outcome, "done");
  await assert.rejects(git(f.repo, ["show-ref", "--verify", "refs/heads/feat"]));
  await assert.rejects(git(f.repo, ["config", "--get", "branch.feat.description"]));

  // Patch-equivalent (non-ancestor) branch must be refused with notAncestorMerged.
  await git(f.repo, ["branch", "patch-only", mainStart]);
  await git(f.repo, ["switch", "-q", "patch-only"]);
  const patchTip = await commit(f.repo, "equiv.txt", "same\n");
  await git(f.repo, ["switch", "-q", "main"]);
  await commit(f.repo, "equiv.txt", "same\n");
  await rejected(f, {
    kind: "deleteBranch",
    refName: "refs/heads/patch-only",
    expectedOid: patchTip,
    baseRefName: "refs/heads/main",
  }, "notAncestorMerged");

  // Checked-out merged branch in a linked worktree is refused with checkedOutElsewhere.
  const wtDir = join(f.base, "linked-wt");
  await git(f.repo, ["worktree", "add", "-q", "-b", "checked-wt", wtDir, "main"]);
  const mainNow = await git(f.repo, ["rev-parse", "refs/heads/main"]);
  await rejected(f, {
    kind: "deleteBranch",
    refName: "refs/heads/checked-wt",
    expectedOid: mainNow,
    baseRefName: "refs/heads/main",
  }, "checkedOutElsewhere");
});

test("M7 workspaceStage, Unstage (with renames and unborn HEAD), Discard, draftCommitMessage, and Commit (# + hook)", async (t) => {
  const f = await fixture(t, "m7-workspace");
  const headOid = await git(f.repo, ["rev-parse", "HEAD"]);

  // Partial stage + discard unstaged keeps staged index content intact; untracked discard removes file.
  await writeFile(join(f.repo, "a.txt"), "staged version\n");
  const aHex = Buffer.from("a.txt").toString("hex");
  const stageRes = await f.call("runOperation", { kind: "workspaceStage", pathsHex: [aHex], all: false });
  assert.equal(stageRes.outcome, "done");
  await writeFile(join(f.repo, "a.txt"), "unstaged discard me\n");
  await writeFile(join(f.repo, "temp.untracked"), "remove me\n");
  const tempHex = Buffer.from("temp.untracked").toString("hex");

  await rejected(f, {
    kind: "workspaceDiscard",
    pathHex: aHex,
    untracked: false,
    expectedHeadOid: "0".repeat(40),
  }, "refChanged");

  const discardWork = await f.call("runOperation", {
    kind: "workspaceDiscard",
    pathHex: aHex,
    untracked: false,
    expectedHeadOid: headOid,
  });
  assert.equal(discardWork.outcome, "done");
  assert.equal(await readFile(join(f.repo, "a.txt"), "utf8"), "staged version\n");
  assert.equal(await git(f.repo, ["show", ":a.txt"]), "staged version");

  const discardUntracked = await f.call("runOperation", {
    kind: "workspaceDiscard",
    pathHex: tempHex,
    untracked: true,
    expectedHeadOid: headOid,
  });
  assert.equal(discardUntracked.outcome, "done");
  await assert.rejects(stat(join(f.repo, "temp.untracked")));

  // Traversal outside repo root must fail validation before touching disk.
  await assert.rejects(f.call("runOperation", {
    kind: "workspaceStage",
    pathsHex: [Buffer.from("../escape.txt").toString("hex")],
    all: false,
  }), e => e.code === "INVALID_REQUEST");

  // Rename unstage: both new and old paths unstage cleanly.
  await git(f.repo, ["mv", "a.txt", "b.txt"]);
  const unstageRename = await f.call("runOperation", {
    kind: "workspaceUnstage",
    pathsHex: [Buffer.from("b.txt").toString("hex"), aHex],
    all: false,
  });
  assert.equal(unstageRename.outcome, "done");
  assert.equal(await git(f.repo, ["diff", "--cached", "--name-only"]), "");

  // Re-stage all via all: true, verify draftCommitMessage deduplication and commit with '#' line preservation.
  await rename(join(f.repo, "b.txt"), join(f.repo, "a.txt"));
  await writeFile(join(f.repo, "a.txt"), "final committed\n");
  assert.equal((await f.call("runOperation", { kind: "workspaceStage", pathsHex: [], all: true })).outcome, "done");

  await writeFile(join(f.repo, ".git", "COMMIT_EDITMSG"), `${await git(f.repo, ["log", "-1", "--format=%B", "HEAD"])}\n# template\n`);
  assert.equal((await f.client.workspaceStatus()).draftCommitMessage ?? null, null, "identical COMMIT_EDITMSG is filtered");
  await writeFile(join(f.repo, ".git", "COMMIT_EDITMSG"), "feat: draft msg\n# Please enter the commit message\n");
  assert.equal((await f.client.workspaceStatus()).draftCommitMessage, "feat: draft msg");

  // Failing pre-commit hook surfaces GIT_ERROR without losing staged changes.
  const hookPath = join(f.repo, ".git", "hooks", "pre-commit");
  await writeFile(hookPath, "#!/bin/sh\necho 'pre-commit lint boom' >&2\nexit 1\n");
  await chmod(hookPath, 0o755);
  await assert.rejects(f.call("runOperation", {
    kind: "workspaceCommit",
    message: "feat: blocked by hook\n\n#99 preserved body comment",
    expectedHeadOid: headOid,
  }), e => e.code === "GIT_ERROR" && /pre-commit lint boom/u.test(e.message));
  assert.equal(await git(f.repo, ["diff", "--cached", "--name-only"]), "a.txt");
  await rm(hookPath);

  const committed = await f.call("runOperation", {
    kind: "workspaceCommit",
    message: "feat: gate commit\n\n#99 preserved body comment",
    expectedHeadOid: headOid,
  });
  assert.equal(committed.outcome, "done");
  assert.ok(committed.committedOid);
  assert.equal(await git(f.repo, ["rev-parse", "HEAD"]), committed.committedOid);
  assert.equal(await git(f.repo, ["log", "-1", "--format=%B", "HEAD"]), "feat: gate commit\n\n#99 preserved body comment");

  // Unborn HEAD repository supports workspaceStage & workspaceUnstage.
  const unbornDir = join(root, "m7-unborn", "local");
  const unbornData = join(root, "m7-unborn", "data");
  await mkdir(unbornDir, { recursive: true });
  await mkdir(unbornData, { recursive: true });
  await git(unbornDir, ["init", "-q", "-b", "main"]);
  await writeFile(join(unbornDir, "first.txt"), "hello\n");
  const unbornClient = new PagesDaemonClient(process.env.COMMITSCOPE_DAEMON_PATH, {
    cwd: unbornDir,
    env: createDaemonEnvironment(unbornData, {
      HOME: process.env.COMMITSCOPE_PAGES_HOME,
      XDG_CONFIG_HOME: join(process.env.COMMITSCOPE_PAGES_HOME, ".config"),
    }),
  });
  await unbornClient.start();
  unbornClient.session = projectSession(await unbornClient.open(unbornDir));
  t.after(() => unbornClient.stop());
  const firstHex = Buffer.from("first.txt").toString("hex");
  assert.equal((await unbornClient.call("runOperation", { operation: { kind: "workspaceStage", pathsHex: [firstHex], all: false } })).chunks[0].data.result.outcome, "done");
  assert.equal(await git(unbornDir, ["ls-files", "--stage", "first.txt"]).then(s => s.length > 0), true);
  assert.equal((await unbornClient.call("runOperation", { operation: { kind: "workspaceUnstage", pathsHex: [firstHex], all: false } })).chunks[0].data.result.outcome, "done");
  assert.equal(await git(unbornDir, ["ls-files", "--stage", "first.txt"]), "");
});

test("M8 previewMerge is zero-write across clean and conflicted branches and supports rebase/merge completeMerge", async t => {
  // 1. Clean diverged branch with distinct author metadata -> preview is zero-write and singleCommitRebase preserves author.
  const f1 = await fixture(t, "m8-clean-rebase");
  await writeFile(join(f1.repo, "local.txt"), "local work\n");
  await git(f1.repo, ["add", "--", "local.txt"]);
  await git(f1.repo, ["commit", "-qm", "feat: preserve author\n\nBody details preserved."], {
    env: {
      GIT_AUTHOR_NAME: "Special Author",
      GIT_AUTHOR_EMAIL: "special@example.test",
      GIT_AUTHOR_DATE: "1700001234 +0800",
      GIT_COMMITTER_NAME: "Default Committer",
      GIT_COMMITTER_EMAIL: "committer@example.test",
    },
  });
  const localOid = await git(f1.repo, ["rev-parse", "refs/heads/main"]);
  const upstreamOid = f1.second;

  const snapBeforeClean = await snapshotTree(f1.repo);
  const cleanPreview = (
    await f1.client.call("previewMerge", {
      targetRef: "refs/heads/main",
      expectedTargetOid: localOid,
      sourceRef: "refs/remotes/origin/main",
      expectedSourceOid: upstreamOid,
    })
  ).chunks[0].data.result;
  assert.deepEqual(await snapshotTree(f1.repo), snapBeforeClean, "clean previewMerge writes zero bytes to repo");
  assert.equal(cleanPreview.outcome, "clean");
  assert.equal(cleanPreview.canSingleCommitRebase, true);
  assert.equal(cleanPreview.singleCommitSummary, "feat: preserve author");

  const rebaseOp = {
    kind: "completeMerge",
    targetRef: "refs/heads/main",
    expectedTargetOid: localOid,
    sourceRef: "refs/remotes/origin/main",
    expectedSourceOid: upstreamOid,
    expectedHeadOid: localOid,
    mode: "singleCommitRebase",
    message: "feat: preserve author",
    resolvedFiles: [],
    switchToTarget: false,
  };
  assert.equal((await f1.call("checkOperation", rebaseOp)).allowed, true);
  const rebaseRun = await f1.call("runOperation", rebaseOp);
  assert.equal(rebaseRun.outcome, "done");
  assert.equal(await git(f1.repo, ["rev-parse", "HEAD^"]), upstreamOid);
  assert.equal(
    await git(f1.repo, ["show", "-s", "--format=%an|%ae|%ad|%B", "--date=raw", "HEAD"]),
    "Special Author|special@example.test|1700001234 +0800|feat: preserve author\n\nBody details preserved.",
  );
  assert.equal(await git(f1.repo, ["status", "--porcelain"]), "");

  // 2. Clean diverged mergeCommit matches an independent Git merge oracle and fails closed when tracked worktree is dirty.
  const f2 = await fixture(t, "m8-clean-merge-commit");
  const local2 = await commit(f2.repo, "local2.txt", "local 2\n");
  await writeFile(join(f2.repo, "local2.txt"), "dirty tracked edit\n");
  const blockedPreview = (
    await f2.client.call("previewMerge", {
      targetRef: "refs/heads/main",
      expectedTargetOid: local2,
      sourceRef: "refs/remotes/origin/main",
      expectedSourceOid: f2.second,
    })
  ).chunks[0].data.result;
  assert.equal(blockedPreview.outcome, "blocked");
  assert.equal(blockedPreview.blockers[0].kind, "dirty");

  await writeFile(join(f2.repo, "local2.txt"), "local 2\n");
  const oracle = join(f2.base, "oracle");
  await git(f2.base, ["clone", "-q", f2.repo, oracle]);
  await git(oracle, ["merge", "--no-ff", "-m", "Merge origin/main", f2.second], { env: identity });
  const mergeOp = {
    kind: "completeMerge",
    targetRef: "refs/heads/main",
    expectedTargetOid: local2,
    sourceRef: "refs/remotes/origin/main",
    expectedSourceOid: f2.second,
    expectedHeadOid: local2,
    mode: "mergeCommit",
    message: "Merge origin/main",
    resolvedFiles: [],
    switchToTarget: false,
  };
  assert.equal((await f2.call("runOperation", mergeOp)).outcome, "done");
  assert.equal(await git(f2.repo, ["rev-parse", "HEAD^{tree}"]), await git(oracle, ["rev-parse", "HEAD^{tree}"]));
  assert.equal(await git(f2.repo, ["rev-parse", "HEAD^1"]), local2);
  assert.equal(await git(f2.repo, ["rev-parse", "HEAD^2"]), f2.second);

  // 3. Conflicted content + add/add: preview zero-write, atomic commit, no MERGE_HEAD.
  const f3 = await fixture(t, "m8-conflicted");
  await writeFile(join(f3.remote, "shared.txt"), "top\nremote\nbottom\n");
  await writeFile(join(f3.remote, "both.txt"), "both remote\n");
  await git(f3.remote, ["add", "."]);
  await git(f3.remote, ["commit", "-qm", "remote conflict side"], { env: identity });
  const remoteConf = await git(f3.remote, ["rev-parse", "HEAD"]);
  await git(f3.repo, ["fetch", "-q"]);
  await writeFile(join(f3.repo, "shared.txt"), "top\nlocal\nbottom\n");
  await writeFile(join(f3.repo, "both.txt"), "both local\n");
  await git(f3.repo, ["add", "."]);
  await git(f3.repo, ["commit", "-qm", "local conflict side"], { env: identity });
  const localConf = await git(f3.repo, ["rev-parse", "HEAD"]);

  const snapBeforeConf = await snapshotTree(f3.repo);
  const confPreview = (
    await f3.client.call("previewMerge", {
      targetRef: "refs/heads/main",
      expectedTargetOid: localConf,
      sourceRef: "refs/remotes/origin/main",
      expectedSourceOid: remoteConf,
    })
  ).chunks[0].data.result;
  assert.deepEqual(await snapshotTree(f3.repo), snapBeforeConf, "conflicted previewMerge writes zero bytes to repo");
  assert.equal(confPreview.outcome, "conflicted");
  assert.deepEqual(confPreview.files.map(file => file.path.display), ["both.txt", "shared.txt"]);

  const confMergeOp = {
    kind: "completeMerge",
    targetRef: "refs/heads/main",
    expectedTargetOid: localConf,
    sourceRef: "refs/remotes/origin/main",
    expectedSourceOid: remoteConf,
    expectedHeadOid: localConf,
    mode: "mergeCommit",
    message: "Resolve both conflicts",
    resolvedFiles: [
      { pathHex: Buffer.from("both.txt").toString("hex"), mode: "100644", contents: "both local\nboth remote\n" },
      { pathHex: Buffer.from("shared.txt").toString("hex"), mode: "100644", contents: "top\nlocal\nremote\nbottom\n" },
    ],
    switchToTarget: false,
  };
  assert.equal((await f3.call("checkOperation", confMergeOp)).allowed, true);
  assert.equal((await f3.call("runOperation", confMergeOp)).outcome, "done");
  assert.equal(await git(f3.repo, ["status", "--porcelain"]), "");
  await assert.rejects(stat(join(f3.repo, ".git/MERGE_HEAD")));
  assert.equal(await readFile(join(f3.repo, "shared.txt"), "utf8"), "top\nlocal\nremote\nbottom\n");
  assert.equal(await readFile(join(f3.repo, "both.txt"), "utf8"), "both local\nboth remote\n");

  // 4. Unsupported conflict kinds: structuralConflict, binaryOrNonUtf8, and crissCross.
  const f4 = await fixture(t, "m8-unsupported");
  await git(f4.repo, ["checkout", "-qb", "struct-a", f4.first]);
  await git(f4.repo, ["rm", "-q", "a.txt"]);
  await git(f4.repo, ["commit", "-qm", "delete a.txt"], { env: identity });
  const delOid = await git(f4.repo, ["rev-parse", "refs/heads/struct-a"]);
  const structRes = (
    await f4.client.call("previewMerge", {
      targetRef: "refs/heads/struct-a",
      expectedTargetOid: delOid,
      sourceRef: "refs/remotes/origin/main",
      expectedSourceOid: f4.second,
    })
  ).chunks[0].data.result;
  assert.equal(structRes.outcome, "unsupported");
  assert.equal(structRes.reason, "structuralConflict");

  await git(f4.repo, ["checkout", "-qb", "bin-a", f4.first]);
  await writeFile(join(f4.repo, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  await git(f4.repo, ["add", "--", "bin.dat"]);
  await git(f4.repo, ["commit", "-qm", "bin a"], { env: identity });
  const binAOid = await git(f4.repo, ["rev-parse", "refs/heads/bin-a"]);
  await git(f4.repo, ["checkout", "-qb", "bin-b", f4.first]);
  await writeFile(join(f4.repo, "bin.dat"), Buffer.from([0x00, 0x03, 0x04, 0xff]));
  await git(f4.repo, ["add", "--", "bin.dat"]);
  await git(f4.repo, ["commit", "-qm", "bin b"], { env: identity });
  const binBOid = await git(f4.repo, ["rev-parse", "refs/heads/bin-b"]);
  const binRes = (
    await f4.client.call("previewMerge", {
      targetRef: "refs/heads/bin-a",
      expectedTargetOid: binAOid,
      sourceRef: "refs/heads/bin-b",
      expectedSourceOid: binBOid,
    })
  ).chunks[0].data.result;
  assert.equal(binRes.outcome, "unsupported");
  assert.equal(binRes.reason, "binaryOrNonUtf8");

  // Criss-cross two common ancestors: b1 and b2 fork from base, then c1 merges both parents and c2 swaps merge parents.
  await git(f4.repo, ["checkout", "-qb", "cc-1", f4.first]);
  await commit(f4.repo, "cc1.txt", "1\n");
  const ccB1 = await git(f4.repo, ["rev-parse", "HEAD"]);
  await git(f4.repo, ["checkout", "-qb", "cc-2", f4.first]);
  await commit(f4.repo, "cc2.txt", "2\n");
  const ccB2 = await git(f4.repo, ["rev-parse", "HEAD"]);
  await git(f4.repo, ["checkout", "-q", "cc-1"]);
  await git(f4.repo, ["merge", "-q", "--no-ff", "-m", "m1", ccB2], { env: identity });
  const ccTip1 = await git(f4.repo, ["rev-parse", "HEAD"]);
  await git(f4.repo, ["checkout", "-q", "cc-2"]);
  await git(f4.repo, ["merge", "-q", "--no-ff", "-m", "m2", ccB1], { env: identity });
  const ccTip2 = await git(f4.repo, ["rev-parse", "HEAD"]);
  const ccRes = (
    await f4.client.call("previewMerge", {
      targetRef: "refs/heads/cc-1",
      expectedTargetOid: ccTip1,
      sourceRef: "refs/heads/cc-2",
      expectedSourceOid: ccTip2,
    })
  ).chunks[0].data.result;
  assert.equal(ccRes.outcome, "unsupported");
  assert.equal(ccRes.reason, "crissCross");
});
