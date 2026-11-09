import type { CommitDetails, ChangedFilesPage, ChangedFile, FileDiff, MergeCommitsPage, BranchesContainingResult } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositorySessionApi, RepositorySessionResult } from "../../../../../packages/protocol/src/repository-session.js";

export type DetailLoadState = "idle" | "loading" | "ready" | "error";
export interface DetailLoad<T> {
  state: DetailLoadState;
  value: T | null;
  error: { code: string; message: string } | null;
}

export interface CommitDetailView {
  sessionKey: string | null;
  oid: string | undefined;
  detailsSessionKey: string | null;
  details: DetailLoad<CommitDetails>;
  files: DetailLoad<ChangedFilesPage>;
  fileParentIndex: number | null;
  fileOffset: number;
  diff: DetailLoad<FileDiff>;
  diffKey: string | null;
  /** The file was over the whole-file limit, so `diff` holds only the changes. */
  diffFullFileLimited: boolean;
  merge: DetailLoad<MergeCommitsPage>;
  mergeParentIndex: number | null;
  mergeOffset: number;
  containing: DetailLoad<BranchesContainingResult>;
}

export type CommitDetailApi = Pick<RepositorySessionApi,
  "getCommit" | "listChangedFiles" | "readMergeCommits" | "branchesContaining" | "readDiff" | "cancelCommitDetails">;

const PAGE_SIZE = 200;
const idle = <T>(): DetailLoad<T> => ({ state: "idle", value: null, error: null });
const initialView = (): CommitDetailView => ({
  sessionKey: null, oid: undefined, detailsSessionKey: null, details: idle(), files: idle(), fileParentIndex: null, fileOffset: 0,
  diff: idle(), diffKey: null, diffFullFileLimited: false, merge: idle(), mergeParentIndex: null, mergeOffset: 0, containing: idle(),
});

export class CommitDetailStore {
  private view = initialView();
  private readonly listeners = new Set<() => void>();
  private selectionIntent = 0;
  private sequenceIntent = 0;
  private requestIntent = 0;
  private activeRequest?: Promise<unknown>;
  private activeKind?: "details" | "files" | "merge" | "containing" | "diff";
  private retryKind?: "details" | "files" | "merge" | "containing" | "diff";
  private requestTail: Promise<void> = Promise.resolve();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryWake?: () => void;

  private diffFile: { file: ChangedFile; parentIndex: number | null } | null = null;

  /** `fullFile` says whether the open diff should carry the whole file as context (P4-11). */
  constructor(private readonly api: CommitDetailApi, private readonly fullFile: () => boolean = () => false) {}

  /** Re-reads the open diff, e.g. after switching between changes-only and the whole file. */
  async reloadDiff(): Promise<void> {
    const open = this.diffFile;
    if (!open || !this.view.diffKey || this.view.diff.state === "idle") return;
    this.update({ ...this.view, diffKey: null });
    await this.toggleDiff(open.file, open.parentIndex);
  }

  getView = (): CommitDetailView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  bind(sessionKey: string | null, oid: string | undefined, selectionIsLoaded = true): void {
    const sameSelection = sessionKey === this.view.sessionKey && oid === this.view.oid;
    const staleSelectionNowLoaded = sameSelection && selectionIsLoaded && Boolean(this.view.details.value && this.view.detailsSessionKey !== sessionKey);
    if (sameSelection && !staleSelectionNowLoaded) return;
    const selection = ++this.selectionIntent;
    const sequence = ++this.sequenceIntent;
    const preserveOld = Boolean(oid && oid === this.view.oid && this.view.details.value && this.view.detailsSessionKey && !selectionIsLoaded);
    if (preserveOld) {
      this.update({
        ...this.view,
        sessionKey,
        oid,
        details: settled(this.view.details),
        files: settled(this.view.files),
        diff: settled(this.view.diff),
        merge: settled(this.view.merge),
        containing: settled(this.view.containing),
      });
      void this.cancelActiveRequest();
      return;
    }
    const details = oid ? { state: "loading" as const, value: null, error: null } : idle<CommitDetails>();
    this.update({
      ...initialView(), sessionKey, oid,
      detailsSessionKey: null,
      details,
    });
    void this.loadSelection(selection, sequence, sessionKey, oid);
  }

