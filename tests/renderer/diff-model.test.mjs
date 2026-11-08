import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { parseUnifiedPatch, splitRows, changedSegments } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "diff-model.mjs")));

const patch = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -10,4 +10,5 @@ export function a() {",
  " const keep = 1;",
  "-const value = oldName();",
  "+const value = newName();",
  "+const extra = 2;",
  " return value;",
  "@@ -40,3 +41,2 @@",
  " start();",
  "-removed();",
  " end();",
  "\\ No newline at end of file",
  "",
].join("\n");

test("line numbers and counts follow the hunk headers", () => {
  const parsed = parseUnifiedPatch(patch);
  assert.equal(parsed.hunkCount, 2);
  assert.equal(parsed.additions, 2);
  assert.equal(parsed.deletions, 2);
  const numbered = parsed.lines.filter(line => line.kind !== "meta" && line.kind !== "hunk" && line.kind !== "notice")
    .map(line => `${line.kind}:${line.oldNumber ?? "-"}:${line.newNumber ?? "-"}:${line.text}`);
  assert.deepEqual(numbered, [
    "context:10:10:const keep = 1;",
    "del:11:-:const value = oldName();",
    "add:-:11:const value = newName();",
    "add:-:12:const extra = 2;",
    "context:12:13:return value;",
    "context:40:41:start();",
    "del:41:-:removed();",
    "context:42:42:end();",
  ]);
  assert.equal(parsed.lines.filter(line => line.kind === "meta").length, 4, "header lines before the first hunk stay as meta rows");
  assert.equal(parsed.lines.at(-1).kind, "notice");
});

test("side-by-side pairs removed lines with the lines that replaced them and pads the shorter side", () => {
  const rows = splitRows(parseUnifiedPatch(patch)).filter(row => row.kind === "pair")
    .map(row => `${row.left.kind}${row.left.number ?? ""}|${row.right.kind}${row.right.number ?? ""}`);
  assert.deepEqual(rows, [
    "context10|context10",
    "del11|add11",
    "empty|add12",
    "context12|context13",
    "context40|context41",
    "del41|empty",
    "context42|context42",
  ]);
});

test("both layouts come from the same parse, so every changed line appears exactly once", () => {
  const parsed = parseUnifiedPatch(patch);
  const pairs = splitRows(parsed).filter(row => row.kind === "pair");
  assert.equal(pairs.filter(row => row.left.kind === "del").length, parsed.deletions);
  assert.equal(pairs.filter(row => row.right.kind === "add").length, parsed.additions);
  assert.equal(splitRows(parsed).filter(row => row.kind === "hunk").length, parsed.hunkCount);
});

test("only the differing middle of a replaced line is marked", () => {
  const [before, after] = changedSegments("const value = oldName();", "const value = newName();");
  assert.deepEqual(before, [{ text: "const value = ", changed: false }, { text: "old", changed: true }, { text: "Name();", changed: false }]);
  assert.deepEqual(after, [{ text: "const value = ", changed: false }, { text: "new", changed: true }, { text: "Name();", changed: false }]);
  assert.equal(changedSegments("alpha", "zzzzz"), null, "lines with nothing in common are not marked piecemeal");
  const [cjkBefore, cjkAfter] = changedSegments("显示 😀 旧值", "显示 😀 新值");
  assert.equal(cjkBefore.find(segment => segment.changed).text, "旧", "characters outside the BMP are not split");
  assert.equal(cjkAfter.find(segment => segment.changed).text, "新");
});
