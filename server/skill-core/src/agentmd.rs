// AGENTS.md auto-discovery — the cross-agent project-guide standard (agents.md).
// An AGENTS.md is a single Markdown file an agent reads on task start: the build
// /test commands, conventions, and boundaries it would otherwise re-learn every
// session. Unlike a skill it is NOT a folder with a manifest — it's one file,
// nearest-wins, so a repo can carry several (one per package/subdir).
//
// We surface two scopes:
//   * "global"  — a guide in a well-known per-agent home dir (read for every repo)
//   * "project" — a guide inside a git repo under the home directory
//
// The editor reads/writes a guide with the existing `read-file`/`write-file`
// routes: `dir` is the root and `file` (always "AGENTS.md") is the rel path.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use walkdir::WalkDir;

/// The canonical file name of the standard. Matched case-insensitively on disk
/// (a lowercase `agents.md` is still surfaced; the client linter flags the
/// casing) but always reported with its real on-disk spelling.
const GUIDE_FILE: &str = "AGENTS.md";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsDoc {
    /// Absolute path to the guide file.
    path: String,
    /// Directory holding it — the "root" passed to read-file / write-file (the
    /// guide's rel path is just its file name).
    dir: String,
    /// File name as spelled on disk (normally "AGENTS.md").
    file: String,
    /// First Markdown H1 (`# …`), when present — a human label for the card.
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    /// "global" (a per-agent home dir) | "project" (inside a repo under home).
    scope: String,
    /// Repo/folder name for a project guide; None for a global one.
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    /// Path of the guide relative to its repo root (e.g. "AGENTS.md" or
    /// "packages/api/AGENTS.md") — lets the UI show WHERE in the repo it lives.
    #[serde(skip_serializing_if = "Option::is_none")]
    rel_in_project: Option<String>,
    /// Byte size on disk.
    size: u64,
}

/// True when `name` is the guide file (case-insensitive).
fn is_guide(name: &str) -> bool {
    name.eq_ignore_ascii_case(GUIDE_FILE)
}

/// Read a guide's first H1 title + size. Only the head of the file is scanned
/// for the title (the title is conventionally line 1).
fn read_title_size(path: &Path) -> (Option<String>, u64) {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let title = std::fs::read_to_string(path).ok().and_then(|raw| first_h1(&raw));
    (title, size)
}

/// The first ATX `# ` heading, skipping fenced code blocks (a `# comment` inside
/// a ``` fence isn't a heading). Scans only the head of the document.
fn first_h1(raw: &str) -> Option<String> {
    let mut in_fence = false;
    for line in raw.lines().take(80) {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let title = rest.trim().trim_end_matches('#').trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn push_doc(
    path: &Path,
    scope: &str,
    project: Option<String>,
    rel_in_project: Option<String>,
    out: &mut Vec<AgentsDoc>,
    seen: &mut HashSet<PathBuf>,
) {
    let Some(file) = path.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    if !is_guide(file) || !path.is_file() {
        return;
    }
    let canon = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !seen.insert(canon) {
        return; // already found via another root
    }
    let (title, size) = read_title_size(path);
    let dir = path
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    out.push(AgentsDoc {
        path: path.to_string_lossy().into_owned(),
        dir,
        file: file.to_string(),
        title,
        scope: scope.to_string(),
        project,
        rel_in_project,
        size,
    });
}

/// Well-known home locations agents read a global AGENTS.md from.
fn collect_global(home: &Path, out: &mut Vec<AgentsDoc>, seen: &mut HashSet<PathBuf>) {
    let globals = [
        home.join(".codex").join(GUIDE_FILE),
        home.join(".claude").join(GUIDE_FILE),
        home.join(".config").join(GUIDE_FILE),
        home.join(".agents").join(GUIDE_FILE),
        home.join(GUIDE_FILE),
    ];
    for p in globals {
        push_doc(&p, "global", None, None, out, seen);
    }
}

// Non-hidden heavyweight dirs to never descend into. Hidden dirs are pruned
// wholesale (a project AGENTS.md lives at a repo/package root, not inside a
// dotdir — and the home dotdirs are scanned by `collect_global`).
const PRUNE: &[&str] = &[
    "node_modules", "target", "dist", "build", "out", "vendor", "Pods", "coverage",
    "venv", "__pycache__", "site-packages", "Library", "AppData",
];

/// True if the project walk should NOT descend into `path`.
fn prune_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if PRUNE.contains(&name) {
        return true;
    }
    // Go module cache (~/go/pkg/mod) — third-party deps, not your projects.
    if name == "pkg"
        && path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()) == Some("go")
    {
        return true;
    }
    // Every hidden dir (.git, .cache, .config, .claude, .vscode, …).
    name.starts_with('.')
}

/// The nearest ancestor directory (inclusive) that is a git repo root, bounded
/// to within `home`. None when the guide isn't inside a tracked repo.
fn enclosing_repo(dir: &Path, home: &Path) -> Option<PathBuf> {
    let mut cur = Some(dir);
    while let Some(d) = cur {
        if !d.starts_with(home) {
            break;
        }
        if d.join(".git").exists() {
            return Some(d.to_path_buf());
        }
        cur = d.parent();
    }
    None
}

