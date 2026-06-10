"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { btnGhost, btnPrimary, Spinner } from "@/components/ui";
import * as api from "@/lib/api";
import type { AgentOption, MineSource } from "@/lib/api";
import { refreshMining } from "@/lib/mining";

const WINDOWS = [7, 14, 35, 90];

/**
 * Source sheet for a mining run: which transcript stores to read, how far back,
 * and which agent runs the mine. Doubles as the consent surface — the caption
 * states what happens to the transcripts, and Start is the consent. Defaults
 * are correct for most users, so the zero-ceremony path is one click.
 */
export default function MineDialog({ onClose, onStarted }: { onClose: () => void; onStarted: () => void }) {
  const [days, setDays] = useState(35);
  const [sources, setSources] = useState<MineSource[] | null>(null);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [agents, setAgents] = useState<AgentOption[] | null>(null);
  const [agent, setAgent] = useState("");
  const [improve, setImprove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-count whenever the window changes; default every non-empty source on.
  useEffect(() => {
    let stale = false;
    setSources(null);
    api
      .mineSources(days)
      .then((s) => {
        if (stale) return;
        setSources(s);
        setEnabled(new Set(s.filter((x) => x.sessions > 0).map((x) => x.id)));
      })
      .catch(() => !stale && setSources([]));
    return () => {
      stale = true;
    };
  }, [days]);

  // The mine runs inside an agent session — a plain shell can't do the judging.
  useEffect(() => {
    api
      .terminalAgents()
      .then((all) => {
        const usable = all.filter((a) => a.agent !== "shell");
        setAgents(usable);
        setAgent((cur) => cur || usable.find((a) => a.agent === "claude")?.id || usable[0]?.id || "");
      })
      .catch(() => setAgents([]));
  }, []);

  const totalSessions = useMemo(
    () => (sources ?? []).filter((s) => enabled.has(s.id)).reduce((n, s) => n + s.sessions, 0),
    [sources, enabled],
  );
  const canStart = !busy && agent !== "" && totalSessions > 0;

  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    setErr(null);
    try {
      await api.mineStart({ days, sources: [...enabled], agent, improve });
      await refreshMining();
      onStarted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn’t start mining");
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal title="Mine your sessions" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
        className="space-y-4 px-5 py-4"
      >
        <p className="text-xs leading-relaxed text-muted">
          Skill Studio studies your recent agent sessions for work you keep redoing. The run happens on this
          machine, in a terminal you can watch, using your own agent and keys — no new service sees your
          sessions.
        </p>

        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">Sources</label>
          {sources === null ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Spinner className="h-3.5 w-3.5" /> Counting sessions…
            </p>
          ) : sources.length === 0 ? (
            <p className="text-sm text-muted">No transcript stores found on this machine.</p>
          ) : (
            <ul className="space-y-1.5">
              {sources.map((s) => (
                <li key={s.id}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
                    <input
                      type="checkbox"
                      checked={enabled.has(s.id)}
                      onChange={() => toggle(s.id)}
                      disabled={s.sessions === 0}
                      className="accent-[var(--accent)]"
                    />
                    <span className={s.sessions === 0 ? "text-faint" : ""}>{s.label}</span>
                    <span className="ml-auto text-xs text-faint">
                      {s.sessions} session{s.sessions === 1 ? "" : "s"}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">Window</label>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent"
            >
              {WINDOWS.map((d) => (
                <option key={d} value={d}>
                  Last {d} days
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">Run with</label>
            {agents === null ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Spinner className="h-3.5 w-3.5" /> Detecting…
              </p>
            ) : agents.length === 0 ? (
              <p className="text-sm text-muted">No agent CLI found.</p>
            ) : (
              <select
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} ({a.flavorLabel})
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={improve}
            onChange={(e) => setImprove(e.target.checked)}
            className="mt-0.5 accent-[var(--accent)]"
          />
          <span>
            Also improve existing skills
            <span className="block text-[0.7rem] text-faint">
              Edits appear as ordinary uncommitted changes — review them before saving a version. Skills you’re
              already editing are left alone.
            </span>
          </span>
        </label>

        {err && <p className="text-xs text-danger">{err}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={btnGhost}>
            Cancel
          </button>
          <button type="submit" disabled={!canStart} className={btnPrimary}>
            {busy ? "Starting…" : "Start mining"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