  async loadFiles(parentIndex: number | null, offset = 0): Promise<void> {
    const { sessionKey, oid, details } = this.view;
    if (!sessionKey || !oid || !this.hasCurrentContextDetails() || !details.value || !isValidFileParent(parentIndex, details.value.commit.parents.length) || !validOffset(offset)) return;
    const selection = this.selectionIntent;
    const sequence = ++this.sequenceIntent;
    this.view = { ...this.view, fileParentIndex: parentIndex, fileOffset: offset,
      files: { ...this.view.files, state: "loading", error: null }, diff: idle(), diffKey: null };
    this.emit();
    await this.cancelActiveRequest("files");
    if (!this.isCurrent(selection, sequence, sessionKey, oid)) return;
    await this.readFiles(selection, sequence, sessionKey, oid, parentIndex, offset);
    if (this.isCurrent(selection, sequence, sessionKey, oid)) await this.loadDefaultMergeIfNeeded(selection, sequence, sessionKey, oid);
  }

  async loadMerge(parentIndex: number, offset = 0): Promise<void> {
    const { sessionKey, oid, details } = this.view;
    if (!sessionKey || !oid || !this.hasCurrentContextDetails() || !details.value || details.value.commit.parents.length < 2 ||
      !Number.isInteger(parentIndex) || parentIndex < 1 || parentIndex >= details.value.commit.parents.length || !validOffset(offset)) return;
    const selection = this.selectionIntent;
    const sequence = ++this.sequenceIntent;
    this.view = { ...this.view, mergeParentIndex: parentIndex, mergeOffset: offset,
      merge: { ...this.view.merge, state: "loading", error: null } };
    this.emit();
    await this.cancelActiveRequest("merge");
    if (!this.isCurrent(selection, sequence, sessionKey, oid)) return;
    await this.readMerge(selection, sequence, sessionKey, oid, parentIndex, offset);
  }

  async loadContaining(): Promise<void> {
    const { sessionKey, oid } = this.view;
    if (!sessionKey || !oid || !this.hasCurrentContextDetails() || this.view.containing.state === "loading") return;
    const selection = this.selectionIntent;
    const sequence = ++this.sequenceIntent;
    this.view = { ...this.view, containing: { ...this.view.containing, state: "loading", error: null } };
    this.emit();
    await this.cancelActiveRequest("containing");
    if (!this.isCurrent(selection, sequence, sessionKey, oid)) return;
    this.view = { ...this.view, containing: { ...this.view.containing, state: "loading", error: null } };
    this.emit();
    await this.perform(selection, sequence, sessionKey, oid, "containing", () => this.api.branchesContaining({ oid }), result => {
      this.update({ ...this.view, containing: ready(result) });
    });
    if (this.isCurrent(selection, sequence, sessionKey, oid)) await this.loadDefaultMergeIfNeeded(selection, sequence, sessionKey, oid);
  }

  async retryDetails(): Promise<void> {
    const { sessionKey, oid } = this.view;
    if (!sessionKey || !oid) return;
    const selection = this.selectionIntent;
    const sequence = ++this.sequenceIntent;
    this.view = { ...this.view, details: { ...this.view.details, state: "loading", error: null } };
    this.emit();
    await this.cancelActiveRequest("details");
    if (!this.isCurrent(selection, sequence, sessionKey, oid)) return;
    await this.readDetails(selection, sequence, sessionKey, oid, true);
    if (this.isCurrent(selection, sequence, sessionKey, oid)) {
      const { fileParentIndex, fileOffset } = this.view;
      if (this.view.files.state === "error" || !this.view.files.value) await this.readFiles(selection, sequence, sessionKey, oid, fileParentIndex, fileOffset);
      await this.loadDefaultMergeIfNeeded(selection, sequence, sessionKey, oid);
    }
  }

  async retryFiles(): Promise<void> {
    await this.loadFiles(this.view.fileParentIndex, this.view.fileOffset);
  }

  async retryMerge(): Promise<void> {
    const parent = this.view.mergeParentIndex;
    if (parent !== null) await this.loadMerge(parent, this.view.mergeOffset);
  }

  async retryContaining(): Promise<void> {
    const previous = this.view.containing;
    this.view = { ...this.view, containing: { ...previous, state: "idle", error: null } };
    this.emit();
    await this.loadContaining();
  }

