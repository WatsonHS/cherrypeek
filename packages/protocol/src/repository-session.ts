import type {
  CommitSummary,
  ErrorCode,
  RecentRepository,
  RefInfo,
  RepositoryInfo,
  RepositorySessionInfo,
  ResponseData,
  StoreStatus,
} from "./generated/server-message.js";

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
  commits: CommitSummary[];
  offset: HistoryPageData["offset"];
  pageSize: HistoryPageData["pageSize"];
  cursor: HistoryPageData["cursor"];
  previousCursor: HistoryPageData["previousCursor"];
  nextCursor: string | null;
  hasMore: HistoryPageData["hasMore"];
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
}
