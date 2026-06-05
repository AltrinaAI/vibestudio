//! SSH remote sessions — the "Full SSH support" roadmap item, built on the same
//! premise as the rest of the app: the backend is separable from the UI and every
//! capability is reachable over HTTP. This module is the *orchestrator* that makes
//! a remote box look local:
//!
//!   1. read the user's `~/.ssh/config` so they can pick a host they already trust;
//!   2. open one multiplexed SSH master connection to it (key auth only — see below);
//!   3. ensure an *identical* `skill-server` is present on the remote — reuse a
//!      cached one, else transfer the local binary (+ the built UI and the bundled
//!      activation skill) when the remote's OS/arch matches ours;
//!   4. launch that server bound to remote loopback and forward a local port to it;
//!   5. hand the frontend a `http://127.0.0.1:<localPort>` URL to open in a new
//!      window — the very same UI + `/api`, now driving the remote's filesystem.
//!
//! Lifetime model (mirrors `skill-term`'s "session outlives the UI" split, but the
//! durable thing here is the *remote server*, not a tmux session):
//!   * the forwarding `ssh -L` client is a child we hold in a registry; dropping it
//!     tears the tunnel down but leaves the remote server running;
//!   * `disconnect` is the deliberate teardown — it kills the tunnel, stops the
//!     remote server by pid, and closes the SSH master;
//!   * `cleanup_all` runs on backend shutdown so we never strand a tunnel.
//!
//! Auth: we run ssh with `BatchMode=yes`, so a host that needs an interactive
//! password / 2FA fails fast with a clear error instead of hanging on a prompt we
//! can't satisfy from a non-TTY child. Key-based hosts (the usual dev box) work.

use std::collections::HashMap;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

static SEQ: AtomicU64 = AtomicU64::new(0);

// ───────────────────────────── public types ─────────────────────────────

/// One `Host` block from `~/.ssh/config`, surfaced in the remote picker. Only the
/// fields we show / need are kept; the rest of the config still governs the actual
/// connection (we always connect by the alias, so ssh applies the full stanza).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    /// The alias after `Host` (what the user picks and what we pass to `ssh`).
    pub name: String,
    /// `HostName` (the real address), when set.
    pub host_name: Option<String>,
    /// `User`, when set.
    pub user: Option<String>,
    /// `Port`, when set.
    pub port: Option<u16>,
}

/// A live remote connection: an SSH master + a forwarded local port pointed at the
/// remote `skill-server`. `localPort` is what the UI opens in a new window.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSession {
    /// Stable id (`rem-<secs>-<seq>`) — the handle for `disconnect`.
    pub id: String,
    /// The ssh host alias this session is connected to.
    pub host: String,
    /// Loopback port on *this* machine forwarded to the remote server.
    pub local_port: u16,
    /// Loopback port the `skill-server` listens on over there.
    pub remote_port: u16,
    /// How the server got there: `reused` | `transferred`.
    pub provisioned: String,
    /// Unix seconds (as a string) when the session came up.
    pub created: String,
    /// A human note worth surfacing (e.g. a libc caveat); usually `None`.
    pub note: Option<String>,
}

// ─────────────────────────── ssh config parsing ───────────────────────────

/// Parse the text of an `ssh_config` into the host aliases we can offer. Real
/// `Host` lines only (patterns containing `*`/`?` and the catch-all `Host *` are
/// skipped — they aren't connectable targets), one `SshHost` per alias, carrying
/// the `HostName`/`User`/`Port` that apply to it. Tolerant of comments, blank
/// lines, `=` separators, and case-insensitive keywords (per ssh's own rules).
pub fn parse_ssh_config(text: &str) -> Vec<SshHost> {
    let mut hosts: Vec<SshHost> = Vec::new();
    // Index of the alias(es) the current stanza's keywords apply to. A single
    // `Host` line can name several aliases; we attribute keywords to each.
    let mut current: Vec<usize> = Vec::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Keyword and value are split by whitespace and/or a single '='.
        let (keyword, value) = match split_kv(line) {
            Some(kv) => kv,
            None => continue,
        };
        let key = keyword.to_ascii_lowercase();
        if key == "host" {
            current = Vec::new();
            for alias in value.split_whitespace() {
                // Patterns and negations aren't concrete, pickable hosts.
                if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                    continue;
                }
                let idx = hosts.len();
                hosts.push(SshHost {
                    name: alias.to_string(),
                    host_name: None,
                    user: None,
                    port: None,
                });
                current.push(idx);
            }
            continue;
        }
        if current.is_empty() {
            continue; // a global option before any Host — not ours to attribute
        }
        for &i in &current {
            match key.as_str() {
                "hostname" => hosts[i].host_name = Some(value.to_string()),
                "user" => hosts[i].user = Some(value.to_string()),
                "port" => hosts[i].port = value.parse().ok(),
                _ => {}
            }
        }
    }
    hosts
}

