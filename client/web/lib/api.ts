// Backend bridge: the frontend reaches every capability over HTTP/JSON (+ SSE for
// streaming) at `/api/*`, served by skill-server on the same origin as the SPA —
// a loopback server locally, an SSH-tunnelled one remotely. There is no second
// transport. YAML parse/validate stays here in TS (lib/skill).
import {
  parseSkillMd,
  serializeSkillMd,
  validateSkill,
  estimateTokens,
  countLines,
  type SkillFrontmatter,
} from "@/lib/skill";
import type { SkillData, FileData, TreeNode } from "@/lib/types";
import { isBootstrapSkill } from "@/lib/agents";

// Same-origin by default (server serves the UI + /api). Override for dev with
// VITE_API_BASE (e.g. point a Vite dev server at a remote skill-server).
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function http<T>(method: "GET" | "POST", path: string, args?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}/api/${path}`, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(args ?? {}) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json && json.error) || `Request failed (${res.status})`);
  return json as T;
}

interface RawSkill {
  root: string;
  dirName: string;
  raw: string;
  tree: TreeNode[];
  files: string[];
  fileCount: number;
  dirCount: number;
  totalBytes: number;
}

// --- HTTP endpoints (skill-server /api/*) ---
const readSkillRaw = (path: string) => http<RawSkill>("POST", "read-skill", { path });

export const readFile = (root: string, rel: string) => http<FileData>("POST", "read-file", { root, rel });

export const writeFile = (root: string, rel: string, content: string) =>
  http<void>("POST", "write-file", { root, rel, content });

const readImage = (root: string, rel: string) =>
  http<{ mime: string; base64: string }>("POST", "read-image", { root, rel });

export async function discoverSkills(): Promise<AgentSkills[]> {
  const groups = await http<AgentSkills[]>("GET", "discover");
  // The bundled "skill-studio" activation skill ships with the app and installs
  // into a personal dir, so discovery tags it "personal". Re-tag it "studio" so
  // it keeps its folder name but tucks into the bundled dropdown (with a "Skill
  // Studio" tag) rather than showing as one of your own skills.
  return groups.map((g) => ({
    ...g,
    skills: g.skills.map((s) => (isBootstrapSkill(s.root) ? { ...s, kind: "studio" } : s)),
  }));
}

// --- composed helpers ---
export async function loadSkill(path: string): Promise<SkillData> {
  const r = await readSkillRaw(path);
  const parsed = parseSkillMd(r.raw);
  const validation = validateSkill({
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    hasFrontmatter: parsed.hasFrontmatter,
    parseError: parsed.parseError,
    dirName: r.dirName,
    files: r.files,
  });
  return {
    root: r.root,
    dirName: r.dirName,
    raw: r.raw,
    frontmatter: parsed.frontmatter,
    frontmatterRaw: parsed.frontmatterRaw,
    body: parsed.body,
    hasFrontmatter: parsed.hasFrontmatter,
    parseError: parsed.parseError,
    tree: r.tree,
    files: r.files,
    validation,
    stats: {
      bodyLines: countLines(parsed.body),
      bodyTokens: estimateTokens(parsed.body),
      fileCount: r.fileCount,
      dirCount: r.dirCount,
      totalBytes: r.totalBytes,
    },
  };
}

export async function saveSkillMd(root: string, frontmatter: SkillFrontmatter, body: string): Promise<void> {
  await writeFile(root, "SKILL.md", serializeSkillMd(frontmatter, body));
}

export async function imageDataUrl(root: string, rel: string): Promise<string> {
  const { mime, base64 } = await readImage(root, rel);
  return `data:${mime};base64,${base64}`;
}

/**
 * Export the skill as a .zip via a `/api/download` link (browser download).
 * `vars` (declared env names present in the store) bundles their values as a
 * `.env` so the recipient can run it immediately; empty means declaration-only.
 */
export async function exportZip(root: string, vars: string[] = []): Promise<void> {
  const q = new URLSearchParams({ root });
  if (vars.length) q.set("vars", vars.join(","));
  const a = document.createElement("a");
  a.href = `${API_BASE}/api/download?${q.toString()}`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Scan the skill's files for which managed secrets it references (auto-detect). */
export const detectRequiredEnv = (root: string) => http<string[]>("POST", "detect-required-env", { root });

// --- folder browsing (server-side; backs the in-app FolderPicker) ---
export interface DirEntry {
  name: string;
  isDir: boolean;
  isSkill: boolean;
}
export interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}
export const listDir = (path: string) => http<DirListing>("POST", "list-dir", { path });

export interface DiscoveredSkill {
  name?: string;
  description?: string;
  root: string;
  /** Backend-computed provenance: "personal" | "official" | "plugin". */
  kind: string;
  /** Repo/folder name when the skill is project-scoped (`<repo>/.claude/skills/…`). */
  project?: string;
  /** A machine-generated draft staged under `generated-skills/` (e.g. by the
   *  skill-miner) — surfaced as a proposal to accept (promote) or discard. The
   *  backend always sends it (defaults to false), so it's required here. */
  proposed: boolean;
}
export interface AgentSkills {
  agent: string;
  skills: DiscoveredSkill[];
}

// --- sync a skill into a shared/global skills dir other agents read ---
export interface SyncTarget {
  /** Stable id passed back to syncSkill ("universal" | "claude-code"). */
  id: string;
  label: string;
  /** Canonical dir a new copy/link lands in. */
  dir: string;
  /** Agent display names this destination serves. */
  reaches: string[];
  /** Already reachable from this destination. */
  present: boolean;
  /** The skill natively lives here. */
  isSource: boolean;
  /** Present via a symlink (a shared copy that tracks the source). */
  linked: boolean;
  /** When present via a legacy alias dir, its basename (e.g. ".codex/skills"). */
  reachedVia?: string;
}
export interface SyncResult {
  dest: string;
  linked: boolean;
}
export const syncTargets = (root: string) => http<SyncTarget[]>("POST", "sync-targets", { root });
export const syncSkill = (root: string, target: string, overwrite: boolean, link: boolean) =>
  http<SyncResult>("POST", "sync-skill", { root, target, overwrite, link });

// --- create a brand-new skill ---
export interface SkillHome {
  /** Stable id passed back to createSkill ("universal" | "claude-code"). */
  id: string;
  label: string;
  /** Absolute path of the dir a new skill lands in. */
  dir: string;
  /** Agent display names this location serves. */
  reaches: string[];
}
export const skillHomes = () => http<SkillHome[]>("GET", "skill-homes");

/** A starter SKILL.md body: heading + the canonical Overview/When-to-use/Instructions skeleton. */
function starterBody(name: string): string {
  const title = name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return [
    `# ${title}`,
    "",
    "One or two sentences describing what this skill does.",
    "",
    "## When to use",
    "",
    "Use this skill when … — describe the trigger conditions so the agent activates it reliably.",
    "",
    "## Instructions",
    "",
    "1. First step.",
    "2. Second step.",
    "",
    "## Resources",
    "",
    "Add supporting files in this folder and link to them here.",
  ].join("\n");
}

