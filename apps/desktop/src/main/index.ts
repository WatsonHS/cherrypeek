import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, session, type IpcMainInvokeEvent } from "electron";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CoreProcess } from "./core-process.js";
import { ProtocolClientError } from "./protocol-transport.js";
import type { CoreStatus } from "../../../../packages/protocol/src/core-status.js";
import type { ErrorCode } from "../../../../packages/protocol/src/generated/server-message.js";
import type { RepositorySessionResult } from "../../../../packages/protocol/src/repository-session.js";
import { RepositorySessionController } from "./repository-session-controller.js";

const APP_ROOT = resolve(__dirname, "..");
const RENDERER_ENTRY = resolve(APP_ROOT, "renderer/index.html");
const PRELOAD_ENTRY = resolve(__dirname, "../preload.cjs");
const CORE_ENTRY = resolve(APP_ROOT, "resources/commitscope-daemon");
const APP_URL = pathToFileURL(RENDERER_ENTRY).href;
const IPC_GET_STATUS = "commitscope:core:get-status";
const IPC_STATUS_CHANGED = "commitscope:core:status-changed";
const IPC_CHOOSE_REPOSITORY = "commitscope:repository:choose";
const IPC_LAUNCH_REPOSITORY = "commitscope:repository:launch";
const IPC_SESSION_OPEN = "commitscope:session:open";
const IPC_SESSION_GET = "commitscope:session:get";
const IPC_SESSION_PREVIEW = "commitscope:session:preview";
const IPC_SESSION_RECORD_VIEW = "commitscope:session:record-view";
const IPC_SESSION_CLOSE = "commitscope:session:close";
const IPC_SESSION_LIST_RECENT = "commitscope:session:list-recent";
const IPC_SESSION_NAVIGATION = "commitscope:session:navigation";
const IPC_SESSION_SELECT_SCOPE = "commitscope:session:select-scope";
const IPC_REF_MERGE_STATUS = "commitscope:refs:merge-status";
const IPC_REF_MERGE_STATUS_CANCEL = "commitscope:refs:merge-status:cancel";
const IPC_INDEX_STATUS = "commitscope:index:status";
const IPC_INDEX_CONTROL = "commitscope:index:control";
const IPC_SEARCH_COMMITS = "commitscope:search:commits";
const IPC_SEARCH_IDENTITIES = "commitscope:search:identities";
const IPC_SEARCH_PATHS = "commitscope:search:paths";
const IPC_SEARCH_CANCEL = "commitscope:search:cancel";
const IPC_COMMIT_GET = "commitscope:details:get";
const IPC_CHANGED_FILES = "commitscope:details:files";
const IPC_MERGE_COMMITS = "commitscope:details:merge";
const IPC_BRANCHES_CONTAINING = "commitscope:details:branches";
const IPC_READ_DIFF = "commitscope:details:diff";
const IPC_COMMIT_DETAILS_CANCEL = "commitscope:details:cancel";
const IPC_HISTORY_READ = "commitscope:history:read-page";
const IPC_HISTORY_LOCATE = "commitscope:history:locate-commit";
const IPC_HISTORY_CANCEL = "commitscope:history:cancel-read";
const IPC_HISTORY_REFRESH = "commitscope:history:refresh";
const IPC_COPY_TEXT = "commitscope:clipboard:write-text";
const MAX_COPY_TEXT_LENGTH = 64 * 1024;
const MAX_PATH_BYTES = 16 * 1024;
let window: BrowserWindow | undefined;
let core: CoreProcess | undefined;
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
  ipcMain.handle(IPC_LAUNCH_REPOSITORY, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return launchRepository();
  });
  ipcMain.handle(IPC_COPY_TEXT, (event, text: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_COPY_TEXT_LENGTH) throw new Error("Invalid clipboard text");
    clipboard.writeText(text);
  });
}

