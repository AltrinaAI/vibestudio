//! App-managed agent terminals, backed by tmux for true detach / nohup.
//!
//! The durable session is a tmux session named `ass-<id>` that holds the agent
//! process. The Rust app is a *bridge*: per connected client it spawns
//! `tmux attach` inside a PTY (portable-pty) and streams bytes to/from the UI.
//! Dropping the attach client leaves the session running (nohup w.r.t. the
//! frontend); reattaching spawns a fresh `tmux attach`, so full-screen TUIs
//! (claude/codex) redraw correctly.
//!
//! Lifetime model:
//!   * attachment ↔ frontend — decoupled: a global registry of `Weak`
//!     attachments; the strong `Arc` is held by the streaming owner (the SSE
//!     reader, or the desktop's managed state). When a client disconnects the
//!     strong ref drops → the attach PTY dies → tmux detaches → session lives.
//!   * session ↔ backend — bound, so a dead backend leaves no zombie agents:
//!     (a) each session embeds an owner-pid watchdog that self-reaps within
//!     ~2s of the backend pid vanishing (covers crash / SIGKILL);
//!     (b) `sweep_orphans()` (run at startup) kills any `ass-*` session whose
//!     `@ass_owner_pid` is no longer a live process;
//!     (c) `cleanup_owned()` kills this process's sessions on graceful exit.

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

fn pid_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

/// A process's start-time (field 22 of `/proc/<pid>/stat`, in clock ticks since
/// boot). Together with the pid it uniquely identifies a process, so a recycled
/// pid can't masquerade as the original owner.
fn proc_starttime(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The comm field (2nd) is parenthesized and may contain spaces or ')', so
    // parse from after the LAST ')': the remaining fields begin at `state`, and
    // starttime is the 20th of those (field 22 overall).
    let after = stat.rsplit_once(')')?.1;
    after.split_whitespace().nth(19).and_then(|s| s.parse().ok())
}

