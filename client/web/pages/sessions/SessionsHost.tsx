import { lazy, Suspense, useEffect, useState } from "react";
import { Spinner } from "@/components/ui";

// Lazy so the @xterm bundle only loads on the first Sessions visit; sticky so the
// live ptys survive navigation thereafter. Mounted once, then hidden via CSS — a
// route swap or unmount would detach/dispose every pty (see TerminalPane cleanup).
const SessionsWorkspace = lazy(() => import("@/components/SessionsWorkspace"));

export default function SessionsHost({ active }: { active: boolean }) {
  const [everVisited, setEverVisited] = useState(active);
  useEffect(() => {
    if (active) setEverVisited(true);
  }, [active]);

  if (!everVisited) return null; // don't pay the xterm cost until first visit
  // Kept alive via CSS, never unmounted: hidden with display:none when off
  // /sessions so the live ptys/xterm survive navigation (contents = no box).
  return (
    <div style={{ display: active ? "contents" : "none" }}>
      <Suspense fallback={<div className="grid h-dvh place-items-center"><Spinner /></div>}>
        <SessionsWorkspace visible={active} />
      </Suspense>
    </div>
  );
}
