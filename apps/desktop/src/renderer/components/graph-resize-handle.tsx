import * as React from "react";
import { MAX_GRAPH_LANES, MIN_GRAPH_LANES } from "../lib/graph.js";

export function GraphResizeHandle({ left, lanes, drawnLanes, laneGap, onChange, onReset }: {
  left: number; lanes: number; drawnLanes: number; laneGap: number;
  onChange(lanes: number): void; onReset(): void;
}): React.JSX.Element {
  const drag = React.useRef<{ x: number; lanes: number } | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const resize = (value: number) => onChange(Math.max(MIN_GRAPH_LANES, Math.min(MAX_GRAPH_LANES, Math.round(value))));
  const stop = () => { drag.current = null; setDragging(false); };
  return <div role="separator" aria-label="调整分支图宽度" aria-orientation="vertical" tabIndex={0}
    aria-valuemin={MIN_GRAPH_LANES} aria-valuemax={MAX_GRAPH_LANES} aria-valuenow={lanes} aria-valuetext={`最多显示 ${lanes} 列图线`}
    title="拖动调整图宽，左右键逐列调整，双击恢复默认" data-testid="graph-resize-handle" data-dragging={dragging}
    className={`group absolute top-[34px] bottom-0 z-20 flex w-2 cursor-col-resize touch-none justify-center outline-none ${dragging ? "select-none" : ""}`}
    style={{ left }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, lanes: drawnLanes };
      setDragging(true);
    }}
    onPointerMove={event => { if (drag.current) resize(drag.current.lanes + (event.clientX - drag.current.x) / laneGap); }}
    onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}
    onDoubleClick={onReset}
    onKeyDown={event => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
        event.preventDefault(); event.stopPropagation();
        resize(event.key === "Home" ? MIN_GRAPH_LANES : event.key === "End" ? MAX_GRAPH_LANES : lanes + (event.key === "ArrowLeft" ? -1 : 1));
      }
    }}>
    <span className={`w-px bg-line2 transition-opacity group-hover:opacity-100 group-focus-visible:bg-accent group-focus-visible:opacity-100 ${dragging ? "opacity-100" : "opacity-0"}`} />
  </div>;
}
