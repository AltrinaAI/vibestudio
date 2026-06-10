"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { Spinner } from "@/components/ui";
import { skillKind, isEditableBundledSkill, KIND_TAG } from "@/lib/agents";
import { useEditorStatus } from "@/lib/editorState";
import { useConfirm } from "@/components/useConfirm";
import { useStudio } from "./StudioContext";
import SaveVersionDialog from "./SaveVersionDialog";
import { GitHubSection } from "./GitHubSync";
import { studioPath, studioFilePath, studioCommitPath } from "@/lib/routes";
import * as api from "@/lib/api";
import type { GitInfo, GitCommit, GitFileChange } from "@/lib/api";

const KIND_BADGE: Record<string, { letter: string; cls: string }> = {
  added: { letter: "A", cls: "text-ok" },
  untracked: { letter: "U", cls: "text-ok" },
  modified: { letter: "M", cls: "text-warn" },
  typechange: { letter: "T", cls: "text-warn" },
  deleted: { letter: "D", cls: "text-danger" },
  unmerged: { letter: "!", cls: "text-danger" },
  renamed: { letter: "R", cls: "text-info" },
  copied: { letter: "C", cls: "text-info" },
};

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-4 text-xs leading-relaxed text-muted">{children}</p>;
}

/** VS Code-style collapsible section header: a chevron + title that toggles the
 *  body, with an optional count and trailing actions. The header stays visible
 *  whether or not the section is expanded. */
function PanelHeader({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="-ml-1 flex min-w-0 items-center gap-1 rounded px-1 text-muted transition-colors hover:text-fg"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        <span className="text-[0.68rem] font-semibold uppercase tracking-wider">{title}</span>
      </button>
      {count != null && count > 0 && <span className="text-[0.68rem] text-faint">{count}</span>}
      {children}
    </div>
  );
}

/** Thin draggable divider between sections (same pattern as the Sidebar's
 *  Files/Versions divider). When there's nothing resizable next to it, it
 *  renders as a plain separator line. */
function RowResizeHandle({ onDragTo, active }: { onDragTo: (clientY: number) => void; active: boolean }) {
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []); // tear down listeners if unmounted mid-drag
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => onDragTo(ev.clientY);
    const stop = () => {
      stopRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    stopRef.current = stop;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  if (!active) return <div className="h-px shrink-0 bg-border" />;
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      onPointerDown={start}
      title="Drag to resize"
      className="group relative h-px shrink-0 cursor-row-resize bg-border"
    >
      <div className="absolute inset-x-0 -top-1 -bottom-1 z-10" />
      <div className="absolute inset-x-0 top-0 h-px bg-transparent group-hover:bg-accent" />
    </div>
  );
}

/** VS Code-style Source Control panel: working-tree changes + commit history,
 *  living in the left sidebar. Clicking a changed file opens it with the inline
 *  diff overlay; clicking a commit opens its read-only diff in the main pane. */
