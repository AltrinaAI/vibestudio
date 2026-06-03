//! On-device LLM engine: a managed `llama-server` (llama.cpp) child process.
//!
//! We shell out to the battle-tested prebuilt `llama-server` rather than linking
//! an inference library into the binary — same philosophy as `gitops` shelling
//! out to `git` and `skill_term` supervising child processes, and it keeps the
//! release profile's small-binary goals intact (no cmake / C++ toolchain).
//!
//! Lifecycle: lazily spawned on first use, bound to `127.0.0.1` on an ephemeral
//! port, kept warm in a global for the session, and reaped on app/server exit.
//! GPU is attempted first (`-ngl 99`, auto-selecting Metal/Vulkan/CUDA via the
//! engine's dynamic backends); on failure it falls back to CPU (`-ngl 0`) so it
//! runs everywhere. The model is a single GGUF downloaded on first use (or
//! pointed at a local file for airgapped installs), never bundled in the binary.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

// ───────────────────────────── model catalog ─────────────────────────────

/// A downloadable GGUF model + the context window to run it with.
struct ModelSpec {
    /// Stable id (selectable via `SKILL_STUDIO_COMMIT_MODEL`).
    id: &'static str,
    /// Hugging Face repo (`<owner>/<name>`).
    repo: &'static str,
    /// GGUF filename within the repo.
    file: &'static str,
    /// Expected SHA-256 of the file. `None` skips verification — MUST be pinned
    /// to the real digest before shipping (see plan's "risk gate").
    sha256: Option<&'static str>,
    /// Context window to start the server with (tokens).
    ctx: u32,
}

/// Default: the user's pick. Qwen3.5 small models default thinking OFF, which is
/// what we want for terse messages. It is new (Mar 2026) — keep the proven
/// Qwen2.5-Coder-1.5B available as a fallback via `SKILL_STUDIO_COMMIT_MODEL`.
const QWEN35_2B: ModelSpec = ModelSpec {
    id: "qwen3.5-2b",
    repo: "bartowski/Qwen_Qwen3.5-2B-GGUF",
    file: "Qwen_Qwen3.5-2B-Q4_K_M.gguf",
    sha256: Some("57a1085840f497d764a7fc5d346922dbde961efb54cc792ea81d694fd846a1d8"), // 1.40 GB
    ctx: 8192,
};

/// Code-aware, plain-instruct (no thinking), universally supported by llama.cpp.
const QWEN25_CODER_1_5B: ModelSpec = ModelSpec {
    id: "qwen2.5-coder-1.5b",
    repo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
    file: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
    sha256: Some("cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046"), // 1.12 GB
    ctx: 8192,
};

fn active_spec() -> &'static ModelSpec {
    match std::env::var("SKILL_STUDIO_COMMIT_MODEL").as_deref() {
        Ok("qwen2.5-coder-1.5b") => &QWEN25_CODER_1_5B,
        _ => &QWEN35_2B,
    }
}

/// Public view of model readiness, for the UI's first-run / download messaging.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    /// The active model's id.
    model: String,
    /// The GGUF is present on disk (so generation won't trigger a download).
    downloaded: bool,
    /// On-disk size in MB (when present).
    size_mb: Option<u64>,
    /// Where the GGUF lives / will be cached.
    path: String,
}

