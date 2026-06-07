"use client";

// A tiny external store the diff editor publishes its changed-chunk geometry
// into, so the overview ruler on the scroll pane (the one piece of diff chrome
// that can't be an in-editor decoration — you can't decorate the native
// scrollbar from inside CodeMirror) can place its marks. The editor is the only
// thing that can locate off-screen changes (CodeMirror virtualizes off-screen
// lines and only its height map knows their pixel position), so it reports them.
// The left change bars + revert buttons are in-editor decorations (see LiveEditor).

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
  /** The `.cm-editor` element, so the ruler can map editor-relative tops into the
   *  scroll pane's content coordinates. */
  el: HTMLElement;
  marks: DiffMark[];
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
