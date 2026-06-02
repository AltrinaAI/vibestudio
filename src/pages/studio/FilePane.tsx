"use client";

import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { useManualSave } from "./useManualSave";
import { humanSize } from "@/lib/fileTypes";
import * as api from "@/lib/api";
import type { FileData } from "@/lib/types";

const LiveEditor = lazy(() => import("./LiveEditor"));
const EditorFallback = () => <div className="px-8 py-6 text-sm text-muted">Loading editor…</div>;

export default function FilePane({ root, file, onSaved }: { root: string; file: FileData; onSaved?: () => void }) {
  const editable = file.content != null && !file.tooLarge && !file.isBinary && file.category !== "image";
  const [content, setContent] = useState(file.content ?? "");
  const baseName = file.rel.split("/").pop() ?? file.rel;

  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);
  useEffect(() => {
    if (file.category !== "image") return;
    let cancelled = false;
    api
      .imageDataUrl(root, file.rel)
      .then((url) => !cancelled && setImgSrc(url))
      .catch(() => !cancelled && setImgError(true));
    return () => {
      cancelled = true;
    };
  }, [root, file.rel, file.category]);

  const save = useCallback(async () => {
    await api.writeFile(root, file.rel, content);
  }, [root, file.rel, content]);

  useManualSave(content, save, editable, onSaved);

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
          ) : imgSrc ? (
            <img src={imgSrc} alt={baseName} className="max-w-full rounded-lg border border-border" />
          ) : (
            <div className="text-sm text-muted">Loading image…</div>
          )}
        </div>
      ) : file.tooLarge ? (
        <p className="py-6 text-sm text-muted">File is too large to display ({humanSize(file.size)}).</p>
      ) : file.isBinary ? (
        <p className="py-6 text-sm text-muted">Binary file ({humanSize(file.size)}) — preview not available.</p>
      ) : (
        <Suspense fallback={<EditorFallback />}>
          <LiveEditor
            kind={file.category === "markdown" ? "markdown" : "code"}
            language={file.language}
            filename={baseName}
            value={content}
            onChange={setContent}
          />
        </Suspense>
      )}
    </div>
  );
}
