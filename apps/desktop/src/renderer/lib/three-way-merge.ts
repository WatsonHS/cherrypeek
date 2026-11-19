import type { MergeConflictFile, MergeDiffHunk } from "../../../../../packages/protocol/src/repository-session.js";

export type ThreeWayChunkKind = "common" | "auto-left" | "auto-right" | "auto-both" | "conflict";

export interface LineRange {
  start: number;
  end: number;
}

export interface ThreeWayChunk {
  id: string;
  kind: ThreeWayChunkKind;
  baseLines: string[];
  leftLines: string[];
  rightLines: string[];
  centerLines: string[];
  baseRange: LineRange;
  leftRange: LineRange;
  rightRange: LineRange;
  centerRange: LineRange;
  resolved: boolean;
  acceptedLeft: boolean;
  acceptedRight: boolean;
  ignoredLeft: boolean;
  ignoredRight: boolean;
  manuallyEdited: boolean;
}

export interface ThreeWayMergeModel {
  pathDisplay: string;
  pathHex: string;
  mode: string;
  eol: "\n" | "\r\n";
  trailingNewline: boolean;
  leftLines: string[];
  rightLines: string[];
  centerLines: string[];
  chunks: ThreeWayChunk[];
}

export function splitMergeText(text: string): {
  lines: string[];
  eol: "\n" | "\r\n";
  trailingNewline: boolean;
} {
  if (text.length === 0) {
    return { lines: [], eol: "\n", trailingNewline: false };
  }
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n");
  let normalized = text.replace(/\r\n/g, "\n");
  if (trailingNewline) {
    normalized = normalized.slice(0, -1);
  }
  return {
    lines: normalized.split("\n"),
    eol,
    trailingNewline,
  };
}

function linesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Fallback line-diff hunk computation matching Git `diff -U0` 0-based coordinates
 * when a caller in unit tests constructs a `MergeConflictFile` without precomputed hunks.
 */
export function computeDiffHunks(baseLines: readonly string[], sideLines: readonly string[]): MergeDiffHunk[] {
  const n = baseLines.length;
  const m = sideLines.length;
  // Fast common prefix / suffix trim so typical files use tiny DP tables.
  let prefix = 0;
  while (prefix < n && prefix < m && baseLines[prefix] === sideLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    n - suffix > prefix &&
    m - suffix > prefix &&
    baseLines[n - 1 - suffix] === sideLines[m - 1 - suffix]
  ) {
    suffix += 1;
  }

  const aLen = n - prefix - suffix;
  const bLen = m - prefix - suffix;
  if (aLen === 0 && bLen === 0) return [];
  if (aLen === 0 || bLen === 0) {
    return [{ baseStart: prefix, baseCount: aLen, sideStart: prefix, sideCount: bLen }];
  }

  // Fallback for very large diffs (> 2M cells) collapses changed middle to one hunk.
  if (aLen * bLen > 2_000_000) {
    return [{ baseStart: prefix, baseCount: aLen, sideStart: prefix, sideCount: bLen }];
  }

  const dp = Array.from({ length: aLen + 1 }, () => new Uint32Array(bLen + 1));
  for (let i = aLen - 1; i >= 0; i -= 1) {
    const aLine = baseLines[prefix + i]!;
    for (let j = bLen - 1; j >= 0; j -= 1) {
      if (aLine === sideLines[prefix + j]) {
        dp[i]![j] = 1 + dp[i + 1]![j + 1]!;
      } else {
        const down = dp[i + 1]![j]!;
        const right = dp[i]![j + 1]!;
        dp[i]![j] = down >= right ? down : right;
      }
    }
  }

  const ops: Array<{ type: "eq" | "del" | "ins"; baseIdx: number; sideIdx: number }> = [];
  let i = 0;
  let j = 0;
  while (i < aLen && j < bLen) {
    if (baseLines[prefix + i] === sideLines[prefix + j]) {
      ops.push({ type: "eq", baseIdx: prefix + i, sideIdx: prefix + j });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "del", baseIdx: prefix + i, sideIdx: prefix + j });
      i += 1;
    } else {
      ops.push({ type: "ins", baseIdx: prefix + i, sideIdx: prefix + j });
      j += 1;
    }
  }
  while (i < aLen) {
    ops.push({ type: "del", baseIdx: prefix + i, sideIdx: prefix + j });
    i += 1;
  }
  while (j < bLen) {
    ops.push({ type: "ins", baseIdx: prefix + i, sideIdx: prefix + j });
    j += 1;
  }

  const hunks: MergeDiffHunk[] = [];
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx]!.type === "eq") {
      idx += 1;
      continue;
    }
    const baseStart = ops[idx]!.baseIdx;
    const sideStart = ops[idx]!.sideIdx;
    let baseCount = 0;
    let sideCount = 0;
    while (idx < ops.length && ops[idx]!.type !== "eq") {
      if (ops[idx]!.type === "del") baseCount += 1;
      else sideCount += 1;
      idx += 1;
    }
    hunks.push({ baseStart, baseCount, sideStart, sideCount });
  }
  return hunks;
}

