// Headless HTTP server for the WSL2 / remote-backend mode. Serves the built UI
// (dist/) and a /api/* JSON endpoint that mirrors the Tauri commands, all from
// one origin so a browser can run the app against this machine's filesystem.
//
// Usage: skill-server [--port N] [--host H] [--dist PATH]
//   defaults: --host 127.0.0.1  --port 8765  --dist ./dist
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};
use skill_core::{discover, gitops, secrets, skill, sync};
use tiny_http::{Header, Method, Response, Server};

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
    // Reject traversal; only serve within dist.
    let candidate = if rel.is_empty() {
        dist.join("index.html")
    } else if rel.contains("..") {
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

fn handle(method: &Method, url: &str, body: &str, dist: &Path) -> Reply {
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
            let root = skill::resolve_skill_input(&s("path"), None);
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
        (Method::Post, "/api/detect-required-env") => {
            let root = s("root");
            json_reply(secrets::secret_keys().map(|keys| skill::scan_for_env_vars(Path::new(&root), &keys)))
        }
        (Method::Post, "/api/git-info") => json_reply(gitops::git_info(&s("root"))),
        (Method::Post, "/api/git-init") => json_reply(gitops::git_init(&s("root"))),
        (Method::Post, "/api/git-commit") => json_reply(gitops::git_commit(&s("root"), &s("message"))),
        (Method::Post, "/api/git-log") => {
            let limit = v.get("limit").and_then(|x| x.as_u64()).unwrap_or(20) as usize;
            json_reply(gitops::git_log(&s("root"), limit))
        }
        (Method::Get, "/api/secrets-status") => json_reply(secrets::secrets_status()),
        (Method::Get, "/api/secrets-list") => json_reply(secrets::secrets_list()),
        (Method::Post, "/api/secret-set") => {
            json_reply(secrets::secret_set(&s("key"), &s("value")).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/secret-delete") => {
            json_reply(secrets::secret_delete(&s("key")).map(|_| json!({ "ok": true })))
        }
        (Method::Post, "/api/secrets-setup") => {
            json_reply(secrets::secrets_setup(bootstrap_skill_dir(dist).as_deref()))
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
        (Method::Get, _) => serve_static(dist, path),
        _ => Reply {
            status: 404,
            body: serde_json::to_vec(&json!({ "error": "Not found" })).unwrap_or_default(),
            content_type: "application/json".into(),
            extra: vec![],
        },
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut host = "127.0.0.1".to_string();
    let mut port = "8765".to_string();
    let mut dist = std::env::var("SKILL_DIST").unwrap_or_else(|_| "dist".to_string());
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--host" => { i += 1; host = args.get(i).cloned().unwrap_or(host); }
            "--port" => { i += 1; port = args.get(i).cloned().unwrap_or(port); }
            "--dist" => { i += 1; dist = args.get(i).cloned().unwrap_or(dist); }
            _ => {}
        }
        i += 1;
    }
    let dist = PathBuf::from(dist);
    let addr = format!("{host}:{port}");

    let server = match Server::http(&addr) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("skill-server: failed to bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    println!("skill-server listening on http://{addr}  (dist: {})", dist.display());
    if !dist.join("index.html").is_file() {
        println!("  note: {} has no index.html — run `npm run build` to serve the UI.", dist.display());
    }

    let mut workers = Vec::new();
    for _ in 0..4 {
        let server = Arc::clone(&server);
        let dist = dist.clone();
        workers.push(thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let method = request.method().clone();
                let url = request.url().to_string();
                let mut body = String::new();
                if method == Method::Post {
                    let _ = request.as_reader().read_to_string(&mut body);
                }
                let reply = handle(&method, &url, &body, &dist);

                let mut response = Response::from_data(reply.body).with_status_code(reply.status);
                let headers = [
                    ("Content-Type", reply.content_type.as_str()),
                    ("Access-Control-Allow-Origin", "*"),
                    ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
                    ("Access-Control-Allow-Headers", "Content-Type"),
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
        }));
    }
    for w in workers {
        let _ = w.join();
    }
}
