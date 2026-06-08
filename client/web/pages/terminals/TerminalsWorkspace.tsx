"use client";

import { useCallback, useEffect, useState } from "react";
import NavBar from "@/components/NavBar";
import NewTerminalDialog from "./NewTerminalDialog";
import TerminalPane from "./TerminalPane";
import * as api from "@/lib/api";
import type { TermSession } from "@/lib/api";

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/**
 * The global Terminals workspace: a rail of live tmux-backed sessions plus the
 * active terminal. Sessions persist across UI disconnects and are reaped when
 * the backend process exits (see skill-term). Polls the list so externally
 * exited / watchdog-reaped sessions drop out.
 */
export default function TerminalsWorkspace({ visible }: { visible: boolean }) {
  const [sessions, setSessions] = useState<TermSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const list = await api.terminalList();
      setSessions(list);
      setActiveId((cur) => (cur && list.some((s) => s.id === cur) ? cur : list[0]?.id ?? null));
    } catch {
      /* transient */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const kill = async (id: string) => {
    try {
      await api.terminalKill(id);
    } catch {
      /* already gone */
    }
    await refresh();
  };

  const active = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <div className="flex h-screen flex-col bg-app text-fg">
      <NavBar
        breadcrumb={
          <>
            <span className="text-faint" aria-hidden>
              /
            </span>
            <span className="font-medium text-fg">Terminals</span>
          </>
        }
      >
        <button
          type="button"
          onClick={() => setNewOpen(true)}
          title="New terminal"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted hover:bg-panel hover:text-fg"
        >
          <PlusIcon />
          <span className="hidden text-xs sm:inline">New terminal</span>
        </button>
      </NavBar>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {loading ? (
              <p className="px-2 py-3 text-sm text-muted">Loading…</p>
            ) : sessions.length === 0 ? (
              <p className="px-2 py-3 text-xs leading-relaxed text-muted">
                No terminals yet. Start one to run Claude Code, Codex, or a shell on this machine.
              </p>
            ) : (
              <ul className="space-y-1">
                {sessions.map((s) => (
                  <li key={s.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setActiveId(s.id)}
                      className={`flex min-w-0 flex-1 flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors ${
                        s.id === activeId ? "bg-panel text-fg" : "text-muted hover:bg-panel hover:text-fg"
                      }`}
                    >
                      <span className="w-full truncate text-sm">{s.label}</span>
                      <span className="w-full truncate font-mono text-[0.65rem] text-faint" title={s.cwd}>
                        {s.cwd}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void kill(s.id)}
                      aria-label={`Kill ${s.label}`}
                      title="Kill session"
                      className="shrink-0 rounded p-1 text-faint opacity-0 hover:text-danger group-hover:opacity-100"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1 bg-surface">
          {active ? (
            <TerminalPane key={active.id} id={active.id} visible={visible} />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <div>
                <p className="text-sm text-muted">No terminal selected.</p>
                <button
                  type="button"
                  onClick={() => setNewOpen(true)}
                  className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90"
                >
                  ＋ New terminal
                </button>
              </div>
            </div>
          )}
        </main>
      </div>

      {newOpen && (
        <NewTerminalDialog
          onClose={() => setNewOpen(false)}
          onCreated={(s) => {
            setNewOpen(false);
            setSessions((prev) => (prev.some((p) => p.id === s.id) ? prev : [s, ...prev]));
            setActiveId(s.id);
          }}
        />
      )}
    </div>
  );
}
