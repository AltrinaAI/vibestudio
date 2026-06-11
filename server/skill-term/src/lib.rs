//! App-managed agent terminals, backed by tmux for true detach / nohup.
//!
//! The durable session is a tmux session named `ass-<id>` that holds the agent
//! process. The Rust app is a *bridge*: per connected client it spawns
//! `tmux attach` inside a PTY (portable-pty) and streams bytes to/from the UI.
//! Dropping the attach client leaves the session running (nohup w.r.t. the
//! frontend); reattaching spawns a fresh `tmux attach`, so full-screen TUIs
//! (claude/codex) redraw correctly.
//!
//! Lifetime model — terminals are PERSISTENT:
//!   * attachment ↔ frontend — decoupled: a global registry of `Weak`
//!     attachments; the strong `Arc` is held by the streaming owner (the SSE
//!     reader, or the desktop's managed state). When a client disconnects the
//!     strong ref drops → the attach PTY dies → tmux detaches → session lives.
//!   * session ↔ backend — ALSO decoupled: sessions outlive the backend that
//!     created them. Quit the desktop app, drop an SSH connection, upgrade or
//!     restart the server — the agent keeps running, and any later client of
//!     any backend can list/attach it (the `ass-*` tmux namespace is shared
//!     machine-wide, deliberately unfiltered by creator). A session ends only
//!     when the user kills it explicitly, or when [`sweep_stale`] garbage-
//!     collects one whose agent has EXITED (every pane back at a plain shell)
//!     after sitting unattached and idle for [`GC_IDLE_SECS`] — finished runs
//!     stay reviewable for a week, but can't pile up forever. A session with a
//!     live agent (or any non-shell foreground process) is never reaped.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

/// Prefix that marks every tmux session this app owns (so we never touch the
/// user's own tmux sessions).
const PREFIX: &str = "ass-";
/// Field separator in our `tmux list-sessions -F` output. A tab: tmux passes it
/// through literally (it escapes non-printable control bytes), and none of our
/// fields — name, label, agent, cwd, created — realistically contains one.
const SEP: char = '\t';

/// Floor for client-reported terminal sizes — below it is a browser layout
/// glitch, never a real pane. Honoring one is destructive: tmux
/// (`window-size latest`) clamps the whole window to our pty, a TUI repaints
/// at that width, and the repaint is baked into scrollback for every viewer.
/// Resizes below the floor are rejected (the window keeps its last good
/// size); create/attach are clamped up (a wrong-sized viewer beats none).
const MIN_COLS: u16 = 20;
const MIN_ROWS: u16 = 5;

fn size_floor(what: &str, id: &str, cols: u16, rows: u16) -> (u16, u16) {
    if cols < MIN_COLS || rows < MIN_ROWS {
        log::warn!("implausible {what} size {cols}x{rows} (id={id}) — clamping to {MIN_COLS}x{MIN_ROWS} floor");
    }
    (cols.max(MIN_COLS), rows.max(MIN_ROWS))
}

static SEQ: AtomicU64 = AtomicU64::new(0);
static ATTACH_SEQ: AtomicU64 = AtomicU64::new(0);

// ───────────────────────────── public types ─────────────────────────────

/// A launchable agent option surfaced in the "New terminal" picker. The same
/// agent can appear multiple times (e.g. the CLI on PATH *and* the version
/// bundled inside a VS Code / Cursor extension).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentOption {
    /// Stable id passed back to `create_session` (e.g. `claude:cli`, `codex:ext:vs-code`, `shell`).
    pub id: String,
    /// Agent family: `claude` | `codex` | `shell`.
    pub agent: String,
    /// Display name, e.g. "Claude Code".
    pub label: String,
    /// `cli` | `extension` | `shell`.
    pub flavor: String,
    /// Human flavor, e.g. "CLI" or "VS Code extension".
    pub flavor_label: String,
    /// Absolute path to the executable.
    pub bin: String,
    /// Best-effort version string (from `<bin> --version`).
    pub version: Option<String>,
    /// Whether this agent supports `--ide` (attach to a running editor extension).
    pub supports_ide: bool,
    /// Whether the agent registry has a programmable (headless) trigger for
    /// this family — the gate for unattended runs like skill mining.
    pub can_mine: bool,
}

/// Metadata for one live tmux-backed terminal session.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub label: String,
    pub agent: String,
    pub cwd: String,
    /// Unix seconds (as a string) when the session was created.
    pub created: String,
}

// ─────────────────────────── base64 (single home) ───────────────────────────

/// Encode raw PTY bytes for the (text-only) JSON / SSE transports.
pub fn b64_encode(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}
/// Decode keystroke bytes from the transport (lenient: bad input → empty).
pub fn b64_decode(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .unwrap_or_default()
}

// ────────────────────────────── tmux helpers ──────────────────────────────

fn which(bin: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(bin))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Expand a leading `~`/`~/` to the user's home directory; pass other paths through
/// unchanged. `None` only when `~` is used but no home dir is resolvable.
fn expand_tilde(path: &str) -> Option<PathBuf> {
    match path.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().map(|h| h.join(rest)),
        None if path == "~" => dirs::home_dir(),
        None => Some(PathBuf::from(path)),
    }
}

