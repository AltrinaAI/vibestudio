"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import * as api from "@/lib/api";
import { log } from "@/lib/log";

/** Reject pasted images larger than this client-side, matching the server cap in
 *  `save_pasted_image`, so an over-limit paste fails instantly instead of after a
 *  full encode-and-upload through the tunnel. */
const MAX_PASTE_BYTES = 32 * 1024 * 1024;

/** A tmux copy-mode copy (OSC 52) replayed via the copy chord stays valid this
 *  long — fresh enough to mean "the thing I just selected", stale after that. */
const COPY_STASH_MS = 60_000;

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** No real pane is ever this small — below it is a transient layout artifact.
 *  skill-term enforces the same floor as a backstop. */
const MIN_COLS = 20;
const MIN_ROWS = 5;

/** Write to the system clipboard from inside a user gesture (the copy chord). The
 *  synchronous hidden-textarea execCommand copy goes FIRST: it lands within the
 *  gesture on WKWebView and on insecure-context LAN origins (which have no
 *  navigator.clipboard at all), where the async Clipboard API is gesture-gated and
 *  rejects a tick too late for a fallback to recover. Only if the legacy command is
 *  unavailable (some browsers are retiring it) do we reach for the async API. */
function copyText(text: string, refocus: () => void): void {
  let copied = false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  ta.remove();
  refocus();
  if (!copied) navigator.clipboard?.writeText(text).catch(() => {});
}

// Pull terminal colors from the app's CSS variables so it tracks the theme.
function themeFromCss(): Record<string, string | undefined> {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => {
    const s = css.getPropertyValue(n).trim();
    return s || undefined;
  };
  return {
    background: v("--surface") ?? v("--bg"),
    foreground: v("--fg"),
    cursor: v("--accent"),
    cursorAccent: v("--surface"),
    selectionBackground: v("--sel"),
  };
}

/**
 * A live terminal view bound to one tmux-backed session. Mounting attaches;
 * unmounting detaches (the session keeps running). Remount with a new `id`
 * (via `key`) to switch sessions.
 */
