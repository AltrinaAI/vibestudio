"use client";

import { useEffect, useRef, useState } from "react";
import { skillKind } from "@/lib/agents";
import { useEditorStatus } from "@/lib/editorState";
import { useStudio } from "./StudioContext";
import * as api from "@/lib/api";

/**
 * Whether `rel` has changes worth reviewing against HEAD — i.e. it's a tracked
 * skill AND the file either differs on disk (git status) or has unsaved buffer
 * edits. Drives whether the "Review changes" toggle is shown at all. Re-checks
 * on git changes (commit/discard via gitVersion) and after each save.
 */
export function useReviewAvailable(root: string, rel: string): boolean {
  const { gitVersion } = useStudio();
  const { dirty, saving } = useEditorStatus();
  const [state, setState] = useState({ isRepo: false, changed: false });

  // Re-check once a save completes (its on-disk status may have flipped).
  const wasSaving = useRef(false);
  const [saveTick, setSaveTick] = useState(0);
  useEffect(() => {
    if (wasSaving.current && !saving) setSaveTick((t) => t + 1);
    wasSaving.current = saving;
  }, [saving]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await api.gitInfo(root);
        if (cancelled) return;
        // Reviewable when HEAD is a valid baseline: your own repo (any kind, as
        // before), or — matching the Source Control panel's personal-only gate — a
        // PERSONAL skill nested in a parent repo.
        const personal = skillKind(root).kind === "personal";
        if (!info.isRepo && !(info.inParentRepo && personal)) {
          setState({ isRepo: false, changed: false });
          return;
        }
        const st = await api.gitStatus(root);
        if (cancelled) return;
        setState({ isRepo: true, changed: st.some((f) => f.path === rel || f.origPath === rel) });
      } catch {
        if (!cancelled) setState({ isRepo: false, changed: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, rel, gitVersion, saveTick]);

  return state.isRepo && (state.changed || dirty);
}
