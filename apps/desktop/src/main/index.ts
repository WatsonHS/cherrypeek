import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, session, type IpcMainInvokeEvent } from "electron";
import { watch, readdirSync, type FSWatcher } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { RepositoryObservationEvent } from "../../../../packages/protocol/src/repository-session.js";
import type { RepositorySessionInfo } from "../../../../packages/protocol/src/generated/server-message.js";
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
const CORE_ENTRY = app.isPackaged
  ? resolve(process.resourcesPath, "commitscope-daemon")
  : resolve(APP_ROOT, "resources/commitscope-daemon");
const APP_URL = pathToFileURL(RENDERER_ENTRY).href;
const IPC_GET_STATUS = "commitscope:core:get-status";
const IPC_STATUS_CHANGED = "commitscope:core:status-changed";
const IPC_RESTART_CORE = "commitscope:core:restart";
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
const IPC_ACTIVITY_STATS = "commitscope:activity:stats";
const IPC_ACTIVITY_STATS_CANCEL = "commitscope:activity:stats:cancel";
const IPC_REPOSITORY_OBSERVE = "commitscope:updates:observe";
const IPC_REPOSITORY_OBSERVE_CANCEL = "commitscope:updates:observe:cancel";
const IPC_REPOSITORY_OBSERVED = "commitscope:updates:observed";
const IPC_REFS_DIFF = "commitscope:updates:diff";
const IPC_REFS_DIFF_CANCEL = "commitscope:updates:diff:cancel";
const IPC_HANDOFF_FACTS = "commitscope:handoff:facts";
const IPC_HANDOFF_CANCEL = "commitscope:handoff:cancel";
const IPC_COMMIT_GET = "commitscope:details:get";
const IPC_CHANGED_FILES = "commitscope:details:files";
const IPC_MERGE_COMMITS = "commitscope:details:merge";
const IPC_BRANCHES_CONTAINING = "commitscope:details:branches";
const IPC_READ_DIFF = "commitscope:details:diff";
const IPC_COMMIT_DETAILS_CANCEL = "commitscope:details:cancel";
const IPC_HISTORY_READ = "commitscope:history:read-page";
const IPC_HISTORY_LOCATE = "commitscope:history:locate-commit";
const IPC_HISTORY_LOCATE_DATE = "commitscope:history:locate-date";
const IPC_HISTORY_CANCEL = "commitscope:history:cancel-read";
const IPC_HISTORY_REFRESH = "commitscope:history:refresh";
const IPC_WORKSPACE_STATUS = "commitscope:workspace:status";
const IPC_WORKSPACE_DIFF = "commitscope:workspace:diff";
const IPC_WORKSPACE_FILE = "commitscope:workspace:file";
const IPC_WORKSPACE_CANCEL = "commitscope:workspace:cancel";
const IPC_WORKSPACE_CHANGED = "commitscope:workspace:changed";
const IPC_FILES_TREE = "commitscope:files:tree";
const IPC_FILES_CONTENT = "commitscope:files:content";
const IPC_FILES_HISTORY = "commitscope:files:history";
const IPC_FILES_CHANGE = "commitscope:files:change";
const IPC_FILES_BLAME = "commitscope:files:blame";
const IPC_FILES_BLAME_CHUNK = "commitscope:files:blame-chunk";
const IPC_FILES_CANCEL = "commitscope:files:cancel";
const IPC_COPY_TEXT = "commitscope:clipboard:write-text";
const MAX_COPY_TEXT_LENGTH = 64 * 1024;
const MAX_PATH_BYTES = 16 * 1024;
let window: BrowserWindow | undefined;
let core: CoreProcess | undefined;
let repositorySessions: RepositorySessionController | undefined;
let quitting = false;
let repositoryWatchers: FSWatcher[] = [];
let observationTimer: ReturnType<typeof setTimeout> | undefined;
let observationFallback: ReturnType<typeof setInterval> | undefined;
let workspaceChangeTimer: ReturnType<typeof setTimeout> | undefined;

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
  ipcMain.handle(IPC_RESTART_CORE, async event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    if (quitting) return;
    await core?.restart();
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
    return sessionResult(async () => {
      const result = await repositorySessions!.open(path);
      configureRepositoryObservation(result);
      return result;
    });
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
    return sessionResult(async () => {
      const result = await repositorySessions!.close();
      clearRepositoryObservation();
      return result;
    });
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
    return sessionResult(async () => {
      const result = await repositorySessions!.selectScope(scope, pageSize === undefined ? 200 : pageSize as number);
      configureRepositoryObservation(result.session);
      return result;
    });
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
  ipcMain.handle(IPC_HISTORY_READ, (event, cursor: unknown, pageSize: unknown, contentOnly: unknown = false) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(async () => {
      if (typeof contentOnly !== "boolean") throw new ProtocolClientError("INVALID_REQUEST", "历史页读取参数无效");
      const page = await repositorySessions!.readHistoryPage(cursor, pageSize === undefined ? 200 : pageSize as number);
      if (!contentOnly) return page;
      const { repository, refs, refsTruncated, ...content } = page;
      return content;
    });
  });
  ipcMain.handle(IPC_HISTORY_LOCATE, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.locateCommit(params));
  });
  ipcMain.handle(IPC_HISTORY_LOCATE_DATE, (event, beforeTimestamp: unknown, pageSize: unknown, knownCursors: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.locateHistoryDate(
      beforeTimestamp,
      pageSize === undefined ? 200 : pageSize as number,
      knownCursors === undefined ? [] : knownCursors,
    ));
  });
  ipcMain.handle(IPC_HISTORY_CANCEL, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.cancelHistoryRead());
  });
  ipcMain.handle(IPC_HISTORY_REFRESH, (event, pageSize: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(async () => {
      const result = await repositorySessions!.refreshRepository(pageSize === undefined ? 200 : pageSize as number);
      configureRepositoryObservation(result.session);
      return result;
    });
  });
  ipcMain.handle(IPC_ACTIVITY_STATS, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.getActivityStats(params));
  });
  ipcMain.handle(IPC_ACTIVITY_STATS_CANCEL, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.cancelActivityStats());
  });
  ipcMain.handle(IPC_REPOSITORY_OBSERVE, (event) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(async () => {
      const identity = repositorySessions!.getCurrentSessionIdentity();
      const observation = await repositorySessions!.observeRepository();
      if (identity) broadcastRepositoryObservation({ ...identity, browsingGeneration: identity.generation, observation });
      return observation;
    });
  });
  ipcMain.handle(IPC_REPOSITORY_OBSERVE_CANCEL, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.cancelRepositoryObservation());
  });
  ipcMain.handle(IPC_REFS_DIFF, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.diffRefSnapshots());
  });
  ipcMain.handle(IPC_REFS_DIFF_CANCEL, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.cancelRefSnapshotDiff());
  });
  ipcMain.handle(IPC_HANDOFF_FACTS, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.getHandoffFacts(params));
  });
  ipcMain.handle(IPC_HANDOFF_CANCEL, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.cancelHandoffFacts());
  });
  ipcMain.handle(IPC_WORKSPACE_STATUS, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.readWorkspaceStatus(params));
  });
  ipcMain.handle(IPC_WORKSPACE_DIFF, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.readWorkspaceDiff(params));
  });
  ipcMain.handle(IPC_WORKSPACE_FILE, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.readWorkspaceFile(params));
  });
  ipcMain.handle(IPC_WORKSPACE_CANCEL, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.cancelWorkspace());
  });
  ipcMain.handle(IPC_FILES_TREE, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.listTree(params));
  });
  ipcMain.handle(IPC_FILES_CONTENT, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.readFileContent(params));
  });
  ipcMain.handle(IPC_FILES_HISTORY, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.readFileHistory(params));
  });
  ipcMain.handle(IPC_FILES_CHANGE, (event, params: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.readFileChange(params));
  });
  ipcMain.handle(IPC_FILES_BLAME, (event, params: unknown, streamId: unknown) => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(async () => {
      if (typeof streamId !== "string" || !/^[A-Za-z0-9-]{1,64}$/u.test(streamId)) throw new ProtocolClientError("INVALID_REQUEST", "逐行追溯的流标识无效");
      const sender = event.sender;
      return repositorySessions!.readBlame(params, chunk => {
        if (!sender.isDestroyed()) sender.send(IPC_FILES_BLAME_CHUNK, { streamId, chunk });
      });
    });
  });
  ipcMain.handle(IPC_FILES_CANCEL, event => {
    if (!isTrustedMainFrame(event)) throw new Error("Untrusted IPC sender");
    return sessionResult(() => repositorySessions!.cancelFiles());
  });
}

