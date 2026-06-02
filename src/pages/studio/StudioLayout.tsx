import { useState } from "react";
import { Outlet, useMatch, useNavigate } from "react-router-dom";
import { skillKind } from "@/lib/agents";
import { requiredEnv } from "@/lib/skill";
import * as api from "@/lib/api";
import { toggleTheme } from "@/lib/theme";
import { armDiscardBypass } from "@/lib/editorState";
import TopBar from "./TopBar";
import Sidebar from "./Sidebar";
import ManagePanel from "./ManagePanel";
import ExportDialog from "./ExportDialog";
import { useStudio, skillName } from "./StudioContext";
import { studioFilePath, studioPath } from "@/lib/routes";

/**
 * The skill workbench chrome: top bar + file sidebar + the routed file pane
 * (Outlet), plus the Manage / Export overlays. Navigation drives which file is
 * shown; the unsaved-changes guard (in AppShell) covers leaving a dirty editor.
 */
export default function StudioLayout() {
  const { data } = useStudio();
  const navigate = useNavigate();
  // Which file is open: the `file/*` splat, else SKILL.md (the index route).
  // useMatch resolves against the current location, so it works here above the
  // Outlet (the splat param isn't visible to this parent via useParams).
  const selected = useMatch("/studio/:root/file/*")?.params["*"] || "SKILL.md";

  const [manageOpen, setManageOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

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
        onManage={() => setManageOpen(true)}
        onExport={onExport}
        toggleTheme={toggleTheme}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar data={data} selected={selected} onSelect={onSelect} />
        <main className="min-w-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
      {manageOpen && (
        <ManagePanel
          root={data.root}
          dirName={data.dirName}
          kind={skillKind(data.root).kind}
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
