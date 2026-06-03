import { createContext, useContext } from "react";
import type { SkillData } from "@/lib/types";

export interface StudioContextValue {
  /** The loaded skill (always present for everything rendered under the layout). */
  data: SkillData;
  /** Bumped when `data` is replaced for the same root (a post-save hook rewrote
   *  SKILL.md) so the mount-initialized document editor remounts with fresh data. */
  docVersion: number;
  /** Bumped whenever git state changes from within the app (commit / discard) so
   *  open diff overlays refetch their HEAD baseline. */
  gitVersion: number;
  /** Bump gitVersion only — refresh diff baselines + git-derived panels after a
   *  checkpoint, WITHOUT re-reading the skill (content is unchanged by a commit,
   *  so this avoids a needless editor remount). */
  bumpGit: () => void;
  /** Run the post-save pipeline for the file just saved (rel=null => SKILL.md). */
  afterSave: (rel: string | null) => void;
  /** Re-read the skill from disk after an external content change (e.g. a discard
   *  reverted a file): refreshes `data`, bumps gitVersion, and remounts the editor
   *  (docVersion) unless it's mid-edit. */
  reload: () => void;
}

const SkillCtx = createContext<StudioContextValue | null>(null);
export const StudioProvider = SkillCtx.Provider;

export function useStudio(): StudioContextValue {
  const v = useContext(SkillCtx);
  if (!v) throw new Error("useStudio must be used within a StudioProvider");
  return v;
}

/** Display name: the frontmatter `name`, else the folder name. */
export function skillName(d: SkillData): string {
  return typeof d.frontmatter.name === "string" && d.frontmatter.name ? d.frontmatter.name : d.dirName;
}
