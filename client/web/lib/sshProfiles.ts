// Saved-SSH-connection loader (mobile). Kept out of the connection components file
// so fast-refresh stays happy (component files export only components).
import { useCallback, useEffect, useState } from "react";
import * as api from "@/lib/api";

/** Tri-state loader for saved connections. `undefined` = probe in flight; `null` =
 *  no credential store (desktop 404 — the RemoteMenu falls back to its ssh-config
 *  UI); an array = the mobile app. A non-404 store error (e.g. a corrupt profile
 *  file → 400) surfaces `loadError` but keeps the mobile UI (empty list + add form),
 *  never the dead-end desktop form. */
export function useSshProfiles() {
  const [profiles, setProfiles] = useState<api.SshProfile[] | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const p = await api.sshProfiles(); // null on 404 (no store), array otherwise
      setProfiles(p);
      setLoadError(null);
    } catch (e) {
      const st = (e as { status?: number } | null)?.status;
      if (st && st !== 404) {
        setProfiles((prev) => (Array.isArray(prev) ? prev : []));
        setLoadError(e instanceof Error ? e.message : "Couldn't read saved connections.");
      } else {
        setProfiles((prev) => prev ?? null); // transport error → leave as-is
      }
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { profiles, reload, loadError, setLoadError };
}
