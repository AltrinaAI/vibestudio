import { Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Spinner } from "@/components/ui";
import TerminalsHost from "@/pages/terminals/TerminalsHost";
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

  return (
    <>
      <div style={{ display: onTerminals ? "none" : "contents" }}>
        <Suspense fallback={<div className="grid h-screen place-items-center"><Spinner /></div>}>
          <Outlet />
        </Suspense>
      </div>
      <TerminalsHost active={onTerminals} />
    </>
  );
}
