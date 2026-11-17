import type { SearchQuery, StatsBucket, StatsSelection } from "../../../../../packages/protocol/src/generated/client-message.js";
import type {
  ActivityOverview, ChangeStats, EvolutionChunk, EvolutionEstimate, GitPath, NotableStats, StatsCommitPage, StatsExclusions,
} from "../../../../../packages/protocol/src/generated/server-message.js";
import type { RepositorySessionApi, RepositorySessionResult } from "../../../../../packages/protocol/src/repository-session.js";
import { evolutionRange, MAX_RANGE_DAYS, pathToHex, presetRange, rangeDays, resolveBucket } from "./stats-range.js";
import type { BucketChoice, CustomDays, EvolutionRangeChoice, RangePreset, UnixRange } from "./stats-range.js";

/*
 * State of the statistics page. Only the visible section loads, only while the page is visible; every load
 * carries a token, so an answer for an old range, query or session is dropped. The statistics yield to
 * interactive reads: BUSY / CANCELLED keeps the previous result, shows "更新中" and retries with a backoff.
 * RESOURCE_LIMIT and INDEX_UNAVAILABLE clear the card (never partial rankings) and say why.
 */

export type StatsApi = Pick<RepositorySessionApi,
  "getActivityOverview" | "getChangeStats" | "getNotableStats" | "getStatsCommits" | "cancelStats" | "getStatsExclusions" | "setStatsExclusions"
  | "estimateEvolution" | "analyzeEvolution" | "onEvolutionChunk" | "cancelEvolution">;

export type StatsSection = "activity" | "changes" | "notable" | "evolution";
type LoadKind = "activity" | "changes" | "notable";
const LOAD_KINDS: readonly LoadKind[] = ["activity", "changes", "notable"];

export interface StatsError { code: string; message: string }

export interface StatsRequest {
  key: string;
  query: SearchQuery;
  range: UnixRange;
  bucket: StatsBucket;
}

export interface StatsSlot<T> {
  value: T | null;
  /** The request `value` answers; labels such as "上一个 7 天" come from its range, not from the controls. */
  loaded: StatsRequest | null;
  loading: boolean;
  /** BUSY / CANCELLED: the previous value stays and a retry is scheduled. */
  updating: boolean;
  error: StatsError | null;
}

export interface StatsCapabilities { activity: boolean; changes: boolean; notable: boolean; evolution: boolean }

export interface StatsCrumb { display: string; rawHex: string; textLossy: boolean }

export type EvolutionPhase = "idle" | "estimating" | "ready" | "analyzing" | "done" | "cancelled" | "error";

export interface EvolutionState {
  pathText: string;
  pathHex: string;
  rangeChoice: EvolutionRangeChoice;
  phase: EvolutionPhase;
  estimate: EvolutionEstimate | null;
  chunk: EvolutionChunk | null;
  error: StatsError | null;
}

export interface ExclusionsState { value: StatsExclusions | null; loading: boolean; saving: boolean; error: StatsError | null }

export interface StatsView {
  sessionKey: string | null;
  active: boolean;
  capabilities: StatsCapabilities;
  section: StatsSection;
  preset: RangePreset;
  custom: CustomDays;
  bucketChoice: BucketChoice;
  /** Non-null after brushing a sub-interval on a time chart; overrides preset/custom until cleared or preset changes. */
  zoomedRange: UnixRange | null;
  /** Null while a custom range is invalid. */
  range: UnixRange | null;
  bucket: StatsBucket | null;
  activity: StatsSlot<ActivityOverview>;
  changes: StatsSlot<ChangeStats>;
  notable: StatsSlot<NotableStats>;
  prefix: StatsCrumb[];
  exclusions: ExclusionsState;
  evolution: EvolutionState;
}

export interface StatsBinding {
  sessionKey: string | null;
  query: SearchQuery;
  capabilities: StatsCapabilities;
  /** The page is shown (and the window visible). */
  active: boolean;
  /** Changes while the metadata index makes progress; an incomplete result is read again then. */
  indexKey?: string;
  /** The tree version the evolution analysis reads; null when the browsing scope has none (all branches). */
  evolutionCommit: string | null;
}

