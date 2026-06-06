"use client";

// A tiny external store the mounted editor publishes its autosave state into, so
// the chrome can surface a save *failure* and other panels can react when a write
// lands on disk. Saving itself is automatic (debounced) — there's no Save button
// and no "you have unsaved changes" prompt in the normal case. Only one editor
// pane is mounted at a time.

import { useSyncExternalStore } from "react";

export interface EditorStatus {
  /** An editable document is mounted. */
  present: boolean;
  /** The buffer differs from what's on disk. */
  dirty: boolean;
  saving: boolean;
  error: string | null;
}

const EMPTY: EditorStatus = { present: false, dirty: false, saving: false, error: null };

let status: EditorStatus = EMPTY;
let saveFn: (() => void) | null = null;
let flushFn: (() => Promise<void>) | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function getSnapshot() {
  return status;
}

/** Called by the active editor whenever its save state changes. `flush` writes
 *  any pending buffer to disk and resolves once it's persisted (awaitable, unlike
 *  the fire-and-forget `save`). */
export function publishEditorStatus(next: EditorStatus, save: () => void, flush: () => Promise<void>) {
  saveFn = save;
  flushFn = flush;
  if (
    next.present !== status.present ||
    next.dirty !== status.dirty ||
    next.saving !== status.saving ||
    next.error !== status.error
  ) {
    status = next;
    emit();
  }
}

/** Called when the active editor unmounts. */
export function clearEditorStatus() {
  saveFn = null;
  flushFn = null;
  if (status.present) {
    status = EMPTY;
    emit();
  }
}

/** Retry the active editor's autosave (used by the failure indicator). No-op if
 *  nothing is mounted or there's nothing to save. */
export function requestSave() {
  saveFn?.();
}

/** Flush the active editor's pending buffer to disk and wait for it to land —
 *  used before a deliberate working-tree swap so the user's latest edits are
 *  persisted (and thus stashed), never dropped. No-op when nothing is mounted. */
export async function flushEditor(): Promise<void> {
  await flushFn?.();
}

// Pause on autosave WRITES, held while the app deliberately swaps the working
// tree under a mounted editor (entering/leaving a version preview). Without it,
// the dying editor's unmount-flush would write its now-stale buffer back over the
// freshly checked-out version. A COUNTER (not a flag) so overlapping transitions
// — e.g. rapidly switching versions — stay held until the LAST one releases,
// rather than an early release uncovering a still-in-flight swap.
let autosaveHolds = 0;
export function holdAutosave() {
  autosaveHolds += 1;
}
export function releaseAutosave() {
  autosaveHolds = Math.max(0, autosaveHolds - 1);
}
export function isAutosaveHeld(): boolean {
  return autosaveHolds > 0;
}

/** True when the active editor's last autosave FAILED — its buffer isn't on disk.
 *  Normal (clean / mid-debounce) edits aren't "unsaved"; autosave persists them. */
export function hasSaveError(): boolean {
  return status.present && status.error != null;
}

/** Guard for navigation away from an editor whose last autosave failed (so the
 *  un-persisted edit would be lost). Clean/saving edits never prompt — autosave
 *  flushes them on unmount. */
export function confirmLeaveUnsaved(): boolean {
  if (!hasSaveError()) return true;
  return window.confirm("Your last change couldn’t be saved and will be lost. Leave anyway?");
}

/** Imperative read of whether the active editor has unsaved edits right now —
 *  e.g. to avoid remounting it (and dropping keystrokes) during async work. */
export function isEditorDirty(): boolean {
  return status.dirty;
}

// One-shot bypass for a navigation that intentionally discards the editor — e.g.
// the edited skill folder was just deleted, so prompting to "save" a gone file is
// wrong. Armed synchronously right before navigating; consumed (read-and-reset)
// once inside the navigation guard so it can never leak to a later navigation.
let discardBypass = false;
export function armDiscardBypass() {
  discardBypass = true;
}
export function consumeDiscardBypass(): boolean {
  if (!discardBypass) return false;
  discardBypass = false;
  return true;
}

export function useEditorStatus(): EditorStatus {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
