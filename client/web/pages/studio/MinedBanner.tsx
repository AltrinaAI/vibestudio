"use client";

import { useSearchParams } from "react-router-dom";
import { useMining } from "@/lib/mining";
import { useStudio } from "./StudioContext";

/**
 * Shown when the open skill carries uncommitted changes a mining run made
 * (clean at run start, dirty now). The changes are ordinary worktree edits, so
 * the whole existing review machinery applies: inline diff, per-chunk revert,
 * Save version. The banner self-clears the moment they're committed or
 * discarded — the dirty-diff that drives it goes away.
 */
export default function MinedBanner() {
  const { data } = useStudio();
  const mining = useMining();
  const [searchParams, setSearchParams] = useSearchParams();
  if (!mining?.improved?.includes(data.root)) return null;

  const reviewing = searchParams.get("diff") === "worktree";
  const review = () =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("diff", "worktree");
        return next;
      },
      { replace: true },
    );

  return (
    <div className="flex items-center gap-2.5 border-b border-[color-mix(in_srgb,var(--info)_30%,transparent)] bg-[color-mix(in_srgb,var(--info)_10%,transparent)] px-4 py-1.5 text-xs">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-info" aria-hidden>
        <path d="M14.531 12.469 6.619 20.38a1 1 0 1 1-3-3l7.912-7.912" />
        <path d="M15.686 4.314A12.5 12.5 0 0 0 5.461 2.958 1 1 0 0 0 5.58 4.71a22 22 0 0 1 6.318 3.393" />
        <path d="M17.7 3.7a1 1 0 0 0-1.4 0l-4.6 4.6a1 1 0 0 0 0 1.4l2.6 2.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z" />
        <path d="M19.686 8.314a12.5 12.5 0 0 1 1.356 10.225 1 1 0 0 1-1.751-.119 22 22 0 0 0-3.393-6.319" />
      </svg>
      <span className="font-semibold text-fg">Skill mining proposed these changes</span>
      <span className="hidden text-muted md:inline">
        — review them, then save a version to keep or discard what you don’t want.
      </span>
      {!reviewing && (
        <button
          type="button"
          onClick={review}
          className="ml-auto shrink-0 rounded-md border border-[color-mix(in_srgb,var(--info)_40%,transparent)] bg-app/40 px-2.5 py-1 font-medium text-info transition-colors hover:bg-app"
        >
          Review changes
        </button>
      )}
    </div>
  );
}
