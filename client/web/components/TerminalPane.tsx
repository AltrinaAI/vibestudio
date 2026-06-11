"use client";

import { useEffect, useRef } from "react";
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

/** Write to the system clipboard from inside a user gesture. The async API first;
 *  if it's denied or missing (insecure-context LAN origins have no
 *  navigator.clipboard at all), fall back to a hidden-textarea execCommand copy,
 *  which only works during a gesture — exactly where this is called from. */
function copyText(text: string, refocus: () => void): void {
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* nothing left to try */
    }
    ta.remove();
    refocus();
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(fallback);
  else fallback();
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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      scrollback: 8000,
      // With `mouse on` (set server-side so the wheel scrolls tmux scrollback),
      // tmux owns drag-selection — so give the user a native-selection escape
      // hatch that doesn't depend on the OSC 52 clipboard hop below: Shift+drag
      // (xterm's default) everywhere, and Option+drag on macOS.
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
    try {
      fit.fit();
    } catch {
      /* host not laid out yet */
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

    // Attach only once the host has a real layout size. A mid-mount measure of
    // a few px (the studio side panel while its width style lands, a dialog
    // mid-open) would create the pty — and, with tmux's `window-size latest`,
    // clamp the whole window — at postage-stamp size; if the correcting resize
    // is ever lost, every other viewer of the session sees a dotted stamp.
    let handle: api.TerminalHandle | null = null;
    let dataSub: { dispose: () => void } | null = null;
    const hostIsReal = () => host.clientWidth >= 120 && host.clientHeight >= 80;
    const attach = () => {
      if (handle) return;
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }
      handle = api.attachTerminal(id, {
        cols: term.cols,
        rows: term.rows,
        onData: (bytes) => term.write(bytes),
        onClose: () => term.write("\r\n\x1b[2m[disconnected — the session may have ended]\x1b[0m\r\n"),
      });
      dataSub = term.onData((d) => handle!.write(d));
    };
    if (hostIsReal()) attach();

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
      raf = requestAnimationFrame(() => {
        if (!handle) {
          // Deferred attach: start once the host first reaches a real size.
          if (hostIsReal()) attach();
          return;
        }
        try {
          fit.fit();
          handle.resize(term.cols, term.rows);
        } catch {
          /* transient zero-size during layout */
        }
      });
    });
    ro.observe(host);
    term.focus();

    refitRef.current = () => {
      if (!handle) {
        if (hostIsReal()) attach();
        return;
      }
      try {
        fit.fit();
        handle.resize(term.cols, term.rows);
      } catch {
        /* transient zero-size during layout */
      }
    };

    return () => {
      gone = true;
      host.removeEventListener("paste", onPaste, true);
      cancelAnimationFrame(raf);
      themeObs.disconnect();
      ro.disconnect();
      dataSub?.dispose();
      handle?.detach();
      term.dispose();
      refitRef.current = () => {};
    };
  }, [id]);

  // Kept alive across navigation via display:none, where the host has zero size
  // and fit() can't measure; re-fit (and resize the pty) once shown again.
  useEffect(() => {
    if (visible) requestAnimationFrame(() => refitRef.current());
  }, [visible]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden bg-surface p-1.5" />;
}
