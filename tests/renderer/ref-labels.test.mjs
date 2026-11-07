import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { refLabels, labelTitle } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "ref-labels.mjs")));

const oid = "a".repeat(40);
const ref = (kind, name, extra = {}) => ({ kind, name, oid, peeledOid: null, symbolicTarget: null, ...extra });
const summary = labels => labels.map(label => `${label.kind}:${label.text}${label.remotes.length ? `+${label.remotes.join(",")}` : ""}`);

test("the window's branch leads as a HEAD label that shows the full branch name", () => {
  const labels = refLabels({
    refs: [ref("tag", "refs/tags/v1.4.0"), ref("remoteBranch", "refs/remotes/origin/main"), ref("localBranch", "refs/heads/main")],
    headReference: "refs/heads/main", isHeadCommit: true,
  });
  assert.deepEqual(summary(labels), ["head:main", "tag:v1.4.0", "remote:origin/main"]);
  assert.equal(labels[0].description, "本窗口 HEAD：main");
});

test("a detached HEAD is labelled HEAD, and a missing branch ref still yields the HEAD label", () => {
  assert.deepEqual(summary(refLabels({ refs: [ref("localBranch", "refs/heads/topic")], headReference: null, isHeadCommit: true })),
    ["head:HEAD", "branch:topic"]);
  assert.equal(refLabels({ refs: [], headReference: null, isHeadCommit: true })[0].description, "本窗口 HEAD（detached）");
  // Refs can be truncated; the HEAD label comes from the repository facts, not from the ref list.
  assert.deepEqual(summary(refLabels({ refs: [], headReference: "refs/heads/main", isHeadCommit: true })), ["head:main"]);
});

test("no HEAD label when the window's HEAD is elsewhere", () => {
  assert.deepEqual(summary(refLabels({ refs: [ref("localBranch", "refs/heads/topic")], headReference: "refs/heads/main", isHeadCommit: false })),
    ["branch:topic"]);
});

test("same-name remotes and origin/HEAD fold into the local label only when asked", () => {
  const refs = [
    ref("localBranch", "refs/heads/main"),
    ref("remoteBranch", "refs/remotes/origin/HEAD", { symbolicTarget: "refs/remotes/origin/main" }),
    ref("remoteBranch", "refs/remotes/origin/main"),
    ref("remoteBranch", "refs/remotes/upstream/main"),
    ref("remoteBranch", "refs/remotes/origin/feature/x"),
  ];
  const folded = refLabels({ refs, headReference: "refs/heads/main", isHeadCommit: true, foldRemotes: true });
  assert.deepEqual(summary(folded), ["head:main+origin/main,upstream/main,origin/HEAD", "remote:origin/feature/x"]);
  assert.equal(labelTitle(folded[0]), "本窗口 HEAD：main\norigin/main、upstream/main、origin/HEAD 也指向这里");
  assert.deepEqual(summary(refLabels({ refs, headReference: "refs/heads/main", isHeadCommit: true })),
    ["head:main", "remote:origin/HEAD", "remote:origin/main", "remote:upstream/main", "remote:origin/feature/x"]);
});

test("origin/HEAD follows its remote branch when no local branch is here", () => {
  const labels = refLabels({
    refs: [ref("remoteBranch", "refs/remotes/origin/HEAD", { symbolicTarget: "refs/remotes/origin/main" }), ref("remoteBranch", "refs/remotes/origin/main")],
    headReference: "refs/heads/main", isHeadCommit: false, foldRemotes: true,
  });
  assert.deepEqual(summary(labels), ["remote:origin/main+origin/HEAD"]);
});

test("other worktrees mark the branch they check out, or appear by folder name when detached", () => {
  const labels = refLabels({
    refs: [ref("localBranch", "refs/heads/review"), ref("localBranch", "refs/heads/topic"), ref("tag", "refs/tags/v1")],
    headReference: "refs/heads/main", isHeadCommit: false,
    otherWorktrees: [
      { path: "/work/review-tree", isMain: false, headReference: "refs/heads/review" },
      { path: "/work/hotfix/", isMain: false, headReference: null },
      { path: "/work/main-tree", isMain: true, headReference: "refs/heads/elsewhere" },
    ],
  });
  assert.deepEqual(summary(labels), ["worktree:review", "branch:topic", "tag:v1", "worktree:hotfix", "worktree:elsewhere"]);
  assert.match(labels[0].description, /已在工作区 review-tree 检出（\/work\/review-tree）/);
  assert.match(labels[3].description, /工作区 hotfix 的 HEAD（detached）指向这里/);
  assert.match(labels[4].description, /^主工作区 main-tree 的 HEAD（elsewhere）/);
});
