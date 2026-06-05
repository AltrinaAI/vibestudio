import { useState } from "react";
import { Outlet, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { skillKind } from "@/lib/agents";
import { requiredEnv } from "@/lib/skill";
import * as api from "@/lib/api";
import { toggleTheme } from "@/lib/theme";
import { armDiscardBypass } from "@/lib/editorState";
import TopBar from "./TopBar";
import Sidebar from "./Sidebar";
import PreviewBanner from "./PreviewBanner";
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
  const { data } = useStudio();
  const navigate = useNavigate();
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
  const showReview = selected != null && (reviewMode || reviewAvailable);
  const toggleReview = () =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (reviewMode) next.delete("diff");
        else next.set("diff", "worktree");
        return next;
      },
      { replace: true },
    );

  const [manageOpen, setManageOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

  const onSelect = (rel: string) => {
    if (rel === selected) return; // no-op re-select; avoid a spurious discard prompt
    navigate(rel === "SKILL.md" ? studioPath(data.root) : studioFilePath(data.root, rel));
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
        onHome={() => navigate("/")}
        skillName={skillName(data)}
        selected={selected}
        reviewMode={reviewMode}
        showReview={showReview}
        onToggleReview={toggleReview}
        onManage={() => setManageOpen(true)}
        onExport={onExport}
        toggleTheme={toggleTheme}
      />
      <PreviewBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar data={data} selected={selected} onSelect={onSelect} />
        {/* The scroll pane (main) + diff overlays (overview ruler on the right,
            change bars + revert buttons in the left margin) — mounted OUTSIDE the
            centered editor column. Rendered for every file (it self-hides when
            there are no changes); the editor publishes live change geometry while
            you edit. `main` is position:relative so the portaled bars/buttons
            position against the scroll content and scroll with it. Revert buttons
            show only in review mode. */}
        <div className="relative flex min-w-0 flex-1">
          <main ref={setScrollEl} className="relative min-w-0 flex-1 overflow-auto">
            <Outlet />
          </main>
          <DiffOverlays scrollEl={scrollEl} showRevert={reviewMode} onToggleReview={toggleReview} />
        </div>
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