  async toggleDiff(file: ChangedFile, parentIndex: number | null): Promise<void> {
    const { sessionKey, oid, files } = this.view;
    if (!sessionKey || !oid || files.state === "loading" || !files.value ||
      files.value.parentIndex !== parentIndex) return;
    const oldPathHex = file.oldPath?.rawHex ?? null;
    const newPathHex = file.newPath?.rawHex ?? null;
    const key = `${parentIndex ?? "root"}:${oldPathHex ?? "-"}:${newPathHex ?? "-"}`;
    if (this.view.diffKey === key && this.view.diff.state === "ready") {
      await this.closeDiff();
      return;
    }
    if (this.view.diffKey === key && this.view.diff.state === "loading") {
      await this.closeDiff();
      return;
    }
    if (!this.hasCurrentContextDetails()) return;
    const selection = this.selectionIntent;
    const sequence = ++this.sequenceIntent;
    this.diffFile = { file, parentIndex };
    this.update({ ...this.view, diff: { state: "loading", value: null, error: null }, diffKey: key, diffFullFileLimited: false });
    await this.cancelActiveRequest("diff");
    if (!this.isCurrent(selection, sequence, sessionKey, oid) || this.view.diffKey !== key) return;
    this.view = { ...this.view, diff: { state: "loading", value: null, error: null }, diffKey: key };
    this.emit();
    const full = this.fullFile();
    let limited = false;
    await this.perform(selection, sequence, sessionKey, oid, "diff", async () => {
      const result = await this.api.readDiff({ oid, parentIndex, oldPathHex, newPathHex, ...(full ? { fullFile: true } : {}) });
      // Files over the whole-file limit fall back to the changes only, and the view says so.
      if (!full || result.ok || result.error.code !== "RESOURCE_LIMIT") return result;
      limited = true;
      return this.api.readDiff({ oid, parentIndex, oldPathHex, newPathHex });
    }, result => {
      this.update({ ...this.view, diff: ready(result), diffKey: key, diffFullFileLimited: limited });
    });
  }

  async closeDiff(): Promise<void> {
    if (this.view.diff.state === "idle" && this.view.diffKey === null) return;
    ++this.sequenceIntent;
    ++this.requestIntent;
    this.update({ ...this.view, diff: idle(), diffKey: null });
    await this.cancelActiveRequest();
  }

  /** Refresh only the reachability/update hint; keep the selected file and merge pages intact. */
  async refreshUpdate(): Promise<void> {
    const { sessionKey, oid, details } = this.view;
    if (!sessionKey || !oid || !this.hasCurrentContextDetails() || !details.value || this.activeRequest) return;
    const selection = this.selectionIntent;
    const sequence = this.sequenceIntent;
    await this.perform(selection, sequence, sessionKey, oid, "details", () => this.api.getCommit({ oid }), result => {
      if (this.view.details.value?.commit.oid === oid && this.view.detailsSessionKey === sessionKey) {
        this.update({ ...this.view, details: ready(result), detailsSessionKey: sessionKey });
      }
    }, true);
  }

  async cancel(): Promise<void> {
    const selection = this.selectionIntent;
    const sessionKey = this.view.sessionKey;
    const oid = this.view.oid;
    ++this.sequenceIntent;
    const sequence = this.sequenceIntent;
    ++this.requestIntent;
    await this.cancelActiveRequest();
    if (selection !== this.selectionIntent || sequence !== this.sequenceIntent || sessionKey !== this.view.sessionKey || oid !== this.view.oid) return;
    this.update({
      ...this.view,
      details: settled(this.view.details), files: settled(this.view.files), merge: settled(this.view.merge),
      containing: settled(this.view.containing), diff: settled(this.view.diff),
    });
  }

  private async loadSelection(selection: number, sequence: number, sessionKey: string | null, oid: string | undefined): Promise<void> {
    await this.cancelActiveRequest("details");
    if (!sessionKey || !oid || !this.isCurrent(selection, sequence, sessionKey, oid)) return;
    const details = await this.readDetails(selection, sequence, sessionKey, oid, false);
    if (!details || !this.isCurrent(selection, sequence, sessionKey, oid)) return;
    const parentIndex = details.commit.parents.length ? 0 : null;
    this.view = { ...this.view, fileParentIndex: parentIndex, fileOffset: 0,
      files: { state: "loading", value: null, error: null } };
    this.emit();
    await this.readFiles(selection, sequence, sessionKey, oid, parentIndex, 0);
    if (this.isCurrent(selection, sequence, sessionKey, oid)) await this.loadDefaultMergeIfNeeded(selection, sequence, sessionKey, oid);
  }

