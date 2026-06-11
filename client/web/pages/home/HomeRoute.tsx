"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Spinner, btnGhost, btnPrimary } from "@/components/ui";
import NavBar from "@/components/NavBar";
import { Modal } from "@/components/Modal";
import { FileIcon, FolderIcon } from "@/components/FileIcon";
import FolderPicker from "@/components/FolderPicker";
import NewSkillDialog from "./NewSkillDialog";
import ImportSkillDialog from "./ImportSkillDialog";
import MineDialog from "./MineDialog";
import { useConfirm } from "@/components/useConfirm";
import { useRecents, removeRecent, type Recent } from "@/lib/recents";
import { agentColor, kindMeta, KIND_TAG, AGENT_GROUP_INFO } from "@/lib/agents";
import * as api from "@/lib/api";
import type { AgentSkills, DiscoveredSkill, MineState } from "@/lib/api";
import { useMining, refreshMining } from "@/lib/mining";
import { useNavigate } from "react-router-dom";
import { studioPath, markdownPath, terminalsPath } from "@/lib/routes";

const EXAMPLES = [
  { name: "docx", path: "examples/docx", blurb: "Create & edit Word documents" },
  { name: "pdf", path: "examples/pdf", blurb: "Extract, fill & process PDFs" },
  { name: "pptx", path: "examples/pptx", blurb: "Build PowerPoint decks" },
  { name: "xlsx", path: "examples/xlsx", blurb: "Read & write spreadsheets" },
];

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Markdown-family extension — a pasted path ending this way opens as a loose file. */
const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;

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
// (not a button) and wear a faint green-tinted border to stand apart inside the
// Discovered grid they share with ordinary skills.
const proposedCardCls =
  "flex flex-col gap-1.5 rounded-xl border border-[color-mix(in_srgb,var(--ok)_40%,transparent)] bg-surface p-3.5 text-left";
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

/** Pill flagging a generated draft awaiting acceptance — green dot: new and
 *  positive, but not yours until accepted. */
