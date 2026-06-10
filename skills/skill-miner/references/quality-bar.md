# Quality bar for generating / modifying a skill

A skill is only worth creating when it will **save real, repeated effort** or
**encode hard-won knowledge that keeps getting re-derived**. Most conversation
groups should NOT become skills. Be strict — a wrong or vague skill is worse
than none, because it pollutes the agent's skill list and misfires.

## A candidate must pass ALL of these (hard gates)

1. **Frequency** — the skill, if created, would have been used more than 1 time in the past conversations analyzed. 
2. **Complexity** — it captures a *multi-step procedure*, a recurring
   *failure-diagnosis path* (something the agent
   re-figures-out each time), or *durable systematic project knowledge* .
3. **Non-overlap** — it does **not** duplicate a skill already listed in the
   context. If it partially overlaps, it must **extend** that skill, not replace
   it. If the context does not include exact paths, run
   `scripts/skills_inventory.py` once and use its output to find files to edit.
4. **Concreteness** — a clear trigger ("use when…") and concrete steps, commands,
   queries, or a bundled script. Reject anything that reads like "an assistant
   for X" or "help with Y".

## Reject if any of these (kill switches)

- Vague, broad, or aspirational ("improve debugging", "frontend helper").
- Substantially overlaps an existing skill without a concrete extension.
- Pure one-time migration or a feature that is now done.
- Would mostly restate general engineering advice the model already knows. Skills encode specific information. If it could be in a LLM's pretraining data, probably don't include it. 

## Output discipline

- **Cap: 5 skills** per run. If more than 5 pass, keep the highest-impact 5
  (frequency × effort-saved × confidence) and list the rest as "deferred".
- **Prefer extending** an existing skill over creating a near-duplicate.
- Rank the chosen skills and explain, for each rejected high-count group, **why**
  it did not clear the bar.
