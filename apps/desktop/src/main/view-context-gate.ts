import type { RequestContext } from "../../../../packages/protocol/src/messages.js";

export type StaleRequestHandler = (requestId: string) => void;

export class ViewContextGate {
  private current: RequestContext = { repoId: null, generation: null };
  private latestObserved: RequestContext = { repoId: null, generation: null };
  private readonly requests = new Map<string, { context: RequestContext; onStale: StaleRequestHandler }>();

  getCurrent(): RequestContext { return { ...this.current }; }
  getLatestObserved(): RequestContext { return { ...this.latestObserved }; }
  isCurrent(context: RequestContext): boolean { return sameContext(context, this.current); }

  observeLatest(context: RequestContext): void {
    this.latestObserved = { ...context };
  }

  switchCurrent(context: RequestContext): void {
    this.current = { ...context };
    for (const [requestId, request] of this.requests) {
      if (!sameContext(request.context, this.current)) {
        this.requests.delete(requestId);
        request.onStale(requestId);
      }
    }
  }

  register(requestId: string, context: RequestContext, onStale: StaleRequestHandler): () => void {
    if (!sameContext(context, this.current)) {
      onStale(requestId);
      return () => undefined;
    }
    this.requests.set(requestId, { context: { ...context }, onStale });
    return () => this.requests.delete(requestId);
  }

  accepts(requestId: string, context: RequestContext): boolean {
    const request = this.requests.get(requestId);
    return Boolean(request && sameContext(request.context, context) && sameContext(context, this.current));
  }
}

function sameContext(left: RequestContext, right: RequestContext): boolean {
  return left.repoId === right.repoId && left.generation === right.generation;
}
