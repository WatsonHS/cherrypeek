/* Generated from Rust protocol types. Do not edit by hand. */

export type ServerMessage =
  | {
      core: CoreReady;
      type: "hello";
    }
  | {
      coverage: Coverage;
      data: ResponseData;
      done: boolean;
      generation: string | null;
      nextCursor: string | null;
      repoId: string | null;
      requestId: string;
      sequence: number;
      type: "response";
    }
  | {
      code: ErrorCode;
      generation: string | null;
      message: string;
      repoId: string | null;
      requestId: string | null;
      retryable: boolean;
      type: "error";
    };
export type Capability =
  | "getRuntimeInfo"
  | "readRepositoryPreview"
  | "repositorySessions"
  | "historyPagination"
  | "historyNewSinceLastSeen"
  | "repositoryScopes"
  | "metadataIndex"
  | "metadataSearch"
  | "historyGraph"
  | "commitDetails";
export type ResponseData =
  | {
      coreVersion: string;
      pid: number;
      section: "core";
    }
  | {
      section: "metadataIndex";
      status: MetadataIndexStatus;
    }
  | {
      page: SearchPage;
      section: "searchPage";
    }
  | {
      result: SearchIdentities;
      section: "searchIdentities";
    }
  | {
      details: CommitDetails;
      section: "commitDetails";
    }
  | {
      page: ChangedFilesPage;
      section: "changedFiles";
    }
  | {
      page: MergeCommitsPage;
      section: "mergeCommits";
    }
  | {
      result: BranchesContainingResult;
      section: "branchesContaining";
    }
  | {
      diff: FileDiff;
      section: "fileDiff";
    }
  | {
      git: GitInfo;
      section: "git";
    }
  | {
      refs: RefInfo[];
      refsTruncated: boolean;
      repository: RepositoryInfo;
      section: "repository";
    }
  | {
      commits: CommitSummary[];
      hasMore: boolean;
      section: "commits";
    }
  | {
      section: "repositorySession";
      session: RepositorySessionInfo;
    }
  | {
      saved: boolean;
      section: "repositoryViewRecorded";
      status: StoreStatus;
    }
  | {
      closed: boolean;
      section: "repositoryClosed";
    }
  | {
      repositories: RecentRepository[];
      section: "recentRepositories";
      status: StoreStatus;
    }
  | {
      /**
       * @maxItems 500
       */
      commits: HistoryCommit[];
      cursor: string;
      hasMore: boolean;
      lastSeenDividerOid: string | null;
      newSinceLastSeenStatus: NewSinceLastSeenStatus;
      offset: number;
      pageSize: number;
      previousCursor: string | null;
      section: "historyPage";
    }
  | {
      navigation: RepositoryNavigation;
      section: "repositoryNavigation";
    }
  | {
      result: RefMergeStatusResult;
      section: "refMergeStatus";
    };
export type ErrorCode =
  | "PROTOCOL_MISMATCH"
  | "PROTOCOL_ERROR"
  | "INVALID_REQUEST"
  | "UNKNOWN_METHOD"
  | "BUSY"
  | "CANCELLED"
  | "TIMEOUT"
  | "CORE_EXITED"
  | "STALE_CONTEXT"
  | "GIT_UNAVAILABLE"
  | "NOT_A_REPOSITORY"
  | "REPOSITORY_UNAVAILABLE"
  | "MISSING_OBJECT"
  | "UNSUPPORTED_REPOSITORY"
  | "RESOURCE_LIMIT"
  | "GIT_ERROR"
  | "PERMISSION_DENIED"
  | "INVALID_CURSOR"
  | "SNAPSHOT_CHANGED"
  | "SCOPE_UNAVAILABLE"
  | "INDEX_UNAVAILABLE"
  | "INDEX_CORRUPT"
  | "INDEX_VERSION_UNSUPPORTED";
export type MetadataIndexState =
  "idle" | "queued" | "running" | "paused" | "cancelled" | "complete" | "quotaLimited" | "unavailable" | "failed";
