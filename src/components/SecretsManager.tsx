"use client";

import { useCallback, useEffect, useState } from "react";
import { Spinner } from "@/components/ui";
import { agentColor } from "@/lib/agents";
import * as api from "@/lib/api";
import type { SecretEntry, SecretsStatus } from "@/lib/api";

const btnPrimary =
  "rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-app transition-opacity hover:opacity-90 disabled:opacity-40";
const btnGhost =
  "rounded-md border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-panel disabled:opacity-40";

const mask = (v: string) => "•".repeat(Math.min(12, Math.max(4, v.length)));

/** Global secret store UI. The env vars a skill references are auto-detected and
 *  folded into its `metadata.required-env` automatically — on save (the post-save
 *  pipeline) and on open — so there's nothing to scan from here. Detection is
 *  store-dependent, so adding a secret here refreshes a skill's required-env on
 *  its next save or reopen, not instantly. */
export default function SecretsManager() {
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [secrets, setSecrets] = useState<SecretEntry[] | null>(null);
  const [reveal, setReveal] = useState<Set<string>>(new Set());
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [st, ls] = await Promise.all([
      api.secretsStatus().catch(() => null),
      api.secretsList().catch(() => [] as SecretEntry[]),
    ]);
    setStatus(st);
    setSecrets(ls);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async (key: string, value: string) => {
    if (!key.trim()) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await api.secretSet(key.trim(), value);
      setNewKey("");
      setNewValue("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn’t save secret");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (key: string) => {
    if (!window.confirm(`Delete ${key}? Skills using it will lose access.`)) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await api.secretDelete(key);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn’t delete secret");
    } finally {
      setBusy(false);
    }
  };

  const runSetup = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const r = await api.secretsSetup();
      setNote(
        r.installedAgents.length
          ? `Activation skill installed for ${r.installedAgents.join(", ")}.`
          : "Set up — no agents detected yet to install the activation skill into.",
      );
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  };

  if (secrets === null || status === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Spinner className="h-3.5 w-3.5" /> Loading secrets…
      </p>
    );
  }

  const installedAny = status.agents.some((a) => a.hasSkill);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Store API keys and tokens once. A skill loads them at runtime via the{" "}
        <span className="font-mono text-[0.9em] text-fg">skill-studio</span> activation skill — never pasted into prompts
        or agent configs.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add(newKey, newValue);
        }}
        className="flex gap-2"
      >
        <input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value.toUpperCase())}
          placeholder="OPENAI_API_KEY"
          spellCheck={false}
          className="w-2/5 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
        />
        <input
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder="value"
          type="password"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
        />
        <button type="submit" disabled={busy || !newKey.trim()} className={btnPrimary}>
          Save
        </button>
      </form>

      {secrets.length > 0 ? (
        <ul className="space-y-0 overflow-hidden rounded-lg border border-border">
          {secrets.map((s) => {
            const shown = reveal.has(s.key);
            return (
              <li key={s.key} className="flex items-center gap-2 border-t border-border px-2.5 py-1.5 text-sm first:border-t-0">
                <code className="shrink-0 font-mono text-fg">{s.key}</code>
                <span className="ml-auto min-w-0 truncate font-mono text-xs text-faint">{shown ? s.value : mask(s.value)}</span>
                <button
                  type="button"
                  onClick={() =>
                    setReveal((r) => {
                      const n = new Set(r);
                      if (n.has(s.key)) n.delete(s.key);
                      else n.add(s.key);
                      return n;
                    })
                  }
                  className="shrink-0 text-xs text-faint hover:text-fg"
                >
                  {shown ? "Hide" : "Show"}
                </button>
                <button
                  type="button"
                  onClick={() => void remove(s.key)}
                  disabled={busy}
                  aria-label={`Delete ${s.key}`}
                  className="shrink-0 text-faint hover:text-danger"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-faint">No secrets stored yet.</p>
      )}

      <div className="space-y-2 rounded-lg border border-border bg-panel px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-fg">Activation skill</span>
          <button type="button" onClick={() => void runSetup()} disabled={busy} className={btnGhost}>
            {busy ? "…" : installedAny ? "Reinstall" : "Set up"}
          </button>
        </div>
        <p className="text-[0.7rem] text-muted">
          Installs the <span className="font-mono">skill-studio</span> skill into the shared{" "}
          <span className="font-mono">~/.agents/skills</span> dir (and Claude Code’s own) so your agents can load these
          vars. Run again after installing a new agent.
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {status.agents.filter((a) => a.installed).length === 0 ? (
            <li className="text-[0.7rem] text-faint">No agents detected on this machine.</li>
          ) : (
            status.agents
              .filter((a) => a.installed)
              .map((a) => (
                <li
                  key={a.agent}
                  className={`flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[0.7rem] ${
                    a.hasSkill ? "text-ok" : "text-faint"
                  }`}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: agentColor(a.agent) }} aria-hidden />
                  {a.agent}
                  {a.hasSkill ? " ✓" : ""}
                </li>
              ))
          )}
        </ul>
      </div>

      {note && <p className="text-xs text-ok">{note}</p>}
      {err && <p className="text-xs text-danger">{err}</p>}
    </div>
  );
}
