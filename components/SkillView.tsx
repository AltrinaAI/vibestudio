"use client";

import Markdown from "./Markdown";
import { Badge } from "./ui";
import { parseAllowedTools, normalizeMetadata, LIMITS } from "@/lib/skill";
import type { SkillData } from "@/lib/types";
import { humanSize } from "@/lib/fileTypes";

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn" | "default";
}) {
  return (
    <div className="flex flex-col">
      <span className={`text-sm font-semibold tabular-nums ${tone === "warn" ? "text-warn" : "text-fg"}`}>
        {value}
      </span>
      <span className="text-[0.68rem] uppercase tracking-wide text-muted">{label}</span>
    </div>
  );
}

export default function SkillView({
  data,
  onNavigate,
}: {
  data: SkillData;
  onNavigate?: (rel: string) => void;
}) {
  const fm = data.frontmatter;
  const name = typeof fm.name === "string" ? fm.name : data.dirName;
  const description = typeof fm.description === "string" ? fm.description : "";
  const tools = parseAllowedTools(fm["allowed-tools"]);
  const metadata = normalizeMetadata(fm.metadata) ?? {};
  const license = typeof fm.license === "string" ? fm.license : undefined;
  const compatibility = typeof fm.compatibility === "string" ? fm.compatibility : undefined;

  return (
    <article className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-8 border-b border-border pb-6">
        <div className="mb-2 flex items-center gap-2">
          <Badge tone="accent">Agent Skill</Badge>
          <span className="font-mono text-xs text-muted">SKILL.md</span>
        </div>
        <h1 className="font-mono text-3xl font-bold tracking-tight text-fg">{name}</h1>
        {description && <p className="mt-3 text-base leading-relaxed text-muted">{description}</p>}

        {(license || compatibility || tools.length > 0 || Object.keys(metadata).length > 0) && (
          <div className="mt-5 flex flex-wrap gap-2">
            {license && <Badge tone="muted" title="license">⚖ {license}</Badge>}
            {compatibility && (
              <Badge tone="info" title={`compatibility: ${compatibility}`}>
                🧩 {compatibility.length > 60 ? compatibility.slice(0, 57) + "…" : compatibility}
              </Badge>
            )}
            {Object.entries(metadata).map(([k, v]) => (
              <Badge key={k} tone="default" title={`metadata.${k}`}>
                <span className="text-muted">{k}:</span> {v}
              </Badge>
            ))}
          </div>
        )}

        {tools.length > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">
              Allowed tools
            </div>
            <div className="flex flex-wrap gap-1.5">
              {tools.map((t) => (
                <span
                  key={t}
                  className="rounded-md border border-border bg-panel px-2 py-0.5 font-mono text-xs text-fg"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-x-8 gap-y-3">
          <Stat
            label="body lines"
            value={`${data.stats.bodyLines} / ${LIMITS.bodyMaxLines}`}
            tone={data.stats.bodyLines > LIMITS.bodyMaxLines ? "warn" : "default"}
          />
          <Stat
            label="≈ tokens"
            value={`${data.stats.bodyTokens} / ${LIMITS.bodyMaxTokens}`}
            tone={data.stats.bodyTokens > LIMITS.bodyMaxTokens ? "warn" : "default"}
          />
          <Stat label="files" value={String(data.stats.fileCount)} />
          <Stat label="folders" value={String(data.stats.dirCount)} />
          <Stat label="size" value={humanSize(data.stats.totalBytes)} />
        </div>
      </header>

      {data.body.trim() ? (
        <Markdown content={data.body} root={data.root} onNavigate={onNavigate} />
      ) : (
        <p className="text-sm italic text-muted">This skill has no instructions in its body.</p>
      )}
    </article>
  );
}
