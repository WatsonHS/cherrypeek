import type { CoreReady } from "./core-ready.js";
import type { RepositorySessionApi } from "./repository-session.js";
import type { RepositoryObservationEvent } from "./repository-session.js";

export type CoreStatus =
  /** `retry` is set while a start that failed is being tried again; `reason` is the last failure. */
  | { state: "starting"; revision: number; retry?: { attempt: number; limit: number; reason: string } }
  | { state: "ready"; revision: number; core: CoreReady }
  | { state: "error"; revision: number; message: string }
  | { state: "stopped"; revision: number };

export interface CommitScopeApi extends RepositorySessionApi {
  getCoreStatus(): Promise<CoreStatus>;
  onCoreStatusChanged(listener: (status: CoreStatus) => void): () => void;
  /** Starts the core again after it ended in an error; does nothing in any other state. */
  restartCore(): Promise<void>;
  chooseRepository(): Promise<string | null>;
  /** Absolute path given with `--repository=` at launch, or null. */
  getLaunchRepository(): Promise<string | null>;
  copyText(text: string): Promise<void>;
  onRepositoryObservationChanged(listener: (event: RepositoryObservationEvent) => void): () => void;
}