  private async readDetails(selection: number, sequence: number, sessionKey: string, oid: string, keepPages: boolean): Promise<CommitDetails | null> {
    this.view = { ...this.view, details: { ...this.view.details, state: "loading", error: null } };
    this.emit();
    return await this.perform(selection, sequence, sessionKey, oid, "details", () => this.api.getCommit({ oid }), result => {
      const sameContext = this.view.detailsSessionKey === sessionKey;
      this.update({ ...this.view, details: ready(result), detailsSessionKey: sessionKey,
        files: keepPages && sameContext ? this.view.files : idle(), merge: keepPages && sameContext ? this.view.merge : idle(),
        containing: keepPages && sameContext ? this.view.containing : idle(),
        fileParentIndex: keepPages && sameContext ? this.view.fileParentIndex : result.commit.parents.length ? 0 : null,
        fileOffset: keepPages && sameContext ? this.view.fileOffset : 0,
        mergeParentIndex: keepPages && sameContext ? this.view.mergeParentIndex : result.commit.parents.length > 1 ? 1 : null,
        mergeOffset: keepPages && sameContext ? this.view.mergeOffset : 0,
      });
    });
  }

  private async readFiles(selection: number, sequence: number, sessionKey: string, oid: string, parentIndex: number | null, offset: number): Promise<void> {
    this.view = { ...this.view, fileParentIndex: parentIndex, fileOffset: offset,
      files: { ...this.view.files, state: "loading", error: null } };
    this.emit();
    await this.perform(selection, sequence, sessionKey, oid, "files", () => this.api.listChangedFiles({ oid, parentIndex, offset, pageSize: PAGE_SIZE }), result => {
      this.update({ ...this.view, files: ready(result) });
    });
  }

  private async readMerge(selection: number, sequence: number, sessionKey: string, oid: string, parentIndex: number, offset: number): Promise<void> {
    this.view = { ...this.view, mergeParentIndex: parentIndex, mergeOffset: offset,
      merge: { ...this.view.merge, state: "loading", error: null } };
    this.emit();
    await this.perform(selection, sequence, sessionKey, oid, "merge", () => this.api.readMergeCommits({ oid, parentIndex, offset, pageSize: PAGE_SIZE }), result => {
      this.update({ ...this.view, merge: ready(result) });
    });
  }

  private async loadDefaultMergeIfNeeded(selection: number, sequence: number, sessionKey: string, oid: string): Promise<void> {
    const { details, mergeParentIndex } = this.view;
    if (!this.isCurrent(selection, sequence, sessionKey, oid) || !details.value || details.value.commit.parents.length <= 1) return;
    const parentIndex = mergeParentIndex ?? 1;
    if (this.view.merge.value?.parentIndex === parentIndex || this.view.merge.state === "loading") return;
    await this.readMerge(selection, sequence, sessionKey, oid, parentIndex, this.view.mergeOffset);
  }

  private async perform<T>(
    selection: number,
    sequence: number,
    sessionKey: string,
    oid: string,
    kind: "details" | "files" | "merge" | "containing" | "diff",
    request: () => Promise<RepositorySessionResult<T>>,
    accept: (value: T) => void,
    quietCancel = false,
  ): Promise<T | null> {
    const retryKind = this.retryKind;
    this.cancelRetryWait();
    if (retryKind && retryKind !== kind) this.settleLoadingKind(retryKind);
    const requestIntent = ++this.requestIntent;
    const work = this.requestTail.catch(() => undefined).then(async () => {
      if (!this.isRequestCurrent(selection, sequence, requestIntent, sessionKey, oid)) return null;
      const retryDelays = [250, 500, 1_000, 1_000];
      let retries = 0;
      while (this.isRequestCurrent(selection, sequence, requestIntent, sessionKey, oid)) {
        let pending: Promise<RepositorySessionResult<T>> | undefined;
        let requestError: { code: string; message: string } | null = null;
        try {
          pending = request();
          this.activeRequest = pending;
          this.activeKind = kind;
          const result = await pending;
          if (!this.isRequestCurrent(selection, sequence, requestIntent, sessionKey, oid)) return null;
          if (result.ok) {
            accept(result.value);
            return result.value;
          }
          requestError = result.error;
        } catch (error) {
          if (!this.isRequestCurrent(selection, sequence, requestIntent, sessionKey, oid)) return null;
          requestError = normalizeError(error);
        } finally {
          if (pending && this.activeRequest === pending) {
            this.activeRequest = undefined;
            this.activeKind = undefined;
          }
        }
        if (!requestError || !this.isRequestCurrent(selection, sequence, requestIntent, sessionKey, oid)) return null;
        if (requestError.code === "BUSY" && retries < retryDelays.length) {
          this.retryKind = kind;
          const resume = await this.waitForRetry(retryDelays[retries++]!);
          if (this.retryKind === kind) this.retryKind = undefined;
          if (!resume || !this.isRequestCurrent(selection, sequence, requestIntent, sessionKey, oid)) return null;
          continue;
        }
        if (!(quietCancel && requestError.code === "CANCELLED")) {
          this.setError(kind, requestError.code === "BUSY"
            ? { ...requestError, message: "读取暂时繁忙，请稍后重试" }
            : requestError);
        }
        return null;
      }
      return null;
    });
    this.requestTail = work.then(() => undefined, () => undefined);
    return await work;
  }

