//! The one place a child process is constructed. Everything that shells out —
//! git, ssh, wsl.exe, nvidia-smi, the llama-server engine, tmux, agent
//! `--version` probes — goes through `hidden_command`, so it spawns with
//! CREATE_NO_WINDOW on Windows. A packaged GUI app has no console to reuse, so
//! without that flag each invocation flashes its own console window; a burst of
//! them on connect/startup reads as windows popping up everywhere. The flag is a
//! no-op off Windows. A clippy `disallowed-methods` rule (see `clippy.toml`)
//! turns the raw `Command::new` into an error so a new call site can't forget.
use std::ffi::OsStr;
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Construct a `Command` that won't flash a console window on Windows. Use this
/// in place of `Command::new` for every spawn (the lint enforces it).
pub fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    // The single sanctioned `Command::new`: every other call site routes here.
    #[allow(clippy::disallowed_methods)]
    let mut cmd = Command::new(program);
    hide_window(&mut cmd);
    cmd
}

/// Apply the no-window flag to a command you already hold a builder for.
/// `hidden_command` is the usual entry point; reach for this only when the
/// `Command` was constructed elsewhere.
pub fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}
