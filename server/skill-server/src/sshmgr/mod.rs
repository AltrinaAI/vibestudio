//! The remote connection manager — the `RemoteControl` impl that a `skill-server`
//! exposes over `/api/remote/*`. It shells out to the system `ssh` (inheriting the
//! user's keys/config/ProxyJump) or, for a local WSL/WSL2 distro on Windows, to
//! `wsl.exe`; it provisions a version-pinned `skill-server` on the target, launches it
//! on a loopback port with a bearer token, and reaches it (`ssh -L` tunnel, or WSL's
//! shared loopback); the local server then proxies `/api/*` to it (see `proxy.rs`).
//!
//! Lives server-side so BOTH entry points get it identically: the desktop's
//! in-process server and the standalone `skill-server` binary (browser-local dev, or
//! a dev box). A *provisioned remote* server leaves `ServerConfig::remote = None`
//! (it's launched with `--lifeline-stdin`), so there's no surprise nested onward-ssh.
use std::sync::{Arc, Mutex};

use crate::{RemoteControl, RemoteHost, RemoteStatus, RemoteTarget};

// The transport seam (Remote/SessionHandle): both the ssh/wsl shell-out and russh plug in
// here, so one connect orchestration drives both.
mod conn;
mod lastconn;
mod provision;
// Pure-Rust SSH transport for the mobile switchboard (iOS can't spawn `ssh`). Desktop
// keeps `ssh.rs`; these compile only under the `russh-transport` feature.
#[cfg(feature = "russh-transport")]
pub mod keygen;
#[cfg(feature = "russh-transport")]
mod russh_tx;
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
    /// The host to auto-reconnect to on launch — loaded from disk at startup, updated
    /// on a successful connect, cleared on an explicit disconnect. The client reads it
    /// (`/api/remote/last`) and drives the resume through the normal connect path.
    last_host: Option<String>,
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
                last_host: lastconn::load(),
            })),
            app_version,
        }
    }

    /// Tear down any live session on app exit (no orphaned remote server / tunnel).
    /// `forget=false`: keep the remembered host so the next launch resumes it.
    pub fn shutdown(&self) {
        let _ = self.disconnect(false);
    }
}

impl RemoteControl for SshRemoteControl {
    fn list_hosts(&self) -> Result<Vec<RemoteHost>, String> {
        ssh::list_targets()
    }

    fn status(&self) -> RemoteStatus {
        self.state.lock().unwrap().status.clone()
    }

    fn active_target(&self) -> Option<RemoteTarget> {
        self.state.lock().unwrap().target.clone()
    }

    fn last_host(&self) -> Option<String> {
        self.state.lock().unwrap().last_host.clone()
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

    fn disconnect(&self, forget: bool) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        // Bump the generation BEFORE clearing: this same lock both supersedes any
        // in-flight connect (so it won't re-persist the host) and clears last_host,
        // closing the race where a connect finishing mid-disconnect resurrects it.
        s.generation += 1;
        s.busy = false;
        s.target = None;
        if forget {
            s.last_host = None;
        }
        s.status = idle_status();
        let sess = s.session.take();
        drop(s);
        if forget {
            lastconn::forget();
        }
        if let Some(mut sess) = sess {
            sess.teardown();
        }
        Ok(())
    }
}
