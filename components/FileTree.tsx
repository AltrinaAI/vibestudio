"use client";

import { useState } from "react";
import type { TreeNode } from "@/lib/types";
import { humanSize } from "@/lib/fileTypes";

function TreeItem({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (rel: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const indent = { paddingLeft: `${depth * 14 + 8}px` };

  if (node.type === "dir") {
    return (
      <li>
        <button
          type="button"
          style={indent}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={node.rel}
          className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm text-fg hover:bg-panel"
        >
          <span aria-hidden className="w-3 text-muted">{open ? "▾" : "▸"}</span>
          <span aria-hidden>{open ? "📂" : "📁"}</span>
          <span className="truncate font-medium">{node.name}</span>
        </button>
        {open && node.children && node.children.length > 0 && (
          <ul>
            {node.children.map((c) => (
              <TreeItem key={c.rel} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isSelected = selected === node.rel;
  return (
    <li>
      <button
        type="button"
        style={indent}
        onClick={() => onSelect(node.rel)}
        title={node.rel}
        className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm ${
          isSelected ? "bg-accent-soft font-medium text-accent" : "text-fg hover:bg-panel"
        }`}
      >
        <span className="w-3" />
        <span aria-hidden>{node.isSkillMd ? "📘" : node.glyph}</span>
        <span className={`truncate ${node.isSkillMd ? "font-semibold" : ""}`}>{node.name}</span>
        {node.size != null && (
          <span className="ml-auto pl-2 text-[0.65rem] text-muted">{humanSize(node.size)}</span>
        )}
      </button>
    </li>
  );
}

export default function FileTree({
  nodes,
  selected,
  onSelect,
}: {
  nodes: TreeNode[];
  selected: string | null;
  onSelect: (rel: string) => void;
}) {
  if (!nodes.length) {
    return <div className="px-3 py-2 text-sm text-muted">No files.</div>;
  }
  return (
    <ul className="px-1.5">
      {nodes.map((n) => (
        <TreeItem key={n.rel} node={n} depth={0} selected={selected} onSelect={onSelect} />
      ))}
    </ul>
  );
}
