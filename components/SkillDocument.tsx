"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useManualSave } from "./useManualSave";
import {
  serializeSkillMd,
  validateSkill,
  normalizeMetadata,
  summarizeIssues,
  KNOWN_FIELDS,
  type SkillFrontmatter,
  type ValidationIssue,
} from "@/lib/skill";
import type { SkillData } from "@/lib/types";

const LiveEditor = dynamic(() => import("./LiveEditor"), {
  ssr: false,
  loading: () => <div className="py-4 text-sm text-muted">Loading editor…</div>,
});

interface MetaRow {
  id: number;
  key: string;
  value: string;
}

const asString = (v: unknown) => (typeof v === "string" ? v : "");

interface Fields {
  name: string;
  description: string;
  license: string;
  compatibility: string;
  allowedTools: string;
  meta: MetaRow[];
  extra: Record<string, unknown>;
}

function buildFrontmatter(v: Fields): SkillFrontmatter {
  const out: SkillFrontmatter = { ...v.extra, name: v.name, description: v.description };
  if (v.license.trim()) out.license = v.license.trim();
  if (v.compatibility.trim()) out.compatibility = v.compatibility.trim();
  if (v.allowedTools.trim()) out["allowed-tools"] = v.allowedTools.trim();
  const m: Record<string, string> = {};
  for (const row of v.meta) if (row.key.trim()) m[row.key.trim()] = row.value;
  if (Object.keys(m).length) out.metadata = m;
  return out;
}

function extraOf(fm: SkillFrontmatter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(fm)) if (!KNOWN_FIELDS.has(k)) out[k] = val;
  return out;
}

function metaRowsOf(fm: SkillFrontmatter): MetaRow[] {
  return Object.entries(normalizeMetadata(fm.metadata) ?? {}).map(([key, value], i) => ({ id: i, key, value }));
}

/** A textarea that grows to fit its content (no inner scrollbar). */
function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);
  useLayoutEffect(() => {
    resize();
  }, [props.value, resize]);
  return <textarea ref={ref} rows={1} {...props} />;
}

