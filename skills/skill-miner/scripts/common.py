"""Shared parsing/normalization for skill-miner.

Agent-agnostic: each *source adapter* knows where one agent CLI stores its
conversation transcripts and how to read one. Every adapter yields a normalized
Conversation dict so the rest of the pipeline (extract, grouping, generation) is
identical regardless of which coding agent produced the logs.

Pure standard library on purpose — no third-party deps, so the skill runs under
any agent/host without an install step.
"""
import json, os, re, glob, time

HOME = os.path.expanduser("~")

# ---------------------------------------------------------------- text helpers
_SR   = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
_IDE  = re.compile(r"<ide_[^>]*>.*?</ide_[^>]*>", re.S)
_CMD  = re.compile(r"<(?:local-)?command-[^>]*>.*?</(?:local-)?command-[^>]*>", re.S)
_NOTIF = re.compile(r"<task-notification>.*?</task-notification>", re.S)
_WS   = re.compile(r"\s+")
# absolute paths (under HOME or /tmp) and @-mentions, used to infer where work happened
_ABS  = re.compile(r"(?:/home/[\w.\-]+|/tmp|/Users/[\w.\-]+)/[\w./\-]+")
_MENT = re.compile(r"@([A-Za-z0-9_][\w./\-]+)")
FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.S)

# slash-commands that are built-in CLI controls, NOT user skills
BUILTIN_CMDS = {"compact","clear","config","help","model","login","logout","status",
                "cost","resume","exit","quit","fast","vim","doctor","memory","add-dir",
                "agents","mcp","terminal-setup","bug","release-notes","pr-comments",
                "effort","upgrade","rate-limit-options","install-github-app","context",
                "output-style","statusline","hooks","permissions","rewind","todos"}

def clean(t):
    if not t: return ""
    t = _SR.sub("", t); t = _IDE.sub("", t); t = _CMD.sub("", t); t = _NOTIF.sub("", t)
    return _WS.sub(" ", t).strip()

# skill-miner's own prompts — if a transcript contains these it's scratch output
# from a host-CLI LLM backend (e.g. `claude -p`), not a real conversation. Drop it.
SENTINELS = (
    "[skill-miner:llm-call v1",              # primary: stamped into every llm.py prompt
    "You are a strict JSON labeler",
    "Label one developer",                   # labeling prompts (wording varies by version)
    "labeling one developer",
    "Cluster these developer coding-agent sessions",
    "USER MESSAGES (in order)",
)

def is_self_scratch(users):
    joined = "\n".join(users)[:4000]
    return any(s in joined for s in SENTINELS)

def strip_agent_context(text):
    """Remove IDE/instruction scaffolding that agents prepend to a user turn,
    keeping the human's actual request. (Codex prepends '# Context from my IDE
    setup:' and '# AGENTS.md instructions'.)"""
    if not text: return ""
    if text.lstrip().startswith("# AGENTS.md"): return ""        # pure system injection
    keep = []
    for ln in text.splitlines():
        s = ln.strip()
        if re.match(r"#\s*Context from my IDE setup", s, re.I): continue
        if re.match(r"##\s*(Active file|Open tabs|Selected text|Cursor|Recently)", s, re.I): continue
        if re.match(r"-\s+\S+\.\w+\b", s): continue              # file-tab bullets
        if re.match(r"</?(INSTRUCTIONS|environment_context|environment|user_instructions)>", s): continue
        keep.append(ln)
    return "\n".join(keep).strip()

