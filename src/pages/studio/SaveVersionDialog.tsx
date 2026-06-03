"use client";

import { useEffect, useRef, useState } from "react";
import * as api from "@/lib/api";

const btnPrimary =
  "rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-app transition-opacity hover:opacity-90 disabled:opacity-40";
const btnGhost =
  "rounded-md border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-panel disabled:opacity-40";

/**
 * "Save a version" — names the current state as a checkpoint (a git commit under
 * the hood). Autosave already keeps edits on disk; this records a version you can
 * diff against and roll back to. Driven by the host (the Versions sidebar panel),
 * which owns the git state and the actual commit.
 */
export default function SaveVersionDialog({
  root,
  dirName,
  tracked,
  hasIdentity,
  saving,
  error,
  onCommit,
  onClose,
}: {
  /** Skill root — used to draft a message from its diff on-device. */
  root: string;
  dirName: string;
  /** The skill is already a git repo (vs making its first-ever version). */
  tracked: boolean;
  /** A git user.email is configured. (Only meaningful when `tracked`.) */
  hasIdentity: boolean;
  saving: boolean;
  error: string | null;
  /** Persist the version; resolves true on success (the dialog then closes). */
  onCommit: (message: string) => Promise<boolean>;
  onClose: () => void;
}) {
  // The backend only reports identity for an existing repo; for an untracked skill
  // it's unknown, so don't block the FIRST version on it — let the commit run and
  // surface the backend's identity error if one's truly missing.
  const knownNoIdentity = tracked && !hasIdentity;
  const [message, setMessage] = useState(tracked ? `Update ${dirName}` : "Initial version");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // On-device "draft a message from the diff".
  const [generating, setGenerating] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<api.CommitModelStatus | null>(null);

  useEffect(() => {
    taRef.current?.select();
    // So we can warn about the one-time model download before the user clicks Generate.
    api.commitModelStatus().then(setModelStatus).catch(() => setModelStatus(null));
  }, []);

  const generate = async () => {
    if (generating || saving) return;
    setGenerating(true);
    setGenErr(null);
    try {
      const msg = await api.generateCommitMessage(root);
      setMessage(msg); // replace the default message with the AI draft
      setModelStatus((s) => (s ? { ...s, downloaded: true } : s));
    } catch (e) {
      // Tauri rejects with a plain string (the Rust Err), not an Error — surface it.
      setGenErr(e instanceof Error ? e.message : typeof e === "string" ? e : "Couldn’t generate a message");
    } finally {
      setGenerating(false);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !saving && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const canSubmit = !knownNoIdentity && !!message.trim() && !saving;
  const submit = async () => {
    if (!canSubmit) return;
    if (await onCommit(message.trim())) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <span className="text-sm font-semibold text-fg">Save a new version</span>
          <span className="truncate font-mono text-xs text-faint">{dirName}</span>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded-md p-1 text-faint hover:bg-panel hover:text-fg">
            ✕
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
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
          {genErr && <p className="text-xs text-danger">{genErr}</p>}
          {modelStatus && !modelStatus.downloaded && (
            <p className="text-[0.7rem] text-faint">
              First use downloads the local AI model (~1–1.5 GB), one time. Generation runs fully on your machine.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={saving || generating}
            title="Draft a message from your changes with on-device AI"
            className={btnGhost}
          >
            {generating ? "Generating…" : "✨ Generate"}
          </button>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} disabled={saving} className={btnGhost}>
              Cancel
            </button>
            <button type="button" onClick={() => void submit()} disabled={!canSubmit || generating} className={btnPrimary}>
              {saving ? "Saving…" : "Save version"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
