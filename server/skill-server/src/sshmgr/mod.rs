//! The SSH connection manager — the `RemoteControl` impl that a `skill-server`
//! exposes over `/api/remote/*`. It shells out to the system `ssh` (inheriting the
//! user's keys/config/ProxyJump), provisions a version-pinned `skill-server` on the
//! remote, launches it on a loopback port with a bearer token, and `ssh -L` tunnels
//! to it; the local server then proxies `/api/*` to that tunnel (see `proxy.rs`).
//!
//! Lives server-side so BOTH entry points get it identically: the desktop's
//! in-process server and the standalone `skill-server` binary (browser-local dev, or
//! a dev box). A *provisioned remote* server leaves `ServerConfig::remote = None`
//! (it's launched with `--lifeline-stdin`), so there's no surprise nested onward-ssh.
use std::sync::{Arc, Mutex};

use crate::{RemoteControl, RemoteHost, RemoteStatus, RemoteTarget};

mod provision;
mod session;
mod ssh;

/// Shared connection state. `generation` is bumped on every connect/disconnect so a
/// background connect thread can tell if it has been superseded (the user
/// disconnected, or started a new connect) before it stores its result.
struct State {
    status: RemoteStatus,
    target: Option<RemoteTarget>,
    session: Option<session::Session>,
    busy: bool,
    generation: u64,
}

fn idle_status() -> RemoteStatus {
    RemoteStatus { state: "idle".into(), host: None, message: None }
}

/// Update the live status during a connect, unless that connect has been superseded.
fn set_stage(state: &Mutex<State>, generation: u64, stage: &str, host: &str, msg: &str) {
    let mut s = state.lock().unwrap();
    if s.generation != generation {
        return; // a newer connect/disconnect won — don't clobber its status
    }
    s.status = RemoteStatus { state: stage.into(), host: Some(host.into()), message: Some(msg.into()) };
}

pub struct SshRemoteControl {
    state: Arc<Mutex<State>>,
    /// The version whose `skill-server-*` release asset we provision onto remotes —
    /// the desktop passes its app version (from `tauri.conf.json`, stamped from the
    /// tag); the standalone bin passes its own crate version.
    app_version: String,
}

impl SshRemoteControl {
    pub fn new(app_version: String) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                status: idle_status(),
                target: None,
                session: None,
                busy: false,
                generation: 0,
            })),
            app_version,
        }
    }

    /// Tear down any live session on app exit (no orphaned remote server / tunnel).
    pub fn shutdown(&self) {
        let _ = self.disconnect();
    }
}

impl RemoteControl for SshRemoteControl {
    fn list_hosts(&self) -> Result<Vec<RemoteHost>, String> {
        ssh::list_hosts()
    }

    fn status(&self) -> RemoteStatus {
        self.state.lock().unwrap().status.clone()
    }

    fn active_target(&self) -> Option<RemoteTarget> {
        self.state.lock().unwrap().target.clone()
    }

    fn connect(&self, host: &str) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        if s.busy {
            return Err("A connection attempt is already in progress.".into());
        }
        if s.target.is_some() {
            return Err("Already connected — disconnect first.".into());
        }
        s.busy = true;
        s.generation += 1;
        let generation = s.generation;
        s.status = RemoteStatus {
            state: "detecting".into(),
            host: Some(host.to_string()),
            message: Some("Connecting…".into()),
        };
        drop(s);

        let state = self.state.clone();
        let host = host.to_string();
        let app_version = self.app_version.clone();
        std::thread::spawn(move || session::run_connect(state, host, generation, app_version));
        Ok(())
    }

    fn disconnect(&self) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        s.generation += 1; // invalidate any in-flight connect
        s.busy = false;
        s.target = None;
        s.status = idle_status();
        let sess = s.session.take();
        drop(s);
        if let Some(mut sess) = sess {
            sess.teardown();
        }
        Ok(())
    }
}
