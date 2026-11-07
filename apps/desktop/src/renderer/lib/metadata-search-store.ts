import type { CommitSummary, HistoryCommit, MetadataIndexStatus, SearchIdentity, SearchPage } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { SearchCommitsParams, SearchQuery, SearchTimeField } from "../../../../../packages/protocol/src/generated/client-message.js";
import type { RepositorySessionApi } from "../../../../../packages/protocol/src/repository-session.js";

export type SearchApi = Pick<RepositorySessionApi, "searchCommits" | "listSearchIdentities" | "cancelSearch">;
export type SearchField = "author" | "committer";

export interface SearchWindow {
  queryKey: string;
  snapshotKey: string;
  resultVersion: string;
  pageOffset: number;
  matchedCount: number;
  coverage: SearchPage["coverage"];
  index: MetadataIndexStatus;
  previousCursor: string | null;
  nextCursor: string | null;
  anchorFound: boolean | null;
  commits: CommitSummary[];
}

export interface SearchIdentityState {
  values: SearchIdentity[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  coverage: SearchPage["coverage"] | null;
}

export interface SearchView {
  active: boolean;
  query: SearchQuery;
  loading: boolean;
  pageLoading: boolean;
  error: { code: string; message: string } | null;
  window: SearchWindow | null;
  selectedOid: string | undefined;
  oldSelectedCommit: CommitSummary | null;
  anchorOid: string | null;
  anchorOffset: number;
  authorIdentities: SearchIdentityState;
  committerIdentities: SearchIdentityState;
}

export interface HistoryReturnPoint {
  cursor: string | null;
  selectedOid: string | undefined;
  selectedCommit: HistoryCommit | null;
  anchor: { oid: string; offset: number } | null;
}

export const DEFAULT_SEARCH_QUERY: SearchQuery = {
  message: "", caseSensitive: false, authors: [], committers: [], oidPrefix: "",
  timeField: "committer", fromTimestamp: null, toTimestamp: null,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
};

const EMPTY_IDENTITIES: SearchIdentityState = { values: [], loading: false, error: null, truncated: false, coverage: null };
const PAGE_SIZE = 200;
const MAX_WINDOW = 1_800;

export function hasSearchCriteria(query: SearchQuery): boolean {
  return query.message !== "" || query.authors.length > 0 || query.committers.length > 0 || query.oidPrefix !== "" ||
    query.fromTimestamp !== null || query.toTimestamp !== null || query.timeField === "author";
}

export function searchQueryKey(query: SearchQuery): string {
  return JSON.stringify(query);
}

export class MetadataSearchStore {
  private view: SearchView = {
    active: false, query: DEFAULT_SEARCH_QUERY, loading: false, pageLoading: false, error: null,
    window: null, selectedOid: undefined, oldSelectedCommit: null, anchorOid: null, anchorOffset: 0,
    authorIdentities: EMPTY_IDENTITIES, committerIdentities: EMPTY_IDENTITIES,
  };
  private readonly listeners = new Set<() => void>();
  private operation = 0;
  private identityOperation = { author: 0, committer: 0 };
  private identityIntent = 0;
  private identityTail: Promise<void> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private composing = false;
  private pages: SearchPage[] = [];
  private sessionKey: string | null = null;
  private historyReturn: HistoryReturnPoint | null = null;

  constructor(private readonly api: SearchApi) {}

  getView = (): SearchView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  setHistoryReturn(point: HistoryReturnPoint): void {
    this.historyReturn = point;
    this.trimWindow("next");
  }
  getHistoryReturn(): HistoryReturnPoint | null { return this.historyReturn; }
  clearHistoryReturn(): void { this.historyReturn = null; }

  updateQuery(query: SearchQuery, composing = false): { wasActive: boolean; active: boolean } {
    this.composing = composing;
    const wasActive = this.view.active;
    const active = hasSearchCriteria(query);
    this.clearDebounce();
    const changed = searchQueryKey(query) !== searchQueryKey(this.view.query);
    if (changed) {
      ++this.operation;
      ++this.identityIntent;
      ++this.identityOperation.author;
      ++this.identityOperation.committer;
      if (this.view.loading || this.view.pageLoading || this.view.authorIdentities.loading || this.view.committerIdentities.loading || this.pages.length) void this.api.cancelSearch();
      this.pages = [];
      this.update({ ...this.view, query, active, window: null, loading: false, pageLoading: false, error: null,
        selectedOid: undefined, oldSelectedCommit: null, anchorOid: null, anchorOffset: 0,
        authorIdentities: { ...this.view.authorIdentities, loading: false },
        committerIdentities: { ...this.view.committerIdentities, loading: false } });
    } else if (active !== this.view.active) {
      this.update({ ...this.view, active });
    }
    if (active && !composing) this.schedule(250);
    return { wasActive, active };
  }

