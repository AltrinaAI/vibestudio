// Tiny diagnostics logger for the SPA. Two jobs:
//   1. Console output — `debug`/`info` only in dev (Vite's `import.meta.env.DEV`);
//      `warn`/`error` always. Namespaced by a `scope` string so it's greppable.
//   2. Pipe `warn`/`error` to the backend so they land in the on-disk server log
//      (skill-studio.log) — the ONLY way to see frontend problems in a packaged app
//      (the webview devtools console isn't reachable there).
//
// Networking is deliberately minimal: only warn/error (plus uncaught errors via the
// global handlers) are forwarded, and they're BATCHED — flushed at BATCH_SIZE or
// every FLUSH_MS, with a sendBeacon on tab-hide/close. In normal operation nothing
// is forwarded, so there is zero per-log traffic; only real problems generate a
// (batched) POST. HTTP 4xx/5xx are intentionally NOT forwarded here — the server
// already logs those itself, so re-sending them would be redundant networking.

type Level = "debug" | "info" | "warn" | "error";
interface Entry {
  level: Level;
  scope: string;
  msg: string;
  ts: number;
}

// Same-origin by default; matches lib/api.ts so dev (VITE_API_BASE) and the
// remote-proxied case behave identically.
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
const DEV = import.meta.env.DEV;
const FORWARD: ReadonlySet<Level> = new Set<Level>(["warn", "error"]);
const BATCH_SIZE = 16;
const FLUSH_MS = 5000;
const MAX_QUEUE = 100; // cap memory if a burst of errors can't be sent

let queue: Entry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function send(entries: Entry[]) {
  // RAW fetch (not the api `http()` wrapper) so a failed log POST can never re-enter
  // the logger and loop. Failures are dropped on purpose.
  fetch(`${API_BASE}/api/client-log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
    keepalive: true,
  }).catch(() => {});
}

function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!queue.length) return;
  const entries = queue;
  queue = [];
  send(entries);
}

function enqueue(e: Entry) {
  queue.push(e);
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  if (queue.length >= BATCH_SIZE) flush();
  else if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

function emit(level: Level, scope: string, args: unknown[]) {
  if (level === "warn" || level === "error" || DEV) {
    const fn = level === "debug" ? "log" : level;
    console[fn](`[${scope}]`, ...args);
  }
  if (FORWARD.has(level)) enqueue({ level, scope, msg: fmt(args), ts: Date.now() });
}

export const log = {
  debug: (scope: string, ...args: unknown[]) => emit("debug", scope, args),
  info: (scope: string, ...args: unknown[]) => emit("info", scope, args),
  warn: (scope: string, ...args: unknown[]) => emit("warn", scope, args),
  error: (scope: string, ...args: unknown[]) => emit("error", scope, args),
};

/// Install global capture for uncaught errors + unhandled promise rejections (the
/// fire-and-forget `.catch`-less rejections that vanish today) and a flush on
/// tab-hide/close so the last entries aren't lost. Call once at startup.
export function initLogging() {
  if (typeof window === "undefined") return;

  window.addEventListener("error", (e) => {
    log.error("window", e.message, e.error ?? "");
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason instanceof Error ? e.reason : String(e.reason);
    log.error("unhandledrejection", reason);
  });

  // On unload, queued entries can't survive a normal fetch — use sendBeacon, which
  // is fire-and-forget and outlives the page.
  const beacon = () => {
    if (!queue.length) return;
    const entries = queue;
    queue = [];
    try {
      const blob = new Blob([JSON.stringify({ entries })], { type: "application/json" });
      navigator.sendBeacon(`${API_BASE}/api/client-log`, blob);
    } catch {
      /* ignore */
    }
  };
  window.addEventListener("pagehide", beacon);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") beacon();
  });
}
