// Thin wrapper around the user's `tailscale` CLI: detection, the machine's
// MagicDNS name, and `tailscale serve` config for fronting the local server
// over the tailnet. Everything shells out — we never speak to tailscaled
// directly, so whatever auth/consent state the CLI reports is what we surface.

use skill_core::process::hidden_command;
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::{mpsc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

/// Where the CLI might live. GUI installs on macOS don't put it on PATH.
const CANDIDATES: &[&str] = &[
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

fn bin() -> Option<&'static str> {
    // Cache only success: while missing we re-probe, so the modal's "Check
    // again" works right after the user installs Tailscale (no app restart).
    static BIN: OnceLock<&'static str> = OnceLock::new();
    if let Some(b) = BIN.get() {
        return Some(b);
    }
    let found = CANDIDATES.iter().copied().find(|c| {
        hidden_command(c)
            .arg("version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })?;
    Some(BIN.get_or_init(|| found))
}

pub enum TsState {
    /// Running; `dns_name` is the machine's MagicDNS name (no trailing dot).
    Ok { dns_name: String },
    /// Installed but signed out / never logged in — no tailnet identity yet.
    /// Distinct from `Stopped` so the UI can offer sign-in, not `tailscale up`.
    NeedsLogin,
    /// Installed and signed in, but the backend isn't up.
    Stopped,
    Missing,
}

pub fn state() -> TsState {
    let Some(b) = bin() else { return TsState::Missing };
    let Ok(out) = hidden_command(b).args(["status", "--json"]).output() else {
        return TsState::Stopped;
    };
    match serde_json::from_slice::<serde_json::Value>(&out.stdout) {
        Ok(v) => parse_status(&v),
        Err(_) => TsState::Stopped,
    }
}

/// Pure classifier over `tailscale status --json` — split out so the mapping
/// (esp. signed-out vs. merely-stopped) is unit-testable without the CLI.
fn parse_status(v: &serde_json::Value) -> TsState {
    let backend = v.get("BackendState").and_then(|s| s.as_str()).unwrap_or("");
    let dns = v
        .pointer("/Self/DNSName")
        .and_then(|s| s.as_str())
        .map(|s| s.trim_end_matches('.').to_string())
        .filter(|s| !s.is_empty());
    match backend {
        // Up but nameless is not yet ready to serve — treat as stopped.
        "Running" => dns.map_or(TsState::Stopped, |dns_name| TsState::Ok { dns_name }),
        // Pre-login zero value, or an explicit signed-out state.
        "NeedsLogin" | "NoState" => TsState::NeedsLogin,
        // "Stopped" / "Starting" / "NeedsMachineAuth" / … — known, just not up;
        // the fix is `tailscale up`, not a fresh sign-in.
        _ => TsState::Stopped,
    }
}

/// Result of `tailscale up` (sign in and/or bring the backend up).
pub enum UpResult {
    /// Interactive sign-in needed; open this URL to authenticate. The CLI keeps
    /// running in the background and completes once the browser step is done.
    LoginUrl(String),
    /// Came up (or is on its way up) without needing an interactive login.
    Started,
    /// Couldn't run the CLI at all.
    Error(String),
}

/// `tailscale up` — sign in and/or bring the tailnet up. When a login is required
/// the CLI prints a `login.tailscale.com` URL and then blocks on the browser step;
/// we scrape that URL (waiting a few seconds) and hand it back for the UI to open,
/// leaving the child to finish on its own. A reaper thread waits on it so a still-
/// blocked `up` never lingers as a zombie.
pub fn up() -> UpResult {
    let Some(b) = bin() else {
        return UpResult::Error("tailscale CLI not found".into());
    };
    let mut child = match hidden_command(b)
        .arg("up")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return UpResult::Error(e.to_string()),
    };
    // Drain BOTH pipes into one line channel: the auth URL has landed on either
    // stream across CLI versions, and draining keeps the child off a full pipe
    // while it waits for the login.
    let (tx, rx) = mpsc::channel::<String>();
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        while let Ok(line) = rx.try_recv() {
            if let Some(url) = login_url(&line) {
                reap(child);
                return UpResult::LoginUrl(url);
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                // Exited before the timeout: drain any last line for a URL, else
                // success ⇒ it came up, failure ⇒ report we couldn't sign in.
                while let Ok(line) = rx.try_recv() {
                    if let Some(url) = login_url(&line) {
                        return UpResult::LoginUrl(url);
                    }
                }
                return if status.success() {
                    UpResult::Started
                } else {
                    UpResult::Error(
                        "Tailscale sign-in didn't complete — try signing in from the Tailscale app.".into(),
                    )
                };
            }
            Ok(None) => {}
            Err(e) => return UpResult::Error(e.to_string()),
        }
        if Instant::now() >= deadline {
            // Still running, no URL — it's bringing an already-signed-in backend
            // up. Let it finish; the modal's "Check again" will see it.
            reap(child);
            return UpResult::Started;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn login_url(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|w| w.starts_with("https://login.tailscale.com/"))
        .map(|w| w.trim_end_matches(['.', ',']).to_string())
}

/// Wait on a child in the background so a still-running `tailscale up` (blocked on
/// the browser login) doesn't become a zombie once it finally exits.
fn reap(mut child: Child) {
    thread::spawn(move || {
        let _ = child.wait();
    });
}

pub enum ServeError {
    /// Linux non-root needs a one-time operator grant.
    NeedsOperator { command: String },
    /// The tailnet hasn't approved the serve/certs feature yet.
    NeedsConsent { url: String },
    Other(String),
}

/// `tailscale serve --bg <port>` — maps https://<dns_name>/ → 127.0.0.1:<port>.
/// The config persists in tailscaled across reboots.
pub fn serve_on(port: u16) -> Result<(), ServeError> {
    let Some(b) = bin() else {
        return Err(ServeError::Other("tailscale CLI not found".into()));
    };
    let out = hidden_command(b)
        .args(["serve", "--bg", &port.to_string()])
        .output()
        .map_err(|e| ServeError::Other(e.to_string()))?;
    if out.status.success() {
        return Ok(());
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if text.contains("Access denied") || text.contains("--operator") {
        return Err(ServeError::NeedsOperator {
            command: "sudo tailscale set --operator=$USER".into(),
        });
    }
    if text.contains("not enabled on your tailnet") || text.contains("Serve is not enabled") {
        // The CLI prints an approval short-link; fall back to the admin DNS page
        // (same consent) when it doesn't.
        let url = text
            .split_whitespace()
            .find(|w| w.starts_with("https://login.tailscale.com/"))
            .unwrap_or("https://login.tailscale.com/admin/dns")
            .trim_end_matches(['.', ','])
            .to_string();
        return Err(ServeError::NeedsConsent { url });
    }
    Err(ServeError::Other(text.trim().to_string()))
}

/// The loopback port the live `tailscale serve` config proxies `/` to, if any.
/// `serve status` maps the root to `http://127.0.0.1:<port>`; startup reads this
/// to spot a mapping left pointing at a previous boot's port (see resync_on_start).
pub fn served_loopback_port() -> Option<u16> {
    let b = bin()?;
    let out = hidden_command(b).args(["serve", "status"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let after = text.split_once("127.0.0.1:")?.1;
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// True when the live serve config proxies to our loopback port specifically —
/// not a mapping left behind for some other (e.g. a prior ephemeral) port.
pub fn serve_status(port: u16) -> bool {
    served_loopback_port() == Some(port)
}

pub fn serve_off() -> Result<(), String> {
    let Some(b) = bin() else { return Err("tailscale CLI not found".into()) };
    let out = hidden_command(b)
        .args(["serve", "--https=443", "off"])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_status_classifies_backend_states() {
        // Running + a MagicDNS name → Ok, trailing dot trimmed.
        match parse_status(&json!({"BackendState": "Running", "Self": {"DNSName": "box.tail1.ts.net."}})) {
            TsState::Ok { dns_name } => assert_eq!(dns_name, "box.tail1.ts.net"),
            _ => panic!("expected Ok"),
        }
        // Signed out / never logged in → NeedsLogin (distinct from Stopped).
        assert!(matches!(parse_status(&json!({"BackendState": "NeedsLogin"})), TsState::NeedsLogin));
        assert!(matches!(parse_status(&json!({"BackendState": "NoState"})), TsState::NeedsLogin));
        // Signed in but backend down → Stopped.
        assert!(matches!(parse_status(&json!({"BackendState": "Stopped"})), TsState::Stopped));
        // Running but nameless yet → not ready → Stopped.
        assert!(matches!(
            parse_status(&json!({"BackendState": "Running", "Self": {"DNSName": ""}})),
            TsState::Stopped
        ));
        // Missing field → Stopped, never a panic.
        assert!(matches!(parse_status(&json!({})), TsState::Stopped));
    }

    #[test]
    fn login_url_extracted_from_cli_line() {
        assert_eq!(
            login_url("To authenticate, visit: https://login.tailscale.com/a/abc123 ."),
            Some("https://login.tailscale.com/a/abc123".to_string())
        );
        assert_eq!(login_url("Success."), None);
    }
}
