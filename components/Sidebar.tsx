"use client";

import FileTree from "./FileTree";
import ValidationPanel from "./ValidationPanel";
import { SectionLabel } from "./ui";
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
  const name = typeof data.frontmatter.name === "string" ? data.frontmatter.name : data.dirName;

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-border bg-surface">
      <div className="border-b border-border px-3 py-3">
        <div className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Skill</div>
        <div className="mt-0.5 truncate font-mono text-sm font-semibold text-fg" title={name}>
          {name}
        </div>
        <div className="mt-0.5 break-all text-[0.7rem] leading-snug text-muted" title={data.root}>
          {data.root}
        </div>
      </div>

      <div className="border-b border-border px-3 py-3">
        <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Validation</div>
        <ValidationPanel issues={data.validation} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto pb-2">
        <SectionLabel>Files</SectionLabel>
        <FileTree nodes={data.tree} selected={selected} onSelect={onSelect} />
      </div>
    </aside>
  );
}
