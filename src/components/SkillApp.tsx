"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import TopBar from "./TopBar";
import Sidebar from "./Sidebar";
import Home from "./Home";
import SkillDocument from "./SkillDocument";
import FilePane from "./FilePane";
import ManagePanel from "./ManagePanel";
import ExportDialog from "./ExportDialog";
import { Spinner } from "./ui";
import { addRecent } from "./recents";
import { confirmDiscardIfDirty } from "./editorState";
import { agentForPath, skillKind } from "@/lib/agents";
import { requiredEnv, withRequiredEnv } from "@/lib/skill";
import * as api from "@/lib/api";
import type { SkillData, FileData } from "@/lib/types";

function skillName(d: SkillData): string {
  return typeof d.frontmatter.name === "string" && d.frontmatter.name ? d.frontmatter.name : d.dirName;
}

export default function SkillApp({
  initialPath,
  initialData = null,
  initialError = null,
}: {
  initialPath?: string;
  initialData?: SkillData | null;
  initialError?: string | null;
}) {
  const [data, setData] = useState<SkillData | null>(initialData);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(initialError);

  const [selected, setSelected] = useState<string | null>("SKILL.md");
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Bumped when we replace `data` for the *same* root (e.g. after a re-scan
  // rewrites SKILL.md) so the mount-initialized editor remounts with it.
  const [docVersion, setDocVersion] = useState(0);
  const reqRef = useRef(0);

  const toggleTheme = useCallback(() => {
    const isDark = document.documentElement.classList.toggle("dark");
    try {
      localStorage.setItem("skillviewer-theme", isDark ? "dark" : "light");
    } catch {}
  }, []);

  // Auto-declare the env vars a skill references: scan its files for managed
  // secret names and fold any new ones into `metadata.required-env`. Additive
  // (never drops a manual entry) and only for our own skills — we own that
  // field, but don't rewrite official/plugin skills. Returns the (possibly
  // reloaded) data plus the referenced names; cancelled=true if a dirty-edit
  // discard prompt was declined.
  const reconcileRequiredEnv = useCallback(
    async (
      sd: SkillData,
      guardDirty = false,
    ): Promise<{ data: SkillData; found: string[]; cancelled?: boolean }> => {
      if (skillKind(sd.root).kind !== "personal") return { data: sd, found: [] };
      let found: string[] = [];
      try {
        found = await api.detectRequiredEnv(sd.root);
      } catch {
        return { data: sd, found: [] };
      }
      const current = requiredEnv(sd.frontmatter);
      const merged = Array.from(new Set([...current, ...found])).sort();
      if (merged.length === current.length) return { data: sd, found }; // nothing new
      if (guardDirty && !confirmDiscardIfDirty()) return { data: sd, found, cancelled: true };
      try {
        await api.saveSkillMd(sd.root, withRequiredEnv(sd.frontmatter, merged), sd.body);
        return { data: await api.loadSkill(sd.root), found };
      } catch {
        return { data: sd, found };
      }
    },
    [],
  );

  // Record a deep-linked / SSR-loaded skill in recents once. (Auto-declare runs
  // in the load path below; SSR-provided `initialData` isn't used in this app,
  // so we don't reconcile here — doing so safely would need a same-root editor
  // remount + a navigation guard, and there's no live path that exercises it.)
  useEffect(() => {
    if (initialData) addRecent({ root: initialData.root, name: skillName(initialData) });
  }, [initialData]);

  const loadSkill = useCallback(async (p: string) => {
    if (!p.trim()) return;
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await api.loadSkill(p);
      const sd = (await reconcileRequiredEnv(loaded)).data;
      setData(sd);
      setSelected("SKILL.md");
      setFileData(null);
      setFileError(null);
      addRecent({ root: sd.root, name: skillName(sd) });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load skill");
    } finally {
      setLoading(false);
    }
  }, [reconcileRequiredEnv]);

  // Open a deep-linked skill (?path=) once on mount.
  useEffect(() => {
    if (initialPath && !initialData) void loadSkill(initialPath);
  }, [initialPath, initialData, loadSkill]);

  const goHome = useCallback(() => {
    if (!confirmDiscardIfDirty()) return;
    setData(null);
    setSelected("SKILL.md");
    setFileData(null);
    setFileError(null);
    setLoadError(null);
  }, []);

  // After a delete the folder is gone — drop back to Home without the
  // unsaved-changes prompt (any pending edit is moot).
  const afterDelete = useCallback(() => {
    setManageOpen(false);
    setData(null);
    setSelected("SKILL.md");
    setFileData(null);
    setFileError(null);
    setLoadError(null);
  }, []);

  // Manual re-scan (e.g. after adding a secret to the store mid-session). May
  // rewrite + reload SKILL.md; bump docVersion so the already-mounted editor
  // remounts with the new declaration. null = cancelled the discard prompt.
  const detectEnv = useCallback(async (): Promise<string[] | null> => {
    if (!data) return [];
    const { data: fresh, found, cancelled } = await reconcileRequiredEnv(data, true);
    if (cancelled) return null;
    if (fresh !== data) {
      setData(fresh);
      setDocVersion((v) => v + 1);
    }
    return found;
  }, [data, reconcileRequiredEnv]);

  // Skills with no declared env can export in one click; otherwise the dialog
  // surfaces the bundle-secrets option and the not-bundled warning.
  const onExport = useCallback(() => {
    if (!data) return;
    if (requiredEnv(data.frontmatter).length === 0) void api.exportZip(data.root);
    else setExportOpen(true);
  }, [data]);

  const selectFile = useCallback(
    async (rel: string) => {
      if (!data || rel === selected) return;
      if (!confirmDiscardIfDirty()) return;
      const myReq = ++reqRef.current;
      setSelected(rel);
      if (rel === "SKILL.md") {
        setFileData(null);
        setFileError(null);
        setFileLoading(false);
        return;
      }
      setFileLoading(true);
      setFileError(null);
      setFileData(null);
      try {
        const fd = await api.readFile(data.root, rel);
        if (myReq !== reqRef.current) return;
        setFileData(fd);
      } catch (e) {
        if (myReq !== reqRef.current) return;
        setFileError(e instanceof Error ? e.message : "Failed to read file");
      } finally {
        if (myReq === reqRef.current) setFileLoading(false);
      }
    },
    [data, selected],
  );

  if (!data) {
    return <Home onOpen={loadSkill} loading={loading} error={loadError} toggleTheme={toggleTheme} />;
  }

  return (
    <div className="flex h-screen flex-col bg-app text-fg">
      <TopBar
        onHome={goHome}
        skillName={skillName(data)}
        selected={selected}
        onManage={() => setManageOpen(true)}
        onExport={onExport}
        toggleTheme={toggleTheme}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar data={data} selected={selected} onSelect={selectFile} />
        <main className="min-w-0 flex-1 overflow-auto">
          {selected === "SKILL.md" ? (
            <SkillDocument key={`${data.root}:${docVersion}`} data={data} />
          ) : fileLoading ? (
            <div role="status" aria-live="polite" className="flex h-full items-center justify-center text-muted">
              <Spinner /> <span className="ml-2">Loading file…</span>
            </div>
          ) : fileError ? (
            <p className="px-8 py-8 text-sm text-danger">{fileError}</p>
          ) : fileData ? (
            <FilePane key={fileData.rel} root={data.root} file={fileData} />
          ) : null}
        </main>
      </div>
      {manageOpen && (
        <ManagePanel
          root={data.root}
          dirName={data.dirName}
          kind={skillKind(data.root).kind}
          agent={agentForPath(data.root)}
          declaredSecrets={requiredEnv(data.frontmatter)}
          onDetectEnv={detectEnv}
          onClose={() => setManageOpen(false)}
          onDeleted={afterDelete}
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
