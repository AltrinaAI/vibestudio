"use client";

import { useState } from "react";
import { summarizeIssues, type ValidationIssue } from "@/lib/skill";

/**
 * A compact validation summary: a click-to-expand pill showing the count of
 * errors / warnings (or an all-clear label), backed by a popover that lists
 * every issue. Shared by the SKILL.md editor (spec validation) and the AGENTS.md
 * editor (the `agentmd` check) so both speak the same visual language.
 */
export default function ValidationPill({
  issues,
  okLabel = "Spec compliant",
}: {
  issues: ValidationIssue[];
  /** Label shown when there are no errors or warnings. */
  okLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const { errors, warnings, ok } = summarizeIssues(issues);
  const label = !ok
    ? `${errors} issue${errors === 1 ? "" : "s"}`
    : warnings > 0
      ? `${warnings} warning${warnings === 1 ? "" : "s"}`
      : okLabel;
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