export interface StatsStoreOptions {
  now?: () => Date;
  /** Wait before reloading after a control or filter change while a result is shown. 0 reloads at once. */
  debounceMs?: number;
  /** Shortest time between re-reads caused only by index progress. */
  indexReloadMs?: number;
  /** Waits between retries after BUSY / CANCELLED. */
  retryDelaysMs?: readonly number[];
}

const emptySlot = <T>(): StatsSlot<T> => ({ value: null, loaded: null, loading: false, updating: false, error: null });
const initialEvolution = (): EvolutionState => ({ pathText: "", pathHex: "", rangeChoice: "all", phase: "idle", estimate: null, chunk: null, error: null });

const today = (now: Date): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

const BUSY_CODES = new Set(["BUSY", "CANCELLED", "STALE_CONTEXT"]);

export class StatsStore {
  private view: StatsView;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;
  private readonly debounceMs: number;
  private readonly retryDelays: readonly number[];
  private query: SearchQuery | null = null;
  private indexKey = "";
  private evolutionCommit: string | null = null;
  private exclusionsVersion = 0;
  private readonly tokens: Record<LoadKind, number> = { activity: 0, changes: 0, notable: 0 };
  private readonly attempted: Record<LoadKind, string | null> = { activity: null, changes: null, notable: null };
  private readonly inflight: Record<LoadKind, boolean> = { activity: false, changes: false, notable: false };
  private readonly retryTimers: Partial<Record<LoadKind, ReturnType<typeof setTimeout>>> = {};
  private readonly retryCount: Record<LoadKind, number> = { activity: 0, changes: 0, notable: 0 };
  private ensureTimer?: ReturnType<typeof setTimeout>;
  private indexReloadTimer?: ReturnType<typeof setTimeout>;
  private readonly indexReloadMs: number;
  private exclusionsToken = 0;
  private evolutionToken = 0;
  private streamCounter = 0;
  private stopChunks: (() => void) | null = null;

  constructor(private readonly api: StatsApi, options: StatsStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.debounceMs = options.debounceMs ?? 300;
    this.indexReloadMs = options.indexReloadMs ?? 5_000;
    // A statistic that gave way to an interactive read is usually free to run again within a few hundred ms.
    this.retryDelays = options.retryDelaysMs ?? [400, 1_000, 2_500, 6_000];
    const custom = { from: today(this.now()), to: today(this.now()) };
    this.view = {
      sessionKey: null, active: false, capabilities: { activity: false, changes: false, notable: false, evolution: false },
      section: "activity", preset: "30d", custom, bucketChoice: "auto", zoomedRange: null, range: null, bucket: null,
      activity: emptySlot(), changes: emptySlot(), notable: emptySlot(), prefix: [],
      exclusions: { value: null, loading: false, saving: false, error: null }, evolution: initialEvolution(),
    };
    this.applyRange();
  }

