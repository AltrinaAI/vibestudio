"use client";

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import NavBar from "@/components/NavBar";
import { Spinner } from "@/components/ui";
import ValidationPill from "@/components/ValidationPill";
import { agentColor } from "@/lib/agents";
import { humanSize } from "@/lib/fileTypes";
import { validateAgentsMd } from "@/lib/agentmd";
import * as api from "@/lib/api";
import type { AgentsMdData } from "@/lib/api";
import { useAutosave } from "@/lib/useAutosave";

// The AGENTS.md editor reuses the SKILL.md markdown core (LiveEditor) verbatim —
// one editor, one set of behaviors to maintain — and layers the `agentmd`
// verification on top via the shared ValidationPill.
const LiveEditor = lazy(() => import("@/components/LiveEditor"));
const EditorFallback = () => <div className="px-8 py-6 text-sm text-muted">Loading editor…</div>;

/** AGENTS.md is the shared-standard guide, so it carries the "Agent Skills" hue. */
const GUIDE_AGENT = "Agent Skills";

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard?.writeText(path).then(() => setCopied(true)).catch(() => {})}
      title="Copy path"
      className="ml-auto flex min-w-0 items-center gap-1.5 font-mono text-faint hover:text-muted"
    >
      <span className="truncate">{path}</span>
      {copied ? (
        <svg className="shrink-0" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-label="Copied">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg className="shrink-0" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function GuideEditor({ data }: { data: AgentsMdData }) {
  const [content, setContent] = useState(data.content);

  // Live HEAD baseline → the same change indicators (overview ruler + left bars)
  // the skill editor shows, for a git-tracked guide. undefined = not tracked.
  const [baseline, setBaseline] = useState<string | undefined>(undefined);
  const baseReq = useRef(0);
  useEffect(() => {
    const myReq = ++baseReq.current;
    api
      .gitInfo(data.dir)
      .then((info) => {
        if (myReq !== baseReq.current) return undefined;
        if (!info.isRepo && !info.inParentRepo) {
          setBaseline(undefined);
          return undefined;
        }
        return api.gitFileAt(data.dir, "HEAD", data.file).then((b) => {
          if (myReq === baseReq.current) setBaseline(b);
        });
      })
      .catch(() => myReq === baseReq.current && setBaseline(undefined));
  }, [data.dir, data.file]);

  const save = useCallback(async () => {
    await api.saveAgentsMd(data.dir, data.file, content);
  }, [data.dir, data.file, content]);
  useAutosave(content, save, true);

  const issues = useMemo(() => validateAgentsMd({ raw: content, fileName: data.file }), [content, data.file]);

  return (
    <div className="mx-auto max-w-208 px-6 py-10 sm:px-10">
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <ValidationPill issues={issues} okLabel="agentmd: passes" />
        <span className="inline-flex items-center gap-1.5 text-muted">
          <span className="h-2 w-2 rounded-full" style={{ background: agentColor(GUIDE_AGENT) }} aria-hidden />
          AGENTS.md
          <span className="text-faint">· {data.file !== "AGENTS.md" ? data.file : humanSize(content.length)}</span>
        </span>
        <CopyPath path={data.path} />
      </div>

      <Suspense fallback={<EditorFallback />}>
        <LiveEditor
          kind="markdown"
          filename={data.file}
          value={content}
          onChange={setContent}
          placeholder="Document the build/test commands, conventions, and boundaries an agent needs…"
          baseline={baseline}
        />
      </Suspense>
    </div>
  );
}

/** Route element for `/agents/:path` — loads an AGENTS.md by its absolute path
 *  and renders the reused markdown editor + the `agentmd` verification. */
export function Component() {
  const path = useParams().path!; // already decoded by the router
  const [data, setData] = useState<AgentsMdData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const myReq = ++reqRef.current;
    setData(null);
    setError(null);
    (async () => {
      try {
        const d = await api.loadAgentsMd(path);
        if (myReq !== reqRef.current) return;
        setData(d);
      } catch (e) {
        if (myReq !== reqRef.current) return;
        setError(e instanceof Error ? e.message : "Failed to load AGENTS.md");
      }
    })();
  }, [path]);

  const fileName = path.split(/[\\/]/).pop() || path;

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar breadcrumb={<span className="truncate text-sm text-muted">{fileName}</span>} />
      <main className="flex-1">
        {error ? (
          <p className="px-8 py-8 text-sm text-danger">{error}</p>
        ) : !data ? (
          <div role="status" aria-live="polite" className="flex flex-1 items-center justify-center py-20 text-muted">
            <Spinner /> <span className="ml-2">Loading guide…</span>
          </div>
        ) : (
          // Remount on path change so the editor's internal buffer resets cleanly.
          <GuideEditor key={data.path} data={data} />
        )}
      </main>
    </div>
  );
}