/// Walk repos under `home` for project-scoped AGENTS.md files, bounded by an
/// entry budget + wall-clock (mirrors the skill project scan).
fn scan_project_guides(home: &Path, out: &mut Vec<AgentsDoc>, seen: &mut HashSet<PathBuf>) {
    let start = Instant::now();
    let mut budget: i64 = 1_000_000;
    let walker = WalkDir::new(home)
        .follow_links(false)
        .max_depth(12)
        .into_iter()
        .filter_entry(|e| !prune_dir(e.path()));
    for entry in walker.filter_map(|e| e.ok()) {
        budget -= 1;
        if budget <= 0 || start.elapsed().as_secs() >= 6 {
            break;
        }
        if !entry.file_type().is_file() || !is_guide(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let path = entry.path();
        let Some(dir) = path.parent() else {
            continue;
        };
        // Only guides that actually live inside a repo are "project" guides.
        let Some(repo) = enclosing_repo(dir, home) else {
            continue;
        };
        let project = repo
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "project".into());
        let rel_in_project = path
            .strip_prefix(&repo)
            .ok()
            .map(|r| r.to_string_lossy().replace('\\', "/"));
        push_doc(path, "project", Some(project), rel_in_project, out, seen);
    }
}

/// Discover AGENTS.md guides: global ones in per-agent home dirs, plus
/// project-scoped ones in git repos under the home directory.
pub fn discover_agents_md() -> Result<Vec<AgentsDoc>, String> {
    let home = dirs::home_dir().ok_or_else(|| "No home directory.".to_string())?;
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut out: Vec<AgentsDoc> = Vec::new();

    collect_global(&home, &mut out, &mut seen);
    scan_project_guides(&home, &mut out, &mut seen);

    // Global guides first, then grouped by project, then by path — a stable order
    // the UI can section without re-sorting.
    out.sort_by(|a, b| {
        let rank = |s: &str| if s == "global" { 0 } else { 1 };
        rank(&a.scope)
            .cmp(&rank(&b.scope))
            .then_with(|| a.project.cmp(&b.project))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_guide_name_case_insensitively() {
        assert!(is_guide("AGENTS.md"));
        assert!(is_guide("agents.md"));
        assert!(!is_guide("SKILL.md"));
        assert!(!is_guide("AGENT.md"));
    }

    #[test]
    fn first_h1_skips_fences_and_trims() {
        assert_eq!(
            first_h1("# My Project\n\nbody").as_deref(),
            Some("My Project")
        );
        assert_eq!(first_h1("no heading here\n## sub").as_deref(), None);
        // A `# ` inside a fenced block is not the title.
        assert_eq!(
            first_h1("```sh\n# not a title\n```\n# Real Title\n").as_deref(),
            Some("Real Title"),
        );
        assert_eq!(first_h1("#  Spaced  #\n").as_deref(), Some("Spaced"));
    }

    #[test]
    fn prunes_heavy_and_hidden_dirs() {
        assert!(prune_dir(Path::new("/h/proj/node_modules")));
        assert!(prune_dir(Path::new("/h/proj/.git")));
        assert!(prune_dir(Path::new("/h/.claude")));
        assert!(prune_dir(Path::new("/h/go/pkg")));
        assert!(!prune_dir(Path::new("/h/proj/src")));
        assert!(!prune_dir(Path::new("/h/proj/packages")));
    }

    #[test]
    fn discovers_a_planted_project_guide() {
        let base = std::env::temp_dir().join(format!("ass_agentmd_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // A repo (marked by .git) with a root guide and a nested package guide.
        let repo = base.join("myrepo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("packages").join("api")).unwrap();
        std::fs::write(repo.join("AGENTS.md"), "# My Repo\n\nRun `make`.\n").unwrap();
        std::fs::write(repo.join("packages/api/AGENTS.md"), "# API\n").unwrap();
        // A guide NOT in a repo is not a project guide.
        std::fs::create_dir_all(base.join("loose")).unwrap();
        std::fs::write(base.join("loose/AGENTS.md"), "# Loose\n").unwrap();

        let mut out = Vec::new();
        let mut seen = HashSet::new();
        scan_project_guides(&base, &mut out, &mut seen);

        let by_rel = |r: &str| out.iter().find(|d| d.rel_in_project.as_deref() == Some(r));
        assert_eq!(out.len(), 2, "two in-repo guides, the loose one excluded");
        let root = by_rel("AGENTS.md").expect("root guide");
        assert_eq!(root.project.as_deref(), Some("myrepo"));
        assert_eq!(root.title.as_deref(), Some("My Repo"));
        assert_eq!(root.scope, "project");
        let nested = by_rel("packages/api/AGENTS.md").expect("nested guide");
        assert_eq!(nested.project.as_deref(), Some("myrepo"));
        assert!(out.iter().all(|d| d.title.as_deref() != Some("Loose")));

        let _ = std::fs::remove_dir_all(&base);
    }

    // Real discovery against this machine; run with:
    // cargo test -p skill-core -- --nocapture live_agentmd_smoke
    #[test]
    fn live_agentmd_smoke() {
        let docs = discover_agents_md().expect("discovery should not error");
        println!(
            "\n=== live AGENTS.md discovery: {} guide(s) ===",
            docs.len()
        );
        for d in &docs {
            println!(
                "  [{}]{}  {}",
                d.scope,
                d.project
                    .as_deref()
                    .map(|p| format!("  ({p})"))
                    .unwrap_or_default(),
                d.path
            );
        }
    }
}