/// Resolve an agent's CLI binary: the shell PATH first, then the agent-specific
/// off-PATH install locations from its `Spec` — the fixed `cli_paths` (leading `~`
/// expanded) and `<install_dir_env>/<path_name>`. Returns the first existing file,
/// so a native/standalone install that isn't on PATH (e.g. claude's
/// `~/.claude/local/claude`) is still detected.
fn resolve_cli(spec: &Spec) -> Option<String> {
    if let Some(bin) = which(spec.path_name) {
        return Some(bin);
    }
    for cand in spec.cli_paths {
        if let Some(path) = expand_tilde(cand) {
            if path.is_file() {
                return Some(path.to_string_lossy().into_owned());
            }
        }
    }
    if !spec.install_dir_env.is_empty() {
        if let Some(dir) = std::env::var_os(spec.install_dir_env) {
            if !dir.is_empty() {
                let path = PathBuf::from(dir).join(spec.path_name);
                if path.is_file() {
                    return Some(path.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

fn tmux_bin() -> String {
    static TMUX: OnceLock<String> = OnceLock::new();
    TMUX.get_or_init(|| which("tmux").unwrap_or_else(|| "tmux".to_string()))
        .clone()
}

/// A `tmux` command that works even when the backend itself runs inside a tmux
/// pane (`-d` creates are fine within tmux; we only must not inherit `$TMUX`).
fn tmux() -> Command {
    let mut c = Command::new(tmux_bin());
    c.env_remove("TMUX");
    c
}

/// Strip characters that would corrupt our tab-separated `list-sessions` parse.
/// Tabs/newlines are legal in Unix paths but must never leak into metadata.
fn sanitize_meta(s: &str) -> String {
    s.replace(['\t', '\r', '\n'], " ")
}

/// POSIX single-quote a string for embedding in a `bash -lc` script.
fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

fn basename(p: &str) -> String {
    p.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(p)
        .to_string()
}

// ──────────────────────────── session lifecycle ────────────────────────────

/// List the app's live sessions (queries tmux, so this is correct within the
/// current backend lifetime regardless of in-process attachment state).
pub fn list_sessions() -> Result<Vec<SessionInfo>, String> {
    let fmt = format!(
        "#{{session_name}}{s}#{{@ass_label}}{s}#{{@ass_agent}}{s}#{{@ass_cwd}}{s}#{{@ass_created}}",
        s = SEP
    );
    let out = match tmux().args(["list-sessions", "-F", &fmt]).output() {
        Ok(o) => o,
        Err(_) => return Ok(vec![]),
    };
    // Non-zero exit just means "no tmux server running yet" → no sessions.
    if !out.status.success() {
        return Ok(vec![]);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut sessions = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split(SEP).collect();
        if f.first().map(|n| n.starts_with(PREFIX)) != Some(true) {
            continue;
        }
        let g = |i: usize| f.get(i).copied().unwrap_or("").to_string();
        let id = g(0);
        let label = {
            let l = g(1);
            if l.is_empty() {
                id.clone()
            } else {
                l
            }
        };
        sessions.push(SessionInfo {
            id,
            label,
            agent: g(2),
            cwd: g(3),
            created: g(4),
        });
    }
    Ok(sessions)
}

fn session_exists(id: &str) -> bool {
    tmux()
        .args(["has-session", "-t", id])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Kill a session (idempotent — a missing session is treated as success).
pub fn kill_session(id: &str) -> Result<(), String> {
    if !id.starts_with(PREFIX) {
        return Err("Invalid terminal id.".into());
    }
    let _ = tmux().args(["kill-session", "-t", id]).output();
    Ok(())
}

/// How long a finished (agent-exited), unattached session sticks around before
/// the GC may reap it: a week, so a run that finishes Friday night is still
/// reviewable well past the weekend. Live agents are never reaped regardless.
const GC_IDLE_SECS: u64 = 7 * 24 * 3600;

/// Garbage-collect stale terminals. Run at backend startup. This is the ONLY
/// automatic reaping — sessions deliberately outlive their creating backend
/// (see the module docs), so the GC's bar is high: a session is stale only if
/// it is unattached, every pane is back at a plain shell (the agent exited),
/// and nothing has touched it for [`GC_IDLE_SECS`].
pub fn sweep_stale() {
    if let Ok(sessions) = list_sessions() {
        for s in sessions {
            let _ = gc_session_if_stale(&s.id, GC_IDLE_SECS);
        }
    }
}

/// Reap `id` iff stale (see [`sweep_stale`]); returns whether it was reaped.
/// Per-session so tests can target their own sessions with a zero cutoff
/// without sweeping a developer's real terminals.
fn gc_session_if_stale(id: &str, idle_secs: u64) -> bool {
    let fmt = format!("#{{session_attached}}{SEP}#{{session_activity}}");
    let Ok(out) = tmux().args(["display-message", "-p", "-t", id, &fmt]).output() else {
        return false;
    };
    if !out.status.success() {
        return false; // session gone (or tmux unhappy) — nothing to do
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut f = text.trim().split(SEP);
    let attached = f.next().unwrap_or("1");
    let activity: u64 = f.next().and_then(|s| s.parse().ok()).unwrap_or(u64::MAX);
    if attached != "0" {
        return false; // someone is looking at it
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if now.saturating_sub(activity) < idle_secs {
        return false; // touched too recently
    }
    if !all_panes_are_shells(id) {
        return false; // the agent (or some process) is still running
    }
    log::info!("reaping stale terminal {id} (agent exited, idle)");
    let _ = kill_session(id);
    true
}

/// True when the session's agent has exited and only shell prompts remain.
/// Used by mining to tell "the headless run ended" apart from "still working"
/// (the launch line ends in `; exec bash -l`, so the session itself lives on).
pub fn agent_exited(id: &str) -> bool {
    all_panes_are_shells(id)
}

/// True when every pane is a plain shell at rest — i.e. the agent (and
/// anything the user ran) has exited and only prompts remain.
///
/// tmux's `#{pane_current_command}` is not enough on its own: panes are
/// spawned as `bash -lc "<agent>; exec bash -l"`, and a non-interactive bash
/// has no job control, so the tty's foreground process group — which is what
/// tmux reports — stays "bash" for the agent's whole lifetime. A pane only
/// counts as at-rest when its process is a shell AND that shell has no
/// non-shell descendants (the agent pipeline, a command the user typed, …).
fn all_panes_are_shells(id: &str) -> bool {
    let Ok(out) = tmux().args(["list-panes", "-s", "-t", id, "-F", "#{pane_pid}"]).output() else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let pane_pids: Vec<u32> = text.split_whitespace().filter_map(|p| p.parse().ok()).collect();
    if pane_pids.is_empty() {
        return false;
    }

    // One snapshot of the process table (Linux and macOS both take -eo with
    // empty headers). comm is a bare name on Linux and may be a full path on
    // macOS; is_shell() compares the basename.
    let Ok(ps) = Command::new("ps").args(["-eo", "pid=,ppid=,comm="]).output() else {
        return false;
    };
    if !ps.status.success() {
        return false;
    }
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut comm: HashMap<u32, String> = HashMap::new();
    for line in String::from_utf8_lossy(&ps.stdout).lines() {
        let mut f = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (
            f.next().and_then(|s| s.parse::<u32>().ok()),
            f.next().and_then(|s| s.parse::<u32>().ok()),
        ) else {
            continue;
        };
        children.entry(ppid).or_default().push(pid);
        comm.insert(pid, f.collect::<Vec<_>>().join(" "));
    }

    for pane in pane_pids {
        let Some(name) = comm.get(&pane) else {
            return false; // pane process vanished mid-probe; try again later
        };
        if !is_shell(name) {
            return false; // the pane itself was exec'd into something else
        }
        let mut queue: Vec<u32> = children.get(&pane).cloned().unwrap_or_default();
        while let Some(pid) = queue.pop() {
            if !comm.get(&pid).map(|n| is_shell(n)).unwrap_or(true) {
                return false; // a live non-shell descendant: the agent is working
            }
            queue.extend(children.get(&pid).cloned().unwrap_or_default());
        }
    }
    true
}

/// Shell-name check for process `comm` values: basename'd (macOS reports full
/// paths) and stripped of the login-shell `-` prefix.
fn is_shell(comm: &str) -> bool {
    const SHELLS: [&str; 8] = ["bash", "sh", "zsh", "fish", "dash", "ash", "ksh", "tcsh"];
    let name = comm.trim().rsplit('/').next().unwrap_or("").trim_start_matches('-');
    SHELLS.contains(&name)
}

/// Create a detached tmux session running the chosen agent in `cwd`, tagged so
/// it can be listed from any backend. The session is persistent: nothing about
/// it dies with this process (see the module docs for the lifetime model).
#[allow(clippy::too_many_arguments)]
pub fn create_session(
    agent_id: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
    ide: bool,
    skip_permissions: bool,
    auto_mode: bool,
    extra_args: &[String],
) -> Result<SessionInfo, String> {
    let opt = detect_agents()
        .into_iter()
        .find(|a| a.id == agent_id)
        .ok_or_else(|| format!("Unknown agent option: {agent_id}"))?;

    // Build the agent argv (empty for a plain shell).
    let mut argv: Vec<String> = Vec::new();
    if opt.agent != "shell" {
        argv.push(opt.bin.clone());
        if opt.agent == "claude" {
            if ide {
                argv.push("--ide".into());
            }
            // Auto mode and skip-permissions are mutually exclusive (the flags
            // conflict); the UI enforces this, but prefer auto if both arrive.
            if auto_mode {
                argv.push("--permission-mode".into());
                argv.push("auto".into());
            } else if skip_permissions {
                argv.push("--dangerously-skip-permissions".into());
            }
        }
        for a in extra_args {
            if !a.trim().is_empty() {
                argv.push(a.clone());
            }
        }
    }
    let agent_cmd = argv
        .iter()
        .map(|a| shell_quote(a))
        .collect::<Vec<_>>()
        .join(" ");
    create_session_inner(&opt, cwd, cols, rows, agent_cmd)
}

/// Create a session that RESUMES the agent's recorded conversation in `cwd`:
/// the agent registry's resume line reads `<cwd>/session-id` (with the
/// agent's own fallback, e.g. codex re-deriving the id from its rollout
/// files). The programmatic counterpart of `create_session` — exposed on the
/// terminal API as a `resume` flag with deliberately no dialog UI; skill
/// mining's "continue the conversation" is the caller today.
pub fn create_session_resume(
    agent_id: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<SessionInfo, String> {
    let opt = detect_agents()
        .into_iter()
        .find(|a| a.id == agent_id)
        .ok_or_else(|| format!("Unknown agent option: {agent_id}"))?;
    let resume = skill_core::agents::by_family(&opt.agent)
        .and_then(|d| d.resume)
        .ok_or_else(|| format!("{} can't resume a recorded session yet.", opt.label))?;
    let resolved = skill_core::pathsafe::resolve_root(cwd);
    let cmd = resume(&skill_core::agents::ResumeCtx {
        bin: &opt.bin,
        run_dir: &resolved,
        model,
        effort,
    });
    create_session_inner(&opt, cwd, cols, rows, cmd)
}

/// Create a session whose agent command is a caller-built shell LINE — e.g. a
/// pipeline like `claude -p … | python3 watch.py` (skill mining's headless run
/// with a live renderer). The caller is responsible for quoting; the secrets
/// env sourcing and the keep-alive shell wrapper still apply.
pub fn create_session_cmd(
    agent_id: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
    cmd: &str,
) -> Result<SessionInfo, String> {
    let opt = detect_agents()
        .into_iter()
        .find(|a| a.id == agent_id)
        .ok_or_else(|| format!("Unknown agent option: {agent_id}"))?;
    create_session_inner(&opt, cwd, cols, rows, cmd.to_string())
}

fn create_session_inner(
    opt: &AgentOption,
    cwd: &str,
    cols: u16,
    rows: u16,
    agent_cmd: String,
) -> Result<SessionInfo, String> {
    let cwd_resolved = if cwd.trim().is_empty() {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "/".into())
    } else {
        skill_core::pathsafe::resolve_root(cwd)
            .to_string_lossy()
            .into_owned()
    };

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let owner = std::process::id();
    // The pid is part of the name because the seq counter is per-process: two
    // backends creating a terminal in the same second would otherwise both
    // mint `ass-<secs>-0` and the second create would fail.
    let name = format!("{PREFIX}{owner}-{secs}-{seq}");

    // Source the managed-secrets env file (the same one the `load-secrets`
    // activation skill reads) before the agent starts, so skills that need
    // credentials find them in the environment without an activation step.
    // The `[ -f ]` guard makes a missing/empty store a silent no-op.
    let env_source = skill_core::secrets::env_path()
        .map(|p| {
            let q = shell_quote(&p.to_string_lossy());
            format!("[ -f {q} ] && . {q}; ")
        })
        .unwrap_or_default();

    // `; exec bash -l` keeps the pane (and the agent's scrollback) alive after
    // the agent exits, so a finished run stays reviewable from any client —
    // the GC only collects it once it's been idle for a week (see sweep_stale).
    let line = if agent_cmd.is_empty() {
        format!("{env_source}exec bash -l")
    } else {
        format!("{env_source}{agent_cmd}; exec bash -l")
    };

    let (cols, rows) = size_floor("create", &name, cols, rows);
    let cols_s = cols.to_string();
    let rows_s = rows.to_string();
    // Create the session around a short-lived stub window first: `history-limit`
    // is captured per-window at creation time, so the session options must be in
    // place *before* the real agent window exists. `-P -F` prints the stub's
    // global window id (`@N`) so exactly that window can be dropped afterwards
    // (immune to `base-index` / `renumber-windows` in the user's tmux config).
    let out = tmux()
        .args([
            "new-session", "-d", "-s", &name, "-x", &cols_s, "-y", &rows_s,
            "-P", "-F", "#{window_id}", "sleep", "60",
        ])
        .output()
        .map_err(|e| format!("Couldn't start tmux: {e}"))?;
    if !out.status.success() {
        log::error!("tmux new-session failed (agent={})", opt.agent);
        return Err("tmux couldn't create the session.".into());
    }
    let stub = String::from_utf8_lossy(&out.stdout).trim().to_string();

    let label = format!("{} · {}", opt.label, basename(&cwd_resolved));
    // Sanitize every stored value: tabs/newlines (legal in paths) would corrupt
    // the tab-separated `list-sessions` parse.
    let set = |k: &str, v: &str| {
        let _ = tmux().args(["set-option", "-t", &name, k, &sanitize_meta(v)]).output();
    };
    set("@ass_label", &label);
    set("@ass_agent", &opt.agent);
    set("@ass_cwd", &cwd_resolved);
    set("@ass_created", &secs.to_string());
    // Informational only (provenance for debugging) — sessions deliberately
    // outlive their creator, so nothing keys lifecycle off this anymore.
    set("@ass_owner_pid", &owner.to_string());
    set("status", "off"); // clean embed — no tmux status bar
    // Scrolling happens in *tmux's* history (the UI's terminal only ever sees the
    // alternate screen): `mouse on` turns wheel events into copy-mode scrolling.
    // Session-scoped, so the user's own tmux sessions keep their settings.
    set("mouse", "on");
    set("history-limit", "10000");

    let status = tmux()
        .args(["new-window", "-t", &name, "-c", &cwd_resolved, "bash", "-lc", &line])
        .status()
        .map_err(|e| format!("Couldn't start tmux: {e}"))?;
    if !status.success() {
        let _ = kill_session(&name);
        log::error!("tmux new-window failed (agent={}, cwd={cwd_resolved})", opt.agent);
        return Err("tmux couldn't create the session (is the working directory valid?).".into());
    }
    let _ = tmux().args(["kill-window", "-t", &stub]).output();

    Ok(SessionInfo {
        id: name,
        label,
        agent: opt.agent.clone(),
        cwd: cwd_resolved,
        created: secs.to_string(),
    })
}

// ──────────────────────────── attach / stream I/O ────────────────────────────

/// A live PTY attachment to a session — a running `tmux attach` client. Holding
/// the `Arc` keeps the client alive; dropping it detaches (the session survives).
pub struct Attachment {
    id: String,
    /// Unique per attachment, so a session that is detached and re-attached gets
    /// a distinct entry — Drop then only removes *its own* registry slot.
    seq: u64,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    writer: Mutex<Box<dyn Write + Send>>,
}

impl Attachment {
    fn write_bytes(&self, data: &[u8]) -> Result<(), String> {
        let mut w = self.writer.lock().map_err(|_| "terminal writer is unavailable".to_string())?;
        w.write_all(data).and_then(|_| w.flush()).map_err(|e| e.to_string())
    }
    fn resize_to(&self, cols: u16, rows: u16) -> Result<(), String> {
        if cols < MIN_COLS || rows < MIN_ROWS {
            log::warn!("refused implausible resize {cols}x{rows} (id={})", self.id);
            return Err(format!("implausible terminal size {cols}x{rows} — refused"));
        }
        let m = self.master.lock().map_err(|_| "terminal is unavailable".to_string())?;
        m.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
    }
}

impl Drop for Attachment {
    fn drop(&mut self) {
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if let Ok(mut reg) = registry().lock() {
            // Remove only if we're still the registered entry (identity by seq),
            // so a newer attachment that replaced us is never clobbered.
            if reg.get(&self.id).map(|(seq, _)| *seq == self.seq).unwrap_or(false) {
                reg.remove(&self.id);
            }
        }
    }
}

/// Live attachments keyed by session id; the `u64` is the attachment seq (identity
/// for the replace-vs-clobber check), the `Weak` lets a dropped owner expire the entry.
type Registry = Mutex<HashMap<String, (u64, Weak<Attachment>)>>;

fn registry() -> &'static Registry {
    static REG: OnceLock<Registry> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Attach to a session: spawn `tmux attach` in a PTY sized `cols`×`rows`, start a
/// reader thread, and return the keep-alive handle plus a channel of raw output.
pub fn attach(id: &str, cols: u16, rows: u16) -> Result<(Arc<Attachment>, Receiver<Vec<u8>>), String> {
    if !id.starts_with(PREFIX) || !session_exists(id) {
        return Err("That terminal session no longer exists.".into());
    }

    let (cols, rows) = size_floor("attach", id, cols, rows);
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(tmux_bin());
    cmd.arg("attach-session");
    cmd.arg("-t");
    cmd.arg(id);
    // Build a clean env: a real terminal, no inherited $TMUX (would refuse to
    // nest), but keep PATH/HOME so tmux finds its socket and the login shell.
    cmd.env("TERM", "xterm-256color");
    cmd.env_remove("TMUX");
    cmd.env_remove("TMUX_PANE");
    if let Ok(p) = std::env::var("PATH") {
        cmd.env("PATH", p);
    }
    if let Some(h) = dirs::home_dir() {
        cmd.env("HOME", h.to_string_lossy().into_owned());
    }
    if let Ok(t) = std::env::var("TMUX_TMPDIR") {
        cmd.env("TMUX_TMPDIR", t);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Couldn't attach: {e}"))?;
    drop(pair.slave);

    // If we fail to wire up I/O after the client spawned, reap it — otherwise the
    // `tmux attach` child would be orphaned (a zombie).
    let reap = |child: &mut Box<dyn Child + Send + Sync>| {
        let _ = child.kill();
        let _ = child.wait();
    };
    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            reap(&mut child);
            return Err(e.to_string());
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            reap(&mut child);
            return Err(e.to_string());
        }
    };

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let seq = ATTACH_SEQ.fetch_add(1, Ordering::Relaxed);
    let att = Arc::new(Attachment {
        id: id.to_string(),
        seq,
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        writer: Mutex::new(writer),
    });
    if let Ok(mut reg) = registry().lock() {
        reg.insert(id.to_string(), (seq, Arc::downgrade(&att)));
    }
    Ok((att, rx))
}

fn current(id: &str) -> Option<Arc<Attachment>> {
    registry().lock().ok()?.get(id).and_then(|(_, w)| w.upgrade())
}

/// Send keystroke bytes to a session's current attachment.
pub fn write(id: &str, data: &[u8]) -> Result<(), String> {
    match current(id) {
        Some(a) => a.write_bytes(data),
        None => Err("Terminal is not attached.".into()),
    }
}

/// Resize a session's current attachment (the tmux client follows the PTY).
pub fn resize(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    match current(id) {
        Some(a) => a.resize_to(cols, rows),
        None => Err("Terminal is not attached.".into()),
    }
}

// ───────────────────────────── pasted images ─────────────────────────────

static PASTE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Where pasted clipboard images land: a per-user dir on the machine the agents
/// run on, so the returned path is readable from inside any session. The user's
/// cache dir, NOT the shared /tmp — a predictable name in a world-writable dir
/// invites symlink games on multi-user hosts (and [`sweep_old_pastes`] deletes
/// in here, which must never be redirectable by another user).
fn paste_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("skill-studio")
        .join("pastes")
}

/// Best-effort: drop pasted images older than a day so the dir can't grow
/// without bound under a long-lived backend.
fn sweep_old_pastes(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let cutoff = SystemTime::now() - std::time::Duration::from_secs(24 * 3600);
    for e in rd.flatten() {
        let stale = e
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Save a pasted clipboard image (base64) to a temp file and return its absolute
/// path. This is how images cross the client/server boundary: the agent may run
/// on a different machine than the user's clipboard (remote SSH), so "paste"
/// must materialize the bytes server-side and hand back a path — the same shape
/// drag-and-drop produces in a native terminal.
pub fn save_pasted_image(data_b64: &str, mime: &str) -> Result<String, String> {
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => return Err(format!("Unsupported image type: {mime}")),
    };
    let bytes = b64_decode(data_b64);
    if bytes.is_empty() {
        return Err("The pasted image was empty.".into());
    }
    const MAX_BYTES: usize = 32 * 1024 * 1024;
    if bytes.len() > MAX_BYTES {
        return Err("The pasted image is too large (max 32 MB).".into());
    }
    let dir = paste_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the paste dir: {e}"))?;
    sweep_old_pastes(&dir);
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let seq = PASTE_SEQ.fetch_add(1, Ordering::Relaxed);
    // pid in the name: temp dirs are shared, and two backends could both be at
    // seq 0 in the same second.
    let path = dir.join(format!("image-{}-{secs}-{seq}.{ext}", std::process::id()));
    std::fs::write(&path, &bytes).map_err(|e| format!("Couldn't save the image: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

// ───────────────────────────── agent detection ─────────────────────────────

enum ExtRel {
    /// A fixed relative file inside the extension dir.
    File(&'static str),
    /// A `<dir>/<arch>/<file>` layout — glob the single arch subdir.
    GlobDir { dir: &'static str, file: &'static str },
}

struct Spec {
    agent: &'static str,
    label: &'static str,
    path_name: &'static str,
    supports_ide: bool,
    ext_prefix: &'static str,
    ext_rel: ExtRel,
    /// Fixed, non-PATH install locations to also probe (agent-specific; `~` ok).
    /// Catches installs that aren't on the current shell's PATH — native
    /// standalone, the curl-installer dir, a different node manager, etc.
    cli_paths: &'static [&'static str],
    /// Env var naming an install dir to also probe (`<dir>/<name>`); "" if none.
    install_dir_env: &'static str,
}

fn agent_specs() -> Vec<Spec> {
    vec![
        Spec {
            agent: "claude",
            label: "Claude Code",
            path_name: "claude",
            supports_ide: true,
            ext_prefix: "anthropic.claude-code-",
            ext_rel: ExtRel::File("resources/native-binary/claude"),
            cli_paths: &["~/.claude/local/claude"],
            install_dir_env: "",
        },
        Spec {
            agent: "codex",
            label: "Codex",
            path_name: "codex",
            supports_ide: false,
            ext_prefix: "openai.chatgpt-",
            ext_rel: ExtRel::GlobDir {
                dir: "bin",
                file: "codex",
            },
            // The native/standalone managed install (curl installer / IDE-managed).
            cli_paths: &["~/.codex/packages/standalone/current/codex"],
            install_dir_env: "CODEX_INSTALL_DIR",
        },
    ]
}

fn editor_roots() -> Vec<(&'static str, &'static str)> {
    vec![
        ("VS Code", "~/.vscode-server/extensions"),
        ("VS Code", "~/.vscode/extensions"),
        ("Cursor", "~/.cursor/extensions"),
        ("Cursor", "~/.cursor-server/extensions"),
        ("VS Code Insiders", "~/.vscode-insiders/extensions"),
    ]
}

fn slug(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Best-effort version from `<bin> --version` (first dotted, digit-leading token),
/// bounded by a timeout so a hung/misbehaving binary can't freeze agent detection.
fn bin_version(bin: &str) -> Option<String> {
    use std::process::Stdio;
    let mut child = Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
    // `--version` output is tiny, so the pipe never blocked; read what's buffered.
    let mut text = String::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_string(&mut text);
    }
    if text.trim().is_empty() {
        if let Some(mut err) = child.stderr.take() {
            let _ = err.read_to_string(&mut text);
        }
    }
    text.split_whitespace()
        .find(|t| {
            t.contains('.') && t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
        })
        .map(|s| {
            s.trim_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
                .to_string()
        })
}

/// Locate an agent's extension-bundled binary across known editor roots.
/// Returns `(editor_label, abs_path)` pairs, deduped by path, latest version first.
fn ext_finds(spec: &Spec) -> Vec<(&'static str, String)> {
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (label, root) in editor_roots() {
        let dir = skill_core::pathsafe::resolve_root(root);
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let mut names: Vec<String> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(spec.ext_prefix))
            .collect();
        names.sort();
        names.reverse(); // lexicographically-latest version dir first
        for n in names {
            let base = dir.join(&n);
            let bin = match &spec.ext_rel {
                ExtRel::File(rel) => {
                    let p = base.join(rel);
                    p.is_file().then_some(p)
                }
                ExtRel::GlobDir { dir: sub, file } => std::fs::read_dir(base.join(sub))
                    .ok()
                    .and_then(|rd| {
                        rd.filter_map(|e| e.ok())
                            .map(|e| e.path().join(file))
                            .find(|p| p.is_file())
                    }),
            };
            if let Some(p) = bin {
                let ps = p.to_string_lossy().into_owned();
                if seen.insert(ps.clone()) {
                    found.push((label, ps));
                }
                break; // first (latest) hit in this root
            }
        }
    }
    found
}

fn compute_agents() -> Vec<AgentOption> {
    let mut out = Vec::new();

    // A plain login shell is always offered.
    out.push(AgentOption {
        id: "shell".into(),
        agent: "shell".into(),
        label: "Shell".into(),
        flavor: "shell".into(),
        flavor_label: "bash".into(),
        bin: which("bash").unwrap_or_else(|| "/bin/bash".to_string()),
        version: None,
        supports_ide: false,
        can_mine: false,
    });

    for spec in agent_specs() {
        if let Some(bin) = resolve_cli(&spec) {
            out.push(AgentOption {
                id: format!("{}:cli", spec.agent),
                agent: spec.agent.into(),
                label: spec.label.into(),
                flavor: "cli".into(),
                flavor_label: "CLI".into(),
                version: bin_version(&bin),
                bin,
                supports_ide: spec.supports_ide,
                can_mine: skill_core::agents::can_trigger(spec.agent),
            });
        }
        for (editor, bin) in ext_finds(&spec) {
            out.push(AgentOption {
                id: format!("{}:ext:{}", spec.agent, slug(editor)),
                agent: spec.agent.into(),
                label: spec.label.into(),
                flavor: "extension".into(),
                flavor_label: format!("{editor} extension"),
                version: bin_version(&bin),
                bin,
                supports_ide: spec.supports_ide,
                can_mine: skill_core::agents::can_trigger(spec.agent),
            });
        }
    }
    out
}

/// Detected launchable agents (computed once per process — agents rarely change
/// mid-session, and `<bin> --version` probes are relatively slow).
pub fn detect_agents() -> Vec<AgentOption> {
    static CACHE: OnceLock<Vec<AgentOption>> = OnceLock::new();
    CACHE.get_or_init(compute_agents).clone()
}

// ─────────────────────────────────── tests ───────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_handles_quotes() {
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote("plain"), "'plain'");
    }

    #[test]
    fn detect_includes_shell() {
        assert!(detect_agents().iter().any(|o| o.agent == "shell"));
    }

    #[test]
    fn resume_requires_a_registry_resume_capability() {
        // "shell" has no agent-registry entry, so the error comes before any
        // tmux work — no session may be spawned for an unresumable agent.
        let err = match create_session_resume("shell", "/tmp", 80, 24, None, None) {
            Err(e) => e,
            Ok(s) => panic!("expected an error, spawned {}", s.id),
        };
        assert!(err.contains("can't resume"), "got: {err}");
    }

    #[test]
    fn basename_trims() {
        assert_eq!(basename("/home/x/proj/"), "proj");
        assert_eq!(basename("/home/x/proj"), "proj");
    }

    #[test]
    fn sanitize_meta_strips_separators() {
        assert_eq!(sanitize_meta("a\tb\nc\rd"), "a b c d");
        assert_eq!(sanitize_meta("plain"), "plain");
    }

    #[test]
    fn save_pasted_image_roundtrip() {
        let bytes = b"\x89PNG\r\n\x1a\nfakepng";
        let path = save_pasted_image(&b64_encode(bytes), "image/png").expect("save");
        assert!(path.ends_with(".png"));
        assert_eq!(std::fs::read(&path).expect("file exists"), bytes);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_pasted_image_rejects_bad_input() {
        assert!(save_pasted_image("aGVsbG8=", "text/plain").is_err(), "mime allowlist");
        assert!(save_pasted_image("", "image/png").is_err(), "empty payload");
        assert!(save_pasted_image("!!!not-base64!!!", "image/png").is_err(), "undecodable payload");
    }

    // tmux-gated: attach → write keystrokes → read echoed output.
    #[test]
    fn tmux_attach_roundtrip() {
        if which("tmux").is_none() {
            eprintln!("tmux not installed — skipping");
            return;
        }
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let s = create_session("shell", &cwd, 100, 30, false, false, false, &[]).expect("create");
        let (att, rx) = attach(&s.id, 100, 30).expect("attach");
        std::thread::sleep(std::time::Duration::from_millis(600)); // let the shell start
        write(&s.id, b"echo HELLO_RT\n").expect("write");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut seen = String::new();
        while std::time::Instant::now() < deadline {
            if let Ok(b) = rx.recv_timeout(std::time::Duration::from_millis(300)) {
                seen.push_str(&String::from_utf8_lossy(&b));
                if seen.contains("HELLO_RT") {
                    break;
                }
            }
        }
        drop(att);
        let _ = kill_session(&s.id);
        assert!(seen.contains("HELLO_RT"), "should see echoed output; got {} bytes", seen.len());
    }

    // tmux-gated end-to-end of session creation + the persistence/GC policy.
    #[test]
    fn tmux_session_lifecycle_and_stale_gc() {
        if which("tmux").is_none() {
            eprintln!("tmux not installed — skipping");
            return;
        }
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let s = create_session("shell", &cwd, 80, 24, false, false, false, &[]).expect("create");
        assert!(
            s.id.starts_with(&format!("{PREFIX}{}-", std::process::id())),
            "names are pid-namespaced so two backends can't collide: {}",
            s.id
        );
        assert!(session_exists(&s.id), "session should exist after create");
        let listed = list_sessions().unwrap();
        let found = listed.iter().find(|x| x.id == s.id).expect("list_sessions should include it");
        assert_eq!(found.agent, "shell");
        assert!(found.label.contains('·'), "label carries the agent + cwd basename");

        // The stub-window dance must leave exactly one window, with mouse
        // scrolling on and the deeper (window-creation-time) history limit.
        let opt = |k: &str| {
            let out = tmux().args(["show-options", "-t", &s.id, "-v", k]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        assert_eq!(opt("mouse"), "on", "wheel scrolling needs tmux mouse mode");
        assert_eq!(opt("history-limit"), "10000");
        let panes = tmux()
            .args(["list-windows", "-t", &s.id, "-F", "#{history_limit}"])
            .output()
            .unwrap();
        let lines: Vec<String> = String::from_utf8_lossy(&panes.stdout)
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(lines, vec!["10000"], "one window, created after history-limit was set");

        // The week-long idle cutoff spares a fresh session (the startup sweep
        // never touches recent work)…
        sweep_stale();
        assert!(session_exists(&s.id), "a fresh session survives the real sweep");
        // …and with a zero cutoff a detached, shell-only session is collected.
        // (Targeted per-id so this test can't reap a developer's real terminals.)
        // Poll: right after creation the login shell's rc files spawn transient
        // children, which make the all-panes-are-shells probe flap (see below).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut reaped = gc_session_if_stale(&s.id, 0);
        while !reaped && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(200));
            reaped = gc_session_if_stale(&s.id, 0);
        }
        assert!(reaped, "detached + agent-exited + past cutoff ⇒ reaped");
        assert!(!session_exists(&s.id));
    }

    // tmux-gated: the GC must never take a session with a live process or a
    // watching client — only explicit kills end those.
    #[test]
    fn tmux_gc_spares_live_and_attached_sessions() {
        if which("tmux").is_none() {
            eprintln!("tmux not installed — skipping");
            return;
        }
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();

        // A non-shell foreground process (stand-in for a running agent).
        let live = create_session("shell", &cwd, 80, 24, false, false, false, &[]).expect("create");
        let _ = tmux().args(["send-keys", "-t", &live.id, "exec sleep 300", "Enter"]).output();
        // Wait for the exec to land: the pane PROCESS becomes `sleep`. (Don't
        // sample all_panes_are_shells for this — the keep-alive login shell's
        // rc files spawn transient children right after creation, which make
        // that probe flap during startup.)
        let sleeping = |id: &str| {
            let Ok(out) = tmux().args(["list-panes", "-s", "-t", id, "-F", "#{pane_pid}"]).output()
            else {
                return false;
            };
            let pid = String::from_utf8_lossy(&out.stdout).trim().to_string();
            !pid.is_empty()
                && Command::new("ps")
                    .args(["-p", &pid, "-o", "comm="])
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().ends_with("sleep"))
                    .unwrap_or(false)
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline && !sleeping(&live.id) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(sleeping(&live.id), "exec sleep should replace the pane shell");
        assert!(!all_panes_are_shells(&live.id), "sleep should be the foreground command");
        assert!(!gc_session_if_stale(&live.id, 0), "a live agent process is never GC'd");
        assert!(session_exists(&live.id));
        let _ = kill_session(&live.id);

        // An attached client protects even a plain idle shell.
        let watched = create_session("shell", &cwd, 80, 24, false, false, false, &[]).expect("create");
        let (att, _rx) = attach(&watched.id, 80, 24).expect("attach");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let attached = |id: &str| {
            let out = tmux()
                .args(["display-message", "-p", "-t", id, "#{session_attached}"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim() != "0"
        };
        while std::time::Instant::now() < deadline && !attached(&watched.id) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(attached(&watched.id), "the tmux client should register as attached");
        assert!(!gc_session_if_stale(&watched.id, 0), "an attached session is never GC'd");
        assert!(session_exists(&watched.id));
        drop(att);
        let _ = kill_session(&watched.id);
    }

    // tmux-gated regression: a caller-built line runs under a NON-interactive
    // `bash -lc` wrapper (no job control), so `#{pane_current_command}` reports
    // "bash" for the agent's whole lifetime. agent_exited must see through
    // that to the process tree — a false "exited" here marked live mining
    // runs as stopped.
    #[test]
    fn tmux_agent_exited_sees_through_the_bash_wrapper() {
        if which("tmux").is_none() {
            eprintln!("tmux not installed — skipping");
            return;
        }
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let s = create_session_cmd("shell", &cwd, 80, 24, "sleep 3").expect("create");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline && agent_exited(&s.id) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(!agent_exited(&s.id), "a command under the bash -lc wrapper is not 'exited'");
        // When it finishes the pane execs into the keep-alive `bash -l` and
        // counts as at rest again.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline && !agent_exited(&s.id) {
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
        assert!(agent_exited(&s.id), "after the command ends only the keep-alive shell remains");
        let _ = kill_session(&s.id);
    }
}
