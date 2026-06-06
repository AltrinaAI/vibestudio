// Remote-SSH connection state, shared app-wide (NavBar pill + the connect dialog).
// A module-level store so status survives per-page NavBar remounts and one poller
// serves everyone. The key behaviour: a user-initiated connect that reaches
// "connected" RELOADS the SPA, so the ENTIRE window re-binds to the remote — skills,
// files, git, secrets, terminals all re-fetch through the now-proxying local server.
// It also polls while connected, so if the tunnel drops (the desktop's liveness
// monitor flips status to "error"/idle) the window rebinds back to Local on its own.
import { useSyncExternalStore } from "react";
import * as api from "./api";
import { flushEditor } from "./editorState";

const CONNECTING: ReadonlySet<api.RemoteState> = new Set([
  "detecting",
  "installing",
  "launching",
  "forwarding",
]);

export interface RemoteSnapshot {
  status: api.RemoteStatus;
  /** Whether this server exposes remoting (false on browser dev / the remote binary,
   *  where `/api/remote/*` 404s) — the pill hides itself when false. */
  available: boolean;
}

let snapshot: RemoteSnapshot = { status: { state: "idle" }, available: false };
let pendingConnect = false; // a user-initiated connect is awaiting "connected"
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollMs = 0; // current poll interval (0 = not polling)

function update(next: RemoteSnapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

/** Poll fast while connecting, slowly while connected (to catch a dropped tunnel),
 *  not at all when idle/errored. Only resets the timer when the cadence changes. */
function setPoll(ms: number) {
  if (ms === pollMs) return;
  pollMs = ms;
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (ms > 0) pollTimer = setInterval(() => void refresh(), ms);
}

export async function refresh(): Promise<void> {
  const prev = snapshot.status.state;
  let status: api.RemoteStatus;
  try {
    status = await api.remoteStatus();
  } catch {
    // No remoting on this server (404) or a transient error — present as Local.
    setPoll(0);
    pendingConnect = false;
    update({ status: { state: "idle" }, available: false });
    if (prev === "connected") window.location.reload();
    return;
  }
  update({ status, available: true });
  if (CONNECTING.has(status.state)) setPoll(1200);
  else if (status.state === "connected") setPoll(5000);
  else setPoll(0);

  if (status.state === "connected" && pendingConnect) {
    pendingConnect = false;
    window.location.reload(); // user-initiated connect succeeded → rebind to the remote
    return;
  }
  if (status.state !== "connected") pendingConnect = false;

  // The tunnel dropped out from under a live session (network loss / remote crash):
  // rebind to Local rather than leaving the window pointed at a dead remote.
  if (prev === "connected" && status.state !== "connected") window.location.reload();
}

export async function connect(host: string): Promise<void> {
  pendingConnect = true;
  try {
    await api.remoteConnect(host);
  } catch (e) {
    pendingConnect = false;
    throw e;
  }
  await refresh(); // picks up "detecting" and starts polling
}

/** Abort an in-flight connect, or clear an "error" state, returning to Local —
 *  WITHOUT a reload. A failed/aborted connect never set a target (we were never
 *  proxying), so there's nothing to rebind; just reset the backend status to idle. */
export async function cancel(): Promise<void> {
  pendingConnect = false;
  try {
    await api.remoteDisconnect();
  } catch {
    /* ignore — best-effort reset */
  }
  await refresh();
}

export async function disconnect(): Promise<void> {
  // Flush any pending editor buffer to the REMOTE before we tear the tunnel down (we're
  // still connected here), then reload so the window re-binds to the local host.
  try {
    await flushEditor();
  } catch {
    /* best-effort — don't block disconnect on a flush failure */
  }
  await api.remoteDisconnect();
  window.location.reload();
}

export function useRemote(): RemoteSnapshot & {
  connect: typeof connect;
  disconnect: typeof disconnect;
  cancel: typeof cancel;
} {
  const snap = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
    () => snapshot,
  );
  return { ...snap, connect, disconnect, cancel };
}

// Resolve availability + current status on first import (cold start / post-reload),
// so the pill is correct immediately and a still-connecting session keeps polling.
void refresh();