function ValidationPill({ issues }: { issues: ValidationIssue[] }) {
  const [open, setOpen] = useState(false);
  const { errors, warnings, ok } = summarizeIssues(issues);
  const label = !ok
    ? `${errors} issue${errors === 1 ? "" : "s"}`
    : warnings > 0
      ? `${warnings} warning${warnings === 1 ? "" : "s"}`
      : "Spec compliant";
  const cls = !ok ? "text-danger" : warnings > 0 ? "text-warn" : "text-muted";
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className={`inline-flex items-center gap-1.5 ${cls} hover:underline`}>
        <span aria-hidden>{ok ? (warnings > 0 ? "▲" : "✓") : "▲"}</span>
        {label}
      </button>
      {open && issues.length > 0 && (
        <div className="absolute left-0 top-6 z-20 w-80 rounded-lg border border-border bg-surface p-2 shadow-lg">
          <ul className="space-y-1.5">
            {issues.map((i, idx) => (
              <li key={idx} className="flex gap-2 text-xs leading-relaxed">
                <span className={i.level === "error" ? "text-danger" : i.level === "warning" ? "text-warn" : "text-info"}>
                  {i.level === "error" ? "✕" : i.level === "warning" ? "▲" : "i"}
                </span>
                <span>
                  <code className="text-muted">{i.field}</code> {i.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const inputCls =
  "w-full bg-transparent text-sm text-fg outline-none placeholder:text-faint border-b border-transparent focus:border-border-strong py-0.5";

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-28 shrink-0 pt-0.5 text-xs text-muted">{label}</span>
      {children}
    </div>
  );
}

export default function SkillDocument({ data }: { data: SkillData }) {
  const fm = data.frontmatter;
  const [name, setName] = useState(asString(fm.name));
  const [description, setDescription] = useState(asString(fm.description));
  const [license, setLicense] = useState(asString(fm.license));
  const [compatibility, setCompatibility] = useState(asString(fm.compatibility));
  const [allowedTools, setAllowedTools] = useState(asString(fm["allowed-tools"]));
  const [meta, setMeta] = useState<MetaRow[]>(() => metaRowsOf(fm));
  const [body, setBody] = useState(data.body);

  const propCount = [license, compatibility, allowedTools].filter(Boolean).length + meta.length;
  const [showProps, setShowProps] = useState(false);

  const extraFields = useMemo(() => extraOf(fm), [fm]);
  const frontmatter = useMemo(
    () => buildFrontmatter({ name, description, license, compatibility, allowedTools, meta, extra: extraFields }),
    [name, description, license, compatibility, allowedTools, meta, extraFields],
  );
  const serialized = useMemo(() => serializeSkillMd(frontmatter, body), [frontmatter, body]);

  const issues = useMemo(
    () => validateSkill({ frontmatter, body, hasFrontmatter: true, dirName: data.dirName, files: data.files }),
    [frontmatter, body, data.dirName, data.files],
  );
  const nameError = issues.find((i) => i.field === "name" && i.level === "error");

  const save = useCallback(async () => {
    const res = await fetch("/api/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: data.root, frontmatter, body }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "Save failed");
    }
  }, [data.root, frontmatter, body]);
  useManualSave(serialized, save);

  const dupKeys = useMemo(() => {
    const trimmed = meta.map((r) => r.key.trim());
    return new Set(trimmed.filter((k, i) => k && trimmed.indexOf(k) !== i));
  }, [meta]);
  const emptyWithValue = meta.some((r) => !r.key.trim() && r.value.trim());

  return (
    <div className="mx-auto max-w-184 px-6 py-10 sm:px-10">
      <div className="mb-7 flex items-center gap-4 text-xs">
        <ValidationPill issues={issues} />
        <span className="ml-auto font-mono text-faint">SKILL.md</span>
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="skill-name"
        spellCheck={false}
        aria-label="Skill name"
        className="w-full bg-transparent text-3xl font-bold tracking-tight text-fg outline-none placeholder:text-faint"
      />
      {nameError && <p className="mt-1.5 text-xs text-danger">{nameError.message}</p>}

      <AutoTextarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Describe what this skill does and when to use it…"
        aria-label="Skill description"
        className="mt-3 w-full resize-none overflow-hidden bg-transparent text-[1.05rem] leading-relaxed text-muted outline-none placeholder:text-faint"
      />

      <div className="mt-5">
        <button
          type="button"
          onClick={() => setShowProps((s) => !s)}
          aria-expanded={showProps}
          className="text-xs font-medium text-muted hover:text-fg"
        >
          {showProps ? "▾" : "▸"} Properties
          {!showProps && propCount > 0 && <span className="ml-1 text-faint">· {propCount}</span>}
        </button>
        {showProps && (
          <div className="mt-2 space-y-2">
            <PropRow label="License">
              <input className={inputCls} value={license} onChange={(e) => setLicense(e.target.value)} placeholder="e.g. Apache-2.0" />
            </PropRow>
            <PropRow label="Compatibility">
              <input className={inputCls} value={compatibility} onChange={(e) => setCompatibility(e.target.value)} placeholder="e.g. Requires Python 3.12+" />
            </PropRow>
            <PropRow label="Allowed tools">
              <input className={`${inputCls} font-mono`} value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} placeholder="e.g. Bash(git:*) Read" />
            </PropRow>
            <PropRow label="Metadata">
              <div className="w-full space-y-1.5">
                {meta.map((row) => (
                  <div key={row.id} className="flex items-center gap-2">
                    <input
                      className={`${inputCls} max-w-40 font-mono ${row.key.trim() && dupKeys.has(row.key.trim()) ? "border-danger" : ""}`}
                      value={row.key}
                      placeholder="key"
                      onChange={(e) => setMeta((rows) => rows.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))}
                    />
                    <input
                      className={inputCls}
                      value={row.value}
                      placeholder="value"
                      onChange={(e) => setMeta((rows) => rows.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))}
                    />
                    <button
                      type="button"
                      onClick={() => setMeta((rows) => rows.filter((r) => r.id !== row.id))}
                      className="shrink-0 text-faint hover:text-danger"
                      aria-label="Remove metadata field"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setMeta((rows) => [...rows, { id: Date.now() + rows.length, key: "", value: "" }])}
                  className="text-xs text-faint hover:text-accent"
                >
                  + Add metadata
                </button>
                {(dupKeys.size > 0 || emptyWithValue) && (
                  <p className="text-xs text-warn">
                    {dupKeys.size > 0 && "Duplicate keys are merged (last value wins). "}
                    {emptyWithValue && "Rows with an empty key are dropped on save."}
                  </p>
                )}
              </div>
            </PropRow>
          </div>
        )}
      </div>

      <hr className="my-7 border-border" />

      <LiveEditor kind="markdown" value={body} onChange={setBody} placeholder="Write the skill instructions in Markdown…" />
    </div>
  );
}