  finishComposition(): void {
    this.composing = false;
    if (this.view.active) this.schedule(250);
  }

  beginComposition(): void {
    this.composing = true;
    this.clearDebounce();
    const pending = this.view.loading || this.view.pageLoading || this.view.authorIdentities.loading || this.view.committerIdentities.loading;
    ++this.operation;
    if (pending) void this.api.cancelSearch();
    this.update({ ...this.view, loading: false, pageLoading: false });
  }

  bindSession(sessionKey: string | null, ready: boolean): void {
    if (sessionKey !== this.sessionKey) {
      this.sessionKey = sessionKey;
      if (this.historyReturn) this.historyReturn = { ...this.historyReturn, cursor: null };
      this.clearDebounce();
      ++this.operation;
      ++this.identityIntent;
      ++this.identityOperation.author;
      ++this.identityOperation.committer;
      this.pages = [];
      this.update({ ...this.view, window: null, loading: false, pageLoading: false, error: null,
        selectedOid: undefined, oldSelectedCommit: null, anchorOid: null, anchorOffset: 0,
        authorIdentities: EMPTY_IDENTITIES, committerIdentities: EMPTY_IDENTITIES });
    }
    if (ready && this.view.active && !this.composing && !this.view.loading && !this.view.window?.coverage.complete && !this.debounceTimer) this.schedule(250);
  }

  setHistoryAnchor(anchor: { oid: string; offset: number } | null): void {
    const oid = anchor?.oid ?? null;
    const offset = anchor?.offset ?? 0;
    if (this.view.anchorOid === oid && this.view.anchorOffset === offset) return;
    this.update({ ...this.view, anchorOid: oid, anchorOffset: offset });
  }

  setSelectedOid(oid: string | undefined): void {
    if (this.view.selectedOid === oid) return;
    this.update({ ...this.view, selectedOid: oid });
  }

  setIndexStatus(index: MetadataIndexStatus): void {
    const window = this.view.window;
    if (window) this.update({ ...this.view, window: { ...window, index } });
  }

  async loadIdentities(field: SearchField, text: string): Promise<void> {
    const intent = this.identityIntent;
    const operation = ++this.identityOperation[field];
    const searchPending = this.view.loading || this.view.pageLoading;
    const resumeSearch = this.view.active && (searchPending || Boolean(this.view.window && !this.view.window.coverage.complete));
    if (searchPending) ++this.operation;
    const otherField = field === "author" ? "committer" : "author";
    this.update({ ...this.view, loading: false, pageLoading: false,
      [field === "author" ? "authorIdentities" : "committerIdentities"]: { ...this.identitiesFor(field), loading: true, error: null },
      [otherField === "author" ? "authorIdentities" : "committerIdentities"]: { ...this.identitiesFor(otherField), loading: false } });
    const result = await this.enqueueIdentityRequest(intent, () => this.api.listSearchIdentities({ field, text, limit: 50 }));
    if (!result) return;
    if (intent !== this.identityIntent || operation !== this.identityOperation[field]) return;
    if (!result.ok) {
      this.updateIdentity(field, { ...this.identitiesFor(field), loading: false, error: result.error.message });
      if (resumeSearch && !this.composing && this.view.active && !this.view.authorIdentities.loading && !this.view.committerIdentities.loading) this.schedule(250);
      return;
    }
    this.updateIdentity(field, { values: result.value.identities,
      loading: false, error: null, truncated: result.value.truncated, coverage: result.value.coverage });
    if (resumeSearch && !this.composing && this.view.active && !this.view.authorIdentities.loading && !this.view.committerIdentities.loading) this.schedule(250);
  }

  async loadNext(): Promise<void> {
    const window = this.view.window;
    const cursor = window?.nextCursor;
    if (!window || !cursor || this.view.pageLoading || this.composing) return;
    await this.loadPage(cursor, "next");
  }

  async loadPrevious(): Promise<void> {
    const window = this.view.window;
    const cursor = window?.previousCursor;
    if (!window || !cursor || this.view.pageLoading || this.composing) return;
    await this.loadPage(cursor, "previous");
  }

  refreshPartial(): Promise<void> {
    if (!this.view.active || this.composing || !this.view.window || this.view.window.coverage.complete || this.view.loading || this.view.pageLoading ||
      this.view.authorIdentities.loading || this.view.committerIdentities.loading) return Promise.resolve();
    return this.runSearch({ cursor: null, anchorOid: this.view.anchorOid });
  }

