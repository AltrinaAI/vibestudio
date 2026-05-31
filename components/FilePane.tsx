"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { useManualSave } from "./useManualSave";
import { humanSize } from "@/lib/fileTypes";
import type { FileData } from "@/lib/types";

const LiveEditor = dynamic(() => import("./LiveEditor"), {
  ssr: false,
  loading: () => <div className="px-8 py-6 text-sm text-muted">Loading editor…</div>,
});

export default function FilePane({ root, file }: { root: string; file: FileData }) {
  const editable = file.content != null && !file.tooLarge && !file.isBinary && file.category !== "image";
  const [content, setContent] = useState(file.content ?? "");
  const baseName = file.rel.split("/").pop() ?? file.rel;
  const [imgError, setImgError] = useState(false);

  const save = useCallback(async () => {
    const res = await fetch("/api/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, rel: file.rel, content }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "Save failed");
    }
  }, [root, file.rel, content]);

  useManualSave(content, save, editable);

  return (
    <div className="mx-auto max-w-208 px-6 py-8 sm:px-10">
      <div className="mb-5 flex items-center gap-3 text-xs text-muted">
        <span className="font-mono text-faint">{file.rel}</span>
        <span>·</span>
        <span>{file.label}</span>
        <span>·</span>
        <span>{humanSize(file.size)}</span>
      </div>

      {file.category === "image" ? (
        <div className="flex justify-center py-6">
          {imgError ? (
            <div className="text-sm text-muted">Image could not be loaded — {baseName}</div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/raw?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(file.rel)}`}
              alt={baseName}
              onError={() => setImgError(true)}
              className="max-w-full rounded-lg border border-border"
            />
          )}
        </div>
      ) : file.tooLarge ? (
        <p className="py-6 text-sm text-muted">File is too large to display ({humanSize(file.size)}).</p>
      ) : file.isBinary ? (
        <p className="py-6 text-sm text-muted">Binary file ({humanSize(file.size)}) — preview not available.</p>
      ) : (
        <LiveEditor
          kind={file.category === "markdown" ? "markdown" : "code"}
          language={file.language}
          filename={baseName}
          value={content}
          onChange={setContent}
        />
      )}
    </div>
  );
}
