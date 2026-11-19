import type { SearchQuery } from "../../../../../packages/protocol/src/generated/client-message.js";
import type { NewSinceLastSeenStatus, RepositorySessionInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import type { OperationRun } from "../../../../../packages/protocol/src/repository-session.js";
import { shortRefName } from "./format.js";
import type { UnixRange } from "./stats-range.js";

type DoneRun = Extract<OperationRun, { outcome: "done" }>;

export type UpdateBatchKind = "update" | "unseen";

export interface UpdateBatchRecord {
  id: string;
  kind: UpdateBatchKind;
  label: string;
  branchName: string;
  oldTips: string[];
  newTips: string[];
  addedCount: number | null;
  minUnix: number | null;
  maxUnix: number | null;
  recordedAtUnixMs: number;
}

export interface BatchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const MAX_SAVED_BATCHES = 5;
const STORAGE_PREFIX = "commitscope:update-batches:v1:";
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function defaultStorage(): BatchStorage | undefined {
  try {
    return typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function batchStorageKey(repositoryKey: string, worktreeId: string): string {
  return `${STORAGE_PREFIX}${repositoryKey}:${worktreeId}`;
}

function validOidList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const oids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !OID_RE.test(item)) return null;
    oids.push(item.toLowerCase());
  }
  return oids;
}

function normalizeBatchRecord(raw: unknown): UpdateBatchRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const oldTips = validOidList(item.oldTips);
  const newTips = validOidList(item.newTips);
  if (
    typeof item.id !== "string" || !item.id ||
    (item.kind !== "update" && item.kind !== "unseen") ||
    typeof item.label !== "string" || !item.label ||
    typeof item.branchName !== "string" || !item.branchName ||
    !oldTips || oldTips.length === 0 || !newTips ||
    !(item.addedCount === null || typeof item.addedCount === "number" && Number.isSafeInteger(item.addedCount) && item.addedCount >= 0) ||
    !(item.minUnix === null || typeof item.minUnix === "number" && Number.isSafeInteger(item.minUnix)) ||
    !(item.maxUnix === null || typeof item.maxUnix === "number" && Number.isSafeInteger(item.maxUnix)) ||
    typeof item.recordedAtUnixMs !== "number" || !Number.isFinite(item.recordedAtUnixMs)
  ) {
    return null;
  }
  return {
    id: item.id,
    kind: item.kind,
    label: item.label,
    branchName: item.branchName,
    oldTips,
    newTips,
    addedCount: item.addedCount,
    minUnix: item.minUnix,
    maxUnix: item.maxUnix,
    recordedAtUnixMs: item.recordedAtUnixMs,
  };
}

