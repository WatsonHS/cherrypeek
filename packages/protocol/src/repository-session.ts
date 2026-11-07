import type {
  CommitSummary,
  ErrorCode,
  HistoryCommit,
  RecentRepository,
  RefInfo,
  RepositoryInfo,
  RepositorySessionInfo,
  RepositoryScope,
  RepositoryNavigation,
  RefMergeStatusResult,
  ResponseData,
  StoreStatus,
} from "./generated/server-message.js";

export type { RepositoryScope, RepositoryNavigation, RefMergeStatusResult } from "./generated/server-message.js";

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

export interface RefreshedRepository {
  session: RepositorySessionInfo;
  page: HistoryPage;
}

export interface RepositorySessionApi {
  openRepositorySession(path: string): Promise<RepositorySessionResult<RepositorySessionInfo>>;
  getRepositorySession(): Promise<RepositorySessionResult<RepositorySessionInfo>>;
  readSessionPreview(): Promise<RepositorySessionResult<SessionPreview>>;
  readHistoryPage(cursor: string | null, pageSize?: number): Promise<RepositorySessionResult<HistoryPage>>;
  cancelHistoryRead(): Promise<RepositorySessionResult<{ cancelled: boolean }>>;
  refreshRepositorySession(pageSize?: number): Promise<RepositorySessionResult<RefreshedRepository>>;
  recordRepositoryView(expectedGeneration: string): Promise<RepositorySessionResult<RepositoryViewRecorded>>;
  closeRepositorySession(): Promise<RepositorySessionResult<{ closed: true }>>;
  listRecentRepositories(): Promise<RepositorySessionResult<RecentRepositoriesResult>>;
  getRepositoryNavigation(): Promise<RepositorySessionResult<RepositoryNavigation>>;
  selectRepositoryScope(scope: RepositoryScope, pageSize?: number): Promise<RepositorySessionResult<RefreshedRepository>>;
  getRefMergeStatus(refNames: string[]): Promise<RepositorySessionResult<RefMergeStatusResult>>;
  cancelRefMergeStatus(): Promise<RepositorySessionResult<{ cancelled: boolean }>>;
}
