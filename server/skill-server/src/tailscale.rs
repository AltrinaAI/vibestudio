// Thin wrapper around the user's `tailscale` CLI: detection, the machine's
// MagicDNS name, and `tailscale serve` config for fronting the local server
// over the tailnet. Everything shells out — we never speak to tailscaled
// directly, so whatever auth/consent state the CLI reports is what we surface.

use std::process::Command;
use std::sync::OnceLock;

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
        Command::new(c)
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
    Stopped,
    Missing,
}

pub fn state() -> TsState {
    let Some(b) = bin() else { return TsState::Missing };
    let Ok(out) = Command::new(b).args(["status", "--json"]).output() else {
        return TsState::Stopped;
    };
    let v: serde_json::Value = match serde_json::from_slice(&out.stdout) {
        Ok(v) => v,
        Err(_) => return TsState::Stopped,
    };
    let running = v.get("BackendState").and_then(|s| s.as_str()) == Some("Running");
    let dns = v
        .pointer("/Self/DNSName")
        .and_then(|s| s.as_str())
        .map(|s| s.trim_end_matches('.').to_string())
        .filter(|s| !s.is_empty());
    match (running, dns) {
        (true, Some(dns_name)) => TsState::Ok { dns_name },
        _ => TsState::Stopped,
    }
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
    let out = Command::new(b)
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

/// True when `tailscale serve status` shows a proxy to our loopback port.
pub fn serve_status(port: u16) -> bool {
    let Some(b) = bin() else { return false };
    Command::new(b)
        .args(["serve", "status"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("127.0.0.1:{port}")))
        .unwrap_or(false)
}

pub fn serve_off() -> Result<(), String> {
    let Some(b) = bin() else { return Err("tailscale CLI not found".into()) };
    let out = Command::new(b)
        .args(["serve", "--https=443", "off"])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
