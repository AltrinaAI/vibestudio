"use client";

import { useState } from "react";
import CodeView from "./CodeView";
import Markdown from "./Markdown";
import { Badge } from "./ui";
import type { FileData } from "@/lib/types";
import { humanSize } from "@/lib/fileTypes";

export default function FileView({
  file,
  root,
  onNavigate,
}: {
  file: FileData;
  root: string;
  onNavigate?: (rel: string) => void;
}) {
  // Parent passes key={file.rel}, so this remounts (and re-defaults) per file.
  const isMarkdown = file.category === "markdown";
  const [rendered, setRendered] = useState(isMarkdown);
  const [imgError, setImgError] = useState(false);
  const baseName = file.rel.split("/").pop() ?? file.rel;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-5 py-2.5">
        <span aria-hidden>{file.category === "image" ? "🖼️" : "📄"}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{file.rel}</span>
        <Badge tone="muted" className="shrink-0">{file.label}</Badge>
        <span className="shrink-0 text-xs text-muted">{humanSize(file.size)}</span>
        {isMarkdown && file.content != null && (
          <div className="flex shrink-0 overflow-hidden rounded-md border border-border text-xs">
            <button
              type="button"
              aria-pressed={rendered}
              onClick={() => setRendered(true)}
              className={`px-2.5 py-1 ${rendered ? "bg-accent font-semibold text-white" : "bg-surface text-muted hover:text-fg"}`}
            >
              Rendered
            </button>
            <button
              type="button"
              aria-pressed={!rendered}
              onClick={() => setRendered(false)}
              className={`px-2.5 py-1 ${!rendered ? "bg-accent font-semibold text-white" : "bg-surface text-muted hover:text-fg"}`}
            >
              Source
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {file.category === "image" ? (
          <div className="flex h-full items-center justify-center p-6">
            {imgError ? (
              <div className="text-sm text-muted">Image could not be loaded — {baseName}</div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/raw?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(file.rel)}`}
                alt={baseName}
                onError={() => setImgError(true)}
                className="max-h-full max-w-full rounded-lg border border-border"
              />
            )}
          </div>
        ) : file.tooLarge ? (
          <div className="p-8 text-sm text-muted">
            File is too large to display ({humanSize(file.size)}).
          </div>
        ) : file.isBinary ? (
          <div className="p-8 text-sm text-muted">
            Binary file ({humanSize(file.size)}) — preview not available.
          </div>
        ) : isMarkdown && rendered && file.content != null ? (
          <div className="mx-auto max-w-3xl px-6 py-6">
            <Markdown content={file.content} root={root} onNavigate={onNavigate} />
          </div>
        ) : file.content != null ? (
          <div className="p-4">
            <CodeView code={file.content} language={file.language} />
          </div>
        ) : (
          <div className="p-8 text-sm text-muted">No preview available.</div>
        )}
      </div>
    </div>
  );
}
