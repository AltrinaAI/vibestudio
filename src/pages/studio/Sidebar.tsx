"use client";

import FileTree from "./FileTree";
import type { SkillData } from "@/lib/types";

export default function Sidebar({
  data,
  selected,
  onSelect,
}: {
  data: SkillData;
  selected: string | null;
  onSelect: (rel: string) => void;
}) {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col overflow-auto border-r border-border bg-panel">
      <div className="px-4 pb-1 pt-3 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">
        Files
      </div>
      <FileTree nodes={data.tree} selected={selected} onSelect={onSelect} />
    </aside>
  );
}
