import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
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
async function fixture(t, label, sha256 = false) {
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
