"use client";

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Spinner } from "@/components/ui";
import * as api from "@/lib/api";
import type { GitWorktreeDiff } from "@/lib/api";
import DiffView from "./DiffView";
import { useStudio } from "./StudioContext";
import { studioPath } from "@/lib/routes";

/** `/studio/:root/commit/:sha` — now used only for `:sha === "worktree"`: the
 *  read-only diff of current uncommitted changes, reached when opening a DELETED
 *  file (which has no buffer to edit). Saved versions are no longer a separate,
 *  degraded view — they're checked out and shown through the FULL editor (see
 *  version preview), so a real commit SHA here just redirects to that. */
export function Component() {
  const { data } = useStudio();
  const root = data.root;
  const sha = useParams().sha ?? "";
  const isWorktree = sha === "worktree";
  const navigate = useNavigate();

  const [worktree, setWorktree] = useState<GitWorktreeDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    // A real version: viewing happens in place through the editor now → redirect.
    if (!isWorktree) {
      navigate(studioPath(root), { replace: true });
      return;
    }
    const myReq = ++reqRef.current;
    setLoading(true);
    setError(null);
    setWorktree(null);
    api
      .gitWorktreeDiff(root)
      .then((wt) => myReq === reqRef.current && setWorktree(wt))
      .catch((e) => myReq === reqRef.current && setError(e instanceof Error ? e.message : "Failed to load changes"))
      .finally(() => {
        if (myReq === reqRef.current) setLoading(false);
      });
  }, [root, sha, isWorktree, navigate]);

  if (!isWorktree) return null;
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Spinner /> <span className="ml-2">Loading changes…</span>
      </div>
    );
  }
  if (error) return <p className="px-8 py-8 text-sm text-danger">{error}</p>;

  return (
    <div className="mx-auto w-full max-w-300 px-6 py-8 sm:px-10">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-fg">Working tree changes</h2>
        <p className="mt-1 text-xs text-muted">
          {worktree && worktree.files.length > 0
            ? `${worktree.files.length} file${worktree.files.length === 1 ? "" : "s"} with uncommitted changes`
            : "No uncommitted changes."}
        </p>
      </div>
      <DiffView
        diff={worktree?.diff ?? ""}
        truncated={worktree?.truncated}
        emptyLabel="Working tree is clean — nothing to compare."
      />
    </div>
  );
}
