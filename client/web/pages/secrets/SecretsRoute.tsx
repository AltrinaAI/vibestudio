"use client";

import NavBar from "@/components/NavBar";
import LocalStoreCard from "./LocalStoreCard";
import ConnectionsCard from "./ConnectionsCard";
import ProviderGallery from "./ProviderGallery";

/**
 * The dedicated Secrets page (route: /secrets). A provider dashboard: the active
 * machine-local store up top, with future managed providers (1Password, Doppler,
 * a team cloud) queued in a quiet gallery below. Reachable from the Home nav bar
 * and the studio Manage drawer.
 */
export function Component() {
  return (
    <div className="flex min-h-dvh flex-col">
      <NavBar
        breadcrumb={
          <>
            <span className="text-faint" aria-hidden>
              /
            </span>
            <span className="font-medium text-fg">Secrets</span>
          </>
        }
      />

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 pb-24 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Secrets</h1>
        <p className="mt-1.5 max-w-prose text-sm text-muted">
          Store API keys and tokens once, then let your agents load them at runtime — never pasted into prompts or agent
          configs. For now they live on this machine; signing in to sync them to the cloud and share with your team is
          coming soon.
        </p>

        <div className="mt-8">
          <LocalStoreCard />
        </div>

        <div className="mt-6">
          <ConnectionsCard />
        </div>

        <ProviderGallery />
      </main>
    </div>
  );
}