pub fn model_status() -> ModelStatus {
    let spec = active_spec();
    let path = model_path(spec);
    let (downloaded, size_mb) = match path.as_ref().ok().and_then(|p| std::fs::metadata(p).ok()) {
        Some(m) => (true, Some(m.len() / 1_000_000)),
        None => (false, None),
    };
    ModelStatus {
        model: spec.id.to_string(),
        downloaded,
        size_mb,
        path: path.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

// ───────────────────────────── model on disk ─────────────────────────────

/// Directory the GGUF is cached in: `$SKILL_STUDIO_MODEL_DIR` or the per-OS data
/// dir (`~/Library/Application Support`, `%APPDATA%`, `$XDG_DATA_HOME`) under
/// `skill-studio/models`.
fn model_dir() -> Result<PathBuf, String> {
    if let Ok(d) = std::env::var("SKILL_STUDIO_MODEL_DIR") {
        if !d.is_empty() {
            return Ok(PathBuf::from(d));
        }
    }
    let base = dirs::data_dir().ok_or_else(|| "Cannot locate a data directory for models.".to_string())?;
    Ok(base.join("skill-studio").join("models"))
}

fn model_path(spec: &ModelSpec) -> Result<PathBuf, String> {
    Ok(model_dir()?.join(spec.file))
}

/// Resolve the model to a usable local GGUF, downloading it on first use.
/// A local override (`SKILL_STUDIO_COMMIT_MODEL_PATH`) wins — for airgapped /
/// WSL2 installs that import a `.gguf` manually.
fn ensure_model() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("SKILL_STUDIO_COMMIT_MODEL_PATH") {
        if !p.is_empty() {
            let path = PathBuf::from(p);
            return if path.exists() {
                Ok(path)
            } else {
                Err(format!("SKILL_STUDIO_COMMIT_MODEL_PATH does not exist: {}", path.display()))
            };
        }
    }
    let spec = active_spec();
    let path = model_path(spec)?;
    if path.exists() {
        return Ok(path);
    }
    download_model(spec, &path)?;
    Ok(path)
}

/// Stream the GGUF to a `.part` file, verify SHA-256 (when pinned), then
/// atomically rename into place so a partial download is never used.
fn download_model(spec: &ModelSpec, dest: &PathBuf) -> Result<(), String> {
    use sha2::{Digest, Sha256};

    let dir = dest.parent().ok_or_else(|| "Bad model path.".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create model dir: {e}"))?;

    let url = format!("https://huggingface.co/{}/resolve/main/{}", spec.repo, spec.file);
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .build();
    let resp = agent
        .get(&url)
        .call()
        .map_err(|e| format!("Couldn't download the model ({}): {e}", spec.id))?;

    let part = dest.with_extension("part");
    let mut out = std::fs::File::create(&part).map_err(|e| format!("Couldn't write model file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 1 << 20]; // 1 MiB
    loop {
        let n = reader.read(&mut buf).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("Download interrupted: {e}")
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        std::io::Write::write_all(&mut out, &buf[..n]).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("Couldn't write model file: {e}")
        })?;
    }
    drop(out);

    if let Some(expected) = spec.sha256 {
        let got = hasher.finalize();
        let got_hex = got.iter().map(|b| format!("{b:02x}")).collect::<String>();
        if !got_hex.eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(&part);
            return Err(format!("Model checksum mismatch (expected {expected}, got {got_hex}). Refusing to use it."));
        }
    }
    std::fs::rename(&part, dest).map_err(|e| format!("Couldn't finalize model file: {e}"))?;
    Ok(())
}

// ──────────────────────────── server process ────────────────────────────

/// Layers to offload to the GPU when attempting acceleration. 999 = "all";
/// llama.cpp clamps to the model's layer count and auto-selects an available
/// backend (Metal/Vulkan/CUDA), so this is a no-op on CPU-only machines.
const GPU_NGL: u32 = 999;
/// How long to wait for the server's `/health` to report ready (model load).
const READY_TIMEOUT: Duration = Duration::from_secs(180);

struct Engine {
    child: Child,
    port: u16,
}

impl Engine {
    fn exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)) | Err(_))
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn engine() -> &'static Mutex<Option<Engine>> {
    static ENGINE: OnceLock<Mutex<Option<Engine>>> = OnceLock::new();
    ENGINE.get_or_init(|| Mutex::new(None))
}

/// Resolve the `llama-server` executable: env override, then next to our own
/// binary (where a Tauri externalBin sidecar lands), then `PATH`.
fn engine_binary() -> PathBuf {
    if let Ok(p) = std::env::var("SKILL_STUDIO_LLAMA_SERVER") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let exe_name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join(exe_name);
            if cand.exists() {
                return cand;
            }
        }
    }
    PathBuf::from(exe_name) // fall back to PATH lookup
}

/// Prepend the engine binary's directory to the platform's dynamic-library search
/// path for the spawned child, so llama.cpp's sibling shared libs always load.
fn add_lib_path(cmd: &mut Command, dir: &std::path::Path) {
    let d = dir.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    {
        let prev = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{d};{prev}"));
    }
    #[cfg(target_os = "macos")]
    {
        let prev = std::env::var("DYLD_LIBRARY_PATH").unwrap_or_default();
        cmd.env("DYLD_LIBRARY_PATH", if prev.is_empty() { d } else { format!("{d}:{prev}") });
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let prev = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
        cmd.env("LD_LIBRARY_PATH", if prev.is_empty() { d } else { format!("{d}:{prev}") });
    }
}

/// Bind to port 0 to let the OS pick a free port, then release it for the child.
fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("No free port: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port) // listener dropped here → port freed for llama-server
}

fn spawn_one(model: &PathBuf, ctx: u32, ngl: u32) -> Result<Engine, String> {
    let port = free_port()?;
    let bin = engine_binary();
    let mut cmd = Command::new(&bin);
    cmd.args([
        "-m",
        &model.to_string_lossy(),
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "-c",
        &ctx.to_string(),
        "-ngl",
        &ngl.to_string(),
        "--jinja", // honor the model's chat template (Qwen3.5 defaults thinking off)
    ])
    .stdout(Stdio::null())
    // Surface llama-server's own logs when debugging; silent otherwise.
    .stderr(if std::env::var_os("SKILL_STUDIO_COMMIT_DEBUG").is_some() {
        Stdio::inherit()
    } else {
        Stdio::null()
    });
    // Bundled/vendored llama.cpp ships its shared libs next to the binary; make
    // the dynamic loader find them (rpath=$ORIGIN usually covers it, but be explicit).
    if let Some(dir) = bin.parent() {
        if !dir.as_os_str().is_empty() {
            add_lib_path(&mut cmd, dir);
        }
    }
    let child = cmd.spawn().map_err(|e| {
        format!(
            "Couldn't start the local AI engine (llama-server): {e}. \
             It should ship with the app; for a dev build run scripts/fetch-engine.sh, \
             or set SKILL_STUDIO_LLAMA_SERVER to a llama-server path."
        )
    })?;

    let mut engine = Engine { child, port };
    match wait_ready(&mut engine) {
        Ok(()) => Ok(engine),
        Err(e) => {
            drop(engine); // kills the child
            Err(e)
        }
    }
}