/// Split an ssh_config line into `(keyword, value)`. ssh accepts whitespace, `=`,
/// or whitespace-around-`=` as the separator; the value runs to end of line.
fn split_kv(line: &str) -> Option<(&str, &str)> {
    let bytes = line.as_bytes();
    // Find the end of the keyword (first whitespace or '=').
    let kw_end = bytes
        .iter()
        .position(|&b| b == b' ' || b == b'\t' || b == b'=')?;
    let keyword = line[..kw_end].trim();
    let rest = line[kw_end..].trim_start_matches([' ', '\t']);
    let value = rest.strip_prefix('=').unwrap_or(rest);
    let value = value.trim().trim_matches('"');
    if keyword.is_empty() || value.is_empty() {
        return None;
    }
    Some((keyword, value))
}

/// The user's configured ssh hosts (`~/.ssh/config`). An absent file is not an
/// error — it just means "no hosts yet" (empty list).
pub fn list_hosts() -> Result<Vec<SshHost>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(vec![]);
    };
    let path = home.join(".ssh").join("config");
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(parse_ssh_config(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(format!("Couldn't read {}: {e}", path.display())),
    }
}

// ─────────────────────────── host name validation ───────────────────────────

/// Reject anything that isn't a plain ssh host alias before it reaches `ssh`'s
/// argv — most importantly a leading `-` (which ssh would read as an option) and
/// any whitespace/control bytes. Allows the host-pattern characters real configs
/// use (letters, digits, `.`, `-`, `_`, `:` for IPv6, `@` for user@host).
fn validate_host(host: &str) -> Result<(), String> {
    if host.is_empty() {
        return Err("No host specified.".into());
    }
    if host.starts_with('-') {
        return Err("Invalid host (must not start with '-').".into());
    }
    if host
        .chars()
        .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("Invalid host (contains whitespace or control characters).".into());
    }
    Ok(())
}

// ────────────────────────────── ssh plumbing ──────────────────────────────

/// The control-socket path for a session's multiplexed SSH master. Kept short and
/// under our own dir so a long host alias can't overflow the unix-socket path cap.
fn control_path(id: &str) -> PathBuf {
    let base = dirs::home_dir()
        .map(|h| h.join(".skill-studio").join("control"))
        .unwrap_or_else(|| std::env::temp_dir().join("skill-studio-control"));
    base.join(format!("{id}.sock"))
}

/// Options shared by every ssh/scp invocation in a session: non-interactive (so we
/// never hang on a prompt), bounded connect time, auto-trust new host keys, and the
/// shared control socket so we authenticate exactly once.
fn mux_opts(ctrl: &Path) -> Vec<String> {
    vec![
        "-o".into(), "BatchMode=yes".into(),
        "-o".into(), "ConnectTimeout=15".into(),
        "-o".into(), "StrictHostKeyChecking=accept-new".into(),
        "-o".into(), format!("ControlPath={}", ctrl.display()),
    ]
}

/// Spawn the persistent SSH master (`-fN`: authenticate, then background with no
/// remote command). Subsequent ssh/scp calls ride this one connection, so the user
/// authenticates once. Returns a clear error if key auth isn't possible.
fn master_start(ctrl: &Path, host: &str) -> Result<(), String> {
    if let Some(dir) = ctrl.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut cmd = Command::new("ssh");
    cmd.args(["-f", "-N"])
        .args(["-o", "ControlMaster=yes", "-o", "ControlPersist=600"])
        .args(mux_opts(ctrl))
        .arg(host)
        .stdin(Stdio::null());
    let out = cmd
        .output()
        .map_err(|e| format!("Couldn't run ssh (is it installed and on PATH?): {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        let hint = if err.contains("Permission denied") || err.contains("publickey") {
            "  (this first pass supports key-based auth only — password/2FA hosts aren't connectable yet)"
        } else {
            ""
        };
        return Err(format!("SSH connection to '{host}' failed: {err}{hint}"));
    }
    Ok(())
}

