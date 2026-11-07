import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { graphPaths, graphWidth, laneX, lanesInMask, MAX_VISIBLE_LANES } = await import(pathToFileURL(
  join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "graph.mjs")));

const geometry = { rowHeight: 60, mid: 22, laneGap: 9, x0: 7 };

test("history graph paths preserve lane positions and clip hidden endpoints without renumbering", () => {
  const paths = graphPaths({
    lane: 7, color: 1, parents: ["a"], boundary: false, above: 1, below: 0b11,
    hiddenLaneCount: 1,
    segments: [
      { kind: "through", fromLane: 0, toLane: 0, color: 0 },
      { kind: "outgoing", fromLane: 7, toLane: 1, color: 1 },
    ],
  }, geometry);
  assert.equal(paths.length, 2);
  assert.equal(paths[0].d, "M7 0V60");
  assert.match(paths[1].d, /^M70 22C70 39\.1 16 42\.9\d* 16 60$/);
  assert.deepEqual(paths.map(path => path.color), [0, 1]);
  assert.equal(laneX(7, geometry), 70, "hidden lane keeps its true slot, rather than becoming visible lane 5");
  assert.ok(graphWidth(geometry) > laneX(MAX_VISIBLE_LANES - 1, geometry));
});

test("six-bit masks map only visible lane slots and do not compact gaps", () => {
  assert.deepEqual(lanesInMask(0b100101), [0, 2, 5]);
  assert.deepEqual(lanesInMask(0), []);
  assert.equal(MAX_VISIBLE_LANES, 6);
});
