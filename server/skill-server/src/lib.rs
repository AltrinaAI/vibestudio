//! skill-server — the HTTP face of `skill-core` + `skill-term`.
//!
//! This crate IS the backend: it exposes every capability over `/api/*` (JSON,
//! plus SSE for terminal output) and serves the built UI (`dist/`) from the same
//! origin. It runs two ways from ONE serve loop:
//!   * **standalone** — the `skill-server` binary (`src/main.rs`), e.g. on a remote
//!     host reached over an `ssh -L` tunnel, or for browser-local dev.
//!   * **in-process** — the desktop shell ([client/desktop]) calls [`spawn`] on a
//!     background thread and points its webview at the returned loopback URL.
//!
//! The desktop and the remote host therefore run byte-identical request handling;
//! only the entry point differs. Configuration (bind addr, the `dist` directory,
//! the bundled-skills + examples bases, an optional bearer token) flows in via
//! [`ServerConfig`] — the library makes no CWD-relative guesses of its own.

use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};
use skill_core::{
    commit_agent, commitmsg, discover, engine, github, gitops, mining, recents, secrets, skill,
    sync, update,
};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

mod proxy;
mod remote_api;
mod sshmgr;

pub use sshmgr::SshRemoteControl;

/// Install the process-wide logger: stderr sink, level via `RUST_LOG`. Idempotent
/// and a no-op if a global logger is already set, so it's safe to call from either
/// entry point — the standalone `skill-server` binary (`main.rs`) or the desktop
/// shell that hosts this server in-process.
///
/// Output is pinned to **stderr** so it never corrupts the `SKILL_SERVER_READY
/// port=N` line the desktop reads off this process's *stdout* (see `main.rs`). The
/// default is intentionally quiet (`warn`, with the `skill_*` crates at `info`), so
/// a packaged/remote build is near-silent; for development raise it with e.g.
/// `RUST_LOG=skill_server=debug,skill_core=debug,skill_term=debug`.
///
/// `log` + `env_logger` (not `tracing`) is deliberate: the server is synchronous
/// (`tiny_http` + `std::thread`, no tokio) and this is dev logging, not tracing.
/// The `log::*` call sites stay portable — an OpenTelemetry Logs exporter
/// (`opentelemetry-appender-log`) can replace this subscriber later with no
/// call-site changes.
pub fn init_logging() {
    let _ = base_log_builder().target(env_logger::Target::Stderr).try_init();
}

/// Like [`init_logging`], but ALSO append logs to `path` — for the packaged desktop,
/// where stderr goes nowhere (no attached terminal; on Windows the release build
/// detaches the console entirely). Tees every line to BOTH stderr (so `npm run dev`
/// keeps showing logs) and the file. Best-effort: if the file can't be opened it
/// falls back to stderr-only, so logging never breaks. The file is kept small by
/// rotating once at startup when it exceeds ~1 MiB (retaining a single `.log.1`); at
/// the default `warn` level it grows very slowly.
pub fn init_logging_to_file(path: &Path) {
    let target = match open_log_file(path) {
        Some(file) => env_logger::Target::Pipe(Box::new(TeeWriter { file })),
        None => env_logger::Target::Stderr,
    };
    let _ = base_log_builder().target(target).try_init();
}

const DEFAULT_LOG_FILTER: &str = "warn,skill_server=info,skill_core=info,skill_term=info";

/// Shared builder: read `RUST_LOG` (quiet default), millisecond timestamps. The
/// caller picks the sink via `.target(...)`.
fn base_log_builder() -> env_logger::Builder {
    let mut b =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(DEFAULT_LOG_FILTER));
    b.format_timestamp_millis();
    b
}

/// Rotate the log if it's already large (keep one previous `.log.1`), then open it
/// for append. All steps best-effort — any failure yields `None` → stderr-only.
fn open_log_file(path: &Path) -> Option<std::fs::File> {
    const MAX_BYTES: u64 = 1024 * 1024; // 1 MiB — keep the on-disk log small.
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    std::fs::OpenOptions::new().create(true).append(true).open(path).ok()
}

/// Fans each formatted log line out to the file (the durable sink for a packaged
/// app) AND stderr (keeps `npm run dev` working). The stderr write is best-effort so
/// a closed/invalid stderr in a bundled app never drops the file write. env_logger
/// serializes writes to this target internally, so no extra locking is needed.
struct TeeWriter {
    file: std::fs::File,
}
impl Write for TeeWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stderr().write_all(buf);
        self.file.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        let _ = std::io::stderr().flush();
        self.file.flush()
    }
}

// ───────────────────────────── public API ─────────────────────────────

// ── Remote-SSH connection manager (desktop only) ──
// The desktop's SSH controller plugs in here so the UI can drive it over
// `/api/remote/*`; while connected, the local server reverse-proxies the rest of
// `/api/*` to the remote. The standalone (remote) binary leaves
// `ServerConfig::remote` as `None`, so none of this is active there. The types live
// here so `ServerConfig` can name them; the impl lives in `client/desktop`
// (preserving the one-way `client/desktop` → `skill_server` crate dependency).

/// A host the user can connect to: an alias from `~/.ssh/config`, or free-form
/// `user@host`.
#[derive(serde::Serialize)]
pub struct RemoteHost {
    pub name: String,
    /// Resolved `user@hostname:port` for display, when known.
    pub detail: Option<String>,
}

/// Live connection state, polled by the UI via `GET /api/remote/status`.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    /// `idle` | `detecting` | `installing` | `launching` | `forwarding` | `connected` | `error`.
    pub state: String,
    pub host: Option<String>,
    pub message: Option<String>,
}

