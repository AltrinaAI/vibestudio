import { useEffect } from "react";
import { useBlocker } from "react-router-dom";
import { confirmLeaveUnsaved, consumeDiscardBypass, hasSaveError } from "@/lib/editorState";

/**
 * App-wide guard for the rare case where an autosave FAILED — navigating away
 * would drop the un-persisted edit, so we prompt. Normal edits never block:
 * autosave persists them (and flushes the final buffer on unmount), so links,
 * navigate(), and back/forward all just work. Must be mounted inside the data
 * router (it lives in AppShell): useBlocker requires it. Window close / full
 * reload is covered separately by useAutosave's beforeunload. The one-shot bypass
 * (armDiscardBypass) lives in lib/editorState so pages can arm it without
 * depending on the app layer.
 */
export function useDiscardBlocker() {
  const blocker = useBlocker(() => {
    if (consumeDiscardBypass()) return false;
    return hasSaveError();
  });
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (confirmLeaveUnsaved()) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
}
