/**
 * Web Push wiring — the notification channel that works with the app CLOSED.
 * The server watches bells and pushes through the browser vendor's service
 * (Apple's for the home-screen iPhone app); this module owns the client half:
 * the service-worker registration, the permission/subscription flow, and the
 * attention beacons that tell the server "someone is looking — don't buzz".
 *
 * iOS grants PushManager only to INSTALLED (Add to Home Screen) web apps;
 * plain Safari tabs feature-detect to no-ops here. Subscriptions silently
 * expire on iOS, so every app open re-subscribes and re-registers.
 */
import * as api from "@/lib/api";
import { log } from "@/lib/log";

// Explicit ArrayBuffer backing: TS types applicationServerKey as BufferSource
// over ArrayBuffer, and Uint8Array.from would infer ArrayBufferLike.
function b64UrlToBytes(b64url: string) {
  const bin = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** This context can receive pushes (installed iOS web app, Android/desktop
 *  browsers). Desktop webviews and iOS Safari tabs fail the detect. */
export function canPush(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
}

/** Worth showing an "enable notifications" affordance: capable, undecided. */
export function canOfferPush(): boolean {
  return import.meta.env.PROD && canPush() && Notification.permission === "default";
}

// The service worker doubles as the offline app shell. Dev builds skip it —
// a worker caching Vite's dev modules would serve stale code forever.
let reg: Promise<ServiceWorkerRegistration | null> | null = null;
function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return Promise.resolve(null);
  reg ??= navigator.serviceWorker.register("/sw.js").catch((e) => {
    // Expected on desktop webviews (WKWebView has no SW outside App-Bound
    // Domains) — the offline shell and push simply don't apply there.
    log.debug("push", "sw registration unavailable", e instanceof Error ? e.message : String(e));
    return null;
  });
  return reg;
}

/** (Re)subscribe and hand the endpoint to the server. Safe to call on every
 *  open: same-key subscribe is idempotent, and the server store replaces by
 *  endpoint — this is the hygiene that outlives iOS's silent expiries. */
async function subscribeNow(): Promise<boolean> {
  const r = await swRegistration();
  if (!r) return false;
  try {
    const { key } = await api.pushKey();
    const appKey = b64UrlToBytes(key);
    let sub: PushSubscription;
    try {
      sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    } catch (e) {
      // A leftover subscription under an older VAPID key blocks re-subscribing:
      // drop it and retry once.
      const old = await r.pushManager.getSubscription();
      if (!old) throw e;
      await old.unsubscribe();
      sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    }
    const j = sub.toJSON();
    if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return false;
    await api.pushSubscribe(j.endpoint, { p256dh: j.keys.p256dh, auth: j.keys.auth });
    return true;
  } catch (e) {
    log.warn("push", "subscribe failed", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Permission prompt + subscription. Call synchronously from a user gesture —
 *  iOS refuses the prompt outside one. */
export function enablePushInGesture(): Promise<boolean> {
  if (!canPush()) return Promise.resolve(false);
  return Notification.requestPermission().then((p) => (p === "granted" ? subscribeNow() : false));
}

// ─── attention beacons ───
// Any focused client within the server's freshness window suppresses pushes:
// the SSE dot/toast path already covers a user who is looking at a live UI.

const CLIENT_ID: string = (() => {
  try {
    const existing = sessionStorage.getItem("skillviewer-client-id");
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem("skillviewer-client-id", id);
    return id;
  } catch {
    return `tab-${Math.random().toString(36).slice(2)}`;
  }
})();

let heartbeat: number | undefined;
function attention(focused: boolean): void {
  api.pushAttention(CLIENT_ID, focused).catch(() => {});
  window.clearInterval(heartbeat);
  heartbeat = undefined;
  if (focused) {
    // The server expires attention after ~60s; re-affirm while focused.
    heartbeat = window.setInterval(() => api.pushAttention(CLIENT_ID, true).catch(() => {}), 30_000);
  }
}

/** Boot: attention edges + the re-subscribe-on-open hygiene. */
export function initPush(): void {
  const sync = () => attention(!document.hidden && document.hasFocus());
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);
  // pagehide is the last reliable moment on iOS — a plain fetch dies with the page.
  window.addEventListener("pagehide", () => {
    try {
      navigator.sendBeacon?.(
        "/api/push/attention",
        new Blob([JSON.stringify({ client: CLIENT_ID, focused: false })], { type: "application/json" }),
      );
    } catch {
      /* sendBeacon missing/blocked — the server-side expiry covers it */
    }
  });
  sync();
  // The SW is also the offline app shell — register it on every boot, not just
  // once push is enabled (a notification tap with the VPN down needs it).
  void swRegistration();
  if (canPush() && Notification.permission === "granted") void subscribeNow();
}
