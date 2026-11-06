import type { CommitScopeApi } from "../../../../packages/protocol/src/core-status.js";

declare global {
  interface Window { commitScope: CommitScopeApi }
}

export {};
