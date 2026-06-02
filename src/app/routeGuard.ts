import { useEffect } from "react";
import { useBlocker } from "react-router-dom";
import { confirmDiscardIfDirty, consumeDiscardBypass, isEditorDirty } from "@/lib/editorState";

/**
 * App-wide unsaved-changes guard. Blocks ANY navigation — links, navigate(), and
 * browser back/forward — while the mounted editor is dirty, then prompts. Must be
 * mounted inside the data router (it lives in AppShell): useBlocker requires it.
 * Window close / full reload is covered separately by useManualSave's beforeunload.
 * The one-shot bypass (armDiscardBypass) lives in lib/editorState so pages can arm
 * it without depending on the app layer.
 */
export function useDiscardBlocker() {
  const blocker = useBlocker(() => {
    if (consumeDiscardBypass()) return false;
    return isEditorDirty();
  });
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (confirmDiscardIfDirty()) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
}
