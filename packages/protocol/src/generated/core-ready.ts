/* Generated from Rust protocol types. Do not edit by hand. */

export type Capability = "getRuntimeInfo" | "readRepositoryPreview" | "repositorySessions" | "historyPagination";

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
