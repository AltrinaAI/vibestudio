// Shared terminal-session store + the agent turn-finish notifier. A module-level
// store (same external-store idiom as lib/remote.ts / lib/updates.ts) because
// notifications must outlive any mounted workspace: TerminalsHost only mounts on
// the first Terminals visit, but an agent finishing while the window sits in the
// tray — or before any visit — must still toast. This module owns:
//   * the session list, and the per-session "last viewed" marks (localStorage)
//     the unread dot compares `bellAt` against — moved out of TerminalsWorkspace
//     so the NavBar dot and the notifier share them;
//   * the `/api/events` subscription (instant bell/opened/closed refresh; the
//     workspace's 5s poll stays as the backstop for servers without it);
//   * the notifier: when a session's unread state transitions false→true while
//     the window is unfocused or hidden, toast — natively via POST /api/notify
//     (the desktop shell), else the Web Notification API (browser mode). Title =
//     the session label; the body is a fixed phrase. A notification summons, it
//     doesn't summarize — the terminal itself is one tap away.
import { useSyncExternalStore } from "react";
import * as api from "@/lib/api";
import type { TermEvent, TermSession } from "@/lib/api";
import { log } from "@/lib/log";
import { terminalsPath } from "@/lib/routes";

/** Per-session "last viewed" marks (id → unix secs) for the unread dot. */
const SEEN_KEY = "skillviewer-terminals-seen";

/** Wall-clock seconds, to compare against tmux bell timestamps. */
const nowSecs = () => Math.floor(Date.now() / 1000);

const bellOf = (s: TermSession) => Number(s.bellAt) || 0;

function readSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function persistSeen() {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* ignore */
  }
}

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

/** The rail's unread predicate: a bell rang after this session was last viewed.
 *  Keyed off the turn-completion BELL, NOT raw output — an idle agent TUI keeps
 *  repainting its pane, so `activity` would leave a phantom dot with nothing new
 *  to see. Sessions never listed before start "seen" at their own bell time, so
 *  a reconnect doesn't light up every terminal that belled while you were away. */
export function isUnread(
  s: TermSession,
  seenMap: Record<string, number>,
  activeId: string | null,
): boolean {
  if (s.id === activeId) return false; // the one you're watching is never "new"
  return bellOf(s) > (seenMap[s.id] ?? bellOf(s));
}

// ─── store state ───

let sessions: TermSession[] = [];
let loading = true;
let seen: Record<string, number> = readSeen();
/** The session a VISIBLE workspace is currently showing (null = none visible). */
let watchedId: string | null = null;
const listeners = new Set<() => void>();

export interface TerminalsSnap {
  sessions: TermSession[];
  loading: boolean;
  seen: Record<string, number>;
  /** Sessions with a bell newer than their seen mark, excluding the watched one
   *  — the NavBar aggregate dot / dock badge count. */
  unreadCount: number;
}

let snap: TerminalsSnap = { sessions, loading, seen, unreadCount: 0 };

function rebuild() {
  const unreadCount = sessions.filter((s) => isUnread(s, seen, watchedId)).length;
  snap = { sessions, loading, seen, unreadCount };
  syncBadge();
  for (const l of listeners) l();
}

export function useTerminals(): TerminalsSnap {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snap,
    () => snap,
  );
}

/** Freeze a session at "viewed now" (switching away from it, killing it). */
export function markSeen(id: string | null): void {
  if (!id) return;
  seen = { ...seen, [id]: nowSecs() };
  persistSeen();
  rebuild();
}

/** Report the session a VISIBLE workspace is showing. The watched session never
 *  counts unread, and its seen mark is stamped at every moment attention is
 *  KNOWN — watch start, watch end, window blur, and each fetch that lands while
 *  focused — so a turn the user watched land (or just read) can never re-dot,
 *  re-badge, or toast after they move on. */
export function setWatched(id: string | null): void {
  if (id === watchedId) return;
  watchedId = id;
  if (id && !document.hidden && document.hasFocus()) {
    markSeen(id); // it's on screen right now — caught up by definition
  } else {
    rebuild();
  }
}

