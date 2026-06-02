"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import * as api from "@/lib/api";

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
      theme: themeFromCss(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* host not laid out yet */
    }

    const handle = api.attachTerminal(id, {
      cols: term.cols,
      rows: term.rows,
      onData: (bytes) => term.write(bytes),
      onClose: () => term.write("\r\n\x1b[2m[disconnected — the session may have ended]\x1b[0m\r\n"),
    });
    const dataSub = term.onData((d) => handle.write(d));

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
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
      try {
        fit.fit();
        handle.resize(term.cols, term.rows);
      } catch {
        /* transient zero-size during layout */
      }
    };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dataSub.dispose();
      handle.detach();
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
