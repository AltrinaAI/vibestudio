"use client";

// A tiny external store the diff editor publishes its changed-chunk geometry
// into, so chrome OUTSIDE the editor (the overview ruler on the scroll pane) can
// place markers. The editor is the only thing that can locate off-screen changes
// (CodeMirror virtualizes off-screen lines and only its height map knows their
// pixel position), so it reports them; the ruler maps them onto the scroll pane.

import { useSyncExternalStore } from "react";

export interface DiffMark {
  /** Pixels from the top of the `.cm-editor` element (documentPadding + block top). */
  top: number;
  /** Pixel height of the changed block. */
  height: number;
  /** add = only new lines, mod = existing lines changed, del = lines removed. */
  kind: "add" | "mod" | "del";
  /** A position inside the chunk (to scroll/jump to). */
  pos: number;
}

export interface DiffGeometry {
  /** The `.cm-editor` element, so overlays can map editor-relative tops/lefts
   *  into the scroll pane's content coordinates. */
  el: HTMLElement;
  marks: DiffMark[];
  /** Revert a chunk (by a position inside it) to the committed version. */
  revert: (pos: number) => void;
}

let geom: DiffGeometry | null = null;
const listeners = new Set<() => void>();

/** Called by the diff editor's ViewPlugin (null when diffing stops). */
export function publishDiffGeometry(g: DiffGeometry | null) {
  geom = g;
  for (const l of listeners) l();
}

export function useDiffGeometry(): DiffGeometry | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => geom,
    () => geom,
  );
}