/// Tear down the SSH master for a session (idempotent).
fn master_exit(ctrl: &Path, host: &str) {
    let _ = Command::new("ssh")
        .args(["-O", "exit"])
        .args(mux_opts(ctrl))
        .arg(host)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = std::fs::remove_file(ctrl);
}

/// Run one remote command over the established master and return its stdout
/// (trimmed). Non-zero exit → `Err` carrying the command's stderr.
fn ssh_run(ctrl: &Path, host: &str, remote_cmd: &str) -> Result<String, String> {
    let out = Command::new("ssh")
        .args(mux_opts(ctrl))
        .arg(host)
        // A login shell so PATH/HOME are set the way the user's box expects.
        .arg("bash")
        .arg("-lc")
        .arg(remote_cmd)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("ssh exec failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Remote command failed: {}", err.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Copy a local file or directory to the remote over the shared master connection.
fn scp(ctrl: &Path, host: &str, local: &Path, remote_rel: &str, recursive: bool) -> Result<(), String> {
    if !local.exists() {
        return Err(format!("Local path to transfer is missing: {}", local.display()));
    }
    let mut cmd = Command::new("scp");
    if recursive {
        cmd.arg("-r");
    }
    cmd.args(mux_opts(ctrl))
        .arg(local)
        .arg(format!("{host}:{remote_rel}"))
        .stdin(Stdio::null());
    let out = cmd.output().map_err(|e| format!("scp failed to run: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Transfer of {} failed: {}", local.display(), err.trim()));
    }
    Ok(())
}

// ─────────────────────────── local artifact discovery ───────────────────────────

/// Locate *our own* `skill-server` binary to ship to the remote. Order:
///   1. `SKILL_SERVER_BIN` (explicit override);
///   2. the current executable, when we *are* skill-server (the browser/remote
///      backend case — the binary that's running is exactly the one we want);
///   3. dev/release build outputs next to the workspace (`target/{release,debug}`).
fn local_server_bin() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("SKILL_SERVER_BIN") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Ok(pb);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let is_server = exe
            .file_name()
            .map(|n| n.to_string_lossy().starts_with("skill-server"))
            .unwrap_or(false);
        if is_server && exe.is_file() {
            return Ok(exe);
        }
        // Desktop app: probe the workspace target dirs relative to the exe.
        if let Some(dir) = exe.parent() {
            for cand in [dir.join("skill-server"), dir.join("skill-server.exe")] {
                if cand.is_file() {
                    return Ok(cand);
                }
            }
        }
    }
    for cand in ["target/release/skill-server", "target/debug/skill-server"] {
        let pb = PathBuf::from(cand);
        if pb.is_file() {
            return Ok(pb);
        }
    }
    Err("Couldn't find a local skill-server binary to transfer. Set SKILL_SERVER_BIN to its path, \
         or build it with `cargo build -p skill-server`."
        .into())
}

/// The built UI to serve from the remote (`dist/`). `SKILL_DIST` wins; otherwise
/// the conventional `dist` beside the working dir or the executable.
fn local_dist() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("SKILL_DIST") {
        let pb = PathBuf::from(p);
        if pb.join("index.html").is_file() {
            return Ok(pb);
        }
    }
    let mut candidates = vec![PathBuf::from("dist")];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("dist"));
            candidates.push(dir.join("../dist"));
        }
    }
    candidates
        .into_iter()
        .find(|d| d.join("index.html").is_file())
        .ok_or_else(|| {
            "Couldn't find the built UI (dist/) to transfer. Run `npm run build`, or set SKILL_DIST."
                .to_string()
        })
}

