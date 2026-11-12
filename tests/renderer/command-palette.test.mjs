import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { paletteItems } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "command-palette.mjs")));
const context = { refs: [{ name: "refs/heads/Feature/中文", kind: "localBranch" }, { name: "refs/tags/v1", kind: "tag" }],
  worktrees: [{ id: "tree", path: "/repos/test", headReference: "refs/heads/side", available: true, headOid: "a".repeat(40) },
    { id: "gone", path: "/gone", available: false, headOid: "b".repeat(40) }],
  repositoryReady: true, coreReady: true, filesAvailable: true, workspaceAvailable: true, selectedOid: "a".repeat(40), oidLength: 40 };

test("palette filters names case-insensitively and preserves exact ref/worktree identity", () => {
  assert.deepEqual(paletteItems("feature/中", context).items[0].action, { kind: "scope", scope: { ref: "refs/heads/Feature/中文" } });
  assert.equal(paletteItems("v1", context).items[0].group, "标签");
  assert.deepEqual(paletteItems("/repos/test", context).items[0].action.scope, { worktree: "tree" });
  assert.equal(paletteItems("gone", context).items.length, 0);
});
test("short hashes are normalized, respect object format, and never accept revision expressions", () => {
  assert.deepEqual(paletteItems(" ABCD ", context).items[0].action, { kind: "commit", oid: "abcd" });
  for (const value of ["abc", "HEAD~1", "a".repeat(41)]) assert.equal(paletteItems(value, context).items.some(item => item.group === "提交"), false);
  assert.equal(paletteItems("a".repeat(64), { ...context, oidLength: 64 }).items[0].group, "提交");
});
test("unavailable actions disappear, and a large ref list still leaves room for commands", () => {
  assert.deepEqual(paletteItems("", { ...context, repositoryReady: false }).items.map(item => item.id), ["openRepository"]);
  assert.equal(paletteItems("复制", { ...context, selectedOid: null }).items.length, 0);
  assert.equal(paletteItems("工作区", { ...context, workspaceAvailable: false }).items.some(item => item.id === "workspace"), false);
  const refs = Array.from({ length: 2000 }, (_, i) => ({ name: `refs/heads/branch-${i}`, kind: "localBranch" }));
  const result = paletteItems("", { ...context, refs });
  assert.ok(result.items.length < 100 && result.total > result.items.length);
  assert.ok(result.items.some(item => item.id === "openRepository"));
});
test("P5-05 copy and open commands appear only when they have something to act on", () => {
  const ids = extra => paletteItems("", { ...context, ...extra }).items.filter(item => item.group === "命令").map(item => item.id);
  assert.deepEqual(ids({}).filter(id => id.startsWith("open") && id !== "openRepository"), ["openFinder"]);
  assert.deepEqual(ids({ hasWorkingDirectory: true }).filter(id => id.startsWith("open") && id !== "openRepository"), ["openFinder", "openTerminal", "openEditor"]);
  assert.equal(ids({ selectedMessage: "fix: 标题\n\n正文" }).includes("copyMessage"), true);
  assert.equal(ids({ selectedMessage: "x", selectedOid: null }).includes("copyMessage"), false);
  assert.equal(ids({}).includes("copyBranch"), false);
  assert.equal(paletteItems("复制当前分支", { ...context, headReference: "refs/heads/Feature/中文" }).items[0].label, "复制当前分支名 Feature/中文");
});
test("P5-01 fetch commands are offered only while the core can run one", () => {
  const ids = extra => paletteItems("fetch", { ...context, ...extra }).items.map(item => item.id);
  assert.deepEqual(ids({}), []);
  assert.deepEqual(ids({ fetchAvailable: true }), ["fetch", "fetchPrune"]);
  assert.deepEqual(ids({ fetchAvailable: true, repositoryReady: false }), []);
});
test("the stats page command is offered with ⌘4 whenever a repository is open", () => {
  const stats = paletteItems("统计", context).items.find(item => item.id === "stats");
  assert.deepEqual([stats?.label, stats?.shortcut, stats?.action], ["切换到统计页", "⌘4", { kind: "command", command: "stats" }]);
  assert.equal(paletteItems("统计", context, "Ctrl+").items[0].shortcut, "Ctrl+4");
  assert.equal(paletteItems("统计", { ...context, repositoryReady: false }).items.length, 0);
  assert.equal(paletteItems("统计", { ...context, filesAvailable: false, workspaceAvailable: false }).items.length, 1);
});
