"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import TopBar from "./TopBar";
import Sidebar from "./Sidebar";
import Home from "./Home";
import SkillDocument from "./SkillDocument";
import FilePane from "./FilePane";
import { Spinner } from "./ui";
import { addRecent } from "./recents";
import { confirmDiscardIfDirty } from "./editorState";
import type { SkillData, FileData } from "@/lib/types";

function skillName(d: SkillData): string {
  return typeof d.frontmatter.name === "string" && d.frontmatter.name ? d.frontmatter.name : d.dirName;
}

export default function SkillApp({
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
  const reqRef = useRef(0);

  const toggleTheme = useCallback(() => {
    const isDark = document.documentElement.classList.toggle("dark");
    try {
      localStorage.setItem("skillviewer-theme", isDark ? "dark" : "light");
    } catch {}
  }, []);

  // Record a deep-linked / SSR-loaded skill in recents once.
  useEffect(() => {
    if (initialData) addRecent({ root: initialData.root, name: skillName(initialData) });
  }, [initialData]);

  const loadSkill = useCallback(async (p: string) => {
    if (!p.trim()) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/skill?path=${encodeURIComponent(p)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load skill");
      const sd = json as SkillData;
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
  }, []);

  const goHome = useCallback(() => {
    if (!confirmDiscardIfDirty()) return;
    setData(null);
    setSelected("SKILL.md");
    setFileData(null);
    setFileError(null);
    setLoadError(null);
  }, []);

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
        const res = await fetch(`/api/file?root=${encodeURIComponent(data.root)}&rel=${encodeURIComponent(rel)}`);
        const json = await res.json();
        if (myReq !== reqRef.current) return;
        if (!res.ok) throw new Error(json.error || "Failed to read file");
        setFileData(json as FileData);
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
      <TopBar onHome={goHome} skillName={skillName(data)} selected={selected} root={data.root} toggleTheme={toggleTheme} />
      <div className="flex min-h-0 flex-1">
        <Sidebar data={data} selected={selected} onSelect={selectFile} />
        <main className="min-w-0 flex-1 overflow-auto">
          {selected === "SKILL.md" ? (
            <SkillDocument key={data.root} data={data} />
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
    </div>
  );
}
