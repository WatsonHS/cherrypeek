import { contextBridge, ipcRenderer } from "electron";
import type { CommitScopeApi, CoreStatus } from "../../../../packages/protocol/src/core-status.js";
import type { RepositoryPreviewState } from "../../../../packages/protocol/src/repository-preview.js";

const api: CommitScopeApi = {
  getCoreStatus: () => ipcRenderer.invoke("commitscope:core:get-status") as Promise<CoreStatus>,
  onCoreStatusChanged(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, status: CoreStatus) => listener(status);
    ipcRenderer.on("commitscope:core:status-changed", wrapped);
    return () => ipcRenderer.removeListener("commitscope:core:status-changed", wrapped);
  },
  chooseRepository: () => ipcRenderer.invoke("commitscope:repository:choose") as Promise<string | null>,
  openRepositoryPreview: path => ipcRenderer.invoke("commitscope:repository:open", path) as Promise<void>,
  cancelRepositoryPreview: () => ipcRenderer.invoke("commitscope:repository:cancel") as Promise<void>,
  getRepositoryPreview: () => ipcRenderer.invoke("commitscope:repository:get") as Promise<RepositoryPreviewState>,
  onRepositoryPreviewChanged(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, state: RepositoryPreviewState) => listener(state);
    ipcRenderer.on("commitscope:repository:changed", wrapped);
    return () => ipcRenderer.removeListener("commitscope:repository:changed", wrapped);
  },
  copyText: text => ipcRenderer.invoke("commitscope:clipboard:write-text", text) as Promise<void>,
  openRepositorySession: path => ipcRenderer.invoke("commitscope:session:open", path),
  getRepositorySession: () => ipcRenderer.invoke("commitscope:session:get"),
  readSessionPreview: () => ipcRenderer.invoke("commitscope:session:preview"),
  recordRepositoryView: () => ipcRenderer.invoke("commitscope:session:record-view"),
  closeRepositorySession: () => ipcRenderer.invoke("commitscope:session:close"),
  listRecentRepositories: () => ipcRenderer.invoke("commitscope:session:list-recent"),
};

contextBridge.exposeInMainWorld("commitScope", api);
