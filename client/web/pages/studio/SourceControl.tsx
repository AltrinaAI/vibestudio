"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { Spinner } from "@/components/ui";
import { StackSection, StackSash } from "@/components/SplitStack";
import { skillKind, isEditableBundledSkill, KIND_TAG } from "@/lib/agents";
import { loadStudioLayout, saveStudioLayout } from "@/lib/studioLayout";
import { useEditorStatus } from "@/lib/editorState";
import { useConfirm } from "@/components/useConfirm";
import { useStudio } from "./StudioContext";
import SaveVersionDialog from "./SaveVersionDialog";
import { GitHubSection } from "./GitHubSync";
import { runGithubSync } from "@/lib/githubSync";
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

/** Guard/notice content in place of the git sections, as a stack section so
 *  the sidebar solver accounts for its height (Files absorbs the rest). */
function StatusSection({ children }: { children: React.ReactNode }) {
  return (
    <StackSection id="vc-status" order={1} open minBody={0}>
      {children}
    </StackSection>
  );
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

/** VS Code-style Source Control panel: working-tree changes + commit history,
 *  living in the left sidebar. Clicking a changed file opens it with the inline
 *  diff overlay; clicking a commit opens its read-only diff in the main pane.
 *  Renders its sections as direct flex children of the sidebar column (fragment
 *  root), so expanding one pushes the others instead of expanding in place. */
export default function SourceControl({
  root,
  dirName,
  onPinFiles,
}: {
  root: string;
  dirName: string;
  /** Persist the Files section height when the Files/SCM sash is dragged. */
  onPinFiles: (px: number) => void;
}) {
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
  const fileMatch = useMatch("/skills/:root/file/*");
  const indexMatch = useMatch("/skills/:root");
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
  // The collapse states persist across skills (studioLayout); Remote starts closed.
  const [open, setOpen] = useState(() => loadStudioLayout().open);
  const toggle = (k: "changes" | "versions" | "github") =>
    setOpen((o) => {
      const next = { ...o, [k]: !o[k] };
      saveStudioLayout({ open: next });
      return next;
    });

  // Pinned height for New Changes (set by dragging its sash; null = size to
  // content). The sash drag itself is the SplitStack's business; this just
  // remembers the result. Remote isn't pinnable — it always sizes to its own
  // content so expanding it reveals everything without a manual drag.
  const [changesH, setChangesH] = useState<number | null>(() => loadStudioLayout().changesH);

  // Quick-sync from the Versions header when a remote exists — the same action as
  // the Remote panel's "Sync now", shared via runGithubSync so they can't diverge.
  const [syncing, setSyncing] = useState(false);

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

  const syncRemote = async () => {
    if (syncing || busy) return;
    setSyncing(true);
    setActionErr(null);
    try {
      await runGithubSync(root, { reload, bumpGit });
      await refresh(); // reflect any pulled versions in the log right away
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
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
  // The Files/SCM boundary sash, rendered above every state that shows SCM
  // content. The untracked state renders nothing at all (no sash either), so an
  // opted-out skill shows just its file list with no empty version-control area.
  const sash = <StackSash after="files" resize="files" onPin={onPinFiles} />;

  if (!loaded) {
    return (
      <>
        {sash}
        <StatusSection>
          <p className="flex items-center gap-2 px-3 py-4 text-xs text-muted">
            <Spinner className="h-3.5 w-3.5" /> Checking…
          </p>
        </StatusSection>
      </>
    );
  }
  if (err || !info)
    return (
      <>
        {sash}
        <StatusSection>
          <Notice>{err ?? "Couldn’t load version control."}</Notice>
        </StatusSection>
      </>
    );
  if (!info.available)
    return (
      <>
        {sash}
        <StatusSection>
          <Notice>Git isn’t installed — install git to enable version history.</Notice>
        </StatusSection>
      </>
    );
  if (!versionable)
    return (
      <>
        {sash}
        <StatusSection>
          <Notice>
            Version history is for your own skills. This is a {KIND_TAG[kind].label.toLowerCase()} skill — use{" "}
            <span className="font-medium text-fg">Manage → Sync</span> to make an editable copy you can version.
          </Notice>
        </StatusSection>
      </>
    );
  // Untracked (opted out, or never tracked): skip the whole Source Control area.
  // Tracking is started/stopped from Manage → Version tracking instead.
  if (!info.isRepo && !info.inParentRepo) return null;

  return (
    <>
      {sash}
      {/* New Changes — working-tree changes, scoped to this folder for your own repo
          AND for a skill nested in a parent repo. Header stays visible even when
          the tree is clean. Content-sized (fully visible) until pinned by a drag. */}
      <StackSection
        id="changes"
        order={1}
        open={open.changes}
        minBody={28}
        pin={changes.length > 0 ? changesH : null}
        header={
          <>
            {actionErr && <p className="px-3 pt-2 text-[0.7rem] text-danger">{actionErr}</p>}
            <PanelHeader title="New Changes" count={changes.length} open={open.changes} onToggle={() => toggle("changes")}>
              {changes.length > 0 && (
                <button type="button" onClick={discardAll} disabled={busy} title="Discard all changes" className="ml-auto text-faint hover:text-danger disabled:opacity-40">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              )}
            </PanelHeader>
          </>
        }
        footer={
          /* Save a version — the deliberate checkpoint that commits these changes.
             Your own repo only (a skill nested in a parent repo is versioned there).
             Stays put below the scrolling list; ⌘S opens the same dialog even
             while this section is collapsed. */
          info.isRepo && changes.length > 0 ? (
            <div className="px-3 pb-3 pt-2">
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
          ) : undefined
        }
      >
        {changes.length === 0 ? (
          <p className="px-3 pb-2 text-xs text-faint">No changes since your last version.</p>
        ) : (
          <ul>
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
        )}
      </StackSection>

      {/* Versions (commit history) + GitHub (its remote) — your own repo only. A
          skill nested in a parent repo is versioned there, so we point to it. */}
      {info.isRepo ? (
        <>
          <StackSash
            after="changes"
            resize="changes"
            onPin={(px) => {
              setChangesH(px);
              saveStudioLayout({ changesH: px });
            }}
          />
          {/* Versions — the flexible list: it soaks up the leftover space and is
              the first to give way when a content-sized neighbor opens. */}
          <StackSection
            id="versions"
            order={2}
            open={open.versions}
            fill
            minBody={64}
            header={
              <PanelHeader title="Versions" count={log.length} open={open.versions} onToggle={() => toggle("versions")}>
                {/* Sync with the remote — shown only when one is connected, so the
                    everyday one-click sync doesn't require opening the Remote panel.
                    Same action as the Remote panel's "Sync now" (runGithubSync). */}
                {info.hasRemote && (
                  <button
                    type="button"
                    onClick={syncRemote}
                    disabled={syncing || busy}
                    title="Sync with the remote"
                    className="ml-auto text-faint hover:text-accent disabled:opacity-40"
                  >
                    <svg className={syncing ? "animate-spin" : ""} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                      <path d="M21 3v5h-5" />
                      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                      <path d="M3 21v-5h5" />
                    </svg>
                  </button>
                )}
              </PanelHeader>
            }
          >
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
          </StackSection>

          {/* Remote — the remote half of version history (publish / sync / disconnect),
              named platform-neutrally since GitHub is just one of several git hosts
              it connects to. Collapsed by default; opening it sizes to exactly its
              content, so the Versions list above gives way and the whole panel shows
              with no manual drag. It isn't pinnable (no sash above it): a content-
              sized footer the way VS Code reveals a collapsed SCM pane. */}
          <StackSection
            id="remote"
            order={3}
            open={open.github}
            minBody={48}
            bodyClassName="px-3 pb-3 pt-1"
            header={<PanelHeader title="Remote" open={open.github} onToggle={() => toggle("github")} />}
          >
            <GitHubSection root={root} dirName={dirName} />
          </StackSection>
        </>
      ) : (
        <StackSection id="vc-note" order={2} open minBody={0}>
          <Notice>
            {changes.length === 0 ? "No changes since the parent repository’s last commit. " : null}
            Tracked by a parent repository
            {info.toplevel ? <> (<span className="font-mono text-faint">{info.toplevel}</span>)</> : null}. Save
            versions there.
          </Notice>
        </StackSection>
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
    </>
  );
}
