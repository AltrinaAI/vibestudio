"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/ui";
import NavBar from "@/components/NavBar";
import { FolderIcon } from "@/components/FileIcon";
import FolderPicker from "@/components/FolderPicker";
import NewSkillDialog from "./NewSkillDialog";
import ImportSkillDialog from "./ImportSkillDialog";
import { useConfirm } from "@/components/useConfirm";
import { useRecents, removeRecent } from "@/lib/recents";
import { agentColor, kindMeta, KIND_TAG, AGENT_GROUP_INFO } from "@/lib/agents";
import * as api from "@/lib/api";
import type { AgentSkills, DiscoveredSkill } from "@/lib/api";
import { useNavigate } from "react-router-dom";
import { studioPath } from "@/lib/routes";

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
const gridCls = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4";
const cardCls =
  "group flex flex-col gap-1.5 rounded-xl border border-border bg-surface p-3.5 text-left transition-colors hover:border-border-strong hover:bg-panel";
// Proposed cards carry their own action buttons, so they're a static container
// (not a button) and wear a faint info-tinted border to stand apart.
const proposedCardCls =
  "flex flex-col gap-1.5 rounded-xl border border-[color-mix(in_srgb,var(--info)_35%,transparent)] bg-surface p-3.5 text-left";
const pillCls = "shrink-0 rounded-full px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide";

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/** Pill flagging a skill with uncommitted git changes in its own folder. */
function ChangesTag() {
  return (
    <span
      title="Uncommitted changes — open to review and save a version"
      className={`inline-flex items-center gap-1 ${pillCls} bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] text-warn`}
    >
      <span className="h-1 w-1 rounded-full bg-warn" aria-hidden />
      Changes
    </span>
  );
}

/** Pill flagging a generated draft awaiting acceptance. */
function ProposedTag() {
  return (
    <span
      title="Proposed skill — accept to add it to your skills, or discard it"
      className={`${pillCls} bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-info`}
    >
      Proposed
    </span>
  );
}

// Your own skills first, then official, then plugins; ties broken by name.
const byKindThenName = (a: DiscoveredSkill, b: DiscoveredSkill) =>
  kindMeta(a.kind).rank - kindMeta(b.kind).rank ||
  (a.name ?? baseName(a.root)).localeCompare(b.name ?? baseName(b.root));

function SkillCard({
  skill,
  dirty,
  deletable,
  deleting,
  onOpen,
  onDelete,
}: {
  skill: DiscoveredSkill;
  dirty?: boolean;
  deletable?: boolean;
  deleting?: boolean;
  onOpen: (p: string) => void;
  onDelete?: (skill: DiscoveredSkill) => void;
}) {
  const name = skill.name ?? baseName(skill.root);
  const tag = KIND_TAG[kindMeta(skill.kind).kind];
  return (
    <div className="group relative h-full">
      {/* h-full + w-full: a <button> shrink-wraps its content (unlike a div), so
          inside this wrapper it must be told to fill the grid cell — w-full or it
          overflows the column, h-full so sibling cards stay equal-height and the
          delete control anchors to the real card bottom (not floating in dead
          space below a short card). */}
      <button type="button" onClick={() => onOpen(skill.root)} className={`${cardCls} h-full w-full`}>
        <div className="flex items-center gap-2">
          <FolderIcon open={false} name={name} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{name}</span>
          {dirty && <ChangesTag />}
          <span className={`${pillCls} ${tag.cls}`}>
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
        <span className="mt-auto truncate pt-0.5 pr-7 font-mono text-[0.7rem] text-faint" title={skill.root}>
          {skill.root}
        </span>
      </button>
      {deletable && onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onDelete(skill);
          }}
          disabled={deleting}
          aria-label={`Delete ${name}`}
          title="Delete skill"
          className="absolute bottom-2 right-2 rounded p-1 text-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 disabled:opacity-40 group-hover:disabled:opacity-40"
        >
          {deleting ? <Spinner className="h-3 w-3" /> : <TrashIcon />}
        </button>
      )}
    </div>
  );
}

