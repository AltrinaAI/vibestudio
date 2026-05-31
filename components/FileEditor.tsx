"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Spinner, Badge } from "./ui";
import type { FileData } from "@/lib/types";

const CodeEditor = dynamic(() => import("./CodeEditor"), {
  ssr: false,
  loading: () => <div className="p-4 text-sm text-muted">Loading editor…</div>,
});

export default function FileEditor({
  root,
  file,
  onSaved,
}: {
  root: string;
  file: FileData;
  onSaved: () => void;
}) {
  const [content, setContent] = useState(file.content ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = content !== (file.content ?? "");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, rel: file.rel, content }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-5 py-2.5">
        <span aria-hidden>📝</span>
        <span className="truncate font-mono text-sm text-fg">{file.rel}</span>
        <Badge tone="muted">{file.label}</Badge>
        {dirty && <span className="text-xs text-warn">● unsaved</span>}
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="ml-auto inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving && <Spinner className="h-3.5 w-3.5" />}
          Save
        </button>
      </div>
      {error && (
        <div className="border-b border-border bg-[color-mix(in_srgb,var(--error)_12%,transparent)] px-5 py-2 text-sm text-danger">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <CodeEditor
          value={content}
          language={file.language}
          onChange={setContent}
          height="100%"
          className="h-full"
        />
      </div>
    </div>
  );
}
