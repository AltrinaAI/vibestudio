"use client";

// Post-save pipeline. Tasks that should run after a file in a skill is written
// to disk live here as `SaveHook`s; `runSaveHooks` executes the registered set.
// Today there's one hook (auto-detect the managed secrets a skill references and
// fold them into `metadata.required-env`), but the contract is the extension
// point — drop another `SaveHook` into `SAVE_HOOKS` and it runs on every save.

import { skillKind, type SkillKind } from "@/lib/agents";
import { requiredEnv, withRequiredEnv } from "@/lib/skill";
import * as api from "@/lib/api";
import type { SkillData } from "@/lib/types";

/** Describes the save that just landed on disk; handed to every hook. */
export interface SaveContext {
  /** Absolute skill root. */
  root: string;
  /** Skill provenance (personal / official / plugin). */
  kind: SkillKind;
  /** Relative path of the file just saved; null means the skill's SKILL.md.
   *  Unread by any hook today — provided for future per-file hooks (e.g. one
   *  that only runs when SKILL.md itself changed). */
  rel: string | null;
}

/** What a hook asks the host to apply after it runs. Most hooks return nothing;
 *  a hook that rewrites the skill on disk returns the reloaded data so the host
 *  can swap it into the live UI. New effect kinds get added here as hooks need
 *  them. */
export interface SaveEffect {
  /** Fresh skill data a hook reloaded (e.g. after rewriting SKILL.md). */
  reloaded?: SkillData;
}

/** A task that runs after a save. Register it in `SAVE_HOOKS`. Hooks are
 *  isolated: one that throws (or is slow) never blocks the save or its
 *  siblings. Gate a hook with `appliesTo` when it only fits some saves. */
export interface SaveHook {
  /** Stable id, used in diagnostics. */
  readonly name: string;
  /** Run only when this returns true (default: always). */
  appliesTo?(ctx: SaveContext): boolean;
  run(ctx: SaveContext): Promise<SaveEffect | void> | SaveEffect | void;
}

/**
 * Scan the skill's files for the managed secrets they reference and fold any new
 * names into `metadata.required-env`. Reads — and, only when something new is
 * found, rewrites — SKILL.md on disk, so it always works from the canonical
 * on-disk state and never clobbers a just-saved edit with stale in-memory data.
 *
 * Additive (never drops a manual entry) and only for our own skills — we own
 * that field but don't rewrite official/plugin skills. Returns the fresh skill
 * data plus whether it rewrote anything. Throws only if the skill can't be
 * loaded; a failed detect/rewrite is swallowed (best-effort).
 */
export async function reconcileRequiredEnv(root: string): Promise<{ data: SkillData; changed: boolean }> {
  const loaded = await api.loadSkill(root);
  // Self-guard on kind: this is called directly from the open path too (not only
  // via the hook's `appliesTo`), so it must re-check rather than rely on the gate.
  if (skillKind(loaded.root).kind !== "personal") return { data: loaded, changed: false };
  let found: string[];
  try {
    found = await api.detectRequiredEnv(loaded.root);
  } catch {
    return { data: loaded, changed: false };
  }
  const current = requiredEnv(loaded.frontmatter);
  const merged = Array.from(new Set([...current, ...found])).sort();
  if (merged.length === current.length) return { data: loaded, changed: false }; // nothing new
  try {
    await api.saveSkillMd(loaded.root, withRequiredEnv(loaded.frontmatter, merged), loaded.body);
    return { data: await api.loadSkill(loaded.root), changed: true };
  } catch {
    return { data: loaded, changed: false };
  }
}

const reconcileRequiredEnvHook: SaveHook = {
  name: "reconcile-required-env",
  appliesTo: (ctx) => ctx.kind === "personal",
  async run(ctx) {
    const { data, changed } = await reconcileRequiredEnv(ctx.root);
    if (changed) return { reloaded: data };
  },
};

/** The registered post-save pipeline. Add new save-time tasks here. */
export const SAVE_HOOKS: readonly SaveHook[] = [reconcileRequiredEnvHook];

/**
 * Run the post-save pipeline for one save. Applicable hooks run in registration
 * order, one after another — sequential on purpose, not concurrent: a hook may
 * rewrite SKILL.md on disk (read-modify-write), so a later hook must observe an
 * earlier hook's write instead of racing it and clobbering the update. Each hook
 * is isolated — one that throws is logged and skipped, never blocking the save
 * or the others. Returns the effects, in order, for the host to apply (so the
 * last reloaded data wins, which is the most recent on-disk state).
 */
export async function runSaveHooks(
  ctx: SaveContext,
  hooks: readonly SaveHook[] = SAVE_HOOKS,
): Promise<SaveEffect[]> {
  const effects: SaveEffect[] = [];
  for (const h of hooks) {
    if (!(h.appliesTo?.(ctx) ?? true)) continue;
    try {
      const effect = await h.run(ctx);
      if (effect) effects.push(effect);
    } catch (e) {
      console.error(`[save-hook:${h.name}] failed`, e);
    }
  }
  return effects;
}
