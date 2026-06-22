#!/usr/bin/env python3
"""Stage 1 — discover conversation transcripts across coding agents.

Walks each registered adapter (Claude Code, Codex, ...), keeps files touched in
the last N days, and writes an inventory. Cheap: only stats files here; the full
parse + LLM labeling happens in extract.py.

  python3 discover.py --since 35 --out ./out/inventory.jsonl
  python3 discover.py --agents codex --since 14
"""
import argparse, os, json, time, sys
import common

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=35, help="max age in days (by file mtime)")
    ap.add_argument("--agents", default="", help="comma list; default = all registered adapters")
    ap.add_argument("--out", default="./out/inventory.jsonl")
    args = ap.parse_args()

    agents = [a.strip() for a in args.agents.split(",") if a.strip()] or list(common.ADAPTERS)
    unknown = [a for a in agents if a not in common.ADAPTERS]
    if unknown:
        sys.exit(f"unknown agent(s): {unknown}. known: {list(common.ADAPTERS)}")

    cutoff = time.time() - args.since * 86400
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    rows, per_agent = [], {}
    for agent in agents:
        discover_fn, _ = common.ADAPTERS[agent]
        n = 0
        for path in discover_fn():
            mt = common.path_mtime(path)  # file mtime, or a DB adapter's embedded epoch
            if mt is None or mt < cutoff: continue
            rows.append({"agent": agent, "path": path,
                         "mtime": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(mt))})
            n += 1
        per_agent[agent] = n

    rows.sort(key=lambda r: r["mtime"])
    with open(args.out, "w") as f:
        for r in rows: f.write(json.dumps(r) + "\n")

    print(f"discovered {len(rows)} candidate conversations (<= {args.since}d) -> {args.out}")
    for a, n in per_agent.items():
        print(f"  {a:14s} {n}")
    if rows:
        print(f"  date range: {rows[0]['mtime'][:10]} .. {rows[-1]['mtime'][:10]}")

if __name__ == "__main__":
    main()
