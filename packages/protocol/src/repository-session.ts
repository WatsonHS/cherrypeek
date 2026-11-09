import type {
  CommitSummary,
  MetadataIndexStatus,
  SearchPage,
  SearchIdentities,
  SearchIdentity,
  SearchPaths,
  SearchPathEntry,
  SearchPathMatch,
  ActivityStats,
  RepositoryObservation,
  RefSnapshotDiff,
  HandoffFacts,
  ErrorCode,
  HistoryCommit,
  RecentRepository,
  RefInfo,
  RepositoryInfo,
  RepositorySessionInfo,
  CommitDetails,
  ChangedFilesPage,
  MergeCommitsPage,
  BranchesContainingResult,
  FileDiff,
  WorkspaceDiff,
  WorkspaceFile,
  WorkspaceStatus,
  TreePage,
  FileContent,
  FileHistoryPage,
  BlameChunk,
  RepositoryScope,
  RepositoryNavigation,
  RefMergeStatusResult,
  ResponseData,
  StoreStatus,
} from "./generated/server-message.js";
import type { MetadataIndexAction } from "./generated/client-message.js";
import type { SearchCommitsParams, SearchIdentitiesParams, SearchQuery, SearchTimeField,
  ListSearchPathsParams, SearchPathFilter, SearchPathKind, GetActivityStatsParams, GetHandoffFactsParams,
  GetCommitParams, ListChangedFilesParams, ReadMergeCommitsParams, BranchesContainingParams, ReadDiffParams,
  ReadWorkspaceStatusParams, ReadWorkspaceDiffParams, ReadWorkspaceFileParams,
  ListTreeParams, ReadFileContentParams, ReadFileHistoryParams, ReadFileChangeParams, ListPathChangesParams, ReadBlameParams } from "./generated/client-message.js";

export type { RepositoryScope, RepositoryNavigation, RefMergeStatusResult } from "./generated/server-message.js";
export type { HistoryGraph, HistoryGraphSegment, HistoryGraphSegmentKind } from "./generated/server-message.js";
export type { MetadataIndexAction } from "./generated/client-message.js";
export type { MetadataIndexStatus } from "./generated/server-message.js";
export type { SearchPage, SearchIdentities, SearchIdentity } from "./generated/server-message.js";
export type { SearchPaths, SearchPathEntry, SearchPathMatch } from "./generated/server-message.js";
export type { ActivityStats, ActivityDay, ActivityAuthor, RepositoryObservation, RefSnapshotDiff, RefSnapshotChange, HandoffFacts, HandoffParentGroup } from "./generated/server-message.js";
export type { CommitDetails, ChangedFilesPage, ChangedFile, ChangeOverview, MergeCommitsPage, BranchesContainingResult, FileDiff, GitPath, Trailer } from "./generated/server-message.js";
export type { SearchCommitsParams, SearchIdentitiesParams, SearchQuery, SearchTimeField, SearchPathFilter, SearchPathKind, ListSearchPathsParams } from "./generated/client-message.js";
export type { GetActivityStatsParams, GetHandoffFactsParams } from "./generated/client-message.js";
export type { GetCommitParams, ListChangedFilesParams, ReadMergeCommitsParams, BranchesContainingParams, ReadDiffParams } from "./generated/client-message.js";
export type { ReadWorkspaceStatusParams, ReadWorkspaceDiffParams, ReadWorkspaceFileParams, WorkspaceSide } from "./generated/client-message.js";
export type { ListTreeParams, ReadFileContentParams, ReadFileHistoryParams, ReadFileChangeParams, ListPathChangesParams, ReadBlameParams } from "./generated/client-message.js";

export type RepositorySessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ErrorCode; message: string; retryable: boolean } };

export interface SessionPreview {
  repository: RepositoryInfo;
  refs: RefInfo[];
  refsTruncated: boolean;
  commits: CommitSummary[];
  hasMore: boolean;
}

export interface RepositoryViewRecorded {
  saved: boolean;
  status: StoreStatus;
}

