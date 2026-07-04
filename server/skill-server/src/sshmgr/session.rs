//! The remote session lifecycle. A SINGLE transport child (`ssh` or `wsl.exe`) both
//! launches the remote server (holding its stdin as a lifeline) and reaches a local port
//! on it: ssh forwards `-L L:127.0.0.1:R` (the client chooses R, sidestepping the "`-L`
//! needs the port before the server picks it" chicken-and-egg, and retries on a port
//! collision); WSL needs no forward — its loopback is shared with Windows, so L == R.
//! One child ⇒ one auth; killing it — or the desktop dying, which closes the held stdin
//! pipe — EOFs the remote server's stdin so it self-exits (no orphan), and the
//! forward dies with the same process.
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::{RemoteStatus, RemoteTarget};

use super::ssh::Transport;
use super::{provision, set_stage, State};

/// A live connection: the transport child (lifeline + tunnel) and the forwarded local port.
pub struct Session {
    pub local_port: u16,
    pub token: String,
    /// Shared so the liveness monitor can `try_wait` it while `teardown` can kill it.
    child: Arc<Mutex<Child>>,
    _stdin: ChildStdin, // held open = the remote server's lifeline
}

impl Session {
    /// Kill the ssh child → remote stdin EOFs → the remote server exits and the
    /// forward closes. (`_stdin` also closes as the struct drops.)
    pub fn teardown(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Run the whole connect flow on a background thread, then store the result — unless
/// a disconnect or newer connect superseded it (tracked by `generation`).
pub fn run_connect(state: Arc<Mutex<State>>, host: String, generation: u64, app_version: String) {
    let transport = Transport::parse(&host);
    let result = connect_flow(&state, &transport, &host, generation, &app_version);
    let mut s = state.lock().unwrap();
    if s.generation != generation {
        // Superseded — discard, tearing down any session we just built.
        drop(s);
        if let Ok(mut sess) = result {
            sess.teardown();
        }
        return;
    }
    s.busy = false;
    match result {
        Ok(sess) => {
            let child = sess.child.clone();
            s.target = Some(RemoteTarget {
                base_url: format!("http://127.0.0.1:{}", sess.local_port),
                token: sess.token.clone(),
            });
            s.status = RemoteStatus { state: "connected".into(), host: Some(host.clone()), message: None };
            s.session = Some(sess);
            // Remember this host so the next launch auto-reconnects (VS Code-style).
            // Persist UNDER the lock so it's atomic with the generation check above —
            // a concurrent disconnect can't slip in and have us re-persist a host it
            // just cleared. Only persisted now that we're fully connected.
            s.last_host = Some(host.clone());
            super::lastconn::remember(&host);
            drop(s);
            // Watch the ssh child: if it dies (network loss, remote crash), clear the
            // session so the UI falls back to Local instead of proxying a dead tunnel.
            spawn_monitor(state.clone(), generation, host, child);
        }
        Err(e) => {
            s.target = None;
            s.session = None;
            // Hybrid resume policy: if the host we just failed to reach IS the
            // remembered resume host, forget it — a genuinely-dead host auto-clears
            // after one failed launch attempt, while an unrelated failed connect
            // leaves the memory intact (we still resume the host that last worked).
            if s.last_host.as_deref() == Some(host.as_str()) {
                s.last_host = None;
                super::lastconn::forget();
            }
            s.status = RemoteStatus { state: "error".into(), host: Some(host), message: Some(e) };
        }
    }
}

/// Watch the ssh child; once it exits (disconnect, network loss, remote crash) clear
/// the active session UNLESS a newer connect/disconnect superseded this one (generation
/// guard). This is what lets the UI recover to Local after a dropped tunnel instead of
/// proxying to a dead loopback port forever.
fn spawn_monitor(state: Arc<Mutex<State>>, generation: u64, host: String, child: Arc<Mutex<Child>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        // "Still running" is the only non-exit case; Some(status) or a wait error
        // (already reaped by teardown) both mean the child is gone.
        let still_running = match child.lock() {
            Ok(mut c) => matches!(c.try_wait(), Ok(None)),
            Err(_) => false, // poisoned mutex — treat as gone
        };
        if still_running {
            continue;
        }
        let mut s = state.lock().unwrap();
        if s.generation == generation {
            s.target = None;
            s.session = None;
            s.status = RemoteStatus {
                state: "error".into(),
                host: Some(host.clone()),
                message: Some(format!("Connection to {host} lost.")),
            };
        }
        return;
    });
}

