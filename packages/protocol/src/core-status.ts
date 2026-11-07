import type { CoreReady } from "./core-ready.js";
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
  /** Absolute path given with `--repository=` at launch, or null. */
  getLaunchRepository(): Promise<string | null>;
  copyText(text: string): Promise<void>;
}
