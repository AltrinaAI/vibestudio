"use client";

// Remembers the last New-terminal selections per agent (working directory and
// the per-agent toggles) in localStorage, so opening the dialog and picking an
// agent restores what you used last time instead of an empty form. Same plain
// localStorage approach as theme.ts / recents.ts. Keyed by AgentOption.id
// (e.g. "claude:cli"), so each agent flavor remembers its own config.

export interface TerminalPrefs {
  cwd: string;
  ide: boolean;
  skip: boolean;
  auto: boolean;
  extra: string;
}

const KEY = "skillviewer-terminal-prefs";

type Store = Record<string, TerminalPrefs>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

/** Last-used config for an agent, or null if it has never been launched. */
export function loadTerminalPrefs(agentId: string): TerminalPrefs | null {
  const p = read()[agentId];
  if (!p || typeof p !== "object") return null;
  return {
    cwd: typeof p.cwd === "string" ? p.cwd : "",
    ide: !!p.ide,
    skip: !!p.skip,
    auto: !!p.auto,
    extra: typeof p.extra === "string" ? p.extra : "",
  };
}

export function saveTerminalPrefs(agentId: string, prefs: TerminalPrefs) {
  if (!agentId) return;
  const store = read();
  store[agentId] = prefs;
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}