  private setError(kind: "details" | "files" | "merge" | "containing" | "diff", error: { code: string; message: string }): void {
    if (kind === "details") this.update({ ...this.view, details: { ...this.view.details, state: "error", error } });
    else if (kind === "files") this.update({ ...this.view, files: { ...this.view.files, state: "error", error } });
    else if (kind === "merge") this.update({ ...this.view, merge: { ...this.view.merge, state: "error", error } });
    else if (kind === "containing") this.update({ ...this.view, containing: { ...this.view.containing, state: "error", error } });
    else this.update({ ...this.view, diff: { ...this.view.diff, state: "error", error } });
  }

  private async cancelActiveRequest(keepLoadingKind?: "details" | "files" | "merge" | "containing" | "diff"): Promise<void> {
    const retryKind = this.retryKind;
    this.cancelRetryWait();
    if (retryKind && retryKind !== keepLoadingKind) this.settleLoadingKind(retryKind);
    const active = this.activeRequest;
    if (!active) return;
    const kind = this.activeKind;
    await this.api.cancelCommitDetails().catch(() => undefined);
    await active.catch(() => undefined);
    if (kind && kind !== keepLoadingKind) this.settleLoadingKind(kind);
  }

  private settleLoadingKind(kind: "details" | "files" | "merge" | "containing" | "diff"): void {
    if (kind === "details") this.update({ ...this.view, details: settled(this.view.details) });
    else if (kind === "files") this.update({ ...this.view, files: settled(this.view.files) });
    else if (kind === "merge") this.update({ ...this.view, merge: settled(this.view.merge) });
    else if (kind === "containing") this.update({ ...this.view, containing: settled(this.view.containing) });
    else this.update({ ...this.view, diff: settled(this.view.diff) });
  }

  private waitForRetry(delay: number): Promise<boolean> {
    return new Promise(resolve => {
      const finish = (resume: boolean) => {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.retryWake = undefined;
        resolve(resume);
      };
      this.retryWake = () => finish(false);
      this.retryTimer = setTimeout(() => finish(true), delay);
    });
  }

  private cancelRetryWait(): void {
    this.retryWake?.();
  }

  private isCurrent(selection: number, sequence: number, sessionKey: string, oid: string): boolean {
    return this.selectionIntent === selection && this.sequenceIntent === sequence && this.view.sessionKey === sessionKey && this.view.oid === oid;
  }

  private isRequestCurrent(selection: number, sequence: number, request: number, sessionKey: string, oid: string): boolean {
    return this.isCurrent(selection, sequence, sessionKey, oid) && this.requestIntent === request;
  }

  private hasCurrentContextDetails(): boolean {
    return Boolean(this.view.sessionKey && this.view.details.value && this.view.detailsSessionKey === this.view.sessionKey);
  }

  private update(view: CommitDetailView): void {
    this.view = view;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function ready<T>(value: T): DetailLoad<T> {
  return { state: "ready", value, error: null };
}

function settled<T>(slice: DetailLoad<T>): DetailLoad<T> {
  return slice.state === "loading"
    ? { ...slice, state: slice.value ? "ready" : "idle", error: null }
    : slice;
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    return { code: String(error.code), message: String(error.message) };
  }
  return { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) };
}

function isValidFileParent(parentIndex: number | null, parentCount: number): boolean {
  return parentCount === 0 ? parentIndex === null : parentIndex !== null && Number.isInteger(parentIndex) && parentIndex >= 0 && parentIndex < parentCount;
}

function validOffset(offset: number): boolean {
  return Number.isInteger(offset) && offset >= 0 && offset <= 0xffff_ffff;
}
