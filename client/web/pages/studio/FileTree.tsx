"use client";

import { useState } from "react";
import type { TreeNode } from "@/lib/types";
import { FileIcon, FolderIcon } from "@/components/FileIcon";

const HOVER = "hover:bg-black/5 dark:hover:bg-white/6";

/** Hover-/focus-revealed trash action on a tree row. Absolutely positioned at the
 *  row's right edge so it never shifts the layout; the row reserves a little right
 *  padding (`pr-7`) so a long, truncated name can't slide under it. */
function TrashButton({
  node,
  onDelete,
}: {
  node: TreeNode;
  onDelete: (rel: string, isDir: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onDelete(node.rel, node.type === "dir");
      }}
      title={`Delete ${node.name}`}
      aria-label={`Delete ${node.name}`}
      className="absolute right-1 top-1/2 z-10 -translate-y-1/2 rounded p-1 text-faint opacity-0 transition hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    </button>
  );
}

function TreeItem({
  node,
  depth,
  selected,
  onSelect,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (rel: string) => void;
  onDelete: (rel: string, isDir: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const deletable = !node.isSkillMd; // SKILL.md is the skill's defining file — never offer to remove it
  const pad = deletable ? "pr-7" : "pr-2";
  const indent = { paddingLeft: `${depth * 14 + 8}px` };

  if (node.type === "dir") {
    return (
      <li>
        <div className={`group relative flex items-center rounded-md ${HOVER}`}>
          <button
            type="button"
            style={indent}
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            title={node.rel}
            className={`flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-sm text-fg ${pad}`}
          >
            <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}>
              <polyline points="9 6 15 12 9 18" />
            </svg>
            <FolderIcon open={open} name={node.name} />
            <span className="truncate font-medium">{node.name}</span>
          </button>
          {deletable && <TrashButton node={node} onDelete={onDelete} />}
        </div>
        {open && node.children && node.children.length > 0 && (
          <ul>
            {node.children.map((c) => (
              <TreeItem key={c.rel} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} onDelete={onDelete} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isSelected = selected === node.rel;
  return (
    <li>
      <div className={`group relative flex items-center rounded-md ${isSelected ? "bg-black/6 dark:bg-white/10" : HOVER}`}>
        <button
          type="button"
          style={indent}
          onClick={() => onSelect(node.rel)}
          title={node.rel}
          aria-current={isSelected ? "true" : undefined}
          className={`flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-sm ${pad} ${
            isSelected ? "font-medium text-fg" : "text-fg"
          }`}
        >
          <span className="w-3" />
          <FileIcon name={node.name} />
          <span className={`truncate ${node.isSkillMd ? "font-semibold" : ""}`}>{node.name}</span>
        </button>
        {deletable && <TrashButton node={node} onDelete={onDelete} />}
      </div>
    </li>
  );
}

export default function FileTree({
  nodes,
  selected,
  onSelect,
  onDelete,
}: {
  nodes: TreeNode[];
  selected: string | null;
  onSelect: (rel: string) => void;
  onDelete: (rel: string, isDir: boolean) => void;
}) {
  if (!nodes.length) {
    return <div className="px-3 py-2 text-sm text-muted">No files.</div>;
  }
  return (
    <ul className="px-1.5">
      {nodes.map((n) => (
        <TreeItem key={n.rel} node={n} depth={0} selected={selected} onSelect={onSelect} onDelete={onDelete} />
      ))}
    </ul>
  );
}
