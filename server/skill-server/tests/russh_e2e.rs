//! End-to-end proof that the WHOLE switchboard works over russh — not just the transport
//! primitives (those are covered in `sshmgr::russh_tx`), but the real connect orchestration:
//! detect (uname over russh) → provision (reuse the pre-placed binary) → launch the server on
//! the remote → russh `-L` forward → the remote server answers HTTP through the tunnel.
//!
//! Opt-in (needs a live sshd + a pre-placed `skill-server`), so `cargo test` in CI is a no-op.
//! Driven by the harness documented in the Mac handoff; in short:
//!   cargo build -p skill-server
//!   cp target/debug/skill-server ~/.vibestudio/server/e2e-test/skill-server
//!   RUSSH_E2E=1 RUSSH_IT_HOST=127.0.0.1 RUSSH_IT_PORT=2222 RUSSH_IT_USER=$USER \
//!     RUSSH_IT_KEY=<key> cargo test -p skill-server --features russh-transport --test russh_e2e -- --nocapture
#![cfg(feature = "russh-transport")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use skill_server::{RemoteControl, SshRemoteControl};

/// Must match the version dir the harness places the binary under.
const VERSION: &str = "e2e-test";

fn env() -> Option<(String, String, String, String)> {
    if std::env::var("RUSSH_E2E").ok().as_deref() != Some("1") {
        return None;
    }
    Some((
        std::env::var("RUSSH_IT_HOST").ok()?,
        std::env::var("RUSSH_IT_PORT").ok()?,
        std::env::var("RUSSH_IT_USER").ok()?,
        std::env::var("RUSSH_IT_KEY").ok()?,
    ))
}

#[test]
fn full_switchboard_over_russh() {
    let Some((host, port, user, key)) = env() else {
        eprintln!("skipping: set RUSSH_E2E=1 + RUSSH_IT_HOST/PORT/USER/KEY (see the handoff)");
        return;
    };

    // Force the russh transport (creds_for reads these); this is exactly what the mobile
    // switchboard does, minus the stored-profile lookup.
    std::env::set_var("VIBESTUDIO_RUSSH", "1");
    std::env::set_var("VIBESTUDIO_RUSSH_KEY", &key);

    let ctrl = SshRemoteControl::new(VERSION.to_string());
    let target = format!("{user}@{host}:{port}");
    ctrl.connect(&target).expect("connect kickoff");

    // Poll the async connect to a terminal state.
    let deadline = Instant::now() + Duration::from_secs(60);
    let base = loop {
        let st = ctrl.status();
        match st.state.as_str() {
            "connected" => break ctrl.active_target().expect("target when connected").base_url,
            "error" => panic!("connect failed: {:?}", st.message),
            _ if Instant::now() >= deadline => panic!("timed out in state {:?}: {:?}", st.state, st.message),
            _ => std::thread::sleep(Duration::from_millis(300)),
        }
    };

    // base_url is the forwarded local port → hit the REMOTE server's /api/health through the
    // russh tunnel. The returned pid is the launched remote server's, proving we reached it
    // (not something local).
    let body = http_get(&base, "/api/health").expect("GET /api/health through the tunnel");
    assert!(body.contains("\"version\""), "health via tunnel missing version: {body}");
    assert!(body.contains("\"pid\""), "health via tunnel missing pid: {body}");

    ctrl.disconnect(true).expect("disconnect");
}

/// Minimal HTTP/1.1 GET so the test needs no HTTP dependency. `base` is `http://127.0.0.1:PORT`.
fn http_get(base: &str, path: &str) -> Result<String, String> {
    let addr = base.strip_prefix("http://").ok_or("base is not http://")?;
    let mut stream = TcpStream::connect(addr).map_err(|e| format!("connect {addr}: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n")
        .map_err(|e| e.to_string())?;
    let mut resp = String::new();
    stream.read_to_string(&mut resp).map_err(|e| e.to_string())?;
    let status = resp.lines().next().unwrap_or("");
    if !status.contains(" 200 ") {
        return Err(format!("non-200 through tunnel: {status:?}"));
    }
    Ok(resp)
}
