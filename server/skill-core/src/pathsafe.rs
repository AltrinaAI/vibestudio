// Path resolution + symlink-escape containment, ported from lib/server.ts.
use std::path::{Component, Path, PathBuf};

/// Expand a leading `~` and lexically normalize to an absolute path.
pub fn resolve_root(input: &str) -> PathBuf {
    let p = input.trim();
    let expanded: PathBuf = if p == "~" {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from(p))
    } else if let Some(rest) = p.strip_prefix("~/") {
        match dirs::home_dir() {
            Some(h) => h.join(rest),
            None => PathBuf::from(p),
        }
    } else {
        PathBuf::from(p)
    };
    normalize_lexical(&expanded)
}

/// Collapse `.` and `..` lexically without touching the filesystem.
pub fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Lexically resolve `rel` inside `root`, refusing `..`/absolute escapes.
pub fn safe_resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let cleaned = rel.replace('\\', "/");
    let cleaned = cleaned.trim_start_matches('/');
    let abs = normalize_lexical(&root.join(cleaned));
    if abs != *root && !abs.starts_with(root) {
        return Err("Path escapes the skill directory.".into());
    }
    Ok(abs)
}

/// Resolve `rel` within `root` AND canonicalize with realpath so a symlink that
/// lives inside the skill folder but points outside it cannot escape the root.
/// For writes (`must_exist = false`) we canonicalize the nearest existing ancestor.
pub fn resolve_within_real(root: &Path, rel: &str, must_exist: bool) -> Result<PathBuf, String> {
    let abs = safe_resolve(root, rel)?;
    let real_root =
        std::fs::canonicalize(root).map_err(|_| "Skill directory not found.".to_string())?;

    // Canonicalize the nearest existing ancestor of `abs`.
    let mut probe = abs.clone();
    let real_probe = loop {
        match std::fs::canonicalize(&probe) {
            Ok(rp) => break Some(rp),
            Err(_) => {
                if !probe.pop() {
                    break None;
                }
            }
        }
    };
    let real_probe = real_probe.ok_or_else(|| "Path escapes the skill directory.".to_string())?;

    if real_probe != real_root && !real_probe.starts_with(&real_root) {
        return Err("Path escapes the skill directory.".into());
    }
    if must_exist && std::fs::canonicalize(&abs).is_err() {
        return Err(format!("File not found: {rel}"));
    }
    Ok(abs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_parent_escape() {
        let root = Path::new("/tmp/skillroot");
        // `..` traversal out of the root is rejected.
        assert!(safe_resolve(root, "../etc/passwd").is_err());
        assert!(safe_resolve(root, "a/../../b").is_err());
        // A leading slash is stripped (treated as relative-to-root), matching the
        // original server behavior — so this stays inside the root, not an escape.
        assert_eq!(safe_resolve(root, "/etc/passwd").unwrap(), root.join("etc/passwd"));
        assert!(safe_resolve(root, "ok/file.txt").is_ok());
        assert!(safe_resolve(root, "nested/../ok.txt").is_ok());
    }

    #[test]
    fn normalize_collapses_dots() {
        assert_eq!(normalize_lexical(Path::new("/a/b/../c")), PathBuf::from("/a/c"));
        assert_eq!(normalize_lexical(Path::new("/a/./b")), PathBuf::from("/a/b"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_blocked() {
        let base = std::env::temp_dir().join(format!("ass_pathsafe_{}", std::process::id()));
        let root = base.join("skill");
        let outside = base.join("outside");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        // Reading through a symlink that points outside the root must be rejected.
        assert!(resolve_within_real(&root, "link/secret.txt", true).is_err());

        // A normal in-root file is allowed.
        fs::write(root.join("inside.txt"), "x").unwrap();
        assert!(resolve_within_real(&root, "inside.txt", true).is_ok());

        let _ = fs::remove_dir_all(&base);
    }
}