function broadcastRepositoryObservation(event: RepositoryObservationEvent): void {
  if (window && !window.isDestroyed()) window.webContents.send(IPC_REPOSITORY_OBSERVED, event);
}

function configureRepositoryObservation(sessionInfo: RepositorySessionInfo): void {
  clearRepositoryObservation();
  const refsDirs = [join(sessionInfo.repository.commonDir, "refs"), join(sessionInfo.repository.gitDir, "refs")];
  const paths = new Set([join(sessionInfo.repository.gitDir, "HEAD"), join(sessionInfo.repository.commonDir, "packed-refs"), join(sessionInfo.repository.commonDir, "worktrees"), ...refsDirs]);
  const dirs = new Set<string>();
  for (const root of refsDirs) collectDirectories(root, dirs);
  for (const path of [...paths, ...dirs]) {
    try {
      repositoryWatchers.push(watch(path, () => scheduleRepositoryObservation()));
    } catch { /* Git metadata may be absent or inaccessible; focus and visible polling remain. */ }
  }
  configureWorkspaceWatch(sessionInfo);
  observationFallback = setInterval(() => {
    if (window && !window.isDestroyed() && window.isVisible()) void observeAndBroadcast();
  }, 5_000);
  scheduleRepositoryObservation();
}

/** Git metadata that changes what `git status` reports: staging, HEAD moves and in-progress operations. */
const WORKSPACE_GIT_FILES = new Set(["index", "HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_LOG"]);

