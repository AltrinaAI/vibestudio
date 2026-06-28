// Tauri desktop shell — a thin CLIENT. It brings up `skill-server` in-process on
// a loopback port and points the webview at it, so the desktop runs the EXACT
// same HTTP path as a browser or a remote host. There are no `#[tauri::command]`s:
// every capability is reached over `/api` (see `server/skill-server`). The shell's
// only jobs are: host the window, seed the bundled-engine path, own the engine +
// terminal lifecycle (the in-process server runs with `startup_maintenance:false`,
// so these fire exactly once), and reap on exit.
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

use skill_core::engine;
use skill_server::{init_logging, init_logging_to_file, ServerConfig, SshRemoteControl};

/// Locate the bundled `llama-server` so the on-device commit-message generator
/// runs with zero setup. Checks the production bundle (resource dir) then the
/// dev-vendored tree (`client/desktop/binaries/<triple>/`, populated by
/// `scripts/fetch-engine.sh`). Returns the first match.
fn find_bundled_engine(app: &tauri::App) -> Option<std::path::PathBuf> {
    let exe = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    let look = |base: std::path::PathBuf| -> Option<std::path::PathBuf> {
        // base/<triple>/<exe> (one platform subdir), or base/<exe> directly.
        if let Ok(entries) = std::fs::read_dir(&base) {
            for e in entries.flatten() {
                let c = e.path().join(exe);
                if c.is_file() {
                    return Some(c);
                }
            }
        }
        let direct = base.join(exe);
        direct.is_file().then_some(direct)
    };
    let resource = app.path().resource_dir().ok().map(|r| r.join("binaries"));
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    // Release: the bundled resource copy. Dev: the repo SOURCE first — Tauri re-copies
    // `binaries` into the target resource dir on rebuilds, and running the warm engine
    // from the source (not the copy) keeps that copy free to overwrite (else ETXTBSY).
    let order: Vec<std::path::PathBuf> = if cfg!(debug_assertions) {
        std::iter::once(source).chain(resource).collect()
    } else {
        resource.into_iter().chain(std::iter::once(source)).collect()
    };
    order.into_iter().find_map(look)
}

/// The shell's half of `skill_core::update`: the server module owns the
/// `/api/update/*` surface and the version check; only this process can replace
/// its own binary, so download/install runs here via `tauri-plugin-updater`.
struct ShellUpdater {
    app: tauri::AppHandle,
    remote_slot: std::sync::Arc<std::sync::OnceLock<std::sync::Arc<SshRemoteControl>>>,
}

impl skill_core::update::UpdateControl for ShellUpdater {
    fn can_install(&self) -> bool {
        // The plugin installs every target we ship (dmg-app, NSIS, deb/AppImage);
        // failures surface via report_error and the UI offers a manual download.
        true
    }

    fn begin_install(&self) {
        let app = self.app.clone();
        let remote_slot = self.remote_slot.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(msg) = install_update(app, remote_slot).await {
                skill_core::update::report_error(msg);
            }
        });
    }
}

