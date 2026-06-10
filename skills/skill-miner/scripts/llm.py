"""Provider-agnostic *small/cheap* LLM client. Standard library only.

Backend resolution (override with SKILL_MINER_LLM=<backend>):
  1. openai      — needs OPENAI_API_KEY        (default model gpt-4o-mini)
  2. gemini      — needs GEMINI_API_KEY/GOOGLE_API_KEY (default gemini-2.0-flash)
  3. openrouter  — needs OPENROUTER_API_KEY     (default google/gemini-2.0-flash-001)
  4. claude-cli  — needs `claude` on PATH        (default model haiku)
  5. codex-cli   — needs `codex` on PATH         (best-effort)
  6. gemini-cli  — needs `gemini` on PATH        (best-effort)
Model override: SKILL_MINER_MODEL.  Endpoint override: SKILL_MINER_BASE_URL.

The point: the skill works whether the host is Claude Code, Codex, Gemini CLI,
or a bare shell with an API key — "as long as it has access to a small LLM."

Public API:  complete_json(system, user, max_tokens=900) -> dict
             detect_backend() -> (backend_name, model)
"""
import os, sys, json, re, shutil, subprocess, urllib.request, urllib.error

FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.S)
_OBJ  = re.compile(r"\{.*\}", re.S)

# Stamped into every prompt. Host-CLI backends (claude -p / codex exec) persist
# each call as a transcript; this marker lets discover/extract recognize and skip
# the skill's own scratch so it never re-ingests its own output. See common.SENTINELS.
MARKER = "[skill-miner:llm-call v1 — synthetic prompt, not a real conversation]"

def _env(*names):
    for n in names:
        v = os.environ.get(n)
        if v: return v
    return None

def detect_backend():
    forced = os.environ.get("SKILL_MINER_LLM")
    model  = os.environ.get("SKILL_MINER_MODEL")
    def pick(b, default_model):
        return b, (model or default_model)
    order = [forced] if forced else ["openai", "gemini", "openrouter", "claude-cli", "codex-cli", "gemini-cli"]
    for b in order:
        if b == "openai" and _env("OPENAI_API_KEY"):           return pick("openai", "gpt-4o-mini")
        if b == "gemini" and _env("GEMINI_API_KEY", "GOOGLE_API_KEY"): return pick("gemini", "gemini-2.0-flash")
        if b == "openrouter" and _env("OPENROUTER_API_KEY"):   return pick("openrouter", "google/gemini-2.0-flash-001")
        if b == "claude-cli" and shutil.which("claude"):       return pick("claude-cli", "haiku")
        if b == "codex-cli" and shutil.which("codex"):         return pick("codex-cli", "gpt-5-mini")
        if b == "gemini-cli" and shutil.which("gemini"):       return pick("gemini-cli", "gemini-2.0-flash")
    if forced:
        raise RuntimeError(f"SKILL_MINER_LLM={forced} but its key/CLI is unavailable")
    raise RuntimeError("No LLM backend available. Set OPENAI_API_KEY / GEMINI_API_KEY / "
                       "OPENROUTER_API_KEY, or install a `claude`/`codex`/`gemini` CLI.")

def _http_json(url, payload, headers, timeout=120):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def _strip(text):
    out = FENCE.sub("", (text or "").strip()).strip()
    m = _OBJ.search(out)
    return m.group(0) if m else out

def _call(backend, model, system, user, max_tokens):
    system = MARKER + "\n" + system
    if backend == "openai" or backend == "openrouter":
        key = _env("OPENAI_API_KEY") if backend == "openai" else _env("OPENROUTER_API_KEY")
        base = os.environ.get("SKILL_MINER_BASE_URL") or (
            "https://api.openai.com/v1" if backend == "openai" else "https://openrouter.ai/api/v1")
        body = {"model": model, "max_tokens": max_tokens, "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        j = _http_json(base.rstrip("/") + "/chat/completions", body, {"Authorization": f"Bearer {key}"})
        return j["choices"][0]["message"]["content"]
    if backend == "gemini":
        key = _env("GEMINI_API_KEY", "GOOGLE_API_KEY")
        base = os.environ.get("SKILL_MINER_BASE_URL") or "https://generativelanguage.googleapis.com/v1beta"
        url = f"{base.rstrip('/')}/models/{model}:generateContent?key={key}"
        body = {"systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {"temperature": 0, "maxOutputTokens": max_tokens,
                                     "responseMimeType": "application/json"}}
        j = _http_json(url, body, {})
        return j["candidates"][0]["content"]["parts"][0]["text"]
    # ---- CLI backends: one-shot, non-interactive ----
    prompt = system + "\n\n" + user
    if backend == "claude-cli":
        cmd = ["claude", "-p", prompt, "--model", model]
    elif backend == "codex-cli":
        cmd = ["codex", "exec", "--model", model, "--skip-git-repo-check", prompt]
    elif backend == "gemini-cli":
        cmd = ["gemini", "-m", model, "-p", prompt]
    else:
        raise RuntimeError(f"unknown backend {backend}")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode != 0 and not r.stdout.strip():
        raise RuntimeError(f"{backend} failed: {r.stderr[:200]}")
    return r.stdout

def complete_json(system, user, max_tokens=900, retries=2):
    backend, model = detect_backend()
    last = None
    for attempt in range(retries + 1):
        try:
            raw = _call(backend, model, system, user, max_tokens)
            return json.loads(_strip(raw))
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError,
                subprocess.TimeoutExpired, RuntimeError, KeyError) as e:
            last = e
            if attempt < retries and isinstance(e, urllib.error.HTTPError) and e.code in (429, 500, 502, 503):
                continue
            if attempt < retries and isinstance(e, (json.JSONDecodeError, subprocess.TimeoutExpired, urllib.error.URLError)):
                continue
            break
    raise RuntimeError(f"LLM call failed via {backend}/{model}: {last}")

if __name__ == "__main__":
    if "--check" in sys.argv:
        try:
            b, m = detect_backend(); print(f"backend={b}  model={m}  OK")
        except RuntimeError as e:
            print(f"NO BACKEND: {e}"); sys.exit(1)
    elif "--test" in sys.argv:
        b, m = detect_backend(); print(f"using {b}/{m}")
        print(complete_json("You output only JSON.", 'Return {"ok": true, "n": 2+2}.'))
    else:
        print(__doc__)