def iter_jsonl(path):
    try:
        with open(path, errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line: continue
                try: yield json.loads(line)
                except Exception: continue
    except Exception:
        return

def _loads(s):
    try: return json.loads(s)
    except Exception: return None

def path_mtime(path):
    """Modification time of a discovered conversation, for the discover.py window
    filter. File-backed adapters yield real paths (stat them); DB-backed adapters
    (opencode — one SQLite file, no per-conversation file) embed their own
    epoch-seconds after a `#mtime=` suffix on a synthetic id."""
    if "#mtime=" in path:
        try: return float(path.rsplit("#mtime=", 1)[1])
        except ValueError: return None
    try: return os.path.getmtime(path)
    except OSError: return None

# ---------------------------------------------------------------- path / main_dir
def extract_paths_from_text(text, cwd):
    """Best-effort touched-file paths from free text: absolute paths + @mentions."""
    out = []
    for m in _ABS.findall(text or ""):
        out.append(m.rstrip(".,;:)"))
    for mn in _MENT.findall(text or ""):
        mn = mn.rstrip(".,;:)#")
        if mn.startswith("/"):
            out.append(mn)
        elif cwd:
            # try cwd/mention, else a sibling of cwd (covers multi-root @Repo/... refs)
            cand = os.path.join(cwd, mn)
            if os.path.exists(cand):
                out.append(cand)
            else:
                sib = os.path.join(os.path.dirname(cwd.rstrip("/")), mn)
                out.append(sib if os.path.exists(sib) else cand)
    return out

def _ancestors(p):
    parts = p.split("/")
    return ["/".join(parts[:i]) for i in range(2, len(parts))]  # dirs above the file

def repo_root(p, project_roots):
    """The project a path belongs to: the longest known session-cwd that is a prefix,
    else a HOME+2-segments heuristic, else first 3 segments."""
    best = None
    for r in project_roots:
        if p == r or p.startswith(r.rstrip("/") + "/"):
            if best is None or len(r) > len(best): best = r
    if best: return best
    if p.startswith(HOME + "/"):
        rest = p[len(HOME) + 1:].split("/")
        return HOME + "/" + "/".join(rest[:2])
    parts = p.split("/")
    return "/".join(parts[:4]) if len(parts) >= 4 else p

def compute_main_dir(weighted, project_roots, primary_cwd):
    """Within the dominant repo (most work weight), the deepest folder covering
    >=60% of that repo's weight. Falls back to the session cwd."""
    weighted = [(p, w) for p, w in weighted if p and "/" in p]
    if not weighted:
        return primary_cwd or "?"
    roots = {}
    for p, w in weighted:
        r = repo_root(p, project_roots); roots[r] = roots.get(r, 0) + w
    dom = max(roots, key=roots.get)
    dompaths = [(p, w) for p, w in weighted if repo_root(p, project_roots) == dom]
    domtotal = sum(w for _, w in dompaths) or 1
    anc = {}
    for p, w in dompaths:
        for d in _ancestors(p): anc[d] = anc.get(d, 0) + w
    cands = [d for d, c in anc.items() if c >= 0.6 * domtotal and (d == dom or d.startswith(dom + "/"))]
    return max(cands, key=lambda d: (d.count("/"), anc[d])) if cands else dom

def shorten(path):
    return (path or "?").replace(HOME + "/", "~/") if path else "?"

# ================================================================ ADAPTERS
# Each adapter is a generator over conversation-file paths and a parser that
# returns a normalized record (or None to skip). Register new agents here.

def _claude_meta(path):
    cwd = None; first = None
    for o in iter_jsonl(path):
        if first is None and o.get("timestamp"): first = o["timestamp"]
        if cwd is None and o.get("cwd"): cwd = o["cwd"]
        if cwd and first: break
    return cwd, first

def claude_discover(roots=None):
    base = os.path.join(HOME, ".claude", "projects")
    # top-level files only; per-project subdirs hold sub-agent sidechains
    for f in glob.glob(os.path.join(base, "*", "*.jsonl")):
        yield f

def claude_parse(path):
    cwds = {}; first = last = None; users = []; weighted = []; skills = set()
    events = []  # ordered ("user", text) / ("skill", name) — lets the labeler see post-skill reactions
    for o in iter_jsonl(path):
        ts = o.get("timestamp")
        if ts:
            if first is None: first = ts
            last = ts
        if o.get("cwd"): cwds[o["cwd"]] = cwds.get(o["cwd"], 0) + 1
        m = o.get("message") or {}
        if o.get("type") == "assistant":
            for b in (m.get("content") or []):
                if not (isinstance(b, dict) and b.get("type") == "tool_use"): continue
                nm = b.get("name"); inp = b.get("input") or {}
                if nm in ("Edit", "MultiEdit", "Write", "NotebookEdit") and inp.get("file_path"):
                    weighted.append((inp["file_path"], 3))
                elif nm == "Read" and inp.get("file_path"):
                    weighted.append((inp["file_path"], 1))
                elif nm in ("Grep", "Glob") and inp.get("path"):
                    weighted.append((inp["path"], 1))
                elif nm == "Bash":
                    cwd = next(iter(cwds), None)
                    for p in extract_paths_from_text(inp.get("command", ""), cwd): weighted.append((p, 1))
                elif nm == "Skill":
                    s = (inp.get("skill") or inp.get("name") or "").strip().lstrip("/")
                    if s:
                        skills.add(s)
                        if events[-1:] != [("skill", s)]: events.append(("skill", s))
        elif o.get("type") == "user" and not o.get("isMeta") and not o.get("isCompactSummary"):
            c = m.get("content")
            if isinstance(c, list) and all(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                continue
            raw = c if isinstance(c, str) else " ".join(
                b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text") if isinstance(c, list) else ""
            for nm in re.findall(r"<command-name>\s*/?([\w:-]+)", raw or ""):
                if nm not in BUILTIN_CMDS:
                    skills.add(nm)
                    if events[-1:] != [("skill", nm)]: events.append(("skill", nm))
            t = clean(raw)
            if not t or t.startswith("Caveat:") or t.startswith("[Request interrupted"): continue
            users.append(t)
            events.append(("user", t))
            cwd = max(cwds, key=cwds.get) if cwds else None
            for p in extract_paths_from_text(raw, cwd): weighted.append((p, 1))
    if not users: return None
    return _norm("claude-code", path, os.path.basename(path)[:-6], cwds, first, last, users, weighted, skills, events)

def codex_discover(roots=None):
    base = os.path.join(HOME, ".codex", "sessions")
    for f in glob.glob(os.path.join(base, "**", "rollout-*.jsonl"), recursive=True):
        yield f

def _opencode_conn():
    """Read-only connection to opencode's SQLite store, or None if it's absent /
    can't be opened. `mode=ro` never creates or write-locks the file, and WAL
    allows concurrent readers, so this is safe while opencode is running. sqlite3
    is stdlib but imported lazily so a Python built without it still mines the
    file-based agents."""
    db = os.path.join(HOME, ".local", "share", "opencode", "opencode.db")
    if not os.path.exists(db):
        return None
    try:
        import sqlite3
        return sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2.0)
    except Exception:
        return None

def _ms_to_iso(ms):
    """opencode times are epoch-ms ints; the pipeline sorts/serializes ISO
    strings (parse_ts reads them back), so normalize to the shared shape."""
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ms / 1000.0))
    except Exception:
        return None

