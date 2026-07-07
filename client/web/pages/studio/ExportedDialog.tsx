"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { btnGhost, btnPrimary } from "@/components/ui";
import * as api from "@/lib/api";

/**
 * Post-export confirmation. The desktop webview saves a `.skill` to Downloads
 * silently — wry suppresses the native download UI — so this dialog is the only
 * signal the export happened. `path` (the real saved path) is present on the
 * desktop save-to-disk route and enables "Reveal in folder"; it's null on the
 * browser blob-download fallback, where the browser shows its own download UI
 * and we can't know where the file went.
 */
export default function ExportedDialog({
  dirName,
  path,
  onClose,
}: {
  dirName: string;
  path: string | null;
  onClose: () => void;
}) {
  const fileName = (path && path.split(/[/\\]/).pop()) || `${dirName}.skill`;
  const [revealErr, setRevealErr] = useState<string | null>(null);

  const reveal = async () => {
    if (!path) return;
    setRevealErr(null);
    try {
      await api.revealPath(path);
    } catch (e) {
      setRevealErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal title="Skill exported" onClose={onClose} widthClass="max-w-sm">
      <div className="space-y-4 px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-ok">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </span>
          <p className="text-sm text-fg">
            Saved <span className="font-mono text-[0.8rem]">{fileName}</span> to your{" "}
            <span className="font-medium">Downloads</span> folder.
          </p>
        </div>

        {revealErr && <p className="text-xs text-danger">{revealErr}</p>}

        <div className="flex justify-end gap-2">
          {path && (
            <button type="button" onClick={() => void reveal()} className={btnGhost}>
              Reveal in folder
            </button>
          )}
          <button type="button" onClick={onClose} className={btnPrimary} autoFocus>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
