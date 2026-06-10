// App-wide mining-run state: one module-level store any component can read
// (Home's Proposed section, the studio's mined-changes banner), polled from
// GET /api/mine/state — fast while a run is live, idle otherwise. Same
// external-store idiom as lib/remote.ts.
import { useSyncExternalStore } from "react";
import { mineState, type MineState } from "@/lib/api";

let state: MineState | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let fetching = false;
const subscribers = new Set<() => void>();

const RUNNING_POLL_MS = 2500;

function emit() {
  for (const fn of subscribers) fn();
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  // Only a live run changes state on its own; otherwise refreshes are
  // event-driven (start/stop/subscribe), so polling would be noise.
  if (subscribers.size > 0 && state?.status === "running") {
    timer = setTimeout(() => void refreshMining(), RUNNING_POLL_MS);
  }
}

/** Re-fetch now (and keep polling while a run is live). */
export async function refreshMining(): Promise<MineState | null> {
  if (fetching) return state;
  fetching = true;
  try {
    state = await mineState();
    emit();
  } catch {
    // Server unreachable or pre-mining build: keep whatever we had.
  } finally {
    fetching = false;
    schedule();
  }
  return state;
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  if (state === null && !fetching) void refreshMining();
  else schedule();
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/** The current mining-run state; null until the first fetch lands. */
export function useMining(): MineState | null {
  return useSyncExternalStore(subscribe, () => state);
}