/// Where the switchboard forwards `/api/*` while connected. The `token` is injected
/// into the upstream `Authorization` header by the proxy and never reaches the
/// browser (so the SSE `EventSource`, which can't set headers, needs no token).
#[derive(Clone)]
pub struct RemoteTarget {
    /// `http://127.0.0.1:<local-forwarded-port>`.
    pub base_url: String,
    pub token: String,
}

/// The desktop's SSH connection manager. `connect` kicks off provisioning/tunnelling
/// on a background thread and reports progress through `status`; `active_target`
/// returns `Some` only once fully connected — that's the proxy's signal to forward.
pub trait RemoteControl: Send + Sync {
    fn list_hosts(&self) -> Result<Vec<RemoteHost>, String>;
    fn connect(&self, host: &str) -> Result<(), String>;
    /// Tear down the live session. `forget` also clears the remembered resume host —
    /// atomically with invalidating any in-flight connect — so an explicit user
    /// disconnect starts Local next launch. App-exit teardown passes `false`, so
    /// quitting while connected still resumes next time.
    fn disconnect(&self, forget: bool) -> Result<(), String>;
    fn status(&self) -> RemoteStatus;
    fn active_target(&self) -> Option<RemoteTarget>;
    /// The host to auto-reconnect to on launch (the last one we connected to and never
    /// explicitly disconnected from), or `None` to start Local. The client reads this
    /// (`GET /api/remote/last`) and drives the resume through the normal connect path.
    fn last_host(&self) -> Option<String> {
        None
    }
}

/// How to run the server. Build with `..Default::default()` and override fields.
pub struct ServerConfig {
    /// Bind host. Desktop and CLI both use `127.0.0.1`.
    pub host: String,
    /// Requested port. `0` = ephemeral (the desktop uses this and reads the real
    /// port back from [`ServerHandle::addr`]).
    pub port: u16,
    /// Directory of the built UI (`index.html` + assets). Required — the library
    /// does NOT fall back to a CWD-relative `dist`.
    pub dist: PathBuf,
    /// Base dir of the bundled built-in skills (`load-secrets`, `skill-miner`),
    /// each a subfolder with a `SKILL.md`. `None` falls back to an env/CWD/dist
    /// probe.
    pub bundled_skills: Option<PathBuf>,
    /// Base dir for resolving a bundled example by relative path in
    /// `/api/read-skill`. `None` keeps absolute-path-only behaviour.
    pub examples_base: Option<PathBuf>,
    /// Optional bearer token. `None` = no auth (loopback). `Some` = require
    /// `Authorization: Bearer <token>` on every request (the SSH case).
    pub token: Option<String>,
    /// Worker-thread count.
    pub workers: usize,
    /// Run the startup chores: `skill_term::sweep_stale` (GC long-finished
    /// terminals — never live ones; sessions deliberately outlive backends),
    /// `engine::reap_orphans` (kill an inference engine whose backend died),
    /// and `prefetch_model`. The standalone binary owns this; an embedding
    /// process (the desktop) that does its own lifecycle sets it `false` so
    /// the chores don't run twice.
    pub startup_maintenance: bool,
    /// The SSH connection manager (desktop only). `None` = a plain server with no
    /// remoting (the standalone binary, or browser-local dev). When set, the server
    /// serves `/api/remote/*` and proxies the rest of `/api/*` to the connected remote.
    pub remote: Option<Arc<dyn RemoteControl>>,
    /// The app's installer (desktop only) — `spawn` hands it to
    /// `skill_core::update::init`, which runs the background release check.
    /// `None` (standalone/dev) = `/api/update/status` reports `canAuto: false`.
    pub updater: Option<Arc<dyn update::UpdateControl>>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 0,
            dist: PathBuf::from("dist"),
            bundled_skills: None,
            examples_base: None,
            token: None,
            workers: 4,
            startup_maintenance: true,
            remote: None,
            updater: None,
        }
    }
}

/// A running server. The worker threads each hold the listener, so the server
/// keeps serving even if this handle is dropped; keep it to read [`addr`] or to
/// [`join`] (block) on it.
///
/// [`addr`]: ServerHandle::addr
/// [`join`]: ServerHandle::join
pub struct ServerHandle {
    /// The ACTUAL bound address; `.port()` is the kernel-assigned port when
    /// `ServerConfig::port` was `0`.
    pub addr: SocketAddr,
    workers: Vec<thread::JoinHandle<()>>,
}

impl ServerHandle {
    /// `http://<addr>` — point a webview here.
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
    /// Block until the workers exit (they serve until the process ends).
    pub fn join(self) {
        for w in self.workers {
            let _ = w.join();
        }
    }
}

/// Bind synchronously (so a bind error surfaces here), then serve on background
/// worker threads. Returns immediately with the bound address.
pub fn spawn(cfg: ServerConfig) -> std::io::Result<ServerHandle> {
    let server = Server::http(format!("{}:{}", cfg.host, cfg.port))
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let addr = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| std::io::Error::other("server bound to a non-IP address"))?;
    let server = Arc::new(server);

    if cfg.startup_maintenance {
        // GC terminals whose agent finished long ago (live ones persist across
        // backend restarts by design — see skill-term), reap an inference
        // engine orphaned by a dead backend, then warm the model so the first
        // commit draft is fast.
        skill_term::sweep_stale();
        engine::reap_orphans();
        engine::prefetch_model();
    }

    if let Some(control) = cfg.updater {
        // The workspace version is stamped to the release tag, same as the desktop.
        update::init(control, env!("CARGO_PKG_VERSION"));
    }

    let ctx = Arc::new(ServerCtx {
        dist: cfg.dist,
        bundled_skills: cfg.bundled_skills,
        examples_base: cfg.examples_base,
        token: cfg.token,
        remote: cfg.remote,
    });

    let mut workers = Vec::with_capacity(cfg.workers);
    for _ in 0..cfg.workers {
        let server = Arc::clone(&server);
        let ctx = Arc::clone(&ctx);
        workers.push(thread::spawn(move || worker_loop(&server, &ctx)));
    }
    Ok(ServerHandle { addr, workers })
}