  async retry(): Promise<void> {
    if (!this.view.active) return;
    await this.runSearch({ cursor: null, anchorOid: this.view.anchorOid });
  }

  async cancelPending(): Promise<void> {
    this.clearDebounce();
    const pending = this.view.loading || this.view.pageLoading || this.view.authorIdentities.loading || this.view.committerIdentities.loading;
    const operation = ++this.operation;
    ++this.identityIntent;
    ++this.identityOperation.author;
    ++this.identityOperation.committer;
    if (pending) await this.api.cancelSearch();
    if (operation !== this.operation) return;
    this.update({ ...this.view, loading: false, pageLoading: false,
      authorIdentities: { ...this.view.authorIdentities, loading: false },
      committerIdentities: { ...this.view.committerIdentities, loading: false } });
  }

  async leave(): Promise<void> {
    this.clearDebounce();
    const operation = ++this.operation;
    ++this.identityIntent;
    ++this.identityOperation.author;
    ++this.identityOperation.committer;
    const hadRequest = this.view.loading || this.view.pageLoading || this.view.authorIdentities.loading || this.view.committerIdentities.loading;
    this.pages = [];
    this.update({ ...this.view, active: false, query: DEFAULT_SEARCH_QUERY, loading: false, pageLoading: false,
      window: null, selectedOid: undefined, oldSelectedCommit: null, anchorOid: null, anchorOffset: 0,
      authorIdentities: EMPTY_IDENTITIES, committerIdentities: EMPTY_IDENTITIES, error: null });
    if (hadRequest) await this.api.cancelSearch();
    if (operation !== this.operation || this.view.active) return;
  }

  dispose(): void {
    this.clearDebounce();
    ++this.operation;
    ++this.identityIntent;
    ++this.identityOperation.author;
    ++this.identityOperation.committer;
    void this.api.cancelSearch();
    this.listeners.clear();
  }