interface TaggedHunk {
  side: "left" | "right";
  hunk: MergeDiffHunk;
}

function recomputeCenterRanges(chunks: ThreeWayChunk[]): ThreeWayChunk[] {
  let centerCursor = 0;
  return chunks.map(chunk => {
    const start = centerCursor;
    const end = start + chunk.centerLines.length;
    centerCursor = end;
    return {
      ...chunk,
      centerRange: { start, end },
    };
  });
}

function finalizeModel(
  baseModel: Omit<ThreeWayMergeModel, "centerLines" | "chunks">,
  rawChunks: ThreeWayChunk[],
): ThreeWayMergeModel {
  const chunks = recomputeCenterRanges(rawChunks);
  const centerLines = chunks.flatMap(chunk => chunk.centerLines);
  return {
    ...baseModel,
    centerLines,
    chunks,
  };
}

export type ThreeWayMergeInput = Omit<MergeConflictFile, "leftHunks" | "rightHunks"> & {
  leftHunks?: MergeDiffHunk[];
  rightHunks?: MergeDiffHunk[];
};

export function buildThreeWayMergeModel(file: ThreeWayMergeInput): ThreeWayMergeModel {
  const baseSplit = splitMergeText(file.baseText);
  const oursSplit = splitMergeText(file.oursText);
  const theirsSplit = splitMergeText(file.theirsText);

  const eol: "\n" | "\r\n" = file.oursText.includes("\r\n")
    ? "\r\n"
    : file.theirsText.includes("\r\n")
      ? "\r\n"
      : baseSplit.eol;
  const trailingNewline = file.oursText.length > 0
    ? oursSplit.trailingNewline
    : file.theirsText.length > 0
      ? theirsSplit.trailingNewline
      : baseSplit.trailingNewline;

  const baseLines = baseSplit.lines;
  const leftAllLines = oursSplit.lines;
  const rightAllLines = theirsSplit.lines;

  const leftHunks = [...(file.leftHunks ?? computeDiffHunks(baseLines, leftAllLines))].sort(
    (a, b) => a.baseStart - b.baseStart || a.baseCount - b.baseCount,
  );
  const rightHunks = [...(file.rightHunks ?? computeDiffHunks(baseLines, rightAllLines))].sort(
    (a, b) => a.baseStart - b.baseStart || a.baseCount - b.baseCount,
  );

  const events: TaggedHunk[] = [
    ...leftHunks.map(hunk => ({ side: "left" as const, hunk })),
    ...rightHunks.map(hunk => ({ side: "right" as const, hunk })),
  ].sort((a, b) => {
    if (a.hunk.baseStart !== b.hunk.baseStart) return a.hunk.baseStart - b.hunk.baseStart;
    const aEnd = a.hunk.baseStart + a.hunk.baseCount;
    const bEnd = b.hunk.baseStart + b.hunk.baseCount;
    if (aEnd !== bEnd) return aEnd - bEnd;
    return a.side === b.side ? 0 : a.side === "left" ? -1 : 1;
  });

  // Coalesce intersecting or touching regions in base line coordinates (closed intervals).
  interface Region {
    baseStart: number;
    baseEnd: number;
    left: MergeDiffHunk[];
    right: MergeDiffHunk[];
  }
  const regions: Region[] = [];
  for (const ev of events) {
    const evStart = ev.hunk.baseStart;
    const evEnd = ev.hunk.baseStart + ev.hunk.baseCount;
    const last = regions[regions.length - 1];
    if (last && evStart <= last.baseEnd) {
      last.baseEnd = Math.max(last.baseEnd, evEnd);
      if (ev.side === "left") last.left.push(ev.hunk);
      else last.right.push(ev.hunk);
    } else {
      regions.push({
        baseStart: evStart,
        baseEnd: evEnd,
        left: ev.side === "left" ? [ev.hunk] : [],
        right: ev.side === "right" ? [ev.hunk] : [],
      });
    }
  }

  const chunks: ThreeWayChunk[] = [];
  let baseCursor = 0;
  let deltaLeft = 0;
  let deltaRight = 0;
  let nextId = 0;

  const pushCommon = (upToBase: number) => {
    if (upToBase <= baseCursor) return;
    const count = upToBase - baseCursor;
    const leftStart = baseCursor + deltaLeft;
    const rightStart = baseCursor + deltaRight;
    const commonBase = baseLines.slice(baseCursor, upToBase);
    const commonLeft = leftAllLines.slice(leftStart, leftStart + count);
    chunks.push({
      id: `chunk-${nextId++}`,
      kind: "common",
      baseLines: commonBase,
      leftLines: commonLeft,
      rightLines: rightAllLines.slice(rightStart, rightStart + count),
      centerLines: [...commonLeft],
      baseRange: { start: baseCursor, end: upToBase },
      leftRange: { start: leftStart, end: leftStart + count },
      rightRange: { start: rightStart, end: rightStart + count },
      centerRange: { start: 0, end: 0 },
      resolved: true,
      acceptedLeft: false,
      acceptedRight: false,
      ignoredLeft: false,
      ignoredRight: false,
      manuallyEdited: false,
    });
    baseCursor = upToBase;
  };

  for (const region of regions) {
    pushCommon(region.baseStart);

    const leftStart = region.baseStart + deltaLeft;
    for (const h of region.left) {
      deltaLeft += h.sideCount - h.baseCount;
    }
    const leftEnd = region.baseEnd + deltaLeft;

    const rightStart = region.baseStart + deltaRight;
    for (const h of region.right) {
      deltaRight += h.sideCount - h.baseCount;
    }
    const rightEnd = region.baseEnd + deltaRight;

    const regionBase = baseLines.slice(region.baseStart, region.baseEnd);
    const regionLeft = leftAllLines.slice(leftStart, leftEnd);
    const regionRight = rightAllLines.slice(rightStart, rightEnd);

    const hasLeft = region.left.length > 0;
    const hasRight = region.right.length > 0;

    let kind: ThreeWayChunkKind;
    let centerLines: string[];
    let resolved: boolean;

    if (hasLeft && !hasRight) {
      kind = "auto-left";
      centerLines = [...regionLeft];
      resolved = true;
    } else if (!hasLeft && hasRight) {
      kind = "auto-right";
      centerLines = [...regionRight];
      resolved = true;
    } else if (linesEqual(regionLeft, regionRight)) {
      kind = "auto-both";
      centerLines = [...regionLeft];
      resolved = true;
    } else {
      kind = "conflict";
      centerLines = [...regionBase];
      resolved = false;
    }

    chunks.push({
      id: `chunk-${nextId++}`,
      kind,
      baseLines: regionBase,
      leftLines: regionLeft,
      rightLines: regionRight,
      centerLines,
      baseRange: { start: region.baseStart, end: region.baseEnd },
      leftRange: { start: leftStart, end: leftEnd },
      rightRange: { start: rightStart, end: rightEnd },
      centerRange: { start: 0, end: 0 },
      resolved,
      acceptedLeft: false,
      acceptedRight: false,
      ignoredLeft: false,
      ignoredRight: false,
      manuallyEdited: false,
    });

    baseCursor = region.baseEnd;
  }

  pushCommon(baseLines.length);

  return finalizeModel(
    {
      pathDisplay: file.path.display,
      pathHex: file.path.rawHex,
      mode: file.mode,
      eol,
      trailingNewline,
      leftLines: leftAllLines,
      rightLines: rightAllLines,
    },
    chunks,
  );
}