/** Release the watch IF this instance holds it — an unmounting/hidden workspace
 *  must not clobber a watch another (visible) workspace just reported. */
export function releaseWatched(id: string | null): void {
  if (id && id === watchedId) {
    watchedId = null;
    markSeen(id); // the user was looking at it until this instant
  }
}

/** Optimistic insert for a just-created session (the rail selects it at once;
 *  the next refresh reconciles). */
export function noteCreated(s: TermSession): void {
  if (sessions.some((p) => p.id === s.id)) return;
  sessions = sortSessions([...sessions, s]);
  if (seen[s.id] == null) {
    seen = { ...seen, [s.id]: bellOf(s) };
    persistSeen();
  }
  rebuild();
}

// One refresh in flight, one queued: an event burst mid-fetch still lands one
// trailing fetch, without stacking requests.
let inflight: Promise<void> | null = null;
let queued = false;

export function refresh(): Promise<void> {
  if (inflight) {
    queued = true;
    return inflight;
  }
  inflight = (async () => {
    try {
      setSessions(sortSessions(await api.terminalList()));
    } catch {
      /* transient — the poll or the next event retries */
    } finally {
      loading = false;
      inflight = null;
      if (queued) {
        queued = false;
        void refresh();
      } else {
        rebuild();
      }
    }
  })();
  return inflight;
}

function setSessions(list: TermSession[]) {
  // Poll-path notification backstop: detect bell transitions here too (a server
  // without /api/events still toasts, ≤5s late). The dedup set in maybeNotify
  // absorbs the overlap when the SSE path already announced the same bell.
  const prevById = new Map(sessions.map((s) => [s.id, s]));
  for (const s of list) {
    const p = prevById.get(s.id);
    if (p && bellOf(s) > bellOf(p)) {
      maybeNotify({ id: s.id, label: s.label, agent: s.agent, cwd: s.cwd, at: s.bellAt });
    }
  }

  sessions = list;

  // Seed a seen mark for each newly-listed session (start it at its own bell)
  // and prune marks for sessions that are gone. Viewed sessions keep the stamps
  // markSeen gave them. An empty list is left alone — a transient tmux hiccup
  // must not wipe every mark.
  if (list.length > 0) {
    const next: Record<string, number> = {};
    let changed = Object.keys(seen).length !== list.length;
    for (const s of list) {
      if (seen[s.id] == null) changed = true;
      next[s.id] = seen[s.id] ?? bellOf(s);
    }
    if (changed) {
      seen = next;
      persistSeen();
    }
  }

  // Watching a focused, visible terminal keeps it read: a turn you watched land
  // must not dot the rail or count in the badge after you switch away.
  if (watchedId && !document.hidden && document.hasFocus()) {
    const w = list.find((s) => s.id === watchedId);
    if (w && bellOf(w) > (seen[w.id] ?? 0)) {
      seen = { ...seen, [w.id]: nowSecs() };
      persistSeen();
    }
  }
}

// ─── the notifier ───

/** Bells already decided on (`id:bellAt`), so the SSE path and the poll backstop
 *  can't double-toast the same turn. */
const notified = new Set<string>();

/** The newest bell actually toasted per session — the "one banner per session
 *  until seen" ledger. Deliberately NOT derived from `sessions` (which lags a
 *  refresh behind and can miss one on a transport blip). */
const announced = new Map<string, number>();

/** Native-surface capability: null = not probed yet, false = 404 (no shell on
 *  this origin — browser mode), true = the desktop shell answers /api/notify. */
let nativeNotify: boolean | null = null;

function maybeNotify(e: TermEvent): void {
  const key = `${e.id}:${e.at}`;
  if (notified.has(key)) return;
  notified.add(key);
  const bell = Number(e.at) || 0;
  const seenAt = seen[e.id];
  // Unknown session (never listed) or already viewed past this bell → no toast;
  // the seen-seeding rule keeps reconnects/restarts silent by construction.
  if (seenAt == null || bell <= seenAt) return;
  // One banner per session until it's seen: a toast for an earlier still-unread
  // bell already summoned the user for this session.
  if ((announced.get(e.id) ?? 0) > seenAt) return;
  // You're looking at the app — the rail dot is enough. Banners are for the
  // hidden/unfocused window (and, in browser mode, the backgrounded tab).
  if (!document.hidden && document.hasFocus()) return;
  announced.set(e.id, bell);
  void deliver(e.label || e.id, "Your turn", e.id);
}

