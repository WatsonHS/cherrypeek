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
  | RefMergeStatusParams
  | ControlMetadataIndexParams
  | SearchCommitsParams
  | SearchIdentitiesParams
  | GetCommitParams
  | ListChangedFilesParams
  | ReadMergeCommitsParams
  | BranchesContainingParams
  | ReadDiffParams;
export type RepositoryScope =
  | ("head" | "allBranches")
  | {
      ref: string;
    }
  | {
      worktree: string;
    };
export type MetadataIndexAction = "pause" | "resume" | "cancel" | "rebuild";
export type SearchTimeField = "author" | "committer";

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
export interface ControlMetadataIndexParams {
  action: MetadataIndexAction;
}
export interface SearchCommitsParams {
  anchorOid: string | null;
  cursor: string | null;
  pageSize: number;
  query: SearchQuery;
}
export interface SearchQuery {
  /**
   * @maxItems 50
   */
  authors: SearchIdentity[];
  caseSensitive: boolean;
  /**
   * @maxItems 50
   */
  committers: SearchIdentity[];
  fromTimestamp: number | null;
  message: string;
  oidPrefix: string;
  timeField: SearchTimeField;
  timeZone: string;
  toTimestamp: number | null;
}
export interface SearchIdentity {
  email: string;
  name: string;
}
export interface SearchIdentitiesParams {
  field: SearchTimeField;
  limit: number;
  text: string;
}
export interface GetCommitParams {
  oid: string;
}
export interface ListChangedFilesParams {
  offset: number;
  oid: string;
  pageSize: number;
  parentIndex: number | null;
}
export interface ReadMergeCommitsParams {
  offset: number;
  oid: string;
  pageSize: number;
  parentIndex: number;
}
export interface BranchesContainingParams {
  oid: string;
}
export interface ReadDiffParams {
  newPathHex: string | null;
  oid: string;
  oldPathHex: string | null;
  parentIndex: number | null;
}
