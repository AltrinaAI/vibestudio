// Tauri desktop shell — a thin CLIENT. It brings up `skill-server` in-process on
// a loopback port and points the webview at it, so the desktop runs the EXACT
// same HTTP path as a browser or a remote host. There are no `#[tauri::command]`s:
// every capability is reached over `/api` (see `server/skill-server`). The shell's
// only jobs are: host the window, seed the bundled-engine path, own the engine +
// terminal lifecycle (the in-process server runs with `startup_maintenance:false`,
// so these fire exactly once), and reap on exit.
//
// Lifecycle is TRAY-governed: closing the window hides it (server + phone access
// stay up); the tray's Quit is the one explicit full-teardown — terminals
// included. Every other exit (update restart, crash, plain Cmd+Q) leaves tmux
// agents running for the next launch to pick up.
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
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

/// The shell's half of `skill_server::NotifyControl`: the SPA decides WHEN a
/// turn-finish deserves a toast (it owns focus + seen state) and posts to the
/// pinned-local `/api/notify*` routes; only this process can talk to the OS
/// notification center, so display runs here via `tauri-plugin-notification`.
struct ShellNotifier {
    app: tauri::AppHandle,
}

impl skill_server::NotifyControl for ShellNotifier {
    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    }

    fn prime(&self) {
        // Permission prompts can block until answered — never on a server worker.
        let app = self.app.clone();
        std::thread::spawn(move || {
            if let Err(e) = app.notification().request_permission() {
                log::warn!("notification permission request failed: {e}");
            }
        });
    }

    fn set_badge(&self, count: u32) {
        // Dock badge (macOS) / launcher count (some Linux DEs). Windows has no
        // numeric badge — the Err is deliberately dropped (quiet degradation).
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.set_badge_count((count > 0).then_some(count as i64));
        }
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
        .plugin(tauri_plugin_notification::init()) // OS toasts; driven from ShellNotifier, no JS API
        .setup(move |app| {
            // Logger first, so even early startup is captured. Tee to a small on-disk
            // file (durable for the packaged app, where stderr goes nowhere) + stderr
            // (so `npm run dev` still shows logs). The in-process server shares this
            // process, so its `log::*` records land here too. RUST_LOG-gated; quiet by
            // default. Frontend warns/errors arrive via POST /api/logs/client.
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
            let phone =
                std::sync::Arc::new(skill_server::PhoneControl::new(app.package_info().version.to_string()));
            let updater = std::sync::Arc::new(ShellUpdater {
                app: app.handle().clone(),
                remote_slot: remote_slot_setup.clone(),
            }) as std::sync::Arc<dyn skill_core::update::UpdateControl>;
            let notifier = std::sync::Arc::new(ShellNotifier { app: app.handle().clone() })
                as std::sync::Arc<dyn skill_server::NotifyControl>;
            let make_cfg = |port: u16| ServerConfig {
                host: "127.0.0.1".into(),
                port,
                dist: dist.clone(),
                bundled_skills: resource_dir.clone().map(|r| r.join("skills")),
                examples_base: resource_dir.clone(), // resolve bundled examples by relative path
                startup_maintenance: false,
                // Plug the SSH connection manager into the local switchboard.
                remote: Some(remote.clone() as std::sync::Arc<dyn skill_server::RemoteControl>),
                // Hand the server's update module its installer (see ShellUpdater).
                updater: Some(updater.clone()),
                phone: Some(phone.clone()),
                // OS toasts + dock badge for the SPA's turn-finish notifier.
                notifier: Some(notifier.clone()),
                ..Default::default()
            };
            // Bind the stable phone port first (it's also dev's Vite proxy target),
            // so a persisted `tailscale serve` mapping finds the app again on the
            // next launch. Prod falls back to an ephemeral port when it's taken
            // (the phone mapping goes stale until re-enabled, the app still works);
            // dev tolerates the failure outright — an external skill-server may
            // already hold 8765 and back the Vite proxy.
            let preferred = std::env::var("SKILL_STUDIO_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(skill_server::PHONE_PORT);
            let port = match skill_server::spawn(make_cfg(preferred)) {
                Ok(h) => {
                    phone.set_port(h.addr.port());
                    h.addr.port()
                }
                Err(e) if !tauri::is_dev() => {
                    log::warn!("port {preferred} taken ({e}); falling back to an ephemeral port");
                    let h = skill_server::spawn(make_cfg(0))?;
                    phone.set_port(h.addr.port());
                    h.addr.port()
                }
                Err(e) => {
                    log::error!("in-process server did not start: {e}");
                    preferred
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
                .title("VibeStudio")
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

            // ── tray: the lifecycle owner. Closing the window only hides it (the
            // server, terminals, and phone access stay up); Quit here is the ONE
            // explicit full teardown — every studio terminal on this machine, the
            // live SSH session, and the engine end with it. Update restarts and
            // plain window closes never touch the terminals.
            let open_item = MenuItemBuilder::with_id("open", "Open VibeStudio").build(app)?;
            let phone_item = MenuItemBuilder::with_id("phone", "Open on your phone…").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit VibeStudio").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&open_item)
                .item(&phone_item)
                .separator()
                .item(&quit_item)
                .build()?;
            let remote_for_tray = remote.clone();
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("VibeStudio")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "phone" => {
                        show_main(app);
                        // The SPA opens the phone modal when it sees this param
                        // (and strips it) — see RemoteMenu.tsx.
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval("window.location.hash = '#/?phone=1'");
                        }
                    }
                    "quit" => {
                        if let Ok(sessions) = skill_term::list_sessions() {
                            for s in sessions {
                                let _ = skill_term::kill_session(&s.id);
                            }
                        }
                        remote_for_tray.shutdown();
                        engine::shutdown();
                        app.exit(0);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close = hide to tray; the tray's Quit is how you actually leave.
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // `_app` is used only by the macOS Reopen arm; the underscore keeps it
        // warning-free on the other platforms where that arm is compiled out.
        .run(move |_app, event| {
            match event {
                // Any non-tray exit (update restart, Cmd+Q, OS shutdown) tears down
                // what only THIS process can use — the inference engine child and any
                // live SSH session — but leaves the tmux terminals running: agents
                // keep working and are picked up by the next launch (or any other
                // client). Only the tray's Quit also ends the terminals.
                tauri::RunEvent::Exit => {
                    if let Some(r) = remote_slot.get() {
                        r.shutdown();
                    }
                    engine::shutdown(); // reap the inference engine child
                }
                // macOS: clicking the dock icon with the window hidden re-shows it.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => show_main(_app),
                _ => {}
            }
        });
}

/// Show + focus the main window (tray "Open", macOS dock reopen).
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
