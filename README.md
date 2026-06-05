# Agent Skill Studio

A desktop app for **viewing, editing, versioning, and running
[Agent Skills](https://agentskills.io/home)** — the portable folders of human
expert knowledge that agents load on demand.

Managing skills is like managing a team's culture and policies: written once,
leveraged by every agent. Studio gives that knowledge a human interface so you
can see, diff, version, and share your skills instead of letting them drift
across a dozen agent config dirs.

Built with [Tauri](https://tauri.app/) (Rust backend + React/TS frontend). The
backend is separable from the UI, so it runs natively *or* headless on a remote
box you drive from a browser (the VS Code-remote model — see [`design.md`](./design.md)).

## Features

- **Discover** every skill on your machine — across Claude Code, Codex, Cursor,
  Gemini CLI, OpenClaw, the shared `~/.agents/skills` standard, and project repos
  — classified personal / official / plugin.
- **Read & validate** `SKILL.md` against the spec (frontmatter badges, GFM body,
  name/description/compatibility/metadata checks, file-reference checks) with a
  full file-tree browser.
- **Edit in place** — frontmatter form + CodeMirror body editor with live
  preview; double-click to toggle render/edit; autosave, scoped to the folder.
- **Version like code** — a VS Code-style Source Control panel per skill: start
  tracking, working-tree changes, inline diffs, discard, numbered commit history,
  parent-repo aware.
- **Draft commit messages on-device** — a managed `llama-server` (llama.cpp)
  running Qwen3-0.6B; nothing leaves the machine.
- **Create / import / export / sync / delete** — scaffold a new skill, import a
  folder or `.zip`, export a `.zip` (optionally bundling secrets), or share into a
  shared dir by copy or symlink.
- **Secrets manager** — one machine-local store, loaded into agent environments
  by the bundled `skill-studio` activation skill.
- **App-managed terminals** — run Claude Code, Codex, or a shell in tmux-backed
  sessions that survive UI disconnect, so you can close the lid and let the agent
  keep going.
- **SSH remotes** — pick a host from your `~/.ssh/config`, and Studio connects,
  sets up an identical `skill-server` on that box (reusing a cached one or
  transferring the local binary + UI when the OS/arch matches), tunnels a local
  port to it, and opens the remote app in a new window — the VS Code-remote UX,
  so your laptop just drives a skill-studio running on the remote's filesystem.

## Run it

```bash
npm install
npm run dev          # native desktop
```

| Mode | Command | Open |
|------|---------|------|
| Native desktop | `npm run dev` | the app window |
| Browser, local backend | `cargo run -p skill-server` + `npm run dev:vite` | `localhost:1420` |
| Browser, remote backend | `skill-server` on the host; `VITE_API_TARGET=http://<host>:8765 npm run dev:vite` | `localhost:1420` |
| Production | `npm run build`, then run `skill-server` | skill-server's port |

Open a skill via the discovered list, the top-bar path input, **Browse…**, or a
`?path=/abs/path/to/skill` deep link. The on-device LLM bundles a prebuilt
`llama-server` (`scripts/fetch-engine.sh`); the model downloads on first use.
`examples/` holds real document skills (`docx`, `pdf`, `pptx`, `xlsx`).

## Roadmap

The thesis: the future is humans and AI agents **collaborating**, not humans
replaced — and skills are the medium for human expert knowledge, so they need a
first-class human UX. Next:

1. **Skill Mining** — a local agent that mines past conversations to propose the
   skills that would have helped, and flags stale ones (the Proposed-skills /
   `generated-skills/` staging is already in place for it).
2. **Version-controlled team collaboration & team secret managers.**
3. **Multi-modal skills / SOP documents** in a readable format.

(**SSH remotes** — drive a skill-studio on a remote box from your local
`~/.ssh/config` — has landed; see Features above. Key-based auth for now;
cross-OS/arch remotes need a `skill-server` already installed there.)

## Notes

- Reads/writes are constrained to the loaded skill folder (no `..` escapes); run
  it on folders you trust. Markdown renders without raw-HTML passthrough.
- The desktop CSP is `default-src 'self'`; any outbound network originates in
  Rust, never the webview — so a skill's diff is never sent anywhere.
