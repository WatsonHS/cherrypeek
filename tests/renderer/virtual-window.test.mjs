import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { virtualRange, itemOffset } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "virtual-window.mjs")));

test("virtual range includes only visible loaded items and bounded overscan", () => {
  const items = Array.from({ length: 2_000 }, (_, index) => ({ key: String(index), height: 60 }));
  const range = virtualRange(items, 600, 300, 12);
  assert.equal(range.start, 0);
  assert.equal(range.end, 27);
  assert.equal(range.top, 0);
  assert.equal(range.bottom, 2_000 * 60 - 27 * 60);
  assert.equal(range.total, 2_000 * 60);
  assert.ok(range.end - range.start <= 300 / 60 + 24 + 1);
});

test("virtual range binary-searches mixed commit and divider heights", () => {
  const items = [
    { key: "day-1", height: 34 },
    { key: "a", height: 60 },
    { key: "b", height: 60 },
    { key: "day-2", height: 34 },
    { key: "c", height: 60 },
  ];
  const range = virtualRange(items, 94, 60, 0);
  assert.equal(range.start, 2);
  assert.equal(range.end, 3);
  assert.equal(range.top, 94);
  assert.equal(range.bottom, 94);
  assert.equal(range.total, 248);
  assert.equal(itemOffset(items, "c"), 188);
});

test("empty, before-start, and after-end ranges remain finite", () => {
  assert.deepEqual(virtualRange([], 0, 500), { start: 0, end: 0, top: 0, bottom: 0, total: 0 });
  const items = [{ key: "a", height: 60 }, { key: "b", height: 60 }];
  const before = virtualRange(items, -100, 20, 0);
  assert.equal(before.start, 0);
  assert.equal(before.end, 1);
  assert.equal(before.total, 120);
  const after = virtualRange(items, 1000, 20, 0);
  assert.equal(after.start, 1);
  assert.equal(after.end, 2);
  assert.equal(after.bottom, 0);
});
