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
//! the bootstrap-skill + examples bases, an optional bearer token) flows in via
//! [`ServerConfig`] — the library makes no CWD-relative guesses of its own.

use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};
use skill_core::{commitmsg, discover, engine, gitops, secrets, skill, sync};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

mod proxy;
mod remote_api;
mod sshmgr;

pub use sshmgr::SshRemoteControl;

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
    fn disconnect(&self) -> Result<(), String>;
    fn status(&self) -> RemoteStatus;
    fn active_target(&self) -> Option<RemoteTarget>;
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
    /// Where the bundled `skill-studio` activation skill lives (for
    /// `/api/secrets-setup`). `None` falls back to an env/CWD/dist probe.
    pub bootstrap_skill: Option<PathBuf>,
    /// Base dir for resolving a bundled example by relative path in
    /// `/api/read-skill`. `None` keeps absolute-path-only behaviour.
    pub examples_base: Option<PathBuf>,
    /// Optional bearer token. `None` = no auth (loopback). `Some` = require
    /// `Authorization: Bearer <token>` on every request (the SSH case).
    pub token: Option<String>,
    /// Worker-thread count.
    pub workers: usize,
    /// Run `sweep_orphans` / `reap_orphans` / `prefetch_model` on start. The
    /// standalone binary owns this; an embedding process (the desktop) that does
    /// its own lifecycle sets it `false` so the chores don't run twice.
    pub startup_maintenance: bool,
    /// The SSH connection manager (desktop only). `None` = a plain server with no
    /// remoting (the standalone binary, or browser-local dev). When set, the server
    /// serves `/api/remote/*` and proxies the rest of `/api/*` to the connected remote.
    pub remote: Option<Arc<dyn RemoteControl>>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 0,
            dist: PathBuf::from("dist"),
            bootstrap_skill: None,
            examples_base: None,
            token: None,
            workers: 4,
            startup_maintenance: true,
            remote: None,
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
        // Reap terminals / inference engines orphaned by a previous backend that
        // died hard, then warm the model so the first commit draft is fast.
        skill_term::sweep_orphans();
        engine::reap_orphans();
        engine::prefetch_model();
    }

    let ctx = Arc::new(ServerCtx {
        dist: cfg.dist,
        bootstrap_skill: cfg.bootstrap_skill,
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
    bootstrap_skill: Option<PathBuf>,
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

/// Serialize a `Reply` onto the wire with the standard CORS + no-store headers, then
/// any reply-specific `extra` headers. Shared by local handlers and the proxy.
pub(crate) fn send_reply(request: Request, reply: Reply) {
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

/// Locate the bundled `skill-studio` activation skill so setup can install it.
/// Honors `SKILL_BOOTSTRAP_SKILL`, else looks relative to CWD and the dist dir.
fn bootstrap_skill_dir(dist: &Path) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SKILL_BOOTSTRAP_SKILL") {
        let pb = PathBuf::from(p);
        if pb.join("SKILL.md").exists() {
            return Some(pb);
        }
    }
    let candidates = [
        PathBuf::from("skills/skill-studio"),
        dist.join("../skills/skill-studio"),
        dist.join("skills/skill-studio"),
    ];
    candidates.into_iter().find(|c| c.join("SKILL.md").exists())
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
        (Method::Get, "/api/discover") => json_reply(discover::discover_all()),
        (Method::Post, "/api/read-skill") => {
            let root = skill::resolve_skill_input(&s("path"), ctx.examples_base.as_deref());
            json_reply(skill::build_raw_skill(&root))
        }
        (Method::Post, "/api/read-file") => json_reply(skill::read_file_impl(&s("root"), &s("rel"))),
        (Method::Post, "/api/write-file") => {
            json_reply(skill::write_file_impl(&s("root"), &s("rel"), &s("content")).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/read-image") => json_reply(skill::read_image_impl(&s("root"), &s("rel"))),
        (Method::Post, "/api/list-dir") => json_reply(skill::list_dir_impl(&s("path"))),
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
        (Method::Post, "/api/detect-required-env") => {
            let root = s("root");
            json_reply(secrets::secret_keys().map(|keys| skill::scan_for_env_vars(Path::new(&root), &keys)))
        }
        (Method::Post, "/api/git-info") => json_reply(gitops::git_info(&s("root"))),
        (Method::Post, "/api/git-init") => json_reply(gitops::git_init(&s("root"))),
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
        (Method::Get, "/api/commit-model-status") => json_reply(Ok(engine::model_status())),
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
        (Method::Get, "/api/secrets-status") => json_reply(secrets::secrets_status()),
        (Method::Get, "/api/secrets-list") => json_reply(secrets::secrets_list()),
        (Method::Post, "/api/secret-set") => {
            json_reply(secrets::secret_set(&s("key"), &s("value")).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/secret-delete") => {
            json_reply(secrets::secret_delete(&s("key")).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/secrets-setup") => {
            let bootstrap = ctx.bootstrap_skill.clone().or_else(|| bootstrap_skill_dir(&ctx.dist));
            json_reply(secrets::secrets_setup(bootstrap.as_deref()))
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
