//! The shell's half of [`skill_server::EditorControl`] — the "Open in VS Code"
//! affordance on the Sessions page. Opening an editor acts on the machine whose
//! screen the user is at, so it lives HERE in the client shell, not in the
//! shippable `skill-core` backend (which also runs headless on a remote host and
//! must never try to pop a window). Reached only over the pinned-local
//! `/api/editor/*` route (never proxied), same one-way rule as `ShellNotifier`.
//!
//! When a remote is connected the folder lives on the remote, so we open it via
//! VS Code Remote-SSH (`code --remote ssh-remote+<host> <path>`) — a LOCAL window
//! attached over the same SSH the tunnel uses — instead of a local `code <path>`.
//!
//! Locating `code` can't lean on PATH alone: a packaged desktop app is launched
//! from the dock/menu with a stripped login PATH (notably macOS — `/usr/bin:/bin`
//! only), so VS Code installed the usual way wouldn't be on it. We search PATH
//! first, then the well-known install locations per OS (including the CLI shim
//! inside the macOS `.app` bundle).
use std::path::{Path, PathBuf};
use std::process::Command;

use skill_core::process::hidden_command;

/// The VS Code CLIs we recognize, best first. Both are "VS Code".
const EDITORS: &[(&str, &str)] = &[("code", "VS Code"), ("code-insiders", "VS Code Insiders")];

/// The shell's editor control, injected into the loopback server as `ctx.editor`.
pub struct ShellEditor;

impl skill_server::EditorControl for ShellEditor {
    /// The reachable editor's display name (`Some` → the button shows), or `None`.
    fn detect(&self) -> Option<String> {
        locate().map(|(_, name)| name.to_string())
    }

    /// Launch VS Code on `path` (a session's working directory). Non-blocking — we
    /// spawn and return; the editor window is the user's feedback. When `remote_host`
    /// is set the path is on that remote, so open it over VS Code Remote-SSH.
    fn open(&self, path: &str, remote_host: Option<&str>) -> Result<(), String> {
        let path = path.trim();
        if path.is_empty() {
            return Err("no folder to open".into());
        }
        let (bin, name) =
            locate().ok_or("VS Code (the `code` command) was not found on this machine")?;
        let mut cmd = spawn_command(&bin);
        if let Some(host) = remote_host {
            // `ssh-remote+<host>` is VS Code's remote authority; <host> is the same
            // ssh destination the tunnel uses (already validated at connect time,
            // so no option injection). A `:port` in the destination isn't honored
            // here — non-default ports belong in the user's ssh config. Requires the
            // Remote-SSH extension; without it VS Code opens and prompts to install.
            cmd.arg("--remote").arg(format!("ssh-remote+{host}"));
        }
        cmd.arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("failed to launch {name}: {e}"))
    }
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
