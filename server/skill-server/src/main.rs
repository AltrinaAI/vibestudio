// CLI entry for the standalone `skill-server` — a remote host reached over an
// `ssh -L` tunnel, or browser-local dev (`cargo run -p skill-server`). The serve
// loop lives in the library (src/lib.rs); this only parses argv and logs. The
// desktop shell embeds the same library in-process instead of spawning this.
//
// Usage: skill-server [--host H] [--port N] [--dist PATH]
//   defaults: --host 127.0.0.1  --port 8765  --dist ./dist  (override with SKILL_DIST)
use std::path::PathBuf;

use skill_server::{spawn, ServerConfig};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut host = "127.0.0.1".to_string();
    let mut port: u16 = 8765;
    let mut dist = std::env::var("SKILL_DIST").unwrap_or_else(|_| "dist".to_string());
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--host" => { i += 1; host = args.get(i).cloned().unwrap_or(host); }
            "--port" => { i += 1; port = args.get(i).and_then(|p| p.parse().ok()).unwrap_or(port); }
            "--dist" => { i += 1; dist = args.get(i).cloned().unwrap_or(dist); }
            _ => {}
        }
        i += 1;
    }
    let dist = PathBuf::from(dist);
    let bind = format!("{host}:{port}");

    let cfg = ServerConfig {
        host,
        port,
        dist: dist.clone(),
        startup_maintenance: true,
        ..Default::default()
    };
    let handle = match spawn(cfg) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("skill-server: failed to bind {bind}: {e}");
            std::process::exit(1);
        }
    };
    println!("skill-server listening on {}  (dist: {})", handle.url(), dist.display());
    if !dist.join("index.html").is_file() {
        println!("  note: {} has no index.html — run `npm run build` to serve the UI.", dist.display());
    }
    handle.join();
}
