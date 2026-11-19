import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

const mergeMod = await import(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "three-way-merge.mjs"));

const HEX = Buffer.from("shared.txt").toString("hex");

function makeFile({ baseText, oursText, theirsText, leftHunks, rightHunks, mode = "100644" }) {
  return {
    path: { display: "shared.txt", rawHex: HEX, textLossy: false },
    mode,
    baseText,
    oursText,
    theirsText,
    ...(leftHunks ? { leftHunks } : {}),
    ...(rightHunks ? { rightHunks } : {}),
  };
}

test("non-overlapping left and right hunks auto-merge with common lines aligned", () => {
  const model = mergeMod.buildThreeWayMergeModel(makeFile({
    baseText: "1\n2\n3\n4\n5\n",
    oursText: "1-left\n2\n3\n4\n5\n",
    theirsText: "1\n2\n3\n4-right\n5\n",
  }));

  assert.equal(mergeMod.countUnresolvedConflicts(model), 0);
  assert.deepEqual(model.chunks.map(c => c.kind), ["auto-left", "common", "auto-right", "common"]);
  assert.equal(mergeMod.serializeMergedText(model), "1-left\n2\n3\n4-right\n5\n");
});

test("identical changes on both sides coalesce into auto-both without conflict", () => {
  const model = mergeMod.buildThreeWayMergeModel(makeFile({
    baseText: "a\nb\nc\n",
    oursText: "a\nb-same\nc\n",
    theirsText: "a\nb-same\nc\n",
  }));

  assert.equal(mergeMod.countUnresolvedConflicts(model), 0);
  assert.deepEqual(model.chunks.map(c => c.kind), ["common", "auto-both", "common"]);
  assert.equal(mergeMod.serializeMergedText(model), "a\nb-same\nc\n");
});

test("adjacent line edits coalesce into one conflict chunk and bilateral arrows append sequentially", () => {
  const model0 = mergeMod.buildThreeWayMergeModel(makeFile({
    baseText: "h1\nbase-1\nbase-2\nfooter\n",
    oursText: "h1\nleft-1\nbase-2\nfooter\n",
    theirsText: "h1\nbase-1\nright-2\nfooter\n",
  }));

  assert.equal(mergeMod.countUnresolvedConflicts(model0), 1);
  const conflict = model0.chunks.find(c => c.kind === "conflict");
  assert.ok(conflict);
  assert.deepEqual(conflict.leftLines, ["left-1", "base-2"]);
  assert.deepEqual(conflict.rightLines, ["base-1", "right-2"]);

  // Click » (left) then « (right): sequential append left -> right.
  const model1 = mergeMod.acceptChunkSide(model0, conflict.id, "left");
  assert.equal(mergeMod.countUnresolvedConflicts(model1), 0);
  assert.equal(mergeMod.serializeMergedText(model1), "h1\nleft-1\nbase-2\nfooter\n");

  const model2 = mergeMod.acceptChunkSide(model1, conflict.id, "right");
  assert.equal(mergeMod.countUnresolvedConflicts(model2), 0);
  assert.equal(mergeMod.serializeMergedText(model2), "h1\nleft-1\nbase-2\nbase-1\nright-2\nfooter\n");

  // Reset restores unresolved state and baseLines.
  const reset = mergeMod.resetChunk(model2, conflict.id);
  assert.equal(mergeMod.countUnresolvedConflicts(reset), 1);
  assert.equal(mergeMod.serializeMergedText(reset), "h1\nbase-1\nbase-2\nfooter\n");

  // Reverse sequential order: click « (right) then » (left).
  const rFirst = mergeMod.acceptChunkSide(reset, conflict.id, "right");
  const lSecond = mergeMod.acceptChunkSide(rFirst, conflict.id, "left");
  assert.equal(mergeMod.serializeMergedText(lSecond), "h1\nbase-1\nright-2\nleft-1\nbase-2\nfooter\n");
});

test("ignoreChunkSide on both sides keeps baseLines and center edits update ranges cleanly", () => {
  const model0 = mergeMod.buildThreeWayMergeModel(makeFile({
    baseText: "top\nbase\nbottom\n",
    oursText: "top\nours\nbottom\n",
    theirsText: "top\ntheirs\nbottom\n",
  }));
  const conflictId = model0.chunks.find(c => c.kind === "conflict").id;

  const leftIgnored = mergeMod.ignoreChunkSide(model0, conflictId, "left");
  assert.equal(mergeMod.countUnresolvedConflicts(leftIgnored), 1, "ignoring only one side leaves conflict unresolved");

  const bothIgnored = mergeMod.ignoreChunkSide(leftIgnored, conflictId, "right");
  assert.equal(mergeMod.countUnresolvedConflicts(bothIgnored), 0);
  assert.equal(mergeMod.serializeMergedText(bothIgnored), "top\nbase\nbottom\n");

  // Manual edit including empty deletion collapses lines without losing common lines.
  const deleted = mergeMod.updateChunkCenterText(model0, conflictId, "");
  assert.equal(mergeMod.countUnresolvedConflicts(deleted), 0);
  assert.equal(mergeMod.serializeMergedText(deleted), "top\nbottom\n");

  const edited = mergeMod.updateChunkCenterText(model0, conflictId, "custom-1\ncustom-2");
  assert.equal(mergeMod.countUnresolvedConflicts(edited), 0);
  assert.equal(mergeMod.serializeMergedText(edited), "top\ncustom-1\ncustom-2\nbottom\n");
  assert.deepEqual(edited.chunks.map(c => c.centerRange), [
    { start: 0, end: 1 },
    { start: 1, end: 3 },
    { start: 3, end: 4 },
  ]);
});

test("CRLF line endings, no-trailing-newline, and add/add empty base round-trip faithfully", () => {
  const addAdd = mergeMod.buildThreeWayMergeModel(makeFile({
    baseText: "",
    oursText: "left-only",
    theirsText: "right-only",
    leftHunks: [{ baseStart: 0, baseCount: 0, sideStart: 0, sideCount: 1 }],
    rightHunks: [{ baseStart: 0, baseCount: 0, sideStart: 0, sideCount: 1 }],
  }));
  const cid = addAdd.chunks[0].id;
  const both = mergeMod.acceptChunkSide(mergeMod.acceptChunkSide(addAdd, cid, "left"), cid, "right");
  assert.equal(mergeMod.serializeMergedText(both), "left-only\nright-only");

  const crlf = mergeMod.buildThreeWayMergeModel(makeFile({
    baseText: "a\r\nb\r\nc\r\n",
    oursText: "a\r\nours\r\nc\r\n",
    theirsText: "a\r\ntheirs\r\nc\r\n",
  }));
  const crlfCid = crlf.chunks.find(c => c.kind === "conflict").id;
  const resolvedCrlf = mergeMod.acceptChunkSide(crlf, crlfCid, "right");
  assert.equal(mergeMod.serializeMergedText(resolvedCrlf), "a\r\ntheirs\r\nc\r\n");
});