function ProposedTag() {
  return (
    <span
      title="Proposed skill — accept to add it to your skills, or discard it"
      className={`inline-flex items-center gap-1 ${pillCls} bg-[color-mix(in_srgb,var(--ok)_16%,transparent)] text-ok`}
    >
      <span className="h-1 w-1 rounded-full bg-ok" aria-hidden />
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
          <span className="inline-flex max-w-full items-center gap-1 text-xs font-medium text-accent" title={`Project skill in ${skill.project}`}>
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

// One section per agent (the skill's source). Mined proposals lead the grid
// (green-tinted, awaiting acceptance), then your own skills; everything you
// didn't author — built-in/official skills and third-party plugins — collapses
// together behind a single toggle (default collapsed).
function AgentSection({
  group,
  dirtyRoots,
  deletingRoot,
  busyRoot,
  evidenceFor,
  onOpen,
  onDelete,
  onAccept,
  onDiscard,
}: {
  group: AgentSkills;
  dirtyRoots: Set<string>;
  deletingRoot: string | null;
  busyRoot: string | null;
  evidenceFor: (root: string) => string | undefined;
  onOpen: (p: string) => void;
  onDelete: (skill: DiscoveredSkill) => void;
  onAccept: (root: string) => void;
  onDiscard: (root: string, name: string) => void;
}) {
  const [showBundled, setShowBundled] = useState(false);
  if (group.skills.length === 0) return null;
  const proposals = group.skills.filter((s) => s.proposed).sort(byKindThenName);
  const own = group.skills
    .filter((s) => !s.proposed && kindMeta(s.kind).kind === "personal")
    .sort(byKindThenName);
  const bundled = group.skills
    .filter((s) => !s.proposed && kindMeta(s.kind).kind !== "personal")
    .sort(byKindThenName);
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
  const bundledToggle =
    bundled.length > 0 ? (
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
    ) : null;
  return (
    <section>
      <div className="mb-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: agentColor(group.agent) }} aria-hidden />
          <h3 className="text-sm font-semibold text-fg">{group.agent}</h3>
          <span className="text-xs text-faint">{group.skills.length}</span>
          {/* No cards to anchor the section: the bundled toggle joins the
              header row instead of dangling alone beneath it. */}
          {own.length === 0 && proposals.length === 0 && bundledToggle}
        </div>
        {info && (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
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
      {(own.length > 0 || proposals.length > 0) && (
        <div className={gridCls}>
          {proposals.map((s) => (
            <ProposedCard
              key={s.root}
              skill={s}
              evidence={evidenceFor(s.root)}
              busy={busyRoot === s.root}
              onOpen={onOpen}
              onAccept={onAccept}
              onDiscard={onDiscard}
            />
          ))}
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
      {(own.length > 0 || proposals.length > 0) && bundledToggle && <div className="mt-3">{bundledToggle}</div>}
      {showBundled && bundled.length > 0 && (
        <div className={`mt-3 ${gridCls}`}>
          {bundled.map((s) => (
            <SkillCard key={s.root} skill={s} dirty={dirtyRoots.has(s.root)} onOpen={onOpen} onDelete={onDelete} />
          ))}
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
  evidence,
  busy,
  onOpen,
  onAccept,
  onDiscard,
}: {
  skill: DiscoveredSkill;
  /** "seen in N sessions · M projects" from the mining run, when it staged this draft. */
  evidence?: string;
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
      {evidence && <p className="text-xs font-medium text-info">{evidence}</p>}
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
          className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-strong disabled:opacity-40"
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

function PickaxeIcon({ className = "", size = 13 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M14.531 12.469 6.619 20.38a1 1 0 1 1-3-3l7.912-7.912" />
      <path d="M15.686 4.314A12.5 12.5 0 0 0 5.461 2.958 1 1 0 0 0 5.58 4.71a22 22 0 0 1 6.318 3.393" />
      <path d="M17.7 3.7a1 1 0 0 0-1.4 0l-4.6 4.6a1 1 0 0 0 0 1.4l2.6 2.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z" />
      <path d="M19.686 8.314a12.5 12.5 0 0 1 1.356 10.225 1 1 0 0 1-1.751-.119 22 22 0 0 0-3.393-6.319" />
    </svg>
  );
}

function timeAgo(unix: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - unix) / 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Plain words for the run's current stage (the terminal has the detail). */
function stageText(mining: MineState): string {
  if (mining.stage === "analyzing")
    return mining.found ? `Analyzing ${Math.min(mining.found, 100)} sessions…` : "Analyzing your sessions…";
  if (mining.stage === "reviewing") return "Reading sessions & drafting skills…";
  return "Scanning your sessions…";
}

// Mining's door: a compact side card (content — discovered and mined skills —
// leads the page). Carries the start button, the live run status (Watch/Stop),
// the last-run line, the after-run conversation link, and the run's edits to
// existing skills. Proposed NEW skills land inline in the Discovered grid.
// `wide` is the no-recents variant: a slim full-width banner (description left,
// actions right) instead of a column card.
function MineCard({
  mining,
  wide = false,
  onMine,
  onStop,
  onWatch,
  onContinue,
  onOpen,
}: {
  mining: MineState | null;
  wide?: boolean;
  onMine: () => void;
  onStop: () => void;
  onWatch: () => void;
  onContinue: () => Promise<void>;
  onOpen: (p: string) => void;
}) {
  const running = mining?.status === "running";
  const hasRun = mining != null && mining.status !== "idle";
  const improved = mining?.improved ?? [];
  const [continuing, setContinuing] = useState(false);
  const description = (
    <p className="text-xs leading-relaxed text-muted">Analyze your conversations to create / update skills</p>
  );
  const actions =
    running && mining ? (
      <div className={`flex items-center gap-2 text-xs ${wide ? "min-w-0" : "mt-auto pt-1"}`}>
        <Spinner className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-muted">{stageText(mining)}</span>
        <button type="button" onClick={onWatch} className="shrink-0 font-medium text-accent hover:opacity-80">
          Watch
        </button>
        <button type="button" onClick={onStop} className="shrink-0 font-medium text-faint hover:text-danger">
          Stop
        </button>
      </div>
    ) : (
      <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 ${wide ? "" : "mt-auto pt-1"}`}>
          <button type="button" onClick={onMine} className={`${btnPrimary} inline-flex items-center gap-1.5`}>
            <PickaxeIcon />
            Mine
          </button>
          {hasRun && mining.status === "done" ? (
            <button
              type="button"
              disabled={continuing}
              onClick={() => {
                setContinuing(true);
                void onContinue().finally(() => setContinuing(false));
              }}
              title="Reopens the mining conversation — ask it why, or steer a refinement (revived if its terminal was closed)"
              className="text-xs font-medium text-accent hover:opacity-80 disabled:opacity-50"
            >
              {continuing ? "Opening…" : "Continue the conversation"}
            </button>
          ) : (
            hasRun &&
            mining.startedUnix != null && (
              <span className="text-xs text-faint">
                {mining.status === "stopped" ? "Last run stopped" : `Mined ${timeAgo(mining.startedUnix)}`}
              </span>
            )
          )}
      </div>
    );
  return (
    <section className="flex flex-1 flex-col gap-1 rounded-xl border border-[color-mix(in_srgb,var(--info)_35%,transparent)] bg-surface p-3">
      {wide ? (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5">
          {description}
          {actions}
        </div>
      ) : (
        <>
          {description}
          {actions}
        </>
      )}
      {improved.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-1 text-xs text-muted">
          Changed
          {improved.map((root) => (
            <button
              key={root}
              type="button"
              onClick={() => onOpen(root)}
              className="rounded-md bg-panel px-1.5 py-0.5 font-mono text-[0.7rem] text-fg hover:text-accent"
            >
              {baseName(root)}
            </button>
          ))}
          <span className="text-faint">— review &amp; save.</span>
        </p>
      )}
    </section>
  );
}

// "Open a skill" demoted to a dialog (reached from the nav): users start from
// discovered or mined skills below; pasting a path is the fallback for the
// rare skill discovery misses.
function OpenSkillDialog({
  onClose,
  onOpenPath,
  onBrowse,
}: {
  onClose: () => void;
  onOpenPath: (p: string) => void;
  onBrowse: () => void;
}) {
  const [path, setPath] = useState("");
  return (
    <Modal title="Open a skill" onClose={onClose}>
      <form
        className="space-y-4 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (path.trim()) onOpenPath(path.trim());
        }}
      >
        <p className="text-xs leading-relaxed text-muted">
          A skill is a folder containing a{" "}
          <code className="rounded bg-panel px-1 py-0.5 font-mono text-[0.85em]">SKILL.md</code>. Paste its path
          (or a loose markdown file's), or browse for it.
        </p>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/absolute/path/to/skill-folder"
          spellCheck={false}
          autoFocus
          className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
        />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onBrowse} className={btnGhost}>
            Browse…
          </button>
          <button type="submit" disabled={!path.trim()} className={btnPrimary}>
            Open
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Component() {
  const recents = useRecents();
  const navigate = useNavigate();
  const onOpen = (p: string) => navigate(studioPath(p));
  // Recents mix skills and loose markdown files; route each to the right place.
  const openRecent = (r: Recent) => navigate(r.kind === "markdown" ? markdownPath(r.root) : studioPath(r.root));
  // The path field opens either a skill folder or a single .md file (by extension).
  const openPath = (p: string) => navigate(MARKDOWN_EXT.test(p) ? markdownPath(p) : studioPath(p));
  const [openOpen, setOpenOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [mineOpen, setMineOpen] = useState(false);
  const mining = useMining();

  // Evidence lines from the run's results, keyed by staged root (basename
  // fallback — the agent writes the paths, so be tolerant of ~ vs absolute).
  const evidenceFor = useCallback(
    (root: string): string | undefined => {
      const p = mining?.results?.proposals?.find(
        (x) => x.root === root || baseName(x.root ?? "") === baseName(root),
      );
      if (!p?.sessions) return undefined;
      return `Seen in ${p.sessions} session${p.sessions === 1 ? "" : "s"}${p.projects ? ` · ${p.projects} project${p.projects === 1 ? "" : "s"}` : ""}`;
    },
    [mining?.results],
  );

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

  // When a mining run finishes (or is stopped), rescan: newly staged proposals
  // and freshly dirtied skills should appear without a manual refresh.
  const prevMineStatus = useRef<string | null>(null);
  useEffect(() => {
    const status = mining?.status ?? null;
    if (prevMineStatus.current === "running" && status !== "running") void runDiscovery();
    prevMineStatus.current = status;
  }, [mining?.status, runDiscovery]);

  // Reopen the run's conversation: the server returns its live terminal, or
  // revives the recorded agent session in a fresh one if the pane was closed.
  const continueMining = useCallback(async () => {
    try {
      const { terminalId } = await api.mineContinue();
      void refreshMining(); // the record may now point at a new terminal
      navigate(terminalsPath(terminalId));
    } catch {
      navigate(terminalsPath(mining?.terminalId));
    }
  }, [navigate, mining?.terminalId]);

  const stopMining = useCallback(async () => {
    if (
      !(await confirm({
        title: "Stop mining?",
        body: "The agent session is interrupted. Anything already staged stays reviewable.",
        confirmLabel: "Stop",
        danger: true,
      }))
    )
      return;
    try {
      await api.mineStop();
    } catch {
      // The state poll will reconcile either way.
    }
    void refreshMining();
  }, [confirm]);

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

  // Proposed drafts ride inside their agent group, badged and leading the grid.
  const groups = discovered;
  const totalFound = groups.reduce((n, g) => n + g.skills.length, 0);

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar>
        <button
          type="button"
          onClick={() => setOpenOpen(true)}
          title="Open a skill by path"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted hover:bg-panel hover:text-fg"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
          </svg>
          <span className="hidden text-xs sm:inline">Open</span>
        </button>
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
        {/* Content leads: recents (and the skills grid below) are where users
            start. Mining is a compact side card; without recents (first run)
            it widens into a slim full-width banner instead. */}
        <div className="grid gap-3 lg:grid-cols-3">
          {recents.length > 0 && (
            <section className="flex flex-col lg:col-span-2">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">Recent</h2>
              <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {/* Always one slim row beside the mining card: 1 card on mobile,
                    2 from sm, 3 from lg (where the third column appears). */}
                {recents.slice(0, 3).map((r, i) => (
                  <div
                    key={r.root}
                    className={`group relative h-full ${i === 1 ? "hidden sm:block" : ""} ${i === 2 ? "hidden lg:block" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => openRecent(r)}
                      className="flex h-full w-full flex-col gap-1 rounded-xl border border-border bg-surface p-3 pr-8 text-left transition-colors hover:border-border-strong hover:bg-panel"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {/* Same icons as the cards below, so a loose markdown file
                            reads differently from a skill folder at a glance. */}
                        {r.kind === "markdown" ? <FileIcon name={r.name} /> : <FolderIcon open={false} name={r.name} />}
                        <span className="truncate text-sm font-semibold text-fg">{r.name}</span>
                      </span>
                      <span className="mt-auto truncate font-mono text-[0.7rem] text-faint" title={r.root}>
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
          <section className={`flex flex-col ${recents.length > 0 ? "" : "lg:col-span-3"}`}>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">Skill Mining</h2>
            <MineCard
              mining={mining}
              wide={recents.length === 0}
              onMine={() => setMineOpen(true)}
              onStop={() => void stopMining()}
              onWatch={() => navigate(terminalsPath(mining?.terminalId))}
              onContinue={continueMining}
              onOpen={onOpen}
            />
          </section>
        </div>

        <section className="mt-12">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
              Your skills
              {discovering ? <Spinner className="h-3 w-3" /> : <span className="text-faint">· {totalFound}</span>}
            </h2>
            <button
              type="button"
              onClick={() => void runDiscovery()}
              disabled={discovering}
              title="Rescan your machine for installed skills"
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-panel hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RefreshIcon className={discovering ? "animate-spin" : ""} />
              Discover
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
                  busyRoot={busyRoot}
                  evidenceFor={evidenceFor}
                  onOpen={onOpen}
                  onDelete={doDelete}
                  onAccept={acceptProposed}
                  onDiscard={discardProposed}
                />
              ))}
            </div>
          )}
        </section>

        <section className="mt-12">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Examples</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {EXAMPLES.map((ex) => (
              <button key={ex.path} type="button" onClick={() => onOpen(ex.path)} className={cardCls}>
                <span className="flex items-center gap-2">
                  <FolderIcon open={false} name={ex.name} />
                  <span className="text-sm font-semibold text-fg">{ex.name}</span>
                </span>
                <span className="text-xs leading-relaxed text-muted">{ex.blurb}</span>
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
          onSelectFile={(p) => {
            setShowPicker(false);
            navigate(markdownPath(p));
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

      {mineOpen && <MineDialog onClose={() => setMineOpen(false)} onStarted={() => setMineOpen(false)} />}

      {openOpen && (
        <OpenSkillDialog
          onClose={() => setOpenOpen(false)}
          onOpenPath={(p) => {
            setOpenOpen(false);
            openPath(p);
          }}
          onBrowse={() => {
            setOpenOpen(false);
            browse();
          }}
        />
      )}
    </div>
  );
}