export type SearchTimeField = "author" | "committer";
export type RefKind = "localBranch" | "remoteBranch" | "tag";
export type CommitUpdateReason = "scopeUnavailable" | "noLongerReachable";
export type CommitUpdateState = "unaffected" | "affected" | "unknown";
export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typeChanged";
export type FileDiffKind = "text" | "binary" | "gitlink" | "lfs" | "tooLarge";
export type StoreStatus = "ok" | "disabled" | "unavailable" | "corrupt";
export type RepositoryScope =
  | ("head" | "allBranches")
  | {
      ref: string;
    }
  | {
      worktree: string;
    };
export type HistoryGraphSegmentKind = "through" | "incoming" | "outgoing";
export type NewSinceLastSeenStatus = "ready" | "firstView" | "unavailable";
export type MergeStatus = "merged" | "notMerged" | "unavailable";

export interface CoreReady {
  capabilities: Capability[];
  coreVersion: string;
  git: GitInfo;
  pid: number;
  protocolVersion: number;
}
export interface GitInfo {
  available: boolean;
  error: string | null;
  version: string | null;
}
export interface Coverage {
  complete: boolean;
  processed: number;
}
export interface MetadataIndexStatus {
  coverage: MetadataIndexCoverage;
  diskBytes: number;
  error: MetadataIndexFailure | null;
  quotaBytes: number;
  snapshotKey: string | null;
  state: MetadataIndexState;
}
export interface MetadataIndexCoverage {
  complete: boolean;
  processed: number;
}
export interface MetadataIndexFailure {
  code: ErrorCode;
  message: string;
}
export interface SearchPage {
  anchorFound: boolean | null;
  /**
   * @maxItems 500
   */
  commits: CommitSummary[];
  coverage: MetadataIndexCoverage;
  index: MetadataIndexStatus;
  matchedCount: number;
  nextCursor: string | null;
  pageOffset: number;
  previousCursor: string | null;
  queryKey: string;
  resultVersion: string;
  snapshotKey: string;
}
export interface CommitSummary {
  author: CommitIdentity;
  committer: CommitIdentity;
  oid: string;
  parents: string[];
  summary: string;
  summaryTruncated: boolean;
  textLossy: boolean;
}
export interface CommitIdentity {
  email: string;
  name: string;
  offset: string;
  timestamp: string;
}
export interface SearchIdentities {
  coverage: MetadataIndexCoverage;
  field: SearchTimeField;
  /**
   * @maxItems 100
   */
  identities: SearchIdentity[];
  index: MetadataIndexStatus;
  truncated: boolean;
}
export interface SearchIdentity {
  email: string;
  name: string;
}
export interface CommitDetails {
  commit: CommitSummary;
  message: string;
  messageWithoutTrailers: string;
  observedAtUnixMs: number;
  /**
   * @maxItems 2000
   */
  refs: RefInfo[];
  refsTruncated: boolean;
  /**
   * @maxItems 4096
   */
  trailers: Trailer[];
  update: CommitUpdate;
  /**
   * @maxItems 128
   */
  worktrees: WorktreeInfo[];
  worktreesTruncated: boolean;
}
export interface RefInfo {
  kind: RefKind;
  name: string;
  oid: string;
  peeledOid: string | null;
  symbolicTarget: string | null;
}
export interface Trailer {
  key: string;
  value: string;
}
export interface CommitUpdate {
  checkedAtUnixMs: number;
  reason: CommitUpdateReason | null;
  state: CommitUpdateState;
}
export interface WorktreeInfo {
  available: boolean;
  headOid: string | null;
  headReference: string | null;
  id: string;
  isBare: boolean;
  isCurrent: boolean;
  isDetached: boolean;
  isMain: boolean;
  lockedReason: string | null;
  path: string;
  prunableReason: string | null;
}
export interface ChangedFilesPage {
  /**
   * @maxItems 200
   */
  files: ChangedFile[];
  hasMore: boolean;
  offset: number;
  oid: string;
  overview: ChangeOverview;
  pageSize: number;
  parentIndex: number | null;
  parentOid: string | null;
  totalFiles: number;
}
export interface ChangedFile {
  additions: number | null;
  binary: boolean;
  deletions: number | null;
  gitlink: boolean;
  newMode: string;
  newOid: string | null;
  newPath: GitPath | null;
  oldMode: string;
  oldOid: string | null;
  oldPath: GitPath | null;
  similarity: number | null;
  status: ChangedFileStatus;
}
export interface GitPath {
  display: string;
  rawHex: string;
  textLossy: boolean;
}
export interface ChangeOverview {
  additions: number;
  binaryFiles: number;
  counts: ChangeCounts;
  deletions: number;
  /**
   * @maxItems 20000
   */
  directories: DirectoryChangeOverview[];
  gitlinkFiles: number;
  totalFiles: number;
}
export interface ChangeCounts {
  added: number;
  copied: number;
  deleted: number;
  modified: number;
  renamed: number;
  typeChanged: number;
}
export interface DirectoryChangeOverview {
  additions: number;
  deletions: number;
  path: GitPath | null;
  totalFiles: number;
}
export interface MergeCommitsPage {
  /**
   * @maxItems 1000
   */
  authors: MergeAuthorCount[];
  /**
   * @maxItems 200
   */
  commits: CommitSummary[];
  firstParentOid: string;
  hasMore: boolean;
  offset: number;
  oid: string;
  pageSize: number;
  parentIndex: number;
  parentOid: string;
  totalCommits: number;
}
export interface MergeAuthorCount {
  count: number;
  email: string;
  name: string;
}
export interface BranchesContainingResult {
  boundaryLimited: boolean;
  /**
   * @maxItems 2000
   */
  branches: RefInfo[];
  complete: boolean;
  observedAtUnixMs: number;
  oid: string;
  refsTruncated: boolean;
}
export interface FileDiff {
  file: ChangedFile;
  kind: FileDiffKind;
  newSize: number | null;
  oid: string;
  oldSize: number | null;
  parentIndex: number | null;
  parentOid: string | null;
  patch: string;
  textLossy: boolean;
  truncated: boolean;
}
export interface RepositoryInfo {
  commonDir: string;
  gitDir: string;
  headOid: string | null;
  headReference: string | null;
  isBare: boolean;
  isShallow: boolean;
  objectFormat: string;
  path: string;
  worktreePath: string | null;
}
export interface RepositorySessionInfo {
  generation: string;
  observedAtUnixMs: number;
  persistence: SessionPersistenceStatus;
  previousView: LastViewedSnapshot | null;
  repoId: string;
  repository: RepositoryInfo;
  repositoryKey: string;
  scope: RepositoryScope;
  /**
   * @maxItems 2000
   */
  tips: string[];
  worktreeId: string;
}
export interface SessionPersistenceStatus {
  lastSeen: StoreStatus;
  recent: StoreStatus;
}
export interface LastViewedSnapshot {
  /**
   * @maxItems 2000
   */
  tips: string[];
  viewedAtUnixMs: number;
}
export interface RecentRepository {
  commonDir: string;
  gitDir: string;
  lastOpenedAtUnixMs: number;
  objectFormat: string;
  path: string;
  repositoryKey: string;
  worktreeId: string;
  worktreePath: string | null;
}
export interface HistoryCommit {
  author: CommitIdentity;
  committer: CommitIdentity;
  graph: HistoryGraph;
  isNewSinceLastSeen: boolean;
  oid: string;
  parents: string[];
  summary: string;
  summaryTruncated: boolean;
  textLossy: boolean;
}
export interface HistoryGraph {
  above: number;
  below: number;
  boundary: boolean;
  color: number;
  hiddenLaneCount: number;
  lane: number;
  /**
   * @maxItems 128
   */
  parents: string[];
  /**
   * @maxItems 256
   */
  segments: HistoryGraphSegment[];
}
export interface HistoryGraphSegment {
  color: number;
  fromLane: number;
  kind: HistoryGraphSegmentKind;
  toLane: number;
}
export interface RepositoryNavigation {
  defaultBase: DefaultBase | null;
  observedAtUnixMs: number;
  /**
   * @maxItems 2000
   */
  refs: RefInfo[];
  refsTruncated: boolean;
  /**
   * @maxItems 128
   */
  worktrees: WorktreeInfo[];
  worktreesTruncated: boolean;
}
export interface DefaultBase {
  name: string;
  oid: string;
}
export interface RefMergeStatusResult {
  defaultBase: DefaultBase | null;
  /**
   * @maxItems 50
   */
  statuses: RefMergeStatus[];
}
export interface RefMergeStatus {
  name: string;
  oid: string;
  status: MergeStatus;
}
