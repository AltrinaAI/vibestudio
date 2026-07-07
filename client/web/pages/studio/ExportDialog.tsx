"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { btnGhost, btnPrimary, Spinner } from "@/components/ui";
import * as api from "@/lib/api";
import type { SecretEntry } from "@/lib/api";

/**
 * Export confirmation for a skill that declares required env vars. Lets the user
 * optionally bundle the matching secret *values* (a `.env` in the `.skill`) so the
 * recipient can run it immediately, and warns when declared vars won't travel —
 * so a shared skill isn't silently unusable on the other end.
 */
export default function ExportDialog({
  root,
  dirName,
  declared,
  onExported,
  onClose,
}: {
  root: string;
  dirName: string;
  declared: string[];
  /** Export succeeded; hands the saved path (null on the blob fallback) to the
   *  host, which swaps this dialog for the "Skill exported" confirmation. */
  onExported: (result: { dirName: string; path: string | null }) => void;
  onClose: () => void;
}) {
  const [stored, setStored] = useState<Set<string> | null>(null);
  const [includeEnv, setIncludeEnv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .secretsList()
      .then((ls: SecretEntry[]) => setStored(new Set(ls.map((s) => s.key))))
      .catch(() => setStored(new Set<string>()));
  }, []);
  const present = useMemo(() => (stored ? declared.filter((k) => stored.has(k)) : []), [stored, declared]);
  const missing = useMemo(() => (stored ? declared.filter((k) => !stored.has(k)) : []), [stored, declared]);

  // Nothing in the store to bundle → the toggle can't help.
  const canBundle = present.length > 0;
  const bundling = includeEnv && canBundle;

  const doExport = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { path } = await api.exportSkill(root, bundling ? present : []);
      onExported({ dirName, path });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Export skill"
      titleAside={<span className="truncate font-mono text-xs text-faint">{dirName}.skill</span>}
      onClose={onClose}
    >
        <div className="space-y-4 px-5 py-4">
          {stored === null ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Spinner className="h-3.5 w-3.5" /> Checking secrets…
            </p>
          ) : (
            <>
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Required environment variables</p>
                <ul className="flex flex-wrap gap-1.5">
                  {declared.map((k) => {
                    const have = present.includes(k);
                    return (
                      <li
                        key={k}
                        className={`flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[0.7rem] ${
                          have ? "border-ok/40 text-ok" : "border-warn/40 text-warn"
                        }`}
                        title={have ? "In your store" : "Not in your store"}
                      >
                        {k}
                        {have ? " ✓" : ""}
                      </li>
                    );
                  })}
                </ul>
              </div>

              <label
                className={`flex items-start gap-2 rounded-lg border border-border px-3 py-2.5 text-sm ${
                  canBundle ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={bundling}
                  disabled={!canBundle}
                  onChange={(e) => setIncludeEnv(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-fg">Include required secrets</span>
                  <span className="block text-[0.7rem] text-muted">
                    {canBundle
                      ? "Bundle the values so the recipient can run it immediately."
                      : "None of the required vars are in your store yet."}
                  </span>
                </span>
              </label>

              {/* Warning: anything declared that won't travel with the bundle. */}
              {bundling ? (
                <div className="space-y-2">
                  <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                    This .skill will contain the real values of{" "}
                    <span className="font-mono">{present.join(", ")}</span>. Only share it with people you’d hand these keys to.
                  </p>
                  {missing.length > 0 && (
                    <p className="rounded-lg border border-border bg-panel px-3 py-2 text-xs text-warn">
                      <span className="font-mono">{missing.join(", ")}</span> {missing.length === 1 ? "isn’t" : "aren’t"} in
                      your store, so {missing.length === 1 ? "it won’t" : "they won’t"} be bundled — recipients must set{" "}
                      {missing.length === 1 ? "it" : "them"}.
                    </p>
                  )}
                </div>
              ) : (
                declared.length > 0 && (
                  <p className="rounded-lg border border-border bg-panel px-3 py-2 text-xs text-warn">
                    Recipients will need to set <span className="font-mono">{declared.join(", ")}</span> themselves, or the
                    skill won’t run on their machine.
                  </p>
                )
              )}
            </>
          )}
        </div>

        {err && (
          <p className="mx-5 -mt-1 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {err}
          </p>
        )}

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} className={btnGhost}>
            Cancel
          </button>
          <button type="button" onClick={() => void doExport()} disabled={busy || stored === null} className={btnPrimary}>
            {busy ? "Exporting…" : "Export .skill"}
          </button>
        </div>
    </Modal>
  );
}
