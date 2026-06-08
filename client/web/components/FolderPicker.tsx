"use client";

import { useEffect, useState } from "react";
import { listDir, type DirListing } from "@/lib/api";
import { FolderIcon } from "./FileIcon";
import { Spinner } from "./ui";

// Browser-mode folder picker: navigates the backend filesystem via /api/list-dir
// (the native OS dialog isn't available outside the Tauri shell).
export default function FolderPicker({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");

  const load = (path: string) => {
    setLoading(true);
    setError(null);
    listDir(path)
      .then((l) => {
        setListing(l);
        setPathInput(l.path);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to list directory"))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load("");
  }, []);

  const join = (name: string) => {
    if (!listing) return name;
    return listing.path.endsWith("/") ? `${listing.path}${name}` : `${listing.path}/${name}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="text-sm font-semibold text-fg">Open a skill folder</span>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto text-faint hover:text-fg">
            ✕
          </button>
        </div>

        <form
          className="flex gap-2 border-b border-border px-4 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            load(pathInput.trim());
          }}
        >
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            spellCheck={false}
            aria-label="Folder path"
            className="w-full rounded-md border border-border bg-app px-2 py-1 font-mono text-xs text-fg outline-none focus:border-accent"
          />
          <button type="submit" className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-panel">
            Go
          </button>
        </form>

        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted">
              <Spinner className="h-3.5 w-3.5" /> Loading…
            </div>
          ) : error ? (
            <p className="px-2 py-3 text-sm text-danger">{error}</p>
          ) : listing ? (
            <ul className="text-sm">
              {listing.parent && (
                <li>
                  <button
                    type="button"
                    onClick={() => load(listing.parent!)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted hover:bg-panel"
                  >
                    <span className="w-4 text-center" aria-hidden>
                      ↑
                    </span>
                    ..
                  </button>
                </li>
              )}
              {listing.entries.map((e) => (
                <li key={e.name} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => load(join(e.name))}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-panel"
                  >
                    <FolderIcon open={false} name={e.name} />
                    <span className="truncate text-fg">{e.name}</span>
                    {e.isSkill && (
                      <span className="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-[0.65rem] font-medium text-accent">
                        skill
                      </span>
                    )}
                  </button>
                  {e.isSkill && (
                    <button
                      type="button"
                      onClick={() => onSelect(join(e.name))}
                      className="shrink-0 rounded-md px-2 py-1 text-xs text-accent hover:bg-panel"
                    >
                      Open
                    </button>
                  )}
                </li>
              ))}
              {listing.entries.length === 0 && <li className="px-2 py-3 text-sm text-muted">No subfolders.</li>}
            </ul>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <span className="truncate font-mono text-xs text-faint">{listing?.path}</span>
          <button
            type="button"
            onClick={() => listing && onSelect(listing.path)}
            disabled={!listing}
            className="ml-auto shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-40"
          >
            Open this folder
          </button>
        </div>
      </div>
    </div>
  );
}
