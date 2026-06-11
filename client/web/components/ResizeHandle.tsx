"use client";

import { useEffect, useRef } from "react";

/** Thin draggable divider (a VS Code sash): `row` separates stacked sections and
 *  drags vertically, `col` separates side-by-side panes and drags horizontally.
 *  It reports the pointer's relevant coordinate; the owner turns that into a
 *  size. When `active` is false it renders as a plain separator line. */
export default function ResizeHandle({
  axis,
  onDragTo,
  onDragStart,
  onDragEnd,
  active = true,
  className = "",
}: {
  axis: "row" | "col";
  onDragTo: (clientPos: number) => void;
  onDragStart?: (clientPos: number) => void;
  onDragEnd?: () => void;
  active?: boolean;
  className?: string;
}) {
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []); // tear down listeners if unmounted mid-drag

  const line = axis === "row" ? "h-px" : "w-px";
  if (!active) return <div className={`${line} shrink-0 bg-border ${className}`} />;

  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    onDragStart?.(axis === "row" ? e.clientY : e.clientX);
    const move = (ev: PointerEvent) => onDragTo(axis === "row" ? ev.clientY : ev.clientX);
    const stop = () => {
      stopRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      onDragEnd?.();
    };
    stopRef.current = stop;
    document.body.style.cursor = axis === "row" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <div
      role="separator"
      aria-orientation={axis === "row" ? "horizontal" : "vertical"}
      onPointerDown={start}
      title="Drag to resize"
      className={`group relative ${line} shrink-0 bg-border ${
        axis === "row" ? "cursor-row-resize" : "cursor-col-resize"
      } ${className}`}
    >
      <div className={`absolute z-10 ${axis === "row" ? "inset-x-0 -bottom-1 -top-1" : "inset-y-0 -left-1 -right-1"}`} />
      <div
        className={`absolute bg-transparent group-hover:bg-accent ${
          axis === "row" ? "inset-x-0 top-0 h-px" : "inset-y-0 left-0 w-px"
        }`}
      />
    </div>
  );
}