/** The repository passed with `--repository=` at launch; the renderer opens it like any other path. */
function launchRepository(): string | null {
  const path = process.argv.find(arg => arg.startsWith("--repository="))?.slice("--repository=".length);
  if (!path || !isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) return null;
  return path;
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
  ipcMain.handle(IPC_SESSION_RECORD_VIEW, (event, expectedGeneration: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.recordView(expectedGeneration));
  });
  ipcMain.handle(IPC_SESSION_CLOSE, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.close());
  });
  ipcMain.handle(IPC_SESSION_LIST_RECENT, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.listRecent());
  });
  ipcMain.handle(IPC_SESSION_NAVIGATION, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.getNavigation());
  });
  ipcMain.handle(IPC_SESSION_SELECT_SCOPE, (event, scope: unknown, pageSize: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.selectScope(scope, pageSize === undefined ? 200 : pageSize as number));
  });
  ipcMain.handle(IPC_REF_MERGE_STATUS, (event, refNames: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.getRefMergeStatus(refNames));
  });
  ipcMain.handle(IPC_REF_MERGE_STATUS_CANCEL, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.cancelRefMergeStatus());
  });
  ipcMain.handle(IPC_INDEX_STATUS, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.getMetadataIndexStatus());
  });
  ipcMain.handle(IPC_INDEX_CONTROL, (event, action: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.controlMetadataIndex(action));
  });
  ipcMain.handle(IPC_SEARCH_COMMITS, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.searchCommits(params));
  });
  ipcMain.handle(IPC_SEARCH_IDENTITIES, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.listSearchIdentities(params));
  });
  ipcMain.handle(IPC_SEARCH_PATHS, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.listSearchPaths(params));
  });
  ipcMain.handle(IPC_SEARCH_CANCEL, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.cancelSearch());
  });
  ipcMain.handle(IPC_COMMIT_GET, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.getCommit(params));
  });
  ipcMain.handle(IPC_CHANGED_FILES, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.listChangedFiles(params));
  });
  ipcMain.handle(IPC_MERGE_COMMITS, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.readMergeCommits(params));
  });
  ipcMain.handle(IPC_BRANCHES_CONTAINING, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.branchesContaining(params));
  });
  ipcMain.handle(IPC_READ_DIFF, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.readDiff(params));
  });
  ipcMain.handle(IPC_COMMIT_DETAILS_CANCEL, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.cancelCommitDetails());
  });
  ipcMain.handle(IPC_HISTORY_READ, (event, cursor: unknown, pageSize: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.readHistoryPage(cursor, pageSize === undefined ? 200 : pageSize as number));
  });
  ipcMain.handle(IPC_HISTORY_LOCATE, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.locateCommit(params));
  });
  ipcMain.handle(IPC_HISTORY_CANCEL, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.cancelHistoryRead());
  });
  ipcMain.handle(IPC_HISTORY_REFRESH, (event, pageSize: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.refreshRepository(pageSize === undefined ? 200 : pageSize as number));
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
    titleBarStyle: "hidden",
    titleBarOverlay: true,
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 16, y: 18 } } : {}),
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
  const syncWindowAppearance = () => {
    const dark = nativeTheme.shouldUseDarkColors;
    const background = dark ? "#121311" : "#f7f7f5";
    window?.setBackgroundColor(background);
    if (process.platform !== "darwin") {
      window?.setTitleBarOverlay({
        color: background,
        symbolColor: dark ? "#ecece8" : "#1b1b19",
        height: 52,
      });
    }
  };
  syncWindowAppearance();
  nativeTheme.on("updated", syncWindowAppearance);
  window.on("closed", () => nativeTheme.removeListener("updated", syncWindowAppearance));
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
  repositorySessions = new RepositorySessionController(core);
  registerStatusIpc();
  registerRepositorySessionIpc();
  await createWindow();
  if (!quitting) await core.start();
}).catch(async error => {
  process.stderr.write(`Desktop startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  repositorySessions?.dispose();
  await core?.stop();
  app.quit();
});
