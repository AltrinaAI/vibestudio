---
name: load-secrets
description: Fallback for missing credentials — loads the secrets managed in Skill Studio (for example OPENAI_API_KEY, GITHUB_TOKEN) into your environment. Only use this after a skill or command actually fails with a missing API key, token, or environment variable; environments launched from Skill Studio already have these secrets loaded, so don't run it preemptively.
---

# Load secrets — Skill Studio activation (fallback)

Skill Studio keeps your API keys and secrets in one place and renders them to a
single env file. Terminals launched from Skill Studio source that file
automatically, so the secrets are normally **already in your environment** —
check first (e.g. `[ -n "$OPENAI_API_KEY" ]`). Reach for this skill only as a
last resort, when a command has actually failed because a key, token, or
environment variable is missing.

## Load the secrets

Run this once, through `eval`, pointing at this skill's folder:

```bash
eval "$(bash ./activate.sh --print)"
```

(Use the absolute path to `activate.sh` if your shell isn't already in this
folder.) It exports every managed secret into the **current** shell and, where
possible, wires your shell startup files so shells started later inherit them
too. It prints only the variable **names** it activated — never the values.

## Sandboxed agents (read-only HOME, fresh shell per command)

Some agents (for example Codex) run each command in a **fresh shell** with a
**read-only HOME**, so a separate `activate` step doesn't persist and the
startup files can't be patched. There, source the env file **in the same
command** that needs the secrets — this only *reads* a file, so it works even
when HOME is read-only:

```bash
. "${SKILL_STUDIO_ENV:-$HOME/.config/skill-studio/env}" && your-command
```

If it reports that no secrets are configured, add them in Skill Studio and run
it again.
