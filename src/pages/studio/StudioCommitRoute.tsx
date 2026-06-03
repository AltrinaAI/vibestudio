"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Spinner } from "@/components/ui";
import * as api from "@/lib/api";
import type { GitCommitDetail, GitWorktreeDiff } from "@/lib/api";
import DiffView from "./DiffView";
import { useStudio } from "./StudioContext";

/** `/studio/:root/commit/:sha` — view a saved version. `:sha` is a commit SHA, or
 *  the literal "worktree" for current uncommitted changes (shown as a read-only
 *  diff). For a real version it defaults to the FULL skill content at that commit
 *  (browse files), with a toggle to the diff of what that version changed. */
export function Component() {
  const { data } = useStudio();
  const root = data.root;
  const sha = useParams().sha ?? "";
  const isWorktree = sha === "worktree";

  const [commit, setCommit] = useState<GitCommitDetail | null>(null);
  const [worktree, setWorktree] = useState<GitWorktreeDiff | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"full" | "changes">("full");

  const reqRef = useRef(0);
  useEffect(() => {
    const myReq = ++reqRef.current;
    setLoading(true);
    setError(null);
    setCommit(null);
    setWorktree(null);
    setFiles([]);
    setMode("full"); // default to the full version each time a version is opened
    (async () => {
      try {
        if (isWorktree) {
          const wt = await api.gitWorktreeDiff(root);
          if (myReq !== reqRef.current) return;
          setWorktree(wt);
        } else {
          const [d, fs] = await Promise.all([
            api.gitCommitDiff(root, sha),
            api.gitFilesAt(root, sha).catch(() => [] as string[]),
          ]);
          if (myReq !== reqRef.current) return;
          setCommit(d);
          setFiles(fs);
        }
      } catch (e) {
        if (myReq !== reqRef.current) return;
        setError(e instanceof Error ? e.message : "Failed to load version");
      } finally {
        if (myReq === reqRef.current) setLoading(false);
      }
    })();
  }, [root, sha, isWorktree]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Spinner /> <span className="ml-2">Loading version…</span>
      </div>
    );
  }
  if (error) return <p className="px-8 py-8 text-sm text-danger">{error}</p>;

  // Working tree = the current uncommitted state; show it as a read-only diff
  // (its full content is just the live editor, so there's no "version" to browse).
  if (isWorktree) {
    return (
      <div className="mx-auto w-full max-w-300 px-6 py-8 sm:px-10">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-fg">Working tree changes</h2>
          <p className="mt-1 text-xs text-muted">
            {worktree && worktree.files.length > 0
              ? `${worktree.files.length} file${worktree.files.length === 1 ? "" : "s"} with uncommitted changes`
              : "No uncommitted changes."}
          </p>
        </div>
        <DiffView
          diff={worktree?.diff ?? ""}
          truncated={worktree?.truncated}
          emptyLabel="Working tree is clean — nothing to compare."
        />
      </div>
    );
  }

  if (!commit) return null;

  return (
    <div className="mx-auto w-full max-w-300 px-6 py-8 sm:px-10">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="text-sm font-semibold text-fg">Version {commit.number}</h2>
            <span className="truncate text-sm text-muted">{commit.subject}</span>
          </div>
          {commit.body && <pre className="mt-1.5 whitespace-pre-wrap font-sans text-xs text-muted">{commit.body}</pre>}
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-faint">
            <code className="font-mono text-muted">{commit.short}</code>
            <span>·</span>
            <span>{commit.author}</span>
            <span>·</span>
            <span title={commit.isoDate}>{commit.relativeDate}</span>
          </p>
        </div>
        {/* Full version (browse files at this commit) vs the diff it introduced. */}
        <div className="flex shrink-0 rounded-md border border-border p-0.5 text-xs">
          {([
            ["full", "Full version"],
            ["changes", "Changes"],
          ] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded px-2 py-0.5 transition-colors ${
                mode === m ? "bg-fg text-app" : "text-muted hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === "changes" ? (
        <DiffView diff={commit.diff} truncated={commit.truncated} emptyLabel="This version has no file changes." />
      ) : (
        <VersionFiles root={root} sha={sha} files={files} />
      )}
    </div>
  );
}

/** The full skill content at a commit: a file picker (SKILL.md first) + the
 *  selected file's read-only content as it was in that version. */
function VersionFiles({ root, sha, files }: { root: string; sha: string; files: string[] }) {
  const pick = (fs: string[]) => (fs.includes("SKILL.md") ? "SKILL.md" : (fs[0] ?? ""));
  const [selected, setSelected] = useState(() => pick(files));
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  // Reset the selection when the version (file list) changes.
  useEffect(() => {
    setSelected(pick(files));
  }, [files]);

  useEffect(() => {
    if (!selected) {
      setContent(null);
      return;
    }
    const myReq = ++reqRef.current;
    setLoading(true);
    api
      .gitFileAt(root, sha, selected)
      .then((c) => myReq === reqRef.current && setContent(c))
      .catch(() => myReq === reqRef.current && setContent(""))
      .finally(() => {
        if (myReq === reqRef.current) setLoading(false);
      });
  }, [root, sha, selected]);

  if (files.length === 0) {
    return <p className="px-1 py-6 text-center text-sm text-muted">No files in this version.</p>;
  }

  // Lossy UTF-8 decode leaves U+FFFD on invalid bytes → treat as binary.
  const isBinary = content != null && content.includes("\uFFFD");

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {files.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setSelected(f)}
            className={`rounded-md px-2 py-1 font-mono text-xs transition-colors ${
              selected === f ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel hover:text-fg"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="py-6 text-sm text-muted">Loading…</p>
      ) : content === null ? null : content === "" ? (
        <p className="py-6 text-sm text-muted">Empty file.</p>
      ) : isBinary ? (
        <p className="py-6 text-sm text-muted">Binary file — preview not available.</p>
      ) : (
        <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-4 font-mono text-[0.82rem] leading-relaxed text-fg">
          {content}
        </pre>
      )}
    </div>
  );
}