/// Resolved per-request context (config the handlers actually read).
struct ServerCtx {
    dist: PathBuf,
    bundled_skills: Option<PathBuf>,
    examples_base: Option<PathBuf>,
    token: Option<String>,
    remote: Option<Arc<dyn RemoteControl>>,
}

/// Bearer-token guard. `None` token ⇒ always authorized (loopback default).
///
/// NOTE for when a token is actually used (the SSH case): the SSE attach path
/// (`/api/terminal/attach`) is consumed with `EventSource`, which can't send an
/// `Authorization` header — so that route will need the token via a query param,
/// or to lean on the loopback-bound `ssh -L` tunnel for auth. See design.md.
fn authorized(token: &Option<String>, request: &Request) -> bool {
    match token {
        None => true,
        Some(t) => {
            let want = format!("Bearer {t}");
            request
                .headers()
                .iter()
                .any(|h| h.field.equiv("Authorization") && h.value.as_str() == want.as_str())
        }
    }
}

fn worker_loop(server: &Server, ctx: &ServerCtx) {
    for mut request in server.incoming_requests() {
        let method = request.method().clone();
        let url = request.url().to_string();
        let path = url.split('?').next().unwrap_or(url.as_str()).to_string();
        // Auth at the single choke point (no-op when token is None). OPTIONS
        // preflight carries no Authorization, so it stays unauthenticated.
        if method != Method::Options && !authorized(&ctx.token, &request) {
            reply_status(request, 401, "Unauthorized");
            continue;
        }

        // ── Remote-SSH switchboard (desktop only; `ctx.remote` is None on the
        //    standalone binary, so neither branch fires there) ──
        // The connection manager is ALWAYS handled locally, even while connected.
        if path.starts_with("/api/remote/") {
            let mut body = String::new();
            if method == Method::Post {
                let _ = request.as_reader().read_to_string(&mut body);
            }
            send_reply(request, remote_api::handle(&method, &path, &body, ctx));
            continue;
        }
        // Frontend log shipping — ALWAYS handled locally (never proxied), so the
        // UI's own warns/errors land in THIS machine's log file, which is where
        // you'd look to debug the desktop app. The client batches these, so it
        // only fires when the UI actually logs a warning/error.
        if path == "/api/client-log" {
            let mut body = String::new();
            if method == Method::Post {
                let _ = request.as_reader().read_to_string(&mut body);
            }
            send_reply(request, client_log(&body));
            continue;
        }
        // App auto-update — ALWAYS handled locally (never proxied): it's THIS
        // desktop's own update state, not the connected remote's.
        if path.starts_with("/api/update/") {
            let mut body = String::new();
            if method == Method::Post {
                let _ = request.as_reader().read_to_string(&mut body);
            }
            send_reply(request, handle(&method, &url, &body, ctx));
            continue;
        }
        // While a remote is connected, every other /api/* is reverse-proxied to it.
        // (Must precede the local attach branch so the SSE stream proxies too.) BOTH
        // proxy paths run on their OWN thread, so a slow/hung remote can never pin a
        // pooled worker — keeping the locally-handled connection manager (status,
        // disconnect) responsive even when every request is being proxied.
        if path.starts_with("/api/") {
            if let Some(target) = ctx.remote.as_ref().and_then(|r| r.active_target()) {
                let url = url.clone();
                if method == Method::Get && path == "/api/terminal/attach" {
                    thread::spawn(move || proxy::proxy_sse(request, &url, &target));
                } else {
                    let method = method.clone();
                    thread::spawn(move || proxy::proxy_buffered(request, &method, &url, &target));
                }
                continue;
            }
        }

        // ── local handling ──
        // Terminal output streams (SSE) block for the session's lifetime — run
        // them on a dedicated thread so they never starve this worker.
        if method == Method::Get && path == "/api/terminal/attach" {
            thread::spawn(move || stream_terminal(request, &url));
            continue;
        }
        let mut body = String::new();
        if method == Method::Post {
            let _ = request.as_reader().read_to_string(&mut body);
        }
        send_reply(request, handle(&method, &url, &body, ctx));
    }
}

/// One-line access/error log for an outgoing reply, the single point through which
/// every locally-handled and proxied request flows. `<400` logs at `debug` (a
/// per-request access trace, off by default — enable with `RUST_LOG=…=debug`);
/// `>=400` logs at `warn` with the error detail pulled from our uniform
/// `{"error": …}` body, so server-side failures that previously only reached the
/// client are now visible at the default level.
fn log_reply(request: &Request, status: u16, body: &[u8]) {
    if status < 400 {
        log::debug!("{} {} -> {}", request.method().as_str(), request.url(), status);
        return;
    }
    let detail = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
        .unwrap_or_default();
    log::warn!("{} {} -> {} {}", request.method().as_str(), request.url(), status, detail);
}

