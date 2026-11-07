import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { graphAboveLanes, graphPaths, graphWidth, graphWidthForMaxLane, hiddenThroughPaths, laneX, lanesInMask, maxGraphLane, MAX_VISIBLE_LANES } = await import(pathToFileURL(
  join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "graph.mjs")));

const geometry = { rowHeight: 60, mid: 22, laneGap: 9, x0: 7 };

test("history graph paths preserve lane positions and clip hidden endpoints without renumbering", () => {
  const paths = graphPaths({
    lane: 7, color: 1, parents: ["a"], boundary: false, above: 1, below: 0b11,
    hiddenLaneCount: 1, hiddenThroughRanges: [],
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

test("expanded graph keeps hidden-to-hidden edges in their original lanes and sizes to the furthest lane", () => {
  const graph = {
    lane: 7, color: 1, parents: ["parent-10"], boundary: false, above: 0, below: 0,
    hiddenLaneCount: 0, hiddenThroughRanges: [{ startLane: 8, endLane: 9 }],
    segments: [{ kind: "outgoing", fromLane: 7, toLane: 10, color: 4 }],
  };
  assert.deepEqual(graphPaths(graph, geometry, 5), [], "compact lane limit clips a hidden-to-hidden edge");
  const expandedPath = graphPaths(graph, geometry)[0];
  assert.match(expandedPath.d, /^M70 22C70 39\.1 97 42\.9\d* 97 60$/,
    "expanded mode draws the hidden edge without renumbering either endpoint");
  assert.equal(expandedPath.color, 4);
  assert.deepEqual(hiddenThroughPaths(graph, geometry), [
    { color: 2, d: "M79 0V60" },
    { color: 3, d: "M88 0V60" },
  ]);
  assert.equal(maxGraphLane(graph), 10);
  assert.equal(graphWidthForMaxLane(geometry, maxGraphLane(graph)), 104);
});

test("expanded lane set supplies hidden date bridges as well as visible mask lanes", () => {
  const graph = {
    lane: 4, color: 4, parents: [], boundary: false, above: 0b100101, below: 0,
    hiddenLaneCount: 0, hiddenThroughRanges: [{ startLane: 6, endLane: 7 }],
    segments: [{ kind: "incoming", fromLane: 9, toLane: 4, color: 3 }],
  };
  const bridgeLanes = graphAboveLanes(graph);
  assert.deepEqual(bridgeLanes, [0, 2, 5, 6, 7, 9], "date bridge lanes include hidden incoming and straight-through lines");
  assert.equal(graphWidthForMaxLane(geometry, Math.max(...bridgeLanes)), 95,
    "expanded date bridge width reaches the furthest actual lane");
});
