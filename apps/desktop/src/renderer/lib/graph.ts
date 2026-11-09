import type { HistoryCommit, HistoryGraph, HistoryGraphSegment } from "../../../../../packages/protocol/src/generated/server-message.js";

export const MAX_VISIBLE_LANES = 6;
export const MIN_GRAPH_LANES = 4;
export const MAX_GRAPH_LANES = 12;
export const OVERFLOW_WIDTH = 48;

export interface GraphGeometry { rowHeight: number; mid: number; laneGap: number; x0: number }

export function laneX(lane: number, geometry: GraphGeometry): number {
  return geometry.x0 + lane * geometry.laneGap;
}

export function graphWidth(geometry: GraphGeometry): number {
  return laneX(MAX_VISIBLE_LANES - 1, geometry) + geometry.x0 + OVERFLOW_WIDTH;
}

export function graphWidthForMaxLane(geometry: GraphGeometry, maxLane: number): number {
  return laneX(Math.max(0, maxLane), geometry) + geometry.x0;
}

export function lanesInMask(mask: number): number[] {
  const lanes: number[] = [];
  for (let lane = 0; lane < MAX_VISIBLE_LANES; lane += 1) {
    if ((mask & (1 << lane)) !== 0) lanes.push(lane);
  }
  return lanes;
}

export function graphAboveLanes(graph: HistoryGraph, laneLimit = Infinity): number[] {
  const lanes = new Set(lanesInMask(graph.above).filter(lane => lane <= laneLimit));
  for (const segment of graph.segments) {
    if (segment.kind === "incoming" && segment.fromLane >= MAX_VISIBLE_LANES && segment.fromLane <= laneLimit) lanes.add(segment.fromLane);
  }
  for (const range of graph.hiddenThroughRanges ?? []) {
    for (let lane = range.startLane; lane <= Math.min(range.endLane, laneLimit); lane += 1) lanes.add(lane);
  }
  return [...lanes].sort((a, b) => a - b);
}

export function maxGraphLane(graph: HistoryGraph): number {
  let maxLane = graph.lane;
  for (const segment of graph.segments) maxLane = Math.max(maxLane, segment.fromLane, segment.toLane);
  for (const range of graph.hiddenThroughRanges ?? []) maxLane = Math.max(maxLane, range.endLane);
  return maxLane;
}

export function hiddenThroughPaths(graph: HistoryGraph, geometry: GraphGeometry, laneLimit = Infinity): Array<{ color: number; d: string }> {
  const paths = new Map<number, string[]>();
  for (const range of graph.hiddenThroughRanges ?? []) {
    for (let lane = range.startLane; lane <= Math.min(range.endLane, laneLimit); lane += 1) {
      const color = lane % 6;
      const x = laneX(lane, geometry);
      const segments = paths.get(color) ?? [];
      segments.push(`M${x} 0V${geometry.rowHeight}`);
      paths.set(color, segments);
    }
  }
  return [...paths].map(([color, segments]) => ({ color, d: segments.join("") }));
}

/** Converts backend graph segments to paths for one rendered row. A lane limit keeps compact views to intersecting segments. */
export function graphPaths(graph: HistoryGraph, geometry: GraphGeometry, laneLimit?: number): Array<{ d: string; color: number; segment: HistoryGraphSegment }> {
  return graph.segments
    .filter(segment => laneLimit === undefined || segment.fromLane <= laneLimit || segment.toLane <= laneLimit)
    .map(segment => ({ d: segmentPath(segment, geometry), color: segment.color, segment }));
}

export function hiddenLaneCount(graph: HistoryGraph, visibleLanes: number): number {
  const ranges = graph.hiddenThroughRanges ?? [];
  const explicit = new Set([graph.lane, ...graph.segments.flatMap(segment => [segment.fromLane, segment.toLane])]);
  return ranges.reduce((count, range) => count + Math.max(0, range.endLane - Math.max(visibleLanes, range.startLane) + 1), 0)
    + [...explicit].filter(lane => lane >= visibleLanes && !ranges.some(range => lane >= range.startLane && lane <= range.endLane)).length;
}