/**
 * Create a new skill folder in the chosen location with a scaffolded SKILL.md
 * (frontmatter + starter body). Returns the new skill's root path; load it next.
 */
export async function createSkill(target: string, name: string, description: string): Promise<string> {
  const content = serializeSkillMd({ name, description }, starterBody(name));
  return http<string>("POST", "create-skill", { target, name, content });
}

// --- import an existing skill (folder or .zip) into a chosen skill home ---
/** A `.env` pair carried by an imported skill (kept out of the copied folder). */
export interface ImportedSecret {
  key: string;
  value: string;
  /** A secret with this key already exists in the store (loading overwrites it). */
  exists: boolean;
}
export interface ImportResult {
  /** Canonical root of the imported skill — open it next. */
  root: string;
  /** The skill/folder name it was imported as. */
  name: string;
  /** The home directory it landed in. */
  dir: string;
  /** An existing skill of the same name was replaced. */
  overwrote: boolean;
  /** `.env` pairs found in the source, for optional loading into the secret store. */
  env: ImportedSecret[];
}

/** Copy an existing skill folder (by absolute path) into the chosen home. */
export const importSkillFolder = (source: string, target: string, overwrite: boolean) =>
  http<ImportResult>("POST", "import-folder", { source, target, overwrite });

/** Import from an uploaded `.zip` (base64 bytes, decoded server-side). */
export const importSkillZipUpload = (data: string, target: string, overwrite: boolean) =>
  http<ImportResult>("POST", "import-zip", { data, target, overwrite });

