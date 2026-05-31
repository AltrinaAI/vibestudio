import SkillApp from "@/components/SkillApp";
import { loadSkill } from "@/lib/server";
import type { SkillData } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ path?: string }>;
}) {
  const sp = await searchParams;
  const initialPath = sp.path ?? process.env.SKILL_PATH ?? "";

  let initialData: SkillData | null = null;
  let initialError: string | null = null;
  if (initialPath) {
    try {
      initialData = await loadSkill(initialPath);
    } catch (e) {
      initialError = e instanceof Error ? e.message : "Failed to load skill";
    }
  }

  return <SkillApp initialPath={initialPath} initialData={initialData} initialError={initialError} />;
}
