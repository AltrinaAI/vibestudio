"use client";

import type { ValidationIssue, IssueLevel } from "@/lib/skill";
import { summarizeIssues } from "@/lib/skill";

const LEVEL_META: Record<IssueLevel, { glyph: string; cls: string; ring: string }> = {
  error: { glyph: "✕", cls: "text-danger", ring: "border-[color-mix(in_srgb,var(--error)_45%,transparent)]" },
  warning: { glyph: "▲", cls: "text-warn", ring: "border-[color-mix(in_srgb,var(--warning)_45%,transparent)]" },
  info: { glyph: "i", cls: "text-info", ring: "border-[color-mix(in_srgb,var(--info)_45%,transparent)]" },
};

const ORDER: Record<IssueLevel, number> = { error: 0, warning: 1, info: 2 };

export default function ValidationPanel({ issues }: { issues: ValidationIssue[] }) {
  const { errors, warnings, infos, ok } = summarizeIssues(issues);
  const sorted = [...issues].sort((a, b) => ORDER[a.level] - ORDER[b.level]);

  return (
    <div className="space-y-2">
      <div
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${
          ok
            ? "border-[color-mix(in_srgb,var(--ok)_40%,transparent)] bg-[color-mix(in_srgb,var(--ok)_12%,transparent)] text-ok"
            : "border-[color-mix(in_srgb,var(--error)_40%,transparent)] bg-[color-mix(in_srgb,var(--error)_12%,transparent)] text-danger"
        }`}
      >
        <span aria-hidden>{ok ? "✓" : "✕"}</span>
        <span>
          {ok ? "Spec compliant" : `${errors} error${errors === 1 ? "" : "s"}`}
        </span>
        <span className="ml-auto text-xs font-normal text-muted">
          {warnings > 0 && <span className="text-warn">{warnings} warn</span>}
          {warnings > 0 && infos > 0 && " · "}
          {infos > 0 && <span className="text-info">{infos} info</span>}
        </span>
      </div>

      {sorted.length > 0 && (
        <ul className="space-y-1.5">
          {sorted.map((issue, i) => {
            const meta = LEVEL_META[issue.level];
            return (
              <li
                key={i}
                className={`flex gap-2 rounded-md border bg-surface px-2.5 py-1.5 text-xs ${meta.ring}`}
              >
                <span className={`mt-px font-bold ${meta.cls}`} aria-hidden>
                  {meta.glyph}
                </span>
                <span className="leading-relaxed">
                  <code className="rounded bg-panel px-1 py-px font-mono text-[0.7rem] text-muted">
                    {issue.field}
                  </code>{" "}
                  <span className="text-fg">{issue.message}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
