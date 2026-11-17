import { screen, type BrowserWindow } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_WINDOW_WIDTH = 1180;
export const DEFAULT_WINDOW_HEIGHT = 760;
export const MIN_WINDOW_WIDTH = 850;
export const MIN_WINDOW_HEIGHT = 560;

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function isVisibleOnAnyDisplay(x: number, y: number, width: number, height: number): boolean {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return false;
  return displays.some(display => {
    const area = display.workArea;
    const overlapWidth = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
    const overlapHeight = Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
    return overlapWidth >= 120 && overlapHeight >= 80;
  });
}

/** Reads persisted window bounds, discarding off-screen coordinates or undersized dimensions. */
export function readWindowState(filePath: string): WindowState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
    }
    const raw = parsed as Record<string, unknown>;
    const rawWidth = finiteInteger(raw.width);
    const rawHeight = finiteInteger(raw.height);
    const width = rawWidth !== undefined ? Math.max(MIN_WINDOW_WIDTH, rawWidth) : DEFAULT_WINDOW_WIDTH;
    const height = rawHeight !== undefined ? Math.max(MIN_WINDOW_HEIGHT, rawHeight) : DEFAULT_WINDOW_HEIGHT;
    const x = finiteInteger(raw.x);
    const y = finiteInteger(raw.y);
    const hasValidPosition = x !== undefined && y !== undefined && isVisibleOnAnyDisplay(x, y, width, height);
    return {
      ...(hasValidPosition ? { x, y } : {}),
      width,
      height,
      ...(raw.isMaximized === true ? { isMaximized: true } : {}),
    };
  } catch {
    return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
  }
}

export function writeWindowState(filePath: string, state: WindowState): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(state), "utf8");
  } catch {
    // Failing to persist window geometry is non-fatal.
  }
}

/** Tracks normal window bounds and persists them on resize/move (debounced) and close. */
export function trackWindowState(win: BrowserWindow, filePath: string, initialState: WindowState): void {
  let normalBounds: { x?: number; y?: number; width: number; height: number } = {
    ...(initialState.x !== undefined && initialState.y !== undefined ? { x: initialState.x, y: initialState.y } : {}),
    width: initialState.width,
    height: initialState.height,
  };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const captureNormalBounds = () => {
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
    const bounds = win.getBounds();
    normalBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  };

  const persistNow = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    captureNormalBounds();
    writeWindowState(filePath, {
      ...normalBounds,
      ...(!win.isDestroyed() && win.isMaximized() ? { isMaximized: true } : {}),
    });
  };

  const schedulePersist = () => {
    captureNormalBounds();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      if (win.isDestroyed()) return;
      writeWindowState(filePath, {
        ...normalBounds,
        ...(win.isMaximized() ? { isMaximized: true } : {}),
      });
    }, 300);
  };

  win.on("resize", schedulePersist);
  win.on("move", schedulePersist);
  win.on("maximize", schedulePersist);
  win.on("unmaximize", schedulePersist);
  win.on("close", persistNow);
}