  getView = (): StatsView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Follows the session, filters and visibility of the page. */
  bind(binding: StatsBinding): void {
    const sessionChanged = binding.sessionKey !== this.view.sessionKey;
    const wasActive = this.view.active;
    const evolutionChanged = binding.evolutionCommit !== this.evolutionCommit;
    const queryChanged = this.query !== null && JSON.stringify(this.query) !== JSON.stringify(binding.query);
    this.query = binding.query;
    if (sessionChanged) {
      this.abortAll();
      this.exclusionsToken += 1;
      this.view = { ...this.view, sessionKey: binding.sessionKey, zoomedRange: null, activity: emptySlot(), changes: emptySlot(), notable: emptySlot(), prefix: [],
        exclusions: { value: null, loading: false, saving: false, error: null }, evolution: { ...initialEvolution(), pathText: "", rangeChoice: this.view.evolution.rangeChoice } };
      this.exclusionsVersion = 0;
      for (const kind of LOAD_KINDS) this.attempted[kind] = null;
      this.resetEvolutionTarget(binding.evolutionCommit);
      this.applyRange();
    } else if (binding.evolutionCommit !== this.evolutionCommit) {
      this.resetEvolutionTarget(binding.evolutionCommit);
    }
    this.evolutionCommit = binding.evolutionCommit;
    const caps = this.view.capabilities;
    const same = binding.active === this.view.active && (Object.keys(caps) as (keyof StatsCapabilities)[]).every(key => caps[key] === binding.capabilities[key]);
    if (!same) this.view = { ...this.view, active: binding.active, capabilities: { ...binding.capabilities } };
    const changed = !same || sessionChanged || evolutionChanged;
    if (binding.indexKey !== undefined && binding.indexKey !== this.indexKey) {
      this.indexKey = binding.indexKey;
      // A result that did not cover the whole index is read again when the index moved on, but at most once
      // per interval: while the index is being built it moves every second, and each re-read scans it.
      if (!this.indexReloadTimer) {
        this.indexReloadTimer = setTimeout(() => {
          this.indexReloadTimer = undefined;
          for (const kind of LOAD_KINDS) {
            const value = this.slot(kind).value as { coverage: { complete: boolean } } | null;
            if (value && !value.coverage.complete) this.attempted[kind] = null;
          }
          if (this.view.active) this.requestEnsure(true);
        }, this.indexReloadMs);
      }
    }
    if (binding.active && !wasActive) this.applyRange();
    if (!binding.active && wasActive) this.abortAll();
    if (changed || binding.active !== wasActive) this.emit();
    if (binding.active) this.requestEnsure(!sessionChanged && queryChanged);
  }

  setSection(section: StatsSection): void {
    if (section === this.view.section) return;
    this.abortAll();
    this.view = { ...this.view, section };
    this.emit();
    this.requestEnsure(false);
  }

  setPreset(preset: RangePreset): void {
    this.view = { ...this.view, preset, zoomedRange: null };
    this.applyRange();
    this.emit();
    this.requestEnsure(true);
  }

  setCustom(custom: CustomDays): void {
    this.view = { ...this.view, custom, zoomedRange: null };
    this.applyRange();
    this.emit();
    this.requestEnsure(true);
  }

  setBucket(choice: BucketChoice): void {
    this.view = { ...this.view, bucketChoice: choice };
    this.applyRange();
    this.emit();
    this.requestEnsure(true);
  }

  /** Zooms into a brushed sub-interval on a time chart; cleared when switching preset, custom range or repository. */
  zoomRange(range: UnixRange): void {
    if (!Number.isFinite(range.startUnix) || !Number.isFinite(range.endUnix) || range.endUnix <= range.startUnix) return;
    if (rangeDays(range) > MAX_RANGE_DAYS) return;
    this.view = { ...this.view, zoomedRange: { startUnix: range.startUnix, endUnix: range.endUnix } };
    this.applyRange();
    this.emit();
    this.requestEnsure(false);
  }

  clearZoom(): void {
    if (!this.view.zoomedRange) return;
    this.view = { ...this.view, zoomedRange: null };
    this.applyRange();
    this.emit();
    this.requestEnsure(false);
  }

  /** Reads the visible section again (the card's 重试). */
  retry(): void {
    const kind = this.kindOf(this.view.section);
    if (!kind) return;
    this.attempted[kind] = null;
    this.retryCount[kind] = 0;
    this.applyRange();
    this.emit();
    this.requestEnsure(false);
  }

  /** Drills into a directory of the changes section; `crumbs` is the whole path from the root. */
  setPrefix(crumbs: StatsCrumb[]): void {
    this.view = { ...this.view, prefix: crumbs };
    this.emit();
    this.requestEnsure(true);
  }

  async loadExclusions(): Promise<void> {
    if (this.view.exclusions.loading || !this.view.sessionKey) return;
    const token = ++this.exclusionsToken;
    this.view = { ...this.view, exclusions: { ...this.view.exclusions, loading: true, error: null } };
    this.emit();
    const result = await settle(this.api.getStatsExclusions());
    if (token !== this.exclusionsToken) return;
    this.view = { ...this.view, exclusions: result.ok
      ? { value: result.value, loading: false, saving: false, error: null }
      : { ...this.view.exclusions, loading: false, error: { code: result.error.code, message: result.error.message } } };
    this.emit();
  }

