import type { HistoryGraph, HistoryGraphSegment } from "../../../../../packages/protocol/src/generated/server-message.js";

export const MAX_VISIBLE_LANES = 6;
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

export function graphAboveLanes(graph: HistoryGraph): number[] {
  const lanes = new Set(lanesInMask(graph.above));
  for (const segment of graph.segments) {
    if (segment.kind === "incoming" && segment.fromLane >= MAX_VISIBLE_LANES) lanes.add(segment.fromLane);
  }
  for (const range of graph.hiddenThroughRanges ?? []) {
    for (let lane = range.startLane; lane <= range.endLane; lane += 1) lanes.add(lane);
  }
  return [...lanes].sort((a, b) => a - b);
}

export function maxGraphLane(graph: HistoryGraph): number {
  let maxLane = graph.lane;
  for (const segment of graph.segments) maxLane = Math.max(maxLane, segment.fromLane, segment.toLane);
  for (const range of graph.hiddenThroughRanges ?? []) maxLane = Math.max(maxLane, range.endLane);
  return maxLane;
}

export function hiddenThroughPaths(graph: HistoryGraph, geometry: GraphGeometry): Array<{ color: number; d: string }> {
  const paths = new Map<number, string[]>();
  for (const range of graph.hiddenThroughRanges ?? []) {
    for (let lane = range.startLane; lane <= range.endLane; lane += 1) {
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
export function graphPaths(graph: HistoryGraph, geometry: GraphGeometry, laneLimit?: number): Array<{ d: string; color: number }> {
  return graph.segments
    .filter(segment => laneLimit === undefined || segment.fromLane <= laneLimit || segment.toLane <= laneLimit)
    .map(segment => ({ d: segmentPath(segment, geometry), color: segment.color }));
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
