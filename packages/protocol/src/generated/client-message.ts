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
  EmptyParams | ReadRepositoryPreviewParams | OpenRepositoryParams | ReadHistoryPageParams | RefreshRepositoryParams;

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