/// Spawn the engine, trying GPU offload first then falling back to CPU.
fn spawn_engine(model: &PathBuf, ctx: u32) -> Result<Engine, String> {
    match spawn_one(model, ctx, GPU_NGL) {
        Ok(e) => Ok(e),
        Err(_) => spawn_one(model, ctx, 0), // GPU init failed → CPU
    }
}

/// Poll `/health` until it returns 200 (only then is the model loaded and ready)
/// or the child dies / we time out.
fn wait_ready(engine: &mut Engine) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/health", engine.port);
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(500))
        .timeout_read(Duration::from_secs(2))
        .build();
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if engine.exited() {
            return Err("The local AI engine exited before it was ready.".into());
        }
        if agent.get(&url).call().is_ok() {
            return Ok(()); // 200 → model loaded (503 while loading comes back as Err)
        }
        if Instant::now() >= deadline {
            return Err("The local AI engine didn't become ready in time.".into());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

// ─────────────────────────────── chat call ───────────────────────────────

/// One OpenAI-style chat message.
#[derive(Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn new(role: &str, content: impl Into<String>) -> Self {
        ChatMessage { role: role.to_string(), content: content.into() }
    }
}

/// Send a chat completion to the (lazily started, warm-kept) engine and return
/// the assistant's text. Serialized through a global lock — one generation at a
/// time, which is all a single-user desktop needs.
pub fn chat(messages: &[ChatMessage], max_tokens: u32, temperature: f32) -> Result<String, String> {
    let model = ensure_model()?;
    let ctx = active_spec().ctx;

    let mut guard = engine().lock().map_err(|_| "AI engine state is unavailable.".to_string())?;
    if guard.as_mut().map(|e| e.exited()).unwrap_or(true) {
        *guard = Some(spawn_engine(&model, ctx)?);
    }
    let port = guard.as_ref().unwrap().port;

    #[derive(Serialize)]
    struct ChatRequest<'a> {
        messages: &'a [ChatMessage],
        max_tokens: u32,
        temperature: f32,
        /// Fixed seed so the same diff produces the same message (re-clicking
        /// Generate no longer reshuffles the wording).
        seed: i64,
        stream: bool,
        /// Forwarded to the model's chat template. Qwen3/Qwen3.5 default thinking
        /// ON, which buries the answer in a <think> block and leaves `content`
        /// empty — fatal for terse commit messages. Disabling it yields the message
        /// directly. Harmless for non-thinking models (the kwarg is just unused).
        chat_template_kwargs: serde_json::Value,
    }
    let body = serde_json::to_string(&ChatRequest {
        messages,
        max_tokens,
        temperature,
        seed: 42,
        stream: false,
        chat_template_kwargs: serde_json::json!({ "enable_thinking": false }),
    })
    .map_err(|e| format!("Couldn't build the AI request: {e}"))?;

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(180))
        .build();
    let resp = agent
        .post(&format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .set("Content-Type", "application/json")
        .send_string(&body);

    // A dead/broken server can leave a stale handle — drop it so the next call respawns.
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            *guard = None;
            return Err(format!("The local AI engine failed to respond: {e}"));
        }
    };

    let text = resp.into_string().map_err(|e| format!("Couldn't read the AI response: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Unexpected AI response: {e}"))?;
    json.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "The AI returned an empty response.".to_string())
}

/// Reap the engine child (call on app/server exit so nothing is orphaned).
pub fn shutdown() {
    if let Ok(mut guard) = engine().lock() {
        *guard = None; // Drop kills + waits the child
    }
}

/// Kill any stray `llama-server` left over from a previous run that was
/// hard-killed before it could reap its engine (e.g. a `tauri dev` rebuild that
/// SIGKILLs the app). Matches OUR resolved engine binary path, so it never
/// touches an unrelated llama-server the user runs. Call once at startup —
/// before any engine is spawned — mirroring `skill_term::sweep_orphans`.
pub fn reap_orphans() {
    let needle = engine_binary().to_string_lossy().into_owned();
    if needle.is_empty() {
        return;
    }
    #[cfg(unix)]
    {
        let Ok(out) = Command::new("ps").args(["-eo", "pid=,args="]).output() else {
            return;
        };
        if !out.status.success() {
            return;
        }
        let me = std::process::id();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let Some((pid_s, args)) = line.trim_start().split_once(char::is_whitespace) else {
                continue;
            };
            if !args.contains(&needle) {
                continue;
            }
            if let Ok(pid) = pid_s.parse::<u32>() {
                if pid != me {
                    let _ = Command::new("kill").arg(pid.to_string()).output(); // SIGTERM
                }
            }
        }
    }
    #[cfg(windows)]
    {
        // Best-effort on Windows: kill our bundled engine by image name.
        let _ = Command::new("taskkill").args(["/F", "/IM", "llama-server.exe"]).output();
    }
}
