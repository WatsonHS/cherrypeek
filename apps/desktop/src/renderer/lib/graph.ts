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

export function lanesInMask(mask: number): number[] {
  const lanes: number[] = [];
  for (let lane = 0; lane < MAX_VISIBLE_LANES; lane += 1) {
    if ((mask & (1 << lane)) !== 0) lanes.push(lane);
  }
  return lanes;
}

/** Converts backend graph segments to paths for one rendered row. Hidden endpoints stay outside the SVG's six-lane clip. */
export function graphPaths(graph: HistoryGraph, geometry: GraphGeometry): Array<{ d: string; color: number }> {
  return graph.segments.map(segment => ({ d: segmentPath(segment, geometry), color: segment.color }));
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
