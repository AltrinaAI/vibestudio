"use client";

// A tiny external store the mounted editor publishes its save state into, so the
// chrome (top bar) can show one global Save button + ⌘S, and navigation can warn
// before discarding unsaved edits. Only one editor pane is mounted at a time.

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

/** Called by the active editor whenever its save state changes. */
export function publishEditorStatus(next: EditorStatus, save: () => void) {
  saveFn = save;
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
  if (status.present) {
    status = EMPTY;
    emit();
  }
}

/** Trigger a save on the active editor (no-op if nothing is mounted/dirty). */
export function requestSave() {
  saveFn?.();
}

/** Guard for navigation that would unmount the editor and drop unsaved edits. */
export function confirmDiscardIfDirty(): boolean {
  if (!status.dirty) return true;
  return window.confirm("You have unsaved changes that will be lost. Continue without saving?");
}

export function useEditorStatus(): EditorStatus {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
