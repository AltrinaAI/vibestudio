"use client";

import { useCallback, useEffect, useState } from "react";
import { Spinner, ThemeToggle } from "./ui";
import NavBar from "./NavBar";
import { FolderIcon } from "./FileIcon";
import FolderPicker from "./FolderPicker";
import NewSkillDialog from "./NewSkillDialog";
import ImportSkillDialog from "./ImportSkillDialog";
import SecretsManager from "./SecretsManager";
import { useRecents, removeRecent } from "./recents";
import { agentColor, kindMeta, KIND_TAG, AGENT_GROUP_INFO } from "@/lib/agents";
import * as api from "@/lib/api";
import type { AgentSkills, DiscoveredSkill } from "@/lib/api";

const EXAMPLES = [
  { name: "docx", path: "examples/docx", blurb: "Create & edit Word documents" },
  { name: "pdf", path: "examples/pdf", blurb: "Extract, fill & process PDFs" },
  { name: "pptx", path: "examples/pptx", blurb: "Build PowerPoint decks" },
  { name: "xlsx", path: "examples/xlsx", blurb: "Read & write spreadsheets" },
];

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function ImportIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v10" />
      <path d="m8 9 4 4 4-4" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}
function KeyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}
function RefreshIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}
function TerminalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  );
}
const gridCls = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4";
const cardCls =
  "group flex flex-col gap-1.5 rounded-xl border border-border bg-surface p-3.5 text-left transition-colors hover:border-border-strong hover:bg-panel";

// Your own skills first, then official, then plugins; ties broken by name.
const byKindThenName = (a: DiscoveredSkill, b: DiscoveredSkill) =>
  kindMeta(a.kind).rank - kindMeta(b.kind).rank ||
  (a.name ?? baseName(a.root)).localeCompare(b.name ?? baseName(b.root));

