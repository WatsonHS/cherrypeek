import { contextBridge, ipcRenderer } from "electron";
import type { CommitScopeApi, CoreStatus } from "../../../../packages/protocol/src/core-status.js";

const api: CommitScopeApi = {
  getCoreStatus: () => ipcRenderer.invoke("commitscope:core:get-status") as Promise<CoreStatus>,
  onCoreStatusChanged(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, status: CoreStatus) => listener(status);
    ipcRenderer.on("commitscope:core:status-changed", wrapped);
    return () => ipcRenderer.removeListener("commitscope:core:status-changed", wrapped);
  },
  chooseRepository: () => ipcRenderer.invoke("commitscope:repository:choose") as Promise<string | null>,
  getLaunchRepository: () => ipcRenderer.invoke("commitscope:repository:launch") as Promise<string | null>,
  copyText: text => ipcRenderer.invoke("commitscope:clipboard:write-text", text) as Promise<void>,
  openRepositorySession: path => ipcRenderer.invoke("commitscope:session:open", path),
  getRepositorySession: () => ipcRenderer.invoke("commitscope:session:get"),
  readSessionPreview: () => ipcRenderer.invoke("commitscope:session:preview"),
  readHistoryPage: (cursor, pageSize) => ipcRenderer.invoke("commitscope:history:read-page", cursor, pageSize),
  cancelHistoryRead: () => ipcRenderer.invoke("commitscope:history:cancel-read"),
  refreshRepositorySession: pageSize => ipcRenderer.invoke("commitscope:history:refresh", pageSize),
  recordRepositoryView: expectedGeneration => ipcRenderer.invoke("commitscope:session:record-view", expectedGeneration),
  closeRepositorySession: () => ipcRenderer.invoke("commitscope:session:close"),
  listRecentRepositories: () => ipcRenderer.invoke("commitscope:session:list-recent"),
};

contextBridge.exposeInMainWorld("commitScope", api);
