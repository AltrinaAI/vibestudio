//! Reveal a file in the OS file manager — the "Reveal in folder" affordance next
//! to an export confirmation, which opens Finder / Explorer / the desktop's file
//! browser with the file selected. Pure server-side, spawned through the one
//! sanctioned `hidden_command`. Like `editor`, these routes are pinned local +
//! gated on `from_this_machine` by the server, so a window only ever opens on the
//! screen the user is actually at — never a remote host or the desktop behind a
//! phone.
use std::path::Path;

// iOS/Android have no file manager to shell out to; the fallback arm errors
// without spawning, so the import only exists where an arm uses it.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use crate::process::hidden_command;

/// Open the OS file manager with `path` selected. Best-effort and non-blocking:
/// the file-manager window is the user's feedback.
pub fn reveal(path: &str) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("no file to reveal".into());
    }
    let file = Path::new(path);
    if !file.exists() {
        return Err(format!("File not found: {path}"));
    }

    #[cfg(target_os = "macos")]
    {
        // `open -R` reveals (selects) the file in Finder.
        hidden_command("open")
            .arg("-R")
            .arg(file)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("couldn't reveal the file: {e}"))
    }

    #[cfg(target_os = "windows")]
    {
        // `explorer /select,<path>` opens the folder with the file highlighted.
        // explorer.exe often exits non-zero even on success, so we only require
        // that the spawn itself succeeded.
        hidden_command("explorer")
            .arg(format!("/select,{}", file.display()))
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("couldn't reveal the file: {e}"))
    }

    #[cfg(target_os = "linux")]
    {
        reveal_linux(file)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("revealing files isn't supported on this platform".into())
    }
}

/// Linux has no portable "select this file" primitive, so try the freedesktop
/// D-Bus call first (Nautilus, Dolphin, … select the item) and fall back to just
/// opening the containing folder — `xdg-open` can't select a file.
#[cfg(target_os = "linux")]
fn reveal_linux(file: &Path) -> Result<(), String> {
    let uri = format!("file://{}", file.display());
    let dbus = hidden_command("dbus-send")
        .args([
            "--session",
            "--dest=org.freedesktop.FileManager1",
            "--type=method_call",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItems",
        ])
        .arg(format!("array:string:{uri}"))
        .arg("string:")
        .spawn()
        .and_then(|mut c| c.wait());
    if matches!(dbus, Ok(status) if status.success()) {
        return Ok(());
    }
    let dir = file.parent().unwrap_or(file);
    hidden_command("xdg-open")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("couldn't open the folder: {e}"))
}