function SkillCard({ skill, onOpen }: { skill: DiscoveredSkill; onOpen: (p: string) => void }) {
  const name = skill.name ?? baseName(skill.root);
  const tag = KIND_TAG[kindMeta(skill.kind).kind];
  return (
    <button type="button" onClick={() => onOpen(skill.root)} className={cardCls}>
      <div className="flex items-center gap-2">
        <FolderIcon open={false} name={name} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{name}</span>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide ${tag.cls}`}>
          {tag.label}
        </span>
      </div>
      {skill.project && (
        <span className="inline-flex max-w-full items-center gap-1 text-[0.7rem] font-medium text-accent" title={`Project skill in ${skill.project}`}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span className="truncate">{skill.project}</span>
        </span>
      )}
      {skill.description && <p className="line-clamp-2 text-xs leading-relaxed text-muted">{skill.description}</p>}
      <span className="mt-auto truncate pt-0.5 font-mono text-[0.7rem] text-faint" title={skill.root}>
        {skill.root}
      </span>
    </button>
  );
}

// One section per agent (the skill's source). Only your own skills show as cards;
// everything you didn't author — built-in/official skills and third-party plugins —
// collapses together behind a single toggle (default collapsed).
function AgentSection({ group, onOpen }: { group: AgentSkills; onOpen: (p: string) => void }) {
  const [showBundled, setShowBundled] = useState(false);
  if (group.skills.length === 0) return null;
  const own = group.skills.filter((s) => kindMeta(s.kind).kind === "personal").sort(byKindThenName);
  const bundled = group.skills.filter((s) => kindMeta(s.kind).kind !== "personal").sort(byKindThenName);
  const officialCount = bundled.filter((s) => kindMeta(s.kind).kind === "official").length;
  const pluginCount = bundled.length - officialCount;
  const bundledLabel = [
    officialCount ? `${officialCount} official` : null,
    pluginCount ? `${pluginCount} plugin${pluginCount === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const info = AGENT_GROUP_INFO[group.agent];
  return (
    <section>
      <div className="mb-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: agentColor(group.agent) }} aria-hidden />
          <h3 className="text-sm font-semibold text-fg">{group.agent}</h3>
          <span className="text-xs text-faint">{group.skills.length}</span>
        </div>
        {info && (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.72rem] text-muted">
            <span>Shared standard — read by</span>
            {info.sharedWith.map((a) => (
              <span key={a} className="inline-flex items-center gap-1 rounded-full bg-panel px-1.5 py-0.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: agentColor(a) }} aria-hidden />
                {a}
              </span>
            ))}
            <span>&amp; more.</span>
            {info.excludes.length > 0 && (
              <span className="text-faint">Not {info.excludes.join(", ")} — it keeps its own folder.</span>
            )}
          </p>
        )}
      </div>
      {own.length > 0 && (
        <div className={gridCls}>
          {own.map((s) => (
            <SkillCard key={s.root} skill={s} onOpen={onOpen} />
          ))}
        </div>
      )}
      {bundled.length > 0 && (
        <div className={own.length > 0 ? "mt-3" : ""}>
          <button
            type="button"
            onClick={() => setShowBundled((o) => !o)}
            aria-expanded={showBundled}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-fg"
          >
            <span className="w-3 text-faint" aria-hidden>
              {showBundled ? "▾" : "▸"}
            </span>
            {bundledLabel}
          </button>
          {showBundled && (
            <div className={`mt-3 ${gridCls}`}>
              {bundled.map((s) => (
                <SkillCard key={s.root} skill={s} onOpen={onOpen} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default function Home({
  onOpen,
  loading,
  error,
  toggleTheme,
  onOpenTerminals,
}: {
  onOpen: (path: string) => void;
  loading: boolean;
  error: string | null;
  toggleTheme: () => void;
  onOpenTerminals: () => void;
}) {
  const recents = useRecents();
  const [path, setPath] = useState("");
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    if (!secretsOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSecretsOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [secretsOpen]);

  const [discovered, setDiscovered] = useState<AgentSkills[]>([]);
  const [discovering, setDiscovering] = useState(true);
  const runDiscovery = useCallback(async () => {
    setDiscovering(true);
    try {
      setDiscovered(await api.discoverSkills());
    } catch {
      // Keep whatever was already found if a rescan fails.
    } finally {
      setDiscovering(false);
    }
  }, []);
  useEffect(() => {
    void runDiscovery();
  }, [runDiscovery]);

  const [showPicker, setShowPicker] = useState(false);
  const browse = async () => {
    if (api.isTauri) {
      const p = await api.pickSkillFolder();
      if (p) onOpen(p);
    } else {
      setShowPicker(true);
    }
  };

  const totalFound = discovered.reduce((n, g) => n + g.skills.length, 0);

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar>
        <button
          type="button"
          onClick={() => setNewOpen(true)}
          title="New skill"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted hover:bg-panel hover:text-fg"
        >
          <PlusIcon />
          <span className="hidden text-xs sm:inline">New</span>
        </button>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          title="Import a skill from a folder or .zip"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted hover:bg-panel hover:text-fg"
        >
          <ImportIcon />
          <span className="hidden text-xs sm:inline">Import</span>
        </button>
        <button
          type="button"
          onClick={onOpenTerminals}
          title="Open the terminals workspace"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted hover:bg-panel hover:text-fg"
        >
          <TerminalIcon />
          <span className="hidden text-xs sm:inline">Terminals</span>
        </button>
        <button
          type="button"
          onClick={() => setSecretsOpen(true)}
          title="Secrets"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted hover:bg-panel hover:text-fg"
        >
          <KeyIcon />
          <span className="hidden text-xs sm:inline">Secrets</span>
        </button>
        <ThemeToggle onClick={toggleTheme} />
      </NavBar>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 pb-24 pt-10">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Open a skill</h1>
          <p className="mt-1.5 text-sm text-muted">
            A skill is a folder containing a{" "}
            <code className="rounded bg-panel px-1 py-0.5 font-mono text-[0.8em]">SKILL.md</code>. Browse for one, paste a
            path, pick from the skills found on your machine below,{" "}
            <button type="button" onClick={() => setImportOpen(true)} className="font-medium text-accent underline hover:opacity-80">
              import a folder or .zip
            </button>
            , or{" "}
            <button type="button" onClick={() => setNewOpen(true)} className="font-medium text-accent underline hover:opacity-80">
              create a new one
            </button>
            .
          </p>

          <form
            className="mt-6 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (path.trim()) onOpen(path.trim());
            }}
          >
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/absolute/path/to/skill-folder"
              spellCheck={false}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-fg outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={browse}
              className="shrink-0 rounded-lg border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-panel"
            >
              Browse…
            </button>
            <button
              type="submit"
              disabled={loading || !path.trim()}
              aria-busy={loading}
              className="inline-flex min-w-20 items-center justify-center gap-2 rounded-lg bg-fg px-4 py-2 text-sm font-medium text-app disabled:opacity-40"
            >
              {loading ? <Spinner className="h-3.5 w-3.5" /> : "Open"}
            </button>
          </form>

          {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        </div>

        {recents.length > 0 && (
          <section className="mt-12">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted">Recent</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {recents.map((r) => (
                <div key={r.root} className="group relative">
                  <button
                    type="button"
                    onClick={() => onOpen(r.root)}
                    className="flex w-full flex-col gap-1 rounded-xl border border-border bg-surface p-3.5 pr-8 text-left transition-colors hover:border-border-strong hover:bg-panel"
                  >
                    <span className="truncate text-sm font-semibold text-fg">{r.name}</span>
                    <span className="truncate font-mono text-[0.7rem] text-faint" title={r.root}>
                      {r.root}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeRecent(r.root)}
                    aria-label={`Remove ${r.name} from recents`}
                    className="absolute right-2 top-2 rounded p-1 text-faint opacity-0 hover:text-danger group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mt-12">
          <div className="mb-4 flex items-center gap-2">
            <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
              Discovered
              {discovering ? <Spinner className="h-3 w-3" /> : <span className="text-faint">· {totalFound}</span>}
            </h2>
            <button
              type="button"
              onClick={() => void runDiscovery()}
              disabled={discovering}
              title="Rescan your machine for installed skills"
              aria-label="Refresh discovered skills"
              className="rounded-md p-1 text-muted hover:bg-panel hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RefreshIcon className={discovering ? "animate-spin" : ""} />
            </button>
          </div>
          {!discovering && totalFound === 0 ? (
            <p className="max-w-2xl text-sm text-muted">
              No installed skills found. Skills live under <code className="font-mono text-[0.8em]">~/.agents/skills</code>,{" "}
              <code className="font-mono text-[0.8em]">~/.claude/skills</code>,{" "}
              <code className="font-mono text-[0.8em]">~/.codex/skills</code>,{" "}
              <code className="font-mono text-[0.8em]">~/.cursor/skills-cursor</code>, and{" "}
              <code className="font-mono text-[0.8em]">~/.openclaw/skills</code>.
            </p>
          ) : (
            <div className="space-y-8">
              {discovered.map((g) => (
                <AgentSection key={g.agent} group={g} onOpen={onOpen} />
              ))}
            </div>
          )}
        </section>

        <section className="mt-12">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted">Examples</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {EXAMPLES.map((ex) => (
              <button key={ex.path} type="button" onClick={() => onOpen(ex.path)} className={cardCls}>
                <span className="font-mono text-sm font-semibold text-fg">{ex.name}</span>
                <span className="text-xs text-muted">{ex.blurb}</span>
              </button>
            ))}
          </div>
        </section>
      </main>

      {showPicker && (
        <FolderPicker
          onSelect={(p) => {
            setShowPicker(false);
            onOpen(p);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}

      {newOpen && (
        <NewSkillDialog
          onClose={() => setNewOpen(false)}
          onCreated={(root) => {
            setNewOpen(false);
            onOpen(root);
          }}
        />
      )}

      {importOpen && (
        <ImportSkillDialog
          onClose={() => setImportOpen(false)}
          onImported={(root) => {
            setImportOpen(false);
            onOpen(root);
          }}
        />
      )}

      {secretsOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setSecretsOpen(false)}>
          <div
            className="flex h-full w-full max-w-md flex-col overflow-hidden border-l border-border bg-surface shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border px-5 py-3">
              <KeyIcon />
              <span className="text-sm font-semibold text-fg">Secrets</span>
              <button
                type="button"
                onClick={() => setSecretsOpen(false)}
                aria-label="Close"
                className="ml-auto rounded-md p-1 text-faint hover:bg-panel hover:text-fg"
              >
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
              <SecretsManager />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
