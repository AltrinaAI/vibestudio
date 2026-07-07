import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { ReviewToggleContext } from "@/components/reviewContext";
import { skillKind } from "@/lib/agents";
import { requiredEnv } from "@/lib/skill";
import * as api from "@/lib/api";
import { useConfirm } from "@/components/useConfirm";
import { armDiscardBypass, holdAutosave, releaseAutosave } from "@/lib/editorState";
import TopBar from "./TopBar";
import Sidebar from "./Sidebar";
import PreviewBanner from "./PreviewBanner";
import AgentPanel from "./AgentPanel";
import { useMining } from "@/lib/mining";
import DiffOverlays from "./DiffOverlays";
import ManagePanel from "./ManagePanel";
import ExportDialog from "./ExportDialog";
import ExportedDialog from "./ExportedDialog";
import { useStudio, skillName } from "./StudioContext";
import { useReviewAvailable } from "./useReviewAvailable";
import { studioFilePath, studioPath } from "@/lib/routes";

/**
 * The skill workbench chrome: top bar + file sidebar + the routed file pane
 * (Outlet), plus the Manage / Export overlays. Navigation drives which file is
 * shown; edits autosave (so navigating away just persists them), and the guard in
 * AppShell only intervenes if an autosave actually failed.
 */
export default function StudioLayout() {
  const { data, reload, preview } = useStudio();
  const navigate = useNavigate();
  const confirm = useConfirm();

  // GitHub-connected skills treat the remote as the source of truth: on open,
  // quietly fast-forward to it in the background (the server no-ops fast when
  // the skill has no remote, and never touches diverged or locally-edited
  // state). A successful pull changed the files on disk — reload the editor.
  useEffect(() => {
    let stale = false;
    api
      .githubAutoPull(data.root)
      .then((r) => {
        if (!stale && r.pulled > 0) reload(true);
      })
      .catch(() => {}); // offline / no remote — nothing to do
    return () => {
      stale = true;
    };
  }, [data.root, reload]);
  // Which file is open: the `file/*` splat, else SKILL.md (the index route).
  // useMatch resolves against the current location, so it works here above the
  // Outlet (the splat param isn't visible to this parent via useParams). On the
  // History route no file is open, so nothing in the sidebar is highlighted.
  const onCommitRoute = useMatch("/skills/:root/commit/:sha") != null;
  const fileRel = useMatch("/skills/:root/file/*")?.params["*"];
  const selected = onCommitRoute ? null : fileRel || "SKILL.md";

  // "Review change mode" toggle (in the nav bar): on for the open file when it
  // has changes to review. The diff overlay is driven by the ?diff=worktree query.
  const [searchParams, setSearchParams] = useSearchParams();
  const reviewMode = searchParams.get("diff") === "worktree";
  const reviewAvailable = useReviewAvailable(data.root, selected ?? "SKILL.md");
  // While viewing a past version there's always something to review — the changes
  // that version introduced (it vs the previous version) — so offer the toggle
  // even though the working tree itself is clean (it equals the detached HEAD).
  const showReview = selected != null && (reviewMode || reviewAvailable || preview != null);
  const toggleReview = useCallback(
    () =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (next.get("diff") === "worktree") next.delete("diff");
          else next.set("diff", "worktree");
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );

  const [manageOpen, setManageOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Set once an export succeeds → the "Skill exported" confirmation (the only
  // signal on desktop, where the webview saves to Downloads with no UI).
  const [exported, setExported] = useState<{ dirName: string; path: string | null } | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

  // Phone-narrow layouts trade the fixed sidebar column for an overlay drawer,
  // toggled from the top bar. Measured on the layout root, not the viewport
  // (same pattern as SessionsWorkspace), so any embedding adapts as it resizes.
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth > 0 && el.clientWidth < 640));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!narrow) setSidebarOpen(false);
  }, [narrow]);

  // The side-panel agent conversation. Proposed skills (staged under
  // generated-skills/) open with the panel already showing — the conversation
  // that proposed them is the natural companion for reviewing. Manual close is
  // respected for the rest of the visit (the ref gates the auto-open to once
  // per mount).
  const [agentOpen, setAgentOpen] = useState(false);
  const mining = useMining();
  const autoOpenedAgent = useRef(false);
  useEffect(() => {
    if (autoOpenedAgent.current || !mining?.terminalId) return;
    if (data.root.includes("/generated-skills/")) {
      autoOpenedAgent.current = true;
      setAgentOpen(true);
    }
  }, [mining, data.root]);

  const onSelect = (rel: string) => {
    setSidebarOpen(false); // a drawer tap always dismisses, even re-selecting the open file
    if (rel === selected) return; // no-op re-select; avoid a spurious discard prompt
    navigate(rel === "SKILL.md" ? studioPath(data.root) : studioFilePath(data.root, rel));
  };

  // Delete a file or folder from the file tree. Destructive, so it's confirmed.
  // When the open file is the target (or sits inside a deleted folder) we must
  // stop its mounted editor from flushing its dying buffer back to disk and
  // recreating the file — hold autosave across the delete + the drop back to
  // SKILL.md (same guard the version-preview transitions use), then refresh the
  // tree. A tracked file's deletion lands as a pending change (recoverable via
  // version history); an untracked one is gone for good.
  const onDelete = async (rel: string, isDir: boolean) => {
    const name = rel.split("/").pop() ?? rel;
    if (
      !(await confirm({
        title: isDir ? `Delete folder “${name}”?` : `Delete “${name}”?`,
        body: isDir
          ? "This permanently removes the folder and everything inside it from disk."
          : "This permanently removes the file from disk.",
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;

    const affectsOpen = selected != null && (selected === rel || (isDir && selected.startsWith(`${rel}/`)));
    if (affectsOpen) {
      holdAutosave(); // suppress the dying editor's unmount-flush (would recreate the file)
      armDiscardBypass(); // and don't prompt about its now-moot buffer on the way out
    }
    try {
      await api.deleteFile(data.root, rel);
    } catch (e) {
      if (affectsOpen) releaseAutosave();
      await confirm({
        title: "Couldn’t delete",
        body: e instanceof Error ? e.message : "Delete failed.",
        confirmLabel: "OK",
      });
      return;
    }
    if (affectsOpen) {
      navigate(studioPath(data.root));
      setTimeout(releaseAutosave, 0); // after the old editor has unmounted held
    }
    reload();
  };

  // Skills with no declared env package in one click; otherwise the dialog
  // surfaces the bundle-secrets option and the not-bundled warning. A failed
  // package (e.g. the validate gate rejecting bad frontmatter) is shown inline.
  const onExport = async () => {
    if (requiredEnv(data.frontmatter).length > 0) {
      setExportOpen(true);
      return;
    }
    try {
      const { path } = await api.exportSkill(data.root);
      setExported({ dirName: data.dirName, path });
    } catch (e) {
      await confirm({
        title: "Couldn't package the skill",
        body: e instanceof Error ? e.message : String(e),
        confirmLabel: "OK",
        cancelLabel: "Close",
      });
    }
  };

  // After a delete the folder is gone — bypass the unsaved-changes guard (any
  // pending edit is moot) and drop back to Home.
  const onDeleted = () => {
    setManageOpen(false);
    armDiscardBypass();
    navigate("/");
  };

  const sidebar = <Sidebar data={data} selected={selected} onSelect={onSelect} onDelete={onDelete} />;

  return (
    <div ref={rootRef} className="flex h-dvh flex-col bg-app text-fg">
      <TopBar
        skillName={skillName(data)}
        selected={selected}
        reviewMode={reviewMode}
        showReview={showReview}
        previewing={preview != null}
        sessionsOpen={agentOpen}
        narrow={narrow}
        sidebarOpen={sidebarOpen}
        onToggleReview={toggleReview}
        onSessions={() => setAgentOpen((o) => !o)}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        onManage={() => setManageOpen(true)}
        onExport={onExport}
      />
      <PreviewBanner />
      <div className={narrow ? "relative flex min-h-0 flex-1" : "flex min-h-0 flex-1"}>
        {!narrow && sidebar}
        {narrow && sidebarOpen && (
          <div className="absolute inset-0 z-10 flex">
            {sidebar}
            <div className="min-w-0 flex-1 bg-black/40" onClick={() => setSidebarOpen(false)} />
          </div>
        )}
        {/* The scroll pane (main) + the change overview ruler on its right edge.
            The left change bars + per-chunk Revert buttons are in-editor gutter
            decorations now (see LiveEditor); only the ruler stays an overlay (it
            sits over the native scrollbar). It self-hides when there are no
            changes; the editor publishes live change geometry while you edit. */}
        <div className="relative flex min-w-0 flex-1">
          <main ref={setScrollEl} className="relative min-w-0 flex-1 overflow-auto">
            <ReviewToggleContext.Provider value={showReview ? toggleReview : null}>
              <Outlet />
            </ReviewToggleContext.Provider>
          </main>
          <DiffOverlays scrollEl={scrollEl} />
        </div>
        {agentOpen && <AgentPanel onClose={() => setAgentOpen(false)} />}
      </div>
      {manageOpen && (
        <ManagePanel
          root={data.root}
          dirName={data.dirName}
          kind={skillKind(data.root).kind}
          declared={requiredEnv(data.frontmatter)}
          onClose={() => setManageOpen(false)}
          onDeleted={onDeleted}
        />
      )}
      {exportOpen && (
        <ExportDialog
          root={data.root}
          dirName={data.dirName}
          declared={requiredEnv(data.frontmatter)}
          onExported={(result) => {
            setExportOpen(false);
            setExported(result);
          }}
          onClose={() => setExportOpen(false)}
        />
      )}
      {exported && (
        <ExportedDialog
          dirName={exported.dirName}
          path={exported.path}
          onClose={() => setExported(null)}
        />
      )}
    </div>
  );
}
