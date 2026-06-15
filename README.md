# Skill Studio

The best editor for **[Agent Skills](.https://agentskills.io/home)**. 

![Skill Studio — recent skills, skill mining, and the discovered skills library](./Screenshot.png)

As agents get more powerful, it's easy to feel like loosing control over the direction of your project or organization. Your need a place to specify your taste, expertise, and customize your way of doing things. We think the place to do it on the organization level is through [agent skills](.https://agentskills.io/home). 

Any place that requires human creativity needs a good human interface, and there just isn't a good one with skills, so we built one and open-sourced it. 

Built with [Tauri](https://tauri.app/), Skill Studio runs on macOS, Linux, and Windows, and connects to any remote dev setup you have natively VS Code style (see [`design.md`](./design.md)). 

## Features

- **Discover** and manage every skill on your machine, across Claude Code, Codex, Cursor,
  Gemini CLI, OpenClaw, the shared `~/.agents/skills` standard, and project repos.
- **Skill Mining** — use your local agent to analyze past agent conversations to create / update skills.
- **Edit rendered markdown directly** — view and edit `SKILL.md` and other Markdown files directly on the rendered document. Double click to edit the raw markdown syntax. 
- **Automatic versioning** — automatically track changes across all your skills and sync to any remote you specify
- **Secrets manager** — machine-local store. Automatically detect secrets used and notice on export for "batteries included" sharing of the skills. 
- **Terminals & remote hosts** — managed agent sessions that survive UI disconnect, so you can close your laptop and pick the run back up later. Point Studio at any SSH host and run agents there. Supports Claude Code, Codex, or a shell. 

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
`?path=/abs/path/to/skill` deep link. The on-device LLM bundles a prebuilt
`llama-server` (`scripts/fetch-engine.sh`); the model downloads on first use.
`examples/` holds real document skills (`docx`, `pdf`, `pptx`, `xlsx`).

## Roadmap

The thesis: the future is one where humans **collaborate** with AI agents , not one where they are replaced by.  Skills are the medium for human expert knowledge, so they need a
first-class human UX. Next:

1. **Team collaboration & secret management** — share skills and the secrets they need across a team, account-backed. 
2. **Multi-modal skills / SOP documents** in a format readable by both humans and agents, for computer use agents. 
