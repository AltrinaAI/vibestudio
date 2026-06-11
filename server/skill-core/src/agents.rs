//! The agent interface. Every agent CLI Skill Studio integrates with is one
//! [`AgentDef`] entry declaring the shared properties an integration needs:
//!
//! - **skills_dirs** — where the agent discovers skills (its own folders, plus
//!   the shared standard when `reads_shared`),
//! - **trigger** — how to run it programmatically: a zero-interaction headless
//!   command that narrates progress to the pane, records its session id to
//!   `<run_dir>/`[`SESSION_FILE`], and creates `<run_dir>/`[`DONE_FILE`] iff it
//!   completed successfully (`prepare` drops any helper files it needs),
//! - **resume** — how to reopen that recorded session as the interactive TUI.
//!
//! Features (mining, install, terminals) consult this registry instead of
//! matching on family names, so supporting a new agent = filling in one entry.
//! A `None` capability means the agent can't do that yet and the UI degrades
//! accordingly (e.g. it isn't offered for mining runs).

use std::path::Path;

use crate::secrets::sh_quote as q;

/// File inside a run dir where the trigger records the agent's session id;
/// the resume line reads it back.
pub const SESSION_FILE: &str = "session-id";

/// File inside a run dir the trigger creates iff the run completed
/// successfully — the completion signal callers watch. Harness-written
/// (claude: watch.py on the final `result` event; codex: `exec`'s exit
/// status), never entrusted to the model's prompt compliance.
pub const DONE_FILE: &str = "done";

/// Home-relative dirs of the shared Agent Skills standard, read by every
/// `reads_shared` agent (Codex, Cursor, Gemini CLI, …; not Claude Code).
pub const SHARED_SKILLS_DIRS: &[&str] = &[".agents/skills", ".agent/skills"];

/// Context for building a headless trigger line. The line must run without
/// any interactive prompt (nobody is watching to answer one), stream progress
/// to the pane, and exit when the prompt is done.
pub struct TriggerCtx<'a> {
    pub bin: &'a str,
    /// Working dir of the run; [`SESSION_FILE`] and helper files live here.
    pub run_dir: &'a Path,
    pub prompt: &'a str,
    /// Model / reasoning-effort overrides (None = the CLI's default).
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
}

/// Context for building a resume line: reopen the session recorded in
/// `<run_dir>/`[`SESSION_FILE`] as the interactive TUI, same tuning.
pub struct ResumeCtx<'a> {
    pub bin: &'a str,
    pub run_dir: &'a Path,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
}

/// Drop helper files the trigger line needs into the run dir.
pub type PrepareFn = fn(&Path) -> Result<(), String>;

pub struct AgentDef {
    /// Family id — the prefix of skill-term agent ids ("claude" in "claude:cli").
    pub family: &'static str,
    pub label: &'static str,
    /// The agent's OWN skill-discovery dirs, home-relative.
    pub skills_dirs: &'static [&'static str],
    /// Whether the agent also reads [`SHARED_SKILLS_DIRS`].
    pub reads_shared: bool,
    pub prepare: Option<PrepareFn>,
    pub trigger: Option<fn(&TriggerCtx) -> String>,
    pub resume: Option<fn(&ResumeCtx) -> String>,
}

pub const AGENTS: &[AgentDef] = &[
    AgentDef {
        family: "claude",
        label: "Claude Code",
        skills_dirs: &[".claude/skills"],
        reads_shared: false,
        prepare: Some(claude_prepare),
        trigger: Some(claude_trigger),
        resume: Some(claude_resume),
    },
    AgentDef {
        family: "codex",
        label: "Codex",
        skills_dirs: &[".codex/skills"],
        reads_shared: true,
        prepare: None,
        trigger: Some(codex_trigger),
        resume: Some(codex_resume),
    },
    // Discovery-only for now: no documented zero-interaction trigger/resume
    // recipe has been verified for these, so the capabilities stay None and
    // they aren't offered where a trigger is required.
    AgentDef {
        family: "cursor",
        label: "Cursor",
        skills_dirs: &[".cursor/skills", ".cursor/skills-cursor"],
        reads_shared: true,
        prepare: None,
        trigger: None,
        resume: None,
    },
    AgentDef {
        family: "gemini",
        label: "Gemini CLI",
        skills_dirs: &[],
        reads_shared: true,
        prepare: None,
        trigger: None,
        resume: None,
    },
    AgentDef {
        family: "openclaw",
        label: "OpenClaw",
        skills_dirs: &[".openclaw/skills"],
        reads_shared: false,
        prepare: None,
        trigger: None,
        resume: None,
    },
];

