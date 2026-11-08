import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const buildDir = process.env.COMMITSCOPE_RENDERER_BUILD_DIR;
if (!buildDir) throw new Error("COMMITSCOPE_RENDERER_BUILD_DIR is required.");
const { historyPrefetchDistance } = await import(resolve(buildDir, "history-prefetch.mjs"));

test("history prefetch starts at one viewport and expands with scroll speed up to eight", () => {
  assert.equal(historyPrefetchDistance(600, 0), 600);
  assert.ok(historyPrefetchDistance(600, 4_000) > historyPrefetchDistance(600, 500));
  assert.equal(historyPrefetchDistance(600, 24_000), 4_800);
});
