"use client";

import { useCallback, useRef, useState } from "react";
import TopBar from "./TopBar";
import Sidebar from "./Sidebar";
import SkillView from "./SkillView";
import SkillEditor from "./SkillEditor";
import FileView from "./FileView";
import FileEditor from "./FileEditor";
import { Spinner } from "./ui";
import type { SkillData, FileData } from "@/lib/types";

const EXAMPLES = [
  { label: "docx", path: "examples/docx" },
  { label: "pdf", path: "examples/pdf" },
  { label: "pptx", path: "examples/pptx" },
  { label: "xlsx", path: "examples/xlsx" },
];

function fileEditable(f: FileData | null): boolean {
  return !!(f && f.content != null && !f.tooLarge && !f.isBinary && f.category !== "image");
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
  const [pathInput, setPathInput] = useState(initialData?.root ?? initialPath ?? "");
  const [data, setData] = useState<SkillData | null>(initialData);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(initialError);

  const [selected, setSelected] = useState<string | null>("SKILL.md");
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  // Monotonic token so out-of-order file fetches don't clobber the latest selection.
  const reqRef = useRef(0);

  // Theme is driven entirely by the `.dark` class on <html> (set pre-paint by an
  // inline script). The toggle flips the class + persists it; the icon follows
  // the class via CSS, so no React state/effect is needed (and no hydration risk).
  const toggleTheme = useCallback(() => {
    const isDark = document.documentElement.classList.toggle("dark");
    try {
      localStorage.setItem("skillviewer-theme", isDark ? "dark" : "light");
    } catch {}
  }, []);

  const loadSkill = useCallback(async (p: string) => {
    if (!p.trim()) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/skill?path=${encodeURIComponent(p)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load skill");
      setData(json as SkillData);
      setPathInput((json as SkillData).root);
      setSelected("SKILL.md");
      setFileData(null);
      setFileError(null);
      setMode("view");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load skill");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectFile = useCallback(
    async (rel: string) => {
      if (!data) return;
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
        const res = await fetch(
          `/api/file?root=${encodeURIComponent(data.root)}&rel=${encodeURIComponent(rel)}`,
        );
        const json = await res.json();
        if (myReq !== reqRef.current) return; // a newer selection superseded this one
        if (!res.ok) throw new Error(json.error || "Failed to read file");
        setFileData(json as FileData);
        if (mode === "edit" && !fileEditable(json as FileData)) setMode("view");
      } catch (e) {
        if (myReq !== reqRef.current) return;
        setFileError(e instanceof Error ? e.message : "Failed to read file");
      } finally {
        if (myReq === reqRef.current) setFileLoading(false);
      }
    },
    [data, mode],
  );

  const editable = selected === "SKILL.md" ? !!data : fileEditable(fileData);
  const effectiveMode = mode === "edit" && editable ? "edit" : "view";

  return (
    <div className="flex h-screen flex-col bg-app text-fg">
      <TopBar
        pathInput={pathInput}
        setPathInput={setPathInput}
        onLoad={() => loadSkill(pathInput)}
        loading={loading}
        mode={mode}
        setMode={setMode}
        toggleTheme={toggleTheme}
        editable={editable}
      />

      <div className="flex min-h-0 flex-1">
        {data && <Sidebar data={data} selected={selected} onSelect={selectFile} />}

        <main className="min-w-0 flex-1 overflow-auto bg-app">
          {!data ? (
            <WelcomeOrError loading={loading} error={loadError} onLoadExample={loadSkill} />
          ) : selected === "SKILL.md" ? (
            effectiveMode === "edit" ? (
              <SkillEditor key={data.root} data={data} onSaved={(next) => setData(next)} />
            ) : (
              <SkillView data={data} onNavigate={selectFile} />
            )
          ) : fileLoading ? (
            <div role="status" aria-live="polite" className="flex h-full items-center justify-center text-muted">
              <Spinner /> <span className="ml-2">Loading file…</span>
            </div>
          ) : fileError ? (
            <div className="p-8 text-sm text-danger">{fileError}</div>
          ) : fileData ? (
            effectiveMode === "edit" ? (
              <FileEditor
                key={fileData.rel}
                root={data.root}
                file={fileData}
                onSaved={() => selectFile(fileData.rel)}
              />
            ) : (
              <FileView key={fileData.rel} file={fileData} root={data.root} onNavigate={selectFile} />
            )
          ) : null}
        </main>
      </div>
    </div>
  );
}

function WelcomeOrError({
  loading,
  error,
  onLoadExample,
}: {
  loading: boolean;
  error: string | null;
  onLoadExample: (p: string) => void;
}) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-bold text-fg">Agent Skill Viewer & Editor</h1>
      <p className="mt-2 text-muted">
        Point it at a single skill folder (a directory containing a <code className="rounded bg-panel px-1 font-mono text-sm">SKILL.md</code>)
        to render its metadata, validate it against the{" "}
        <a className="text-accent hover:underline" href="https://agentskills.io/specification" target="_blank" rel="noopener noreferrer">
          Agent Skills spec
        </a>
        , browse its files, and edit it.
      </p>

      {loading && (
        <div role="status" aria-live="polite" className="mt-6 flex items-center gap-2 text-muted">
          <Spinner /> Loading…
        </div>
      )}

      {error && (
        <div className="mt-6 rounded-lg border border-[color-mix(in_srgb,var(--error)_40%,transparent)] bg-[color-mix(in_srgb,var(--error)_12%,transparent)] px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="mt-8">
        <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">
          Try a bundled example
        </div>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.path}
              onClick={() => onLoadExample(ex.path)}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-sm text-fg hover:border-accent hover:text-accent"
            >
              {ex.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-8 rounded-lg border border-border bg-surface p-4 text-sm text-muted">
        <div className="mb-1 font-medium text-fg">Tip</div>
        Set a default folder with{" "}
        <code className="rounded bg-panel px-1 font-mono">SKILL_PATH=/path/to/skill npm run dev</code>, or paste an
        absolute path into the bar above and press <span className="font-medium text-fg">Load</span>.
      </div>
    </div>
  );
}
