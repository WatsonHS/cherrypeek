export interface VirtualItem {
  key: string;
  height: number;
}

export interface VirtualRange {
  start: number;
  end: number;
  top: number;
  bottom: number;
  total: number;
}

export interface VirtualLayout {
  items: VirtualItem[];
  offsets: number[];
  range(scrollTop: number, viewportHeight: number, overscan?: number): VirtualRange;
  offset(key: string): number | undefined;
}

/** Builds the height prefix once per data revision; scrolling only does binary searches. */
export function createVirtualLayout(items: VirtualItem[]): VirtualLayout {
  const offsets = itemOffsets(items);
  const itemOffsetsByKey = new Map(items.map((item, index) => [item.key, offsets[index]!]));
  return {
    items,
    offsets,
    range(scrollTop, viewportHeight, overscan = 12) {
      return rangeFromOffsets(offsets, scrollTop, viewportHeight, overscan);
    },
    offset(key) { return itemOffsetsByKey.get(key); },
  };
}

/** Returns a bounded slice of a finite, already-loaded list. It never models unknown rows. */
export function virtualRange(items: VirtualItem[], scrollTop: number, viewportHeight: number, overscan = 12): VirtualRange {
  return rangeFromOffsets(itemOffsets(items), scrollTop, viewportHeight, overscan);
}

function rangeFromOffsets(offsets: number[], scrollTop: number, viewportHeight: number, overscan: number): VirtualRange {
  const itemCount = Math.max(0, offsets.length - 1);
  if (!itemCount) return { start: 0, end: 0, top: 0, bottom: 0, total: 0 };
  const total = offsets[itemCount]!;
  const viewport = Math.max(0, viewportHeight);
  const topEdge = Math.min(Math.max(0, scrollTop), Math.max(0, total - viewport));
  const bottomEdge = topEdge + Math.max(0, viewportHeight);
  const first = firstEndingAfter(offsets, topEdge);
  const afterLast = firstStartingAtOrAfter(offsets, bottomEdge);
  const start = Math.max(0, first - Math.max(0, overscan));
  const end = Math.min(itemCount, Math.max(first + 1, afterLast) + Math.max(0, overscan));
  return {
    start,
    end,
    top: offsets[start] ?? 0,
    bottom: Math.max(0, total - offsets[end]!),
    total,
  };
}

/** Maps an item key to its content-space top using the same measured fixed heights as virtualRange. */
export function itemOffset(items: VirtualItem[], key: string): number | undefined {
  return createVirtualLayout(items).offset(key);
}

function itemOffsets(items: VirtualItem[]): number[] {
  const offsets = new Array<number>(items.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < items.length; index += 1) {
    offsets[index + 1] = offsets[index]! + Math.max(0, items[index]!.height);
  }
  return offsets;
}

function firstEndingAfter(offsets: number[], edge: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle + 1]! <= edge) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, offsets.length - 1);
}

function firstStartingAtOrAfter(offsets: number[], edge: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle]! < edge) low = middle + 1;
    else high = middle;
  }
  return low;
}
