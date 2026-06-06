//! Thin wrappers over the system `ssh`, plus `~/.ssh/config` discovery. Shelling out
//! to the user's own ssh inherits their keys, config, and ProxyJump — "any host you
//! can already ssh to" comes free. Auth is key-based (`BatchMode=yes`): a host that
//! needs an interactive password fails fast with a hint rather than hanging the GUI.
use std::io::{Read, Write};
use std::process::{Command, Stdio};

use crate::RemoteHost;

const COMMON_OPTS: &[&str] = &[
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-o", "StrictHostKeyChecking=accept-new",
];

pub struct RunError {
    /// The remote command's exit code, when the failure was a non-zero exit (vs. ssh
    /// itself failing to run). Provisioning uses code `3` to signal "no downloader".
    pub code: Option<i32>,
    pub message: String,
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Run a remote command and return its stdout. Err carries the exit code plus a
/// friendly hint derived from stderr.
pub fn run(host: &str, remote_cmd: &str) -> Result<String, RunError> {
    let out = Command::new("ssh")
        .args(COMMON_OPTS)
        .arg("--") // end option parsing: a host can never be read as an ssh flag
        .arg(host)
        .arg(remote_cmd)
        .output()
        .map_err(|e| RunError { code: None, message: format!("failed to run ssh: {e} (is OpenSSH installed?)") })?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(RunError { code: out.status.code(), message: hint(host, &String::from_utf8_lossy(&out.stderr)) })
    }
}

/// Like [`run`], but maps any failure to a plain message (detection paths where the
/// exit code is irrelevant).
pub fn capture(host: &str, remote_cmd: &str) -> Result<String, String> {
    run(host, remote_cmd).map_err(|e| e.message)
}

/// Run a remote command feeding it `stdin` bytes (used to pipe a downloaded binary to
/// `cat > …` on a no-internet remote). Drains stdout/stderr on their own threads while
/// writing, so a chatty remote (e.g. a verbose shell rc) can't fill a pipe and deadlock
/// the multi-MB write; then closes stdin so the remote `cat` sees EOF.
pub fn run_with_stdin(host: &str, remote_cmd: &str, stdin: &[u8]) -> Result<(), RunError> {
    let mut child = Command::new("ssh")
        .args(COMMON_OPTS)
        .arg("--")
        .arg(host)
        .arg(remote_cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| RunError { code: None, message: format!("failed to run ssh: {e}") })?;

    let mut sin = child.stdin.take().unwrap();
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    // Concurrent drains so the write below never blocks on a full output pipe.
    let out_t = std::thread::spawn(move || {
        let _ = std::io::copy(&mut out, &mut std::io::sink());
    });
    let err_t = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = err.read_to_end(&mut s);
        s
    });

    let write_res = sin.write_all(stdin);
    drop(sin); // EOF → the remote `cat` finishes and the command exits
    let _ = out_t.join();
    let err_bytes = err_t.join().unwrap_or_default();
    let status = child.wait().map_err(|e| RunError { code: None, message: e.to_string() })?;

    if let Err(e) = write_res {
        return Err(RunError { code: None, message: format!("writing to ssh failed: {e}") });
    }
    if status.success() {
        Ok(())
    } else {
        Err(RunError { code: status.code(), message: hint(host, &String::from_utf8_lossy(&err_bytes)) })
    }
}

/// List `Host` aliases from `~/.ssh/config` (skipping wildcard patterns). These are
/// exactly the names you can `ssh <name>`; the UI also accepts free-form `user@host`.
pub fn list_hosts() -> Result<Vec<RemoteHost>, String> {
    let mut hosts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let Some(home) = dirs::home_dir() else { return Ok(hosts) };
    let Ok(text) = std::fs::read_to_string(home.join(".ssh").join("config")) else {
        return Ok(hosts); // no config = no aliases; free-form entry still works
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(kw) = parts.next() else { continue };
        if !kw.eq_ignore_ascii_case("host") {
            continue;
        }
        for alias in parts {
            // Skip pattern entries (`Host *`, negations) — they aren't connectable names.
            if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                continue;
            }
            if seen.insert(alias.to_string()) {
                hosts.push(RemoteHost { name: alias.to_string(), detail: None });
            }
        }
    }
    Ok(hosts)
}

/// Turn ssh's stderr into an actionable message.
fn hint(host: &str, stderr: &str) -> String {
    let s = stderr.trim();
    if s.contains("Permission denied") || s.contains("publickey") {
        format!("authentication to {host} failed — ensure key-based SSH access (e.g. your key is loaded in ssh-agent). ssh said: {s}")
    } else if s.contains("Could not resolve") || s.contains("Name or service not known") {
        format!("could not resolve host {host}. ssh said: {s}")
    } else if s.contains("Connection refused") || s.contains("timed out") || s.contains("Operation timed out") {
        format!("could not connect to {host}. ssh said: {s}")
    } else if s.is_empty() {
        format!("ssh to {host} failed")
    } else {
        format!("ssh to {host}: {s}")
    }
}
