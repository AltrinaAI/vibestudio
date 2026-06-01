"use client";

import { ThemeToggle } from "./ui";
import NavBar from "./NavBar";
import { requestSave, useEditorStatus } from "./editorState";

function SaveButton() {
  const { present, dirty, saving, error } = useEditorStatus();
  if (!present) return null;

  const label = error ? "Retry save" : saving ? "Saving…" : dirty ? "Save" : "Saved";
  const canSave = dirty && !saving;

  return (
    <button
      type="button"
      onClick={requestSave}
      disabled={!canSave}
      title={error ?? (canSave ? "Save changes (⌘S)" : "All changes saved")}
      aria-live="polite"
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
        error
          ? "text-danger hover:bg-panel"
          : canSave
            ? "bg-accent text-white hover:opacity-90"
            : "text-muted"
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          error ? "bg-danger" : dirty ? "bg-current" : "bg-ok"
        }`}
      />
      {label}
      {canSave && <kbd className="ml-0.5 font-sans text-[0.65rem] opacity-70">⌘S</kbd>}
    </button>
  );
}

export default function TopBar({
  onHome,
  skillName,
  selected,
  onManage,
  onExport,
  toggleTheme,
}: {
  onHome: () => void;
  skillName: string;
  selected: string | null;
  onManage: () => void;
  onExport: () => void;
  toggleTheme: () => void;
}) {
  return (
    <NavBar
      onHome={onHome}
      breadcrumb={
        <>
          <span className="text-faint" aria-hidden>
            /
          </span>
          <span className="truncate font-medium text-fg">{skillName}</span>
          {selected && selected !== "SKILL.md" && (
            <>
              <span className="text-faint" aria-hidden>
                /
              </span>
              <span className="truncate font-mono text-xs text-muted">{selected}</span>
            </>
          )}
        </>
      }
    >
      <SaveButton />
      <button
        type="button"
        onClick={onManage}
        title="Version, sync & collaborate"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-panel hover:text-fg"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="18" cy="9" r="2.5" />
          <path d="M6 8.5v7M8.4 6.6c5 .3 7.5 1 7.5 4.4M18 11.5c0 3-2.5 4-6 4.2" />
        </svg>
        <span className="hidden sm:inline">Manage</span>
      </button>
      <button
        type="button"
        onClick={onExport}
        title="Export skill as .zip"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-panel hover:text-fg"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
        </svg>
        <span className="hidden sm:inline">Export .zip</span>
      </button>
      <ThemeToggle onClick={toggleTheme} />
    </NavBar>
  );
}
