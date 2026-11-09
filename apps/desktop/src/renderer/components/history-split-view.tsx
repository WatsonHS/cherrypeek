import * as React from "react";
import { cn } from "../lib/utils.js";

const DEFAULT_SIDEBAR_WIDTH = 400;
const HANDLE_WIDTH = 8;
const NARROW_WINDOW = "(max-width: 1099px)";

function subscribeNarrowWindow(listener: () => void): () => void {
  const query = window.matchMedia(NARROW_WINDOW);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
const isNarrowWindow = () => window.matchMedia(NARROW_WINDOW).matches;
export function useNarrowHistoryLayout(): boolean {
  return React.useSyncExternalStore(subscribeNarrowWindow, isNarrowWindow);
}

export function HistorySplitView({ sidebar, children, narrow, detailOpen, active, onCloseDetail }: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  narrow: boolean;
  detailOpen: boolean;
  active: boolean;
  onCloseDetail(): void;
}): React.JSX.Element {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const sidebarRef = React.useRef<HTMLElement>(null);
  const detailRef = React.useRef<HTMLDivElement>(null);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const wasOpen = React.useRef(false);
  const drawerOpen = narrow && detailOpen && active;
  const dragRef = React.useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [containerWidth, setContainerWidth] = React.useState(0);
  const [sidebarWidth, setSidebarWidth] = React.useState(DEFAULT_SIDEBAR_WIDTH);
  const [dragging, setDragging] = React.useState(false);
  const detailMinWidth = Math.min(360, Math.max(240, containerWidth * 0.45));
  const sidebarMinWidth = Math.min(320, Math.max(160, containerWidth - detailMinWidth - HANDLE_WIDTH));
  const sidebarMaxWidth = Math.max(sidebarMinWidth, containerWidth - detailMinWidth - HANDLE_WIDTH);
  const visibleSidebarWidth = Math.max(sidebarMinWidth, Math.min(sidebarWidth, sidebarMaxWidth));

  React.useLayoutEffect(() => {
    if (drawerOpen && !wasOpen.current) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      detailRef.current?.querySelector<HTMLElement>('[aria-label="关闭详情"]')?.focus({ preventScroll: true });
    } else if (!drawerOpen && wasOpen.current && active) {
      if (!narrow) detailRef.current?.focus({ preventScroll: true });
      else {
        const target = returnFocus.current;
        if (target?.isConnected && sidebarRef.current?.contains(target)) target.focus({ preventScroll: true });
        else sidebarRef.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus({ preventScroll: true });
      }
    }
    wasOpen.current = drawerOpen;
  }, [drawerOpen, active, narrow]);

  React.useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      // Menus, the command palette, and handoff dialogs dismiss their own layer first.
      if (document.querySelector('[role="menu"], [data-slot="popover-content"][data-state="open"], [role="dialog"]:not([data-testid="commit-detail-pane"])')) return;
      event.preventDefault();
      onCloseDetail();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, onCloseDetail]);

  React.useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const updateWidth = () => setContainerWidth(element.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const resize = React.useCallback((nextWidth: number) => {
    setSidebarWidth(Math.max(sidebarMinWidth, Math.min(nextWidth, sidebarMaxWidth)));
  }, [sidebarMinWidth, sidebarMaxWidth]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: visibleSidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resize(drag.startWidth + event.clientX - drag.startX);
  };

  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  return <div ref={rootRef} data-testid="history-split-view" data-layout={narrow ? "narrow" : "split"} className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden ${dragging ? "select-none" : ""}`}>
    <aside ref={sidebarRef} data-testid="history-sidebar" inert={drawerOpen} className="flex min-h-0 min-w-0 shrink-0 overflow-hidden" style={{ width: narrow ? "100%" : visibleSidebarWidth }}>
      {sidebar}
    </aside>
    <div role="separator" aria-label="调整提交列表宽度" aria-orientation="vertical" tabIndex={0}
      aria-valuemin={Math.round(sidebarMinWidth)} aria-valuemax={Math.round(sidebarMaxWidth)} aria-valuenow={Math.round(visibleSidebarWidth)}
      data-testid="history-resize-handle" className={cn("group relative z-10 w-2 shrink-0 cursor-col-resize touch-none items-stretch justify-center outline-none", narrow ? "hidden" : "flex")}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onDoubleClick={() => resize(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={event => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          resize(visibleSidebarWidth + (event.key === "ArrowLeft" ? -24 : 24));
        }
      }}>
      <span aria-hidden="true" className="w-px bg-line group-hover:bg-accent group-focus-visible:bg-accent" />
    </div>
    {drawerOpen ? <button type="button" tabIndex={-1} aria-label="关闭详情遮罩" data-testid="detail-drawer-backdrop"
      className="absolute inset-0 z-20 cursor-default bg-[var(--scrim)]" onClick={onCloseDetail} /> : null}
    <div ref={detailRef} data-testid="commit-detail-pane" role={drawerOpen ? "dialog" : undefined} aria-label={drawerOpen ? "提交详情" : undefined}
      tabIndex={-1} className={cn("min-h-0 min-w-0 overflow-hidden outline-none", narrow
        ? detailOpen ? "absolute inset-y-0 right-0 z-30 flex w-[min(560px,100%)] border-l border-line bg-panel shadow-[-14px_0_36px_rgba(20,20,18,.18)]" : "hidden"
        : "flex flex-1")}>
      {children}
    </div>
  </div>;
}