// One section per agent (the skill's source). Only your own skills show as cards;
// everything you didn't author — built-in/official skills and third-party plugins —
// collapses together behind a single toggle (default collapsed).
function AgentSection({
  group,
  dirtyRoots,
  deletingRoot,
  onOpen,
  onDelete,
}: {
  group: AgentSkills;
  dirtyRoots: Set<string>;
  deletingRoot: string | null;
  onOpen: (p: string) => void;
  onDelete: (skill: DiscoveredSkill) => void;
}) {
  const [showBundled, setShowBundled] = useState(false);
  if (group.skills.length === 0) return null;
  const own = group.skills.filter((s) => kindMeta(s.kind).kind === "personal").sort(byKindThenName);
  const bundled = group.skills.filter((s) => kindMeta(s.kind).kind !== "personal").sort(byKindThenName);
  // The Skill Studio activation skill counts as official here; its distinct
  // badge sets it apart in the list, so it needs no separate tally.
  const officialCount = bundled.filter((s) => {
    const k = kindMeta(s.kind).kind;
    return k === "official" || k === "studio";
  }).length;
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
            <SkillCard
              key={s.root}
              skill={s}
              dirty={dirtyRoots.has(s.root)}
              deletable
              deleting={deletingRoot === s.root}
              onOpen={onOpen}
              onDelete={onDelete}
            />
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
                <SkillCard key={s.root} skill={s} dirty={dirtyRoots.has(s.root)} onOpen={onOpen} onDelete={onDelete} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// A generated draft staged under `generated-skills/`. Unlike a SkillCard it isn't
// a single button — it carries Open / Accept / Discard actions — so it's a static
// container with its own controls.
function ProposedCard({
  skill,
  busy,
  onOpen,
  onAccept,
  onDiscard,
}: {
  skill: DiscoveredSkill;
  busy: boolean;
  onOpen: (p: string) => void;
  onAccept: (root: string) => void;
  onDiscard: (root: string, name: string) => void;
}) {
  const name = skill.name ?? baseName(skill.root);
  return (
    <div className={proposedCardCls}>
      <div className="flex items-center gap-2">
        <FolderIcon open={false} name={name} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{name}</span>
        <ProposedTag />
      </div>
      {skill.description && <p className="line-clamp-2 text-xs leading-relaxed text-muted">{skill.description}</p>}
      <span className="truncate pt-0.5 font-mono text-[0.7rem] text-faint" title={skill.root}>
        {skill.root}
      </span>
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onOpen(skill.root)}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg hover:bg-panel"
        >
          Open
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAccept(skill.root)}
          title="Move this skill out of generated-skills/ into your skills home"
          className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"
        >
          {busy ? <Spinner className="h-3 w-3" /> : <CheckIcon />}
          Accept
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDiscard(skill.root, name)}
          title="Delete this proposed skill"
          className="ml-auto rounded-md px-2.5 py-1 text-xs font-medium text-faint hover:text-danger disabled:opacity-40"
        >
          Discard
        </button>
      </div>
    </div>
  );
}

function ProposedSection({
  skills,
  busyRoot,
  error,
  onOpen,
  onAccept,
  onDiscard,
}: {
  skills: DiscoveredSkill[];
  busyRoot: string | null;
  error: string | null;
  onOpen: (p: string) => void;
  onAccept: (root: string) => void;
  onDiscard: (root: string, name: string) => void;
}) {
  return (
    <section className="mt-12">
      <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
        Proposed skills <span className="text-faint">· {skills.length}</span>
      </h2>
      <p className="mb-4 mt-1.5 max-w-2xl text-sm text-muted">
        Freshly generated drafts staged under{" "}
        <code className="font-mono text-[0.8em]">generated-skills/</code> (e.g. by the skill-miner). Accept one to move
        it into your skills home, or discard it.
      </p>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <div className={gridCls}>
        {skills.map((s) => (
          <ProposedCard
            key={s.root}
            skill={s}
            busy={busyRoot === s.root}
            onOpen={onOpen}
            onAccept={onAccept}
            onDiscard={onDiscard}
          />
        ))}
      </div>
    </section>
  );
}

