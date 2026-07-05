# Skill Studio

The best human interface for **[Agent Skills](https://agentskills.io/home)**. Available on macOS, Linux, and Windows.

![Skill Studio — recent skills, skill mining, and the discovered skills library](./Screenshot.png)

We love [agent skills](https://agentskills.io/home). As agents get more powerful, it's easy to feel like losing control over the direction of your project or organization. We think agent skills is the right place to specify your taste, expertise, and customize your way of doing things on an organization level. 

There just isn't a good human interface for editing agent skills. Any place that requires human creativity needs a good human interface: clean, intuitive, version controlled. So we built one and open-sourced it. 

Built with [Tauri](https://tauri.app/), Skill Studio runs on macOS, Linux, and Windows, and connects to any remote dev setup you have natively VS Code style (see [`design.md`](./design.md)). 

## Features

- **Skill Management** — locate and manage every skill on your machine (across Claude Code, Codex, opencode, Cursor, Gemini CLI, OpenClaw) with automatic versioning and git-remote sync as the source of truth.
- **Skill Mining** — turn past agent conversations into skills or update your existing skills with recent conversations. 
- **Best Markdown editor** — preview and edit `SKILL.md` and other Markdow at the same time; double-click any block to drop into the raw syntax.
- **Credential Management** — a local store for the API keys and MCP tokens your agents need. Oauth your MCPs once and every agent reaches it through a local gateway. No token ever lands in an agent's config, environment, or transcript. 
- **Agent Session Management** — managed agent terminals that survive UI disconnect and notifies when a run finishes or needs you. Run locally or on any SSH host VS Code-remote style. 

## Install

Grab the latest build for your platform:

| Platform | |
|----------|--|
| **macOS** — Apple silicon & Intel | [Download](https://github.com/AltrinaAI/skill-studio/releases/latest/download/Skill-Studio-macOS.dmg) |
| **Windows** | [Download](https://github.com/AltrinaAI/skill-studio/releases/latest/download/Skill-Studio-Windows-x64-setup.exe) |
| **Linux** — Debian/Ubuntu | [Download](https://github.com/AltrinaAI/skill-studio/releases/latest/download/Skill-Studio-Linux-x86_64.deb) |

### First launch

Windows builds aren't code-signed yet, so each shows a one-time prompt:

- **Windows** — SmartScreen shows "Windows protected your PC". Click **More info → Run anyway**.
- **Linux** — install the package with `sudo apt install ./Skill-Studio-Linux-x86_64.deb`.

## Use from a browser (phone included)

The backend serves the full app over plain HTTP, meaning all you need is a browser pointed at the skill-server to run the entire app. 

**In the app:** click the **Local** pill → **Open on your phone…** → scan the QR. The app fronts its own server with [Tailscale](https://tailscale.com) (free) and walks you through the two one-time Tailscale permissions if needed. Any device signed in to your Tailscale network can open the URL. Closing the window keeps Skill Studio (and phone access) running in your tray; right-click the tray icon to quit entirely.

## Build from source

Install Rust, Node.js/npm, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS, then:

```bash
git clone https://github.com/AltrinaAI/skill-studio.git
cd skill-studio
npm install
npm run tauri -- build
```

The built app bundle is written under `client/desktop/target/release/bundle/`.

## Development

```bash
npm install
npm run dev          # native desktop
```

| Mode | Command | Open |
|------|---------|------|
| Native desktop | `npm run dev` | the app window |
| Browser, local backend | `cargo run -p skill-server` + `npm run dev:vite` | `localhost:1420` |

## Roadmap

The thesis: the future is one where humans **collaborate** with AI agents, not one where they are replaced by them. Skills are the medium for human expert knowledge, so they need a first-class human UX. Next:

1. **Team collaboration & secret management** — share skills and the secrets and connections they need across a team, account-backed. 
2. **Multi-modal skills / SOP documents** in a format readable by both humans and agents, for computer use agents. 
