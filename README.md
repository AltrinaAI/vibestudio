# Agent Skill Studio

A desktop app for **viewing, editing, organizing, version-controlling, and
running [Agent Skills](https://agentskills.io/home)** — the portable folders of
human expert knowledge that agents load on demand.

Skills are how you record what you know so every agent can reuse it. Managing
them is like managing a company's culture and policies: written once, leveraged
by every employee — and every agent. Studio gives that knowledge a human
interface. **Observability is the first step toward controllability**: you can
see your skills, diff them, version them, and share them, instead of letting
them drift invisibly across a dozen agent config directories.

Built with [Tauri](https://tauri.app/) (Rust backend + React/TypeScript
frontend). The backend is separable from the UI, so it runs natively on your
laptop *or* headless on a remote box you drive from a browser (the VS Code-remote
model — see [Architecture](#architecture)).

---

## What it does

### Discover every skill on your machine
Studio scans the canonical locations each agent reads and lists what it finds,
grouped by agent and classified by provenance — **personal** (you wrote it,
editable & versionable), **official** (vendor-bundled), or **plugin** (installed
third-party):

- **Claude Code** — `~/.claude/skills`, plugin trees, remote plugins
- **Codex** — `~/.codex/skills` (with `.system/` as the bundled set)
- **Cursor** — `~/.cursor/skills-cursor` plus your own
- **Gemini CLI** — `~/.gemini/skills`
- **OpenClaw** — `~/.openclaw/skills`
- **Shared standard** — `~/.agents/skills` (one copy reaches the whole cohort)
- **Project skills** — `<repo>/.claude|.cursor|.codex|.agents/skills/…` in repos
  under your home directory

The home screen surfaces recents, flags any skill with uncommitted git changes,
and tucks bundled official/plugin skills behind a toggle so your own work leads.

### Read & validate against the spec
- **Renders `SKILL.md`** — `name`, `description`, `license`, `compatibility`,
  `allowed-tools` (as chips) and `metadata`, followed by the Markdown body with
  GitHub-flavored Markdown and code highlighting.
- **Browses files** — a tree of the whole skill folder; click any file to view
  it with syntax highlighting, render it (Markdown), or preview it (images).
- **Validates** — name pattern & folder-name match, name/description length,
  the 500-char `compatibility` limit, metadata shape, body-size advisories
  (≈ 500 lines / ≈ 5000 tokens), and broken/too-deep file references, surfaced
  as error / warning / info.

### Edit in place
A form for the frontmatter fields plus a CodeMirror editor with live preview for
the body, and a plain editor for any other text file. Double-click the rendered
document to drop into editing (and back) without the layout shifting. Edits
autosave to disk, constrained to the loaded skill folder (no `..` escapes).

### Version skills like code
A VS Code-style **Source Control** panel, per skill:

- **Start tracking** a personal skill (`git init`) in one click.
- **Working-tree changes** — a scoped status list with per-file *Discard* and
  *Discard all*, and an **inline diff overlay** in the editor (working tree vs.
  `HEAD` or any commit).
- **Save a version** (a commit, ⌘S) and browse the numbered **commit history**;
  click a version to open its read-only diff, or browse its files at that point.
- **Parent-repo aware** — a skill nested inside a larger repo shows scoped
  changes and defers history to that repo.

### Draft commit messages on-device
A built-in local LLM drafts Conventional-Commits messages from a skill's diff —
**fully on-device**, nothing leaves the machine. It runs a managed
`llama-server` ([llama.cpp](https://github.com/ggml-org/llama.cpp)) hosting
**Qwen3-0.6B** (Q8_0 GGUF, ~610 MiB, downloaded once on first use), GPU-accelerated
with a CPU fallback so it runs everywhere. Drafts are prepared eagerly in the
background; ✨ regenerate for a fresh phrasing.

### Create, import, export & share
- **Create** a new skill from a scaffolded `SKILL.md` in a chosen home (the
  universal `.agents/skills` or Claude Code's).
- **Import** an existing skill from a folder or `.zip`; any `.env` it carries is
  offered for loading into the secret store rather than copied into the folder.
- **Export** a skill as a `.zip`, optionally bundling selected managed secrets'
  values as a `.env` so the recipient can run it immediately.
- **Sync** a skill into a shared/global skills dir other agents read — by copy or
  by symlink (a link tracks the source) — with a clear view of which agents each
  destination reaches.
- **Delete** a skill (guarded — unlinks a synced copy, else removes the folder).

### Manage secrets once, load them everywhere
A machine-local secret manager keeps your API keys and tokens in one place
(a `0600` JSON store rendered to a shell-sourceable env file). The bundled
**`skill-studio` activation skill** loads them into an agent's environment at the
start of a task — including sandboxed agents like Codex that run each command in a
fresh shell with a read-only `HOME`. Setup installs the activation skill across
the agents detected on your machine; Studio can also auto-detect which secrets a
given skill references.

### Run agents in app-managed terminals
A **Terminals** workspace runs agents in **tmux-backed sessions that survive UI
disconnects** — detach the UI (or close the browser tab) and the session keeps
running; reattach and a full-screen TUI redraws correctly. Launch **Claude Code**,
**Codex** (the CLI *or* the build bundled in a VS Code / Cursor extension), or a
plain shell, with options for the working directory, `--ide` attach to a running
editor, skip-permissions, Claude **auto mode** (`--permission-mode auto`), and
extra args. This is the foundation for *close the lid and let the agent keep
going.*

### Proposed skills
Drafts staged under a `generated-skills/` folder surface as **Proposed** cards
you can **Accept** (promote into your skills home) or **Discard** — the landing
zone for the [skill-miner](#roadmap) and any other tool that generates skills.

---

## Architecture

> The one rule that matters: **every capability is reachable over HTTP.** See
> [`design.md`](./design.md) for the full design.

The app is two parts that can run on **different machines**:

- **Backend (Rust).** All real work — filesystem, git, skill discovery, secrets,
  app-managed terminals, the on-device LLM — lives in `crates/skill-core`
  (transport-agnostic, no GUI deps) and is exposed over **HTTP/JSON + SSE** by
  `crates/skill-server`. Terminal supervision lives in `crates/skill-term`.
- **Frontend (React/TS, `src/`).** Talks to the backend through `src/lib/api.ts`,
  which auto-selects a transport: in-process `invoke` on the Tauri desktop, or
  `fetch('/api/…')` in a plain browser.

Because the HTTP contract is the source of truth, the backend can run on a remote
dev box, WSL2, or a container while the frontend runs in a browser somewhere else
— the same model VS Code Remote uses. Cross-platform releases (macOS Intel/ARM,
signed Windows, Linux AppImage) are built by Tauri via GitHub Actions.

---

## Run it

```bash
npm install
```

| Goal | Command | Open |
|------|---------|------|
| **Native desktop** | `npm run dev` | the app window |
| **Browser, local backend** | `cargo run -p skill-server` (`:8765`) + `npm run dev:vite` (`:1420`) | `localhost:1420` (Vite proxies `/api` → 8765) |
| **Browser, remote backend** | run `skill-server` on the remote host; `VITE_API_TARGET=http://<remote>:8765 npm run dev:vite` | `localhost:1420` |
| **Production / no Vite** | `npm run build`, then run `skill-server` | skill-server's port (UI + API, one origin) |

To open a specific folder on launch, paste an absolute path into the top bar and
press **Open**, browse for one, pick from the discovered list, or deep-link with
`?path=/absolute/path/to/skill`.

The on-device LLM bundles a prebuilt `llama-server`. For local desktop builds,
vendor it first with `scripts/fetch-engine.sh` (CI runs this for every shipped
target); the GGUF model itself downloads on first use.

## Examples

`examples/` contains real document skills (`docx`, `pdf`, `pptx`, `xlsx`) used by
the welcome screen — each ships a `SKILL.md`, a `scripts/` directory, a bundled
license, and (for `pdf`/`pptx`) additional reference docs.

---

## Roadmap

The thesis: the future is **humans and AI agents collaborating**, not humans
replaced by AI. The right interface for that collaboration matters, and skills —
the medium for recording human expert knowledge — need a first-class human UX.
Studio is built toward that. Next:

1. **Skill Mining** — a local agent that mines your past conversations to propose
   the personalized skills that *would have helped* in those sessions, and flags
   when an existing skill needs an update. (The Proposed-skills surface and the
   `generated-skills/` staging area are already in place for it.)
2. **Full SSH support from your local config** — plug into a remote dev
   environment, run the server there, and drive its agents through the Terminal
   so you can close your laptop and the agents keep going.
3. **Version-controlled team collaboration & team secret managers** — share
   skills (and the credentials they need) between teammates with proper history.
4. **Multi-modal skills / SOP documents** — author and read richer, multi-modal
   standard-operating-procedure documents in a human-readable format.

---

## Notes

- File reads and writes are constrained to the loaded skill directory (no `..`
  escapes). It's a local developer tool — run it on folders you trust.
- Markdown is rendered without raw-HTML passthrough, so embedded `<script>` etc.
  are not executed.
- The on-device model runs locally and the desktop CSP is `default-src 'self'`;
  any outbound network must originate in Rust, never the webview — so a skill's
  diff is never sent anywhere to draft its commit message.