export function Component() {
  const recents = useRecents();
  const navigate = useNavigate();
  const onOpen = (p: string) => navigate(studioPath(p));
  const [path, setPath] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const [discovered, setDiscovered] = useState<AgentSkills[]>([]);
  const [discovering, setDiscovering] = useState(true);
  const [dirtyRoots, setDirtyRoots] = useState<Set<string>>(new Set());
  const [busyRoot, setBusyRoot] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const confirm = useConfirm();
  // Bumped on every scan; a slower in-flight scan (or its background dirty fetch)
  // checks this before committing state so it can't clobber a newer scan's results.
  const discoveryEpoch = useRef(0);
  const runDiscovery = useCallback(async () => {
    const epoch = ++discoveryEpoch.current;
    setDiscovering(true);
    try {
      const groups = await api.discoverSkills();
      if (epoch !== discoveryEpoch.current) return; // a newer scan superseded us
      setDiscovered(groups);
      // Flag which skills have uncommitted changes in the background — one batch
      // call, so the list paints immediately and the badges fill in after. Skip
      // proposed drafts: they sit in a staging dir that isn't a repo, so never dirty.
      const roots = groups.flatMap((g) => g.skills.filter((s) => !s.proposed).map((s) => s.root));
      void api
        .gitDirtyMany(roots)
        .then((states) => {
          if (epoch === discoveryEpoch.current) {
            setDirtyRoots(new Set(states.filter((d) => d.dirty).map((d) => d.root)));
          }
        })
        .catch(() => {});
    } catch {
      // Keep whatever was already found if a rescan fails.
    } finally {
      if (epoch === discoveryEpoch.current) setDiscovering(false);
    }
  }, []);
  useEffect(() => {
    void runDiscovery();
  }, [runDiscovery]);

  const acceptProposed = useCallback(
    async (root: string) => {
      setBusyRoot(root);
      setActionError(null);
      try {
        await api.promoteSkill(root);
        await runDiscovery();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyRoot(null);
      }
    },
    [runDiscovery],
  );
  const discardProposed = useCallback(
    async (root: string, name: string) => {
      if (
        !(await confirm({
          title: `Discard “${name}”?`,
          body: `This permanently deletes ${root}.`,
          confirmLabel: "Discard",
          danger: true,
        }))
      )
        return;
      setBusyRoot(root);
      setActionError(null);
      try {
        await api.deleteSkill(root);
        await runDiscovery();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyRoot(null);
      }
    },
    [runDiscovery, confirm],
  );
  const doDelete = useCallback(
    async (skill: DiscoveredSkill) => {
      const name = skill.name ?? baseName(skill.root);
      // Be honest about what's deleted. A project skill is a real folder inside the
      // project repo (never a link) — say so. Otherwise it may be a synced link
      // (only the link is removed) or a real folder.
      const body = skill.project
        ? `This permanently deletes the real skill folder from your “${skill.project}” project on disk. This can’t be undone.`
        : `This permanently removes the skill folder from disk. If it’s a synced link, only the link is removed; a real folder is deleted outright. This can’t be undone.`;
      if (!(await confirm({ title: `Delete “${name}”?`, body, confirmLabel: "Delete", danger: true }))) return;
      setBusyRoot(skill.root);
      setActionError(null);
      try {
        await api.deleteSkill(skill.root);
        removeRecent(skill.root); // drop any stale Recent entry pointing at the deleted folder
        await runDiscovery();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyRoot(null);
      }
    },
    [runDiscovery, confirm],
  );

  const [showPicker, setShowPicker] = useState(false);
  const browse = () => setShowPicker(true);

  // Proposed drafts surface in their own section; the per-agent "Discovered" list
  // shows everything else.
  const proposed = discovered.flatMap((g) => g.skills.filter((s) => s.proposed));
  const groups = discovered.map((g) => ({ ...g, skills: g.skills.filter((s) => !s.proposed) }));
  const totalFound = groups.reduce((n, g) => n + g.skills.length, 0);

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
              className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-strong"
            >
              Browse…
            </button>
            <button
              type="submit"
              disabled={!path.trim()}
              className="inline-flex min-w-20 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
            >
              Open
            </button>
          </form>
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

        {proposed.length > 0 && (
          <ProposedSection
            skills={proposed}
            busyRoot={busyRoot}
            error={actionError}
            onOpen={onOpen}
            onAccept={acceptProposed}
            onDiscard={discardProposed}
          />
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
          {actionError && <p className="mb-3 text-sm text-danger">{actionError}</p>}
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
              {groups.map((g) => (
                <AgentSection
                  key={g.agent}
                  group={g}
                  dirtyRoots={dirtyRoots}
                  deletingRoot={busyRoot}
                  onOpen={onOpen}
                  onDelete={doDelete}
                />
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
    </div>
  );
}
