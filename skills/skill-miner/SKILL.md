---
name: skill-miner
description: "Mine past agent conversation(s) for high quality Agent Skills to generate / update. Use when asked to analyze past sessions for skill improvements, find what's worth turning into a skill or auto-generate/refresh skills from history. "
license: MIT
---

# Skill Miner

Turn the signal buried in past coding-agent sessions into new and existing
"[Agent Skills](https://agentskills.io/home)". A session earns a skill only when it
clears this gate — **repeatable AND (room to do it better OR a repeated ask)**:

1. **Repeatable** — the task or knowledge recurs, or clearly could. Past recurrence
   is the strongest evidence, but a plausibly-recurring task counts; a genuine
   one-off never does. *(Required.)*
2. **Room to do it better** — there's meaningful feedback, so next time beats the
   first:
   - **Environment feedback** — what running the work revealed: failures, recurring
     quirks of this environment, roundabout paths and their shortcuts, hard-won
     heuristics. **These are literally skills.**
   - **User feedback** — the user is the expert and their feedback is rare; mine it
     to pick their brain (a correction, a better way they knew, a fact we got wrong).
3. **A repeated ask** — the user keeps requesting the same thing; extract it once so
   they don't have to ask again.

Pipeline: **discover → distill (cheap LLM, per conversation) → group, judge &
generate**.

## 0. Prerequisites

A small LLM must be reachable. Check it first:

```bash
python3 scripts/llm.py --check   # prints the backend it will use, or how to enable one
```

Set one of `OPENAI_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`, or have a
`claude` / `codex` / `gemini` CLI on PATH. Override model with `SKILL_MINER_MODEL`,
force a backend with `SKILL_MINER_LLM`.

## 1–2. Run the pipeline (scripts do the heavy, cheap-LLM work)

Keep your working directory at the launch directory: all artifacts go under `./out`.

```bash
OUT=./out
python3 scripts/discover.py  --since 35 --out $OUT/inventory.jsonl       # find transcripts across agents
python3 scripts/extract.py   --inventory $OUT/inventory.jsonl --out $OUT/conversations.jsonl --workers 10
```

- `discover.py` walks each adapter in `common.py:ADAPTERS` (Claude Code, Codex,
  opencode; add more there) and keeps sessions from the last `--since` days. Start with at most
  100 conversations unless the user asks for more. Add `--limit 15` to `extract.py`
  to sample fast.
- `extract.py` parses each conversation and emits one JSONL row:
  `agent, session_id, path, main_dir, datetime, n_user_turns, topics[], tasks[], skills_used[], env_feedback[], user_feedback[]`.
  `main_dir` = the deepest folder where most work happened (from edited / read /
  mentioned files), not the launch cwd. `topics` are the scope (usually one —
  doubling as the headline — for grouping). `tasks`, `env_feedback`, and
  `user_feedback` are short arrays the cheap LLM copies from the user's own words
  (each `[]` for the typical session) — they map to the gate's three dimensions. The
  cheap call sees only user turns, so
  `env_feedback` is what the user *said about* what ran, not raw tool output — verify
  it in step 4.

## 3. Group the conversations

Read `conversations.jsonl` — one row per session. At ≤100 rows the whole file fits
in context, so read it. (If you mined many more, skim with `jq`/`grep` for rows with
non-empty `env_feedback` / `user_feedback` first, then read the interesting slices.)
Ignore rows whose `topics` is `<error>` or trivial/empty.

Cluster by **task archetype** — the KIND of work, not directory alone (e.g. "CI
deploy debugging", "settings UI iteration", "dependency migration") — to judge
**dimension 1 (repeatable)**: which tasks recur or clearly could. Then, across the
rows, gather the other two dimensions:

- **dimension 2** — `env_feedback` and `user_feedback` that point at a way to do a
  task better next time (lead with environment feedback). A single hard-won lesson is
  a lead even without a cluster around it.
- **dimension 3** — a detail that recurs across many sessions' `tasks` (the user
  keeps asking for the same thing).

