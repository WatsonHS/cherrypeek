import type { CoreReady } from "./core-ready.js";
import type { RepositoryPreviewState } from "./repository-preview.js";
import type { RepositorySessionApi } from "./repository-session.js";

export type CoreStatus =
  | { state: "starting"; revision: number }
  | { state: "ready"; revision: number; core: CoreReady }
  | { state: "error"; revision: number; message: string }
  | { state: "stopped"; revision: number };

export interface CommitScopeApi extends RepositorySessionApi {
  getCoreStatus(): Promise<CoreStatus>;
  onCoreStatusChanged(listener: (status: CoreStatus) => void): () => void;
  chooseRepository(): Promise<string | null>;
  openRepositoryPreview(path: string): Promise<void>;
  cancelRepositoryPreview(): Promise<void>;
  getRepositoryPreview(): Promise<RepositoryPreviewState>;
  onRepositoryPreviewChanged(listener: (state: RepositoryPreviewState) => void): () => void;
  copyText(text: string): Promise<void>;
}
