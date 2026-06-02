"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clearEditorStatus, publishEditorStatus } from "@/lib/editorState";

export type SaveStatus = "saved" | "dirty" | "saving" | "error";

/**
 * Explicit, manual save for a derived string `value` (no autosave).
 * - `save(value)` persists and resolves; call it via the returned `save()`,
 *   the global Save button, or ⌘S / Ctrl-S.
 * - Tracks dirty/saving/error and publishes them to the shared editor store.
 * - Warns (beforeunload) if the tab is closed with unsaved changes.
 * - `onSaved` fires after each successful save (fire-and-forget) — the hook the
 *   host uses to run the post-save pipeline.
 */
export function useManualSave(
  value: string,
  save: (value: string) => Promise<void>,
  enabled = true,
  onSaved?: () => void,
) {
  const [savedValue, setSavedValue] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = enabled && value !== savedValue;

  // Live refs so the stable doSave/listeners always see current values. Synced
  // in an effect (React forbids writing refs during render).
  const valueRef = useRef(value);
  const savedRef = useRef(savedValue);
  const savingRef = useRef(saving);
  const dirtyRef = useRef(dirty);
  const enabledRef = useRef(enabled);
  const saveImplRef = useRef(save);
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    valueRef.current = value;
    savedRef.current = savedValue;
    savingRef.current = saving;
    dirtyRef.current = dirty;
    enabledRef.current = enabled;
    saveImplRef.current = save;
    onSavedRef.current = onSaved;
  });

  const doSave = useCallback(() => {
    if (!enabledRef.current || savingRef.current) return;
    const v = valueRef.current;
    if (v === savedRef.current) return; // nothing to save
    setSaving(true);
    Promise.resolve(saveImplRef.current(v))
      .then(() => {
        setSavedValue(v);
        setError(null);
        // Fire the post-save pipeline without blocking the save (it may reload
        // the skill); a clean save means value === savedValue, so it's safe.
        onSavedRef.current?.();
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Save failed"))
      .finally(() => setSaving(false));
  }, []);

  // Publish state to the shared store (drives the top-bar Save button + guard).
  useEffect(() => {
    if (enabled) publishEditorStatus({ present: true, dirty, saving, error }, doSave);
    else clearEditorStatus();
  }, [enabled, dirty, saving, error, doSave]);
  useEffect(() => () => clearEditorStatus(), []);

  // ⌘S / Ctrl-S anywhere saves the current document.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        doSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSave]);

  // Warn before unloading the tab with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const status: SaveStatus = error ? "error" : saving ? "saving" : dirty ? "dirty" : "saved";
  return { status, dirty, saving, error, save: doSave };
}