fn connect_flow(
    state: &Arc<Mutex<State>>,
    transport: &Transport,
    host: &str,
    generation: u64,
    app_version: &str,
) -> Result<Session, String> {
    set_stage(state, generation, "detecting", host, "Detecting the remote platform…");
    let platform = provision::detect(transport)?;

    set_stage(state, generation, "installing", host, "Installing skill-server on the remote…");
    let bin = provision::ensure_installed(transport, &platform, app_version)?;
    let version = provision::server_version(app_version);

    set_stage(state, generation, "launching", host, "Starting the remote server…");
    // Keep-alive means a prior connect's server for this version can still be running
    // (closing the laptop disconnects the client but leaves the remote server up). With a
    // single client there's never a second user contending for it, so reattach to that
    // warm server instead of launching a duplicate. ANY miss/failure falls through to a
    // fresh launch below — so the worst case is exactly the pre-reattach behaviour.
    if let Some((remote_port, token)) = probe_running(transport, &version) {
        if let Ok(session) = reattach(transport, host, remote_port, &token) {
            return Ok(session);
        }
    }

    let token = new_token();
    let mut last_err = String::new();
    // A few attempts to dodge a remote/local port collision (R is client-chosen).
    for attempt in 0..4u32 {
        match launch(transport, host, &bin, &token, &version, attempt) {
            Ok(session) => return Ok(session),
            Err(LaunchError::PortConflict(e)) => last_err = e,
            Err(LaunchError::Fatal(e)) => return Err(e),
        }
    }
    Err(format!("Could not start the remote server after several attempts. {last_err}"))
}

enum LaunchError {
    /// A local or remote port was taken — retry with fresh ports.
    PortConflict(String),
    /// Auth/connectivity/other — don't retry.
    Fatal(String),
}

fn launch(transport: &Transport, host: &str, bin: &str, token: &str, version: &str, attempt: u32) -> Result<Session, LaunchError> {
    let local_port = free_local_port().map_err(LaunchError::Fatal)?;
    // WSL shares the loopback with Windows, so the server listens on the same port the
    // client connects to (no `-L`). For ssh, R is client-chosen and forwarded.
    let remote_port = if transport.same_port() { local_port } else { pick_remote_port(attempt) };
    spawn_session(transport, host, &launch_script(version, bin, remote_port, token), local_port, remote_port, token)
}

/// Reattach to an already-running server (found by [`probe_running`]) instead of starting
/// a second one: open the tunnel to its port and become the disconnect detector (announce
/// READY, then hold stdin via `cat`). The warm server keeps running on its own lifeline;
/// killing this child only drops our tunnel — consistent with the keep-alive intent.
fn reattach(transport: &Transport, host: &str, remote_port: u16, token: &str) -> Result<Session, LaunchError> {
    let local_port = if transport.same_port() { remote_port } else { free_local_port().map_err(LaunchError::Fatal)? };
    spawn_session(transport, host, &reattach_script(remote_port), local_port, remote_port, token)
}

/// Ask the remote whether a server for this version is already running (kept alive past a
/// prior disconnect) and, if so, return its `(port, token)` from the record the launch
/// wrote — but only after confirming the recorded pid is alive AND is a `skill-server`
/// (guards a reused pid). Any miss → `None` → the caller launches fresh.
fn probe_running(transport: &Transport, version: &str) -> Option<(u16, String)> {
    let out = super::ssh::capture(transport, &probe_script(version)).ok()?;
    let mut it = out.split_whitespace();
    let port: u16 = it.next()?.parse().ok()?;
    let token = it.next()?.to_string();
    (!token.is_empty()).then_some((port, token))
}