export function loadUpdateBatches(
  repositoryKey: string,
  worktreeId: string,
  storage: BatchStorage | undefined = defaultStorage(),
): UpdateBatchRecord[] {
  if (!storage || !repositoryKey || !worktreeId) return [];
  try {
    const raw = storage.getItem(batchStorageKey(repositoryKey, worktreeId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries = parsed.map(normalizeBatchRecord).filter((entry): entry is UpdateBatchRecord => entry !== null);
    return entries.slice(0, MAX_SAVED_BATCHES);
  } catch {
    return [];
  }
}

export function latestUpdateBatch(
  repositoryKey: string,
  worktreeId: string,
  storage: BatchStorage | undefined = defaultStorage(),
): UpdateBatchRecord | null {
  return loadUpdateBatches(repositoryKey, worktreeId, storage)[0] ?? null;
}

function sameBatchIdentity(left: UpdateBatchRecord, right: UpdateBatchRecord): boolean {
  return left.kind === right.kind &&
    left.branchName === right.branchName &&
    left.oldTips.join(",") === right.oldTips.join(",") &&
    left.newTips.join(",") === right.newTips.join(",");
}

export function saveUpdateBatch(
  repositoryKey: string,
  worktreeId: string,
  batch: UpdateBatchRecord,
  storage: BatchStorage | undefined = defaultStorage(),
): UpdateBatchRecord[] {
  const existing = loadUpdateBatches(repositoryKey, worktreeId, storage);
  const next = [batch, ...existing.filter(item => !sameBatchIdentity(item, batch))].slice(0, MAX_SAVED_BATCHES);
  if (storage && repositoryKey && worktreeId) {
    try {
      storage.setItem(batchStorageKey(repositoryKey, worktreeId), JSON.stringify(next));
    } catch {
      // Ignore quota / restricted storage errors; in-memory notice actions still work.
    }
  }
  return next;
}

export function batchRecordFromOperation(params: {
  label: string;
  branchName: string;
  updatedRef: DoneRun["updatedRef"] | undefined;
  run: DoneRun;
  fallbackOldOid?: string | null;
  fallbackNewOid?: string | null;
  nowMs?: number;
}): UpdateBatchRecord | null {
  const oldOid = (params.updatedRef?.oldOid ?? params.fallbackOldOid ?? null)?.toLowerCase() ?? null;
  const newOid = (params.updatedRef?.newOid ?? params.fallbackNewOid ?? null)?.toLowerCase() ?? null;
  if (!oldOid || !newOid || oldOid === newOid || !OID_RE.test(oldOid) || !OID_RE.test(newOid)) {
    return null;
  }
  const nowMs = params.nowMs ?? Date.now();
  return {
    id: `update:${params.branchName}:${oldOid.slice(0, 8)}:${newOid.slice(0, 8)}:${nowMs}`,
    kind: "update",
    label: params.label,
    branchName: params.branchName,
    oldTips: [oldOid],
    newTips: [newOid],
    addedCount: params.run.addedCount ?? null,
    minUnix: params.run.addedMinUnix ?? null,
    maxUnix: params.run.addedMaxUnix ?? null,
    recordedAtUnixMs: nowMs,
  };
}

export function unseenBatchFromSession(params: {
  session: RepositorySessionInfo | null;
  status: NewSinceLastSeenStatus;
  count: number | null;
  minUnix: number | null;
  maxUnix: number | null;
}): UpdateBatchRecord | null {
  const { session, status, count, minUnix, maxUnix } = params;
  if (!session || status !== "ready" || !count || count <= 0) return null;
  const oldTips = session.previousView?.tips ?? [];
  if (oldTips.length === 0) return null;
  const branchName = session.repository.headReference
    ? shortRefName(session.repository.headReference)
    : session.repository.headOid
      ? session.repository.headOid.slice(0, 8)
      : "当前范围";
  return {
    id: `unseen:${session.repoId}:${session.generation}`,
    kind: "unseen",
    label: "自上次查看新增",
    branchName,
    oldTips: [...oldTips],
    newTips: [...session.tips],
    addedCount: count,
    minUnix,
    maxUnix,
    recordedAtUnixMs: session.previousView?.viewedAtUnixMs ?? session.observedAtUnixMs,
  };
}

export function zoomRangeForBatch(batch: Pick<UpdateBatchRecord, "minUnix" | "maxUnix">): UnixRange | null {
  if (batch.minUnix === null || batch.maxUnix === null) return null;
  const startUnix = Math.floor(batch.minUnix / 60) * 60;
  const endUnix = Math.max(startUnix + 60, Math.ceil((batch.maxUnix + 1) / 60) * 60);
  return { startUnix, endUnix };
}

export function batchFilterQuery(base: SearchQuery, oldTips: readonly string[]): SearchQuery {
  return {
    message: "",
    caseSensitive: false,
    authors: [],
    committers: [],
    oidPrefix: "",
    timeField: "committer",
    fromTimestamp: null,
    toTimestamp: null,
    path: null,
    timeZone: base.timeZone,
    ...(oldTips.length > 0 ? { excludeTips: [...oldTips] } : {}),
  };
}