/// True iff `pid` is the *same* owner that recorded `start` — defeats pid reuse.
/// When `start` is unknown (older sessions), falls back to a plain liveness check.
fn owner_alive(pid: u32, start: Option<u64>) -> bool {
    pid_alive(pid) && start.map(|s| proc_starttime(pid) == Some(s)).unwrap_or(true)
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

fn session_opt_u64(id: &str, key: &str) -> Option<u64> {
    let out = tmux().args(["show-options", "-t", id, "-v", key]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

fn owner_pid_of(id: &str) -> Option<u32> {
    session_opt_u64(id, "@ass_owner_pid").map(|v| v as u32)
}

/// Kill any of *our* sessions whose owning backend process is gone. Run once at
/// backend startup — the belt to the watchdog's suspenders. Uses pid + start-time
/// so a recycled pid doesn't keep an orphan alive.
pub fn sweep_orphans() {
    if let Ok(sessions) = list_sessions() {
        for s in sessions {
            let alive = owner_pid_of(&s.id)
                .map(|pid| owner_alive(pid, session_opt_u64(&s.id, "@ass_owner_start")))
                .unwrap_or(false);
            if !alive {
                let _ = kill_session(&s.id);
            }
        }
    }
}

/// Kill the sessions owned by *this* process — call on graceful shutdown.
pub fn cleanup_owned() {
    let me = std::process::id();
    if let Ok(sessions) = list_sessions() {
        for s in sessions {
            if owner_pid_of(&s.id) == Some(me) {
                let _ = kill_session(&s.id);
            }
        }
    }
}

/// Create a detached tmux session running the chosen agent in `cwd`, tagged so
/// it can be listed/reaped, with an embedded owner-pid watchdog.
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
    let name = format!("{PREFIX}{secs}-{seq}");
    let owner = std::process::id();
    let owner_start = proc_starttime(owner);

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

    // The owner watchdog: self-reap within ~2s of the backend dying. We check
    // both the pid AND (when known) its start-time, so a recycled pid can't fool
    // the loop into thinking the original backend is still alive.
    let alive_check = match owner_start {
        Some(start) => format!(
            "kill -0 {owner} 2>/dev/null && [ \"$(awk '{{n=split($0,a,\")\"); split(a[n],b,\" \"); print b[20]}}' /proc/{owner}/stat 2>/dev/null)\" = \"{start}\" ]",
            owner = owner,
            start = start,
        ),
        None => format!("kill -0 {owner} 2>/dev/null", owner = owner),
    };
    let watchdog = format!(
        "( while {alive_check}; do sleep 2; done; {tmux} kill-session -t {name} ) >/dev/null 2>&1 &",
        alive_check = alive_check,
        tmux = shell_quote(&tmux_bin()),
        name = shell_quote(&name),
    );
    // `; exec bash -l` keeps the session alive after the agent exits.
    let line = if agent_cmd.is_empty() {
        format!("{watchdog} exec bash -l")
    } else {
        format!("{watchdog} {agent_cmd}; exec bash -l")
    };

    let cols_s = cols.max(2).to_string();
    let rows_s = rows.max(2).to_string();
    let status = tmux()
        .args([
            "new-session", "-d", "-s", &name, "-c", &cwd_resolved, "-x", &cols_s, "-y", &rows_s,
            "bash", "-lc", &line,
        ])
        .status()
        .map_err(|e| format!("Couldn't start tmux: {e}"))?;
    if !status.success() {
        return Err("tmux couldn't create the session (is the working directory valid?).".into());
    }

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
    set("@ass_owner_pid", &owner.to_string());
    if let Some(start) = owner_start {
        set("@ass_owner_start", &start.to_string());
    }
    set("status", "off"); // clean embed — no tmux status bar

    Ok(SessionInfo {
        id: name,
        label,
        agent: opt.agent,
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
        let m = self.master.lock().map_err(|_| "terminal is unavailable".to_string())?;
        m.resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
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

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
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
    fn starttime_and_owner_alive() {
        let me = std::process::id();
        let start = proc_starttime(me).expect("our own start-time is readable");
        assert!(owner_alive(me, Some(start)), "we are alive with our real start-time");
        assert!(!owner_alive(me, Some(start.wrapping_add(1))), "wrong start-time ⇒ not the same owner");
        assert!(owner_alive(me, None), "unknown start-time falls back to liveness");
        assert!(!owner_alive(2147480000, None), "a dead pid is never alive");
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

    // tmux-gated end-to-end of the session lifetime + orphan sweep.
    #[test]
    fn tmux_session_lifecycle_and_sweep() {
        if which("tmux").is_none() {
            eprintln!("tmux not installed — skipping");
            return;
        }
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let s = create_session("shell", &cwd, 80, 24, false, false, false, &[]).expect("create");
        assert!(s.id.starts_with(PREFIX));
        assert!(session_exists(&s.id), "session should exist after create");
        let listed = list_sessions().unwrap();
        let found = listed.iter().find(|x| x.id == s.id).expect("list_sessions should include it");
        assert_eq!(found.agent, "shell");
        assert!(found.label.contains('·'), "label carries the agent + cwd basename");

        // Re-tag with a dead owner pid → the orphan sweep must reap it.
        let _ = tmux()
            .args(["set-option", "-t", &s.id, "@ass_owner_pid", "2147480000"])
            .output();
        sweep_orphans();
        assert!(!session_exists(&s.id), "sweep_orphans should kill a dead-owner session");
    }

    // tmux-gated: a recycled pid (same pid, different start-time) is reaped.
    #[test]
    fn tmux_sweep_detects_pid_reuse() {
        if which("tmux").is_none() {
            eprintln!("tmux not installed — skipping");
            return;
        }
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let s = create_session("shell", &cwd, 80, 24, false, false, false, &[]).expect("create");
        assert!(session_exists(&s.id));
        // Owner pid stays our (live) pid, but corrupt the recorded start-time to
        // mimic a pid that was reused by a different process → sweep must reap.
        let _ = tmux()
            .args(["set-option", "-t", &s.id, "@ass_owner_start", "1"])
            .output();
        sweep_orphans();
        assert!(!session_exists(&s.id), "start-time mismatch (pid reuse) should be reaped");
    }
}