/// Look up an agent by family, accepting full skill-term ids ("claude:cli").
pub fn by_family(family_or_id: &str) -> Option<&'static AgentDef> {
    let family = family_or_id.split(':').next().unwrap_or(family_or_id);
    AGENTS.iter().find(|a| a.family == family)
}

/// True when the family has a programmable (headless) trigger — the gate for
/// offering it where nobody can answer interactive prompts (mining runs).
pub fn can_trigger(family_or_id: &str) -> bool {
    by_family(family_or_id).map(|a| a.trigger.is_some()).unwrap_or(false)
}

/// Every skill dir any known agent reads (shared standard + each agent's own),
/// home-relative — e.g. the writable roots a sandboxed run needs to reach.
pub fn all_skills_dirs() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = SHARED_SKILLS_DIRS.to_vec();
    for a in AGENTS {
        for d in a.skills_dirs {
            if !out.contains(d) {
                out.push(d);
            }
        }
    }
    out
}

// ─────────────────────────────── Claude Code ───────────────────────────────

fn claude_prepare(run_dir: &Path) -> Result<(), String> {
    std::fs::write(run_dir.join("watch.py"), CLAUDE_WATCH_PY).map_err(|e| e.to_string())
}

/// Print mode (`-p`) is the documented zero-interaction path: it skips the
/// per-directory workspace-trust dialog by design, whereas the interactive TUI
/// blocks on it in a fresh dir with no flag to suppress it. Permission mode is
/// `auto` (classifier-reviewed autonomy, CLI v2.1.83+), not bypassPermissions:
/// reads are auto-approved everywhere, which covers the transcript sources,
/// and every known skill home is passed as `--add-dir` so skill writes count
/// as in-workspace edits rather than classifier round-trips (mirrors
/// `codex_trigger`'s writable roots). Repeated classifier blocks abort a `-p`
/// run — already the failure shape the run-state machine reads: no
/// [`DONE_FILE`], the run surfaces as stopped. Note auto mode is model-gated
/// (Opus/Sonnet 4.6+; not haiku).
/// Plain `-p` prints nothing until the very end, so the stream-json feed pipes
/// through the watcher `claude_prepare` dropped into the run dir, which
/// narrates live and records the session id. `</dev/null`: the CLI otherwise
/// waits on stdin.
/// Appended to every `-p` prompt: in print mode the run ends the moment the
/// agent ends its turn, and the harness's background-task re-invocation never
/// fires — an agent that backgrounds long work and "stands by" produces a
/// false-success run with no output.
const CLAUDE_HEADLESS_CAVEAT: &str = "\n\nThis is a headless print-mode run: the run ends \
permanently the moment you end your turn, and background tasks will NOT re-invoke you. \
Never end your turn to wait — wait on long-running work with foreground commands \
(re-running a bounded polling loop as many times as needed).";

fn claude_trigger(c: &TriggerCtx) -> String {
    let prompt = format!("{}{}", c.prompt, CLAUDE_HEADLESS_CAVEAT);
    let mut cmd = format!("{} -p {} --permission-mode auto", q(c.bin), q(&prompt));
    if let Some(home) = dirs::home_dir() {
        for rel in all_skills_dirs() {
            let dir = home.join(rel);
            if dir.exists() {
                cmd.push_str(&format!(" --add-dir {}", q(&dir.to_string_lossy())));
            }
        }
    }
    cmd.push_str(&format!(
        " --output-format stream-json --verbose{tune} </dev/null | python3 -u {watch} {sid} {done}",
        tune = claude_tune(c.model, c.effort),
        watch = q(&c.run_dir.join("watch.py").to_string_lossy()),
        sid = q(&c.run_dir.join(SESSION_FILE).to_string_lossy()),
        done = q(&c.run_dir.join(DONE_FILE).to_string_lossy()),
    ));
    cmd
}

