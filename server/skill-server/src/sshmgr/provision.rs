//! Remote OS/arch detection + version-pinned `skill-server` provisioning — modelled
//! on how VS Code bootstraps its server: detect the platform, reuse an already
//! installed binary at a versioned path, else download it (remote `curl`/`wget`, or,
//! for a no-internet remote, a local download piped over the SSH connection).
use std::io::Read;
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::ssh;

/// Idempotent remote install: reuse a runnable binary, else download (curl/wget) to a
/// temp file, verify it against the published `.sha256` (best-effort — skipped only if
/// the checksum asset or a hasher is absent), and atomically move it into place. Exit
/// codes the caller interprets: 3 = no downloader (→ pipe fallback), 4 = checksum
/// mismatch. `__VERSION__`/`__URL__` are substituted (raw string ⇒ shell braces are
/// literal, unlike `format!`).
const INSTALL_SCRIPT: &str = r#"set -e
ver="__VERSION__"
dir="$HOME/.skill-studio/server/$ver"
bin="$dir/skill-server"
if [ -x "$bin" ] && "$bin" --version >/dev/null 2>&1; then echo INSTALLED; exit 0; fi
mkdir -p "$dir"
url="__URL__"
tmp="$bin.tmp.$$"
dl() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; return $?; fi
  if command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"; return $?; fi
  return 3
}
if dl "$url" "$tmp"; then :; else
  rc=$?
  if [ "$rc" = 3 ]; then echo NO_DOWNLOADER >&2; exit 3; fi
  echo DOWNLOAD_FAILED >&2; exit 1
fi
expected=$(dl "$url.sha256" - 2>/dev/null | awk '{print $1}')
if [ -n "$expected" ]; then
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$tmp" | awk '{print $1}')
  else actual=""; fi
  if [ -n "$actual" ] && [ "$expected" != "$actual" ]; then rm -f "$tmp"; echo CHECKSUM_MISMATCH >&2; exit 4; fi
fi
chmod +x "$tmp"
mv -f "$tmp" "$bin"
echo DOWNLOADED
"#;

/// The no-downloader fallback's remote side: receive the binary on stdin, install it.
const PIPE_SCRIPT: &str = r#"set -e
dir="$HOME/.skill-studio/server/__VERSION__"
mkdir -p "$dir"
tmp="$dir/skill-server.tmp.$$"
cat > "$tmp"
chmod +x "$tmp"
mv -f "$tmp" "$dir/skill-server"
"#;

/// The release version whose `skill-server` asset we install. Defaults to the running
/// app's version (`app_version`, taken from `tauri.conf.json`, which CI stamps from
/// the release tag); override with `SKILL_STUDIO_SERVER_VERSION`. Either way it must
/// match a published release tag `v<version>` carrying the `skill-server-*` assets.
pub fn server_version(app_version: &str) -> String {
    std::env::var("SKILL_STUDIO_SERVER_VERSION")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| app_version.to_string())
}

/// Base URL the remote downloads the binary from. Defaults to this repo's GitHub
/// Releases; override with `SKILL_STUDIO_SERVER_BASE_URL` (no trailing slash; the
/// asset name `skill-server-<target>` is appended).
fn base_url(version: &str) -> String {
    std::env::var("SKILL_STUDIO_SERVER_BASE_URL")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            format!("https://github.com/AltrinaAI/skills-studio/releases/download/v{version}")
        })
}

/// A detected remote platform — the rust target triple naming its release asset.
pub struct Platform {
    pub target: &'static str,
}

/// Detect the remote OS/arch via `uname -sm`. Linux/macOS only; a Windows remote (no
/// `uname`) yields a clear not-yet-supported error.
pub fn detect(host: &str) -> Result<Platform, String> {
    let out = ssh::capture(host, "uname -sm")
        .map_err(|e| format!("Couldn't reach the remote (note: Windows remotes aren't supported yet). {e}"))?;
    let u = out.trim();
    let target = if u.starts_with("Linux") && u.contains("x86_64") {
        "x86_64-unknown-linux-musl"
    } else if u.starts_with("Linux") && (u.contains("aarch64") || u.contains("arm64")) {
        "aarch64-unknown-linux-musl"
    } else if u.starts_with("Darwin") && u.contains("arm64") {
        "aarch64-apple-darwin"
    } else if u.starts_with("Darwin") && u.contains("x86_64") {
        "x86_64-apple-darwin"
    } else if u.is_empty() {
        return Err("Couldn't detect the remote platform (Windows remotes aren't supported yet).".into());
    } else {
        return Err(format!("Unsupported remote platform: {u}"));
    };
    Ok(Platform { target })
}

/// Ensure the version-pinned `skill-server` is installed on the remote; returns its
/// path (with a literal `$HOME` for the remote shell to expand). Idempotent.
pub fn ensure_installed(host: &str, platform: &Platform, app_version: &str) -> Result<String, String> {
    let version = server_version(app_version);
    let bin = format!("$HOME/.skill-studio/server/{version}/skill-server");
    let url = format!("{}/skill-server-{}", base_url(&version), platform.target);

    let script = INSTALL_SCRIPT.replace("__VERSION__", &version).replace("__URL__", &url);

    match ssh::run(host, &script) {
        Ok(_) => Ok(bin),
        // Exit 3 = the remote has neither curl nor wget → download here and pipe it
        // over the same ssh transport (works for no-internet remotes / through ProxyJump).
        Err(e) if e.code == Some(3) => {
            install_via_pipe(host, &version, &url)?;
            Ok(bin)
        }
        // Exit 4 = the downloaded binary didn't match the published checksum.
        Err(e) if e.code == Some(4) => Err(
            "The downloaded skill-server failed its checksum check (possible corruption or tampering). Aborted.".into(),
        ),
        Err(e) => Err(format!("Failed to install skill-server on the remote: {}", e.message)),
    }
}

/// No-downloader fallback: fetch the asset on THIS machine (verifying its checksum
/// here, since the remote can't reach the network), then stream it to the remote over
/// ssh (`cat > tmp && chmod +x && mv`).
fn install_via_pipe(host: &str, version: &str, url: &str) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(120))
        .build();
    let resp = agent.get(url).call().map_err(|e| format!("Local download of {url} failed: {e}"))?;
    let mut bytes: Vec<u8> = Vec::new();
    resp.into_reader()
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Reading the downloaded binary failed: {e}"))?;

    // Best-effort integrity check against the published `.sha256` (skip only if that
    // asset is unavailable, e.g. an older release).
    if let Ok(sum_resp) = agent.get(&format!("{url}.sha256")).call() {
        let mut sum = String::new();
        let _ = sum_resp.into_reader().read_to_string(&mut sum);
        if let Some(expected) = sum.split_whitespace().next().filter(|s| !s.is_empty()) {
            let actual: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
            if !expected.eq_ignore_ascii_case(&actual) {
                return Err("The downloaded skill-server failed its checksum check (possible corruption or tampering).".into());
            }
        }
    }

    let script = PIPE_SCRIPT.replace("__VERSION__", version);
    ssh::run_with_stdin(host, &script, &bytes)
        .map_err(|e| format!("Piping skill-server to the remote failed: {}", e.message))
}