  /** Saves the list, then reads the sections that depend on it again. Resolves with whether it was saved. */
  async saveExclusions(patterns: string[]): Promise<boolean> {
    const token = ++this.exclusionsToken;
    this.view = { ...this.view, exclusions: { ...this.view.exclusions, saving: true, error: null } };
    this.emit();
    const result = await settle(this.api.setStatsExclusions(patterns));
    if (token !== this.exclusionsToken) return false;
    if (!result.ok) {
      this.view = { ...this.view, exclusions: { ...this.view.exclusions, saving: false, error: { code: result.error.code, message: result.error.message } } };
      this.emit();
      return false;
    }
    this.view = { ...this.view, exclusions: { value: result.value, loading: false, saving: false, error: null } };
    this.exclusionsVersion += 1;
    this.attempted.changes = null;
    this.attempted.notable = null;
    this.emit();
    this.requestEnsure(false);
    return true;
  }

  /** One page of commits behind a ranking row or the "untested" count, for the request the section last answered. */
  async commitsPage(source: "changes" | "notable", selection: StatsSelection, offset: number, limit = 50): Promise<RepositorySessionResult<StatsCommitPage>> {
    const loaded = this.view[source].loaded;
    if (!loaded) return { ok: false, error: { code: "STALE_CONTEXT", message: "统计结果已经过期，请重新统计。", retryable: true } };
    return settle(this.api.getStatsCommits({ query: loaded.query, range: loaded.range, selection, offset, limit }));
  }

  // --- evolution -------------------------------------------------------------------------------------------

  setEvolutionPath(text: string, hex?: string): void {
    this.patchEvolutionInput({ pathText: text, pathHex: hex ?? pathToHex(text) });
  }

  setEvolutionRange(rangeChoice: EvolutionRangeChoice): void {
    this.patchEvolutionInput({ rangeChoice });
  }

  async estimateEvolution(): Promise<void> {
    const commit = this.evolutionCommit;
    if (!commit || !this.view.capabilities.evolution) return;
    const token = ++this.evolutionToken;
    this.stopStream();
    const input = this.view.evolution;
    this.setEvolution({ ...input, phase: "estimating", estimate: null, chunk: null, error: null });
    const result = await settle(this.api.estimateEvolution({ commit, pathHex: input.pathHex, range: evolutionRange(input.rangeChoice, this.now()) }));
    if (token !== this.evolutionToken) return;
    this.setEvolution(result.ok
      ? { ...this.view.evolution, phase: "ready", estimate: result.value, error: null }
      : { ...this.view.evolution, phase: result.error.code === "CANCELLED" ? "idle" : "error", error: { code: result.error.code, message: result.error.message } });
  }

  async analyzeEvolution(): Promise<void> {
    const commit = this.evolutionCommit;
    if (!commit || !this.view.capabilities.evolution) return;
    const token = ++this.evolutionToken;
    this.stopStream();
    const input = this.view.evolution;
    const streamId = `evolution-${++this.streamCounter}-${this.now().getTime()}`;
    this.setEvolution({ ...input, phase: "analyzing", chunk: null, error: null });
    this.stopChunks = this.api.onEvolutionChunk(event => {
      if (event.streamId !== streamId || token !== this.evolutionToken) return;
      this.setEvolution({ ...this.view.evolution, phase: "analyzing", chunk: event.chunk });
    });
    const result = await settle(this.api.analyzeEvolution({ commit, pathHex: input.pathHex, range: evolutionRange(input.rangeChoice, this.now()) }, streamId));
    if (token !== this.evolutionToken) return;
    this.stopStream();
    const current = this.view.evolution;
    if (result.ok) {
      const progress = current.chunk?.progress ?? { filesDone: result.value.covered.files, filesTotal: result.value.covered.files, currentPath: null };
      this.setEvolution({ ...current, phase: "done", chunk: { progress: { ...progress, currentPath: null }, result: result.value }, error: null });
    } else if (result.error.code === "CANCELLED") {
      // What arrived stays on screen.
      this.setEvolution({ ...current, phase: "cancelled" });
    } else {
      this.setEvolution({ ...current, phase: "error", error: { code: result.error.code, message: result.error.message } });
    }
  }