// --- delete a skill (guarded; unlinks a synced copy, else removes the folder) ---
export interface DeleteResult {
  removed: string;
  wasLink: boolean;
}
export const deleteSkill = (root: string) => http<DeleteResult>("POST", "delete-skill", { root });

// --- accept a proposed (generated-skills) skill: promote it into the real home ---
export interface PromoteResult {
  /** New canonical root after the skill is moved out of generated-skills/. */
  root: string;
}
/** Accept a proposed skill — move it out of its `generated-skills/` staging folder
 *  up into the real skills home, turning it into an ordinary skill. */
export const promoteSkill = (root: string) => http<PromoteResult>("POST", "promote-skill", { root });

// --- per-skill git version control ---
export interface GitInfo {
  available: boolean;
  isRepo: boolean;
  inParentRepo: boolean;
  toplevel?: string;
  branch?: string;
  dirty: boolean;
  hasRemote: boolean;
  hasIdentity: boolean;
}
export interface GitCommit {
  /** Full SHA — the handle for fetching this commit's diff. */
  sha: string;
  short: string;
  message: string;
  author: string;
  /** ISO-8601 author date (for an absolute-date tooltip). */
  isoDate: string;
  relativeDate: string;
  /** 1-based version number (position in linear history; first commit = 1). */
  number: number;
}
/** One uncommitted change in the working tree (a `git status` entry). */
export interface GitFileChange {
  /** Path relative to the skill root (new path for a rename). */
  path: string;
  /** Previous path for a rename/copy. */
  origPath?: string;
  /** added | modified | deleted | renamed | copied | untracked | typechange | unmerged */
  kind: string;
  /** Recorded in the index. */
  staged: boolean;
  /** Differs in the working tree beyond what's staged. */
  unstaged: boolean;
}
/** The working tree's uncommitted state: per-file summary + one unified diff. */
export interface GitWorktreeDiff {
  files: GitFileChange[];
  /** Unified diff text covering every change (empty when clean). */
  diff: string;
  /** The diff hit the size cap and was cut short. */
  truncated: boolean;
}
/** A single commit's metadata plus its full unified diff. */
export interface GitCommitDetail {
  sha: string;
  short: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  isoDate: string;
  relativeDate: string;
  diff: string;
  truncated: boolean;
  /** 1-based version number (this commit's position in linear history). */
  number: number;
}
export const gitInfo = (root: string) => http<GitInfo>("POST", "git-info", { root });
/** One skill root's uncommitted-changes flag (from the batch [`gitDirtyMany`]). */
export interface DirtyState {
  root: string;
  dirty: boolean;
}
/** Batch "has uncommitted changes?" for the home page — one cheap status check per
 *  skill root, scoped to its own folder. Roots not under git report `dirty: false`. */
export const gitDirtyMany = (roots: string[]) => http<DirtyState[]>("POST", "git-dirty-many", { roots });
export const gitInit = (root: string) => http<GitInfo>("POST", "git-init", { root });
export const gitCommit = (root: string, message: string) =>
  http<{ sha: string; summary: string }>("POST", "git-commit", { root, message });
export const gitLog = (root: string, limit = 20) => http<GitCommit[]>("POST", "git-log", { root, limit });

// --- on-device commit-message generation (local llama.cpp engine) ---
/** Whether the on-device model is downloaded yet, so the UI can warn about the
 *  one-time first-run download before the user clicks Generate. */
