// The secret SOURCES the page knows about. Today exactly one is functional — the
// machine-local store, rendered by LocalStoreCard. Everything else is a managed
// vault we intend to connect to (1Password, Doppler, a team cloud) and lives here
// as a "soon" descriptor that ProviderGallery renders as a disabled Connect card.
//
// Growing this is additive: when a provider goes live, build its own card
// component (mirroring LocalStoreCard) and stack it above the gallery; the entry
// below stops being "soon". No layout, route, or chrome change is needed.

export type ProviderStatus = "active" | "soon";

/** Which glyph ProviderGallery renders for a provider (icons live there, with the
 *  rest of the page's components, keeping this module pure data). */
export type ProviderIcon = "1password" | "doppler" | "cloud";

export interface Provider {
  /** Stable id (also the future api.ts namespace, e.g. `doppler*`). */
  id: string;
  name: string;
  /** One line shown on the card. */
  blurb: string;
  status: ProviderStatus;
  icon: ProviderIcon;
}

export const FUTURE_PROVIDERS: Provider[] = [
  { id: "1password", name: "1Password", blurb: "Pull secrets straight from your 1Password vaults.", status: "soon", icon: "1password" },
  { id: "doppler", name: "Doppler", blurb: "Sync from your Doppler projects and configs.", status: "soon", icon: "doppler" },
  { id: "studio-cloud", name: "VibeStudio Cloud", blurb: "A team-shared vault for your whole org.", status: "soon", icon: "cloud" },
];
