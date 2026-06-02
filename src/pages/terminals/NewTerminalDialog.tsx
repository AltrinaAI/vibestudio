"use client";

import { useEffect, useMemo, useState } from "react";
import { Spinner } from "@/components/ui";
import FolderPicker from "@/components/FolderPicker";
import * as api from "@/lib/api";
import type { AgentOption } from "@/lib/api";

const btnPrimary =
  "rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-app transition-opacity hover:opacity-90 disabled:opacity-40";
const btnGhost =
  "rounded-md border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-panel disabled:opacity-40";

function optionLabel(a: AgentOption): string {
  if (a.agent === "shell") return "Shell (bash)";
  const ver = a.version ? ` ${a.version}` : "";
  return `${a.label} — ${a.flavorLabel}${ver}`;
}

/** Split an args string into argv, honoring single/double quotes so a value with
 *  spaces (e.g. --append-system-prompt "be brief") stays one argument. */
function tokenizeArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else {
        cur += ch;
        started = true;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === " " || ch === "\t") {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

/**
 * Start a new managed terminal: pick an agent (each detected flavor — PATH CLI
 * and editor-extension build — is its own option), a working directory, and
 * optional flags, then create a detached tmux-backed session.
 */
export default function NewTerminalDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (s: api.TermSession) => void;
}) {
  const [agents, setAgents] = useState<AgentOption[] | null>(null);
  const [agentId, setAgentId] = useState("");
  const [cwd, setCwd] = useState("");
  const [ide, setIde] = useState(false);
  const [skip, setSkip] = useState(false);
  const [auto, setAuto] = useState(false);
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    api
      .terminalAgents()
      .then((a) => {
        setAgents(a);
        // Default to the first real agent (not the plain shell), else the shell.
        setAgentId((a.find((x) => x.agent !== "shell") ?? a[0])?.id ?? "");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't list agents."));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selected = useMemo(() => agents?.find((a) => a.id === agentId), [agents, agentId]);

  const chooseCwd = async () => {
    if (api.isTauri) {
      const p = await api.pickSkillFolder();
      if (p) setCwd(p);
    } else {
      setPickerOpen(true);
    }
  };

  const create = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.terminalCreate({
        agent: selected.id,
        cwd: cwd.trim(),
        cols: 80,
        rows: 24,
        ide: ide && selected.supportsIde,
        skipPermissions: skip && !auto && selected.agent === "claude",
        autoMode: auto && selected.agent === "claude",
        extraArgs: tokenizeArgs(extra),
      });
      onCreated(s);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Couldn't start the terminal.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <span className="text-sm font-semibold text-fg">New terminal</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-md p-1 text-faint hover:bg-panel hover:text-fg"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* Agent */}
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">Agent</label>
            {agents === null ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Spinner className="h-3.5 w-3.5" /> Detecting…
              </p>
            ) : (
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                disabled={busy}
                className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent disabled:opacity-50"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {optionLabel(a)}
                  </option>
                ))}
              </select>
            )}
            {selected && selected.agent !== "shell" && (
              <p className="mt-1 truncate font-mono text-[0.7rem] text-faint" title={selected.bin}>
                {selected.bin}
              </p>
            )}
          </div>

          {/* Working directory */}
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">
              Working directory
            </label>
            <div className="flex gap-2">
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="~ (home)"
                spellCheck={false}
                disabled={busy}
                className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent disabled:opacity-50"
              />
              <button type="button" onClick={chooseCwd} disabled={busy} className={`${btnGhost} shrink-0`}>
                Browse…
              </button>
            </div>
          </div>

          {/* Per-agent options */}
          {selected?.supportsIde && (
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={ide} onChange={(e) => setIde(e.target.checked)} className="accent-accent" />
              Connect to the running editor (<code className="font-mono text-[0.85em]">--ide</code>)
            </label>
          )}
          {selected?.agent === "claude" && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={auto}
                  onChange={(e) => {
                    setAuto(e.target.checked);
                    if (e.target.checked) setSkip(false);
                  }}
                  className="accent-accent"
                />
                Auto mode (<code className="font-mono text-[0.85em]">--permission-mode auto</code>)
                <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide text-accent">
                  preview
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={skip}
                  onChange={(e) => {
                    setSkip(e.target.checked);
                    if (e.target.checked) setAuto(false);
                  }}
                  className="accent-accent"
                />
                Skip permission prompts
                <span className="rounded-full bg-warn/15 px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide text-warn">
                  risky
                </span>
              </label>
            </div>
          )}

          {selected && selected.agent !== "shell" && (
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">
                Extra arguments <span className="font-normal normal-case text-faint">(optional)</span>
              </label>
              <input
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                placeholder="--model …"
                spellCheck={false}
                disabled={busy}
                className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent disabled:opacity-50"
              />
            </div>
          )}

          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={busy} className={btnGhost}>
              Cancel
            </button>
            <button type="button" onClick={() => void create()} disabled={busy || !selected} className={btnPrimary}>
              {busy ? "Starting…" : "Start terminal"}
            </button>
          </div>
        </div>
      </div>

      {pickerOpen && (
        <FolderPicker
          onSelect={(p) => {
            setPickerOpen(false);
            setCwd(p);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
