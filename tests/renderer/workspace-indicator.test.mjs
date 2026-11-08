import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { workspaceBadge, workspaceBranchLabel } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "workspace-indicator.mjs")));

const repository = (extra = {}) => ({ isBare: false, headReference: "refs/heads/main", headOid: "9eb8940a".padEnd(40, "0"), ...extra });
const navigation = { worktrees: [{ id: "wt-main", isCurrent: true }, { id: "wt-agent", isCurrent: false }] };

test("the branch is written only when the browsing scope is not the working tree's branch", () => {
  assert.equal(workspaceBranchLabel("head", repository(), navigation), null);
  assert.equal(workspaceBranchLabel({ ref: "refs/heads/main" }, repository(), navigation), null);
  assert.equal(workspaceBranchLabel({ worktree: "wt-main" }, repository(), navigation), null);
  assert.equal(workspaceBranchLabel({ ref: "refs/heads/agent/daemon-queue" }, repository(), navigation), "main");
  assert.equal(workspaceBranchLabel("allBranches", repository(), navigation), "main");
  assert.equal(workspaceBranchLabel({ worktree: "wt-agent" }, repository(), navigation), "main");
  assert.equal(workspaceBranchLabel({ ref: "refs/heads/main" }, repository({ headReference: null }), navigation), "9eb8940a", "detached HEAD shows the short OID");
  assert.equal(workspaceBranchLabel("allBranches", repository({ isBare: true }), navigation), null);
});

test("only a complete read with no changes shows the clean dot", () => {
  const at = Date.UTC(2026, 10, 9, 6, 32, 5);
  assert.equal(workspaceBadge({ state: "clean", observedAtUnixMs: at }, repository(), null).kind, "ok");
  for (const indicator of [{ state: "loading" }, { state: "error", message: "failed" }, { state: "unavailable", reason: "not wired" },
    { state: "changes", files: 2000, conflicts: 0, complete: false, stale: false, observedAtUnixMs: at }]) {
    assert.notEqual(workspaceBadge(indicator, repository(), null).kind, "ok", indicator.state);
  }
});

test("badges say how many files, whether the count is a lower bound and whether it may be stale", () => {
  const at = Date.UTC(2026, 10, 9, 6, 32, 5);
  const changes = extra => workspaceBadge({ state: "changes", files: 5, conflicts: 0, complete: true, stale: false, observedAtUnixMs: at, ...extra }, repository(), "main");
  assert.deepEqual([changes().kind, changes().text], ["warn", "5"]);
  assert.match(changes().ariaLabel, /^工作区：main，有 5 个文件改动$/u);
  assert.deepEqual([changes({ complete: false, files: 2000 }).text], ["2000+"]);
  assert.match(changes({ complete: false, files: 2000 }).ariaLabel, /至少 2000 个文件改动/u);
  assert.equal(changes({ stale: true }).kind, "stale");
  assert.deepEqual([changes({ conflicts: 2 }).kind, changes({ conflicts: 2 }).text], ["bad", "冲突 2"]);
  assert.equal(workspaceBadge({ state: "error", message: "x" }, repository(), null).text, "?");
  const bare = workspaceBadge({ state: "bare" }, repository({ isBare: true }), null);
  assert.equal(bare.disabled, true);
});
