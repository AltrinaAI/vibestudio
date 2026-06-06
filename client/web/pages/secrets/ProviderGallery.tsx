"use client";

import type { ReactNode } from "react";
import { PreviewBadge } from "@/components/ui";
import { FUTURE_PROVIDERS, type Provider, type ProviderIcon } from "./providers";

// A deliberately quiet gallery: plain border/surface cards (no info-tint), a
// disabled Connect on each, and ONE shared "coming soon" caption — so the unbuilt
// providers read as a calm roadmap, not a call to action. Mirrors the studio's
// CollaborateSection idiom (disabled control + PreviewBadge + caption).

// Inline line glyphs, matching the app's icon style (24×24, stroke=currentColor,
// round caps), keyed by the provider's `icon` so the registry stays pure data.
const ICONS: Record<ProviderIcon, () => ReactNode> = {
  "1password": () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6" />
      <circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  ),
  doppler: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2a10 10 0 0 1 0 20" />
      <path d="M5 5a10 10 0 0 0 0 14" opacity="0.5" />
    </svg>
  ),
  cloud: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 18a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 9.5a3.5 3.5 0 0 1-.5 8.5z" />
    </svg>
  ),
};

function ProviderCard({ provider }: { provider: Provider }) {
  const Icon = ICONS[provider.icon];
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3.5">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-panel text-muted" aria-hidden>
          <Icon />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{provider.name}</span>
      </div>
      <p className="min-h-8 text-xs leading-relaxed text-muted">{provider.blurb}</p>
      <button
        type="button"
        disabled
        title="Coming soon — not yet functional"
        className="mt-0.5 cursor-not-allowed rounded-md border border-border px-3 py-1.5 text-sm text-faint"
      >
        Connect
      </button>
    </div>
  );
}

export default function ProviderGallery() {
  return (
    <section className="mt-10">
      <div className="mb-1.5 flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Connect a provider</h2>
        <PreviewBadge />
      </div>
      <p className="mb-4 max-w-prose text-sm text-muted">
        Pull secrets from a managed vault instead of this machine — bring your own, or share one across your team.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FUTURE_PROVIDERS.map((p) => (
          <ProviderCard key={p.id} provider={p} />
        ))}
      </div>
      <p className="mt-3 text-[0.7rem] text-faint">Coming soon — not yet functional.</p>
    </section>
  );
}