/**
 * Watches the window's working tree as a hint that its status may have changed (P4-09).
 * The hint only triggers a re-read in the renderer; it never decides whether the tree is clean.
 */
function configureWorkspaceWatch(sessionInfo: RepositorySessionInfo): void {
  const worktree = sessionInfo.repository.worktreePath;
  if (sessionInfo.repository.isBare || !worktree) return;
  const notify = () => {
    if (workspaceChangeTimer) clearTimeout(workspaceChangeTimer);
    workspaceChangeTimer = setTimeout(() => {
      workspaceChangeTimer = undefined;
      if (window && !window.isDestroyed()) window.webContents.send(IPC_WORKSPACE_CHANGED, { repoId: sessionInfo.repoId });
    }, 800);
  };
  const gitDirName = ".git";
  try {
    repositoryWatchers.push(watch(worktree, { recursive: true }, (_event, filename) => {
      const name = typeof filename === "string" ? filename.replaceAll("\\", "/") : null;
      if (name === null) { notify(); return; }
      if (name === gitDirName || name.startsWith(`${gitDirName}/`)) {
        const inner = name.slice(gitDirName.length + 1);
        if (WORKSPACE_GIT_FILES.has(inner) || inner.startsWith("rebase-merge") || inner.startsWith("rebase-apply")) notify();
        return;
      }
      notify();
    }));
  } catch { /* Watching is a hint; focus and manual refresh still re-read the status. */ }
  // A linked worktree keeps its index and HEAD outside the directory.
  const worktreeGitDir = sessionInfo.repository.gitDir;
  if (!resolve(worktreeGitDir).startsWith(resolve(worktree))) {
    try {
      repositoryWatchers.push(watch(worktreeGitDir, (_event, filename) => {
        if (typeof filename !== "string" || WORKSPACE_GIT_FILES.has(filename) || filename.startsWith("rebase-")) notify();
      }));
    } catch { /* see above */ }
  }
}

function collectDirectories(path: string, output: Set<string>): void {
  try {
    output.add(path);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) collectDirectories(join(path, entry.name), output);
    }
  } catch { /* Missing refs directories are normal in empty repositories. */ }
}

function scheduleRepositoryObservation(): void {
  if (observationTimer) clearTimeout(observationTimer);
  observationTimer = setTimeout(() => {
    observationTimer = undefined;
    void observeAndBroadcast();
  }, 300);
}

async function observeAndBroadcast(): Promise<void> {
  if (!repositorySessions) return;
  const identity = repositorySessions.getCurrentSessionIdentity();
  if (!identity) return;
  const result = await sessionResult(() => repositorySessions!.observeRepository());
  if (!result.ok) return;
  broadcastRepositoryObservation({ ...identity, browsingGeneration: identity.generation, observation: result.value });
}

function clearRepositoryObservation(): void {
  for (const watcher of repositoryWatchers) watcher.close();
  repositoryWatchers = [];
  if (observationTimer) clearTimeout(observationTimer);
  observationTimer = undefined;
  if (observationFallback) clearInterval(observationFallback);
  observationFallback = undefined;
  if (workspaceChangeTimer) clearTimeout(workspaceChangeTimer);
  workspaceChangeTimer = undefined;
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
  window.on("focus", () => { void observeAndBroadcast(); });
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
  clearRepositoryObservation();
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
