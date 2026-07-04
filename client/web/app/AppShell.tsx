import { Suspense, useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Spinner } from "@/components/ui";
import PhoneModal from "@/components/PhoneModal";
import TerminalsHost from "@/pages/terminals/TerminalsHost";
import UpdateBanner from "@/components/UpdateBanner";
import { useDiscardBlocker } from "./routeGuard";

/**
 * The single persistent node under the router — it never unmounts across
 * navigation. Routed views (Home, Skill) render in the Outlet; Terminals is an
 * always-mounted sibling kept alive (its pty/xterm must survive navigation) and
 * shown only on `/terminals`. The unsaved-changes guard lives here so it covers
 * every navigation, including browser back/forward.
 */
export default function AppShell() {
  const onTerminals = useLocation().pathname === "/terminals";
  useDiscardBlocker();

  // The tray's "Open on your phone…" item deep-links to `#/?phone=1`. Handled
  // here — mounted exactly once and never display:none-hidden (RemoteMenu isn't:
  // a hidden Terminals copy would consume the one-shot param invisibly). With
  // HashRouter the query rides inside the hash, so parse it ourselves; open the
  // modal and strip the param (replaceState doesn't re-fire hashchange, so no loop).
  const [phoneOpen, setPhoneOpen] = useState(false);
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

  return (
    <>
      <div style={{ display: onTerminals ? "none" : "contents" }}>
        <Suspense fallback={<div className="grid h-dvh place-items-center"><Spinner /></div>}>
          <Outlet />
        </Suspense>
      </div>
      <TerminalsHost active={onTerminals} />
      <UpdateBanner />
      {phoneOpen && <PhoneModal onClose={() => setPhoneOpen(false)} />}
    </>
  );
}