export interface RecentRepositoriesResult {
  repositories: RecentRepository[];
  status: StoreStatus;
}

type HistoryPageData = Extract<ResponseData, { section: "historyPage" }>;

export interface HistoryPage {
  repository: RepositoryInfo;
  refs: RefInfo[];
  refsTruncated: boolean;
  commits: HistoryCommit[];
  offset: HistoryPageData["offset"];
  pageSize: HistoryPageData["pageSize"];
  cursor: HistoryPageData["cursor"];
  previousCursor: HistoryPageData["previousCursor"];
  nextCursor: string | null;
  hasMore: HistoryPageData["hasMore"];
  newSinceLastSeenStatus: HistoryPageData["newSinceLastSeenStatus"];
  lastSeenDividerOid: HistoryPageData["lastSeenDividerOid"];
}

export type HistoryPageContent = Omit<HistoryPage, "repository" | "refs" | "refsTruncated">;

export interface HistoryDateLocation {
  oid: string;
  cursor: string;
  offset: number;
  pageSize: number;
  page: HistoryPageContent | null;
}

export interface RefreshedRepository {
  session: RepositorySessionInfo;
  page: HistoryPage;
}

export interface WorkspaceChangeEvent {
  repoId: string;
}

/** One chunk of a blame stream, tagged with the id the renderer passed to `readBlame`. */
export interface BlameChunkEvent {
  streamId: string;
  chunk: BlameChunk;
}

export interface RepositoryObservationEvent {
  repoId: string;
  browsingGeneration: string;
  observation: RepositoryObservation;
}