export function acceptChunkSide(model: ThreeWayMergeModel, chunkId: string, side: "left" | "right"): ThreeWayMergeModel {
  const nextChunks = model.chunks.map(chunk => {
    if (chunk.id !== chunkId || chunk.kind !== "conflict") return chunk;
    if (side === "left" && (chunk.acceptedLeft || chunk.ignoredLeft)) return chunk;
    if (side === "right" && (chunk.acceptedRight || chunk.ignoredRight)) return chunk;

    const incoming = side === "left" ? chunk.leftLines : chunk.rightLines;
    const replaceInitial = !chunk.acceptedLeft && !chunk.acceptedRight && !chunk.manuallyEdited;
    const centerLines = replaceInitial ? [...incoming] : [...chunk.centerLines, ...incoming];

    return {
      ...chunk,
      centerLines,
      resolved: true,
      acceptedLeft: chunk.acceptedLeft || side === "left",
      acceptedRight: chunk.acceptedRight || side === "right",
    };
  });
  return finalizeModel(model, nextChunks);
}

export function ignoreChunkSide(model: ThreeWayMergeModel, chunkId: string, side: "left" | "right"): ThreeWayMergeModel {
  const nextChunks = model.chunks.map(chunk => {
    if (chunk.id !== chunkId || chunk.kind !== "conflict") return chunk;
    const ignoredLeft = chunk.ignoredLeft || side === "left";
    const ignoredRight = chunk.ignoredRight || side === "right";
    const acceptedLeft = side === "left" ? false : chunk.acceptedLeft;
    const acceptedRight = side === "right" ? false : chunk.acceptedRight;
    const bothIgnored = ignoredLeft && ignoredRight;
    const centerLines = bothIgnored && !chunk.acceptedLeft && !chunk.acceptedRight && !chunk.manuallyEdited
      ? [...chunk.baseLines]
      : chunk.centerLines;
    const resolved = chunk.resolved || bothIgnored;

    return {
      ...chunk,
      centerLines,
      resolved,
      acceptedLeft,
      acceptedRight,
      ignoredLeft,
      ignoredRight,
    };
  });
  return finalizeModel(model, nextChunks);
}

