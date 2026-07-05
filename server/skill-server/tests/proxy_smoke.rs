//! Loopback smoke test for the Remote-SSH reverse proxy — no SSH required. Stands up
//! a token-guarded "remote" server, points a local switchboard at it via a fixed
//! `RemoteControl`, and checks that `/api/*` is proxied with the bearer injected,
//! that `/api/remote/*` stays local, and that the remote rejects an un-tokened hit.
use std::sync::Arc;

use skill_server::{spawn, RemoteControl, RemoteHost, RemoteStatus, RemoteTarget, ServerConfig};

/// A `RemoteControl` that reports a fixed, always-connected target (the stand-in
/// "remote"), so the switchboard proxies to it without any real SSH session.
struct FixedRemote(RemoteTarget);

impl RemoteControl for FixedRemote {
    fn list_hosts(&self) -> Result<Vec<RemoteHost>, String> {
        Ok(vec![])
    }
    fn connect(&self, _host: &str) -> Result<(), String> {
        Ok(())
    }
    fn disconnect(&self, _forget: bool) -> Result<(), String> {
        Ok(())
    }
    fn status(&self) -> RemoteStatus {
        RemoteStatus { state: "connected".into(), host: Some("loopback".into()), message: None }
    }
    fn active_target(&self) -> Option<RemoteTarget> {
        Some(self.0.clone())
    }
}

fn base(port: u16) -> ServerConfig {
    ServerConfig { port, startup_maintenance: false, ..Default::default() }
}

#[test]
fn proxies_api_with_injected_token() {
    // 1) A token-guarded "remote" server.
    let remote = spawn(ServerConfig { token: Some("SECRET".into()), ..base(0) }).expect("remote");
    let rport = remote.addr.port();

    // 2) A local switchboard pointing at it (token injected by the proxy, not the UI).
    let target = RemoteTarget { base_url: format!("http://127.0.0.1:{rport}"), token: "SECRET".into() };
    let local = spawn(ServerConfig { remote: Some(Arc::new(FixedRemote(target))), ..base(0) }).expect("local");
    let lport = local.addr.port();

    // A GET is proxied to the remote with the bearer injected → 200.
    let get = ureq::get(&format!("http://127.0.0.1:{lport}/api/secrets/status")).call().expect("proxied GET");
    assert_eq!(get.status(), 200, "GET /api/secrets/status should proxy to the remote");

    // A POST (with a JSON body) is proxied too → 200.
    let post = ureq::post(&format!("http://127.0.0.1:{lport}/api/git/dirty-many"))
        .set("Content-Type", "application/json")
        .send_string("{\"roots\":[]}")
        .expect("proxied POST");
    assert_eq!(post.status(), 200, "POST /api/git/dirty-many should proxy to the remote");

    // The connection manager itself is handled LOCALLY (never proxied) → 200.
    let status = ureq::get(&format!("http://127.0.0.1:{lport}/api/remote/status")).call().expect("local remote/status");
    assert_eq!(status.status(), 200, "/api/remote/* must be served locally even while connected");

    // Hitting the remote directly WITHOUT the token → 401, proving the proxy is what
    // injects it on the path above.
    let direct = ureq::get(&format!("http://127.0.0.1:{rport}/api/secrets/status")).call();
    assert!(matches!(direct, Err(ureq::Error::Status(401, _))), "remote must reject an un-tokened request");

    drop((remote, local));
}
