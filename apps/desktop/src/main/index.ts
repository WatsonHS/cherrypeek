import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CoreProcess } from "./core-process.js";
import { ProtocolClientError } from "./protocol-transport.js";
import type { CoreStatus } from "../../../../packages/protocol/src/core-status.js";
import type { ErrorCode } from "../../../../packages/protocol/src/generated/server-message.js";
import type { RepositorySessionResult } from "../../../../packages/protocol/src/repository-session.js";
import type { RepositoryPreviewState } from "../../../../packages/protocol/src/repository-preview.js";
import { RepositoryPreviewController } from "./repository-preview-controller.js";
import { RepositorySessionController } from "./repository-session-controller.js";

const APP_ROOT = resolve(__dirname, "..");
const RENDERER_ENTRY = resolve(APP_ROOT, "renderer/index.html");
const PRELOAD_ENTRY = resolve(__dirname, "../preload.cjs");
const CORE_ENTRY = resolve(APP_ROOT, "resources/commitscope-daemon");
const APP_URL = pathToFileURL(RENDERER_ENTRY).href;
const IPC_GET_STATUS = "commitscope:core:get-status";
const IPC_STATUS_CHANGED = "commitscope:core:status-changed";
const IPC_CHOOSE_REPOSITORY = "commitscope:repository:choose";
const IPC_OPEN_REPOSITORY = "commitscope:repository:open";
const IPC_CANCEL_REPOSITORY = "commitscope:repository:cancel";
const IPC_GET_REPOSITORY = "commitscope:repository:get";
const IPC_REPOSITORY_CHANGED = "commitscope:repository:changed";
const IPC_SESSION_OPEN = "commitscope:session:open";
const IPC_SESSION_GET = "commitscope:session:get";
const IPC_SESSION_PREVIEW = "commitscope:session:preview";
const IPC_SESSION_RECORD_VIEW = "commitscope:session:record-view";
const IPC_SESSION_CLOSE = "commitscope:session:close";
const IPC_SESSION_LIST_RECENT = "commitscope:session:list-recent";
let window: BrowserWindow | undefined;
let core: CoreProcess | undefined;
let preview: RepositoryPreviewController | undefined;
let repositorySessions: RepositorySessionController | undefined;
let quitting = false;

function isTrustedMainFrame(event: IpcMainInvokeEvent): boolean {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.parent === null &&
    event.senderFrame.url === APP_URL);
}

function registerStatusIpc(): void {
  ipcMain.handle(IPC_GET_STATUS, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    if (!core) throw new Error("Core process is unavailable");
    return core.getStatus();
  });
  core?.subscribe((status: CoreStatus) => {
    if (window && !window.isDestroyed()) window.webContents.send(IPC_STATUS_CHANGED, status);
  });
  ipcMain.handle(IPC_CHOOSE_REPOSITORY, async event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    if (!window || window.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC_OPEN_REPOSITORY, async (event, path: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    if (preview) void preview.open(path);
  });
  ipcMain.handle(IPC_CANCEL_REPOSITORY, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    preview?.cancel();
  });
  ipcMain.handle(IPC_GET_REPOSITORY, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return preview?.getState();
  });
  preview?.subscribe((state: RepositoryPreviewState) => {
    if (window && !window.isDestroyed()) window.webContents.send(IPC_REPOSITORY_CHANGED, state);
  });
}

function registerRepositorySessionIpc(): void {
  ipcMain.handle(IPC_SESSION_OPEN, (event, path: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.open(path));
  });
  ipcMain.handle(IPC_SESSION_GET, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.get());
  });
  ipcMain.handle(IPC_SESSION_PREVIEW, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.readPreview());
  });
  ipcMain.handle(IPC_SESSION_RECORD_VIEW, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.recordView());
  });
  ipcMain.handle(IPC_SESSION_CLOSE, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.close());
  });
  ipcMain.handle(IPC_SESSION_LIST_RECENT, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.listRecent());
  });
}

async function sessionResult<T>(action: () => Promise<T>): Promise<RepositorySessionResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    const protocolError = error instanceof ProtocolClientError
      ? error
      : new ProtocolClientError("PROTOCOL_ERROR", error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      error: { code: protocolError.code as ErrorCode, message: protocolError.message, retryable: protocolError.retryable },
    };
  }
}


async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 850,
    minHeight: 560,
    show: false,
    webPreferences: {
      preload: PRELOAD_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== APP_URL) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  await window.loadFile(RENDERER_ENTRY);
  window.show();
  window.on("closed", () => {
    window = undefined;
    void quitApplication();
  });
}

async function quitApplication(): Promise<void> {
  if (quitting) return;
  quitting = true;
  repositorySessions?.dispose();
  await core?.stop();
  preview?.dispose();
  app.quit();
}

app.on("window-all-closed", () => { void quitApplication(); });
process.on("SIGINT", () => { void quitApplication(); });
process.on("SIGTERM", () => { void quitApplication(); });
app.on("before-quit", event => {
  if (!quitting) {
    event.preventDefault();
    void quitApplication();
  }
});
app.on("session-created", ses => {
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
});

void app.whenReady().then(async () => {
  const mode = process.argv.find(arg => arg.startsWith("--smoke-mode="))?.split("=", 2)[1];
  const executable = mode === "missing-core" ? resolve(APP_ROOT, "resources/missing-core") : CORE_ENTRY;
  const appDataDir = resolve(app.getPath("userData"), "repository-state");
  core = new CoreProcess(executable, {
    env: { ...process.env, COMMITSCOPE_APP_DATA_DIR: appDataDir },
  });
  preview = new RepositoryPreviewController(core);
  repositorySessions = new RepositorySessionController(core);
  registerStatusIpc();
  registerRepositorySessionIpc();
  await createWindow();
  if (!quitting) {
    await core.start();
    const repositoryArg = process.argv.find(arg => arg.startsWith("--repository="));
    const repositoryPath = repositoryArg?.slice("--repository=".length);
    if (!quitting && repositoryPath) await preview.open(repositoryPath);
  }
}).catch(async error => {
  process.stderr.write(`Desktop startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  repositorySessions?.dispose();
  await core?.stop();
  preview?.dispose();
  app.quit();
});