/// Serialize a `Reply` onto the wire with the standard CORS + no-store headers, then
/// any reply-specific `extra` headers. Shared by local handlers and the proxy.
pub(crate) fn send_reply(request: Request, reply: Reply) {
    log_reply(&request, reply.status, &reply.body);
    let mut response = Response::from_data(reply.body).with_status_code(reply.status);
    let headers = [
        ("Content-Type", reply.content_type.as_str()),
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type, Authorization"),
        ("Cache-Control", "no-store"),
    ];
    for (k, val) in headers {
        if let Ok(h) = Header::from_bytes(k.as_bytes(), val.as_bytes()) {
            response.add_header(h);
        }
    }
    for (k, val) in &reply.extra {
        if let Ok(h) = Header::from_bytes(k.as_bytes(), val.as_bytes()) {
            response.add_header(h);
        }
    }
    let _ = request.respond(response);
}

// ───────────────────────────── request handling ─────────────────────────────

struct Reply {
    status: u16,
    body: Vec<u8>,
    content_type: String,
    extra: Vec<(String, String)>,
}

fn json_reply<T: serde::Serialize>(result: Result<T, String>) -> Reply {
    match result {
        Ok(v) => Reply {
            status: 200,
            body: serde_json::to_vec(&v).unwrap_or_default(),
            content_type: "application/json".into(),
            extra: vec![],
        },
        Err(e) => Reply {
            status: 400,
            body: serde_json::to_vec(&json!({ "error": e })).unwrap_or_default(),
            content_type: "application/json".into(),
            extra: vec![],
        },
    }
}

/// Re-emit a batch of frontend log entries through the server logger, so they land
/// in the same sink (stderr + the on-disk file) as backend logs. Only `warn`/`error`
/// are forwarded by the client, under the `skill_client` target; malformed batches
/// are ignored (never let client input crash the route).
fn client_log(body: &str) -> Reply {
    #[derive(serde::Deserialize)]
    struct Entry {
        level: String,
        scope: Option<String>,
        msg: String,
    }
    #[derive(serde::Deserialize)]
    struct Batch {
        entries: Vec<Entry>,
    }
    if let Ok(batch) = serde_json::from_str::<Batch>(body) {
        for e in batch.entries.into_iter().take(200) {
            let scope = e.scope.as_deref().unwrap_or("client");
            if e.level == "error" {
                log::error!(target: "skill_client", "[{scope}] {}", e.msg);
            } else {
                log::warn!(target: "skill_client", "[{scope}] {}", e.msg);
            }
        }
    }
    json_reply(Ok(json!({ "ok": true })))
}

fn web_mime(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "wasm" => "application/wasm",
        "map" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Serve a static asset from `dist`, falling back to index.html (SPA).
fn serve_static(dist: &Path, url_path: &str) -> Reply {
    let rel = url_path.trim_start_matches('/');
    // Empty path or a traversal attempt → fall back to the SPA index; only ever
    // serve within dist.
    let candidate = if rel.is_empty() || rel.contains("..") {
        dist.join("index.html")
    } else {
        dist.join(rel)
    };
    let target = if candidate.is_file() {
        candidate
    } else {
        dist.join("index.html")
    };
    match std::fs::read(&target) {
        Ok(body) => Reply {
            status: 200,
            content_type: web_mime(target.to_str().unwrap_or("")).into(),
            body,
            extra: vec![],
        },
        Err(_) => Reply {
            status: 404,
            body: b"Not found. Build the UI first (npm run build) or pass --dist.".to_vec(),
            content_type: "text/plain; charset=utf-8".into(),
            extra: vec![],
        },
    }
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_else(|_| v.to_string()));
            }
        }
    }
    None
}

/// Locate the base dir of the bundled built-in skills (`load-secrets`,
/// `skill-miner`). Honors `SKILL_STUDIO_BUNDLED_SKILLS`, else looks relative to
/// CWD and the dist dir. A candidate counts if it contains the activation skill.
fn bundled_skills_dir(dist: &Path) -> Option<PathBuf> {
    let has_skills = |p: &Path| p.join("load-secrets").join("SKILL.md").exists();
    if let Ok(p) = std::env::var("SKILL_STUDIO_BUNDLED_SKILLS") {
        let pb = PathBuf::from(p);
        if has_skills(&pb) {
            return Some(pb);
        }
    }
    let candidates = [PathBuf::from("skills"), dist.join("../skills"), dist.join("skills")];
    candidates.into_iter().find(|c| has_skills(c))
}

/// A bundled skill's folder, by dir name.
fn bundled_skill(ctx: &ServerCtx, name: &str) -> Option<PathBuf> {
    let base = ctx.bundled_skills.clone().or_else(|| bundled_skills_dir(&ctx.dist))?;
    let dir = base.join(name);
    dir.join("SKILL.md").exists().then_some(dir)
}