  private schedule(delay: number): void {
    if (this.composing) return;
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.runSearch({ cursor: null, anchorOid: this.view.anchorOid });
    }, delay);
  }

  private async runSearch(options: { cursor: string | null; anchorOid: string | null }): Promise<void> {
    if (this.composing) return;
    const operation = ++this.operation;
    ++this.identityIntent;
    ++this.identityOperation.author;
    ++this.identityOperation.committer;
    const query = this.view.query;
    const existing = this.view.window;
    this.update({ ...this.view, loading: options.cursor === null, pageLoading: options.cursor !== null, error: null,
      authorIdentities: { ...this.view.authorIdentities, loading: false }, committerIdentities: { ...this.view.committerIdentities, loading: false } });
    const params: SearchCommitsParams = { query, cursor: options.cursor, anchorOid: options.cursor === null ? options.anchorOid : null, pageSize: PAGE_SIZE };
    const result = await this.api.searchCommits(params);
    if (operation !== this.operation || !this.view.active || searchQueryKey(this.view.query) !== searchQueryKey(query)) return;
    if (!result.ok) {
      this.update({ ...this.view, loading: false, pageLoading: false, error: result.error });
      return;
    }
    const page = result.value;
    if (options.cursor !== null && existing && page.resultVersion === existing.resultVersion && page.queryKey === existing.queryKey) {
      const adjacent = options.cursor === existing.nextCursor
        ? page.pageOffset === existing.pageOffset + existing.commits.length
        : page.pageOffset + page.commits.length === existing.pageOffset;
      if (adjacent && !page.commits.some(item => existing.commits.some(old => old.oid === item.oid))) {
        this.pages.push(page);
        this.trimWindow("next");
        this.applyPages(page.anchorFound);
        return;
      }
    }
    this.pages = [page];
    const oldSelectedCommit = this.view.selectedOid
      ? existing?.commits.find(commit => commit.oid === this.view.selectedOid) ?? this.view.oldSelectedCommit
      : null;
    const selectedStillVisible = Boolean(this.view.selectedOid && page.commits.some(commit => commit.oid === this.view.selectedOid));
    const selectedOid = this.view.selectedOid ?? page.commits[0]?.oid;
    this.update({ ...this.view, loading: false, pageLoading: false, error: null, window: toWindow(page),
      selectedOid: selectedStillVisible || !this.view.selectedOid ? selectedOid : this.view.selectedOid,
      oldSelectedCommit: selectedStillVisible ? null : oldSelectedCommit,
      anchorOid: options.anchorOid ?? this.view.anchorOid,
    });
  }

  private async loadPage(cursor: string, direction: "next" | "previous"): Promise<void> {
    const operation = ++this.operation;
    const query = this.view.query;
    const existing = this.view.window;
    if (!existing) return;
    this.update({ ...this.view, pageLoading: true, error: null });
    const result = await this.api.searchCommits({ query, cursor, anchorOid: null, pageSize: PAGE_SIZE });
    if (operation !== this.operation || !this.view.active || searchQueryKey(this.view.query) !== searchQueryKey(query)) return;
    if (!result.ok) {
      this.update({ ...this.view, pageLoading: false, error: result.error });
      return;
    }
    const page = result.value;
    if (page.resultVersion !== existing.resultVersion || page.queryKey !== existing.queryKey || page.snapshotKey !== existing.snapshotKey) {
      this.pages = [page];
      this.applyPages(page.anchorFound);
      return;
    }
    const edge = direction === "next" ? this.pages.at(-1) : this.pages[0];
    const adjacent = direction === "next"
      ? page.pageOffset === edge!.pageOffset + edge!.commits.length
      : page.pageOffset + page.commits.length === edge!.pageOffset;
    if (!adjacent || page.commits.some(item => existing.commits.some(old => old.oid === item.oid))) {
      this.update({ ...this.view, pageLoading: false, error: { code: "PROTOCOL_ERROR", message: "搜索结果页与当前窗口不连续" } });
      return;
    }
    if (direction === "next") this.pages.push(page);
    else this.pages.unshift(page);
    this.trimWindow(direction);
    this.applyPages(page.anchorFound);
  }

  private trimWindow(direction: "next" | "previous"): void {
    let total = this.pages.reduce((count, page) => count + page.commits.length, 0);
    const limit = MAX_WINDOW - (this.historyReturn?.selectedCommit ? 1 : 0);
    while (this.pages.length > 1 && total > limit) {
      total -= (direction === "next" ? this.pages.shift()! : this.pages.pop()!).commits.length;
    }
  }

  private applyPages(anchorFound: SearchPage["anchorFound"]): void {
    const first = this.pages[0]!;
    const last = this.pages.at(-1)!;
    const commits = this.pages.flatMap(page => page.commits);
    const previousWindow = this.view.window;
    const oldSelectedCommit = this.view.selectedOid
      ? previousWindow?.commits.find(commit => commit.oid === this.view.selectedOid) ?? this.view.oldSelectedCommit
      : null;
    const selectedVisible = Boolean(this.view.selectedOid && commits.some(commit => commit.oid === this.view.selectedOid));
    const anchorVisible = Boolean(this.view.anchorOid && commits.some(commit => commit.oid === this.view.anchorOid));
    this.update({ ...this.view, pageLoading: false, loading: false, error: null,
      window: { ...toWindow(last), pageOffset: first.pageOffset, previousCursor: first.previousCursor, nextCursor: last.nextCursor, commits,
        anchorFound },
      anchorOid: anchorVisible ? this.view.anchorOid : first.commits[0]?.oid ?? null,
      oldSelectedCommit: selectedVisible ? null : oldSelectedCommit,
    });
  }

  private identitiesFor(field: SearchField): SearchIdentityState {
    return field === "author" ? this.view.authorIdentities : this.view.committerIdentities;
  }

  private updateIdentity(field: SearchField, state: SearchIdentityState): void {
    this.update(field === "author" ? { ...this.view, authorIdentities: state } : { ...this.view, committerIdentities: state });
  }

  private clearDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  private async enqueueIdentityRequest<T>(intent: number, request: () => Promise<T>): Promise<T | undefined> {
    const previous = this.identityTail;
    let release!: () => void;
    this.identityTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (intent !== this.identityIntent) return undefined;
      return await request();
    } finally {
      release();
    }
  }

  private update(view: SearchView): void {
    this.view = view;
    for (const listener of this.listeners) listener();
  }
}

function toWindow(page: SearchPage): SearchWindow {
  return {
    queryKey: page.queryKey, snapshotKey: page.snapshotKey, resultVersion: page.resultVersion,
    pageOffset: page.pageOffset, matchedCount: page.matchedCount, coverage: page.coverage,
    index: page.index, previousCursor: page.previousCursor, nextCursor: page.nextCursor,
    anchorFound: page.anchorFound, commits: page.commits,
  };
}

function sameIdentity(left: SearchIdentity, right: SearchIdentity): boolean {
  return left.name === right.name && left.email === right.email;
}
