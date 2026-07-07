//! Open a folder in the user's local VS Code — the "Open in VS Code" affordance
//! on the Sessions page. Pure server-side: locate the `code` CLI and shell out
//! `code <dir>` through the one sanctioned spawn (`hidden_command`).
//!
//! Locating `code` can't lean on PATH alone: a packaged desktop app is launched
//! from the dock/menu with a stripped login PATH (notably macOS — `/usr/bin:/bin`
//! only), so VS Code installed the usual way wouldn't be on it. We search PATH
//! first, then the well-known install locations per OS (including the CLI shim
//! inside the macOS `.app` bundle). These routes are pinned local + gated on
//! `from_this_machine` by the server, so this only ever opens on the screen the
//! user is actually at — never a remote host or the desktop behind a phone.
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use crate::process::hidden_command;

/// The VS Code CLIs we recognize, best first. Both are "VS Code".
const EDITORS: &[(&str, &str)] = &[("code", "VS Code"), ("code-insiders", "VS Code Insiders")];

/// Whether a local VS Code is reachable, for the UI to show/hide the button.
/// `{ available, name }` — `name` distinguishes stable from Insiders.
pub fn status() -> Value {
    match locate() {
        Some((_, name)) => json!({ "available": true, "name": name }),
        None => json!({ "available": false }),
    }
}

/// Launch VS Code on `path` (a session's working directory). Non-blocking — we
/// spawn and return; the editor window is the user's feedback.
pub fn open(path: &str) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("no folder to open".into());
    }
    let (bin, name) = locate().ok_or("VS Code (the `code` command) was not found on this machine")?;
    spawn_command(&bin)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch {name}: {e}"))
}

/// The first recognized editor's resolved binary, with its display name.
fn locate() -> Option<(PathBuf, &'static str)> {
    for (cli, name) in EDITORS {
        if let Some(p) = resolve(cli) {
            return Some((p, name));
        }
    }
    None
}

/// PATH first (the common case), then the OS's well-known install locations.
fn resolve(cli: &str) -> Option<PathBuf> {
    search_path(cli).or_else(|| known_locations(cli).into_iter().find(|p| p.is_file()))
}

fn search_path(cli: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        exe_names(cli).into_iter().map(|n| dir.join(n)).find(|c| c.is_file())
    })
}

/// Candidate filenames for `cli` in a PATH dir. Windows ships `code.cmd` (a shim)
/// and `Code.exe`; elsewhere the bare name.
fn exe_names(cli: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![format!("{cli}.cmd"), format!("{cli}.exe"), cli.to_string()]
    }
    #[cfg(not(windows))]
    {
        vec![cli.to_string()]
    }
}

/// Well-known absolute install paths for `cli`, the fallback when PATH is stripped.
fn known_locations(cli: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        v.push(PathBuf::from("/usr/local/bin").join(cli));
        v.push(PathBuf::from("/opt/homebrew/bin").join(cli));
        // The CLI shim inside the .app — the reliable path for a dock-launched
        // app whose PATH is `/usr/bin:/bin` only.
        if cli == "code" {
            let app = "Visual Studio Code.app/Contents/Resources/app/bin/code";
            v.push(PathBuf::from("/Applications").join(app));
            if let Some(home) = std::env::var_os("HOME") {
                v.push(PathBuf::from(home).join("Applications").join(app));
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        for base in ["/usr/bin", "/usr/local/bin", "/snap/bin", "/var/lib/flatpak/exports/bin"] {
            v.push(PathBuf::from(base).join(cli));
        }
        if let Some(home) = std::env::var_os("HOME") {
            v.push(PathBuf::from(home).join(".local/bin").join(cli));
        }
    }

    #[cfg(windows)]
    {
        // Prefer the real Code.exe (a PE binary spawns directly); fall back to the
        // bin\*.cmd shim, launched via `cmd /C` in spawn_command.
        let exe = if cli == "code" { "Code.exe" } else { "Code - Insiders.exe" };
        for var in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(var) {
                let root = PathBuf::from(base).join("Microsoft VS Code");
                v.push(root.join(exe));
                v.push(root.join("bin").join(format!("{cli}.cmd")));
            }
        }
    }

    v
}

/// A spawn builder for `bin`. On Windows a `.cmd`/`.bat` shim isn't a PE binary,
/// so it must be run through `cmd /C`; everything else spawns directly.
fn spawn_command(bin: &Path) -> Command {
    #[cfg(windows)]
    {
        if bin.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat")) {
            let mut c = hidden_command("cmd");
            c.arg("/C").arg(bin);
            return c;
        }
    }
    hidden_command(bin)
}