export interface CommitModelStatus {
  /** Active model id (e.g. "qwen3.5-2b"). */
  model: string;
  /** The GGUF is present on disk (generation won't trigger a download). */
  downloaded: boolean;
  /** On-disk size in MB, when present. */
  sizeMb?: number;
  /** Where the GGUF lives / will be cached. */
  path: string;
}
/** Draft a Conventional-Commits message from the skill's uncommitted diff,
 *  fully on-device. The first call may download the model + warm the engine. */
export const generateCommitMessage = (root: string) => http<string>("POST", "generate-commit-message", { root });
/** Force a fresh draft (the manual ✨ Generate button): ignores the cache and
 *  varies the seed, so each click offers a different phrasing. */
export const regenerateCommitMessage = (root: string) => http<string>("POST", "regenerate-commit-message", { root });
export const commitModelStatus = () => http<CommitModelStatus>("GET", "commit-model-status");
/** A draft already prepared in the background for `root`'s current diff, or null
 *  when none is ready. Instant — never runs the model. Used to pre-fill the Save
 *  dialog from the eagerly-generated message. */
export const peekCommitMessage = (root: string) => http<string | null>("POST", "peek-commit-message", { root });
export const gitStatus = (root: string) => http<GitFileChange[]>("POST", "git-status", { root });
export const gitWorktreeDiff = (root: string) => http<GitWorktreeDiff>("POST", "git-worktree-diff", { root });
export const gitCommitDiff = (root: string, sha: string) =>
  http<GitCommitDetail>("POST", "git-commit-diff", { root, sha });
/** The file's content at a revision ("HEAD" or a SHA) — the "original" the
 *  in-editor diff overlay compares against. Empty string when absent at that rev. */
export const gitFileAt = (root: string, rev: string, path: string) =>
  http<string>("POST", "git-file-at", { root, rev, path });
/** The tracked file paths at a revision (a SHA or "HEAD") — for browsing a past
 *  version's files. */
export const gitFilesAt = (root: string, rev: string) => http<string[]>("POST", "git-files-at", { root, rev });
/** Discard one path's working-tree changes back to HEAD (tracked → restore,
 *  untracked → delete). Destructive — confirm before calling. */
export const gitDiscard = (root: string, path: string) =>
  http<{ ok: boolean }>("POST", "git-discard", { root, path }).then(() => {});
/** Discard ALL uncommitted changes back to HEAD. Destructive — confirm first. */
export const gitDiscardAll = (root: string) =>
  http<{ ok: boolean }>("POST", "git-discard-all", { root }).then(() => {});

// --- version preview (view/edit a past version through the full editor) ---
/** Returned when entering version preview. */
export interface PreviewState {
  /** Uncommitted work was set aside (stashed) to show this version cleanly. */
  stashed: boolean;
  /** The branch we'll return to on exit. */
  branch?: string;
}
/** Enter "version preview": stash any uncommitted work and check `sha` into the
 *  working tree (detached) so the full editor renders that version as if current.
 *  Editing then autosaves onto it; saving makes a new linear version. Own-repo
 *  personal skills only. */
export const gitEnterVersion = (root: string, sha: string) =>
  http<PreviewState>("POST", "git-enter-version", { root, sha });
/** Leave version preview: reattach to the branch and restore the set-aside work
 *  (discarding any unsaved preview edits). Returns fresh GitInfo. */
export const gitExitVersion = (root: string) => http<GitInfo>("POST", "git-exit-version", { root });
/** Save the previewed/edited version as a NEW version on the branch tip (linear
 *  history); the set-aside work is discarded. */
export const gitKeepVersion = (root: string, message: string) =>
  http<{ sha: string; summary: string }>("POST", "git-keep-version", { root, message });