/// The bundled `skill-studio` activation skill (so the remote's secrets setup can
/// install it, exactly like local). Best-effort: `None` just means the remote runs
/// without it pre-staged.
fn local_bootstrap_skill() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("SKILL_BOOTSTRAP_SKILL") {
        let pb = PathBuf::from(p);
        if pb.join("SKILL.md").is_file() {
            return Some(pb);
        }
    }
    let mut candidates = vec![PathBuf::from("skills/skill-studio")];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("skills/skill-studio"));
            candidates.push(dir.join("../skills/skill-studio"));
        }
    }
    candidates.into_iter().find(|c| c.join("SKILL.md").is_file())
}

// ─────────────────────────── os / arch matching ───────────────────────────

/// Canonicalize an architecture name so equivalent spellings compare equal
/// (`arm64`≡`aarch64`, `amd64`≡`x86_64`).
fn norm_arch(a: &str) -> String {
    match a.to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" | "x64" => "x86_64".into(),
        "aarch64" | "arm64" => "arm64".into(),
        other => other.to_string(),
    }
}

/// Canonicalize an OS name from `uname -s` / Rust's `target_os` to a common token.
fn norm_os(s: &str) -> String {
    let l = s.to_ascii_lowercase();
    if l.contains("linux") {
        "linux".into()
    } else if l.contains("darwin") || l.contains("macos") {
        "darwin".into()
    } else if l.contains("mingw") || l.contains("cygwin") || l.contains("windows") {
        "windows".into()
    } else {
        l
    }
}

/// This machine's `(os, arch)` in the same normalized vocabulary as the remote's
/// `uname` output, so a transferred binary is only ever shipped where it can exec.
fn local_os_arch() -> (String, String) {
    (norm_os(std::env::consts::OS), norm_arch(std::env::consts::ARCH))
}

// ─────────────────────────── port helpers ───────────────────────────

/// Grab a free loopback port on *this* machine by binding `:0` and reading back the
/// assigned port. Inherently racy (the port is briefly free after we close the
/// listener) but fine here: the SSH forward re-binds it within milliseconds.
fn free_local_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Couldn't allocate a local port: {e}"))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| format!("Couldn't read the local port: {e}"))
}