fn handle(method: &Method, url: &str, body: &str, ctx: &ServerCtx) -> Reply {
    let path = url.split('?').next().unwrap_or(url);
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();

    match (method, path) {
        (Method::Options, _) => Reply {
            status: 204,
            body: vec![],
            content_type: "text/plain".into(),
            extra: vec![],
        },
        (Method::Get, "/api/discover") => json_reply(discover::discover_and_autotrack()),
        (Method::Post, "/api/read-skill") => {
            let root = skill::resolve_skill_input(&s("path"), ctx.examples_base.as_deref());
            json_reply(skill::build_raw_skill(&root))
        }
        (Method::Post, "/api/read-file") => json_reply(skill::read_file_impl(&s("root"), &s("rel"))),
        (Method::Post, "/api/write-file") => {
            json_reply(skill::write_file_impl(&s("root"), &s("rel"), &s("content")).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/delete-file") => {
            json_reply(skill::delete_path_impl(&s("root"), &s("rel")).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/read-image") => json_reply(skill::read_image_impl(&s("root"), &s("rel"))),
        (Method::Post, "/api/write-asset") => {
            // `data` is the media file base64-encoded (the JSON body must stay
            // UTF-8 text — same convention as /api/import-zip). The server picks a
            // non-clobbering name under `dir` and returns the path it wrote,
            // relative to `root`, for the markdown link.
            json_reply(
                skill::write_asset_impl(&s("root"), &s("dir"), &s("name"), &s("data"))
                    .map(|rel| json!({ "rel": rel })),
            )
        }
        (Method::Post, "/api/list-dir") => json_reply(skill::list_dir_impl(
            &s("path"),
            v.get("includeFiles").and_then(|x| x.as_bool()).unwrap_or(false),
        )),
        (Method::Post, "/api/sync-targets") => json_reply(sync::sync_targets(&s("root"))),
        (Method::Post, "/api/sync-skill") => {
            let overwrite = v.get("overwrite").and_then(|x| x.as_bool()).unwrap_or(false);
            let link = v.get("link").and_then(|x| x.as_bool()).unwrap_or(false);
            json_reply(sync::sync_skill(&s("root"), &s("target"), overwrite, link))
        }
        (Method::Post, "/api/delete-skill") => json_reply(sync::delete_skill(&s("root"))),
        (Method::Post, "/api/promote-skill") => json_reply(sync::promote_skill(&s("root"))),
        (Method::Get, "/api/skill-homes") => json_reply(sync::skill_homes()),
        (Method::Post, "/api/create-skill") => {
            json_reply(sync::create_skill(&s("target"), &s("name"), &s("content")))
        }
        (Method::Post, "/api/import-folder") => {
            let overwrite = v.get("overwrite").and_then(|x| x.as_bool()).unwrap_or(false);
            json_reply(sync::import_skill_folder(&s("source"), &s("target"), overwrite))
        }
        (Method::Post, "/api/import-zip") => {
            // `data` is the .zip base64-encoded (the JSON body must stay UTF-8 text).
            let overwrite = v.get("overwrite").and_then(|x| x.as_bool()).unwrap_or(false);
            json_reply(sync::import_skill_zip_base64(&s("data"), &s("target"), overwrite))
        }
        (Method::Post, "/api/import-remote") => {
            // Clone a skill repository (GitHub/GitLab/any git URL) into a home;
            // the clone keeps its origin, so the skill arrives sync-connected.
            let overwrite = v.get("overwrite").and_then(|x| x.as_bool()).unwrap_or(false);
            json_reply(github::import_skill_from_remote(&s("url"), &s("target"), overwrite))
        }
        // --- app-managed agent terminals (tmux-backed) ---
        (Method::Get, "/api/terminal/agents") => json_reply(Ok(skill_term::detect_agents())),
        (Method::Get, "/api/terminal/list") => json_reply(skill_term::list_sessions()),
        (Method::Post, "/api/terminal/create") => {
            let u16f = |k: &str, d: u16| v.get(k).and_then(|x| x.as_u64()).map(|n| n as u16).unwrap_or(d);
            let boolf = |k: &str| v.get(k).and_then(|x| x.as_bool()).unwrap_or(false);
            let extra: Vec<String> = v
                .get("extraArgs")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            // `resume` (API-only, no dialog control): reopen the agent's
            // recorded session in cwd instead of starting a fresh one.
            if boolf("resume") {
                let model = s("model");
                let effort = s("effort");
                json_reply(skill_term::create_session_resume(
                    &s("agent"),
                    &s("cwd"),
                    u16f("cols", 80),
                    u16f("rows", 24),
                    Some(model.trim()).filter(|m| !m.is_empty()),
                    Some(effort.trim()).filter(|e| !e.is_empty()),
                ))
            } else {
                json_reply(skill_term::create_session(
                    &s("agent"),
                    &s("cwd"),
                    u16f("cols", 80),
                    u16f("rows", 24),
                    boolf("ide"),
                    boolf("skipPermissions"),
                    boolf("autoMode"),
                    &extra,
                ))
            }
        }
        (Method::Post, "/api/terminal/kill") => {
            json_reply(skill_term::kill_session(&s("id")).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/terminal/input") => {
            let data = skill_term::b64_decode(&s("data"));
            json_reply(skill_term::write(&s("id"), &data).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/terminal/resize") => {
            let u16f = |k: &str, d: u16| v.get(k).and_then(|x| x.as_u64()).map(|n| n as u16).unwrap_or(d);
            json_reply(
                skill_term::resize(&s("id"), u16f("cols", 80), u16f("rows", 24)).map(|_| json!({ "ok": true })),
            )
        }
        (Method::Post, "/api/terminal/paste-image") => {
            // `data` is the image base64-encoded (the JSON body must stay UTF-8
            // text — same convention as /api/import-zip). Returns the temp-file
            // path on THIS machine, which is where the agent runs.
            json_reply(skill_term::save_pasted_image(&s("data"), &s("mime")).map(|p| json!({ "path": p })))
        }
        // --- skill mining (a skill-miner run in an agent terminal) ---
        (Method::Get, "/api/mine/sources") => {
            let days = query_param(url, "days").and_then(|d| d.parse().ok()).unwrap_or(35);
            json_reply(Ok(mining::sources(days)))
        }
        // The active run dir's files (the history archive is excluded) — the
        // mining page's artifacts listing.
        (Method::Get, "/api/mine/files") => json_reply(mining::files()),
        // Past runs archived under history/<id>/ — the mining page's "Past
        // runs" list (display-only: agent, id, when).
        (Method::Get, "/api/mine/history") => json_reply(mining::history()),
        // Whether the installed skill-miner copies differ from the bundled
        // official version — the dialog only offers "reinstall" when they do.
        (Method::Get, "/api/mine/miner-status") => {
            let bundled = bundled_skill(ctx, "skill-miner");
            json_reply(Ok(mining::miner_status(bundled.as_deref())))
        }
        // Restore every installed copy of the skill-miner to the official
        // bundled version (any .git the user created is preserved, so the
        // refresh lands as ordinary reviewable uncommitted changes).
        (Method::Post, "/api/mine/reinstall-miner") => {
            let bundled = bundled_skill(ctx, "skill-miner");
            json_reply(mining::reinstall_miner(bundled.as_deref()).map(|roots| json!({ "roots": roots })))
        }
        // The prompt a run with these settings would send — the dialog shows
        // it for review/editing; an edited prompt comes back via mine/start.
        (Method::Post, "/api/mine/prompt") => {
            let days = v.get("days").and_then(|x| x.as_u64()).unwrap_or(35);
            let improve = v.get("improve").and_then(|x| x.as_bool()).unwrap_or(true);
            json_reply(mining::preview_prompt(days, improve).map(|p| json!({ "prompt": p })))
        }
        (Method::Post, "/api/mine/start") => {
            let days = v.get("days").and_then(|x| x.as_u64()).unwrap_or(35);
            let sources: Vec<String> = v
                .get("sources")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let improve = v.get("improve").and_then(|x| x.as_bool()).unwrap_or(true);
            let agent = s("agent");
            let model = s("model");
            let effort = s("effort");
            let prompt = s("prompt");
            let bundled = bundled_skill(ctx, "skill-miner");
            json_reply((|| {
                let opt = skill_term::detect_agents()
                    .into_iter()
                    .find(|a| a.id == agent)
                    .ok_or_else(|| format!("Unknown agent option: {agent}"))?;
                let prompt_override = Some(prompt.trim()).filter(|p| !p.is_empty());
                let prep = mining::prepare_run(
                    &opt.agent,
                    days,
                    &sources,
                    improve,
                    prompt_override,
                    bundled.as_deref(),
                )?;
                // The agent registry's interactive launch: the TUI with the
                // run prompt pre-submitted — an ordinary agent session. The
                // client navigates the user to this terminal, where any
                // first-run trust dialog or approval prompt is answered.
                let cmd = mining::launch_cmd(
                    &opt.agent,
                    &opt.bin,
                    &prep.prompt,
                    Some(model.trim()).filter(|m| !m.is_empty()),
                    Some(effort.trim()).filter(|e| !e.is_empty()),
                )
                .ok_or_else(|| format!("{} can't run skill mining yet.", opt.label))?;
                let sess = skill_term::create_session_cmd(&agent, &prep.run_dir, 200, 50, &cmd)?;
                mining::record_run(prep, &agent, model.trim(), effort.trim(), &sess.id)
            })())
        }
        // The run's conversation: the recorded terminal while the agent is
        // live in it, else revived — via the terminal API's resume path
        // (create_session_resume), the same one `terminal/create {resume:true}`
        // takes.
        (Method::Post, "/api/mine/continue") => {
            let exists = |id: &str| {
                skill_term::list_sessions()
                    .map(|ss| ss.iter().any(|s| s.id == id))
                    .unwrap_or(false)
            };
            let running = |id: &str| !skill_term::agent_exited(id);
            let spawn = |agent_id: &str, cwd: &str, model: Option<&str>, effort: Option<&str>| {
                skill_term::create_session_resume(agent_id, cwd, 200, 50, model, effort)
                    .map(|s| s.id)
            };
            json_reply(
                mining::continue_run(exists, running, spawn)
                    .map(|id| json!({ "terminalId": id })),
            )
        }
        (Method::Get, "/api/mine/state") => {
            let exists = |id: &str| {
                skill_term::list_sessions()
                    .map(|ss| ss.iter().any(|s| s.id == id))
                    .unwrap_or(false)
            };
            let running = |id: &str| !skill_term::agent_exited(id);
            json_reply(mining::state(exists, running))
        }
        (Method::Post, "/api/mine/stop") => {
            json_reply(mining::stop(skill_term::kill_session).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/detect-required-env") => {
            let root = s("root");
            json_reply(secrets::secret_keys().map(|keys| skill::scan_for_env_vars(Path::new(&root), &keys)))
        }
        (Method::Post, "/api/git-info") => json_reply(gitops::git_info(&s("root"))),
        (Method::Post, "/api/git-track") => json_reply(gitops::git_track(&s("root"))),
        (Method::Post, "/api/git-untrack") => {
            json_reply(gitops::git_untrack(&s("root")).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/git-dirty-many") => {
            let roots: Vec<String> = v
                .get("roots")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            json_reply(Ok(gitops::git_dirty_many(&roots)))
        }
        (Method::Post, "/api/git-commit") => json_reply(gitops::git_commit(&s("root"), &s("message"))),
        (Method::Post, "/api/generate-commit-message") => json_reply(commitmsg::generate(&s("root"))),
        (Method::Post, "/api/regenerate-commit-message") => json_reply(commitmsg::regenerate(&s("root"))),
        (Method::Post, "/api/peek-commit-message") => json_reply(commitmsg::peek(&s("root"))),
        (Method::Get, "/api/commit-model-status") => json_reply(Ok(commit_agent::status())),
        (Method::Post, "/api/git-log") => {
            let limit = v.get("limit").and_then(|x| x.as_u64()).unwrap_or(20) as usize;
            json_reply(gitops::git_log(&s("root"), limit))
        }
        (Method::Post, "/api/git-status") => json_reply(gitops::git_status(&s("root"))),
        (Method::Post, "/api/git-worktree-diff") => json_reply(gitops::git_worktree_diff(&s("root"))),
        (Method::Post, "/api/git-commit-diff") => json_reply(gitops::git_commit_diff(&s("root"), &s("sha"))),
        (Method::Post, "/api/git-file-at") => json_reply(gitops::git_file_at(&s("root"), &s("rev"), &s("path"))),
        (Method::Post, "/api/git-files-at") => json_reply(gitops::git_files_at(&s("root"), &s("rev"))),
        (Method::Post, "/api/git-discard") => {
            json_reply(gitops::git_discard(&s("root"), &s("path")).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/git-discard-all") => {
            json_reply(gitops::git_discard_all(&s("root")).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/git-enter-version") => json_reply(gitops::git_enter_version(&s("root"), &s("sha"))),
        (Method::Post, "/api/git-exit-version") => json_reply(gitops::git_exit_version(&s("root"))),
        (Method::Post, "/api/git-keep-version") => json_reply(gitops::git_keep_version(&s("root"), &s("message"))),
        // --- publish a skill to GitHub (its own repo; remote = source of truth) ---
        (Method::Post, "/api/github/status") => {
            let check_remote = v.get("checkRemote").and_then(|x| x.as_bool()).unwrap_or(false);
            json_reply(github::github_status(&s("root"), check_remote))
        }
        (Method::Post, "/api/github/owners") => json_reply(github::list_owners()),
        (Method::Post, "/api/github/connect-token") => json_reply(github::connect_token(&s("token"))),
        (Method::Post, "/api/github/disconnect") => {
            json_reply(github::disconnect().map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/github/device-start") => json_reply(github::device_start()),
        (Method::Post, "/api/github/device-poll") => json_reply(github::device_poll()),
        (Method::Post, "/api/github/publish") => {
            let private = v.get("private").and_then(|x| x.as_bool()).unwrap_or(true);
            json_reply(github::publish(&s("root"), &s("owner"), &s("repo"), private))
        }
        // Provider-free: connect any existing git remote by URL (GitLab,
        // Bitbucket, self-hosted, …) — only github.com URLs get token sugar.
        (Method::Post, "/api/github/connect-remote") => {
            json_reply(github::connect_remote(&s("root"), &s("url")))
        }
        (Method::Post, "/api/github/sync") => json_reply(github::sync_now(&s("root"))),
        (Method::Post, "/api/github/auto-pull") => json_reply(github::auto_pull(&s("root"))),
        (Method::Post, "/api/github/unlink") => {
            json_reply(github::unlink(&s("root")).map(|_| json!({ "ok": true })))
        }
        // --- app auto-update (always served locally — see worker_loop) ---
        (Method::Get, "/api/update/status") => json_reply(Ok(update::status())),
        (Method::Post, "/api/update/apply") => {
            json_reply(update::apply().map(|_| json!({ "ok": true })))
        }
        // Recently opened skills/markdown. A NORMAL /api/* route (not short-circuited
        // like /api/remote/*): while connected it proxies to the remote, so recents
        // belong to whichever machine you're working on — same list whether you reach
        // it locally or over SSH.
        (Method::Get, "/api/recents") => json_reply(Ok(recents::list())),
        (Method::Post, "/api/recents-add") => {
            json_reply(recents::add(&s("root"), &s("name"), v.get("kind").and_then(|x| x.as_str())))
        }
        (Method::Post, "/api/recents-remove") => json_reply(recents::remove(&s("root"))),
        (Method::Get, "/api/secrets-status") => json_reply(secrets::secrets_status()),
        (Method::Get, "/api/secrets-list") => json_reply(secrets::secrets_list()),
        (Method::Post, "/api/secret-set") => {
            json_reply(secrets::secret_set(&s("key"), &s("value")).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/secret-delete") => {
            json_reply(secrets::secret_delete(&s("key")).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/secrets-preview-env") => json_reply(Ok(secrets::preview_dotenv(&s("data")))),
        (Method::Post, "/api/secrets-setup") => {
            let bootstrap = bundled_skill(ctx, "load-secrets");
            json_reply(secrets::secrets_setup(bootstrap.as_deref()))
        }
        // The skill's secrets as a plain-text .env download — for handing a
        // collaborator the values over a channel of the user's choosing (the
        // values deliberately never travel in the repo; see remotesync).
        (Method::Get, "/api/download-env") => {
            let root = query_param(url, "root").unwrap_or_default();
            let vars: Vec<String> = query_param(url, "vars")
                .map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
                .unwrap_or_default();
            let name = Path::new(&root)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "skill".into());
            match secrets::render_dotenv(&vars) {
                Ok(body) if body.is_empty() => {
                    json_reply::<()>(Err("None of this skill's secrets are in your store yet.".into()))
                }
                Ok(body) => Reply {
                    status: 200,
                    body: body.into_bytes(),
                    content_type: "text/plain; charset=utf-8".into(),
                    extra: vec![(
                        "Content-Disposition".into(),
                        format!("attachment; filename=\"{name}.env\""),
                    )],
                },
                Err(e) => json_reply::<()>(Err(e)),
            }
        }
        (Method::Get, "/api/download") => {
            let root = query_param(url, "root").unwrap_or_default();
            // Optional `vars=A,B` → bundle those managed secrets' values as a .env.
            let env_vars: Vec<String> = query_param(url, "vars")
                .map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
                .unwrap_or_default();
            match skill::zip_skill_bytes(&root, &env_vars) {
                Ok((filename, bytes)) => Reply {
                    status: 200,
                    body: bytes,
                    content_type: "application/zip".into(),
                    extra: vec![(
                        "Content-Disposition".into(),
                        format!("attachment; filename=\"{filename}\""),
                    )],
                },
                Err(e) => json_reply::<()>(Err(e)),
            }
        }
        (Method::Get, _) => serve_static(&ctx.dist, path),
        _ => Reply {
            status: 404,
            body: serde_json::to_vec(&json!({ "error": "Not found" })).unwrap_or_default(),
            content_type: "application/json".into(),
            extra: vec![],
        },
    }
}

// ───────────────── terminal output streaming (Server-Sent Events) ─────────────────
// We take over the raw socket (`into_writer`) and hand-roll a chunked
// `text/event-stream`: PTY output → `data: <base64>\n\n` frames, each flushed
// immediately. (tiny_http's normal `respond` streams a reader via a
// never-returning `io::copy` and only flushes at the very end, so it can't do
// SSE.) Browser input/resize ride the POST routes above. Holding the
// `Attachment` Arc keeps the tmux-attach client alive; returning from this fn
// drops it → detaches, leaving the tmux session running (nohup w.r.t. the UI).

/// Write one HTTP/1.1 chunk and flush it to the socket immediately.
pub(crate) fn write_chunk(w: &mut dyn Write, frame: &[u8]) -> std::io::Result<()> {
    write!(w, "{:x}\r\n", frame.len())?;
    w.write_all(frame)?;
    w.write_all(b"\r\n")?;
    w.flush()
}

// Bound concurrent attach streams so a flood of `/api/terminal/attach` requests
// can't spawn unbounded threads. Terminals are few in practice; this is a backstop.
static ACTIVE_STREAMS: AtomicUsize = AtomicUsize::new(0);
const MAX_STREAMS: usize = 256;

/// RAII guard for one streaming slot; releases the count on drop (every exit path).
pub(crate) struct StreamSlot;
impl Drop for StreamSlot {
    fn drop(&mut self) {
        ACTIVE_STREAMS.fetch_sub(1, Ordering::Relaxed);
    }
}
/// Reserve a streaming slot, or `None` if `MAX_STREAMS` are already open. Shared by the
/// local terminal stream and the proxied (remote) one so the cap covers both paths.
pub(crate) fn acquire_stream_slot() -> Option<StreamSlot> {
    if ACTIVE_STREAMS.fetch_add(1, Ordering::Relaxed) >= MAX_STREAMS {
        ACTIVE_STREAMS.fetch_sub(1, Ordering::Relaxed);
        None
    } else {
        Some(StreamSlot)
    }
}

pub(crate) fn reply_status(request: Request, status: u16, error: &str) {
    // Status-only replies (401/404/503/proxy 502, …) bypass `send_reply`, so log
    // them here too — `error` is already the human detail, no body parse needed.
    if status >= 400 {
        log::warn!("{} {} -> {} {}", request.method().as_str(), request.url(), status, error);
    } else {
        log::debug!("{} {} -> {}", request.method().as_str(), request.url(), status);
    }
    let body = serde_json::to_vec(&json!({ "error": error })).unwrap_or_default();
    let mut resp = Response::from_data(body).with_status_code(StatusCode(status));
    for (k, val) in [("Content-Type", "application/json"), ("Access-Control-Allow-Origin", "*")] {
        if let Ok(h) = Header::from_bytes(k.as_bytes(), val.as_bytes()) {
            resp.add_header(h);
        }
    }
    let _ = request.respond(resp);
}

/// Handle `GET /api/terminal/attach?id=&cols=&rows=` on its own thread (it blocks
/// for the session's lifetime, so it must not occupy a pooled worker).
fn stream_terminal(request: Request, url: &str) {
    let _slot = match acquire_stream_slot() {
        Some(s) => s,
        None => return reply_status(request, 503, "Too many terminal streams are open."),
    };

    let id = query_param(url, "id").unwrap_or_default();
    let cols = query_param(url, "cols").and_then(|s| s.parse().ok()).unwrap_or(80u16);
    let rows = query_param(url, "rows").and_then(|s| s.parse().ok()).unwrap_or(24u16);

    let (att, rx) = match skill_term::attach(&id, cols, rows) {
        Ok(pair) => pair,
        Err(e) => return reply_status(request, 400, &e),
    };

    let mut w = request.into_writer();
    let head = concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: text/event-stream\r\n",
        "Cache-Control: no-store\r\n",
        "Transfer-Encoding: chunked\r\n",
        "Access-Control-Allow-Origin: *\r\n",
        "X-Accel-Buffering: no\r\n",
        "\r\n",
    );
    if w.write_all(head.as_bytes()).is_err() || w.flush().is_err() {
        return; // drops `att` → detaches
    }

    use std::sync::mpsc::RecvTimeoutError;
    loop {
        // The 15s keepalive comment doubles as a disconnect probe: the write
        // fails once the client is gone, so we stop and detach.
        let frame = match rx.recv_timeout(std::time::Duration::from_secs(15)) {
            Ok(bytes) => format!("data: {}\n\n", skill_term::b64_encode(&bytes)),
            Err(RecvTimeoutError::Timeout) => ": ping\n\n".to_string(),
            Err(RecvTimeoutError::Disconnected) => break, // PTY closed
        };
        if write_chunk(w.as_mut(), frame.as_bytes()).is_err() {
            break; // client gone
        }
    }
    let _ = write_chunk(w.as_mut(), b""); // terminating 0-length chunk
    drop(att); // detach (the tmux session keeps running)
}