/// Download → install → relaunch. On Windows the plugin hands off to the NSIS
/// installer and exits this process itself — `RunEvent::Exit` never fires — so
/// `on_before_exit` must repeat the Exit handler's teardown. macOS/Linux installs
/// return, and we restart explicitly.
async fn install_update(
    app: tauri::AppHandle,
    remote_slot: std::sync::Arc<std::sync::OnceLock<std::sync::Arc<SshRemoteControl>>>,
) -> Result<(), String> {
    let updater = app
        .updater_builder()
        .on_before_exit(move || {
            if let Some(r) = remote_slot.get() {
                r.shutdown();
            }
            engine::shutdown();
        })
        .build()
        .map_err(|e| format!("The updater could not start: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Couldn't check for the update: {e}"))?
        .ok_or_else(|| "The update is no longer available.".to_string())?;
    let mut received: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                received += chunk as u64;
                let pct = total.filter(|t| *t > 0).map(|t| (received * 100 / t).min(100) as u8);
                skill_core::update::report_progress(pct);
            },
            || skill_core::update::report_ready(),
        )
        .await
        .map_err(|e| format!("Couldn't install the update: {e}"))?;
    app.restart() // macOS/Linux: relaunch into the new build (Windows exited above)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The SSH connection manager is created in `setup` (it needs the app version to
    // provision the matching remote `skill-server`); this slot hands it to the exit
    // handler so a live session is torn down on quit (no orphaned remote/tunnel).
    let remote_slot: std::sync::Arc<std::sync::OnceLock<std::sync::Arc<SshRemoteControl>>> =
        std::sync::Arc::new(std::sync::OnceLock::new());
    let remote_slot_setup = remote_slot.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build()) // self-update; driven from ShellUpdater, no JS API
        .setup(move |app| {
            // Logger first, so even early startup is captured. Tee to a small on-disk
            // file (durable for the packaged app, where stderr goes nowhere) + stderr
            // (so `npm run dev` still shows logs). The in-process server shares this
            // process, so its `log::*` records land here too. RUST_LOG-gated; quiet by
            // default. Frontend warns/errors arrive via POST /api/client-log.
            let log_path = app.path().app_log_dir().ok().map(|d| d.join("skill-studio.log"));
            match &log_path {
                Some(p) => init_logging_to_file(p),
                None => init_logging(),
            }
            if let Some(p) = &log_path {
                log::info!("on-disk log: {}", p.display());
            }

            // ── lifecycle this process owns (the in-process server is spawned with
            //    startup_maintenance:false, so these run exactly once) ──
            skill_term::sweep_stale(); // GC terminals whose agent finished long ago (live ones persist)
            // Point the on-device generator at the bundled/vendored llama-server so
            // it works with no config; an explicit env override still wins. The
            // in-process server shares this process, so it sees the env var.
            if std::env::var_os("SKILL_STUDIO_LLAMA_SERVER").is_none() {
                if let Some(p) = find_bundled_engine(app) {
                    std::env::set_var("SKILL_STUDIO_LLAMA_SERVER", p);
                }
            }
            engine::reap_orphans(); // kill any engine orphaned by a previous hard-kill
            engine::prefetch_model(); // start the one-time model download now, not on first Generate

            // SSH connection manager: provisions the release-matching `skill-server`
            // onto remotes, so it needs the app version (from tauri.conf.json).
            let remote = std::sync::Arc::new(SshRemoteControl::new(
                app.package_info().version.to_string(),
            ));
            let _ = remote_slot_setup.set(remote.clone());

            // ── bring up the loopback backend and point the webview at it ──
            let resource_dir = app.path().resource_dir().ok();
            let dist = resource_dir
                .clone()
                .map(|r| r.join("dist"))
                .unwrap_or_else(|| std::path::PathBuf::from("dist"));
            let cfg = ServerConfig {
                host: "127.0.0.1".into(),
                // Dev: fixed 8765 so Vite's existing /api proxy target matches.
                // Prod: an ephemeral port, read back from the handle.
                port: if tauri::is_dev() { 8765 } else { 0 },
                dist,
                bundled_skills: resource_dir.clone().map(|r| r.join("skills")),
                examples_base: resource_dir, // resolve bundled examples by relative path
                startup_maintenance: false,
                // Plug the SSH connection manager into the local switchboard.
                remote: Some(remote.clone() as std::sync::Arc<dyn skill_server::RemoteControl>),
                // Hand the server's update module its installer (see ShellUpdater).
                updater: Some(std::sync::Arc::new(ShellUpdater {
                    app: app.handle().clone(),
                    remote_slot: remote_slot_setup.clone(),
                }) as std::sync::Arc<dyn skill_core::update::UpdateControl>),
                ..Default::default()
            };
            let port = match skill_server::spawn(cfg) {
                Ok(h) => h.addr.port(),
                Err(e) => {
                    // Dev tolerates this — an external skill-server may already hold
                    // 8765 and back the Vite proxy. Prod logs the failure.
                    log::error!("in-process server did not start: {e}");
                    8765
                }
            };

            // Same-origin model: the webview's origin IS the server, so api.ts's
            // relative `/api` calls + the SSE EventSource pass CSP `default-src 'self'`.
            let url = if tauri::is_dev() {
                "http://localhost:1420".to_string() // Vite serves the UI + proxies /api → 8765
            } else {
                format!("http://127.0.0.1:{port}") // the in-process server serves UI + /api
            };
            WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::External(url.parse().unwrap()))
                .title("Skill Studio")
                .inner_size(1200.0, 800.0)
                .min_inner_size(720.0, 480.0)
                // Off by default in wry; enables Cmd/Ctrl +/-/0 whole-window zoom
                // (native page zoom on Windows, an injected CSS-zoom polyfill on
                // macOS/Linux). The terminal's DOM renderer stays crisp under it.
                .zoom_hotkeys_enabled(true)
                // `target="_blank"` links (release page, GitHub device flow) must
                // open in the SYSTEM browser — wry's default silently drops them.
                .on_new_window(|url, _features| {
                    if matches!(url.scheme(), "http" | "https") {
                        if let Err(e) = open::that_detached(url.as_str()) {
                            log::warn!("couldn't open {url} in the system browser: {e}");
                        }
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            // Closing the desktop app tears down what only THIS process can use —
            // the inference engine child and any live SSH session — but leaves the
            // tmux terminals running: agents keep working after quit and are picked
            // up by the next launch (or any other client). See skill-term's docs.
            if let tauri::RunEvent::Exit = event {
                if let Some(r) = remote_slot.get() {
                    r.shutdown();
                }
                engine::shutdown(); // reap the inference engine child
            }
        });
}
