"use client";

import { Spinner } from "./ui";

export default function TopBar({
  pathInput,
  setPathInput,
  onLoad,
  loading,
  mode,
  setMode,
  toggleTheme,
  editable,
}: {
  pathInput: string;
  setPathInput: (v: string) => void;
  onLoad: () => void;
  loading: boolean;
  mode: "view" | "edit";
  setMode: (m: "view" | "edit") => void;
  toggleTheme: () => void;
  editable: boolean;
}) {
  return (
    <header className="z-20 flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
      <div className="flex items-center gap-2 pr-1 font-semibold text-fg">
        <span aria-hidden className="text-lg">📘</span>
        <span className="hidden sm:inline">Skill Viewer</span>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onLoad();
        }}
        className="flex max-w-2xl flex-1 items-center gap-2"
      >
        <input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          placeholder="/absolute/path/to/skill-folder"
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-app px-3 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
        <button
          type="submit"
          disabled={loading}
          aria-label="Load skill"
          aria-busy={loading}
          className="inline-flex min-w-18 items-center justify-center gap-2 rounded-lg border border-border bg-panel px-3.5 py-1.5 text-sm font-medium text-fg hover:border-accent disabled:opacity-50"
        >
          {loading ? <Spinner className="h-3.5 w-3.5" /> : "Load"}
        </button>
      </form>

      <div className="ml-auto flex items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-border text-sm">
          <button
            type="button"
            aria-pressed={mode === "view"}
            onClick={() => setMode("view")}
            className={`px-3 py-1.5 ${mode === "view" ? "bg-accent font-semibold text-white" : "bg-surface text-muted hover:text-fg"}`}
          >
            View
          </button>
          <button
            type="button"
            aria-pressed={mode === "edit"}
            onClick={() => editable && setMode("edit")}
            disabled={!editable}
            title={editable ? "Edit" : "Open a text file or SKILL.md to edit"}
            className={`px-3 py-1.5 ${
              mode === "edit" ? "bg-accent font-semibold text-white" : "bg-surface text-muted hover:text-fg"
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >
            Edit
          </button>
        </div>

        <button
          onClick={toggleTheme}
          title="Toggle theme"
          aria-label="Toggle theme"
          className="rounded-lg border border-border bg-surface p-1.5 text-fg hover:border-accent"
        >
          {/* Icon follows the .dark class via CSS so it stays correct without JS state. */}
          <svg className="hidden dark:block" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
          </svg>
          <svg className="block dark:hidden" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