/// Ask the remote for a free loopback port (python3 if present, else a bash
/// `/dev/tcp` probe over a small range). Returns a concrete port number.
fn remote_free_port(ctrl: &Path, host: &str) -> Result<u16, String> {
    let script = r#"
if command -v python3 >/dev/null 2>&1; then
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
else
  for p in $(seq 8765 8900); do
    if ! (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null; then echo $p; exit 0; fi
    exec 3>&- 2>/dev/null || true
  done
  echo 0
fi
"#;
    let out = ssh_run(ctrl, host, script)?;
    let port: u16 = out
        .lines()
        .last()
        .unwrap_or("")
        .trim()
        .parse()
        .map_err(|_| format!("Couldn't determine a free port on the remote (got '{out}')."))?;
    if port == 0 {
        return Err("No free port available on the remote.".into());
    }
    Ok(port)
}

// ─────────────────────────── remote detection ───────────────────────────

struct RemoteInfo {
    os: String,
    arch: String,
    cached: bool,
    cargo: bool,
}

/// One round-trip that tells us everything the provisioning decision needs: the
/// remote's OS/arch, whether a `skill-server` is already cached there, and whether
/// a Rust toolchain exists (for the cross-arch guidance).
fn detect_remote(ctrl: &Path, host: &str) -> Result<RemoteInfo, String> {
    let script = r#"
echo "OS=$(uname -s)"
echo "ARCH=$(uname -m)"
if [ -x "$HOME/.skill-studio/bin/skill-server" ]; then echo "CACHED=1"; else echo "CACHED=0"; fi
if command -v cargo >/dev/null 2>&1; then echo "CARGO=1"; else echo "CARGO=0"; fi
"#;
    let out = ssh_run(ctrl, host, script)?;
    let mut os = String::new();
    let mut arch = String::new();
    let mut cached = false;
    let mut cargo = false;
    for line in out.lines() {
        if let Some(v) = line.strip_prefix("OS=") {
            os = norm_os(v.trim());
        } else if let Some(v) = line.strip_prefix("ARCH=") {
            arch = norm_arch(v.trim());
        } else if let Some(v) = line.strip_prefix("CACHED=") {
            cached = v.trim() == "1";
        } else if let Some(v) = line.strip_prefix("CARGO=") {
            cargo = v.trim() == "1";
        }
    }
    if os.is_empty() || arch.is_empty() {
        return Err(format!("Couldn't detect the remote OS/arch (got '{out}')."));
    }
    Ok(RemoteInfo { os, arch, cached, cargo })
}

// ─────────────────────────── provisioning ───────────────────────────

/// Make sure an identical `skill-server` is present on the remote, returning how it
/// got there. Reuse a cached one; else (matching OS/arch) transfer ours along with
/// the built UI and bundled skill; else fail with actionable cross-arch guidance.
fn provision(ctrl: &Path, host: &str, info: &RemoteInfo) -> Result<&'static str, String> {
    if info.cached {
        return Ok("reused");
    }
    let (local_os, local_arch) = local_os_arch();
    if info.os != local_os || info.arch != local_arch {
        let cargo_hint = if info.cargo {
            " A Rust toolchain was detected there, so `cargo install --path crates/skill-server` \
             on the remote would produce a matching binary."
        } else {
            " Install skill-server on the remote yourself (or a Rust toolchain so it can be built there)."
        };
        return Err(format!(
            "The remote is {}/{} but this machine is {}/{}, so the local skill-server binary \
             won't run there.{cargo_hint} Once a skill-server is on the remote's PATH or at \
             ~/.skill-studio/bin/skill-server, reconnecting will reuse it.",
            info.os, info.arch, local_os, local_arch
        ));
    }

    // Matching target: ship the binary, the UI, and (best-effort) the skill.
    let bin = local_server_bin()?;
    let dist = local_dist()?;
    ssh_run(ctrl, host, "mkdir -p ~/.skill-studio/bin ~/.skill-studio/log ~/.skill-studio/skills")?;
    scp(ctrl, host, &bin, "~/.skill-studio/bin/skill-server", false)?;
    ssh_run(ctrl, host, "chmod +x ~/.skill-studio/bin/skill-server")?;
    // `scp -r <dist> host:~/.skill-studio/dist` lands the tree as `dist/` even if
    // the local folder is named differently.
    ssh_run(ctrl, host, "rm -rf ~/.skill-studio/dist")?;
    scp(ctrl, host, &dist, "~/.skill-studio/dist", true)?;
    if let Some(skill) = local_bootstrap_skill() {
        let _ = scp(ctrl, host, &skill, "~/.skill-studio/skills/skill-studio", true);
    }
    Ok("transferred")
}

/// Launch `skill-server` on the remote, detached, bound to remote loopback. Returns
/// its pid so we can stop it on disconnect. Mirrors the local invocation (same
/// binary, same `--dist`, same bundled-skill env) so the remote app is identical.
fn launch_server(ctrl: &Path, host: &str, remote_port: u16, id: &str) -> Result<u32, String> {
    let cmd = format!(
        "mkdir -p ~/.skill-studio/log; \
         SKILL_BOOTSTRAP_SKILL=$HOME/.skill-studio/skills/skill-studio \
         SKILL_DIST=$HOME/.skill-studio/dist \
         nohup $HOME/.skill-studio/bin/skill-server --host 127.0.0.1 --port {port} \
           --dist $HOME/.skill-studio/dist \
           >$HOME/.skill-studio/log/server-{id}.log 2>&1 & \
         echo $!",
        port = remote_port,
        id = id,
    );
    let out = ssh_run(ctrl, host, &cmd)?;
    out.lines()
        .last()
        .unwrap_or("")
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("Couldn't read the remote server pid (got '{out}')."))
}

/// Stop the remote server by pid (idempotent — a missing process is fine).
fn stop_server(ctrl: &Path, host: &str, pid: u32) {
    let _ = ssh_run(ctrl, host, &format!("kill {pid} 2>/dev/null || true"));
}

// ─────────────────────────── tunnel + registry ───────────────────────────

/// A held SSH local-forward client (`ssh -N -L …`). Holding the `Child` keeps the
/// tunnel open; killing it closes the forwarded port.
struct Session {
    info: RemoteSession,
    ctrl: PathBuf,
    tunnel: Child,
    remote_pid: u32,
}

fn registry() -> &'static Mutex<HashMap<String, Session>> {
    static REG: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Spawn the forwarding client `127.0.0.1:<local> → 127.0.0.1:<remote>` over the