Set aside one-off setup steps and lone offhand remarks. Keep short notes: named
groups, each with its conversation count, dominant `main_dir`(s), the feedback /
repeated asks it carries, and a few example `path`s to open as evidence next.

## 4. Judge & generate

Read `references/quality-bar.md` and apply its gate: **repeatable AND (feedback OR a
repeated ask)**.

1. **Know the landscape.** Check your existing skills for what can be extended —
   especially one whose feedback says it fell short; if a candidate overlaps it, open
   that `SKILL.md` and edit it in place. To find skill file paths:
   ```bash
   python3 scripts/skills_inventory.py
   ```
   Use it only to find files to edit; your context stays the source of truth for the
   landscape. If a candidate centers on a specific repo, check what Markdown docs
   already exist there (`README.md`, design docs, plans); if the recurring knowledge
   belongs in those docs instead of a skill, recommend that to the user in your
   report.
2. **Confirm against transcripts.** For each lead, open 1–3 example transcripts (the
   `path` field) to confirm the signal is real and to capture the *specifics* — the
   exact rule, the exact error and workaround, the better path the user pointed to,
   the repeated ask. Read the user's words around any correction and around
   `[skill used: X]` markers. The condensed rows show only user turns, so the
   transcript is where you verify what the environment actually did. Separate a
   **recurring quirk** (write it down) from **one-time setup** (a one-line gotcha at
   most).
3. **Decide, against the gate.** A lead becomes a skill only if it is repeatable AND
   has either room to do it better (feedback) or a repeated ask. The three dimensions
   carry equal weight — don't drop a hard-won lesson because the task appeared once if
   it clearly recurs, and don't ship a repeatable task that has nothing to improve and
   no repeated ask.
4. **Generate / modify ≤ 5 skills.** Write each as concrete content: the rule, the
   trigger, the steps/commands, the quirk + workaround — with file paths **relative
   to the repo root** (`src/pages/Run.tsx`), never machine-specific absolutes
   (`/home/<user>/…`) copied from a transcript. Where it lands:
   - **Extending an existing skill** → edit it **in place** at the skill path. Don't
     fork or copy it.
   - **A brand-new skill** → write it under
     `~/.agents/skills/generated-skills/<name>/`, staged for the user to review and
     promote — don't drop new skills straight into a live home.
5. **Report.** List what you created/modified and, for each, which dimension(s) it
   came from. For each notable rejected candidate, say in one line which dimension it
   missed. Include any repo docs you think should be updated instead of, or in
   addition to, the skill changes.

## Extending to other agents

Each agent stores transcripts differently. To support a new one (Gemini CLI,
Cursor, …) add a `(discover_fn, parse_fn)` pair to `common.py:ADAPTERS` that yields
the normalized record (`_norm(...)`). The rest of the pipeline is unchanged. Cursor
(sqlite `state.vscdb`) is not yet wired up — opencode's adapter is a DB-backed
(SQLite) template to follow.

## Notes

- Read-only over your transcripts; the only writes are the `--out` artifacts and the
  skills you choose to generate or improve — new skills land staged under
  `~/.agents/skills/generated-skills/`, edits go in place to the existing skill.
- Sub-agent / review threads (Claude Code sidechains, Codex `thread_source:
  subagent`) are filtered out — only real user conversations are mined.

## Viewing the results

Run standalone, the results are plain files: the artifacts under `./out`, and the
skills you changed (edited in place, or staged under `generated-skills/`). This skill
also ships with [VibeStudio](https://github.com/AltrinaAI/vibestudio), a desktop
app where the user watches the run live, reviews each new skill staged under
`generated-skills/` as a **Proposed** card to **Accept** or **Discard**, and sees
in-place edits as git-tracked changes to save as a version or revert.
