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
export type Capability = "getRuntimeInfo" | "readRepositoryPreview";
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
    };
export type RefKind = "localBranch" | "remoteBranch" | "tag";
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
  | "GIT_ERROR";

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