def opencode_discover(roots=None):
    # One DB holds every session, so there's no per-conversation file to stat.
    # Yield a synthetic id carrying the session's last-activity epoch after a
    # `#mtime=` suffix; discover.py's window filter honors it via path_mtime().
    conn = _opencode_conn()
    if conn is None:
        return
    try:
        rows = conn.execute(
            "select s.id, coalesce(max(m.time_created), s.time_created) "
            "from session s left join message m on m.session_id = s.id "
            "group by s.id"
        ).fetchall()
    except Exception:
        rows = []
    finally:
        conn.close()
    for sid, last_ms in rows:
        yield f"opencode:{sid}#mtime={(last_ms or 0) / 1000.0}"

def opencode_parse(path):
    sid = path.split("#mtime=", 1)[0].split("opencode:", 1)[-1]
    conn = _opencode_conn()
    if conn is None:
        return None
    try:
        srow = conn.execute("select directory from session where id=?", (sid,)).fetchone()
        if not srow:
            return None
        cwds = {}
        if srow[0]:
            cwds[srow[0]] = cwds.get(srow[0], 0) + 5  # the session's own cwd, weighted
        users = []; weighted = []; events = []; skills = set(); first = last = None
        msgs = conn.execute(
            "select id, data, time_created from message where session_id=? order by time_created, id", (sid,)
        ).fetchall()
        for mid, mdata, mtime in msgs:
            try: md = json.loads(mdata)
            except Exception: continue
            role = md.get("role")
            if mtime:
                if first is None: first = mtime
                last = mtime
            parts = conn.execute(
                "select data from part where message_id=? order by time_created, id", (mid,)
            ).fetchall()
            cwd = max(cwds, key=cwds.get) if cwds else None
            if role == "user":
                # real user text only: skip the synthetic parts opencode injects
                # for tool descriptions ("Called the Read tool with ...").
                texts = []
                for (pdata,) in parts:
                    pd = _loads(pdata)
                    if pd and pd.get("type") == "text" and not pd.get("synthetic"):
                        texts.append(pd.get("text", ""))
                raw = "\n".join(t for t in texts if t)
                for nm in re.findall(r"<command-name>\s*/?([\w:-]+)", raw or ""):
                    if nm not in BUILTIN_CMDS:
                        skills.add(nm)
                        if events[-1:] != [("skill", nm)]: events.append(("skill", nm))
                t = clean(strip_agent_context(raw))
                if t and len(t) > 8:
                    users.append(t); events.append(("user", t))
                for p in extract_paths_from_text(raw, cwd): weighted.append((p, 1))
            elif role == "assistant":
                for (pdata,) in parts:
                    pd = _loads(pdata)
                    if not pd: continue
                    pt = pd.get("type")
                    if pt == "tool":
                        tool = (pd.get("tool") or "").lower()
                        inp = (pd.get("state") or {}).get("input") or {}
                        fp = inp.get("filePath") or inp.get("file_path") or inp.get("path")
                        if tool in ("edit", "write", "patch") and fp: weighted.append((fp, 3))
                        elif tool == "read" and fp: weighted.append((fp, 1))
                        elif tool in ("grep", "glob", "list", "ls") and (inp.get("path") or fp):
                            weighted.append((inp.get("path") or fp, 1))
                        elif tool == "bash":
                            for p in extract_paths_from_text(inp.get("command", ""), cwd): weighted.append((p, 1))
                    elif pt == "patch":
                        files = pd.get("files")
                        if isinstance(files, dict): files = list(files.keys())
                        if isinstance(files, list):
                            for f in files:
                                if isinstance(f, str): weighted.append((f, 3))
    finally:
        conn.close()
    if not users:
        return None
    return _norm("opencode", f"opencode:{sid}", sid, cwds,
                 _ms_to_iso(first), _ms_to_iso(last), users, weighted, skills, events)

