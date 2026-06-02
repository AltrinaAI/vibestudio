import SkillDocument from "./SkillDocument";
import { useStudio } from "./StudioContext";

/** Index child of `/studio/:root` — the SKILL.md document editor. The `key`
 *  (root + docVersion) remounts the mount-initialized editor when the skill
 *  changes or a post-save hook reloads it (but only when not mid-edit). */
export function Component() {
  const { data, docVersion, afterSave } = useStudio();
  return <SkillDocument key={`${data.root}:${docVersion}`} data={data} onSaved={() => afterSave(null)} />;
}
