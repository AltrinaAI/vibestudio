"use client";

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAutosave } from "@/lib/useAutosave";
import { useStudio } from "./StudioContext";
import DiffView from "./DiffView";
import { skillKind } from "@/lib/agents";
import { humanSize } from "@/lib/fileTypes";
import * as api from "@/lib/api";
import type { FileData } from "@/lib/types";

const LiveEditor = lazy(() => import("@/components/LiveEditor"));
const EditorFallback = () => <div className="px-8 py-6 text-sm text-muted">Loading editor…</div>;

export default function FilePane({ root, file, onSaved }: { root: string; file: FileData; onSaved?: () => void }) {
  const { gitVersion } = useStudio();
  const editable = file.content != null && !file.tooLarge && !file.isBinary && file.category !== "image";
  // The in-editor WYSIWYG diff overlay is prose-only; other file types (code,
  // etc.) review via a plain read-only unified diff instead.
  const isMarkdown = file.category === "markdown";
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

  // --- Change tracking + review mode.
  // The HEAD baseline is fetched for EVERY tracked file (not just review) so the
  // editor can show live change indicators (overview ruler + left bars). Markdown
  // additionally gets the inline review overlay when ?diff=worktree is set; code
  // files review via a plain read-only diff (no editor) instead. ---
  const [searchParams] = useSearchParams();
  const reviewRequested = searchParams.get("diff") === "worktree";
  const codeReview = reviewRequested && editable && !isMarkdown; // read-only code diff (no editor)
  // The file's HEAD content (indicators baseline). undefined = not tracked / not
  // loaded; "" = a new/untracked file (whole buffer reads as added).
  const [baseline, setBaseline] = useState<string | undefined>(undefined);
  // For code review: the file's read-only worktree diff (git-computed).
  const [codeDiff, setCodeDiff] = useState<{ diff: string; truncated: boolean } | null>(null);

  const reqRef = useRef(0);
  useEffect(() => {
    // Bump first so exiting or switching invalidates any in-flight fetch.
    const myReq = ++reqRef.current;
    if (!editable) {
      setBaseline(undefined);
      setCodeDiff(null);
      return;
    }
    if (codeReview) {
      // Read-only code diff — no editor, so no baseline needed.
      setBaseline(undefined);
      api
        .gitWorktreeDiff(root)
        .then((wt) => myReq === reqRef.current && setCodeDiff({ diff: wt.diff, truncated: wt.truncated }))
        .catch(() => myReq === reqRef.current && setCodeDiff({ diff: "", truncated: false }));
      return;
    }
    // Normal editing (code or markdown) or markdown review → live indicators need
    // the HEAD baseline. Only for files git actually tracks (else "" would render
    // a non-repo file as all-added).
    setCodeDiff(null);
    api
      .gitInfo(root)
      .then((info) => {
        if (myReq !== reqRef.current) return;
        // HEAD baseline: your own repo (any kind), or a PERSONAL skill nested in a
        // parent repo — matching the Source Control panel's personal-only gate.
        const personal = skillKind(root).kind === "personal";
        if (!info.isRepo && !(info.inParentRepo && personal)) {
          setBaseline(undefined);
          return undefined;
        }
        return api.gitFileAt(root, "HEAD", file.rel).then((b) => {
          if (myReq === reqRef.current) setBaseline(b);
        });
      })
      .catch(() => myReq === reqRef.current && setBaseline(undefined));
  }, [codeReview, editable, root, file.rel, gitVersion]);

  const save = useCallback(async () => {
    await api.writeFile(root, file.rel, content);
  }, [root, file.rel, content]);

  useAutosave(content, save, editable, onSaved);

  const inDiff = reviewRequested && isMarkdown && baseline !== undefined; // markdown overlay active
  const isNewFile = inDiff && baseline === "";

  return (
    <div className="mx-auto max-w-208 px-6 py-8 sm:px-10">
      {inDiff && (
        <div className="mb-5 rounded-md border border-accent/30 bg-accent-soft px-3 py-2 text-xs text-muted">
          {isNewFile ? (
            <>New file — all lines are new since the last commit.</>
          ) : (
            <>
              Reviewing changes since the last commit. Hover a change for{" "}
              <span className="font-medium text-fg">Revert</span>; <kbd className="font-sans">F7</kbd> jumps to the next.
            </>
          )}
        </div>
      )}
      {codeReview && (
        <div className="mb-5 rounded-md border border-accent/30 bg-accent-soft px-3 py-2 text-xs text-muted">
          Changes since the last commit (read-only). Save edits first to see them here.
        </div>
      )}
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
      ) : codeReview ? (
        codeDiff ? (
          <DiffView diff={codeDiff.diff} truncated={codeDiff.truncated} only={file.rel} emptyLabel="No changes since the last commit." />
        ) : (
          <p className="py-6 text-sm text-muted">Loading diff…</p>
        )
      ) : (
        <Suspense fallback={<EditorFallback />}>
          <LiveEditor
            kind={isMarkdown ? "markdown" : "code"}
            language={file.language}
            filename={baseName}
            value={content}
            onChange={setContent}
            baseline={baseline}
            review={reviewRequested && isMarkdown}
          />
        </Suspense>
      )}
    </div>
  );
}
