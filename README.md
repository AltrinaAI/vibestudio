# Skill Studio

The best editor for **[Agent Skills](https://agentskills.io/home)**. 

![Skill Studio — recent skills, skill mining, and the discovered skills library](./Screenshot.png)

We love [agent skills](https://agentskills.io/home). As agents get more powerful, it's easy to feel like losing control over the direction of your project or organization. We think agent skills is the right place to specify your taste, expertise, and customize your way of doing things on an organization level. 

There just isn't a good human interface for editing agent skills. Any place that requires human creativity needs a good human interface: clean, intuitive, version controlled. So we built one and open-sourced it. 

Built with [Tauri](https://tauri.app/), Skill Studio runs on macOS, Linux, and Windows, and connects to any remote dev setup you have natively VS Code style (see [`design.md`](./design.md)). 

## Features

- **Discover** and manage every skill on your machine, across Claude Code, Codex, Cursor,
  Gemini CLI, OpenClaw, the shared `~/.agents/skills` standard, and project repos.
- **Skill Mining** — use your local agent to analyze past agent conversations to create / update skills.
- **Edit rendered markdown directly** — view and edit `SKILL.md` and other Markdown files directly on the rendered document. Double click to edit the raw markdown syntax. 
- **Automatic versioning** — automatically track changes across all your skills and sync to any remote you specify
- **Secrets manager** — machine-local store. Automatically detect secrets used and notice on export for "batteries included" sharing of the skills. 
- **Terminals & remote hosts** — managed agent sessions that survive UI disconnect, so you can close your laptop and pick the run back up later. Point Studio at any SSH host and run agents there. Supports Claude Code, Codex, or a shell. 

## Download

Grab the latest signed build for your platform from the
[**Releases**](https://github.com/AltrinaAI/skills-studio/releases/latest) page:

| Platform | File |
|----------|------|
| macOS (Apple silicon / Intel) | `.dmg` |
| Windows | `.exe` installer |
| Linux | `.deb` |

Prefer to build from source? See **Run it** below.

## Run it

```bash
npm install
npm run dev          # native desktop
```

| Mode | Command | Open |
|------|---------|------|
| Native desktop | `npm run dev` | the app window |
| Browser, local backend | `cargo run -p skill-server` + `npm run dev:vite` | `localhost:1420` |
| Production | `npm run build`, then run `skill-server` | skill-server's port |

Open a skill via the discovered list, the top-bar path input, **Browse…**, or a
`?path=/abs/path/to/skill` deep link. Commit-message drafting is keyless: it shells
out to a coding-agent CLI you're already logged into (Claude Code, Codex, or
Gemini). An on-device model (`scripts/fetch-engine.sh` + `SKILL_STUDIO_COMMIT_AGENT=llama`)
is an opt-in offline alternative. `examples/` holds real document skills (`docx`,
`pdf`, `pptx`, `xlsx`).

## Roadmap

The thesis: the future is one where humans **collaborate** with AI agents, not one where they are replaced by them. Skills are the medium for human expert knowledge, so they need a
first-class human UX. Next:

1. **Team collaboration & secret management** — share skills and the secrets they need across a team, account-backed. 
2. **Multi-modal skills / SOP documents** in a format readable by both humans and agents, for computer use agents. 
