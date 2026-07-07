// App-wide discovered-skills cache: one module-level store the home page reads
// from two places (the "Skills" stat card and the embedded gallery), so a scan
// runs ONCE per visit instead of once per component, and — the point of this
// module — its results survive unmount. A revisit paints the last-known skills
// instantly and rescans in the background, instead of blanking to a spinner and
// repopulating every time. Same external-store idiom as lib/mining.ts / lib/sessions.ts.
import { useSyncExternalStore } from "react";
import * as api from "@/lib/api";
import type { AgentSkills } from "@/lib/api";

// A mount-driven background refresh is skipped when the cache is fresher than
// this — coalescing already dedups a same-tick mount storm; this also spares a
// redundant scan on a quick bounce back to home. An explicit refreshSkills()
// (after accept/discard/delete/mining) always runs regardless.
const STALE_MS = 2000;

const nowMs = () => Date.now();

export interface SkillsSnap {
  groups: AgentSkills[];
  /** Roots with uncommitted changes (fills in just after `groups`, one batch call). */
  dirtyRoots: Set<string>;
  /** True only until the FIRST successful scan lands — drives the cold-start
   *  spinner. False forever after, so revisits show the cache, never a blank. */
  loading: boolean;
  /** A scan is in flight (cold OR background) — drives the small header spinner
   *  without blanking the grid. */
  scanning: boolean;
  /** Total skills across groups (incl. proposed drafts) — the stat card's value. */
  total: number;
}

// ─── store state ───
let groups: AgentSkills[] = [];
let dirtyRoots: Set<string> = new Set();
let loading = true;
let scanning = false;
let fetchedAt = 0;
const listeners = new Set<() => void>();

// Coalesce concurrent scans into one, with a single trailing rescan (sessions.ts
// pattern): a mount storm, or an action firing mid-scan, still lands exactly one
// fresh pass. This serialization is also why no epoch guard is needed — a scan
// (discover + its dirty wave) fully completes before the next begins, so a slow
// one can't clobber a newer one's results.
let inflight: Promise<void> | null = null;
let queued = false;

let snap: SkillsSnap = { groups, dirtyRoots, loading, scanning, total: 0 };

function rebuild() {
  const total = groups.reduce((n, g) => n + g.skills.length, 0);
  snap = { groups, dirtyRoots, loading, scanning, total };
  for (const l of listeners) l();
}

/** Rescan now. Shows the cached groups throughout (never blanks after the first
 *  load); swaps in fresh results — then the dirty badges — when they land. */
export function refreshSkills(): Promise<void> {
  if (inflight) {
    queued = true;
    return inflight;
  }
  scanning = true;
  rebuild();
  inflight = (async () => {
    try {
      const g = await api.discoverSkills();
      groups = g;
      loading = false;
      fetchedAt = nowMs();
      rebuild();
      // Dirty flags — one batch call, awaited so the next queued scan sees a
      // settled state. Proposed drafts sit in a staging dir that isn't a repo, so
      // they're never dirty and are excluded.
      const roots = g.flatMap((gr) => gr.skills.filter((s) => !s.proposed).map((s) => s.root));
      try {
        const states = await api.gitDirtyMany(roots);
        dirtyRoots = new Set(states.filter((d) => d.dirty).map((d) => d.root));
      } catch {
        /* dirty badges are best-effort */
      }
    } catch {
      /* keep whatever was already cached if a rescan fails */
    } finally {
      inflight = null;
      scanning = false;
      rebuild();
      if (queued) {
        queued = false;
        void refreshSkills();
      }
    }
  })();
  return inflight;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  // Paint the cache immediately; refresh in the background. The cold start (no
  // scan yet) shows the spinner via loading=true; a fresh-enough cache skips the
  // redundant rescan (coalescing handles a same-tick double-mount).
  if (!inflight && nowMs() - fetchedAt >= STALE_MS) void refreshSkills();
  return () => {
    listeners.delete(fn);
  };
}

/** The cached discovered skills; the home page's stat card and gallery share it.
 *  Reads the last result instantly on revisit while a background rescan runs. */
export function useSkills(): SkillsSnap {
  return useSyncExternalStore(subscribe, () => snap, () => snap);
}