async function deliver(title: string, body: string, tag: string): Promise<void> {
  if (nativeNotify !== false) {
    try {
      await api.notifyNative(title, body);
      nativeNotify = true;
      return;
    } catch (err) {
      if ((err as { status?: number } | undefined)?.status === 404) {
        nativeNotify = false; // no shell on this origin — web fallback below
      } else {
        // The shell exists but the OS refused (permission denied, no DBus
        // daemon, unsigned dev build): quiet failure, the dot still shows.
        log.warn("notify", "native notification failed", err instanceof Error ? err.message : String(err));
        return;
      }
    }
  }
  webNotify(title, body, tag);
}

function webNotify(title: string, body: string, tag: string): void {
  // Feature-detect: WKWebView has no Notification API at all, and iOS Safari
  // tabs don't either — those quietly keep the dot only.
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      window.location.hash = `#${terminalsPath(tag)}`;
      n.close();
    };
  } catch {
    /* some embedders throw on construction — quiet */
  }
}

// Dock/taskbar badge follows the unread count (desktop shell only).
let lastBadge = -1;
function syncBadge(): void {
  if (nativeNotify !== true) return;
  const n = snap.unreadCount;
  if (n === lastBadge) return;
  lastBadge = n;
  api.notifyBadge(n).catch(() => {
    lastBadge = -1; // retry on the next change
  });
}

async function probeNative(): Promise<void> {
  try {
    nativeNotify = (await api.notifyStatus()).native;
    syncBadge();
  } catch (e) {
    // 404 = no native surface, for good. A transport error leaves it unknown;
    // the first deliver() re-probes by just trying.
    if ((e as { status?: number } | undefined)?.status === 404) nativeNotify = false;
  }
}

/** Ask for notification permission at a user-legible moment — call this from
 *  the gesture that creates a terminal, so the OS prompt has an obvious "why".
 *  Browser mode needs the actual user gesture, so call it synchronously from
 *  the click handler, not after an await. */
export function primeNotifications(): void {
  if (nativeNotify !== false) {
    api.notifyPrime().catch(() => {});
  }
  if (nativeNotify === false && typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

// ─── the /api/events subscription ───

let esHandle: { close(): void } | null = null;

function connectEvents(): void {
  esHandle?.close();
  esHandle = api.terminalEvents(
    (kind, e) => {
      if (kind === "bell") maybeNotify(e);
      void refresh();
    },
    () => {
      // Fatal close: an older server without /api/events, or a topology change
      // mid-stream. Retry slowly forever — one cheap request per interval, and a
      // remote connect/disconnect reloads the whole SPA anyway (lib/remote.ts),
      // which rebinds this subscription cleanly.
      esHandle = null;
      setTimeout(connectEvents, 30_000);
    },
    // (Re)connect edge: events are hints with no server replay, so the client
    // owns catching up here — a bell landing during a network gap (wifi blip,
    // phone asleep) must still surface as a dot/badge after reconnect.
    () => void refresh(),
  );
}

// ─── boot (module side effects, like lib/updates.ts) ───

void probeNative();
connectEvents();
// A baseline fetch so the NavBar dot and the notifier's seen marks exist even
// before any Terminals surface mounts; waits out app startup.
setTimeout(() => void refresh(), 1500);
// Attention edges. Losing it stamps the watched session — everything up to this
// instant was on screen, so a bell that raced the blur (turn finished while the
// user was still looking, event delivered just after) must not toast or dot.
// Gaining it stamps too, and catches up the list (hidden webviews get their
// timers throttled, so the poll may have stretched).
window.addEventListener("blur", () => {
  if (watchedId) markSeen(watchedId);
});
window.addEventListener("focus", () => {
  if (watchedId && !document.hidden) markSeen(watchedId);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (watchedId) markSeen(watchedId);
  } else {
    void refresh();
  }
});
