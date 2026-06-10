---
name: skill-miner
description: "Mine past agent conversation(s) to discover recurring work and generate or improve Agent Skills. Use when asked to analyze past sessions / transcripts for skill improvements, find what's worth turning into a skill or auto-generate/refresh skills from history. "
---

# Skill Miner

Distill information recurring non-standard process the user has into new and existing "[Agent Skills](https://agentskills.io/home)". This skill miner contains scripts and processes that may be helpful. 

Pipeline: **discover → distill (cheap LLM, per conversation) → group, judge &
generate**.

## 0. Prerequisites

A small LLM must be reachable. Check it first:

```bash
cd <this skill dir>/scripts
python3 llm.py --check        # prints the backend it will use, or how to enable one
```

Set one of `OPENAI_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`, or have a
`claude` / `codex` / `gemini` CLI on PATH. Override model with
`SKILL_MINER_MODEL`, force a backend with `SKILL_MINER_LLM`.

## 1–2. Run the pipeline (scripts do the heavy, cheap-LLM work)

```bash
OUT=./skill-miner-out
python3 discover.py  --since 35 --out $OUT/inventory.jsonl       # find transcripts across agents
python3 extract.py   --inventory $OUT/inventory.jsonl --out $OUT/conversations.jsonl --workers 10
```

- `discover.py` walks each adapter in `common.py:ADAPTERS` (Claude Code, Codex;
  add more there) and keeps sessions from the last `--since` days.
- Start with at most 100 conversations unless the user specifically requests more 
- `extract.py` parses each conversation and emits one JSONL row:
  `agent, session_id, path, main_dir, datetime, n_user_turns, theme, topics[], skills_used[], feedback`.
  `main_dir` = the deepest folder where most of the work happened (from edited /
  read / mentioned files), not the launch cwd. `theme` is a headline; `topics`
  are full-sentence scopes (one per conversation unless the subject truly shifts).
  `feedback` is a short natural-language summary of any explicit user feedback
  in the session — corrections, durable preferences, asserted domain facts,
  approval/frustration — and `""` for the (typical) session with none.

While iterating, add `--limit 15` to `extract.py` to sample fast.

## 3. Analyze the conversations

Cluster similar past conversations into groups. 

Read `conversations.jsonl` — one row per session with `theme`, `topics`,
`main_dir`, `n_user_turns`, `agent`, `datetime`, `path`. At ≤100 rows the whole
file fits in context, so read it. (If you mined many more, first skim by
`main_dir` and `theme` with `jq`/`grep`, then read the interesting slices.)

Think about which conversations could benefit from the same skill / procedure. Cluster by **task archetype** — the KIND of work, not directory alone: e.g. "job
failure debugging", "frontend UI iteration", "dependency migration". Ignore rows
whose `theme` is `<error>` or trivial/empty. Keep the result in your notes: a
short list of named groups, each with its conversation count, dominant
`main_dir`(s), and a few example `path`s to open as evidence in the next step.

Weigh the `feedback` field while grouping: rows where the user corrected the
agent or asserted domain facts are the highest-value evidence (the user had to
teach the agent something), and feedback about an existing skill falling short
is a direct improvement lead for that skill — collect those even if the
surrounding sessions don't cluster.

## 4. Judge & generate

Read `references/quality-bar.md` and apply it.

1. **Know the landscape.** Check your existing skills for what can be extended.
   If a candidate overlaps an existing skill, open that skill's `SKILL.md` and
   edit it in place. If you cannot find the exact file for a skill, run the
   inventory once to list the skills available on this machine and use that
   output to look up paths:
   ```bash
   python3 skills_inventory.py
   ```
   Use this only to find files to edit; your context remains the source of truth
   for which skills are part of the landscape.
   If the candidate skill is centered around a specific repo, first check what
   Markdown documentation exists in that repo (for example `README.md`,
   design docs, plans, or other project notes). Still prioritize skill work for
   this workflow, but if the recurring knowledge would be better captured by
   updating those repo docs instead of creating or changing a skill, mention that
   recommendation to the user in your report.
2. **Spot-check each group.** For each sizeable group from step 3, open 1–3
   of its example transcripts (the `path` field) to confirm the recurring
   procedure / friction / knowledge is real. Look for two things
   specifically: *roundabout paths* (time wasted, figured out late) and
   *user-feedback signals* (corrections, asserted domain facts, preferences) —
   those distill into the strongest skill content. The rows' `feedback` field
   tells you which transcripts to open first: prefer sessions where the user
   corrected the agent, and where feedback says an existing skill fell short,
   read that session to learn exactly where its instructions failed.
3. **Decide, against the quality bar.** A group becomes a skill only if it clears
   every hard gate. 
4. **Generate / modify ≤ 5 skills.** Where each lands depends on whether it
   already exists:
   - **Extending an existing skill** → edit it **in place** at the skill path.
     Don't fork or copy it. Skill Studio tracks every skill in git, so the user
     reviews your uncommitted changes (flagged on its home page) and either saves
     a version or reverts.
   - **A brand-new skill** → write it under
     `~/.agents/skills/generated-skills/<name>/`. Skill Studio surfaces anything
     staged there as a **Proposed** skill the user can **Accept** (promote into
     `~/.agents/skills/`) or **Discard** — so don't drop new skills straight into a
     live home.

5. **Report.** List what you created/modified.
   Include any repo documentation files you think should be updated instead of,
   or in addition to, the skill changes.

## Extending to other agents

Each agent stores transcripts differently. To support a new one (Gemini CLI,
opencode, Cursor, …) add a `(discover_fn, parse_fn)` pair to
`common.py:ADAPTERS` that yields the normalized record (`_norm(...)`). The rest
of the pipeline is unchanged. Cursor (sqlite `state.vscdb`) is not yet wired up.

## Notes

- Read-only over your transcripts; the only writes are the `--out` artifacts and
  the skills you choose to generate or improve — new skills land staged under
  `~/.agents/skills/generated-skills/`, edits go in place to the existing skill.
- Sub-agent / review threads (Claude Code sidechains, Codex `thread_source:
  subagent`) are filtered out — only real user conversations are mined.
