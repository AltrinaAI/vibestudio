#!/usr/bin/env python3
"""Stage 2 — distill each conversation into a structured row (the JSONL).

For every discovered conversation: parse it (agent-specific adapter) to user
turns + touched paths, infer `main_dir` (deepest folder where most work happened)
and `datetime`/`skills_used` deterministically, then call a CHEAP LLM for the
`theme` (headline), `topics` (full-sentence scope, one per conv unless the
subject genuinely shifts) and `feedback` (a short natural-language summary of
explicit user feedback — corrections, durable preferences, asserted domain
facts; "" for most sessions). Writes conversations.jsonl.

  python3 extract.py --inventory ./skill-miner-out/inventory.jsonl \
                     --out ./skill-miner-out/conversations.jsonl --workers 12
  python3 extract.py --limit 10        # quick sample while testing
"""
import argparse, json, os, sys
from concurrent.futures import ThreadPoolExecutor
import common, llm

SYS = ("You are a strict JSON labeler. Output ONLY one JSON object: no prose, "
       "no code fences, no echoing of input data.")

PROMPT = """Label one developer coding-agent session to capture its SCOPE so similar sessions can be grouped later. Below are the user's messages in order (tool output stripped).{skill_note}

Output ONLY one JSON object with exactly:
- "theme": a short headline label (max ~12 words) naming what the session did.
- "topics": an array of FULL SENTENCES, each a semantically meaningful description of a distinct subject/thread of work. Use ONE topic for most sessions. Add another ONLY when the conversation clearly shifts to a substantially different subject (NOT minor follow-ups, tweaks, bug-fixes, or sub-steps of the same effort). Aim for 1; rarely more than 2-3.
- "feedback": one short natural-language sentence (two at most) summarizing any EXPLICIT user feedback in the session: corrections to the agent's work or approach, durable preferences/rules for how work should be done, asserted domain facts the agent didn't know, clear approval or frustration. Most sessions have none — then use "". Plain task requests and instructions are NOT feedback.

If the session is empty/trivial, use theme "trivial/empty session" and a single topic saying so.

USER MESSAGES (in order):
<<<
{body}
>>>"""

SKILL_NOTE = (" Lines like `[skill used: X]` mark where the agent invoked a skill; how the"
              " user responds right after one is feedback worth summarizing.")

def label(condensed):
    has_skills = "[skill used:" in (condensed or "")
    try:
        j = llm.complete_json(SYS, PROMPT.format(
                body=condensed or "(no user messages)",
                skill_note=SKILL_NOTE if has_skills else ""), max_tokens=700)
        tp = j.get("topics")
        if isinstance(tp, str): tp = [tp]
        fb = j.get("feedback", "")
        if isinstance(fb, (list, tuple)):  # tolerate a stray array from small models
            fb = "; ".join(str(x).strip() for x in fb if str(x).strip())
        return {"theme": str(j.get("theme", ""))[:200],
                "topics": [str(x).strip()[:400] for x in (tp or []) if str(x).strip()][:5],
                "feedback": str(fb).strip()[:300]}
    except Exception as e:
        return {"theme": "<error>", "topics": ["error"], "feedback": "", "error": str(e)[:120]}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inventory", default="./skill-miner-out/inventory.jsonl")
    ap.add_argument("--out", default="./skill-miner-out/conversations.jsonl")
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--limit", type=int, default=0, help="cap conversations (testing)")
    args = ap.parse_args()

    try:
        b, m = llm.detect_backend(); print(f"LLM backend: {b}/{m}", file=sys.stderr)
    except RuntimeError as e:
        sys.exit(str(e))

    inv = [json.loads(l) for l in open(args.inventory)]
    if args.limit: inv = inv[-args.limit:]   # newest N (inventory is mtime-sorted)
    print(f"parsing {len(inv)} conversations...", file=sys.stderr)

    records = []
    for row in inv:
        parse = common.ADAPTERS[row["agent"]][1]
        try: rec = parse(row["path"])
        except Exception: rec = None
        if rec: records.append(rec)
    print(f"  {len(records)} have real user content (rest skipped: empty/subagent)", file=sys.stderr)

    project_roots = {r["primary_cwd"] for r in records if r.get("primary_cwd")}
    for r in records:
        r["main_dir"] = common.shorten(common.compute_main_dir(r["weighted_paths"], project_roots, r["primary_cwd"]))

    def work(r):
        r.update(label(r["condensed"]))
        return r
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        results = []
        for r in ex.map(work, records):
            done += 1
            if done % 10 == 0 or done == len(records):
                print(f"  labeled {done}/{len(records)}", file=sys.stderr)
            results.append(r)

    results.sort(key=lambda r: r.get("first_ts") or "")
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    nerr = 0
    with open(args.out, "w") as f:
        for r in results:
            if r["theme"] == "<error>": nerr += 1
            f.write(json.dumps({
                "agent": r["agent"], "session_id": r["session_id"], "path": r["path"],
                "main_dir": r["main_dir"], "datetime": r["first_ts"],
                "n_user_turns": r["n_user_turns"], "theme": r["theme"],
                "topics": r["topics"], "skills_used": r["skills_used"],
                "feedback": r["feedback"],
            }, ensure_ascii=False) + "\n")
    print(f"wrote {len(results)} rows -> {args.out}  ({nerr} label errors)", file=sys.stderr)

if __name__ == "__main__":
    main()
