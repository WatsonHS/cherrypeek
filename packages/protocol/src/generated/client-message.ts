/* Generated from Rust protocol types. Do not edit by hand. */

export type ClientMessage =
  | {
      protocolVersion: number;
      type: "hello";
    }
  | {
      generation: string | null;
      method: string;
      params: RequestParams;
      repoId: string | null;
      requestId: string;
      type: "request";
    }
  | {
      requestId: string;
      type: "cancel";
    };
export type RequestParams =
  | EmptyParams
  | ReadRepositoryPreviewParams
  | OpenRepositoryParams
  | ReadHistoryPageParams
  | RefreshRepositoryParams
  | SelectRepositoryScopeParams
  | RefMergeStatusParams;
export type RepositoryScope =
  | ("head" | "allBranches")
  | {
      ref: string;
    }
  | {
      worktree: string;
    };

export interface EmptyParams {}
export interface ReadRepositoryPreviewParams {
  path: string;
}
export interface OpenRepositoryParams {
  path: string;
}
export interface ReadHistoryPageParams {
  cursor: string | null;
  pageSize: number;
}
export interface RefreshRepositoryParams {
  pageSize: number;
}
export interface SelectRepositoryScopeParams {
  pageSize: number;
  scope: RepositoryScope;
}
export interface RefMergeStatusParams {
  /**
   * @minItems 1
   * @maxItems 50
   */
  refNames: [string, ...string[]];
}
