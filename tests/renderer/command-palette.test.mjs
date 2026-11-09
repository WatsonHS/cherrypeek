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
