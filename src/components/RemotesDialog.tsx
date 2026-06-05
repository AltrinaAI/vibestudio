"use client";

import { useCallback, useEffect, useState } from "react";
import { Spinner } from "@/components/ui";
import * as api from "@/lib/api";
import type { SshHost, RemoteSession } from "@/lib/api";

const btnPrimary =
  "rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-app transition-opacity hover:opacity-90 disabled:opacity-40";
const btnGhost =
  "rounded-md border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-panel disabled:opacity-40";

function hostSubtitle(h: SshHost): string {
  const addr = h.hostName ?? h.name;
  const user = h.user ? `${h.user}@` : "";
  const port = h.port && h.port !== 22 ? `:${h.port}` : "";
  return `${user}${addr}${port}`;
}

/**
 * The remote picker — the SSH entry point. Lists the hosts from the user's
 * `~/.ssh/config`, connects to the chosen one (provisioning + launching an
 * identical skill-server on the remote and tunneling to it), then opens that
 * remote UI in a new window, just like VS Code's remote-SSH flow. Already-live
 * sessions are listed so they can be re-opened or disconnected.
 */
export default function RemotesDialog({ onClose }: { onClose: () => void }) {
  const [hosts, setHosts] = useState<SshHost[] | null>(null);
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [manual, setManual] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await api.remoteList());
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    api
      .remoteHosts()
      .then(setHosts)
      .catch((e) => {
        setHosts([]);
        setError(e instanceof Error ? e.message : "Couldn't read ~/.ssh/config.");
      });
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const open = async (s: RemoteSession) => {
    const ok = await api.openRemoteWindow(s.localPort);
    if (!ok) {
      setInfo(`Pop-up blocked — open http://localhost:${s.localPort}/ manually.`);
    }
  };

  const connect = async (host: string) => {
    const name = host.trim();
    if (!name) return;
    setConnecting(name);
    setError(null);
    setInfo(null);
    try {
      const s = await api.remoteConnect(name);
      setSessions((prev) => [s, ...prev.filter((p) => p.id !== s.id)]);
      if (s.note) setInfo(s.note);
      await open(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't connect to the remote.");
    } finally {
      setConnecting(null);
    }
  };

  const disconnect = async (id: string) => {
    try {
      await api.remoteDisconnect(id);
    } catch {
      /* already gone */
    }
    await refreshSessions();
  };

  const busy = connecting !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <span className="text-sm font-semibold text-fg">Connect to a remote</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-md p-1 text-faint hover:bg-panel hover:text-fg"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-auto px-5 py-4">
          <p className="text-xs leading-relaxed text-muted">
            Pick a host from your <code className="rounded bg-panel px-1 py-0.5 font-mono text-[0.85em]">~/.ssh/config</code>.
            Skill Studio will SSH in, set up an identical server on that machine, and open it in a new window — your laptop
            just drives it. Key-based auth only for now.
          </p>

          {/* Active sessions */}
          {sessions.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted">Connected</h3>
              <ul className="space-y-1.5">
                {sessions.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 rounded-md border border-border bg-app px-3 py-2"
                  >
                    <span className="relative flex h-2 w-2 shrink-0" title="Connected">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-accent/60" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-fg">{s.host}</p>
                      <p className="truncate font-mono text-[0.65rem] text-faint">
                        localhost:{s.localPort} · {s.provisioned}
                      </p>
                    </div>
                    <button type="button" onClick={() => void open(s)} className={btnGhost}>
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => void disconnect(s.id)}
                      title="Disconnect"
                      className="rounded-md p-1.5 text-faint hover:text-danger"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Hosts from ssh config */}
          <section>
            <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted">Hosts</h3>
            {hosts === null ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Spinner className="h-3.5 w-3.5" /> Reading ~/.ssh/config…
              </p>
            ) : hosts.length === 0 ? (
              <p className="text-xs leading-relaxed text-muted">
                No hosts found in <code className="font-mono">~/.ssh/config</code>. Add one, or type a host below.
              </p>
            ) : (
              <ul className="space-y-1">
                {hosts.map((h) => {
                  const isConnecting = connecting === h.name;
                  return (
                    <li key={h.name} className="group flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void connect(h.name)}
                        disabled={busy}
                        className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-panel disabled:opacity-50"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-fg">{h.name}</span>
                          <span className="block truncate font-mono text-[0.65rem] text-faint">{hostSubtitle(h)}</span>
                        </span>
                        {isConnecting ? (
                          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
                            <Spinner className="h-3.5 w-3.5" /> Connecting…
                          </span>
                        ) : (
                          <span className="shrink-0 text-xs text-accent opacity-0 group-hover:opacity-100">Connect →</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Manual host */}
          <section>
            <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted">Or type a host</h3>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void connect(manual);
              }}
            >
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="user@host or an ssh alias"
                spellCheck={false}
                disabled={busy}
                className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent disabled:opacity-50"
              />
              <button type="submit" disabled={busy || !manual.trim()} className={`${btnPrimary} shrink-0`}>
                {connecting === manual.trim() ? "Connecting…" : "Connect"}
              </button>
            </form>
          </section>

          {info && <p className="text-xs text-muted">{info}</p>}
          {error && <p className="whitespace-pre-wrap text-xs text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}
