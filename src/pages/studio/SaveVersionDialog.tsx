"use client";

import { useEffect, useRef, useState } from "react";
import type { Checkpoint } from "./useCheckpoint";

const btnPrimary =
  "rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-app transition-opacity hover:opacity-90 disabled:opacity-40";
const btnGhost =
  "rounded-md border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-panel disabled:opacity-40";

/**
 * "Save a version" — names the current state as a checkpoint (a git commit under
 * the hood). Autosave already keeps edits on disk; this records a version you can
 * diff against and roll back to. Reused by the top-bar Save button.
 */
export default function SaveVersionDialog({
  checkpoint,
  dirName,
  onClose,
}: {
  checkpoint: Checkpoint;
  dirName: string;
  onClose: () => void;
}) {
  const { info, saving, error, commit } = checkpoint;
  const tracked = info?.isRepo ?? false;
  // The backend only reports `hasIdentity` for an existing repo; for an untracked
  // skill it's always false, so don't block the FIRST version on it — let the
  // commit run and surface the backend's identity error if one's truly missing.
  const knownNoIdentity = tracked && info?.hasIdentity === false;
  const [message, setMessage] = useState(tracked ? `Update ${dirName}` : "Initial version");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    taRef.current?.select();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !saving && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const canSubmit = !knownNoIdentity && !!message.trim() && !saving;
  const submit = async () => {
    if (!canSubmit) return;
    if (await commit(message.trim())) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <span className="text-sm font-semibold text-fg">Save a version</span>
          <span className="truncate font-mono text-xs text-faint">{dirName}</span>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded-md p-1 text-faint hover:bg-panel hover:text-fg">
            ✕
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <p className="text-xs text-muted">
            {tracked
              ? "Your edits are already saved. This records a named version you can compare against and return to later."
              : "Your edits are already on disk. Saving the first version starts tracking changes you can compare and roll back."}
          </p>
          <textarea
            ref={taRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
            autoFocus
            placeholder="Describe what changed…"
            className="w-full resize-none rounded-md border border-border bg-app px-2.5 py-2 text-sm text-fg outline-none focus:border-accent"
          />

          {knownNoIdentity && (
            <p className="rounded-md bg-panel px-2.5 py-2 text-xs text-warn">
              Set a git identity to save versions:{" "}
              <code className="font-mono">git config --global user.email "you@example.com"</code> (and{" "}
              <code className="font-mono">user.name</code>).
            </p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} disabled={saving} className={btnGhost}>
            Cancel
          </button>
          <button type="button" onClick={() => void submit()} disabled={!canSubmit} className={btnPrimary}>
            {saving ? "Saving…" : "Save version"}
          </button>
        </div>
      </div>
    </div>
  );
}