// --- secret manager (machine-local env vars for skills) ---
export interface SecretEntry {
  key: string;
  value: string;
}
export interface AgentInstall {
  agent: string;
  /** The agent's home dir exists on this machine. */
  installed: boolean;
  /** The skill-studio activation skill is installed for this agent. */
  hasSkill: boolean;
}
export interface SecretsStatus {
  configured: boolean;
  storePath: string;
  envPath: string;
  count: number;
  agents: AgentInstall[];
}
export interface SetupResult {
  envPath: string;
  storePath: string;
  installedAgents: string[];
  skillInstalled: boolean;
}
export const secretsStatus = () => http<SecretsStatus>("GET", "secrets-status");
export const secretsList = () => http<SecretEntry[]>("GET", "secrets-list");
export const secretSet = (key: string, value: string) => http<void>("POST", "secret-set", { key, value });
export const secretDelete = (key: string) => http<void>("POST", "secret-delete", { key });
export const secretsSetup = () => http<SetupResult>("POST", "secrets-setup");

// --- app-managed agent terminals (tmux-backed; survive UI disconnect) ---

/** A launchable agent in the "New terminal" picker. The same agent can appear as
 *  its PATH CLI *and* the build bundled inside a VS Code / Cursor extension. */
export interface AgentOption {
  /** Stable id passed back to terminalCreate (e.g. "claude:cli", "codex:ext:vs-code", "shell"). */
  id: string;
  /** Family: "claude" | "codex" | "shell". */
  agent: string;
  label: string;
  /** "cli" | "extension" | "shell". */
  flavor: string;
  /** Human flavor, e.g. "CLI" or "VS Code extension". */
  flavorLabel: string;
  bin: string;
  version: string | null;
  /** Whether this agent supports `--ide` (attach to a running editor extension). */
  supportsIde: boolean;
}

/** One live tmux-backed terminal session. */
export interface TermSession {
  id: string;
  label: string;
  agent: string;
  cwd: string;
  created: string;
}

export interface CreateTermArgs {
  /** An AgentOption.id. */
  agent: string;
  cwd: string;
  cols: number;
  rows: number;
  ide: boolean;
  skipPermissions: boolean;
  /** Claude only: start in auto mode (`--permission-mode auto`). Mutually
   *  exclusive with skipPermissions. */
  autoMode: boolean;
  extraArgs: string[];
}

export const terminalAgents = () => http<AgentOption[]>("GET", "terminal/agents");
export const terminalList = () => http<TermSession[]>("GET", "terminal/list");
export const terminalCreate = (a: CreateTermArgs) => http<TermSession>("POST", "terminal/create", { ...a });
export const terminalKill = (id: string) =>
  http<{ ok: boolean }>("POST", "terminal/kill", { id }).then(() => {});

// base64 ↔ bytes for the text-only transports (SSE data: frames / JSON input).
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const strToB64 = (s: string) => bytesToB64(new TextEncoder().encode(s));

/** A bidirectional attachment to a live terminal; detaching keeps the session alive. */
export interface TerminalHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

/**
 * Attach to a session and stream its output: SSE for output (auto-reconnecting)
 * + POST for input. Detaching keeps the (tmux-backed) session alive.
 */
export function attachTerminal(
  id: string,
  opts: {
    cols: number;
    rows: number;
    onData: (bytes: Uint8Array) => void;
    /** Fired when the stream ends fatally (e.g. the session is gone). */
    onClose?: () => void;
  },
): TerminalHandle {
  const q = new URLSearchParams({ id, cols: String(opts.cols), rows: String(opts.rows) });
  const es = new EventSource(`${API_BASE}/api/terminal/attach?${q.toString()}`);
  let closed = false;
  es.onmessage = (e) => {
    if (e.data) opts.onData(b64ToBytes(e.data));
  };
  es.onerror = () => {
    // CLOSED ⇒ the browser gave up (e.g. a 4xx because the session is gone) and
    // won't reconnect; surface it once. CONNECTING ⇒ a transient blip, let it retry.
    if (es.readyState === EventSource.CLOSED && !closed) {
      closed = true;
      opts.onClose?.();
    }
  };
  return {
    write: (data) => void http("POST", "terminal/input", { id, data: strToB64(data) }),
    resize: (cols, rows) => void http("POST", "terminal/resize", { id, cols, rows }),
    detach: () => {
      closed = true;
      es.close();
    },
  };
}
