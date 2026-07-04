// "Open on your phone": front THIS server with `tailscale serve` and hand the
// UI a QR for the HTTPS tailnet URL. There is no separate daemon — the serving
// process is whoever answers /api/phone/*: the desktop app's in-process server
// (tray-resident; quitting the tray ends phone access with everything else) or
// a standalone `skill-server`.

use std::sync::atomic::{AtomicU16, Ordering};

use serde_json::{json, Value};

use crate::tailscale;

/// The port the desktop binds by preference, so the `tailscale serve` mapping
/// (which persists in tailscaled across restarts) finds the app again on the
/// next launch. Not load-bearing for correctness: enable() always maps
/// whatever port we actually bound.
pub const PHONE_PORT: u16 = 8765;

pub struct PhoneControl {
    /// Our actual bound port — set right after spawn (0 until then).
    port: AtomicU16,
    /// Shown in the modal ("Served by Skill Studio vX.Y.Z…").
    pub version: String,
}

fn qr_svg(url: &str) -> Option<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(url.as_bytes()).ok()?;
    Some(
        code.render::<svg::Color>()
            .min_dimensions(180, 180)
            .quiet_zone(true)
            .build(),
    )
}

impl PhoneControl {
    pub fn new(version: String) -> Self {
        Self { port: AtomicU16::new(0), version }
    }

    /// Record the port the server actually bound (ephemeral fallback included).
    pub fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::Relaxed);
    }

    fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    /// Current state for the UI. Never mutates anything.
    pub fn status(&self) -> Value {
        let (ts, dns) = match tailscale::state() {
            tailscale::TsState::Ok { dns_name } => ("ok", Some(dns_name)),
            tailscale::TsState::Stopped => ("stopped", None),
            tailscale::TsState::Missing => ("missing", None),
        };
        // Serving means the persisted mapping targets *us* — a mapping left
        // behind for some other port (a previous ephemeral bind) doesn't count.
        let serving = ts == "ok" && tailscale::serve_status(self.port());
        let url = match (&dns, serving) {
            (Some(d), true) => Some(format!("https://{d}")),
            _ => None,
        };
        json!({
            "tailscale": ts,
            "serving": serving,
            "server": { "version": self.version, "port": self.port() },
            "url": url,
            "qrSvg": url.as_deref().and_then(qr_svg),
        })
    }

    pub fn enable(&self) -> Value {
        let dns = match tailscale::state() {
            tailscale::TsState::Ok { dns_name } => dns_name,
            tailscale::TsState::Missing => {
                return json!({"ok": false, "stage": "tailscale",
                    "message": "Tailscale isn't installed on this machine."});
            }
            tailscale::TsState::Stopped => {
                return json!({"ok": false, "stage": "tailscale",
                    "message": "Tailscale is installed but not running. Start it (`tailscale up`) and retry."});
            }
        };
        match tailscale::serve_on(self.port()) {
            Ok(()) => {}
            Err(tailscale::ServeError::NeedsOperator { command }) => {
                return json!({"ok": false, "stage": "operator",
                    "message": "Tailscale needs a one-time permission to let this app configure serving.",
                    "command": command});
            }
            Err(tailscale::ServeError::NeedsConsent { url }) => {
                return json!({"ok": false, "stage": "consent",
                    "message": "Your Tailscale network needs HTTPS enabled once (free).",
                    "consentUrl": url});
            }
            Err(tailscale::ServeError::Other(m)) => {
                return json!({"ok": false, "stage": "serve", "message": m});
            }
        }
        let mut v = self.status();
        // serve_status can lag right after enabling; trust what we just did.
        let url = format!("https://{dns}");
        v["serving"] = json!(true);
        v["qrSvg"] = json!(qr_svg(&url));
        v["url"] = json!(url);
        v["ok"] = json!(true);
        v
    }

    pub fn disable(&self) -> Value {
        match tailscale::serve_off() {
            Ok(()) => json!({"ok": true}),
            Err(m) => json!({"ok": false, "stage": "serve", "message": m}),
        }
    }
}
