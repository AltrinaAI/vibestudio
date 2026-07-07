//! Where VibeStudio keeps its per-user state on disk. One helper so every module
//! (secrets, recents, the remote-connection memory) resolves the SAME directory:
//! `$XDG_CONFIG_HOME/vibestudio` or `~/.config/vibestudio`.
use std::path::PathBuf;
use std::sync::Once;

/// The config directory. Honors `XDG_CONFIG_HOME`, else `~/.config/vibestudio`.
pub fn config_dir() -> Result<PathBuf, String> {
    let dir = resolve_config_dir()?;
    migrate_legacy_config_dir();
    Ok(dir)
}

fn resolve_config_dir() -> Result<PathBuf, String> {
    if let Ok(x) = std::env::var("XDG_CONFIG_HOME") {
        if !x.is_empty() {
            return Ok(PathBuf::from(x).join("vibestudio"));
        }
    }
    let home = dirs::home_dir().ok_or_else(|| "Cannot locate home directory.".to_string())?;
    Ok(home.join(".config").join("vibestudio"))
}

/// One-time carry-over from the pre-rebrand config dir (`skill-studio` →
/// `vibestudio`): the first time the renamed build runs, move an existing user's
/// secrets/connections/mining across instead of silently orphaning them. Fires
/// only when the new dir is absent and the old one is present; best-effort — a
/// fresh dir is created regardless if the rename fails.
fn migrate_legacy_config_dir() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let Ok(new) = resolve_config_dir() else { return };
        if new.exists() {
            return;
        }
        if let Some(old) = new.parent().map(|p| p.join("skill-studio")) {
            if old.is_dir() {
                let _ = std::fs::rename(&old, &new);
            }
        }
    });
}

/// The config dir, created if absent (0700 on unix). For writers.
pub fn ensure_config_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}
