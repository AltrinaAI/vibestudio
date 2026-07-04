"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import PhoneModal, { PhoneIcon } from "@/components/PhoneModal";
import { btnGhost, btnPrimary, Spinner } from "@/components/ui";
import * as api from "@/lib/api";
import { useRemote } from "@/lib/remote";

const CONNECTING = new Set<api.RemoteState>(["detecting", "installing", "launching", "forwarding"]);

function ServerIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}

/**
 * The connection control in the top chrome: a status pill ("Local" / "⟳ Connecting…"
 * / "● <host>") that opens a dialog to pick an SSH host. While connected, the entire
 * app runs on the remote (the local server proxies every `/api/*` to it). Hidden when
 * the server doesn't expose remoting (browser dev / the remote binary itself).
 */
export default function RemoteMenu() {
  const { status, available } = useRemote();
  const [open, setOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);

  // The tray's "Open on your phone…" item deep-links to `#/?phone=1`. With HashRouter
  // the query rides inside the hash, so parse it ourselves; open the modal once and
  // strip the param (replaceState doesn't re-fire hashchange, so no loop).
  useEffect(() => {
    const check = () => {
      const hash = window.location.hash;
      const q = hash.indexOf("?");
      if (q === -1) return;
      const params = new URLSearchParams(hash.slice(q + 1));
      if (params.get("phone") !== "1") return;
      params.delete("phone");
      const rest = params.toString();
      const url = window.location.pathname + window.location.search + hash.slice(0, q) + (rest ? `?${rest}` : "");
      history.replaceState(null, "", url);
      setPhoneOpen(true);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);

  if (!available) return null;

  const connecting = CONNECTING.has(status.state);
  const connected = status.state === "connected";
  const errored = status.state === "error";
  const label = connected ? status.host || "Remote" : connecting ? "Connecting…" : errored ? "Connection lost" : "Local";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={
          errored
            ? `${status.message || "Connection error"} — click to reconnect`
            : connected
              ? `Connected to ${status.host}`
              : "Connect to a remote host over SSH"
        }
        className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
          connected ? "text-ok hover:bg-panel" : errored ? "text-warn hover:bg-panel" : "text-muted hover:bg-panel hover:text-fg"
        }`}
      >
        {connecting ? <Spinner className="h-3.5 w-3.5" /> : <ServerIcon />}
        <span className="hidden max-w-40 truncate sm:inline">{label}</span>
        {connected && <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />}
        {errored && <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />}
      </button>
      {open && (
        <RemoteDialog
          onClose={() => setOpen(false)}
          onOpenPhone={() => {
            setOpen(false);
            setPhoneOpen(true);
          }}
        />
      )}
      {phoneOpen && <PhoneModal onClose={() => setPhoneOpen(false)} />}
    </>
  );
}

function RemoteDialog({ onClose, onOpenPhone }: { onClose: () => void; onOpenPhone: () => void }) {
  const { status, connect, disconnect, cancel } = useRemote();
  const [hosts, setHosts] = useState<api.RemoteHost[] | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false); // disconnect in flight (reloads the page)
  const [starting, setStarting] = useState(false); // connect kickoff, before status updates
  const [error, setError] = useState<string | null>(null);

  const connecting = CONNECTING.has(status.state) || starting;
  const connected = status.state === "connected";
  const errored = status.state === "error";

  // WSL distros (Windows) are offered as `wsl:<distro>` targets; split them from the
  // ssh-config aliases so each gets its own labelled group.
  const wslHosts = (hosts ?? []).filter((h) => h.name.startsWith("wsl:"));
  const sshHosts = (hosts ?? []).filter((h) => !h.name.startsWith("wsl:"));

  // Whether this server has the phone feature — probed when the dialog opens
  // (never on page load), so the item only shows where /api/phone answers.
  const [phone, setPhone] = useState(false);

  useEffect(() => {
    api.remoteList().then(setHosts).catch(() => setHosts([]));
    api.phoneStatus().then((s) => setPhone(s != null)).catch(() => setPhone(false));
  }, []);
  // Surface a backend connect failure inside the dialog.
  useEffect(() => {
    if (status.state === "error" && status.message) setError(status.message);
  }, [status.state, status.message]);

  const doConnect = async (host: string) => {
    const h = host.trim();
    if (!h) return;
    setError(null);
    setStarting(true);
    try {
      // Kicks off; the store's status drives the connecting view. On success it
      // reloads once "connected"; on failure status flips to "error" and the form
      // reappears below with the message — no stuck spinner.
      await connect(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start connecting.");
    } finally {
      setStarting(false);
    }
  };

  // Abort an in-flight connect, or clear an "error" → back to Local (no reload).
  const doCancel = async () => {
    setError(null);
    await cancel();
  };

  const doDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnect(); // reloads the page on success
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Couldn't disconnect.");
    }
  };

  return (
    <Modal title="Remote host" titleLeading={<ServerIcon />} onClose={onClose}>
        <div className="space-y-4 px-5 py-4">
          {connected ? (
            <>
              <p className="text-sm text-fg">
                Connected to <span className="font-mono text-ok">{status.host}</span>. The whole app — skills, files, git,
                secrets, and terminals — is running on this host.
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={onClose} className={btnGhost}>
                  Close
                </button>
                <button type="button" onClick={() => void doDisconnect()} disabled={busy} className={btnPrimary}>
                  {busy ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>
            </>
          ) : connecting ? (
            <>
              <p className="flex items-center gap-2 text-sm text-muted">
                <Spinner className="h-4 w-4" /> {status.message || "Connecting…"}
              </p>
              <p className="text-xs text-faint">
                Connecting to <span className="font-mono">{status.host || value}</span>. First-time setup downloads a small
                server to the remote.
              </p>
              <div className="flex justify-end pt-1">
                <button type="button" onClick={() => void doCancel()} className={btnGhost}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">SSH host</label>
                <input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void doConnect(value)}
                  placeholder="user@host or a ~/.ssh/config alias"
                  spellCheck={false}
                  autoFocus
                  className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
                />
              </div>

              {hosts === null ? (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Spinner className="h-3.5 w-3.5" /> Reading hosts…
                </p>
              ) : hosts.length > 0 ? (
                <div className="space-y-3">
                  <HostGroup label="WSL distros" hosts={wslHosts} display={(h) => h.name.replace(/^wsl:/, "")} onPick={doConnect} />
                  <HostGroup label="From ~/.ssh/config" hosts={sshHosts} display={(h) => h.name} onPick={doConnect} />
                </div>
              ) : (
                <p className="text-xs text-faint">No hosts in ~/.ssh/config — type one above.</p>
              )}

              {error && <p className="text-xs text-danger">{error}</p>}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    if (errored) void cancel(); // reset backend status → Local
                    onClose();
                  }}
                  className={btnGhost}
                >
                  {errored ? "Back to local" : "Cancel"}
                </button>
                <button type="button" onClick={() => void doConnect(value)} disabled={!value.trim()} className={btnPrimary}>
                  {errored ? "Try again" : "Connect"}
                </button>
              </div>
            </>
          )}
          {phone && (
            <div className="border-t border-border pt-2">
              <button
                type="button"
                onClick={onOpenPhone}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted transition-colors hover:bg-panel hover:text-fg"
              >
                <PhoneIcon className="shrink-0" />
                Open on your phone…
              </button>
            </div>
          )}
        </div>
    </Modal>
  );
}

/** A labelled list of pickable hosts; renders nothing when empty. */
function HostGroup({
  label,
  hosts,
  display,
  onPick,
}: {
  label: string;
  hosts: api.RemoteHost[];
  display: (h: api.RemoteHost) => string;
  onPick: (host: string) => void;
}) {
  if (hosts.length === 0) return null;
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">{label}</label>
      <div className="max-h-48 space-y-1 overflow-auto">
        {hosts.map((h) => (
          <button
            key={h.name}
            type="button"
            onClick={() => void onPick(h.name)}
            className="flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-fg transition-colors hover:border-border-strong hover:bg-panel"
          >
            <ServerIcon className="shrink-0 text-muted" />
            <span className="truncate font-mono text-xs">{display(h)}</span>
            {h.detail && <span className="ml-auto truncate text-xs text-faint">{h.detail}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
