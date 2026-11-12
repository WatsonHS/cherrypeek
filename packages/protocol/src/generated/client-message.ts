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
  | LocateCommitParams
  | LocateHistoryDateParams
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
  | ReadDiffParams
  | ListSearchPathsParams
  | GetActivityStatsParams
  | GetActivityOverviewParams
  | GetChangeStatsParams
  | SetStatsExclusionsParams
  | GetStatsCommitsParams
  | EvolutionParams
  | GetHandoffFactsParams
  | ReadWorkspaceStatusParams
  | ReadWorkspaceDiffParams
  | ReadWorkspaceFileParams
  | ListTreeParams
  | ReadFileContentParams
  | ReadFileHistoryParams
  | ReadFileChangeParams
  | ListPathChangesParams
  | ReadBlameParams
  | FetchRepositoryParams
  | GetBranchSyncParams
  | OperationParams;
export type RepositoryScope =
  | ("head" | "allBranches")
  | {
      ref: string;
    }
  | {
      worktree: string;
    };
export type MetadataIndexAction = "pause" | "resume" | "cancel" | "rebuild";
export type SearchPathKind = "file" | "directory";
export type SearchTimeField = "author" | "committer";
export type StatsBucket = "tenMinutes" | "hour" | "day" | "week" | "month";
export type StatsSelection =
  | {
      kind: "file";
      pathHex: string;
    }
  | {
      kind: "directory";
      pathHex: string;
    }
  | {
      aHex: string;
      bHex: string;
      kind: "pair";
    }
  | {
      kind: "untested";
    };
export type WorkspaceSide = "staged" | "unstaged";
export type RepositoryOperation =
  | {
      expectedOid: string;
      kind: "fastForward";
      refName: string;
      upstreamOid: string;
    }
  | {
      expectedHeadOid: string;
      expectedOid: string;
      kind: "switch";
      target: SwitchTarget;
    }
  | {
      expectedHeadOid: string;
      kind: "createBranch";
      name: string;
      startOid: string;
      switchAfter: boolean;
    };
export type SwitchTarget =
  | {
      refName: string;
    }
  | {
      remoteRefName: string;
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
export interface LocateCommitParams {
  oid: string;
  pageSize: number;
}
export interface LocateHistoryDateParams {
  beforeTimestamp: number;
  /**
   * @maxItems 9
   */
  knownCursors?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | null;
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
  path: SearchPathFilter | null;
  timeField: SearchTimeField;
  timeZone: string;
  toTimestamp: number | null;
}
export interface SearchIdentity {
  email: string;
  name: string;
}
export interface SearchPathFilter {
  includeDescendants: boolean;
  kind: SearchPathKind;
  rawHex: string;
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
  /**
   * P4-11: whole file as context. Only sent when the core declares `diffFullContext`.
   */
  fullFile?: boolean;
  newPathHex: string | null;
  oid: string;
  oldPathHex: string | null;
  parentIndex: number | null;
}
export interface ListSearchPathsParams {
  limit: number;
  text: string;
}
export interface GetActivityStatsParams {
  query: SearchQuery;
}
export interface GetActivityOverviewParams {
  bucket: StatsBucket;
  query: SearchQuery;
  range: StatsRange;
}
export interface StatsRange {
  endUnix: number;
  startUnix: number;
}
export interface GetChangeStatsParams {
  bucket: StatsBucket;
  directoryPrefix?: string;
  query: SearchQuery;
  range: StatsRange;
}
export interface SetStatsExclusionsParams {
  patterns: string[];
}
export interface GetStatsCommitsParams {
  limit: number;
  offset: number;
  query: SearchQuery;
  range: StatsRange;
  selection: StatsSelection;
}
export interface EvolutionParams {
  commit: string;
  pathHex: string;
  range?: StatsRange | null;
}
export interface GetHandoffFactsParams {
  branchRef: string | null;
  operationWorktreeId: string | null;
  selectedOid: string | null;
  staleWorktreeId: string | null;
}
/**
 * P4-09: the working tree of the window's own directory, independent of the browsing scope.
 */
export interface ReadWorkspaceStatusParams {
  maxEntries: number;
}
export interface ReadWorkspaceDiffParams {
  /**
   * P4-11: whole file as context. Only sent when the core declares `diffFullContext`.
   */
  fullFile?: boolean;
  oldPathHex: string | null;
  pathHex: string;
  side: WorkspaceSide;
}
export interface ReadWorkspaceFileParams {
  maxLines: number;
  pathHex: string;
}
/**
 * P4-10: one directory of the tree at a commit, directories first, then by raw name bytes.
 */
export interface ListTreeParams {
  commit: string;
  limit: number;
  offset: number;
  /**
   * Directory to list; null for the root.
   */
  pathHex: string | null;
}
export interface ReadFileContentParams {
  commit: string;
  maxLines: number;
  pathHex: string;
}
/**
 * History of one literal path, reachable from `commit` (the tree version). No rename following.
 */
export interface ReadFileHistoryParams {
  commit: string;
  cursor: string | null;
  kind: SearchPathKind;
  /**
   * Literal substring of the commit message; empty for no filter.
   */
  message: string;
  pageSize: number;
  /**
   * Empty for the repository root (directory history of everything).
   */
  pathHex: string;
}
/**
 * One file's change in one commit, without loading the commit details first.
 */
export interface ReadFileChangeParams {
  fullFile?: boolean;
  oid: string;
  /**
   * The path in the parent when the file was renamed in this commit.
   */
  oldPathHex: string | null;
  parentIndex: number | null;
  pathHex: string;
}
/**
 * Files a commit changed under one directory, against the chosen parent (a root commit compares with the empty tree).
 */
export interface ListPathChangesParams {
  offset: number;
  oid: string;
  pageSize: number;
  parentIndex: number | null;
  /**
   * The directory's raw path bytes as hex; empty means the whole repository.
   */
  pathHex: string;
}
/**
 * P4-12: blame of a file at a commit, streamed in chunks.
 */
export interface ReadBlameParams {
  commit: string;
  pathHex: string;
}
/**
 * P5-01: fetch remote-tracking refs. Never touches the working tree, the index, HEAD or local branches.
 */
export interface FetchRepositoryParams {
  /**
   * Also delete remote-tracking refs whose branch is gone on the remote.
   */
  prune: boolean;
  /**
   * The name of a configured remote, or null for every remote.
   */
  remote: string | null;
}
export interface GetBranchSyncParams {
  refNames: string[];
}
export interface OperationParams {
  operation: RepositoryOperation;
}
