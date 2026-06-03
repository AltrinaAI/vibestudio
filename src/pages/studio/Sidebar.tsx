"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FileTree from "./FileTree";
import SourceControl from "./SourceControl";
import type { SkillData } from "@/lib/types";

/** Left sidebar: the file tree on top and the Versions (git) panel below it,
 *  separated by a draggable divider that resizes the split — VS Code style. */
export default function Sidebar({
  data,
  selected,
  onSelect,
}: {
  data: SkillData;
  selected: string | null;
  onSelect: (rel: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [versionsH, setVersionsH] = useState(300); // px height of the bottom panel
  const dragging = useRef(false);

  const onMove = useCallback((e: PointerEvent) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const h = rect.bottom - e.clientY;
    setVersionsH(Math.max(120, Math.min(rect.height - 160, h)));
  }, []);
  const stop = useCallback(() => {
    dragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
  }, [onMove]);
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
  };
  useEffect(() => stop, [stop]); // tear down listeners if unmounted mid-drag

  return (
    <aside ref={containerRef} className="flex h-full w-60 shrink-0 flex-col overflow-hidden border-r border-border bg-panel">
      {/* Files (fills the remaining space) */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="px-4 pb-1 pt-3 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Files</div>
        <nav className="min-h-0 flex-1 overflow-auto">
          <FileTree nodes={data.tree} selected={selected} onSelect={onSelect} />
        </nav>
      </div>

      {/* Draggable divider */}
      <div
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={startDrag}
        title="Drag to resize"
        className="group relative h-px shrink-0 cursor-row-resize bg-border"
      >
        <div className="absolute inset-x-0 -top-1 -bottom-1 z-10" />
        <div className="absolute inset-x-0 top-0 h-px bg-transparent group-hover:bg-accent" />
      </div>

      {/* Versions (git) — its own "New Changes" / "Versions" section headers. */}
      <div className="flex shrink-0 flex-col overflow-hidden" style={{ height: versionsH }}>
        <SourceControl root={data.root} dirName={data.dirName} />
      </div>
    </aside>
  );
}
