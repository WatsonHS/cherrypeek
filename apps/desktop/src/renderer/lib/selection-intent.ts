import type { RepositorySessionInfo } from "../../../../../packages/protocol/src/generated/server-message.js";

export interface SelectionIntentToken {
  revision: number;
  repoId: string;
  generation: string;
}

/** Invalidates asynchronous selection navigation when the user chooses another row. */
export class SelectionIntent {
  private revision = 0;

  capture(session: RepositorySessionInfo | null): SelectionIntentToken | null {
    return session ? { revision: this.revision, repoId: session.repoId, generation: session.generation } : null;
  }

  invalidate(): void {
    this.revision += 1;
  }

  isRevisionCurrent(token: SelectionIntentToken | null): boolean {
    return Boolean(token && token.revision === this.revision);
  }

  isCurrent(token: SelectionIntentToken | null, session: RepositorySessionInfo | null): boolean {
    return Boolean(token && session && token.revision === this.revision &&
      token.repoId === session.repoId && token.generation === session.generation);
  }
}

export function applySelectionIfCurrent(
  intent: SelectionIntent,
  token: SelectionIntentToken | null,
  session: RepositorySessionInfo | null,
  oid: string,
  select: (oid: string) => void,
): boolean {
  if (!intent.isCurrent(token, session)) return false;
  intent.invalidate();
  select(oid);
  return true;
}
