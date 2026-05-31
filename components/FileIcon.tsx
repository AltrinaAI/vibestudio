"use client";

// File-tree icons using VS Code's Material Icon Theme (self-hosted SVGs from the
// `vscode-material-icons` package, copied to /public/material-icons). These are
// the authentic, up-to-date language logos — python, js/ts badges, json, etc.

import { getIconForFilePath, getIconForDirectoryPath } from "vscode-material-icons";

const ICONS_URL = "/material-icons";

function Img({ icon, fallback, size = 16 }: { icon: string; fallback: string; size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${ICONS_URL}/${icon}.svg`}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className="shrink-0"
      onError={(e) => {
        const el = e.currentTarget;
        if (el.dataset.fb !== "1") {
          el.dataset.fb = "1";
          el.src = `${ICONS_URL}/${fallback}.svg`;
        }
      }}
    />
  );
}

/** Icon for a file in the tree. */
export function FileIcon({ name }: { name: string }) {
  return <Img icon={getIconForFilePath(name)} fallback="document" />;
}

/** Folder icon (open / closed) — Material ships an `-open` variant per folder. */
export function FolderIcon({ open, name }: { open: boolean; name: string }) {
  const base = getIconForDirectoryPath(name);
  return <Img icon={open ? `${base}-open` : base} fallback={open ? "folder-open" : "folder"} />;
}

/** Brand mark used in the chrome (top bar / home header). */
export function BrandIcon({ className }: { className?: string }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </svg>
  );
}
