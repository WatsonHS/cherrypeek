import type { CommitSummary } from "../../../../../packages/protocol/src/generated/server-message.js";

/*
 * TEMPORARY renderer-side lane layout for the loaded first page only.
 * ARCHITECTURE assigns graph layout to Rust (P2-01: lanes, edges and cross-page
 * checkpoints). Replace this module once the core returns lane data.
 */

export const MAX_VISIBLE_LANES = 6;

export interface GraphPath { d: string; lane: number }
export interface GraphRow {
  lane: number;
  isMerge: boolean;
  paths: GraphPath[];
  /** Lanes still active below this row, used to draw through group headers. */
  activeBelow: number[];
}
export interface GraphLayout { rows: Map<string, GraphRow>; laneCount: number }
export interface GraphGeometry { rowHeight: number; mid: number; laneGap: number; x0: number }

export function laneX(lane: number, geometry: GraphGeometry): number {
  return geometry.x0 + lane * geometry.laneGap;
}

export function layoutGraph(commits: CommitSummary[], geometry: GraphGeometry): GraphLayout {
  const { rowHeight: h, mid } = geometry;
  const x = (lane: number) => laneX(lane, geometry);
  const rows = new Map<string, GraphRow>();
  let lanes: (string | null)[] = [];
  let laneCount = 0;

  for (const commit of commits) {
    const before = lanes;
    const incoming = before.flatMap((oid, index) => oid === commit.oid ? [index] : []);
    let lane = incoming[0] ?? before.indexOf(null);
    if (lane === -1) lane = before.length;

    const after = before.slice();
    for (const index of incoming) after[index] = null;
    const downs: number[] = [];
    const [firstParent, ...otherParents] = commit.parents;
    if (firstParent) {
      const existing = after.indexOf(firstParent);
      if (existing !== -1) downs.push(existing);
      else { after[lane] = firstParent; downs.push(lane); }
    }
    for (const parent of otherParents) {
      let target = after.indexOf(parent);
      if (target === -1) {
        target = after.findIndex((oid, index) => oid === null && index !== lane);
        if (target === -1) target = Math.max(after.length, lane + 1);
        after[target] = parent;
      }
      downs.push(target);
    }
    while (after.length && after[after.length - 1] === null) after.pop();

    const paths: GraphPath[] = [];
    before.forEach((oid, index) => {
      if (oid !== null && oid !== commit.oid && after[index] === oid) paths.push({ d: `M${x(index)} 0V${h}`, lane: index });
    });
    for (const index of incoming) {
      paths.push(index === lane
        ? { d: `M${x(lane)} 0V${mid}`, lane }
        : { d: `M${x(index)} 0C${x(index)} ${mid * 0.55} ${x(lane)} ${mid * 0.5} ${x(lane)} ${mid}`, lane: index });
    }
    downs.forEach((target, order) => {
      paths.push(target === lane
        ? { d: `M${x(lane)} ${mid}V${h}`, lane }
        : { d: `M${x(lane)} ${mid}C${x(lane)} ${mid + (h - mid) * 0.6} ${x(target)} ${mid + (h - mid) * 0.5} ${x(target)} ${h}`, lane: order === 0 ? lane : target });
    });

    lanes = after;
    laneCount = Math.max(laneCount, lane + 1, after.length);
    rows.set(commit.oid, {
      lane,
      isMerge: commit.parents.length > 1,
      paths,
      activeBelow: after.flatMap((oid, index) => oid === null ? [] : [index]),
    });
  }
  return { rows, laneCount };
}
