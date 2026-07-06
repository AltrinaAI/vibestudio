//! Where VibeStudio keeps its per-user state on disk. One helper so every module
//! (secrets, recents, the remote-connection memory) resolves the SAME directory:
//! `$XDG_CONFIG_HOME/skill-studio` or `~/.config/skill-studio`.
use std::path::PathBuf;

/// The config directory. Honors `XDG_CONFIG_HOME`, else `~/.config/skill-studio`.
pub fn config_dir() -> Result<PathBuf, String> {
    if let Ok(x) = std::env::var("XDG_CONFIG_HOME") {
        if !x.is_empty() {
            return Ok(PathBuf::from(x).join("skill-studio"));
        }
    }
    let home = dirs::home_dir().ok_or_else(|| "Cannot locate home directory.".to_string())?;
    Ok(home.join(".config").join("skill-studio"))
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
