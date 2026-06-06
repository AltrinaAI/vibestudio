import { createHashRouter, Navigate } from "react-router-dom";
import { studioPath } from "@/lib/routes";
import AppShell from "./AppShell";
import RootFallback from "./RootFallback";

// One-time deep-link promotion: a pre-hash `?path=/abs/skill` launch (the packaged
// app's deep link, which HashRouter ignores because it lives in location.search,
// before the `#`) becomes the hash route. Done here, at module load, so it runs
// before createHashRouter() below captures the current location.
try {
  const p = new URLSearchParams(window.location.search).get("path");
  if (p && !window.location.hash) window.location.hash = `#${studioPath(p)}`;
} catch {}

export const router = createHashRouter([
  {
    element: <AppShell />,
    HydrateFallback: RootFallback,
    children: [
      { index: true, lazy: () => import("@/pages/home/HomeRoute") },
      { path: "secrets", lazy: () => import("@/pages/secrets/SecretsRoute") },
      { path: "agents/:path", lazy: () => import("@/pages/agentmd/AgentMdRoute") },
      // The Terminals UI is the always-mounted host in AppShell; this route only
      // owns the URL/visibility, so its own element renders nothing.
      { path: "terminals", element: null },
      {
        path: "studio/:root",
        lazy: () => import("@/pages/studio/StudioRoute"),
        children: [
          { index: true, lazy: () => import("@/pages/studio/StudioIndexRoute") },
          { path: "file/*", lazy: () => import("@/pages/studio/StudioFileRoute") },
          { path: "commit/:sha", lazy: () => import("@/pages/studio/StudioCommitRoute") },
        ],
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
