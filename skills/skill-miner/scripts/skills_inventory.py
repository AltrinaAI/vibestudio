#!/usr/bin/env python3
"""List local skills and their SKILL.md paths.

Use this after the active context says a skill should be extended, but the
context does not provide exact paths. This script is a path inventory, not the
source of truth for which skills belong in the landscape.

  python3 skills_inventory.py
  python3 skills_inventory.py --name skill-miner
  python3 skills_inventory.py --name skill-miner --root /path/to/project/.agents/skills
"""
import argparse
import json
import os
import re
import sys


DEFAULT_ROOTS = [
    os.path.expanduser("~/.agents/skills"),
    os.path.expanduser("~/.agent/skills"),
    os.path.expanduser("~/.claude/skills"),
    os.path.expanduser("~/.codex/skills"),
    os.path.expanduser("~/.codex/plugins/cache"),
    os.path.expanduser("~/.cursor/skills"),
]
SKIP_DIRS = {".git", "__pycache__", "node_modules", "generated-skills"}


def normalize(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def frontmatter(path):
    try:
        with open(path, errors="replace") as handle:
            text = handle.read(4096)
    except OSError:
        return None

    match = re.match(r"\s*---\s*\n(.*?)\n---", text, re.S)
    block = match.group(1) if match else text
    name_match = re.search(r"^name:\s*(.+)$", block, re.M)
    desc_match = re.search(r"^description:\s*(.*)$", block, re.M)
    name = name_match.group(1).strip().strip("\"'") if name_match else None
    description = desc_match.group(1).strip().strip("\"'") if desc_match else ""
    return {
        "name": name or os.path.basename(os.path.dirname(path)),
        "description": re.sub(r"\s+", " ", description)[:300],
        "path": path,
    }


def skill_files(root):
    if not os.path.isdir(root):
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(name for name in dirnames if name not in SKIP_DIRS)
        if "SKILL.md" in filenames:
            yield os.path.join(dirpath, "SKILL.md")
            dirnames[:] = []


def query_keys(query):
    return {normalize(query), normalize(query.split(":")[-1])}


def matches(skill, query):
    skill_keys = {
        normalize(skill["name"]),
        normalize(os.path.basename(os.path.dirname(skill["path"]))),
    }
    return bool(skill_keys & query_keys(query))


def main():
    parser = argparse.ArgumentParser(description="List local skills and their paths.")
    parser.add_argument("--name", action="append", default=[], help="Optional skill name filter.")
    parser.add_argument(
        "--root",
        action="append",
        default=[],
        help="Extra skill root to search, such as <repo>/.agents/skills.",
    )
    args = parser.parse_args()

    roots = DEFAULT_ROOTS + [os.path.abspath(root) for root in args.root]
    seen = set()
    found = []
    for root in roots:
        for path in skill_files(root):
            real_path = os.path.realpath(path)
            if real_path in seen:
                continue
            seen.add(real_path)
            skill = frontmatter(path)
            if skill and (not args.name or any(matches(skill, name) for name in args.name)):
                found.append(skill)

    found.sort(key=lambda skill: (skill["name"], skill["path"]))
    print(json.dumps(found, indent=2, ensure_ascii=False))
    return 0 if found else 1


if __name__ == "__main__":
    sys.exit(main())
