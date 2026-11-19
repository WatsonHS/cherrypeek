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
  | (
      | "getRuntimeInfo"
      | "readRepositoryPreview"
      | "repositorySessions"
      | "historyPagination"
      | "historyNewSinceLastSeen"
      | "repositoryScopes"
      | "metadataIndex"
      | "metadataSearch"
      | "historyGraph"
      | "commitDetails"
      | "activityStats"
      | "activityOverview"
      | "changeStats"
      | "notableStats"
      | "evolution"
      | "repositoryObservation"
      | "handoffFacts"
    )
  | "workspaceStatus"
  | "fileBrowsing"
  | "diffFullContext"
  | "blame"
  | "repositoryOperations";
export type ResponseData =
  | {
      estimate: EvolutionEstimate;
      section: "evolutionEstimate";
    }
  | {
      chunk: EvolutionChunk;
      section: "evolutionChunk";
    }
  | {
      section: "changeStats";
      stats: ChangeStats;
    }
  | {
      section: "notableStats";
      stats: NotableStats;
    }
  | {
      result: StatsExclusions;
      section: "statsExclusions";
    }
  | {
      page: StatsCommitPage;
      section: "statsCommitPage";
    }
  | {
      section: "activityOverview";
      stats: ActivityOverview;
    }
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
      paths: SearchPaths;
      section: "searchPaths";
    }
  | {
      section: "activityStats";
      stats: ActivityStats;
    }
  | {
      result: BranchSyncResult;
      section: "branchSync";
    }
  | {
      result: OperationCheck;
      section: "operationCheck";
    }
  | {
      result: OperationRun;
      section: "operationRun";
    }
  | {
      observation: RepositoryObservation;
      section: "repositoryObservation";
    }
  | {
      diff: RefSnapshotDiff;
      section: "refSnapshotDiff";
    }
  | {
      facts: HandoffFacts;
      section: "handoffFacts";
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
      section: "workspaceStatus";
      status: WorkspaceStatus;
    }
  | {
      diff: WorkspaceDiff;
      section: "workspaceDiff";
    }
  | {
      file: WorkspaceFile;
      section: "workspaceFile";
    }
  | {
      page: TreePage;
      section: "treePage";
    }
  | {
      content: FileContent;
      section: "fileContent";
    }
  | {
      page: FileHistoryPage;
      section: "fileHistory";
    }
  | {
      chunk: BlameChunk;
      section: "blameChunk";
    }
  | {
      result: FetchResult;
      section: "repositoryFetched";
    }
  | {
      result: PushResult;
      section: "repositoryPushed";
    }
  | {
      result: MergePreviewResult;
      section: "mergePreview";
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
      newSinceLastSeenCount?: number | null;
      newSinceLastSeenMaxUnix?: number | null;
      newSinceLastSeenMinUnix?: number | null;
      newSinceLastSeenStatus: NewSinceLastSeenStatus;
      offset: number;
      pageSize: number;
      previousCursor: string | null;
      section: "historyPage";
    }
  | {
      location: HistoryDateLocation;
      section: "historyDateLocation";
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
export type SearchPathKind = "file" | "directory";
export type BranchSyncState = "upToDate" | "behind" | "ahead" | "diverged" | "noUpstream" | "unavailable";
export type OperationBlocker =
  | {
      ahead: number;
      behind: number;
      kind: "diverged";
      localCommits: OperationCommit[];
      localCommitsTruncated: boolean;
      overlapPaths: GitPath[];
      overlapPathsTruncated: boolean;
      upstreamCommits: OperationCommit[];
      upstreamCommitsTruncated: boolean;
    }
  | {
      kind: "dirty";
      paths: DirtyOperationPath[];
      pathsTruncated: boolean;
      replaceToken?: string | null;
    }
  | {
      kind: "checkedOutElsewhere";
      worktreePath: string;
    }
  | {
      kind: "inProgress";
      operation: string;
    }
  | {
      kind: "noUpstream";
    }
  | {
      kind: "notFastForward";
    }
  | {
      kind: "refChanged";
    }
  | {
      kind: "nameInvalid";
    }
  | {
      kind: "nameExists";
    }
  | {
      kind: "bare";
    }
  | {
      kind: "unsafeState";
      message: string;
    }
  | {
      kind: "remoteRejected";
      message: string;
      remote: string;
    }
  | {
      baseRefName: string;
      kind: "notAncestorMerged";
    };
export type OperationRun =
  | {
      blockers: OperationBlocker[];
      outcome: "rejected";
    }
  | {
      addedCount?: number | null;
      addedMaxUnix?: number | null;
      addedMinUnix?: number | null;
      committedOid?: string | null;
      headOid?: string | null;
      headReference?: string | null;
      outcome: "done";
      untracked?: UntrackedOutcome | null;
      updatedRef?: UpdatedRef | null;
    };
export type RefSnapshotChangeKind = "fastForward" | "rewritten" | "created" | "deleted" | "unknown";
export type MergeStatus = "merged" | "patchEquivalent" | "notMerged" | "unavailable";
export type RefKind = "localBranch" | "remoteBranch" | "tag";
export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typeChanged";
export type RepositoryScope =
  | ("head" | "allBranches")
  | {
      ref: string;
    }
  | {
      worktree: string;
    };
export type CommitUpdateReason = "scopeUnavailable" | "noLongerReachable";
export type CommitUpdateState = "unaffected" | "affected" | "unknown";
export type FileDiffKind = "text" | "binary" | "gitlink" | "lfs" | "tooLarge";
export type WorkspaceConflict =
  "bothModified" | "bothAdded" | "bothDeleted" | "addedByUs" | "addedByThem" | "deletedByUs" | "deletedByThem";
export type WorkspaceOperation = "none" | "merge" | "rebase" | "cherryPick" | "revert" | "bisect";
export type WorkspaceSide = "staged" | "unstaged";
export type WorkspaceFileKind = "text" | "binary" | "tooLarge" | "symlink" | "missing" | "notFile";
export type TreeEntryKind = "directory" | "file" | "symlink" | "submodule";
export type FileContentKind = "text" | "binary" | "lfs" | "submodule" | "symlink" | "tooLarge" | "missing";
export type PushResult =
  | {
      blockers: OperationBlocker[];
      outcome: "rejected";
    }
  | {
      finishedAtUnixMs: number;
      newOid: string;
      outcome: "done";
      refName: string;
      remote: string;
      remoteRefName: string;
      setUpstream: boolean;
    };
export type MergePreviewResult =
  | {
      blockers: OperationBlocker[];
      outcome: "blocked";
    }
  | {
      autoMergedCount: number;
      canSingleCommitRebase: boolean;
      defaultMessage: string;
      mergeBaseOid: string;
      outcome: "clean";
      singleCommitSummary?: string | null;
    }
  | {
      autoMergedCount: number;
      defaultMessage: string;
      /**
       * @maxItems 10
       */
      files:
        | []
        | [MergeConflictFile]
        | [MergeConflictFile, MergeConflictFile]
        | [MergeConflictFile, MergeConflictFile, MergeConflictFile]
        | [MergeConflictFile, MergeConflictFile, MergeConflictFile, MergeConflictFile]
        | [MergeConflictFile, MergeConflictFile, MergeConflictFile, MergeConflictFile, MergeConflictFile]
        | [
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile
          ]
        | [
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile
          ]
        | [
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile
          ]
        | [
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile
          ]
        | [
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile,
            MergeConflictFile
          ];
      mergeBaseOid: string;
      outcome: "conflicted";
    }
  | {
      conflictPaths: GitPath[];
      message: string;
      outcome: "unsupported";
      reason: MergeUnsupportedReason;
    };
export type MergeUnsupportedReason =
  "crissCross" | "unrelatedHistories" | "structuralConflict" | "binaryOrNonUtf8" | "tooManyOrTooLarge";
export type StoreStatus = "ok" | "disabled" | "unavailable" | "corrupt";
export type HistoryGraphSegmentKind = "through" | "incoming" | "outgoing";
export type NewSinceLastSeenStatus = "ready" | "firstView" | "unavailable";

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
export interface EvolutionEstimate {
  bytes: number;
  fileLimit: number;
  files: number;
  lines: number;
  skipped: EvolutionSkipped[];
  totalFiles: number;
}
export interface EvolutionSkipped {
  path: GitPath;
  reason: string;
}
export interface GitPath {
  display: string;
  rawHex: string;
  textLossy: boolean;
}
export interface EvolutionChunk {
  progress: EvolutionProgress;
  result: EvolutionResult;
}
export interface EvolutionProgress {
  currentPath?: GitPath | null;
  filesDone: number;
  filesTotal: number;
}
export interface EvolutionResult {
  age: EvolutionAge;
  asOfUnix: number;
  complete: boolean;
  covered: EvolutionCovered;
  ownership: EvolutionOwner[];
  skipped: EvolutionSkipped[];
  survival: EvolutionSurvival;
}
export interface EvolutionAge {
  older: number;
  within1y: number;
  within30d: number;
  within7d: number;
  within90d: number;
}
export interface EvolutionCovered {
  files: number;
  lines: number;
}
export interface EvolutionOwner {
  author: SearchIdentity;
  commits: number;
  lines: number;
}
export interface SearchIdentity {
  email: string;
  name: string;
}
export interface EvolutionSurvival {
  byAuthor: SurvivalAuthor[];
  coverage: MetadataIndexCoverage;
  weeks: SurvivalWeek[];
}
export interface SurvivalAuthor {
  added: number;
  author: SearchIdentity;
  kept: number;
}
export interface MetadataIndexCoverage {
  complete: boolean;
  processed: number;
}
export interface SurvivalWeek {
  added: number;
  kept: number;
  startUnix: number;
}
export interface ChangeStats {
  authorDirectories: AuthorDirectories[];
  authorDirectoriesTruncated: boolean;
  buckets: ChangeBucket[];
  coverage: MetadataIndexCoverage;
  directories: DirectoryChanges[];
  directoriesTruncated: boolean;
  excluded: ExcludedChanges;
  extensions: ExtensionChanges[];
  extensionsTruncated: boolean;
  files: FileChanges[];
  filesTruncated: boolean;
  kinds: ChangeKinds;
  largest: LargeCommit[];
  previousTotals: ChangeTotals;
  sessions: ChangeSession[];
  sessionsTruncated: boolean;
  sizeHistogram: number[];
  totals: ChangeTotals;
}
export interface AuthorDirectories {
  author: SearchIdentity;
  cells: AuthorDirectoryCell[];
}
export interface AuthorDirectoryCell {
  directory: GitPath;
  lines: number;
}
export interface ChangeBucket {
  additions: number;
  deletions: number;
  netGrowth: number;
  startUnix: number;
}
export interface DirectoryChanges {
  commits: number;
  lines: number;
  path: GitPath;
}
export interface ExcludedChanges {
  lines: number;
  lockFiles: number;
  mergeCommits: number;
}
export interface ExtensionChanges {
  additions: number;
  deletions: number;
  extension: string;
  filesChanged: number;
}
export interface FileChanges {
  additions: number;
  commits: number;
  deletions: number;
  path: GitPath;
}
export interface ChangeKinds {
  code: number;
  docs: number;
  test: number;
}
export interface LargeCommit {
  additions: number;
  author: SearchIdentity;
  deletions: number;
  oid: string;
  summary: string;
}
export interface ChangeTotals {
  additions: number;
  deletions: number;
  filesAdded: number;
  filesChanged: number;
  filesDeleted: number;
  filesRenamed: number;
}
export interface ChangeSession {
  additions: number;
  authors: string[];
  count: number;
  deletions: number;
  directories: GitPath[];
  endUnix: number;
  startUnix: number;
}
export interface NotableStats {
  churnFiles: ChurnFile[];
  churnFilesTruncated: boolean;
  coverage: MetadataIndexCoverage;
  pairCommitsSkipped: number;
  pairs: FilePair[];
  pairsTruncated: boolean;
  soloDirectories: SoloDirectory[];
  soloDirectoriesTruncated: boolean;
  untested: UntestedChanges;
}
export interface ChurnFile {
  authors: number;
  commits: number;
  days: number[];
  path: GitPath;
}
export interface FilePair {
  a: GitPath;
  b: GitPath;
  shareOfAPerMille: number;
  together: number;
}
export interface SoloDirectory {
  author: SearchIdentity;
  commits: number;
  lines: number;
  path: GitPath;
}
export interface UntestedChanges {
  commits: LargeCommit[];
  commitsTruncated: boolean;
  count: number;
  total: number;
}
export interface StatsExclusions {
  defaults: string[];
  patterns: string[];
}
export interface StatsCommitPage {
  commits: OperationCommit[];
  coverage: MetadataIndexCoverage;
  nextOffset?: number | null;
  total: number;
}
export interface OperationCommit {
  oid: string;
  summary: string;
}
export interface ActivityOverview {
  authors: ActivityAuthor[];
  authorsTruncated: boolean;
  branches: BranchActivity[];
  branchesTruncated: boolean;
  buckets: ActivityBucket[];
  coverage: MetadataIndexCoverage;
  fixupCount: number;
  mergeCount: number;
  previousTotals: ActivityTotals;
  revertCount: number;
  rhythm: ActivityRhythm;
  sessions: ActivitySession[];
  sessionsTruncated: boolean;
  totals: ActivityTotals;
  types: CommitTypeCount[];
  weekHour: number[][];
}
export interface ActivityAuthor {
  count: number;
  email: string;
  name: string;
}
export interface BranchActivity {
  complete: boolean;
  count: number;
  lastCommitUnix?: number | null;
  refName: string;
}
export interface ActivityBucket {
  count: number;
  startUnix: number;
}
export interface ActivityTotals {
  activeDays: number;
  authors: number;
  commits: number;
}
export interface ActivityRhythm {
  busiestDay?: ActivityDay | null;
  longestGapDays: number;
  longestStreakDays: number;
}
export interface ActivityDay {
  count: number;
  day: string;
}
export interface ActivitySession {
  authors: string[];
  count: number;
  endUnix: number;
  startUnix: number;
}
export interface CommitTypeCount {
  count: number;
  prefix: string;
}
export interface MetadataIndexStatus {
  coverage: MetadataIndexCoverage;
  diskBytes: number;
  error: MetadataIndexFailure | null;
  quotaBytes: number;
  snapshotKey: string | null;
  state: MetadataIndexState;
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
  /**
   * @maxItems 500
   */
  pathMatches: SearchPathMatch[];
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
export interface SearchPathMatch {
  oid: string;
  /**
   * @maxItems 128
   */
  parentIndices: (number | null)[];
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
export interface SearchPaths {
  /**
   * @maxItems 100
   */
  entries: SearchPathEntry[];
  truncated: boolean;
}
export interface SearchPathEntry {
  kind: SearchPathKind;
  path: GitPath;
}
export interface ActivityStats {
  /**
   * @maxItems 500
   */
  authors: ActivityAuthor[];
  authorsTruncated: boolean;
  coverage: MetadataIndexCoverage;
  /**
   * @maxItems 3660
   */
  days: ActivityDay[];
  daysTruncated: boolean;
  index: MetadataIndexStatus;
  matchedCount: number;
  queryKey: string;
  timeField: SearchTimeField;
  timeZone: string;
}
export interface BranchSyncResult {
  branches: BranchSync[];
  lastFetchUnixMs?: number | null;
}
export interface BranchSync {
  ahead?: number | null;
  behind?: number | null;
  checkedOutBy: string[];
  oid: string;
  refName: string;
  state: BranchSyncState;
  upstream?: RefTarget | null;
}
export interface RefTarget {
  oid: string;
  refName: string;
}
export interface OperationCheck {
  allowed: boolean;
  blockers: OperationBlocker[];
  identicalUntrackedCount: number;
  preservedDirtyCount: number;
}
export interface DirtyOperationPath {
  path: GitPath;
  replace?: UntrackedDifference | null;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}
export interface UntrackedDifference {
  localOnlyLines?: number | null;
  upstreamOnlyLines?: number | null;
}
export interface UntrackedOutcome {
  backedUpCount: number;
  backupDir?: string | null;
  discardedCount?: number;
  identicalCount: number;
}
export interface UpdatedRef {
  newOid: string;
  oldOid?: string | null;
  refName: string;
}
export interface RepositoryObservation {
  changeCount: number;
  changedRefCount: number;
  generation: string;
  observedAtUnixMs: number;
  refsTruncated: boolean;
  worktreesChanged: boolean;
  worktreesTruncated: boolean;
}
export interface RefSnapshotDiff {
  /**
   * @maxItems 2000
   */
  changes: RefSnapshotChange[];
  complete: boolean;
  fromGeneration: string;
  observedAtUnixMs: number;
  toGeneration: string;
  truncated: boolean;
  worktreesChanged: boolean;
}
export interface RefSnapshotChange {
  /**
   * @maxItems 20
   */
  addedCommits:
    | []
    | [CommitSummary]
    | [CommitSummary, CommitSummary]
    | [CommitSummary, CommitSummary, CommitSummary]
    | [CommitSummary, CommitSummary, CommitSummary, CommitSummary]
    | [CommitSummary, CommitSummary, CommitSummary, CommitSummary, CommitSummary]
    | [CommitSummary, CommitSummary, CommitSummary, CommitSummary, CommitSummary, CommitSummary]
    | [CommitSummary, CommitSummary, CommitSummary, CommitSummary, CommitSummary, CommitSummary, CommitSummary]
    | [
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary
      ]
    | [
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary
      ]
    | [
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary
      ]
    | [
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary
      ]
    | [
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary
      ]
    | [
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary
      ]
    | [
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary
      ]
    | [
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary
      ]
    | [
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary
      ]
    | [
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary
      ]
    | [
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary
      ]
    | [
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary
      ]
    | [
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary,
        CommitSummary
      ];
  addedCommitsTruncated: boolean;
  addedCount: number | null;
  change: RefSnapshotChangeKind;
  deletedMergeStatus: MergeStatus | null;
  kind: RefKind;
  name: string;
  newOid: string | null;
  oldOid: string | null;
  replacedCount: number | null;
}
export interface HandoffFacts {
  ahead: number | null;
  base: DefaultBase | null;
  behind: number | null;
  branch: RefInfo | null;
  /**
   * @maxItems 50
   */
  branchCommits: CommitSummary[];
  branchCommitsCount: number | null;
  branchCommitsTruncated: boolean;
  /**
   * @maxItems 50
   */
  changedFiles: ChangedFile[];
  changedFilesCount: number | null;
  changedFilesTruncated: boolean;
  /**
   * @maxItems 128
   */
  checkedOutBy: WorktreeInfo[];
  checkedOutByComplete: boolean;
  /**
   * @maxItems 127
   */
  mergeParentGroups: HandoffParentGroup[];
  mergeParentGroupsTruncated: boolean;
  mergeStatus: MergeStatus | null;
  observedAtUnixMs: number;
  operationWorktree: WorktreeInfo | null;
  overlapComplete: boolean;
  /**
   * @maxItems 20
   */
  overlapPaths:
    | []
    | [GitPath]
    | [GitPath, GitPath]
    | [GitPath, GitPath, GitPath]
    | [GitPath, GitPath, GitPath, GitPath]
    | [GitPath, GitPath, GitPath, GitPath, GitPath]
    | [GitPath, GitPath, GitPath, GitPath, GitPath, GitPath]
    | [GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath]
    | [GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath]
    | [GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath]
    | [GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath]
    | [GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath]
    | [GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath, GitPath]
    | [
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath
      ]
    | [
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath
      ]
    | [
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath
      ]
    | [
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath
      ]
    | [
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath
      ]
    | [
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath
      ]
    | [
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath
      ]
    | [
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath,
        GitPath
      ];
  overlapTruncated: boolean;
  rangeSummary?: HandoffRangeSummary | null;
  repository: RepositoryInfo;
  scope: RepositoryScope;
  selectedCommit: CommitSummary | null;
  staleWorktree: WorktreeInfo | null;
  windowWorktree: WorktreeInfo | null;
}
export interface DefaultBase {
  name: string;
  oid: string;
}
export interface RefInfo {
  kind: RefKind;
  name: string;
  oid: string;
  peeledOid: string | null;
  symbolicTarget: string | null;
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
export interface HandoffParentGroup {
  /**
   * @maxItems 50
   */
  commits: CommitSummary[];
  parentIndex: number;
  totalCount: number | null;
  truncated: boolean;
}
export interface HandoffRangeSummary {
  /**
   * @maxItems 2000
   */
  excludeTips: string[];
  /**
   * @maxItems 200
   */
  headCommits: CommitSummary[];
  /**
   * @maxItems 2000
   */
  headTips: string[];
  newestOid: string | null;
  oldestOid: string | null;
  /**
   * @maxItems 100
   */
  tailCommits: CommitSummary[];
  totalCount: number;
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
export interface Trailer {
  key: string;
  value: string;
}
export interface CommitUpdate {
  checkedAtUnixMs: number;
  reason: CommitUpdateReason | null;
  state: CommitUpdateState;
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
  /**
   * At most 128 KiB for a normal diff; up to 1 MiB when the whole file was requested (P4-11).
   */
  patch: string;
  textLossy: boolean;
  truncated: boolean;
}
export interface WorkspaceStatus {
  /**
   * False when more paths changed than `max_entries`; `total_paths` is then a lower bound.
   */
  complete: boolean;
  conflictCount: number;
  /**
   * Draft commit message from MERGE_MSG / SQUASH_MSG / COMMIT_EDITMSG when distinct from HEAD.
   */
  draftCommitMessage?: string | null;
  /**
   * @maxItems 2000
   */
  entries: WorkspaceEntry[];
  headOid: string | null;
  /**
   * HEAD when the status was read; it may differ from the HEAD the session opened with.
   */
  headReference: string | null;
  observedAtUnixMs: number;
  operation: WorkspaceOperation;
  totalPaths: number;
}
export interface WorkspaceEntry {
  conflict: WorkspaceConflict | null;
  /**
   * Source path when Git reports a rename or copy.
   */
  originalPath: GitPath | null;
  path: GitPath;
  staged: WorkspaceChange | null;
  unstaged: WorkspaceChange | null;
  untracked: boolean;
  untrackedSize: number | null;
}
export interface WorkspaceChange {
  additions: number | null;
  binary: boolean;
  deletions: number | null;
  gitlink: boolean;
  status: ChangedFileStatus;
}
export interface WorkspaceDiff {
  kind: FileDiffKind;
  newSize: number | null;
  oldPath: GitPath | null;
  oldSize: number | null;
  /**
   * At most 128 KiB for a normal diff; up to 1 MiB when the whole file was requested (P4-11).
   */
  patch: string;
  path: GitPath;
  side: WorkspaceSide;
  textLossy: boolean;
  truncated: boolean;
}
export interface WorkspaceFile {
  kind: WorkspaceFileKind;
  lines: number;
  path: GitPath;
  size: number | null;
  symlinkTarget: GitPath | null;
  text: string;
  textLossy: boolean;
  truncated: boolean;
}
export interface TreePage {
  commit: string;
  /**
   * @maxItems 500
   */
  entries: TreeEntry[];
  hasMore: boolean;
  offset: number;
  path: GitPath | null;
  total: number;
}
export interface TreeEntry {
  kind: TreeEntryKind;
  mode: string;
  /**
   * Last path component.
   */
  name: GitPath;
  oid: string;
  /**
   * Full repository-relative path.
   */
  path: GitPath;
  /**
   * Blob size in bytes; null for directories and submodules.
   */
  size: number | null;
}
export interface FileContent {
  blobOid: string | null;
  commit: string;
  kind: FileContentKind;
  lines: number;
  path: GitPath;
  size: number | null;
  symlinkTarget: GitPath | null;
  /**
   * The first `lines` lines when `kind` is text; at most 1 MiB.
   */
  text: string;
  textLossy: boolean;
  /**
   * Total line count of the blob when known, also when `text` was truncated.
   */
  totalLines: number | null;
  truncated: boolean;
}
export interface FileHistoryPage {
  commit: string;
  /**
   * @maxItems 200
   */
  entries: FileHistoryEntry[];
  nextCursor: string | null;
  path: GitPath;
}
export interface FileHistoryEntry {
  change: FileHistoryChange;
  commit: CommitSummary;
}
export interface FileHistoryChange {
  additions: number | null;
  binary: boolean;
  deletions: number | null;
  /**
   * Files changed under the path; 1 for a file.
   */
  files: number;
  oldPath: GitPath | null;
  /**
   * Relative to the first parent (or the empty tree for a root commit).
   */
  status: ChangedFileStatus;
}
export interface BlameChunk {
  /**
   * @maxItems 5000
   */
  blocks: BlameBlock[];
  commit: string;
  /**
   * Commits first referenced in this chunk.
   *
   * @maxItems 5000
   */
  commits: BlameCommit[];
  path: GitPath;
  totalLines: number;
}
export interface BlameBlock {
  lineCount: number;
  oid: string;
  /**
   * Path in that commit when it differs from the current path (whole-file rename).
   */
  originalPath: GitPath | null;
  /**
   * First line of this block in the commit that last changed it.
   */
  originalStartLine: number;
  /**
   * First line in the file at `commit`, 1-based.
   */
  startLine: number;
}
export interface BlameCommit {
  authorEmail: string;
  authorName: string;
  /**
   * Unix seconds.
   */
  authorTime: number;
  oid: string;
  summary: string;
  summaryTruncated: boolean;
  textLossy: boolean;
}
export interface FetchResult {
  finishedAtUnixMs: number;
  /**
   * The remotes that were fetched, in Git's order.
   *
   * @maxItems 64
   */
  remotes: string[];
}
export interface MergeConflictFile {
  baseText: string;
  leftHunks: MergeDiffHunk[];
  mode: string;
  oursText: string;
  path: GitPath;
  rightHunks: MergeDiffHunk[];
  theirsText: string;
}
export interface MergeDiffHunk {
  baseCount: number;
  baseStart: number;
  sideCount: number;
  sideStart: number;
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
  /**
   * @maxItems 8192
   */
  hiddenThroughRanges: HistoryGraphLaneRange[];
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
export interface HistoryGraphLaneRange {
  endLane: number;
  startLane: number;
}
export interface HistoryGraphSegment {
  color: number;
  fromLane: number;
  kind: HistoryGraphSegmentKind;
  toLane: number;
}
export interface HistoryDateLocation {
  cursor: string;
  offset: number;
  oid: string;
  pageSize: number;
}
export interface RepositoryNavigation {
  branchUpstreams: BranchUpstream[];
  defaultBase: DefaultBase | null;
  lastFetchUnixMs?: number | null;
  observedAtUnixMs: number;
  /**
   * @maxItems 2000
   */
  refs: RefInfo[];
  refsTruncated: boolean;
  remotes: RemoteInfo[];
  /**
   * @maxItems 128
   */
  worktrees: WorktreeInfo[];
  worktreesTruncated: boolean;
}
export interface BranchUpstream {
  refName: string;
  upstreamRefName: string;
}
export interface RemoteInfo {
  name: string;
  webUrl?: string | null;
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