export function updateChunkCenterText(model: ThreeWayMergeModel, chunkId: string, text: string): ThreeWayMergeModel {
  const nextChunks = model.chunks.map(chunk => {
    if (chunk.id !== chunkId || chunk.kind === "common") return chunk;
    const nextLines = text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
    return {
      ...chunk,
      centerLines: nextLines,
      manuallyEdited: true,
      resolved: true,
    };
  });
  return finalizeModel(model, nextChunks);
}

export function resetChunk(model: ThreeWayMergeModel, chunkId: string): ThreeWayMergeModel {
  const nextChunks = model.chunks.map(chunk => {
    if (chunk.id !== chunkId) return chunk;
    if (chunk.kind === "auto-left") {
      return {
        ...chunk,
        centerLines: [...chunk.leftLines],
        resolved: true,
        acceptedLeft: false,
        acceptedRight: false,
        ignoredLeft: false,
        ignoredRight: false,
        manuallyEdited: false,
      };
    }
    if (chunk.kind === "auto-right") {
      return {
        ...chunk,
        centerLines: [...chunk.rightLines],
        resolved: true,
        acceptedLeft: false,
        acceptedRight: false,
        ignoredLeft: false,
        ignoredRight: false,
        manuallyEdited: false,
      };
    }
    if (chunk.kind === "auto-both") {
      return {
        ...chunk,
        centerLines: [...chunk.leftLines],
        resolved: true,
        acceptedLeft: false,
        acceptedRight: false,
        ignoredLeft: false,
        ignoredRight: false,
        manuallyEdited: false,
      };
    }
    if (chunk.kind !== "conflict") return chunk;
    return {
      ...chunk,
      centerLines: [...chunk.baseLines],
      resolved: false,
      acceptedLeft: false,
      acceptedRight: false,
      ignoredLeft: false,
      ignoredRight: false,
      manuallyEdited: false,
    };
  });
  return finalizeModel(model, nextChunks);
}

export function resolveAllConflictsWithSide(model: ThreeWayMergeModel, side: "left" | "right"): ThreeWayMergeModel {
  const nextChunks = model.chunks.map(chunk => {
    if (chunk.kind !== "conflict") return chunk;
    const lines = side === "left" ? chunk.leftLines : chunk.rightLines;
    return {
      ...chunk,
      centerLines: [...lines],
      resolved: true,
      acceptedLeft: side === "left",
      acceptedRight: side === "right",
      ignoredLeft: side === "right",
      ignoredRight: side === "left",
      manuallyEdited: false,
    };
  });
  return finalizeModel(model, nextChunks);
}

export function countUnresolvedConflicts(model: ThreeWayMergeModel): number {
  let count = 0;
  for (const chunk of model.chunks) {
    if (chunk.kind === "conflict" && !chunk.resolved) count += 1;
  }
  return count;
}

export function serializeMergedText(model: ThreeWayMergeModel): string {
  const allLines = model.chunks.flatMap(chunk => chunk.centerLines);
  if (allLines.length === 0) return "";
  return `${allLines.join(model.eol)}${model.trailingNewline ? model.eol : ""}`;
}
