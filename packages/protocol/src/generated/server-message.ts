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
export type Capability = "getRuntimeInfo" | "readRepositoryPreview" | "repositorySessions" | "historyPagination";
export type ResponseData =
  | {
      coreVersion: string;
      pid: number;
      section: "core";
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
      commits: CommitSummary[];
      cursor: string;
      hasMore: boolean;
      offset: number;
      pageSize: number;
      previousCursor: string | null;
      section: "historyPage";
    };
export type RefKind = "localBranch" | "remoteBranch" | "tag";
export type StoreStatus = "ok" | "disabled" | "unavailable" | "corrupt";
export type RepositoryScope = "head";
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
  | "SNAPSHOT_CHANGED";

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
export interface RefInfo {
  kind: RefKind;
  name: string;
  oid: string;
  peeledOid: string | null;
  symbolicTarget: string | null;
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
export interface RepositorySessionInfo {
  generation: string;
  observedAtUnixMs: number;
  persistence: SessionPersistenceStatus;
  previousView: LastViewedSnapshot | null;
  repoId: string;
  repository: RepositoryInfo;
  repositoryKey: string;
  scope: RepositoryScope;
  worktreeId: string;
}
export interface SessionPersistenceStatus {
  lastSeen: StoreStatus;
  recent: StoreStatus;
}
export interface LastViewedSnapshot {
  /**
   * @maxItems 1
   */
  tips: [] | [string];
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
