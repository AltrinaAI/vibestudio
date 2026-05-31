"use client";

import type { ReactNode } from "react";

export type Tone = "default" | "accent" | "ok" | "warn" | "danger" | "info" | "muted";

const TONE_CLASSES: Record<Tone, string> = {
  default: "bg-panel text-fg border-border",
  muted: "bg-panel text-muted border-border",
  accent: "border-transparent text-white",
  ok: "bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-ok border-[color-mix(in_srgb,var(--ok)_35%,transparent)]",
  warn: "bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-warn border-[color-mix(in_srgb,var(--warning)_35%,transparent)]",
  danger: "bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-danger border-[color-mix(in_srgb,var(--error)_35%,transparent)]",
  info: "bg-[color-mix(in_srgb,var(--info)_14%,transparent)] text-info border-[color-mix(in_srgb,var(--info)_35%,transparent)]",
};

export function Badge({
  children,
  tone = "default",
  title,
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
  className?: string;
}) {
  const accentStyle = tone === "accent" ? { background: "var(--accent)" } : undefined;
  return (
    <span
      title={title}
      style={accentStyle}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      role="status"
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      aria-label="Loading"
    />
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1.5 pt-3 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">
      {children}
    </div>
  );
}
