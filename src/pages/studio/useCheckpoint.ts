"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { skillKind } from "@/lib/agents";
import { useEditorStatus } from "@/lib/editorState";
import { useStudio } from "./StudioContext";
import * as api from "@/lib/api";
import type { GitInfo } from "@/lib/api";

export interface Checkpoint {
  info: GitInfo | null;
  loaded: boolean;
  /** Versioning is possible for this skill (own skill, git available, not owned
   *  by a parent repo). When false, no Save button is shown. */
  possible: boolean;
  /** There's something new to capture as a version (uncommitted changes, or the
   *  skill isn't tracked yet so the first version can be made). */
  hasChanges: boolean;
  /** A commit is in flight. */
  saving: boolean;
  /** The last commit attempt's error, if any. */
  error: string | null;
  /** Capture the current on-disk state as a version with `message`. Initializes
   *  the repo first if needed. Resolves true on success; on success it refreshes
   *  git-derived UI (diff baselines + this hook's state). */
  commit: (message: string) => Promise<boolean>;
  refresh: () => void;
}

/**
 * Drives the "Save a version" affordance: loads the skill's git state, decides
 * whether a checkpoint is possible / has anything to capture, and commits.
 *
 * The user-facing word is "save", but a checkpoint is a git commit — autosave
 * already persists edits to disk continuously; this records a named version you
 * can diff against and return to.
 */
export function useCheckpoint(root: string): Checkpoint {
  const kind = skillKind(root).kind;
  const { gitVersion, bumpGit } = useStudio();
  const { saving: editorSaving } = useEditorStatus();
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reqRef = useRef(0);
  const refresh = useCallback(async () => {
    const myReq = ++reqRef.current;
    try {
      const i = await api.gitInfo(root);
      if (myReq === reqRef.current) setInfo(i);
    } catch {
      if (myReq === reqRef.current) setInfo(null);
    } finally {
      if (myReq === reqRef.current) setLoaded(true);
    }
  }, [root]);

  // Reload on mount, on the root changing, and whenever git changed elsewhere.
  useEffect(() => {
    void refresh();
  }, [refresh, gitVersion]);

  // When an autosave lands on disk (saving true → false), the working tree may
  // have gone dirty/clean — refresh so the Save button enables/disables in step.
  const wasSaving = useRef(false);
  useEffect(() => {
    if (wasSaving.current && !editorSaving) void refresh();
    wasSaving.current = editorSaving;
  }, [editorSaving, refresh]);

  const possible = !!info && info.available && kind === "personal" && !info.inParentRepo;
  const hasChanges = !!info && (!info.isRepo || info.dirty);

  const commit = useCallback(
    async (message: string) => {
      setSaving(true);
      setError(null);
      try {
        const cur = await api.gitInfo(root);
        if (!cur.isRepo) await api.gitInit(root); // first version: start tracking
        await api.gitCommit(root, message);
        // Bump gitVersion: refreshes the diff baselines (change indicators clear)
        // AND re-runs this hook's gitVersion effect, so its own state (dirty →
        // false) updates without a second explicit fetch.
        bumpGit();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn’t save this version");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [root, bumpGit],
  );

  return { info, loaded, possible, hasChanges, saving, error, commit, refresh };
}
