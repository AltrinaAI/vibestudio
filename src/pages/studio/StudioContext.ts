import { createContext, useContext } from "react";
import type { SkillData } from "@/lib/types";

export interface StudioContextValue {
  /** The loaded skill (always present for everything rendered under the layout). */
  data: SkillData;
  /** Bumped when `data` is replaced for the same root (a post-save hook rewrote
   *  SKILL.md) so the mount-initialized document editor remounts with fresh data. */
  docVersion: number;
  /** Run the post-save pipeline for the file just saved (rel=null => SKILL.md). */
  afterSave: (rel: string | null) => Promise<void>;
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
