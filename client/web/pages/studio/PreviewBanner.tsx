"use client";

import { useState } from "react";
import { useStudio } from "./StudioContext";

/**
 * Shown while VIEWING a past version: its content is checked out into the working
 * tree, so the whole editor renders it like the current version (markdown, files,
 * properties — all of it). Editing autosaves onto it; the sidebar's Save button
 * then lands those edits as a NEW version (linear history). "Return to current"
 * reattaches to the latest version and restores any work that was set aside.
 */
export default function PreviewBanner() {
  const { preview, exitVersion } = useStudio();
  const [leaving, setLeaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!preview) return null;

  const label = preview.number > 0 ? `Viewing Version ${preview.number}` : "Viewing a previous version";
  const onReturn = async () => {
    setLeaving(true);
    setErr(null);
    try {
      await exitVersion();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn’t return to current");
    } finally {
      setLeaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2.5 border-b border-accent/30 bg-accent-soft px-4 py-1.5 text-xs">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent" aria-hidden>
        <path d="M3 3v5h5" />
        <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
        <path d="M12 7v5l3 2" />
      </svg>
      <span className="font-semibold text-fg">{label}</span>
      <span className="hidden text-muted md:inline">— a saved version. Edit it to base a new version on it.</span>
      {err && <span className="text-danger">{err}</span>}
      <button
        type="button"
        onClick={onReturn}
        disabled={leaving}
        className="ml-auto shrink-0 rounded-md border border-accent/40 bg-app/40 px-2.5 py-1 font-medium text-accent transition-colors hover:bg-app disabled:opacity-50"
      >
        {leaving ? "Returning…" : "Return to current"}
      </button>
    </div>
  );
}