/// shared master. Held as a child so the tunnel's lifetime is ours to control.
fn tunnel_start(ctrl: &Path, host: &str, local_port: u16, remote_port: u16) -> Result<Child, String> {
    Command::new("ssh")
        .args(["-N"])
        .args(mux_opts(ctrl))
        .arg("-L")
        .arg(format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"))
        .arg(host)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't open the SSH tunnel: {e}"))
}

/// Poll the forwarded local port until the remote server accepts a TCP connection
/// (the tunnel is up *and* the server is listening), or time out.
fn wait_for_port(local_port: u16, timeout: Duration) -> Result<(), String> {
    let addr = format!("127.0.0.1:{local_port}");
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(
            &addr.parse().map_err(|e| format!("bad addr: {e}"))?,
            Duration::from_millis(500),
        )
        .is_ok()
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("Timed out waiting for the remote server to come up through the tunnel.".into())
}

// ─────────────────────────── public API ───────────────────────────

/// Connect to a host: open the SSH master, ensure + launch an identical
/// skill-server on the remote, forward a local port to it, and return the live
/// session (the UI opens `http://127.0.0.1:<localPort>` in a new window). On any
/// failure the partial connection is fully torn down before returning the error.
pub fn connect(host: &str) -> Result<RemoteSession, String> {
    validate_host(host)?;

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let id = format!("rem-{secs}-{seq}");
    let ctrl = control_path(&id);

    master_start(&ctrl, host)?;

    // RAII teardown for the half-built connection: until we hand ownership to the
    // registry (`committed`), any early return (a `?`) unwinds through here and
    // undoes exactly what's been started — stop a launched remote server, then
    // close the SSH master — so a failure mid-setup never strands anything.
    struct Partial<'a> {
        ctrl: &'a Path,
        host: &'a str,
        remote_pid: Option<u32>,
        committed: bool,
    }
    impl Drop for Partial<'_> {
        fn drop(&mut self) {
            if self.committed {
                return;
            }
            if let Some(pid) = self.remote_pid {
                stop_server(self.ctrl, self.host, pid);
            }
            master_exit(self.ctrl, self.host);
        }
    }
    let mut partial = Partial { ctrl: &ctrl, host, remote_pid: None, committed: false };

    let info = detect_remote(&ctrl, host)?;
    let note = libc_note(&info);
    let provisioned = provision(&ctrl, host, &info)?;
    let remote_port = remote_free_port(&ctrl, host)?;
    let remote_pid = launch_server(&ctrl, host, remote_port, &id)?;
    partial.remote_pid = Some(remote_pid); // now teardown will stop it on failure
    let local_port = free_local_port()?;
    let tunnel = tunnel_start(&ctrl, host, local_port, remote_port)?;

    let session = RemoteSession {
        id: id.clone(),
        host: host.to_string(),
        local_port,
        remote_port,
        provisioned: provisioned.to_string(),
        created: secs.to_string(),
        note,
    };
    registry()
        .lock()
        .map_err(|_| "remote registry unavailable".to_string())?
        .insert(
            id.clone(),
            Session {
                info: session.clone(),
                ctrl: ctrl.clone(),
                tunnel,
                remote_pid,
            },
        );
    partial.committed = true; // the registry now owns teardown (via `disconnect`)
    drop(partial);

    // Wait for the server to be reachable through the tunnel; on timeout, tear the
    // whole session down via the registry path.
    if let Err(e) = wait_for_port(local_port, Duration::from_secs(30)) {
        let _ = disconnect(&id);
        return Err(e);
    }
    Ok(session)
}

/// libc mismatch can break a transferred Linux binary even when OS/arch match
/// (glibc vs musl). We can't cheaply detect it here, so attach a gentle caveat only
/// when we actually transferred onto Linux; reuse/other-OS paths get no note.
fn libc_note(info: &RemoteInfo) -> Option<String> {
    let (los, larch) = local_os_arch();
    if !info.cached && info.os == "linux" && info.os == los && info.arch == larch {
        Some(
            "If the remote uses a different libc (e.g. musl vs glibc), the transferred binary may \
             not start — check ~/.skill-studio/log if the page doesn't load."
                .into(),
        )
    } else {
        None
    }
}

