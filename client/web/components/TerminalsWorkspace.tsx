"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import NavBar from "@/components/NavBar";
import NewTerminalDialog from "@/components/NewTerminalDialog";
import TerminalPane from "@/components/TerminalPane";
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
 * The Terminals workspace: a rail of live tmux-backed sessions plus the
 * active terminal. Sessions persist across UI disconnects and are reaped when
 * the backend process exits (see skill-term). Polls the list so externally
 * exited / watchdog-reaped sessions drop out.
 *
 * Two render modes, one implementation: the full /terminals page (NavBar,
 * `?id=` deep link), and `embedded` — chrome-less, fills its parent — for
 * hosts like the studio's Agent side panel. In tight horizontal layouts
 * (a phone, the panel at its default width) the sessions rail collapses
 * into a dropdown row above the terminal, measured on the workspace itself.
 */
export default function TerminalsWorkspace({
  visible,
  embedded = false,
  focusId,
  defaultCwd,
  onActiveChange,
}: {
  visible: boolean;
  /** Chrome-less variant for embedding: no NavBar/deep-link, compact rail
   *  with its own New button, h-full instead of h-screen. */
  embedded?: boolean;
  /** Select this session whenever it's set (e.g. the mining conversation). */
  focusId?: string | null;
  /** Initial working directory for the New-terminal dialog. */
  defaultCwd?: string;
  /** Reports the selected session — e.g. so an embedding host's "open full
   *  page" affordance can carry the selection along. */
  onActiveChange?: (id: string | null) => void;
}) {
  const [sessions, setSessions] = useState<TermSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  // Deep link: /terminals?id=<session> selects that terminal (e.g. "Continue
  // the conversation" from the mining card). Consumed once — the param is
  // dropped so later visits don't keep forcing the selection.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!visible || embedded) return;
    const want = new URLSearchParams(location.search).get("id");
    if (want) {
      setActiveId(want);
      navigate("/terminals", { replace: true });
    }
  }, [visible, embedded, location.search, navigate]);

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

  // Programmatic selection from the embedding host (e.g. the studio panel
  // focusing the mining conversation, possibly created a moment ago).
  useEffect(() => {
    if (!focusId) return;
    setActiveId(focusId);
    void refresh();
  }, [focusId, refresh]);

  useEffect(() => {
    onActiveChange?.(activeId);
  }, [activeId, onActiveChange]);

  const kill = async (id: string) => {
    try {
      await api.terminalKill(id);
    } catch {
      /* already gone */
    }
    await refresh();
  };

  // Tight horizontal layouts (a phone, or the studio's Agent panel at its
  // default width) trade the sessions rail for a dropdown row above the
  // terminal. Measured on the workspace itself, not the viewport, so the
  // embedded panel adapts as it's resized.
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(embedded);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth > 0 && el.clientWidth < 640));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const active = sessions.find((s) => s.id === activeId) ?? null;

  const pane = active ? (
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
  );

  return (
    <div ref={rootRef} className={`flex ${embedded ? "h-full" : "h-screen"} flex-col bg-app text-fg`}>
      {!embedded && (
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
      )}

      {narrow ? (
        // Tight layout: the rail becomes a dropdown row above the terminal.
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5 border-b border-border bg-surface py-1.5 pl-2 pr-1.5">
            <select
              value={activeId ?? ""}
              onChange={(e) => setActiveId(e.target.value)}
              disabled={sessions.length === 0}
              aria-label="Session"
              title={active?.cwd}
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-xs text-fg outline-none focus:border-accent disabled:opacity-50"
            >
              {sessions.length === 0 ? (
                <option value="">{loading ? "Loading…" : "No terminals yet"}</option>
              ) : (
                sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))
              )}
            </select>
            {active && (
              <button
                type="button"
                onClick={() => void kill(active.id)}
                aria-label={`Kill ${active.label}`}
                title="Kill session"
                className="shrink-0 rounded p-1 text-faint hover:text-danger"
              >
                ✕
              </button>
            )}
            <button
              type="button"
              onClick={() => setNewOpen(true)}
              title="New terminal"
              className="shrink-0 rounded p-1 text-muted hover:bg-panel hover:text-fg"
            >
              <PlusIcon />
            </button>
          </div>
          <main className="min-h-0 flex-1 bg-surface">{pane}</main>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside
            className={`flex ${embedded ? "w-44" : "w-60"} shrink-0 flex-col border-r border-border bg-surface`}
          >
            {embedded && (
              <div className="flex items-center justify-between border-b border-border py-1 pl-3 pr-1.5">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted">Sessions</span>
                <button
                  type="button"
                  onClick={() => setNewOpen(true)}
                  title="New terminal"
                  className="rounded p-1 text-muted hover:bg-panel hover:text-fg"
                >
                  <PlusIcon />
                </button>
              </div>
            )}
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

          <main className="min-w-0 flex-1 bg-surface">{pane}</main>
        </div>
      )}

      {newOpen && (
        <NewTerminalDialog
          defaultCwd={defaultCwd}
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
