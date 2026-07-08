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
    /// is set the path is on that remote, so open it over VS Code Remote-SSH. When
    /// `conversation` is set and the folder is LOCAL, also resume that agent
    /// conversation in the editor (see [`open_conversation`]).
    fn open(
        &self,
        path: &str,
        remote_host: Option<&str>,
        conversation: Option<skill_server::AgentConversation<'_>>,
    ) -> Result<(), String> {
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
            .map_err(|e| format!("failed to launch {name}: {e}"))?;

        // Also resume the exact conversation in the agent's IDE surface, but only for
        // a LOCAL session: a remote's transcript store lives on the far host, and an
        // OS-delivered `vscode://` URI reaches only this machine's extension host, so
        // firing it at a remote session would resume nothing (or start a blank chat).
        // The URI scheme follows the resolved build (Insiders listens on its own),
        // so we never wake a stable VS Code the user doesn't run.
        if remote_host.is_none() {
            let scheme = if name.contains("Insiders") { "vscode-insiders" } else { "vscode" };
            if let Some(c) =
                conversation.and_then(|c| conversation_uri(c.agent, c.session_id, scheme))
            {
                open_conversation(c);
            }
        }
        Ok(())
    }
}

/// The IDE deep link (under URL `scheme`, e.g. `vscode` / `vscode-insiders`) that
/// reopens conversation `session_id` for agent family `agent`, or `None` when the
/// agent has no such handler. Claude Code's is the only one that exists today —
/// `<scheme>://anthropic.claude-code/open?session=<id>` opens or focuses a chat tab
/// resumed at that session (the id must belong to the folder we open alongside it,
/// which it does: it's that session's cwd). The other agents' conversations still
/// surface in their own extensions' history, because those read the same on-disk
/// session store — there is just no link to jump straight to one.
fn conversation_uri(agent: &str, session_id: &str, scheme: &str) -> Option<String> {
    // The id goes into a URL unescaped, so accept only the token shape we mint
    // (`--session-id` UUIDs) — anything else is skipped rather than risk mangling.
    let safe = !session_id.is_empty()
        && session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    match agent {
        "claude" if safe => {
            Some(format!("{scheme}://anthropic.claude-code/open?session={session_id}"))
        }
        _ => None,
    }
}

/// Hand a `vscode://` deep link to the OS URL opener, after a short delay so the
/// folder window opened just before it has time to take focus — the handler targets
/// whichever VS Code window is focused. Detached and best-effort: the editor is the
/// user's feedback, so a miss here never fails or blocks the folder open.
fn open_conversation(uri: String) {
    // Long enough for an already-running VS Code to focus the folder window; a cold
    // start takes longer, and there the link may open a fresh tab — an acceptable
    // degrade, not a failure.
    const FOCUS_SETTLE_MS: u64 = 1500;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(FOCUS_SETTLE_MS));
        let _ = url_opener(&uri).spawn();
    });
}

/// The platform command that hands a URL to its registered handler — the same
/// invocations the Claude Code docs show (`open` / `xdg-open` / `start`).
fn url_opener(uri: &str) -> Command {
    // (program, args that precede the URL). On Windows cmd's `start` reads its first
    // quoted argument as a window title, so pass an empty title before the URL
    // (matches the docs' cmd.exe example).
    #[cfg(target_os = "macos")]
    let (prog, pre): (&str, &[&str]) = ("open", &[]);
    #[cfg(windows)]
    let (prog, pre): (&str, &[&str]) = ("cmd", &["/C", "start", ""]);
    #[cfg(not(any(target_os = "macos", windows)))]
    let (prog, pre): (&str, &[&str]) = ("xdg-open", &[]);
    let mut c = hidden_command(prog);
    c.args(pre).arg(uri);
    c
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

#[cfg(test)]
mod tests {
    use super::conversation_uri;

    #[test]
    fn claude_conversation_deep_link() {
        // The documented handler, built under whichever build's scheme resolved.
        assert_eq!(
            conversation_uri("claude", "1e4f2a3b-0000-4c5d-8e9f-abcdef012345", "vscode").as_deref(),
            Some("vscode://anthropic.claude-code/open?session=1e4f2a3b-0000-4c5d-8e9f-abcdef012345"),
        );
        // Insiders listens on its own scheme, so a stable VS Code is never woken.
        assert_eq!(
            conversation_uri("claude", "abc123", "vscode-insiders").as_deref(),
            Some("vscode-insiders://anthropic.claude-code/open?session=abc123"),
        );
    }

    #[test]
    fn no_link_for_other_agents_or_unsafe_ids() {
        // Only Claude Code has an IDE deep link today.
        assert_eq!(conversation_uri("codex", "abc123", "vscode"), None);
        assert_eq!(conversation_uri("opencode", "ses_123", "vscode"), None);
        // The id lands in a URL unescaped, so anything but the UUID shape is skipped
        // (empty, whitespace, or URL metacharacters that would mangle the link).
        assert_eq!(conversation_uri("claude", "", "vscode"), None);
        assert_eq!(conversation_uri("claude", "has space", "vscode"), None);
        assert_eq!(conversation_uri("claude", "a&b=c", "vscode"), None);
        assert_eq!(conversation_uri("claude", "../etc", "vscode"), None);
    }
}
