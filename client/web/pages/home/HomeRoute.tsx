"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
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
import { agentColor, kindMeta, KIND_TAG, AGENT_GROUP_INFO, type AgentGroupInfo } from "@/lib/agents";
import * as api from "@/lib/api";
import type { AgentSkills, DiscoveredSkill, MineState } from "@/lib/api";
import { useMining, refreshMining } from "@/lib/mining";
import { useNavigate } from "react-router-dom";
import { studioPath, markdownPath, miningPath, terminalsPath } from "@/lib/routes";

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
// A skill with uncommitted changes is "pending review" like a proposed skill, so
// it wears the same tinted-border treatment — in amber (its CHANGES tone) rather
// than the proposed card's green — so the two read as one family of review cards.
const dirtyCardCls =
  "group flex flex-col gap-1.5 rounded-xl border border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_6%,var(--surface))] p-3.5 text-left transition-colors hover:border-[color-mix(in_srgb,var(--warning)_60%,transparent)] hover:bg-[color-mix(in_srgb,var(--warning)_12%,var(--surface))]";
// Proposed cards wear a green-tinted border to stand apart in the grid. The card
// body opens the skill (same click-to-open as a normal card), but Accept /
// Discard live below as their own buttons — so the root stays a container, not a
// single button. Mirrors the SkillCard look (h-full, hover) so they sit flush.
const proposedCardCls =
  "group flex h-full flex-col gap-1.5 rounded-xl border border-[color-mix(in_srgb,var(--ok)_40%,transparent)] bg-[color-mix(in_srgb,var(--ok)_6%,var(--surface))] p-3.5 text-left transition-colors hover:border-[color-mix(in_srgb,var(--ok)_60%,transparent)] hover:bg-[color-mix(in_srgb,var(--ok)_12%,var(--surface))]";
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
      {/* w-full so the shrink-wrapping <button> fills the column; h-full keeps
          sibling cards equal-height with the delete control at the real bottom. */}
      <button type="button" onClick={() => onOpen(skill.root)} className={`${dirty ? dirtyCardCls : cardCls} h-full w-full`}>
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

function InfoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}

// A real hover popover for the shared-standard explainer — the desktop webview
// renders nothing for a native `title`, so the ⓘ carries its own DOM tooltip.
// Keeps the section header to one line; the chips + note appear only on hover.
function SharedStandardInfo({ info }: { info: AgentGroupInfo }) {
  return (
    <span className="group/info relative flex items-center">
      <span className="cursor-help text-faint transition-colors hover:text-muted">
        <InfoIcon />
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-30 mt-1.5 hidden w-max max-w-xs flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-muted shadow-lg group-hover/info:flex"
      >
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
      </span>
    </span>
  );
}

// The shared ~/.agents/skills dir is keyed "Agent Skills" internally (color,
// info, path rules); shown as "Standard Agent Skills" so its cross-agent,
// standard nature is clear from the label alone.
const AGENT_LABELS: Record<string, string> = { "Agent Skills": "Standard Agent Skills" };
const agentLabel = (agent: string) => AGENT_LABELS[agent] ?? agent;

