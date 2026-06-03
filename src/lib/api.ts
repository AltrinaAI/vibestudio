// Backend bridge with two transports:
//   • Desktop (Tauri): in-process `invoke`.
//   • Browser (served by skill-server, e.g. backend in WSL2): `fetch('/api/...')`.
// Auto-detected at runtime. YAML parse/validate stays here in TS (lib/skill).
import { invoke, Channel } from "@tauri-apps/api/core";
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

/** True when running inside the Tauri desktop shell (vs a plain browser). */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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

// --- raw command transports ---
const readSkillRaw = (path: string) =>
  isTauri ? invoke<RawSkill>("read_skill", { path }) : http<RawSkill>("POST", "read-skill", { path });

export const readFile = (root: string, rel: string) =>
  isTauri ? invoke<FileData>("read_file", { root, rel }) : http<FileData>("POST", "read-file", { root, rel });

export const writeFile = (root: string, rel: string, content: string) =>
  isTauri
    ? invoke<void>("write_file", { root, rel, content })
    : http<void>("POST", "write-file", { root, rel, content });

const readImage = (root: string, rel: string) =>
  isTauri
    ? invoke<{ mime: string; base64: string }>("read_image_base64", { root, rel })
    : http<{ mime: string; base64: string }>("POST", "read-image", { root, rel });

