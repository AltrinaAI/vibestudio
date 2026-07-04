//! Loopback smoke test for the pinned-local `/api/notify*` surface. Stands up a
//! server with a capturing `NotifyControl` and checks the two boundaries that
//! matter: no notifier → 404 (the SPA's cue to use the Web Notification API),
//! and a `tailscale serve`-fronted request (forwarding headers / foreign Host)
//! → 404 even WITH a notifier — the phone's toast must not pop on this desktop.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use skill_server::{spawn, NotifyControl, ServerConfig};

/// Counts deliveries instead of showing anything.
#[derive(Default)]
struct Capture {
    shown: AtomicUsize,
    badge: AtomicUsize,
}

impl NotifyControl for Capture {
    fn notify(&self, _title: &str, _body: &str) -> Result<(), String> {
        self.shown.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn set_badge(&self, count: u32) {
        self.badge.store(count as usize, Ordering::SeqCst);
    }
}

#[test]
fn notify_routes_gate_on_notifier_and_locality() {
    // 1) No notifier (standalone/browser server) → the whole family 404s.
    let plain = spawn(ServerConfig { port: 0, startup_maintenance: false, ..Default::default() })
        .expect("plain server");
    let p = plain.addr.port();
    let r = ureq::get(&format!("http://127.0.0.1:{p}/api/notify/status")).call();
    assert!(matches!(r, Err(ureq::Error::Status(404, _))), "no notifier must 404");

    // 2) With a notifier, this machine's own webview/browser gets the surface.
    let capture = Arc::new(Capture::default());
    let server = spawn(ServerConfig {
        port: 0,
        startup_maintenance: false,
        notifier: Some(capture.clone()),
        ..Default::default()
    })
    .expect("notifier server");
    let port = server.addr.port();
    let base = format!("http://127.0.0.1:{port}");

    let status = ureq::get(&format!("{base}/api/notify/status")).call().expect("status");
    assert_eq!(status.status(), 200);
    assert!(status.into_string().unwrap_or_default().contains("true"));

    let post = ureq::post(&format!("{base}/api/notify"))
        .set("Content-Type", "application/json")
        .send_string("{\"title\":\"t\",\"body\":\"b\"}")
        .expect("notify");
    assert_eq!(post.status(), 200);
    assert_eq!(capture.shown.load(Ordering::SeqCst), 1);

    let badge = ureq::post(&format!("{base}/api/notify/badge"))
        .set("Content-Type", "application/json")
        .send_string("{\"count\":3}")
        .expect("badge");
    assert_eq!(badge.status(), 200);
    assert_eq!(capture.badge.load(Ordering::SeqCst), 3);

    // 3) The same requests fronted by tailscale serve (forwarding headers) → 404,
    //    and nothing is shown on this machine.
    let fronted = ureq::get(&format!("{base}/api/notify/status"))
        .set("X-Forwarded-Host", "machine.tailnet.ts.net")
        .call();
    assert!(matches!(fronted, Err(ureq::Error::Status(404, _))), "fronted status must 404");

    let fronted_post = ureq::post(&format!("{base}/api/notify"))
        .set("X-Forwarded-For", "100.64.0.7")
        .set("Content-Type", "application/json")
        .send_string("{\"title\":\"t\",\"body\":\"b\"}");
    assert!(matches!(fronted_post, Err(ureq::Error::Status(404, _))), "fronted notify must 404");
    assert_eq!(capture.shown.load(Ordering::SeqCst), 1, "no toast for a fronted request");

    drop((plain, server));
}