def codex_parse(path):
    cwds = {}; first = last = None; users = []; weighted = []; sess_id = None
    for o in iter_jsonl(path):
        t = o.get("type"); pl = o.get("payload") or {}
        ts = o.get("timestamp")
        if ts:
            if first is None: first = ts
            last = ts
        if t == "session_meta":
            # skip sub-agent / review threads (not real user conversations)
            if pl.get("thread_source") == "subagent" or "subagent" in (pl.get("source") or {}):
                return None
            sess_id = pl.get("id")
            if pl.get("cwd"): cwds[pl["cwd"]] = cwds.get(pl["cwd"], 0) + 5
            if pl.get("timestamp") and first is None: first = pl["timestamp"]
        elif t == "turn_context" and pl.get("cwd"):
            cwds[pl["cwd"]] = cwds.get(pl["cwd"], 0) + 1
        elif t == "response_item":
            cwd = max(cwds, key=cwds.get) if cwds else None
            if pl.get("type") == "message" and pl.get("role") == "user":
                txt = "\n".join(c.get("text", "") for c in (pl.get("content") or []) if isinstance(c, dict))
                # strip IDE/AGENTS scaffolding but keep the real request; use the
                # raw text (incl. context) for path inference (Active-file hints).
                t2 = clean(strip_agent_context(txt))
                if t2 and len(t2) > 8:
                    users.append(t2)
                for p in extract_paths_from_text(txt, cwd): weighted.append((p, 1))
            elif pl.get("type") in ("function_call", "local_shell_call", "custom_tool_call"):
                blob = json.dumps(pl.get("arguments") or pl.get("action") or pl.get("input") or "")
                for p in extract_paths_from_text(blob, cwd): weighted.append((p, 1))
    if not users: return None
    return _norm("codex", path, sess_id or os.path.basename(path), cwds, first, last, users, weighted, set())

def _norm(agent, path, sid, cwds, first, last, users, weighted, skills, events=None):
    if not users or is_self_scratch(users):
        return None
    primary = max(cwds, key=cwds.get) if cwds else None
    # condensed = numbered user turns, with [skill used: X] markers interleaved in
    # chronological order so the labeler can read the turns after a skill ran as
    # the user's reaction to it. Adapters without skill events just pass users.
    if events is None:
        events = [("user", t) for t in users]
    lines = []; n = 0
    for kind, t in events:
        if kind == "user":
            n += 1
            lines.append(f"{n}. {t[:300]}")
        else:
            lines.append(f"   [skill used: {t}]")
    return {
        "agent": agent, "path": path, "session_id": sid,
        "primary_cwd": primary, "all_cwds": sorted(cwds, key=lambda k: -cwds[k]),
        "first_ts": first, "last_ts": last, "n_user_turns": len(users),
        "condensed": "\n".join(lines)[:10000],
        "weighted_paths": weighted, "skills_used": sorted(skills),
    }

# registry: name -> (discover_fn, parse_fn).  Add new agents here.
ADAPTERS = {
    "claude-code": (claude_discover, claude_parse),
    "codex":       (codex_discover, codex_parse),
    "opencode":    (opencode_discover, opencode_parse),
}

def parse_ts(ts):
    if not ts: return 0.0
    s = ts.replace("Z", "+0000")
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try: return time.mktime(time.strptime(s.split(".")[0] if "%f" not in fmt else s, fmt))
        except Exception: continue
    try: return time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception: return 0.0