/// Launch remote command: record `pid port token` (so a later connect can REATTACH to this
/// exact server rather than spawn a duplicate), then `exec` the server. `$$` is the shell
/// pid, preserved across `exec`, so the record holds the server's real pid. Joined with `;`
/// (never `&&`) so a record-write hiccup can't stop the server — at worst the record is
/// missing and the next connect just launches fresh.
///
/// TOKENLESS since the phone inversion: the remote server is the hub a phone
/// reaches directly through the remote's own `tailscale serve`, and a browser
/// can't send a bearer — so the loopback bind + tailnet is the trust boundary,
/// same as the local server. The token is still generated and RECORDED: the
/// proxy keeps injecting it (a `None`-token server ignores it), which keeps
/// reattach compatible with older, token-enforcing servers.
/// `bin` is remote-`$HOME`-expanded, `remote_port` numeric, `token`/`version` shell-safe.
fn launch_script(version: &str, bin: &str, remote_port: u16, token: &str) -> String {
    format!(
        "d=\"$HOME/.skill-studio/server/{version}\"; mkdir -p \"$d\"; \
         printf '%s %s %s' \"$$\" {remote_port} {token} > \"$d/running\"; \
         exec \"{bin}\" --host 127.0.0.1 --port {remote_port} --lifeline-stdin"
    )
}

/// Reattach remote command: announce READY (so the client's startup wait succeeds) and hold
/// stdin via `cat` — this child is purely the tunnel + disconnect detector; it starts no
/// server.
fn reattach_script(remote_port: u16) -> String {
    format!("echo SKILL_SERVER_READY port={remote_port}; exec cat")
}

/// Probe remote command: echo `port token` iff the recorded pid is alive and is actually a
/// `skill-server` (the comm check rejects a record whose pid was recycled by another
/// process). Silent (exit 0, no output) on any miss.
fn probe_script(version: &str) -> String {
    format!(
        "f=\"$HOME/.skill-studio/server/{version}/running\"; [ -f \"$f\" ] || exit 0; \
         read pid port token < \"$f\"; [ -n \"$pid\" ] || exit 0; \
         ps -p \"$pid\" -o comm= 2>/dev/null | grep -q skill-server || exit 0; \
         echo \"$port $token\""
    )
}

/// Spawn the transport child for `remote_cmd` (which either launches the server or, on a
/// reattach, just tunnels), hold its stdin as the lifeline/keepalive, and block until the
/// READY line before returning the live Session.
fn spawn_session(
    transport: &Transport,
    host: &str,
    remote_cmd: &str,
    local_port: u16,
    remote_port: u16,
    token: &str,
) -> Result<Session, LaunchError> {
    // The transport builds the right invocation: ssh with `-L` (and `--` so a host
    // beginning with `-` can't be read as an option), or `wsl.exe` with the script
    // base64-wrapped. The API also validates the host/distro up front.
    let mut child = transport
        .launch_command(remote_cmd, local_port, remote_port)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| LaunchError::Fatal(format!("failed to start the remote connection: {e}")))?;

    let stdin = child.stdin.take().unwrap(); // HOLD = lifeline
    let stdout = child.stdout.take().unwrap();

    // Drain stdout on a thread, forwarding lines until the READY line (or the child
    // dies). Keep reading even after the receiver is gone so a chatty server can't
    // block on a full stdout pipe.
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(LaunchError::Fatal(format!("timed out waiting for the remote server on {host}")));
        }
        match rx.recv_timeout(remaining.min(Duration::from_millis(500))) {
            Ok(line) if is_ready(&line) => {
                // Drain stderr for the session's lifetime too (stdout is already drained
                // by the reader thread above) so a chatty ssh can't fill a pipe and
                // wedge the tunnel.
                if let Some(mut err) = child.stderr.take() {
                    std::thread::spawn(move || {
                        let _ = std::io::copy(&mut err, &mut std::io::sink());
                    });
                }
                return Ok(Session {
                    local_port,
                    token: token.to_string(),
                    child: Arc::new(Mutex::new(child)),
                    _stdin: stdin,
                });
            }
            Ok(_) => {} // some other startup line — keep waiting for READY
            Err(mpsc::RecvTimeoutError::Timeout) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                // The child may have exited (remote bind conflict, auth failure, …).
                if let Ok(Some(_)) = child.try_wait() {
                    return Err(classify_exit(host, &read_stderr(&mut child)));
                }
            }
        }
    }
}

