const PREFETCH_LATENCY_SECONDS = 0.3;
const MAX_PREFETCH_VIEWPORTS = 8;

export function historyPrefetchDistance(viewportHeight: number, velocityPxPerSecond: number): number {
  const viewport = Math.max(viewportHeight, 100);
  return Math.min(viewport * MAX_PREFETCH_VIEWPORTS, viewport + Math.max(0, velocityPxPerSecond) * PREFETCH_LATENCY_SECONDS);
}
