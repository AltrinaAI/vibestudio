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
import MinedBanner from "./MinedBanner";
import AgentPanel from "./AgentPanel";
import { useMining } from "@/lib/mining";
import DiffOverlays from "./DiffOverlays";
import ManagePanel from "./ManagePanel";
import ExportDialog from "./ExportDialog";
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
  const onCommitRoute = useMatch("/studio/:root/commit/:sha") != null;
  const fileRel = useMatch("/studio/:root/file/*")?.params["*"];
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
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

  // The side-panel agent conversation. Skills that came out of the last mining
  // run open with the panel already showing — the conversation that proposed
  // them is the natural companion for reviewing. Manual close is respected for
  // the rest of the visit (the ref gates the auto-open to once per mount).
  const [agentOpen, setAgentOpen] = useState(false);
  const mining = useMining();
  const autoOpenedAgent = useRef(false);
  useEffect(() => {
    if (autoOpenedAgent.current || !mining?.terminalId) return;
    const fromMining =
      data.root.includes("/generated-skills/") || (mining.improved ?? []).includes(data.root);
    if (fromMining) {
      autoOpenedAgent.current = true;
      setAgentOpen(true);
    }
  }, [mining, data.root]);

  const onSelect = (rel: string) => {
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

  // Skills with no declared env export in one click; otherwise the dialog surfaces
  // the bundle-secrets option and the not-bundled warning.
  const onExport = () => {
    if (requiredEnv(data.frontmatter).length === 0) void api.exportZip(data.root);
    else setExportOpen(true);
  };

  // After a delete the folder is gone — bypass the unsaved-changes guard (any
  // pending edit is moot) and drop back to Home.
  const onDeleted = () => {
    setManageOpen(false);
    armDiscardBypass();
    navigate("/");
  };

  return (
    <div className="flex h-screen flex-col bg-app text-fg">
      <TopBar
        skillName={skillName(data)}
        selected={selected}
        reviewMode={reviewMode}
        showReview={showReview}
        previewing={preview != null}
        terminalsOpen={agentOpen}
        onToggleReview={toggleReview}
        onTerminals={() => setAgentOpen((o) => !o)}
        onManage={() => setManageOpen(true)}
        onExport={onExport}
      />
      <PreviewBanner />
      <MinedBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar data={data} selected={selected} onSelect={onSelect} onDelete={onDelete} />
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
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}