export interface RepositorySessionApi {
  openRepositorySession(path: string): Promise<RepositorySessionResult<RepositorySessionInfo>>;
  getRepositorySession(): Promise<RepositorySessionResult<RepositorySessionInfo>>;
  readSessionPreview(): Promise<RepositorySessionResult<SessionPreview>>;
  readHistoryPage(cursor: string | null, pageSize?: number, contentOnly?: false): Promise<RepositorySessionResult<HistoryPage>>;
  readHistoryPage(cursor: string | null, pageSize: number, contentOnly: true): Promise<RepositorySessionResult<HistoryPageContent>>;
  locateCommit(oid: string, pageSize?: number): Promise<RepositorySessionResult<HistoryPage>>;
  locateHistoryDate(beforeTimestamp: number, pageSize?: number, knownCursors?: string[]): Promise<RepositorySessionResult<HistoryDateLocation>>;
  cancelHistoryRead(): Promise<RepositorySessionResult<{ cancelled: boolean }>>;
  refreshRepositorySession(pageSize?: number): Promise<RepositorySessionResult<RefreshedRepository>>;
  recordRepositoryView(expectedGeneration: string): Promise<RepositorySessionResult<RepositoryViewRecorded>>;
  closeRepositorySession(): Promise<RepositorySessionResult<{ closed: true }>>;
  listRecentRepositories(): Promise<RepositorySessionResult<RecentRepositoriesResult>>;
  getRepositoryNavigation(): Promise<RepositorySessionResult<RepositoryNavigation>>;
  selectRepositoryScope(scope: RepositoryScope, pageSize?: number): Promise<RepositorySessionResult<RefreshedRepository>>;
  getRefMergeStatus(refNames: string[]): Promise<RepositorySessionResult<RefMergeStatusResult>>;
  cancelRefMergeStatus(): Promise<RepositorySessionResult<{ cancelled: boolean }>>;
  getMetadataIndexStatus(): Promise<RepositorySessionResult<MetadataIndexStatus>>;
  controlMetadataIndex(action: MetadataIndexAction): Promise<RepositorySessionResult<MetadataIndexStatus>>;
  searchCommits(params: SearchCommitsParams): Promise<RepositorySessionResult<SearchPage>>;
  listSearchIdentities(params: SearchIdentitiesParams): Promise<RepositorySessionResult<SearchIdentities>>;
  listSearchPaths(params: ListSearchPathsParams): Promise<RepositorySessionResult<SearchPaths>>;
  cancelSearch(): Promise<RepositorySessionResult<{ cancelled: boolean }>>;
  getActivityStats(params: GetActivityStatsParams): Promise<RepositorySessionResult<ActivityStats>>;
  cancelActivityStats(): Promise<RepositorySessionResult<{ cancelled: boolean }>>;
  observeRepository(): Promise<RepositorySessionResult<RepositoryObservation>>;
  cancelRepositoryObservation(): Promise<RepositorySessionResult<{ cancelled: boolean }>>;
  diffRefSnapshots(): Promise<RepositorySessionResult<RefSnapshotDiff>>;
  cancelRefSnapshotDiff(): Promise<RepositorySessionResult<{ cancelled: boolean }>>;
  getHandoffFacts(params: GetHandoffFactsParams): Promise<RepositorySessionResult<HandoffFacts>>;
  cancelHandoffFacts(): Promise<RepositorySessionResult<{ cancelled: boolean }>>;
  getCommit(params: GetCommitParams): Promise<RepositorySessionResult<CommitDetails>>;
  listChangedFiles(params: ListChangedFilesParams): Promise<RepositorySessionResult<ChangedFilesPage>>;
  readMergeCommits(params: ReadMergeCommitsParams): Promise<RepositorySessionResult<MergeCommitsPage>>;
  branchesContaining(params: BranchesContainingParams): Promise<RepositorySessionResult<BranchesContainingResult>>;
  readDiff(params: ReadDiffParams): Promise<RepositorySessionResult<FileDiff>>;
  cancelCommitDetails(): Promise<RepositorySessionResult<{ cancelled: boolean }>>;
  /** P4-09: the window's working tree. Fails with UNKNOWN_METHOD until the core declares `workspaceStatus`. */
  readWorkspaceStatus(params: ReadWorkspaceStatusParams): Promise<RepositorySessionResult<WorkspaceStatus>>;
  readWorkspaceDiff(params: ReadWorkspaceDiffParams): Promise<RepositorySessionResult<WorkspaceDiff>>;
  readWorkspaceFile(params: ReadWorkspaceFileParams): Promise<RepositorySessionResult<WorkspaceFile>>;
  cancelWorkspace(): Promise<RepositorySessionResult<{ cancelled: boolean }>>;
  /** A hint that files in the working tree changed; the status must be re-read to know what changed. */
  onWorkspaceChanged(listener: (change: WorkspaceChangeEvent) => void): () => void;
  /** P4-10: the files page. These fail with UNKNOWN_METHOD until the core declares `fileBrowsing`. */
  listTree(params: ListTreeParams): Promise<RepositorySessionResult<TreePage>>;
  readFileContent(params: ReadFileContentParams): Promise<RepositorySessionResult<FileContent>>;
  readFileHistory(params: ReadFileHistoryParams): Promise<RepositorySessionResult<FileHistoryPage>>;
  readFileChange(params: ReadFileChangeParams): Promise<RepositorySessionResult<FileDiff>>;
  /** Files a commit changed under one directory (empty pathHex: the whole repository), one page at a time. */
  listPathChanges(params: ListPathChangesParams): Promise<RepositorySessionResult<ChangedFilesPage>>;
  /** A commit's full details for the files page's change view; its own channel, so commit page reads are not cancelled. */
  readCommitInfo(params: GetCommitParams): Promise<RepositorySessionResult<CommitDetails>>;
  cancelFiles(): Promise<RepositorySessionResult<{ cancelled: boolean }>>;
  /** P4-12: chunks arrive through `onBlameChunk` with the same `streamId`; the result resolves when the file is covered. */
  readBlame(params: ReadBlameParams, streamId: string): Promise<RepositorySessionResult<{ totalLines: number; blocks: number }>>;
  onBlameChunk(listener: (event: BlameChunkEvent) => void): () => void;
}