export interface GraphRowHighlight {
  node: boolean;
  aboveLane?: number;
  hiddenThroughLane?: number;
  segments: Set<HistoryGraphSegment>;
}

/** Follow the drawn first-parent line inside the loaded window, including lane changes, never colour reuse. */
export function graphHighlight(commits: Pick<HistoryCommit, "oid" | "graph">[], oid: string | undefined): Map<HistoryGraph, GraphRowHighlight> {
  const result = new Map<HistoryGraph, GraphRowHighlight>();
  const index = commits.findIndex(commit => commit.oid === oid);
  if (index < 0) return result;
  const row = (graph: HistoryGraph) => {
    let value = result.get(graph);
    if (!value) { value = { node: false, segments: new Set() }; result.set(graph, value); }
    return value;
  };
  const firstParent = (graph: HistoryGraph) => graph.segments.find(segment => segment.kind === "outgoing");
  const incoming = (graph: HistoryGraph) => graph.segments.find(segment => segment.kind === "incoming" && segment.fromLane === graph.lane);
  const through = (graph: HistoryGraph, lane: number): boolean => {
    const segment = graph.segments.find(segment => segment.kind === "through" && segment.fromLane === lane && segment.toLane === lane);
    if (segment) { row(graph).segments.add(segment); row(graph).aboveLane = lane; return true; }
    if (graph.hiddenThroughRanges.some(range => range.startLane <= lane && range.endLane >= lane)) {
      row(graph).hiddenThroughLane = lane; row(graph).aboveLane = lane; return true;
    }
    return false;
  };
  const start = commits[index]!.graph;
  row(start).node = true;
  const startIncoming = incoming(start);
  if (startIncoming) { row(start).segments.add(startIncoming); row(start).aboveLane = startIncoming.fromLane; }
  let lane = startIncoming?.fromLane;
  for (let i = index - 1; i >= 0 && lane !== undefined; i--) {
    const graph = commits[i]!.graph;
    if (through(graph, lane)) continue;
    const outgoing = graph.segments.find(segment => segment.kind === "outgoing" && segment.toLane === lane);
    if (!outgoing) break;
    row(graph).segments.add(outgoing); row(graph).node = true;
    // A secondary parent starts another line at this fork; do not jump onto its first-parent trunk.
    if (outgoing !== firstParent(graph)) break;
    const previous = incoming(graph);
    if (previous) { row(graph).segments.add(previous); row(graph).aboveLane = previous.fromLane; }
    lane = previous?.fromLane;
  }
  const startOutgoing = firstParent(start);
  if (startOutgoing) row(start).segments.add(startOutgoing);
  lane = startOutgoing?.toLane;
  for (let i = index + 1; i < commits.length && lane !== undefined; i++) {
    const graph = commits[i]!.graph;
    if (through(graph, lane)) continue;
    const next = graph.segments.find(segment => segment.kind === "incoming" && segment.fromLane === lane);
    if (!next) break;
    row(graph).segments.add(next); row(graph).aboveLane = lane; row(graph).node = true;
    const outgoing = firstParent(graph);
    if (outgoing) row(graph).segments.add(outgoing);
    lane = outgoing?.toLane;
  }
  return result;
}

function segmentPath(segment: HistoryGraphSegment, geometry: GraphGeometry): string {
  const { rowHeight, mid } = geometry;
  const x1 = laneX(segment.fromLane, geometry);
  const x2 = laneX(segment.toLane, geometry);
  if (segment.kind === "through") {
    return x1 === x2 ? `M${x1} 0V${rowHeight}` : `M${x1} 0C${x1} ${mid * 0.45} ${x2} ${mid * 0.55} ${x2} ${rowHeight}`;
  }
  if (segment.kind === "incoming") {
    return x1 === x2 ? `M${x1} 0V${mid}` : `M${x1} 0C${x1} ${mid * 0.45} ${x2} ${mid * 0.5} ${x2} ${mid}`;
  }
  return x1 === x2 ? `M${x1} ${mid}V${rowHeight}`
    : `M${x1} ${mid}C${x1} ${mid + (rowHeight - mid) * 0.45} ${x2} ${mid + (rowHeight - mid) * 0.55} ${x2} ${rowHeight}`;
}