/// Sessions are project-scoped, so this must run with cwd = the run dir (the
/// stable path also means its one-time trust accept persists).
fn claude_resume(c: &ResumeCtx) -> String {
    let sid = q(&c.run_dir.join(SESSION_FILE).to_string_lossy());
    format!(
        "[ -s {sid} ] && {bin} --resume \"$(cat {sid})\"{tune} \
         || echo 'No session id was recorded for this run.'",
        bin = q(c.bin),
        tune = claude_tune(c.model, c.effort),
    )
}

fn claude_tune(model: Option<&str>, effort: Option<&str>) -> String {
    let mut tune = String::new();
    if let Some(m) = model {
        tune.push_str(&format!(" --model {}", q(m)));
    }
    if let Some(e) = effort {
        tune.push_str(&format!(" --effort {}", q(e)));
    }
    tune
}

/// Renders Claude Code's `--output-format stream-json` event feed as a live,
/// human-readable narration in the run's terminal pane. Stdlib-only Python,
/// a dependency the miner's own scripts already require. Event shapes
/// verified against v2.1.172.
const CLAUDE_WATCH_PY: &str = r#"#!/usr/bin/env python3
# Live renderer for `claude -p --output-format stream-json --verbose` (stdin).
# argv[1] (optional): file to write the session id to as soon as it's known,
# so `claude --resume` can revive the conversation later.
# argv[2] (optional): file to create iff the run succeeds (`result` event with
# is_error false) — the completion signal. The pipe eats claude's exit code,
# so the renderer owns it. Keyed off is_error: subtype reads "success" even on
# some API errors.
import json, sys

DIM, BOLD, CYAN, RED, RESET = "\033[2m", "\033[1m", "\033[36m", "\033[31m", "\033[0m"
SID_OUT = sys.argv[1] if len(sys.argv) > 1 else None
DONE_OUT = sys.argv[2] if len(sys.argv) > 2 else None

def brief(inp):
    if not isinstance(inp, dict): return ""
    for k in ("command", "description", "file_path", "path", "pattern", "skill", "prompt", "url"):
        v = inp.get(k)
        if isinstance(v, str) and v.strip():
            v = " ".join(v.split())
            return v[:120] + ("…" if len(v) > 120 else "")
    return ""

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: o = json.loads(line)
    except ValueError:
        print(line); sys.stdout.flush(); continue
    t = o.get("type")
    if t == "system" and o.get("subtype") == "init":
        sid = o.get("session_id", "")
        if SID_OUT and sid:
            try:
                open(SID_OUT, "w").write(sid)
            except OSError:
                pass
        print(f"{DIM}model {o.get('model','?')} · {o.get('permissionMode','')} · session {sid}{RESET}")
    elif t == "assistant":
        for b in (o.get("message") or {}).get("content") or []:
            if not isinstance(b, dict): continue
            if b.get("type") == "text" and b.get("text", "").strip():
                print(b["text"].strip())
            elif b.get("type") == "tool_use":
                print(f"{CYAN}→ {b.get('name','?')}{RESET} {DIM}{brief(b.get('input'))}{RESET}")
    elif t == "user":
        for b in (o.get("message") or {}).get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
                c = b.get("content")
                s = c if isinstance(c, str) else json.dumps(c)
                print(f"{RED}  ✗ {' '.join(str(s).split())[:160]}{RESET}")
    elif t == "result":
        ok = not o.get("is_error")
        if ok and DONE_OUT:
            try:
                open(DONE_OUT, "w").close()
            except OSError:
                pass
        print(f"\n{BOLD}{'✓' if ok else '✗'} {o.get('subtype','done')}{RESET} {DIM}· {o.get('num_turns','?')} turns{RESET}")
        if not ok and o.get("result"): print(str(o.get("result"))[:400])
    sys.stdout.flush()
"#;

// ────────────────────────────────── Codex ──────────────────────────────────