  /** Stops an estimate or analysis; chunks already received are kept. */
  async cancelEvolution(): Promise<void> {
    const phase = this.view.evolution.phase;
    if (phase !== "estimating" && phase !== "analyzing") return;
    this.evolutionToken += 1;
    this.stopStream();
    this.setEvolution({ ...this.view.evolution, phase: phase === "estimating" ? "idle" : "cancelled" });
    await settle(this.api.cancelEvolution());
  }

  dispose(): void {
    if (this.indexReloadTimer) clearTimeout(this.indexReloadTimer);
    this.indexReloadTimer = undefined;
    this.abortAll();
    this.exclusionsToken += 1;
    this.evolutionToken += 1;
    this.stopStream();
    if (this.ensureTimer) clearTimeout(this.ensureTimer);
    this.ensureTimer = undefined;
  }

  // --- internals -------------------------------------------------------------------------------------------

  private kindOf(section: StatsSection): LoadKind | null {
    return section === "evolution" ? null : section;
  }

  private slot(kind: LoadKind): StatsSlot<unknown> {
    return this.view[kind] as StatsSlot<unknown>;
  }

  private patchSlot(kind: LoadKind, patch: Partial<StatsSlot<unknown>>): void {
    this.view = { ...this.view, [kind]: { ...this.view[kind], ...patch } } as StatsView;
  }

  private applyRange(): void {
    const range = this.view.zoomedRange ?? presetRange(this.view.preset, this.now(), this.view.custom);
    const bucket = range ? resolveBucket(this.view.bucketChoice, range) : null;
    const same = range && this.view.range && range.startUnix === this.view.range.startUnix && range.endUnix === this.view.range.endUnix;
    this.view = { ...this.view, range: same ? this.view.range : range, bucket,
      bucketChoice: range && this.view.bucketChoice !== "auto" && resolveBucket(this.view.bucketChoice, range) !== this.view.bucketChoice ? "auto" : this.view.bucketChoice };
  }

  private requestKey(kind: LoadKind): string | null {
    const { range, bucket, sessionKey } = this.view;
    if (!range || !bucket || !sessionKey || !this.query) return null;
    return [sessionKey, JSON.stringify(this.query), range.startUnix, range.endUnix, bucket,
      kind === "changes" ? this.view.prefix[this.view.prefix.length - 1]?.rawHex ?? "" : "", kind === "activity" ? "" : this.exclusionsVersion].join("|");
  }

  private requestEnsure(debounce: boolean): void {
    if (this.ensureTimer && debounce) return;
    if (this.ensureTimer) clearTimeout(this.ensureTimer);
    this.ensureTimer = undefined;
    const kind = this.kindOf(this.view.section);
    const delayed = debounce && this.debounceMs > 0 && kind !== null && this.slot(kind).value !== null;
    if (delayed) {
      this.ensureTimer = setTimeout(() => { this.ensureTimer = undefined; this.ensure(); }, this.debounceMs);
      return;
    }
    this.ensure();
  }

  private ensure(): void {
    const view = this.view;
    if (!view.active || !view.sessionKey) return;
    const kind = this.kindOf(view.section);
    if (!kind || !view.capabilities[kind]) return;
    const key = this.requestKey(kind);
    if (!key) return;
    if (this.attempted[kind] === key) return;
    void this.load(kind, key);
  }

  private async load(kind: LoadKind, key: string): Promise<void> {
    const token = ++this.tokens[kind];
    const superseded = this.inflight[kind];
    this.attempted[kind] = key;
    this.retryCount[kind] = 0;
    this.clearRetry(kind);
    const request: StatsRequest = { key, query: this.query!, range: this.view.range!, bucket: this.view.bucket! };
    this.patchSlot(kind, { loading: true, updating: false, error: null });
    this.emit();
    // A running read of the same section is cancelled first so the new one is not refused as busy.
    if (superseded) await settle(this.api.cancelStats());
    if (token !== this.tokens[kind]) return;
    await this.run(kind, token, request);
  }

