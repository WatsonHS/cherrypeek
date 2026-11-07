import type {
  CommitSummary,
  RefInfo,
  RepositoryInfo,
  RepositorySessionInfo,
  StoreStatus,
} from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositorySessionApi, RepositorySessionResult } from "../../../../../packages/protocol/src/repository-session.js";

export type RepositoryViewState = "idle" | "loading" | "ready" | "error" | "cancelled";

export interface ViewError {
  code: string;
  message: string;
  /** The path the user tried to open, when the error came from opening. */
  path?: string;
}

export interface ViewRecord {
  saved: boolean;
  status: StoreStatus | null;
  error: ViewError | null;
}

/** What the window shows. Only data from `session` is shown; a newer open replaces it as a whole. */
export interface RepositoryView {
  revision: number;
  state: RepositoryViewState;
  /** Session whose data is shown. Null when nothing is open or the core went away. */
  session: RepositorySessionInfo | null;
  repository: RepositoryInfo | null;
  refs: RefInfo[];
  refsTruncated: boolean;
  commits: CommitSummary[];
  hasMore: boolean;
  /** Error about what is shown: a failed read, or a failed open when nothing else is shown. */
  error: ViewError | null;
  /** Path being opened while the current repository stays on screen. */
  opening: string | null;
  /** A failed open that left the current repository in place. */
  notice: ViewError | null;
  /** Result of the latest "viewed" record for this session. */
  record: ViewRecord | null;
}

export type SessionApi = Pick<RepositorySessionApi,
  "openRepositorySession" | "getRepositorySession" | "readSessionPreview" | "recordRepositoryView" | "closeRepositorySession">;

function emptyView(revision: number, state: RepositoryViewState = "idle"): RepositoryView {
  return {
    revision, state, session: null, repository: null, refs: [], refsTruncated: false, commits: [], hasMore: false,
    error: null, opening: null, notice: null, record: null,
  };
}

/**
 * Drives the repository session from the renderer. Every open bumps `operation`;
 * results that arrive for an older operation are dropped so they never overwrite the current view.
 */
export class RepositorySessionStore {
  private view = emptyView(0);
  private readonly listeners = new Set<() => void>();
  private operation = 0;
  private recording?: { session: RepositorySessionInfo; done: Promise<void> };
  private shownSession?: RepositorySessionInfo;

  constructor(private readonly api: SessionApi) {}

  getView = (): RepositoryView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async open(path: string): Promise<void> {
    const operation = ++this.operation;
    const previous = this.view;
    const keep = previous.state === "ready" && previous.session !== null ? previous.session : null;
    this.update(keep ? { ...previous, opening: path, notice: null } : { ...emptyView(0, "loading"), opening: path });

    // The shown repository counts as viewed when the user switches away from it.
    if (keep) await this.recordView();
    if (operation !== this.operation) return;

    const opened = await settle(this.api.openRepositorySession(path));
    if (operation !== this.operation) return;
    if (!opened.ok) {
      await this.openFailed(operation, { ...opened.error, path }, keep);
      return;
    }
    const session = opened.value;
    this.update({ ...emptyView(0, "loading"), session, repository: session.repository });
    await this.read(operation, session);
  }

  /** Re-reads the first page of the current session after a failed read. */
  async retry(): Promise<void> {
    const { session, state } = this.view;
    if (!session || state !== "error") return;
    const operation = ++this.operation;
    this.update({ ...this.view, state: "loading", error: null });
    await this.read(operation, session);
  }

  /** Stops opening or reading. The session API can only stop by closing, so this closes the repository. */
  async cancel(): Promise<void> {
    if (this.view.state !== "loading" && this.view.opening === null) return;
    const operation = ++this.operation;
    this.update(emptyView(0, "cancelled"));
    const closed = await settle(this.api.closeRepositorySession());
    if (operation !== this.operation || closed.ok) return;
    this.update({ ...this.view, error: closed.error });
  }

  dismissNotice(): void {
    if (this.view.notice) this.update({ ...this.view, notice: null });
  }

  /** Records the first time a session's content is on screen while the window has focus. */
  async markShown(): Promise<void> {
    const { session, state } = this.view;
    if (!session || state !== "ready" || this.shownSession === session) return;
    this.shownSession = session;
    await this.recordView();
  }

  /** Saves the shown session's HEAD as viewed. Only content that reached the screen is recorded. */
  async recordView(): Promise<void> {
    const { session, state } = this.view;
    if (!session || state !== "ready") return;
    if (this.recording?.session === session) return this.recording.done;
    const done = (async () => {
      const result = await settle(this.api.recordRepositoryView());
      if (this.view.session !== session) return;
      this.update({
        ...this.view,
        record: result.ok
          ? { saved: result.value.saved, status: result.value.status, error: null }
          : { saved: false, status: null, error: result.error },
      });
    })();
    this.recording = { session, done };
    try { await done; } finally { if (this.recording?.done === done) this.recording = undefined; }
  }

  /** The core stopped: its sessions are gone. Keep shown data, stop anything in flight. */
  coreUnavailable(): void {
    const view = this.view;
    if (!view.session && view.opening === null && view.state !== "loading") return;
    this.operation += 1;
    if (view.state === "ready") {
      this.update({ ...view, session: null, opening: null });
      return;
    }
    this.update({ ...view, session: null, opening: null, state: "error", error: { code: "CORE_EXITED", message: "核心已退出，仓库读取已停止" } });
  }

  private async read(operation: number, session: RepositorySessionInfo): Promise<void> {
    const preview = await settle(this.api.readSessionPreview());
    if (operation !== this.operation) return;
    if (!preview.ok) {
      this.update({ ...this.view, state: "error", error: preview.error });
      return;
    }
    const { repository, refs, refsTruncated, commits, hasMore } = preview.value;
    this.update({ ...emptyView(0, "ready"), session, repository, refs, refsTruncated, commits, hasMore });
  }

  private async openFailed(operation: number, error: ViewError, kept: RepositorySessionInfo | null): Promise<void> {
    // A failed open leaves the previous session in place; confirm before keeping it on screen.
    if (kept) {
      const current = await settle(this.api.getRepositorySession());
      if (operation !== this.operation) return;
      if (current.ok && current.value.repoId === kept.repoId && current.value.generation === kept.generation) {
        this.update({ ...this.view, opening: null, notice: error });
        return;
      }
    }
    this.update({ ...emptyView(0, "error"), error });
  }

  private update(next: RepositoryView): void {
    this.view = { ...next, revision: this.view.revision + 1 };
    for (const listener of this.listeners) listener();
  }
}

/** Turns IPC rejections into the same result shape the session API uses. */
export async function settle<T>(promise: Promise<RepositorySessionResult<T>>): Promise<RepositorySessionResult<T>> {
  try {
    return await promise;
  } catch (error) {
    return { ok: false, error: { code: "PROTOCOL_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false } };
  }
}
