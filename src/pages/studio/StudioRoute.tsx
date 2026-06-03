import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Spinner } from "@/components/ui";
import NavBar from "@/components/NavBar";
import { addRecent } from "@/lib/recents";
import { skillKind } from "@/lib/agents";
import { loadSkill } from "@/lib/api";
import type { SkillData } from "@/lib/types";
import { reconcileRequiredEnv, runSaveHooks } from "./saveHooks";
import { isEditorDirty } from "@/lib/editorState";
import { StudioProvider, skillName } from "./StudioContext";
import StudioLayout from "./StudioLayout";

/** Idle delay before the post-save pipeline (reconcile) runs, so a burst of
 *  autosaves coalesces into one reconcile instead of one per keystroke pause. */
const HOOK_DELAY = 2000;

/**
 * Route element for `/studio/:root`. Owns the loaded skill: it loads (and
 * reconciles required-env) on every `:root` change, holds the post-save pipeline,
 * provides StudioContext, and renders the layout (or a loading / error shell). The
 * nested file routes render inside the layout's Outlet.
 */
export function Component() {
  const root = useParams().root!; // already decoded by the router
  const [data, setData] = useState<SkillData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docVersion, setDocVersion] = useState(0);
  const [gitVersion, setGitVersion] = useState(0);

  // Live `data` for async callbacks that may resolve after a navigation.
  const dataRef = useRef<SkillData | null>(null);
  useEffect(() => {
    dataRef.current = data;
  });

  // (Re)load whenever the routed skill root changes.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);
    (async () => {
      try {
        // Reconcile required-env on open so the declaration is current before edits.
        const { data: sd } = await reconcileRequiredEnv(root);
        if (cancelled) return;
        setData(sd);
        addRecent({ root: sd.root, name: skillName(sd) });
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load skill");
      }
    })();
    return () => {
      cancelled = true;
      if (hookTimer.current) clearTimeout(hookTimer.current); // drop a pending reconcile for the old skill
    };
  }, [root]);

  // Post-save pipeline. Autosave fires often, so we DEBOUNCE the (relatively
  // heavy) reconcile — it scans the skill's files and may rewrite SKILL.md — to
  // run once edits settle rather than on every keystroke pause. When a hook
  // rewrote the skill (same root only) we swap the reloaded data in and remount
  // the editor (docVersion bump) only when it isn't mid-edit, so keystrokes typed
  // after the save aren't dropped. `saveSeq` drops a stale reconcile if a newer
  // one started before it resolved.
  const saveSeq = useRef(0);
  const hookTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runPipeline = useCallback(async (rel: string | null) => {
    const cur = dataRef.current;
    if (!cur) return;
    const seq = ++saveSeq.current;
    const effects = await runSaveHooks({ root: cur.root, kind: skillKind(cur.root).kind, rel });
    if (seq !== saveSeq.current) return; // a newer save superseded this one
    let reloaded: SkillData | undefined;
    for (const e of effects) if (e.reloaded) reloaded = e.reloaded;
    if (reloaded && dataRef.current?.root === reloaded.root) {
      setData(reloaded);
      dataRef.current = reloaded;
      if (!isEditorDirty()) setDocVersion((v) => v + 1);
    }
  }, []);
  const afterSave = useCallback(
    (rel: string | null) => {
      if (hookTimer.current) clearTimeout(hookTimer.current);
      hookTimer.current = setTimeout(() => void runPipeline(rel), HOOK_DELAY);
    },
    [runPipeline],
  );

  const bumpGit = useCallback(() => setGitVersion((v) => v + 1), []);

  // Git changed on disk from within the app (commit / discard). Bump gitVersion
  // so open diff overlays refetch their HEAD baseline; re-read the skill so the
  // editor reflects reverted content, remounting it (docVersion) only when it's
  // not mid-edit, so live keystrokes are never dropped.
  const reload = useCallback(() => {
    const cur = dataRef.current;
    if (!cur) return;
    setGitVersion((v) => v + 1);
    (async () => {
      try {
        const sd = await loadSkill(cur.root);
        if (dataRef.current?.root !== sd.root) return;
        setData(sd);
        dataRef.current = sd;
        if (!isEditorDirty()) setDocVersion((v) => v + 1);
      } catch {
        /* a transient read failure just leaves the current data in place */
      }
    })();
  }, []);

  if (error) return <SkillErrorShell root={root} message={error} />;
  if (!data) return <SkillLoadingShell />;
  return (
    <StudioProvider value={{ data, docVersion, gitVersion, bumpGit, afterSave, reload }}>
      <StudioLayout />
    </StudioProvider>
  );
}

function SkillLoadingShell() {
  return (
    <div className="flex h-screen flex-col bg-app text-fg">
      <NavBar />
      <div role="status" aria-live="polite" className="flex flex-1 items-center justify-center text-muted">
        <Spinner /> <span className="ml-2">Loading skill…</span>
      </div>
    </div>
  );
}

function SkillErrorShell({ root, message }: { root: string; message: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex h-screen flex-col bg-app text-fg">
      <NavBar onHome={() => navigate("/")} />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-danger">{message}</p>
        <p className="max-w-md break-all font-mono text-xs text-faint">{root}</p>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-app hover:opacity-90"
        >
          Back to home
        </button>
      </div>
    </div>
  );
}