export default function TerminalPane({ id, visible = true }: { id: string; visible?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Refreshed on each (re)attach; invoked when the pane becomes visible again.
  const refitRef = useRef<() => void>(() => {});
  const termRef = useRef<Terminal | null>(null);

  // Select mode: while on, a plain drag makes a NATIVE xterm selection instead of
  // being forwarded to the agent's own mouse handling — the only way to drag-copy a
  // region out of a full-screen, mouse-grabbing TUI (opencode) without tmux. The ref
  // is what the (effect-scoped) shouldForceSelection override reads on each
  // mousedown; the state drives the toggle's appearance. Toggling it never re-runs
  // the attach effect (deps are stable), so the terminal is not torn down.
  const selectModeRef = useRef(false);
  const [selectMode, setSelectMode] = useState(false);
  const applySelectMode = useCallback((on: boolean) => {
    selectModeRef.current = on;
    setSelectMode(on);
    termRef.current?.focus();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      scrollback: 8000,
      // `mouse on` (server-side) lets the wheel scroll tmux scrollback, but means a
      // plain drag is sent to the agent rather than selected. The Select toggle and
      // Shift/Option+drag both force a native xterm selection instead — see the
      // shouldForceSelection override after open().
      macOptionClickForcesSelection: true,
      theme: themeFromCss(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // tmux owns the scrollback (wheel → copy-mode); copying there arrives as an
    // OSC 52 write — honor it so copy-mode copies land on the system clipboard.
    // Releasing a mouse-drag IS the copy in tmux: there is no Ctrl+C step.
    let lastCopy = { text: "", at: 0 };
    term.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(";");
      const payload = semi < 0 ? "" : data.slice(semi + 1);
      if (!payload || payload === "?") return true; // never answer clipboard *reads*
      let text: string;
      try {
        text = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
      } catch {
        return true; // malformed base64
      }
      // Stash first: this write fires from the SSE stream (no user gesture), and
      // WKWebView/insecure origins deny gestureless clipboard writes — the copy
      // chord below replays the stash from inside a real keystroke when that
      // happens. The rejection is async, so a try/catch could never see it.
      lastCopy = { text, at: Date.now() };
      navigator.clipboard?.writeText(text).catch((e) => log.debug("term", "OSC52 clipboard write denied", e));
      return true;
    });
    // Copy chord — Cmd+C on macOS, Ctrl+Shift+C elsewhere (plain Ctrl+C must stay
    // SIGINT; it only copies when a native Shift/Option+drag selection exists, VS
    // Code-style). Native selection wins; otherwise replay the last tmux copy —
    // from inside this keystroke the clipboard write is allowed everywhere.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Esc leaves select mode (mirrors tmux copy-mode's q/Esc) without reaching the
      // agent; outside select mode it passes through untouched.
      if (e.key === "Escape" && selectModeRef.current) {
        applySelectMode(false);
        return false;
      }
      const key = e.key.toLowerCase();
      // Paste chord (non-Mac; Cmd+V is already native on Mac): skip xterm so the
      // browser's default paste fires and rides the normal text/image path.
      // Otherwise Ctrl+V becomes a literal ^V in the pty — which Claude/Codex
      // bind to "read MY clipboard": a dead end when the agent runs on a remote
      // headless backend that can't see this machine's clipboard.
      if (!IS_MAC && key === "v" && e.ctrlKey && !e.altKey && !e.metaKey) return false;
      if (key !== "c" || e.altKey) return true;
      const wantsCopy = IS_MAC
        ? e.metaKey && !e.ctrlKey
        : e.ctrlKey && !e.metaKey && (e.shiftKey || term.hasSelection());
      if (!wantsCopy) return true;
      const stashed = Date.now() - lastCopy.at < COPY_STASH_MS ? lastCopy.text : "";
      const text = term.hasSelection() ? term.getSelection() : stashed;
      if (!text) return true;
      copyText(text, () => term.focus());
      term.clearSelection();
      return false;
    });
    term.open(host);
    termRef.current = term;

    // Force a NATIVE xterm selection (instead of forwarding the drag to the agent)
    // when in select mode, or on Shift/Option-drag — the only way to drag-copy a
    // region out of a full-screen mouse-grabbing TUI (opencode) without tmux.
    // Reaches a private service like the fit addon reaches `_core`; guarded so a
    // future xterm that drops it degrades instead of throwing.
    const sel = (
      term as unknown as {
        _core?: { _selectionService?: { shouldForceSelection?: (e: MouseEvent) => boolean } };
      }
    )._core?._selectionService;
    if (sel && typeof sel.shouldForceSelection === "function") {
      sel.shouldForceSelection = (ev: MouseEvent) =>
        selectModeRef.current || ev.shiftKey || (IS_MAC && ev.altKey);
    } else {
      log.warn("term", "xterm selection service unavailable — select mode inert");
    }

    // xterm captures its colors at construction and renders to a canvas, so it
    // can't follow CSS the way the rest of the UI does — without this it keeps
    // stale colors until it's remounted, lagging the rest of the app on a theme
    // toggle. Re-read the CSS vars whenever the `.dark` class on <html> flips
    // (the theme's source of truth), regardless of what triggered the change.
    const themeObs = new MutationObserver(() => {
      term.options.theme = themeFromCss();
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    // The single gate for every size reported to the backend (attach + resize).
    // tmux sizes the whole window to our pty (`window-size latest`) and a TUI
    // repaints on SIGWINCH, so one transient postage-stamp measurement (a side
    // panel mid-layout, a display:none flip) gets baked into the scrollback for
    // every viewer. Refuse implausible sizes; log every attempt (refusals at
    // warn → forwarded to the server log).
    let handle: api.TerminalHandle | null = null;
    let dataSub: { dispose: () => void } | null = null;
    let sent = { cols: 0, rows: 0 };
    const syncSize = (why: string) => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w < 120 || h < 80) {
        log.debug("term-size", `skip (${why}): host ${w}×${h}px, id=${id}`);
        return;
      }
      try {
        fit.fit();
      } catch {
        return; // not laid out yet
      }
      if (term.cols < MIN_COLS || term.rows < MIN_ROWS) {
        log.warn("term-size", `refused ${term.cols}×${term.rows} (${why}): host ${w}×${h}px, id=${id}`);
        return;
      }
      if (!handle) {
        handle = api.attachTerminal(id, {
          cols: term.cols,
          rows: term.rows,
          onData: (bytes) => term.write(bytes),
          onClose: () => term.write("\r\n\x1b[2m[disconnected — the session may have ended]\x1b[0m\r\n"),
        });
        dataSub = term.onData((d) => handle!.write(d));
        log.debug("term-size", `attach ${term.cols}×${term.rows} (${why}), id=${id}`);
      } else if (term.cols !== sent.cols || term.rows !== sent.rows) {
        handle.resize(term.cols, term.rows);
        log.debug("term-size", `resize ${term.cols}×${term.rows} (${why}), id=${id}`);
      } else {
        return; // unchanged — nothing to report
      }
      sent = { cols: term.cols, rows: term.rows };
    };
    syncSize("mount");

    // Images can't ride the text paste path: ship the bytes to the backend
    // (where the agent runs — possibly a remote host with no access to this
    // machine's clipboard) and paste the returned file path, the same shape
    // drag-and-drop produces in a native terminal. When the clipboard carries
    // both text and an image (e.g. spreadsheet cells), text wins and xterm's
    // own paste handler takes it.
    let gone = false;
    const note = (msg: string) => {
      if (!gone) term.write(`\r\n\x1b[2m[${msg}]\x1b[0m\r\n`);
    };
    const onPaste = (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      const img = dt && Array.from(dt.items).find((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (!img || dt.getData("text/plain")) return;
      e.preventDefault();
      e.stopPropagation();
      const file = img.getAsFile();
      if (!file) return;
      // Capture the mime NOW: the File snapshot keeps its type, but the
      // DataTransferItem is neutered once this handler returns, so `img.type`
      // reads "" after the first await — which the server's allowlist rejects.
      const mime = file.type || img.type;
      // Reject oversized images here, before encoding ~1.33× their bytes into a
      // JSON body and shipping it through the SSH tunnel only for the server's
      // identical cap to 400 it. Keep the limit in sync with save_pasted_image.
      if (file.size > MAX_PASTE_BYTES) {
        note("image too large (max 32 MB)");
        return;
      }
      void (async () => {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const { path } = await api.terminalPasteImage(bytes, mime);
          if (!gone) term.paste(path);
        } catch (err) {
          note(`couldn't paste image: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    };
    host.addEventListener("paste", onPaste, true);

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => syncSize("resize"));
    });
    ro.observe(host);
    term.focus();

    refitRef.current = () => syncSize("shown");

    return () => {
      gone = true;
      host.removeEventListener("paste", onPaste, true);
      cancelAnimationFrame(raf);
      themeObs.disconnect();
      ro.disconnect();
      dataSub?.dispose();
      handle?.detach();
      term.dispose();
      termRef.current = null;
      refitRef.current = () => {};
    };
  }, [id, applySelectMode]);

  // Kept alive across navigation via display:none, where the host has zero size
  // and fit() can't measure; re-fit (and resize the pty) once shown again.
  useEffect(() => {
    if (visible) requestAnimationFrame(() => refitRef.current());
  }, [visible]);

  return (
    <div className="group relative h-full w-full">
      <button
        type="button"
        // preventDefault keeps the click from stealing focus / starting a drag in
        // the terminal underneath; applySelectMode hands focus back to the term.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => applySelectMode(!selectMode)}
        title={
          selectMode
            ? "Select mode on — drag to highlight, ⌘/Ctrl-C to copy, Esc to exit"
            : "Select text — drag to highlight a region, then ⌘/Ctrl-C"
        }
        className={`absolute right-2 top-2 z-10 rounded-md px-2 py-0.5 text-xs font-medium shadow-sm transition ${
          selectMode
            ? "bg-accent text-accent-fg"
            : "pointer-events-none border border-border bg-surface/85 text-muted opacity-0 backdrop-blur hover:bg-panel hover:text-fg focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
        }`}
      >
        {selectMode ? "Selecting…" : "Select"}
      </button>
      <div
        ref={hostRef}
        className={`h-full w-full overflow-hidden bg-surface p-1.5 ${
          selectMode ? "[&_.xterm-screen]:!cursor-text" : ""
        }`}
      />
    </div>
  );
}
