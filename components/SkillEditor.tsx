"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Markdown from "./Markdown";
import ValidationPanel from "./ValidationPanel";
import { Spinner } from "./ui";
import {
  serializeSkillMd,
  validateSkill,
  normalizeMetadata,
  LIMITS,
  KNOWN_FIELDS,
  type SkillFrontmatter,
} from "@/lib/skill";
import type { SkillData } from "@/lib/types";

const CodeEditor = dynamic(() => import("./CodeEditor"), {
  ssr: false,
  loading: () => <div className="p-4 text-sm text-muted">Loading editor…</div>,
});

interface MetaRow {
  id: number;
  key: string;
  value: string;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

interface FrontmatterFields {
  name: string;
  description: string;
  license: string;
  compatibility: string;
  allowedTools: string;
  meta: MetaRow[];
  extra: Record<string, unknown>;
}

/** Build a spec frontmatter object from the editable fields (shared by the live
 *  value and the once-captured baseline, so they compare identically on load). */
function buildFrontmatter(v: FrontmatterFields): SkillFrontmatter {
  const out: SkillFrontmatter = { ...v.extra, name: v.name, description: v.description };
  if (v.license.trim()) out.license = v.license.trim();
  if (v.compatibility.trim()) out.compatibility = v.compatibility.trim();
  if (v.allowedTools.trim()) out["allowed-tools"] = v.allowedTools.trim();
  const m: Record<string, string> = {};
  for (const row of v.meta) {
    if (row.key.trim()) m[row.key.trim()] = row.value;
  }
  if (Object.keys(m).length) out.metadata = m;
  return out;
}

function extraOf(fm: SkillFrontmatter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!KNOWN_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

function metaRowsOf(fm: SkillFrontmatter): MetaRow[] {
  return Object.entries(normalizeMetadata(fm.metadata) ?? {}).map(([key, value], i) => ({ id: i, key, value }));
}

function Field({
  label,
  hint,
  children,
  count,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  count?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium text-fg">{label}</span>
        {count && <span className="text-[0.68rem] tabular-nums text-muted">{count}</span>}
      </div>
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent";

export default function SkillEditor({
  data,
  onSaved,
}: {
  data: SkillData;
  onSaved: (next: SkillData) => void;
}) {
  const fm = data.frontmatter;
  const [name, setName] = useState(asString(fm.name));
  const [description, setDescription] = useState(asString(fm.description));
  const [license, setLicense] = useState(asString(fm.license));
  const [compatibility, setCompatibility] = useState(asString(fm.compatibility));
  const [allowedTools, setAllowedTools] = useState(asString(fm["allowed-tools"]));
  const [meta, setMeta] = useState<MetaRow[]>(() => metaRowsOf(fm));
  const [body, setBody] = useState(data.body);
  const [tab, setTab] = useState<"edit" | "split" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Non-spec fields are preserved untouched across the save round-trip.
  const extraFields = useMemo(() => extraOf(fm), [fm]);

  const frontmatter: SkillFrontmatter = useMemo(
    () => buildFrontmatter({ name, description, license, compatibility, allowedTools, meta, extra: extraFields }),
    [extraFields, name, description, license, compatibility, allowedTools, meta],
  );

  const serialized = useMemo(() => serializeSkillMd(frontmatter, body), [frontmatter, body]);

  // Baseline = serialized form of the on-disk values, captured once at mount (and
  // updated on save). Comparing against this — not the raw bytes — avoids spurious
  // "dirty" from YAML key ordering or body normalization on a freshly loaded skill.
  const [baseline, setBaseline] = useState(() =>
    serializeSkillMd(
      buildFrontmatter({
        name: asString(fm.name),
        description: asString(fm.description),
        license: asString(fm.license),
        compatibility: asString(fm.compatibility),
        allowedTools: asString(fm["allowed-tools"]),
        meta: metaRowsOf(fm),
        extra: extraOf(fm),
      }),
      data.body,
    ),
  );
  const dirty = serialized !== baseline;

  const metaIssues = useMemo(() => {
    const trimmed = meta.map((r) => r.key.trim());
    const dup = new Set(trimmed.filter((k, i) => k && trimmed.indexOf(k) !== i));
    const emptyWithValue = meta.some((r) => !r.key.trim() && r.value.trim());
    return { dup, emptyWithValue };
  }, [meta]);

  const issues = useMemo(
    () =>
      validateSkill({
        frontmatter,
        body,
        hasFrontmatter: true,
        dirName: data.dirName,
        files: data.files,
      }),
    [frontmatter, body, data.dirName, data.files],
  );
  const errorCount = issues.filter((i) => i.level === "error").length;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: data.root, frontmatter, body }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setBaseline(serialized);
      onSaved(json as SkillData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      {/* Toolbar */}
      <div className="sticky top-0 z-10 -mx-6 mb-5 flex items-center gap-3 border-b border-border bg-app/90 px-6 py-3 backdrop-blur">
        <h2 className="font-mono text-sm font-semibold text-fg">Editing SKILL.md</h2>
        {dirty ? (
          <span className="text-xs text-warn">● unsaved changes</span>
        ) : (
          <span className="text-xs text-muted">saved</span>
        )}
        <div className="ml-auto flex items-center gap-3">
          {errorCount > 0 && <span className="text-xs text-danger">{errorCount} spec error{errorCount === 1 ? "" : "s"}</span>}
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving && <Spinner className="h-3.5 w-3.5" />}
            Save
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-[color-mix(in_srgb,var(--error)_40%,transparent)] bg-[color-mix(in_srgb,var(--error)_12%,transparent)] px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {/* Frontmatter form */}
      <section className="mb-6 space-y-4 rounded-xl border border-border bg-surface p-5">
        <div className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Frontmatter</div>

        <Field
          label="name *"
          hint="Lowercase, hyphen-separated; must match the folder name."
          count={`${name.length}/${LIMITS.nameMax}`}
        >
          <input className={`${inputCls} font-mono`} value={name} onChange={(e) => setName(e.target.value)} placeholder="my-skill" />
        </Field>

        <Field
          label="description *"
          hint="Describe what the skill does and when to use it."
          count={`${description.length}/${LIMITS.descriptionMax}`}
        >
          <textarea
            className={`${inputCls} min-h-20 resize-y`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Extract text from PDFs. Use when the user mentions PDFs or forms."
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="license">
            <input className={inputCls} value={license} onChange={(e) => setLicense(e.target.value)} placeholder="Apache-2.0" />
          </Field>
          <Field label="allowed-tools" hint="Space-separated (experimental).">
            <input
              className={`${inputCls} font-mono`}
              value={allowedTools}
              onChange={(e) => setAllowedTools(e.target.value)}
              placeholder="Bash(git:*) Read"
            />
          </Field>
        </div>

        <Field label="compatibility" count={`${compatibility.length}/${LIMITS.compatibilityMax}`}>
          <input
            className={inputCls}
            value={compatibility}
            onChange={(e) => setCompatibility(e.target.value)}
            placeholder="Requires Python 3.12+ and uv"
          />
        </Field>

        {/* metadata */}
        <div>
          <div className="mb-1.5 text-sm font-medium text-fg">metadata</div>
          <div className="space-y-2">
            {meta.map((row) => (
              <div key={row.id} className="flex gap-2">
                <input
                  className={`${inputCls} font-mono ${row.key.trim() && metaIssues.dup.has(row.key.trim()) ? "border-danger" : ""}`}
                  value={row.key}
                  placeholder="key"
                  onChange={(e) =>
                    setMeta((rows) => rows.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))
                  }
                />
                <input
                  className={inputCls}
                  value={row.value}
                  placeholder="value"
                  onChange={(e) =>
                    setMeta((rows) => rows.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))
                  }
                />
                <button
                  type="button"
                  onClick={() => setMeta((rows) => rows.filter((r) => r.id !== row.id))}
                  className="shrink-0 rounded-lg border border-border px-3 text-muted hover:text-danger"
                  title="Remove"
                  aria-label="Remove metadata field"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setMeta((rows) => [...rows, { id: Date.now() + rows.length, key: "", value: "" }])}
              className="rounded-lg border border-dashed border-border px-3 py-1.5 text-xs text-muted hover:border-accent hover:text-accent"
            >
              + Add metadata field
            </button>
            {(metaIssues.dup.size > 0 || metaIssues.emptyWithValue) && (
              <p className="text-xs text-warn">
                {metaIssues.dup.size > 0 && "Duplicate keys are merged (last value wins). "}
                {metaIssues.emptyWithValue && "Rows with an empty key are dropped on save."}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Body editor + preview */}
      <section className="mb-6 rounded-xl border border-border bg-surface">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Body (Markdown)</span>
          <div className="ml-auto flex overflow-hidden rounded-md border border-border text-xs">
            {(["edit", "split", "preview"] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={tab === t}
                onClick={() => setTab(t)}
                className={`px-2.5 py-1 capitalize ${tab === t ? "bg-accent font-semibold text-white" : "bg-surface text-muted hover:text-fg"}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className={`grid ${tab === "split" ? "md:grid-cols-2" : "grid-cols-1"}`}>
          {tab !== "preview" && (
            <div className="overflow-hidden border-border md:border-r">
              <CodeEditor value={body} language="markdown" onChange={setBody} height="520px" />
            </div>
          )}
          {tab !== "edit" && (
            <div className="max-h-[520px] overflow-auto border-t border-border px-5 py-4 md:border-t-0">
              {body.trim() ? (
                <Markdown content={body} root={data.root} />
              ) : (
                <p className="text-sm italic text-muted">Nothing to preview.</p>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Live validation */}
      <section>
        <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Live validation</div>
        <ValidationPanel issues={issues} />
      </section>
    </div>
  );
}
