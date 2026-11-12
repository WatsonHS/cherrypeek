import { contextBridge, ipcRenderer } from "electron";
import type { CommitScopeApi, CoreStatus } from "../../../../packages/protocol/src/core-status.js";
import type { BlameChunkEvent, RepositoryObservationEvent, WorkspaceChangeEvent } from "../../../../packages/protocol/src/repository-session.js";

const api: CommitScopeApi = {
  getCoreStatus: () => ipcRenderer.invoke("commitscope:core:get-status") as Promise<CoreStatus>,
  onCoreStatusChanged(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, status: CoreStatus) => listener(status);
    ipcRenderer.on("commitscope:core:status-changed", wrapped);
    return () => ipcRenderer.removeListener("commitscope:core:status-changed", wrapped);
  },
  restartCore: () => ipcRenderer.invoke("commitscope:core:restart") as Promise<void>,
  chooseRepository: () => ipcRenderer.invoke("commitscope:repository:choose") as Promise<string | null>,
  getLaunchRepository: () => ipcRenderer.invoke("commitscope:repository:launch") as Promise<string | null>,
  copyText: text => ipcRenderer.invoke("commitscope:clipboard:write-text", text) as Promise<void>,
  openWorkspaceIn: (target, reselect = false) => ipcRenderer.invoke("commitscope:workspace:open-in", target, reselect) as Promise<boolean>,
  onRepositoryObservationChanged(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, observation: RepositoryObservationEvent) => listener(observation);
    ipcRenderer.on("commitscope:updates:observed", wrapped);
    return () => ipcRenderer.removeListener("commitscope:updates:observed", wrapped);
  },
  openRepositorySession: path => ipcRenderer.invoke("commitscope:session:open", path),
  getRepositorySession: () => ipcRenderer.invoke("commitscope:session:get"),
  readSessionPreview: () => ipcRenderer.invoke("commitscope:session:preview"),
  readHistoryPage: (cursor, pageSize, contentOnly) => ipcRenderer.invoke("commitscope:history:read-page", cursor, pageSize, contentOnly),
  locateCommit: (oid, pageSize) => ipcRenderer.invoke("commitscope:history:locate-commit", { oid, pageSize: pageSize ?? 200 }),
  locateHistoryDate: (beforeTimestamp, pageSize, knownCursors = []) => ipcRenderer.invoke("commitscope:history:locate-date", beforeTimestamp, pageSize ?? 200, knownCursors),
  cancelHistoryRead: () => ipcRenderer.invoke("commitscope:history:cancel-read"),
  refreshRepositorySession: pageSize => ipcRenderer.invoke("commitscope:history:refresh", pageSize),
  recordRepositoryView: expectedGeneration => ipcRenderer.invoke("commitscope:session:record-view", expectedGeneration),
  closeRepositorySession: () => ipcRenderer.invoke("commitscope:session:close"),
  listRecentRepositories: () => ipcRenderer.invoke("commitscope:session:list-recent"),
  getRepositoryNavigation: () => ipcRenderer.invoke("commitscope:session:navigation"),
  selectRepositoryScope: (scope, pageSize) => ipcRenderer.invoke("commitscope:session:select-scope", scope, pageSize),
  getRefMergeStatus: refNames => ipcRenderer.invoke("commitscope:refs:merge-status", refNames),
  cancelRefMergeStatus: () => ipcRenderer.invoke("commitscope:refs:merge-status:cancel"),
  getMetadataIndexStatus: () => ipcRenderer.invoke("commitscope:index:status"),
  controlMetadataIndex: action => ipcRenderer.invoke("commitscope:index:control", action),
  searchCommits: params => ipcRenderer.invoke("commitscope:search:commits", params),
  listSearchIdentities: params => ipcRenderer.invoke("commitscope:search:identities", params),
  listSearchPaths: params => ipcRenderer.invoke("commitscope:search:paths", params),
  cancelSearch: () => ipcRenderer.invoke("commitscope:search:cancel"),
  getActivityStats: params => ipcRenderer.invoke("commitscope:activity:stats", params),
  cancelActivityStats: () => ipcRenderer.invoke("commitscope:activity:stats:cancel"),
  observeRepository: () => ipcRenderer.invoke("commitscope:updates:observe"),
  cancelRepositoryObservation: () => ipcRenderer.invoke("commitscope:updates:observe:cancel"),
  diffRefSnapshots: () => ipcRenderer.invoke("commitscope:updates:diff"),
  cancelRefSnapshotDiff: () => ipcRenderer.invoke("commitscope:updates:diff:cancel"),
  getHandoffFacts: params => ipcRenderer.invoke("commitscope:handoff:facts", params),
  cancelHandoffFacts: () => ipcRenderer.invoke("commitscope:handoff:cancel"),
  getCommit: params => ipcRenderer.invoke("commitscope:details:get", params),
  listChangedFiles: params => ipcRenderer.invoke("commitscope:details:files", params),
  readMergeCommits: params => ipcRenderer.invoke("commitscope:details:merge", params),
  branchesContaining: params => ipcRenderer.invoke("commitscope:details:branches", params),
  readDiff: params => ipcRenderer.invoke("commitscope:details:diff", params),
  cancelCommitDetails: () => ipcRenderer.invoke("commitscope:details:cancel"),
  readWorkspaceStatus: params => ipcRenderer.invoke("commitscope:workspace:status", params),
  readWorkspaceDiff: params => ipcRenderer.invoke("commitscope:workspace:diff", params),
  readWorkspaceFile: params => ipcRenderer.invoke("commitscope:workspace:file", params),
  cancelWorkspace: () => ipcRenderer.invoke("commitscope:workspace:cancel"),
  listTree: params => ipcRenderer.invoke("commitscope:files:tree", params),
  readFileContent: params => ipcRenderer.invoke("commitscope:files:content", params),
  readFileHistory: params => ipcRenderer.invoke("commitscope:files:history", params),
  readFileChange: params => ipcRenderer.invoke("commitscope:files:change", params),
  listPathChanges: params => ipcRenderer.invoke("commitscope:files:path-changes", params),
  readCommitInfo: params => ipcRenderer.invoke("commitscope:files:commit", params),
  readBlame: (params, streamId) => ipcRenderer.invoke("commitscope:files:blame", params, streamId),
  cancelFiles: () => ipcRenderer.invoke("commitscope:files:cancel"),
  fetchRepository: params => ipcRenderer.invoke("commitscope:operations:fetch", params),
  cancelRepositoryOperation: () => ipcRenderer.invoke("commitscope:operations:cancel"),
  onBlameChunk(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, chunk: BlameChunkEvent) => listener(chunk);
    ipcRenderer.on("commitscope:files:blame-chunk", wrapped);
    return () => ipcRenderer.removeListener("commitscope:files:blame-chunk", wrapped);
  },
  onWorkspaceChanged(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, change: WorkspaceChangeEvent) => listener(change);
    ipcRenderer.on("commitscope:workspace:changed", wrapped);
    return () => ipcRenderer.removeListener("commitscope:workspace:changed", wrapped);
  },
};

contextBridge.exposeInMainWorld("commitScope", api);