export async function discoverSkills(): Promise<AgentSkills[]> {
  const groups = isTauri
    ? await invoke<AgentSkills[]>("discover_skills")
    : await http<AgentSkills[]>("GET", "discover");
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
 * Export the skill as a .zip — native save dialog (desktop) or browser download.
 * `vars` (declared env names present in the store) bundles their values as a
 * `.env` so the recipient can run it immediately; empty means declaration-only.
 */
export async function exportZip(root: string, vars: string[] = []): Promise<void> {
  if (isTauri) {
    await invoke<boolean>("export_skill_zip", { root, envVars: vars });
    return;
  }
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
export const detectRequiredEnv = (root: string) =>
  isTauri
    ? invoke<string[]>("detect_required_env", { root })
    : http<string[]>("POST", "detect-required-env", { root });

/** Native folder dialog — desktop only (browser uses the FolderPicker modal + listDir). */
export const pickSkillFolder = () => invoke<string | null>("pick_skill_folder");

// --- remote folder browsing (browser mode) ---
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
export const syncTargets = (root: string) =>
  isTauri ? invoke<SyncTarget[]>("sync_targets", { root }) : http<SyncTarget[]>("POST", "sync-targets", { root });
export const syncSkill = (root: string, target: string, overwrite: boolean, link: boolean) =>
  isTauri
    ? invoke<SyncResult>("sync_skill", { root, target, overwrite, link })
    : http<SyncResult>("POST", "sync-skill", { root, target, overwrite, link });

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
export const skillHomes = () =>
  isTauri ? invoke<SkillHome[]>("skill_homes") : http<SkillHome[]>("GET", "skill-homes");

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
  return isTauri
    ? invoke<string>("create_skill", { target, name, content })
    : http<string>("POST", "create-skill", { target, name, content });
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

/** Native file picker for a `.zip` (desktop only; browser uses a file input). */
export const pickZipFile = () => invoke<string | null>("pick_zip_file");

/** Copy an existing skill folder (by absolute path) into the chosen home. */
export const importSkillFolder = (source: string, target: string, overwrite: boolean) =>
  isTauri
    ? invoke<ImportResult>("import_skill_folder", { source, target, overwrite })
    : http<ImportResult>("POST", "import-folder", { source, target, overwrite });

/** Desktop: import from a `.zip` on disk (the backend reads the path). */
export const importSkillZipPath = (path: string, target: string, overwrite: boolean) =>
  invoke<ImportResult>("import_skill_zip", { path, target, overwrite });

/** Browser: import from an uploaded `.zip` (base64 bytes, decoded server-side). */
export const importSkillZipUpload = (data: string, target: string, overwrite: boolean) =>
  http<ImportResult>("POST", "import-zip", { data, target, overwrite });

// --- delete a skill (guarded; unlinks a synced copy, else removes the folder) ---
export interface DeleteResult {
  removed: string;
  wasLink: boolean;
}
export const deleteSkill = (root: string) =>
  isTauri ? invoke<DeleteResult>("delete_skill", { root }) : http<DeleteResult>("POST", "delete-skill", { root });

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
export const gitInfo = (root: string) =>
  isTauri ? invoke<GitInfo>("git_info", { root }) : http<GitInfo>("POST", "git-info", { root });
export const gitInit = (root: string) =>
  isTauri ? invoke<GitInfo>("git_init", { root }) : http<GitInfo>("POST", "git-init", { root });
export const gitCommit = (root: string, message: string) =>
  isTauri
    ? invoke<{ sha: string; summary: string }>("git_commit", { root, message })
    : http<{ sha: string; summary: string }>("POST", "git-commit", { root, message });
export const gitLog = (root: string, limit = 20) =>
  isTauri ? invoke<GitCommit[]>("git_log", { root, limit }) : http<GitCommit[]>("POST", "git-log", { root, limit });

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
export const generateCommitMessage = (root: string) =>
  isTauri
    ? invoke<string>("generate_commit_message", { root })
    : http<string>("POST", "generate-commit-message", { root });
export const commitModelStatus = () =>
  isTauri
    ? invoke<CommitModelStatus>("commit_model_status")
    : http<CommitModelStatus>("GET", "commit-model-status");
/** A draft already prepared in the background for `root`'s current diff, or null
 *  when none is ready. Instant — never runs the model. Used to pre-fill the Save
 *  dialog from the eagerly-generated message. */
export const peekCommitMessage = (root: string) =>
  isTauri
    ? invoke<string | null>("peek_commit_message", { root })
    : http<string | null>("POST", "peek-commit-message", { root });
export const gitStatus = (root: string) =>
  isTauri ? invoke<GitFileChange[]>("git_status", { root }) : http<GitFileChange[]>("POST", "git-status", { root });
export const gitWorktreeDiff = (root: string) =>
  isTauri
    ? invoke<GitWorktreeDiff>("git_worktree_diff", { root })
    : http<GitWorktreeDiff>("POST", "git-worktree-diff", { root });
export const gitCommitDiff = (root: string, sha: string) =>
  isTauri
    ? invoke<GitCommitDetail>("git_commit_diff", { root, sha })
    : http<GitCommitDetail>("POST", "git-commit-diff", { root, sha });
/** The file's content at a revision ("HEAD" or a SHA) — the "original" the
 *  in-editor diff overlay compares against. Empty string when absent at that rev. */
export const gitFileAt = (root: string, rev: string, path: string) =>
  isTauri
    ? invoke<string>("git_file_at", { root, rev, path })
    : http<string>("POST", "git-file-at", { root, rev, path });
/** The tracked file paths at a revision (a SHA or "HEAD") — for browsing a past
 *  version's files. */
export const gitFilesAt = (root: string, rev: string) =>
  isTauri ? invoke<string[]>("git_files_at", { root, rev }) : http<string[]>("POST", "git-files-at", { root, rev });
/** Discard one path's working-tree changes back to HEAD (tracked → restore,
 *  untracked → delete). Destructive — confirm before calling. */
export const gitDiscard = (root: string, path: string) =>
  isTauri
    ? invoke<void>("git_discard", { root, path })
    : http<{ ok: boolean }>("POST", "git-discard", { root, path }).then(() => {});
/** Discard ALL uncommitted changes back to HEAD. Destructive — confirm first. */
export const gitDiscardAll = (root: string) =>
  isTauri
    ? invoke<void>("git_discard_all", { root })
    : http<{ ok: boolean }>("POST", "git-discard-all", { root }).then(() => {});

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
export const secretsStatus = () =>
  isTauri ? invoke<SecretsStatus>("secrets_status") : http<SecretsStatus>("GET", "secrets-status");
export const secretsList = () =>
  isTauri ? invoke<SecretEntry[]>("secrets_list") : http<SecretEntry[]>("GET", "secrets-list");
export const secretSet = (key: string, value: string) =>
  isTauri ? invoke<void>("secret_set", { key, value }) : http<void>("POST", "secret-set", { key, value });
export const secretDelete = (key: string) =>
  isTauri ? invoke<void>("secret_delete", { key }) : http<void>("POST", "secret-delete", { key });
export const secretsSetup = () =>
  isTauri ? invoke<SetupResult>("secrets_setup") : http<SetupResult>("POST", "secrets-setup");

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

export const terminalAgents = () =>
  isTauri ? invoke<AgentOption[]>("terminal_agents") : http<AgentOption[]>("GET", "terminal/agents");
export const terminalList = () =>
  isTauri ? invoke<TermSession[]>("terminal_list") : http<TermSession[]>("GET", "terminal/list");
export const terminalCreate = (a: CreateTermArgs) =>
  isTauri
    ? invoke<TermSession>("terminal_create", { ...a })
    : http<TermSession>("POST", "terminal/create", { ...a });
export const terminalKill = (id: string) =>
  isTauri ? invoke<void>("terminal_kill", { id }) : http<{ ok: boolean }>("POST", "terminal/kill", { id }).then(() => {});

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
 * Attach to a session and stream its output. Desktop uses a Tauri Channel +
 * commands; browser uses SSE for output (auto-reconnecting) + POST for input.
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
  if (isTauri) {
    const channel = new Channel<string>();
    channel.onmessage = (b64) => opts.onData(b64ToBytes(b64));
    void invoke("terminal_attach", { id, cols: opts.cols, rows: opts.rows, onEvent: channel });
    return {
      write: (data) => void invoke("terminal_write", { id, data: strToB64(data) }),
      resize: (cols, rows) => void invoke("terminal_resize", { id, cols, rows }),
      detach: () => void invoke("terminal_detach", { id }),
    };
  }
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
