"use client";

import { ThemeToggle } from "./ui";
import { BrandIcon } from "./FileIcon";
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
  root,
  toggleTheme,
}: {
  onHome: () => void;
  skillName: string;
  selected: string | null;
  root: string;
  toggleTheme: () => void;
}) {
  return (
    <header className="z-20 flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-sm">
      <button
        type="button"
        onClick={onHome}
        title="Back to home"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-fg hover:bg-panel"
      >
        <BrandIcon />
        <span className="font-medium">Agent Skill Studio</span>
      </button>
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
      <div className="ml-auto flex items-center gap-1">
        <SaveButton />
        <a
          href={`/api/download?path=${encodeURIComponent(root)}`}
          title="Download skill as .zip"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-panel hover:text-fg"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
          </svg>
          <span className="hidden sm:inline">Download</span>
        </a>
        <ThemeToggle onClick={toggleTheme} />
      </div>
    </header>
  );
}