/// Live remote sessions (registry snapshot), newest first.
pub fn list_sessions() -> Vec<RemoteSession> {
    let mut out: Vec<RemoteSession> = registry()
        .lock()
        .map(|reg| reg.values().map(|s| s.info.clone()).collect())
        .unwrap_or_default();
    out.sort_by(|a, b| b.created.cmp(&a.created));
    out
}

/// Disconnect a session: drop the tunnel, stop the remote server, close the SSH
/// master. Idempotent — an unknown id is treated as already gone.
pub fn disconnect(id: &str) -> Result<(), String> {
    let session = registry()
        .lock()
        .map_err(|_| "remote registry unavailable".to_string())?
        .remove(id);
    if let Some(mut s) = session {
        let _ = s.tunnel.kill();
        let _ = s.tunnel.wait();
        stop_server(&s.ctrl, &s.info.host, s.remote_pid);
        master_exit(&s.ctrl, &s.info.host);
    }
    Ok(())
}

/// Tear down every live session — call on backend shutdown so no tunnel or remote
/// server is stranded.
pub fn cleanup_all() {
    let ids: Vec<String> = registry()
        .lock()
        .map(|reg| reg.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        let _ = disconnect(&id);
    }
}

// ─────────────────────────────────── tests ───────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_hosts() {
        let cfg = "\
Host dev
    HostName 10.0.0.5
    User harvey
    Port 2222

Host prod gateway
    HostName prod.example.com
";
        let hosts = parse_ssh_config(cfg);
        assert_eq!(hosts.len(), 3);
        assert_eq!(hosts[0].name, "dev");
        assert_eq!(hosts[0].host_name.as_deref(), Some("10.0.0.5"));
        assert_eq!(hosts[0].user.as_deref(), Some("harvey"));
        assert_eq!(hosts[0].port, Some(2222));
        // A multi-alias Host line attributes its keywords to each alias.
        assert_eq!(hosts[1].name, "prod");
        assert_eq!(hosts[2].name, "gateway");
        assert_eq!(hosts[1].host_name.as_deref(), Some("prod.example.com"));
        assert_eq!(hosts[2].host_name.as_deref(), Some("prod.example.com"));
    }

    #[test]
    fn skips_patterns_and_comments() {
        let cfg = "\
# a comment
Host *
    ForwardAgent yes

Host *.internal
    User bob

Host real
    HostName r.example.com
";
        let hosts = parse_ssh_config(cfg);
        // `Host *` and `Host *.internal` are patterns, not pickable hosts.
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "real");
    }

    #[test]
    fn tolerates_equals_and_case() {
        let cfg = "\
host=DEV
  hostname = 1.2.3.4
  PORT=22
";
        let hosts = parse_ssh_config(cfg);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "DEV");
        assert_eq!(hosts[0].host_name.as_deref(), Some("1.2.3.4"));
        assert_eq!(hosts[0].port, Some(22));
    }

    #[test]
    fn global_options_before_host_are_ignored() {
        let cfg = "\
ServerAliveInterval 60
Host only
    HostName h
";
        let hosts = parse_ssh_config(cfg);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "only");
    }

    #[test]
    fn host_validation() {
        assert!(validate_host("dev").is_ok());
        assert!(validate_host("user@10.0.0.1").is_ok());
        assert!(validate_host("-oProxyCommand=evil").is_err());
        assert!(validate_host("has space").is_err());
        assert!(validate_host("").is_err());
    }

    #[test]
    fn arch_and_os_normalization() {
        assert_eq!(norm_arch("aarch64"), norm_arch("arm64"));
        assert_eq!(norm_arch("amd64"), "x86_64");
        assert_eq!(norm_os("Linux"), "linux");
        assert_eq!(norm_os("Darwin"), "darwin");
        assert_eq!(norm_os("macos"), "darwin");
    }

    #[test]
    fn free_local_port_is_nonzero() {
        let p = free_local_port().expect("should allocate a port");
        assert!(p > 0);
    }

    #[test]
    fn disconnect_unknown_is_ok() {
        // No such session — must be a clean no-op, never an error.
        assert!(disconnect("rem-does-not-exist").is_ok());
    }
}
