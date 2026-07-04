"use client";

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Spinner } from "@/components/ui";
import NavBar from "@/components/NavBar";
import { useAutosave } from "@/components/useAutosave";
import { useExternalFileSync } from "@/components/useExternalFileSync";
import { humanSize } from "@/lib/fileTypes";
import { addRecent } from "@/lib/recents";
import * as api from "@/lib/api";
import type { FileData } from "@/lib/types";

// The same live-preview markdown editor the skill pages use — reused as-is. It's
// skill-agnostic, so a loose file gets the full Obsidian-style rendering with no
// frontmatter form, validation, git review, or sidebar attached.
const LiveEditor = lazy(() => import("@/components/LiveEditor"));
const EditorFallback = () => <div className="px-8 py-6 text-sm text-muted">Loading editor…</div>;

// Split an absolute file path into its parent dir + basename. read-file sandboxes
// `rel` inside `root` (rejecting `..`/symlink escapes); with root = the file's own
// folder and rel = its bare basename there's nothing to escape, so a loose file is
// both reachable and safe. Tolerates a trailing slash and \-separators.
function splitPath(abs: string): { dir: string; name: string } {
  const trimmed = abs.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (i < 0) return { dir: ".", name: trimmed };
  return { dir: trimmed.slice(0, i) || "/", name: trimmed.slice(i + 1) };
}

/** Editor pane for one loose markdown file: wordless autosave straight to disk,
 *  matching the app's Notion-style save model. No git baseline/review — those are
 *  skill-only. Remounted per file (keyed by path), so local state resets cleanly. */
function MarkdownPane({ dir, name, file }: { dir: string; name: string; file: FileData }) {
  const editable = file.content != null && !file.tooLarge && !file.isBinary && file.category !== "image";
  const [content, setContent] = useState(file.content ?? "");
  // Compare-and-swap baseline: the tag we loaded, advanced on each successful write.
  // A stale write is refused (never clobbers a newer disk version); the autosave
  // failure indicator surfaces it — reopen to pull the latest. (Pane is keyed by
  // path, so the ref resets cleanly per file.)
  const etagRef = useRef(file.etag);
  const diskRef = useRef(file.content ?? "");
  const save = useCallback(
    async (value: string) => {
      const res = await api.writeFile(dir, name, value, etagRef.current);
      if (res.status === "written") {
        etagRef.current = res.etag;
        diskRef.current = value;
      } else {
        throw new Error("This file changed on disk — your edits aren’t saved. Reopen to get the latest version.");
      }
    },
    [dir, name],
  );
  const { markClean } = useAutosave(content, save, editable);

  // Show-latest: poll for external writes; swap in the latest only when the buffer is
  // clean (a dirty buffer is left for its next autosave's compare-and-swap). The
  // swapped-in version is adopted as the baseline so it isn't written straight back.
  const onExternalChange = useCallback(
    (fresh: FileData) => {
      if (fresh.content == null || !fresh.etag || content !== diskRef.current) return;
      etagRef.current = fresh.etag;
      diskRef.current = fresh.content;
      setContent(fresh.content);
      markClean(fresh.content);
    },
    [content, markClean],
  );
  useExternalFileSync(dir, name, editable, () => etagRef.current, onExternalChange);

  return (
    <div className="mx-auto max-w-208 px-6 py-8 sm:px-10">
      <div className="mb-5 flex items-center gap-3 text-xs text-muted">
        <span className="font-mono text-faint">{name}</span>
        <span>·</span>
        <span>{file.label}</span>
        <span>·</span>
        <span>{humanSize(file.size)}</span>
      </div>

      {file.tooLarge ? (
        <p className="py-6 text-sm text-muted">File is too large to display ({humanSize(file.size)}).</p>
      ) : file.isBinary || file.category === "image" ? (
        <p className="py-6 text-sm text-muted">Not a text file — preview not available.</p>
      ) : (
        <Suspense fallback={<EditorFallback />}>
          {/* Markdown gets the WYSIWYG renderer; a non-md path (deep-linked) still
              opens read/edit-able as plain code. */}
          <LiveEditor
            kind={file.category === "markdown" ? "markdown" : "code"}
            language={file.language}
            filename={name}
            value={content}
            onChange={setContent}
            placeholder="Write Markdown…"
            assets={{ root: dir, dir: "." }}
          />
        </Suspense>
      )}
    </div>
  );
}

/** `/markdown/:path` — open and edit an arbitrary markdown file by absolute path.
 *  The `reqRef` guard drops a stale read that resolves after a navigation. */
export function Component() {
  const abs = useParams().path ?? ""; // already decoded by the router — do NOT re-decode
  const { dir, name } = splitPath(abs);

  const [file, setFile] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const myReq = ++reqRef.current;
    setLoading(true);
    setError(null);
    setFile(null);
    (async () => {
      try {
        const fd = await api.readFile(dir, name);
        if (myReq !== reqRef.current) return;
        setFile(fd);
        addRecent({ root: abs, name, kind: "markdown" });
      } catch (e) {
        if (myReq !== reqRef.current) return;
        setError(e instanceof Error ? e.message : "Failed to read file");
      } finally {
        if (myReq === reqRef.current) setLoading(false);
      }
    })();
  }, [dir, name, abs]);

  return (
    <div className="flex min-h-dvh flex-col">
      <NavBar
        breadcrumb={
          <span className="truncate font-mono text-xs text-faint" title={abs}>
            {name}
          </span>
        }
      />
      <main className="flex-1">
        {loading ? (
          <div role="status" aria-live="polite" className="flex items-center justify-center py-20 text-muted">
            <Spinner /> <span className="ml-2">Loading…</span>
          </div>
        ) : error ? (
          <p className="px-8 py-8 text-sm text-danger">{error}</p>
        ) : file ? (
          <MarkdownPane key={abs} dir={dir} name={name} file={file} />
        ) : null}
      </main>
    </div>
  );
}
