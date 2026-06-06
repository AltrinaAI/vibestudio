//! The SSH session lifecycle. A SINGLE `ssh` child both launches the remote server
//! (holding its stdin as a lifeline) and forwards a local port to it
//! (`-L L:127.0.0.1:R`). The client chooses R, sidestepping the "`-L` needs the port
//! before the server picks it" chicken-and-egg, and retries on a port collision. One
//! child ⇒ one auth; killing it — or the desktop dying, which closes the held stdin
//! pipe — EOFs the remote server's stdin so it self-exits (no orphan), and the
//! forward dies with the same process.
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::{RemoteStatus, RemoteTarget};

use super::{provision, set_stage, State};

const COMMON_OPTS: &[&str] = &[
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    // accept-new = trust-on-first-use: a host not yet in known_hosts is auto-pinned
    // (no prompt under BatchMode), but a CHANGED key is still rejected. Intentional —
    // matches VS Code Remote-SSH's first-contact behaviour; hosts you've ssh'd to
    // before are already pinned in your known_hosts and get full strict checking.
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
];

/// A live connection: the `ssh` child (lifeline + tunnel) and the forwarded local port.
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
    let result = connect_flow(&state, &host, generation, &app_version);
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
            drop(s);
            // Watch the ssh child: if it dies (network loss, remote crash), clear the
            // session so the UI falls back to Local instead of proxying a dead tunnel.
            spawn_monitor(state.clone(), generation, host, child);
        }
        Err(e) => {
            s.target = None;
            s.session = None;
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

fn connect_flow(state: &Arc<Mutex<State>>, host: &str, generation: u64, app_version: &str) -> Result<Session, String> {
    set_stage(state, generation, "detecting", host, "Detecting the remote platform…");
    let platform = provision::detect(host)?;

    set_stage(state, generation, "installing", host, "Installing skill-server on the remote…");
    let bin = provision::ensure_installed(host, &platform, app_version)?;

    set_stage(state, generation, "launching", host, "Starting the remote server…");
    let token = new_token();
    let mut last_err = String::new();
    // A few attempts to dodge a remote/local port collision (R is client-chosen).
    for attempt in 0..4u32 {
        match launch(host, &bin, &token, attempt) {
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

fn launch(host: &str, bin: &str, token: &str, attempt: u32) -> Result<Session, LaunchError> {
    let local_port = free_local_port().map_err(LaunchError::Fatal)?;
    let remote_port = pick_remote_port(attempt);
    // The token is delivered via an ENV VAR (not argv) so it never appears in the
    // remote process's world-readable command line (/proc/<pid>/cmdline) — other
    // users on a shared remote host can't read it from the process table. `bin` is
    // remote-$HOME-expanded; `remote_port` is numeric; `token` is hex — all shell-safe.
    let remote_cmd = format!(
        "SKILL_STUDIO_SERVER_TOKEN={token} exec \"{bin}\" --host 127.0.0.1 --port {remote_port} --lifeline-stdin"
    );

    // `--` ends ssh option parsing so a host that begins with `-` can never be read as
    // an option (e.g. -oProxyCommand=…). The API also validates the host up front.
    let mut child = Command::new("ssh")
        .args(COMMON_OPTS)
        .arg("-L")
        .arg(format!("{local_port}:127.0.0.1:{remote_port}"))
        .arg("--")
        .arg(host)
        .arg(&remote_cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| LaunchError::Fatal(format!("failed to run ssh: {e} (is OpenSSH installed?)")))?;

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

/// A per-session bearer token (128 bits, hex). The proxy injects it on upstream
/// requests; it never reaches the browser, and it's delivered to the remote via an
/// env var (not argv) so it stays off the process table. Guards the loopback-bound
/// remote server against other users on a shared remote host.
fn new_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("getrandom failed");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
