"use client";

import { useState } from "react";
import FileTree from "./FileTree";
import SourceControl from "./SourceControl";
import { SplitStack, StackSection, StackSash } from "@/components/SplitStack";
import { loadStudioLayout, saveStudioLayout } from "@/lib/studioLayout";
import type { SkillData } from "@/lib/types";

/** Left sidebar: Files on top, then the version-control sections (New Changes /
 *  Versions / Remote) — one SplitStack column (the VS Code SplitView model), so
 *  open sections size to exactly their content, sash drags track the pointer
 *  and cascade through neighbors, and pinned heights + collapse states persist
 *  across skills via studioLayout. */
export default function Sidebar({
  data,
  selected,
  onSelect,
  onDelete,
}: {
  data: SkillData;
  selected: string | null;
  onSelect: (rel: string) => void;
  onDelete: (rel: string, isDir: boolean) => void;
}) {
  const [filesH, setFilesH] = useState<number | null>(() => loadStudioLayout().filesH);

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col overflow-hidden border-r border-border bg-panel">
      <SplitStack className="min-h-0 flex-1">
        <StackSection
          id="files"
          order={0}
          open
          fill
          minBody={64}
          pin={filesH}
          header={
            <div className="px-4 pb-1 pt-3 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">
              Files
            </div>
          }
        >
          <FileTree nodes={data.tree} selected={selected} onSelect={onSelect} onDelete={onDelete} />
        </StackSection>
        <StackSash
          after="files"
          resize="files"
          onPin={(px) => {
            setFilesH(px);
            saveStudioLayout({ filesH: px });
          }}
        />
        <SourceControl root={data.root} dirName={data.dirName} />
      </SplitStack>
    </aside>
  );
}