export default function SourceControl({ root, dirName }: { root: string; dirName: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();
  const { reload, gitVersion, bumpGit, preview, enterVersion, keepVersion } = useStudio();
  const confirm = useConfirm();
  const kind = skillKind(root).kind;
  // Versioning is for skills that are yours to change: personal ones, plus the
  // editable bundled skills (skill-miner) — installed into your skills home and
  // meant to be tuned; a reinstall restores the official version as a diff.
  const versionable = kind === "personal" || isEditableBundledSkill(root);

  // The version being previewed stays highlighted in the list. The open file
  // (file route, or the index = SKILL.md) drives the New Changes highlight.
  const selectedSha = preview?.sha ?? null;
  const fileMatch = useMatch("/studio/:root/file/*");
  const indexMatch = useMatch("/studio/:root");
  const selectedRel = fileMatch?.params["*"] ?? (indexMatch ? "SKILL.md" : null);

  const [info, setInfo] = useState<GitInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [changes, setChanges] = useState<GitFileChange[]>([]);
  const [log, setLog] = useState<GitCommit[]>([]);

  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // VS Code-style accordion: each section collapses independently, but its header
  // stays visible — so the Remote panel is always reachable even under a long log.
  const [open, setOpen] = useState({ changes: true, versions: true, github: true });
  const toggle = (k: "changes" | "versions" | "github") => setOpen((o) => ({ ...o, [k]: !o[k] }));

  // Per-section resize: the dividers between sections drag like the Sidebar's
  // Files/Versions one (VS Code sashes). Until dragged (null), New Changes and
  // GitHub are content-sized up to a default cap — no blank space; after a drag
  // they hold the exact height the user set. Versions flexes into what's left.
  const containerRef = useRef<HTMLDivElement>(null);
  const [changesH, setChangesH] = useState<number | null>(null);
  const [githubH, setGithubH] = useState<number | null>(null);
  const dragChanges = useCallback((clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setChangesH(Math.max(80, Math.min(rect.height - 180, clientY - rect.top)));
  }, []);
  const dragGithub = useCallback((clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setGithubH(Math.max(100, Math.min(rect.height - 180, rect.bottom - clientY)));
  }, []);

  // "Save a version" (the deliberate checkpoint, a git commit) — moved here from
  // the top bar since it's a version action, not a file-level save.
  const [saveOpen, setSaveOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitErr, setCommitErr] = useState<string | null>(null);

  const refreshReq = useRef(0);
  const refresh = useCallback(async () => {
    const myReq = ++refreshReq.current; // drop a refresh superseded by a newer one
    setErr(null);
    try {
      const i = await api.gitInfo(root);
      if (myReq !== refreshReq.current) return;
      setInfo(i);
      // Working-tree changes are scoped to this folder for your own repo AND for a
      // skill nested in a parent repo. Commit history (the log) is only the
      // parent's to show, so we skip it there.
      if (i.isRepo || i.inParentRepo) {
        const [c, l] = await Promise.all([
          api.gitStatus(root).catch(() => [] as GitFileChange[]),
          i.isRepo ? api.gitLog(root, 100).catch(() => [] as GitCommit[]) : Promise.resolve([] as GitCommit[]),
        ]);
        if (myReq !== refreshReq.current) return;
        setChanges(c);
        setLog(l);
      } else {
        setChanges([]);
        setLog([]);
      }
    } catch (e) {
      if (myReq !== refreshReq.current) return;
      setErr(e instanceof Error ? e.message : "Failed to load git status");
    } finally {
      if (myReq === refreshReq.current) setLoaded(true);
    }
  }, [root]);

  useEffect(() => {
    setLoaded(false);
    void refresh();
  }, [refresh]);

  // Refresh silently (no loading flash) when git changed elsewhere — a checkpoint
  // from the top-bar Save, or a discard — so the change list + history stay live.
  useEffect(() => {
    void refresh();
  }, [gitVersion, refresh]);

  // Refresh the change list once an autosave completes (saving true → false), so
  // the panel reflects edits made in the editor without a manual refresh.
  const editor = useEditorStatus();
  const wasSaving = useRef(false);
  useEffect(() => {
    if (wasSaving.current && !editor.saving) void refresh();
    wasSaving.current = editor.saving;
  }, [editor.saving, refresh]);

  const startTracking = async () => {
    setBusy(true);
    setActionErr(null);
    try {
      await api.gitInit(root);
      await refresh();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Failed to start tracking");
    } finally {
      setBusy(false);
    }
  };

  const openChange = (f: GitFileChange) => {
    if (f.kind === "deleted") {
      navigate(studioCommitPath(root, "worktree")); // no buffer to edit → read-only view
      return;
    }
    const target = f.path === "SKILL.md" ? studioPath(root) : studioFilePath(root, f.path);
    // Already viewing this file → just flip on the overlay (a full navigate would
    // trip the unsaved-changes guard for the file you're about to review).
    if (location.pathname === target) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("diff", "worktree");
          return next;
        },
        { replace: true },
      );
    } else {
      navigate(`${target}?diff=worktree`);
    }
  };

  const discard = async (f: GitFileChange) => {
    if (busy) return;
    if (
      !(await confirm({
        title: "Discard changes?",
        body: `Discard changes to “${f.path}”. This can’t be undone.`,
        confirmLabel: "Discard",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setActionErr(null);
    try {
      await api.gitDiscard(root, f.path);
      await refresh();
      reload(); // the file changed on disk → reload the open editor so a later save can't un-discard
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Discard failed");
    } finally {
      setBusy(false);
    }
  };

  const discardAll = async () => {
    if (busy) return;
    if (
      !(await confirm({
        title: "Discard all changes?",
        body: "Discard ALL changes since the last commit. This can’t be undone.",
        confirmLabel: "Discard all",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setActionErr(null);
    try {
      await api.gitDiscardAll(root);
      await refresh();
      reload();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Discard failed");
    } finally {
      setBusy(false);
    }
  };

  const doCommit = useCallback(
    async (message: string) => {
      setCommitting(true);
      setCommitErr(null);
      try {
        if (preview) {
          // Editing a previewed version → land it as a NEW version on the branch
          // tip (linear history) and return to current. keepVersion reloads +
          // bumps diff baselines for us.
          await keepVersion(message);
        } else {
          await api.gitCommit(root, message);
          bumpGit(); // refresh open diff baselines so live change indicators clear
        }
        await refresh();
        return true;
      } catch (e) {
        setCommitErr(e instanceof Error ? e.message : "Couldn’t save this version");
        return false;
      } finally {
        setCommitting(false);
      }
    },
    [root, refresh, bumpGit, preview, keepVersion],
  );

  // There's a version to save when this is your own tracked repo with uncommitted
  // changes. ⌘S opens the dialog (a missing git identity is surfaced there).
  const canSaveVersion =
    !!info && info.available && info.isRepo && info.dirty && versionable && !info.inParentRepo;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault(); // never let the browser's Save-page dialog through
        if (canSaveVersion) setSaveOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSaveVersion]);

  // ---- guard states -------------------------------------------------------
  if (!loaded) {
    return (
      <p className="flex items-center gap-2 px-3 py-4 text-xs text-muted">
        <Spinner className="h-3.5 w-3.5" /> Checking…
      </p>
    );
  }
  if (err || !info) return <Notice>{err ?? "Couldn’t load version control."}</Notice>;
  if (!info.available) return <Notice>Git isn’t installed — install git to enable version history.</Notice>;
  if (!versionable)
    return (
      <Notice>
        Version history is for your own skills. This is a {KIND_TAG[kind].label.toLowerCase()} skill — use{" "}
        <span className="font-medium text-fg">Manage → Sync</span> to make an editable copy you can version.
      </Notice>
    );
  if (!info.isRepo && !info.inParentRepo)
    return (
      <div className="px-3 py-4">
        <p className="mb-3 text-xs text-muted">Not version-tracked yet. Start a history for this skill.</p>
        <button
          type="button"
          onClick={startTracking}
          disabled={busy}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "Starting…" : "Start tracking"}
        </button>
        {actionErr && <p className="mt-2 text-xs text-danger">{actionErr}</p>}
      </div>
    );

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {actionErr && <p className="px-3 pt-2 text-[0.7rem] text-danger">{actionErr}</p>}

      {/* New Changes — working-tree changes, scoped to this folder for your own repo
          AND for a skill nested in a parent repo. Header stays visible even when
          the tree is clean. Content-sized up to its adjustable cap. */}
      <section
        className="flex min-h-0 flex-col overflow-hidden"
        style={
          open.changes && changes.length > 0 && info.isRepo && (open.versions || open.github)
            ? changesH != null
              ? { height: changesH }
              : { maxHeight: 240 }
            : undefined
        }
      >
        <PanelHeader title="New Changes" count={changes.length} open={open.changes} onToggle={() => toggle("changes")}>
          {changes.length > 0 && (
            <button type="button" onClick={discardAll} disabled={busy} title="Discard all changes" className="ml-auto text-faint hover:text-danger disabled:opacity-40">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
        </PanelHeader>
        {open.changes &&
          (changes.length === 0 ? (
            <p className="px-3 pb-2 text-xs text-faint">No changes since your last version.</p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-auto">
              {changes.map((f) => {
                const badge = KIND_BADGE[f.kind] ?? { letter: "?", cls: "text-muted" };
                const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
                const name = f.path.slice(dir.length);
                const active = f.path === selectedRel;
                return (
                  <li key={f.path} className={`group flex items-center gap-2 border-l-2 px-3 py-1 ${active ? "border-accent hover:bg-surface" : "border-transparent hover:border-accent hover:bg-surface"}`}>
                    <button type="button" onClick={() => openChange(f)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                      <span className="min-w-0 flex-1 truncate text-xs" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
                        <span className={active ? "font-medium text-fg" : "text-fg"}>{name}</span>
                        {dir && <span className="text-faint"> {dir}</span>}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => discard(f)}
                      disabled={busy}
                      title="Discard changes"
                      className="shrink-0 text-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 disabled:opacity-40"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.7 3L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                    </button>
                    <span className={`shrink-0 font-mono text-xs font-bold ${badge.cls}`} title={f.kind}>
                      {badge.letter}
                    </span>
                  </li>
                );
              })}
            </ul>
          ))}

        {/* Save a version — the deliberate checkpoint that commits these changes.
            Your own repo only (a skill nested in a parent repo is versioned there).
            ⌘S opens the same dialog even while this section is collapsed. */}
        {open.changes && info.isRepo && changes.length > 0 && (
          <div className="shrink-0 px-3 pb-3 pt-2">
            <button
              type="button"
              onClick={() => setSaveOpen(true)}
              disabled={busy}
              title={
                !info.hasIdentity
                  ? "Set a git identity first"
                  : preview
                    ? "Save these edits as a new version (⌘S)"
                    : "Save a version (⌘S)"
              }
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-accent/50 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent-soft disabled:opacity-40"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {preview ? "Save as new version" : "Save version"}
            </button>
          </div>
        )}
      </section>

      {/* Versions (commit history) + GitHub (its remote) — your own repo only. A
          skill nested in a parent repo is versioned there, so we point to it. */}
      {info.isRepo ? (
        <>
          <RowResizeHandle
            onDragTo={dragChanges}
            active={open.changes && changes.length > 0 && (open.versions || open.github)}
          />
          <section className={`flex flex-col ${open.versions ? "min-h-0 flex-1" : "flex-none"}`}>
            <PanelHeader title="Versions" count={log.length} open={open.versions} onToggle={() => toggle("versions")} />
            {open.versions && (
              <div className="min-h-0 flex-1 overflow-auto">
                {log.length === 0 ? (
                  <p className="px-3 pb-3 text-xs text-faint">No versions yet.</p>
                ) : (
                  <ul className="pb-3">
                    {log.map((c) => {
                      const active = c.sha === selectedSha;
                      return (
                        <li key={c.sha}>
                          <button
                            type="button"
                            onClick={() => {
                              setActionErr(null);
                              enterVersion(c.sha, c.number).catch((e) =>
                                setActionErr(e instanceof Error ? e.message : "Couldn’t open that version"),
                              );
                            }}
                            className={`flex w-full flex-col gap-0.5 border-l-2 px-3 py-1.5 text-left ${
                              active ? "border-accent bg-accent-soft" : "border-transparent hover:border-accent hover:bg-surface"
                            }`}
                          >
                            <span className="truncate text-xs text-fg" title={c.message}>
                              {c.message}
                            </span>
                            <span className="flex items-center gap-1.5 text-[0.66rem] text-faint">
                              <span className="font-medium text-muted" title={c.short}>
                                Version {c.number}
                              </span>
                              <span className="truncate">· {c.author}</span>
                              <span className="ml-auto shrink-0" title={c.isoDate}>
                                {c.relativeDate}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>

          {/* Remote — the remote half of version history (publish / sync / disconnect),
              named platform-neutrally since GitHub is just one of several git hosts
              it connects to. Content-sized up to its adjustable cap while Versions is
              open; free to use the remaining space when Versions is collapsed. */}
          <RowResizeHandle onDragTo={dragGithub} active={open.github && open.versions} />
          <section
            className="flex min-h-0 flex-col overflow-hidden"
            style={
              open.github && open.versions
                ? githubH != null
                  ? { height: githubH }
                  : { maxHeight: 360 }
                : undefined
            }
          >
            <PanelHeader title="Remote" open={open.github} onToggle={() => toggle("github")} />
            {open.github && (
              <div className="min-h-0 flex-1 overflow-auto px-3 pb-3 pt-1">
                <GitHubSection root={root} dirName={dirName} />
              </div>
            )}
          </section>
        </>
      ) : (
        <Notice>
          {changes.length === 0 ? "No changes since the parent repository’s last commit. " : null}
          Tracked by a parent repository
          {info.toplevel ? <> (<span className="font-mono text-faint">{info.toplevel}</span>)</> : null}. Save
          versions there.
        </Notice>
      )}

      {saveOpen && (
        <SaveVersionDialog
          root={root}
          dirName={dirName}
          tracked={info.isRepo}
          hasIdentity={info.hasIdentity}
          saving={committing}
          error={commitErr}
          onCommit={doCommit}
          onClose={() => {
            setSaveOpen(false);
            setCommitErr(null);
          }}
        />
      )}
    </div>
  );
}
