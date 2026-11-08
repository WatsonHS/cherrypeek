import * as React from "react";

const DEFAULT_SIDEBAR_WIDTH = 400;
const HANDLE_WIDTH = 8;

export function HistorySplitView({ sidebar, children }: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [containerWidth, setContainerWidth] = React.useState(0);
  const [sidebarWidth, setSidebarWidth] = React.useState(DEFAULT_SIDEBAR_WIDTH);
  const [dragging, setDragging] = React.useState(false);
  const detailMinWidth = Math.min(360, Math.max(240, containerWidth * 0.45));
  const sidebarMinWidth = Math.min(320, Math.max(160, containerWidth - detailMinWidth - HANDLE_WIDTH));
  const sidebarMaxWidth = Math.max(sidebarMinWidth, containerWidth - detailMinWidth - HANDLE_WIDTH);
  const visibleSidebarWidth = Math.max(sidebarMinWidth, Math.min(sidebarWidth, sidebarMaxWidth));

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

  return <div ref={rootRef} data-testid="history-split-view" className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${dragging ? "select-none" : ""}`}>
    <aside data-testid="history-sidebar" className="flex min-h-0 min-w-0 shrink-0 overflow-hidden" style={{ width: visibleSidebarWidth }}>
      {sidebar}
    </aside>
    <div role="separator" aria-label="调整提交列表宽度" aria-orientation="vertical" tabIndex={0}
      aria-valuemin={Math.round(sidebarMinWidth)} aria-valuemax={Math.round(sidebarMaxWidth)} aria-valuenow={Math.round(visibleSidebarWidth)}
      data-testid="history-resize-handle" className="group relative z-10 flex w-2 shrink-0 cursor-col-resize touch-none items-stretch justify-center outline-none"
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
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
  </div>;
}
