"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import NavBar from "@/components/NavBar";
import NewTerminalDialog from "@/components/NewTerminalDialog";
import ResizeHandle from "@/components/ResizeHandle";
import TerminalPane from "@/components/TerminalPane";
import * as api from "@/lib/api";
import type { TermSession } from "@/lib/api";

const RAIL_KEY = "skillviewer-terminals-rail";
/** Per-session "last viewed" activity marks (id → unix secs) for the unread dot. */
const SEEN_KEY = "skillviewer-terminals-seen";

function readRailW(): number {
  try {
    const v = Number(localStorage.getItem(RAIL_KEY));
    return Number.isFinite(v) && v > 0 ? v : 240;
  } catch {
    return 240;
  }
}

function readSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Wall-clock seconds, to compare against tmux activity timestamps. */
const nowSecs = () => Math.floor(Date.now() / 1000);

/**
 * Stable, chronological order (oldest first) so the rail never reshuffles.
 * tmux lists sessions alphabetically by name, and our names lead with the
 * creating backend's pid — so a backend restart (app relaunch, version upgrade,
 * remote reconnect) would otherwise reorder the whole list under you. Sorting by
 * creation time keeps every existing row put and appends new terminals at the
 * end; the id is a deterministic tiebreak when two share a second.
 */
function sortSessions(list: TermSession[]): TermSession[] {
  return [...list].sort(
    (a, b) =>
      (Number(a.created) || 0) - (Number(b.created) || 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

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
   *  with its own New button, h-full instead of h-dvh. */
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

  const location = useLocation();
  const navigate = useNavigate();

  // Unread dot. Keyed off the agent's turn-completion BELL (the server stamps it
  // into `bellAt`), NOT raw output: an idle agent TUI (e.g. Codex) keeps
  // repainting its pane, which bumped the old `window_activity` signal and left a
  // phantom dot with nothing new to see. "Unread" = a bell rang since you last
  // *viewed* the session — we stamp it seen = now the instant you switch away from
  // it (below), so a turn you already watched, and the repaint your own attach
  // causes, never light it.
  const [seen, setSeen] = useState<Record<string, number>>(readSeen);
  const markSeen = useCallback((id: string | null) => {
    if (id) setSeen((prev) => ({ ...prev, [id]: nowSecs() }));
  }, []);
  const unread = useCallback(
    (s: TermSession) => {
      if (s.id === activeId) return false; // the one you're watching is never "new"
      const bell = Number(s.bellAt) || 0;
      // Unseen sessions fall back to their own bell time (i.e. start seen), so a
      // reconnect doesn't light up every terminal that belled while you were away —
      // they only dot on a bell that arrives *after* we first list them.
      return bell > (seen[s.id] ?? bell);
    },
    [activeId, seen],
  );

  // Freeze the terminal you're leaving at "now" — synchronously, before paint, so
  // switching away never flashes a dot on the pane you were just watching (its
  // attach repaint bumped `activity` above the last poll's snapshot). A plain
  // effect would let one painted frame through with the stale mark.
  const prevActiveRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const prev = prevActiveRef.current;
    if (prev && prev !== activeId) markSeen(prev);
    prevActiveRef.current = activeId;
  }, [activeId, markSeen]);

  useEffect(() => {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch {
      /* ignore */
    }
  }, [seen]);

  const refresh = useCallback(async () => {
    try {
      const list = sortSessions(await api.terminalList());
      setSessions(list);
      setActiveId((cur) => (cur && list.some((s) => s.id === cur) ? cur : list[0]?.id ?? null));
    } catch {
      /* transient */
    } finally {
      setLoading(false);
    }
  }, []);

  // Seed a "seen" mark for each newly-listed session (start it seen = its own
  // bell time, so a reconnect doesn't light up every terminal that belled while
  // you were away) and drop marks for sessions that are gone. Sessions you've
  // actually viewed keep the stamp markSeen gave them; this only fills gaps and prunes.
  useEffect(() => {
    if (sessions.length === 0) return;
    setSeen((prev) => {
      const next: Record<string, number> = {};
      let changed = Object.keys(prev).length !== sessions.length;
      for (const s of sessions) {
        if (prev[s.id] == null) changed = true;
        next[s.id] = prev[s.id] ?? (Number(s.bellAt) || 0);
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // Deep link: /terminals?id=<session> selects that terminal (e.g. "Continue
  // the conversation" from the mining card — possibly created a moment ago,
  // hence the refresh). Consumed once — the param is dropped so later visits
  // don't keep forcing the selection.
  useEffect(() => {
    if (!visible || embedded) return;
    const want = new URLSearchParams(location.search).get("id");
    if (want) {
      setActiveId(want);
      void refresh();
      navigate("/terminals", { replace: true });
    }
  }, [visible, embedded, location.search, navigate, refresh]);

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

  // Draggable sessions rail on the full page (the embedded panel is sized by its
  // host, AgentPanel). Width persists across visits; the ResizeHandle is the
  // divider, so the rail drops its own border. Clamped to keep the terminal usable.
  const railRef = useRef<HTMLElement>(null);
  const [railW, setRailW] = useState(readRailW);
  const dragRail = useCallback((clientX: number) => {
    const left = railRef.current?.getBoundingClientRect().left;
    if (left == null) return;
    const w = Math.round(Math.max(180, Math.min(520, clientX - left)));
    setRailW(w);
    try {
      localStorage.setItem(RAIL_KEY, String(w));
    } catch {
      /* ignore */
    }
  }, []);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  // Collapsed (narrow) layout hides the rail, so surface a single dot when any
  // hidden session has new output.
  const anyUnread = sessions.some(unread);

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
    <div ref={rootRef} className={`flex ${embedded ? "h-full" : "h-dvh"} flex-col bg-app text-fg`}>
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
            {anyUnread && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-info"
                title="New output in a background terminal"
                aria-label="New output in a background terminal"
              />
            )}
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
                    {unread(s) ? "● " : ""}
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
            ref={railRef}
            style={embedded ? undefined : { width: railW }}
            className={`flex shrink-0 flex-col bg-surface ${embedded ? "w-44 border-r border-border" : ""}`}
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
                  No terminals yet. Start one to run Claude Code, Codex, opencode, or a shell on this machine.
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
                        <span className="flex w-full items-center gap-1.5">
                          {/* Reserved slot so the label never shifts as the dot toggles. */}
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${unread(s) ? "bg-info" : "bg-transparent"}`}
                            title={unread(s) ? "New output" : undefined}
                            aria-label={unread(s) ? "New output" : undefined}
                          />
                          <span className="min-w-0 flex-1 truncate text-sm">{s.label}</span>
                        </span>
                        <span className="w-full truncate pl-3 font-mono text-[0.65rem] text-faint" title={s.cwd}>
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

          {!embedded && <ResizeHandle axis="col" onDragTo={dragRail} />}

          <main className="min-w-0 flex-1 bg-surface">{pane}</main>
        </div>
      )}

      {newOpen && (
        <NewTerminalDialog
          defaultCwd={defaultCwd}
          onClose={() => setNewOpen(false)}
          onCreated={(s) => {
            setNewOpen(false);
            setSessions((prev) => (prev.some((p) => p.id === s.id) ? prev : sortSessions([...prev, s])));
            setActiveId(s.id);
          }}
        />
      )}
    </div>
  );
}