  private async run(kind: LoadKind, token: number, request: StatsRequest): Promise<void> {
    this.inflight[kind] = true;
    const result = await settle(this.call(kind, request));
    if (token !== this.tokens[kind]) return;
    this.inflight[kind] = false;
    if (result.ok) {
      this.patchSlot(kind, { value: result.value, loaded: request, loading: false, updating: false, error: null });
      this.emit();
      return;
    }
    const error = { code: result.error.code as string, message: result.error.message };
    if (BUSY_CODES.has(error.code)) {
      const delay = this.retryDelays[this.retryCount[kind]];
      if (delay !== undefined) {
        this.retryCount[kind] += 1;
        this.patchSlot(kind, { loading: false, updating: true });
        this.emit();
        this.retryTimers[kind] = setTimeout(() => {
          delete this.retryTimers[kind];
          if (token !== this.tokens[kind]) return;
          this.patchSlot(kind, { loading: true, updating: false });
          this.emit();
          void this.run(kind, token, request);
        }, delay);
        return;
      }
      // Out of retries: the previous result stays; the card says the statistics are still waiting.
      this.patchSlot(kind, { loading: false, updating: false, error: { code: "BUSY", message: "统计暂时让位给其他读取，稍后再试。" } });
      this.emit();
      return;
    }
    // Any other failure answers this request: no result of another range is left on the card.
    this.patchSlot(kind, { value: null, loaded: null, loading: false, updating: false, error });
    this.emit();
  }

  private call(kind: LoadKind, request: StatsRequest): Promise<RepositorySessionResult<unknown>> {
    const base = { query: request.query, range: request.range, bucket: request.bucket };
    if (kind === "activity") return this.api.getActivityOverview(base);
    if (kind === "notable") return this.api.getNotableStats(base);
    const prefix = this.view.prefix[this.view.prefix.length - 1]?.rawHex;
    return this.api.getChangeStats(prefix ? { ...base, directoryPrefix: prefix } : base);
  }

  private clearRetry(kind: LoadKind): void {
    const timer = this.retryTimers[kind];
    if (timer) clearTimeout(timer);
    delete this.retryTimers[kind];
  }

  /** Invalidates every running read; the loaded values stay, the next visit reads again. */
  private abortAll(): void {
    let running = false;
    for (const kind of LOAD_KINDS) {
      if (this.inflight[kind] || this.slot(kind).loading || this.retryTimers[kind]) running = true;
      this.tokens[kind] += 1;
      this.inflight[kind] = false;
      this.clearRetry(kind);
      if (this.attempted[kind] !== null && (this.slot(kind).loading || this.slot(kind).updating)) this.attempted[kind] = null;
      if (this.slot(kind).loading || this.slot(kind).updating) this.patchSlot(kind, { loading: false, updating: false });
    }
    if (running) void settle(this.api.cancelStats());
  }

  private resetEvolutionTarget(commit: string | null): void {
    if (this.view.evolution.phase === "estimating" || this.view.evolution.phase === "analyzing") void settle(this.api.cancelEvolution());
    this.evolutionToken += 1;
    this.stopStream();
    this.view = { ...this.view, evolution: { ...this.view.evolution, phase: "idle", estimate: null, chunk: null, error: null } };
    this.evolutionCommit = commit;
  }

  private patchEvolutionInput(patch: Partial<EvolutionState>): void {
    const running = this.view.evolution.phase === "estimating" || this.view.evolution.phase === "analyzing";
    this.evolutionToken += 1;
    this.stopStream();
    if (running) void settle(this.api.cancelEvolution());
    this.setEvolution({ ...this.view.evolution, ...patch, phase: "idle", estimate: null, chunk: null, error: null });
  }

  private stopStream(): void {
    this.stopChunks?.();
    this.stopChunks = null;
  }

  private setEvolution(evolution: EvolutionState): void {
    this.view = { ...this.view, evolution };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Directory path from a GitPath, kept as a breadcrumb entry. */
export function crumbOf(path: GitPath): StatsCrumb {
  return { display: path.display, rawHex: path.rawHex, textLossy: path.textLossy };
}

async function settle<T>(promise: Promise<RepositorySessionResult<T>>): Promise<RepositorySessionResult<T>> {
  try {
    return await promise;
  } catch (error) {
    return { ok: false, error: { code: "PROTOCOL_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false } };
  }
}
