// Tauri desktop shell — a thin CLIENT. It brings up `skill-server` in-process on
// a loopback port and points the webview at it, so the desktop runs the EXACT
// same HTTP path as a browser or a remote host. There are no `#[tauri::command]`s:
// every capability is reached over `/api` (see `server/skill-server`). The shell's
// only jobs are: host the window, seed the bundled-engine path, own the engine +
// terminal lifecycle (the in-process server runs with `startup_maintenance:false`,
// so these fire exactly once), and reap on exit.
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use skill_core::engine;
use skill_server::ServerConfig;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // ── lifecycle this process owns (the in-process server is spawned with
            //    startup_maintenance:false, so these run exactly once) ──
            skill_term::sweep_orphans(); // reap terminals orphaned by a hard-killed predecessor
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
                bootstrap_skill: resource_dir.clone().map(|r| r.join("skills").join("skill-studio")),
                examples_base: resource_dir, // resolve bundled examples by relative path
                startup_maintenance: false,
                ..Default::default()
            };
            let port = match skill_server::spawn(cfg) {
                Ok(h) => h.addr.port(),
                Err(e) => {
                    // Dev tolerates this — an external skill-server may already hold
                    // 8765 and back the Vite proxy. Prod logs the failure.
                    eprintln!("skill-studio: in-process server did not start: {e}");
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
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Closing the desktop app reaps the agents + engine it owns (no zombies).
            if let tauri::RunEvent::Exit = event {
                skill_term::cleanup_owned();
                engine::shutdown(); // reap the inference engine child too
            }
        });
}