// One section per agent (the skill's source). Mined proposals lead the grid
// (green-tinted, awaiting acceptance), then your own skills; everything you
// didn't author — built-in/official skills and third-party plugins — collapses
// together behind a single toggle (default collapsed).
function AgentSection({
  group,
  dirtyRoots,
  deletingRoot,
  busyRoot,
  onOpen,
  onDelete,
  onAccept,
  onDiscard,
}: {
  group: AgentSkills;
  dirtyRoots: Set<string>;
  deletingRoot: string | null;
  busyRoot: string | null;
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
      {/* One-line header; the shared-standard explainer (Agent Skills only) lives
          in a hover popover on the ⓘ so the row stays compact — a real DOM
          popover, since native `title` tooltips render nothing in the webview. */}
      <div className="mb-3 flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: agentColor(group.agent) }} aria-hidden />
        <h3 className="text-sm font-semibold text-fg">{agentLabel(group.agent)}</h3>
        <span className="text-xs text-faint">{group.skills.length}</span>
        {info && <SharedStandardInfo info={info} />}
        {/* No cards to anchor the section: the bundled toggle joins the header
            row instead of dangling alone beneath it. */}
        {own.length === 0 && proposals.length === 0 && bundledToggle}
      </div>
      {(own.length > 0 || proposals.length > 0) && (
        <div className={gridCls}>
          {proposals.map((s) => (
            <ProposedCard
              key={s.root}
              skill={s}
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
      {/* Card body opens the skill — where the path/dir is visible — so the path
          is dropped from the card face. The bottom slot that ordinary cards use
          for the path holds Accept / Discard here, keeping both the same height. */}
      <button type="button" onClick={() => onOpen(skill.root)} className="flex flex-1 flex-col gap-1.5 text-left">
        <div className="flex items-center gap-2">
          <FolderIcon open={false} name={name} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{name}</span>
          <ProposedTag />
        </div>
        {skill.description && <p className="line-clamp-2 text-xs leading-relaxed text-muted">{skill.description}</p>}
      </button>
      <div className="flex items-center gap-2">
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

// Mining's door: a compact side card to start a run or reopen the last one. It
// deliberately shows NO progress/status — a run is an interactive session that
// stays open after the work lands, so the app can't reliably tell "still running"
// from "done". Rather than guess (and usually guess wrong), the card just points
// at the last session. Proposed NEW skills land inline in the Discovered grid.
function MineCard({
  mining,
  onMine,
  onContinue,
  onDetails,
}: {
  mining: MineState | null;
  onMine: () => void;
  onContinue: () => Promise<void>;
  onDetails: () => void;
}) {
  const hasRun = mining != null && mining.status !== "idle";
  const [continuing, setContinuing] = useState(false);
  return (
    <section
      onClick={onDetails}
      title="Mining details — the latest run and its files"
      className="flex flex-1 cursor-pointer flex-col gap-1 rounded-xl border border-border bg-surface p-3.5 transition-colors hover:border-border-strong hover:bg-panel"
    >
      <p className="text-xs leading-relaxed text-muted">Analyze your past conversations to create / update skills</p>
      {/* The whole card opens the mining page; inner controls stop the bubble so
          their own action doesn't also navigate. */}
      <div className="mt-auto flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMine();
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent-soft"
        >
          <PickaxeIcon />
          Mine
        </button>
        {hasRun && (
          <button
            type="button"
            disabled={continuing}
            onClick={(e) => {
              e.stopPropagation();
              setContinuing(true);
              void onContinue().finally(() => setContinuing(false));
            }}
            title="Reopens your last mining session — revived in a fresh terminal if it was closed"
            className="text-xs font-medium text-accent hover:opacity-80 disabled:opacity-50"
          >
            {continuing ? "Opening…" : "Open last session"}
          </button>
        )}
      </div>
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

function OpenIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

/** The page's primary section title — the big, bold tier reserved for the main
 *  section ("Your skills"). Recent, mining and Examples wear the quiet small-caps
 *  AsideLabel so they read as secondary utilities, not peers. */
function SectionTitle({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <h2 className="text-lg font-semibold tracking-tight text-fg">{children}</h2>
      {trailing}
    </div>
  );
}

/** Quiet small-caps label for secondary regions (the mining aside, Examples). */
function AsideLabel({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">{children}</h2>;
}

// A recent item — a compact card in a single slim row up top. It's a quick
// shortcut back into work, not the page's focus (that's "Your skills" below), so
// it stays small.
function RecentCard({ r, onOpen, onRemove }: { r: Recent; onOpen: () => void; onRemove: () => void }) {
  return (
    <div className="group relative h-full">
      <button
        type="button"
        onClick={onOpen}
        className="flex h-full w-full flex-col gap-1 rounded-xl border border-border bg-surface p-3 pr-8 text-left transition-colors hover:border-border-strong hover:bg-panel"
      >
        <span className="flex min-w-0 items-center gap-2">
          {/* Folder vs file icon, as in the gallery — a loose markdown file reads
              differently from a skill folder at a glance. */}
          {r.kind === "markdown" ? <FileIcon name={r.name} /> : <FolderIcon open={false} name={r.name} />}
          <span className="truncate text-sm font-semibold text-fg">{r.name}</span>
        </span>
        <span className="truncate font-mono text-[0.7rem] text-faint" title={r.root}>
          {r.root}
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${r.name} from recents`}
        className="absolute right-2 top-2 rounded p-1 text-faint opacity-0 hover:text-danger group-hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}

// First-run / no-history hero: when there's nothing to "jump back into", the
// top-left can't sit empty (or mining becomes the de-facto hero). These are the
// real entry points — New leads as the single filled primary; a pointer to the
// gallery below covers the "I already have skills" case.
function StartPanel({
  onNew,
  onOpen,
  onImport,
  count,
}: {
  onNew: () => void;
  onOpen: () => void;
  onImport: () => void;
  count: number;
}) {
  const tileCls =
    "flex flex-col gap-1.5 rounded-xl border p-4 text-left transition-colors";
  return (
    <div>
      <AsideLabel>Get started</AsideLabel>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <button
          type="button"
          onClick={onNew}
          className={`${tileCls} border-transparent bg-accent text-accent-fg hover:bg-accent-strong`}
        >
          <span className="flex items-center gap-2 font-semibold">
            <PlusIcon />
            New skill
          </span>
          <span className="text-xs text-accent-fg/80">Start from a template</span>
        </button>
        <button
          type="button"
          onClick={onOpen}
          className={`${tileCls} border-border bg-surface hover:border-border-strong hover:bg-panel`}
        >
          <span className="flex items-center gap-2 font-semibold text-fg">
            <OpenIcon />
            Open a skill
          </span>
          <span className="text-xs text-muted">From a folder or path</span>
        </button>
        <button
          type="button"
          onClick={onImport}
          className={`${tileCls} border-border bg-surface hover:border-border-strong hover:bg-panel`}
        >
          <span className="flex items-center gap-2 font-semibold text-fg">
            <ImportIcon />
            Import
          </span>
          <span className="text-xs text-muted">From a folder or .zip</span>
        </button>
      </div>
      {count > 0 && (
        <p className="mt-3 text-xs text-muted">
          …or pick from your <span className="font-medium text-fg">{count}</span> skills below.
        </p>
      )}
    </div>
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

  const [discovered, setDiscovered] = useState<AgentSkills[]>([]);
  const [discovering, setDiscovering] = useState(true);
  const [dirtyRoots, setDirtyRoots] = useState<Set<string>>(new Set());
  const [busyRoot, setBusyRoot] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const confirm = useConfirm();
  // Bumped on every scan; a slower in-flight scan (or its background dirty fetch)
  // checks this before committing state so it can't clobber a newer scan's results.
  const discoveryEpoch = useRef(0);
  // `silent` skips the header spinner — for automatic ticks; the epoch guard
  // already arbitrates racing scans.
  const runDiscovery = useCallback(async (opts?: { silent?: boolean }) => {
    const epoch = ++discoveryEpoch.current;
    if (!opts?.silent) setDiscovering(true);
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
      // Unconditional: also clears a manual scan's spinner when a silent
      // tick superseded it.
      if (epoch === discoveryEpoch.current) setDiscovering(false);
    }
  }, []);
  useEffect(() => {
    void runDiscovery();
  }, [runDiscovery]);

  // When a mining run ends (TUI quit, terminal closed, or stopped), rescan:
  // newly staged proposals and freshly dirtied skills should appear without a
  // manual refresh.
  const prevMineStatus = useRef<string | null>(null);
  useEffect(() => {
    const status = mining?.status ?? null;
    if (prevMineStatus.current === "running" && status !== "running")
      void runDiscovery({ silent: true });
    prevMineStatus.current = status;
  }, [mining?.status, runDiscovery]);
  // And rescan on a slow tick while one is live: the conversation stays open
  // after the mining work lands (the run IS an interactive session), so
  // proposals must surface without waiting for its terminal to close.
  useEffect(() => {
    if (mining?.status !== "running") return;
    const t = setInterval(() => {
      if (!document.hidden) void runDiscovery({ silent: true });
    }, 15000);
    return () => clearInterval(t);
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
        {/* Slim utility strip above the main gallery: a quick path back into
            recent work (or a Start panel on first run) on the left, the mining
            aside on the right. Both stay compact and quiet — "Your skills" below
            is the page's main section. */}
        <section className="grid gap-3 lg:grid-cols-3">
          <div className="flex flex-col lg:col-span-2">
            {recents.length > 0 ? (
              <>
                <AsideLabel>Recent</AsideLabel>
                {/* flex-1 + auto-rows-fr: the row fills the column so the cards
                    stretch to the same height as the mining card beside them. */}
                <div className="grid flex-1 auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {recents.slice(0, 3).map((r) => (
                    <RecentCard
                      key={r.root}
                      r={r}
                      onOpen={() => openRecent(r)}
                      onRemove={() => removeRecent(r.root)}
                    />
                  ))}
                </div>
              </>
            ) : (
              <StartPanel
                onNew={() => setNewOpen(true)}
                onOpen={() => setOpenOpen(true)}
                onImport={() => setImportOpen(true)}
                count={totalFound}
              />
            )}
          </div>
          <div className="flex flex-col lg:col-span-1">
            <AsideLabel>Skill Mining</AsideLabel>
            <MineCard
              mining={mining}
              onMine={() => setMineOpen(true)}
              onContinue={continueMining}
              onDetails={() => navigate(miningPath())}
            />
          </div>
        </section>

        <section className="mt-12">
          <SectionTitle
            trailing={
              <>
                {discovering ? <Spinner className="h-3 w-3" /> : <span className="text-sm text-faint">{totalFound}</span>}
                <button
                  type="button"
                  onClick={() => void runDiscovery()}
                  disabled={discovering}
                  title="Rescan your machine for installed skills"
                  className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-panel hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RefreshIcon className={discovering ? "animate-spin" : ""} />
                  Discover
                </button>
              </>
            }
          >
            Your skills
          </SectionTitle>
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
          <AsideLabel>Examples</AsideLabel>
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

      {mineOpen && (
        <MineDialog
          onClose={() => setMineOpen(false)}
          // Land the user in the run's terminal right away: they see where it
          // runs and can answer any first-run trust dialog without hunting.
          onStarted={(terminalId) => {
            setMineOpen(false);
            navigate(terminalsPath(terminalId));
          }}
        />
      )}

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
