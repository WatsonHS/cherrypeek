import type { ErrorCode, RefInfo, RepositoryInfo, CommitSummary } from "./generated/server-message.js";

export type RepositoryPreviewStateName = "idle" | "loading" | "ready" | "error" | "cancelled";
export interface RepositoryPreviewState {
  revision: number;
  state: RepositoryPreviewStateName;
  repository: RepositoryInfo | null;
  refs: RefInfo[];
  refsTruncated: boolean;
  commits: CommitSummary[];
  hasMore: boolean;
  error: { code: ErrorCode | "INVALID_REQUEST"; message: string } | null;
}

export function emptyRepositoryPreview(revision = 0, state: RepositoryPreviewStateName = "idle"): RepositoryPreviewState {
  return { revision, state, repository: null, refs: [], refsTruncated: false, commits: [], hasMore: false, error: null };
}