/// `exec` is codex's documented headless mode (no trust prompt, streams
/// human-readable progress natively). The sandbox stays on (workspace-write)
/// with every known skill home added as a writable root, network enabled for
/// the run's LLM calls, and approvals off — nothing can answer them. `exec`
/// exits non-zero on failed/interrupted turns, so its exit status writes
/// [`DONE_FILE`].
fn codex_trigger(c: &TriggerCtx) -> String {
    let mut cmd = format!(
        "{} exec --skip-git-repo-check --sandbox workspace-write -c {} -c {}",
        q(c.bin),
        q("approval_policy=\"never\""),
        q("sandbox_workspace_write.network_access=true"),
    );
    if let Some(home) = dirs::home_dir() {
        for rel in all_skills_dirs() {
            let dir = home.join(rel);
            if dir.exists() {
                cmd.push_str(&format!(" --add-dir {}", q(&dir.to_string_lossy())));
            }
        }
    }
    if let Some(m) = c.model {
        cmd.push_str(&format!(" -m {}", q(m)));
    }
    if let Some(e) = c.effort {
        cmd.push_str(&format!(" -c {}", q(&format!("model_reasoning_effort=\"{e}\""))));
    }
    cmd.push_str(&format!(
        " {} </dev/null && touch {}",
        q(c.prompt),
        q(&c.run_dir.join(DONE_FILE).to_string_lossy())
    ));
    cmd
}

/// codex exec doesn't print its session id, but every session leaves a rollout
/// file (`~/.codex/sessions/Y/M/D/rollout-<stamp>-<uuid>.jsonl`) whose metadata
/// line carries the cwd — so if no id was recorded yet, match our run dir among
/// the newest rollouts first (immune to concurrent codex sessions, unlike
/// `--last`, which stays as the last resort).
fn codex_resume(c: &ResumeCtx) -> String {
    let sid = q(&c.run_dir.join(SESSION_FILE).to_string_lossy());
    format!(
        "[ -s {sid} ] || python3 -c {py} {dir} {sid}; \
         if [ -s {sid} ]; then {bin} resume \"$(cat {sid})\"; else {bin} resume --last; fi",
        py = q(CODEX_SID_PY),
        dir = q(&c.run_dir.to_string_lossy()),
        bin = q(c.bin),
    )
}

/// Scan the newest codex rollout files for the one whose metadata line names
/// our run dir as cwd; write the session uuid (the filename's last 36 chars
/// before `.jsonl`) to argv[2]. argv[1] = run dir. Stdlib-only.
const CODEX_SID_PY: &str = "import glob,os,sys\n\
d,out=sys.argv[1],sys.argv[2]\n\
fs=sorted(glob.glob(os.path.expanduser('~/.codex/sessions/*/*/*/rollout-*.jsonl')),key=os.path.getmtime,reverse=True)[:20]\n\
m=[f for f in fs if d in open(f,errors='ignore').readline()]\n\
open(out,'w').write(m[0][:-6][-36:] if m else '')";

// ─────────────────────────────────── tests ───────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lookup_accepts_ids_and_families() {
        assert_eq!(by_family("claude").unwrap().label, "Claude Code");
        assert_eq!(by_family("codex:cli").unwrap().label, "Codex");
        assert!(by_family("shell").is_none());
        assert!(can_trigger("claude:cli") && can_trigger("codex"));
        assert!(!can_trigger("cursor") && !can_trigger("shell"));
    }

    #[test]
    fn all_skills_dirs_unions_shared_and_own() {
        let dirs = all_skills_dirs();
        for d in [".agents/skills", ".claude/skills", ".codex/skills", ".cursor/skills"] {
            assert!(dirs.contains(&d), "missing {d}");
        }
        let dedup: std::collections::HashSet<_> = dirs.iter().collect();
        assert_eq!(dedup.len(), dirs.len(), "no duplicates");
    }

    #[test]
    fn resume_lines_read_the_recorded_session() {
        let rd = Path::new("/tmp/run");
        let ctx = ResumeCtx { bin: "/bin/claude", run_dir: rd, model: Some("opus"), effort: None };
        let c = claude_resume(&ctx);
        assert!(c.contains("--resume \"$(cat '/tmp/run/session-id')\""));
        assert!(c.contains("--model 'opus'"));
        assert!(c.starts_with("[ -s '/tmp/run/session-id' ] &&"), "guarded on the recorded id");

        let ctx = ResumeCtx { bin: "/bin/codex", run_dir: rd, model: None, effort: None };
        let x = codex_resume(&ctx);
        assert!(x.contains("resume \"$(cat '/tmp/run/session-id')\""));
        assert!(x.contains("rollout-*.jsonl"), "self-captures the id from rollouts");
        assert!(x.contains("resume --last"), "--last only as the last resort");
    }
}