fn classify_exit(host: &str, stderr: &str) -> LaunchError {
    let s = stderr.trim();
    if s.contains("Address already in use") || s.contains("failed to bind") {
        LaunchError::PortConflict(s.to_string())
    } else if s.contains("Permission denied") || s.contains("publickey") {
        LaunchError::Fatal(format!(
            "authentication to {host} failed — ensure key-based SSH access (ssh-agent). ssh said: {s}"
        ))
    } else if s.is_empty() {
        LaunchError::Fatal(format!("the remote server on {host} exited before it was ready"))
    } else {
        LaunchError::Fatal(format!("remote server on {host} failed to start: {s}"))
    }
}

/// Grab an unused local port by binding `:0`, then release it for ssh to reuse.
fn free_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("could not allocate a local port: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port) // listener drops here, freeing the port
}

/// Guess a free remote loopback port. R is loopback-only on the remote, so a clash is
/// rare; `connect_flow` retries with a fresh guess if `skill-server` can't bind.
fn pick_remote_port(attempt: u32) -> u16 {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let seed = nanos ^ std::process::id().wrapping_mul(2_654_435_761) ^ attempt.wrapping_mul(40_503);
    20_000 + (seed % 40_000) as u16
}

fn is_ready(line: &str) -> bool {
    line.trim_start().starts_with("SKILL_SERVER_READY")
}

fn read_stderr(child: &mut Child) -> String {
    let mut s = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut s);
    }
    s
}

/// A per-session token (128 bits, hex). Recorded in the `running` file and injected
/// by the proxy on upstream requests — new servers launch tokenless and ignore it,
/// but reattach to an older, token-enforcing server still works.
fn new_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("getrandom failed");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The launch must persist the (pid, port, token) record so a later connect can find
    // and reattach to this exact server — and writing that record must never be able to
    // stop the server from starting.
    #[test]
    fn launch_script_records_then_execs_server() {
        let s = launch_script("0.1.4", "$HOME/.skill-studio/server/0.1.4/skill-server", 39544, "abc123");
        assert!(s.contains("/.skill-studio/server/0.1.4"), "writes under the version dir: {s}");
        assert!(s.contains("> \"$d/running\""), "persists the running record: {s}");
        assert!(s.contains("\"$$\""), "records the server's own pid via $$: {s}");
        assert!(s.contains(" abc123 > "), "token recorded for reattach compat: {s}");
        assert!(!s.contains("SKILL_STUDIO_SERVER_TOKEN"), "tokenless launch — no env token: {s}");
        assert!(s.contains("--port 39544") && s.contains("--lifeline-stdin"), "still launches the server: {s}");
        assert!(!s.contains("&&"), "record write joined with ; so it can't block the exec: {s}");
    }

    // Reattach is tunnel-only: it announces READY and holds stdin, but starts NO server.
    #[test]
    fn reattach_script_tunnels_without_launching() {
        let s = reattach_script(39544);
        assert!(s.contains("SKILL_SERVER_READY port=39544"), "satisfies the client's READY wait: {s}");
        assert!(s.contains("exec cat"), "holds stdin as the disconnect detector: {s}");
        assert!(!s.contains("skill-server"), "must not launch a second server: {s}");
    }

    // The probe only reattaches to a LIVE server of the right identity — a recycled pid
    // (now some other process) must not be mistaken for our server.
    #[test]
    fn probe_script_checks_liveness_and_identity() {
        let s = probe_script("0.1.4");
        assert!(s.contains("/.skill-studio/server/0.1.4/running"), "reads the version's record: {s}");
        assert!(s.contains("ps -p \"$pid\"") && s.contains("grep -q skill-server"), "pid alive AND is a skill-server: {s}");
        assert!(s.contains("echo \"$port $token\""), "yields port+token on a hit: {s}");
    }
}
