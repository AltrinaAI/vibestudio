// Filesystem layer, ported from the original lib/server.ts. Transport-agnostic
// (no Tauri) — reused by the desktop commands and the headless server.
use std::collections::BTreeSet;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use zip::write::SimpleFileOptions;

use crate::filetypes;
use crate::pathsafe::{normalize_lexical, resolve_root, resolve_within_real};

const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024; // 2 MB
const MAX_TREE_ENTRIES: i64 = 5000;
const MAX_TOTAL: u64 = 100 * 1024 * 1024; // 100 MB zip cap
const IGNORED_DIRS: [&str; 5] = [".git", "node_modules", ".next", "__pycache__", ".venv"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    name: String,
    rel: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_skill_md: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<TreeNode>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSkill {
    root: String,
    dir_name: String,
    raw: String,
    tree: Vec<TreeNode>,
    files: Vec<String>,
    file_count: usize,
    dir_count: usize,
    total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    rel: String,
    category: String,
    language: String,
    label: String,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    too_large: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_binary: Option<bool>,
}

#[derive(Serialize)]
pub struct ImageData {
    pub mime: String,
    pub base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    is_dir: bool,
    is_skill: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    path: String,
    parent: Option<String>,
    entries: Vec<DirEntry>,
}

fn to_posix(abs: &Path, root: &Path) -> String {
    let rel = abs.strip_prefix(root).unwrap_or(abs);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

struct BuildAcc {
    files: Vec<String>,
    file_count: usize,
    dir_count: usize,
    total_bytes: u64,
    budget: i64,
}

fn walk_tree(dir: &Path, root: &Path, acc: &mut BuildAcc) -> Vec<TreeNode> {
    let mut entries: Vec<_> = match std::fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => return vec![],
    };
    entries.sort_by(|a, b| {
        let a_is_file = a.file_type().map(|t| !t.is_dir()).unwrap_or(true);
        let b_is_file = b.file_type().map(|t| !t.is_dir()).unwrap_or(true);
        a_is_file
            .cmp(&b_is_file)
            .then_with(|| a.file_name().cmp(&b.file_name()))
    });

    let mut nodes = Vec::new();
    for entry in entries {
        if acc.budget <= 0 {
            break;
        }
        acc.budget -= 1;

        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let abs = dir.join(&name);
        let rel = to_posix(&abs, root);

        if ft.is_dir() {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            acc.dir_count += 1;
            let children = walk_tree(&abs, root, acc);
            nodes.push(TreeNode {
                name,
                rel,
                kind: "dir".into(),
                size: None,
                category: None,
                language: None,
                label: None,
                is_skill_md: None,
                children: Some(children),
            });
        } else if ft.is_file() {
            acc.file_count += 1;
            let size = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
            acc.total_bytes += size;
            acc.files.push(rel.clone());
            let (category, language, label) = filetypes::file_type(&name);
            let is_skill_md = rel == "SKILL.md";
            nodes.push(TreeNode {
                name,
                rel,
                kind: "file".into(),
                size: Some(size),
                category: Some(category.into()),
                language: Some(language.into()),
                label: Some(label.into()),
                is_skill_md: Some(is_skill_md),
                children: None,
            });
        }
    }
    nodes
}

/// Resolve a skill path: `~`/absolute via resolve_root; a relative path (bundled
/// examples) against `examples_base`, then the working dir.
pub fn resolve_skill_input(input: &str, examples_base: Option<&Path>) -> PathBuf {
    let trimmed = input.trim();
    if trimmed == "~" || trimmed.starts_with("~/") || Path::new(trimmed).is_absolute() {
        return resolve_root(trimmed);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(base) = examples_base {
        candidates.push(base.join(trimmed));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(trimmed));
    }
    for c in &candidates {
        if c.exists() {
            return normalize_lexical(c);
        }
    }
    normalize_lexical(&candidates.into_iter().next().unwrap_or_else(|| PathBuf::from(trimmed)))
}

/// Read + analyze a skill directory.
pub fn build_raw_skill(root: &Path) -> Result<RawSkill, String> {
    let meta = std::fs::metadata(root).map_err(|_| format!("Path not found: {}", root.display()))?;
    if !meta.is_dir() {
        return Err(format!("Not a directory: {}", root.display()));
    }
    let skill_md = root.join("SKILL.md");
    if !skill_md.exists() {
        return Err(format!(
            "No SKILL.md found in {}. A skill directory must contain a SKILL.md file.",
            root.display()
        ));
    }
    let raw = std::fs::read_to_string(&skill_md).map_err(|e| format!("Failed to read SKILL.md: {e}"))?;

    let mut acc = BuildAcc {
        files: Vec::new(),
        file_count: 0,
        dir_count: 0,
        total_bytes: 0,
        budget: MAX_TREE_ENTRIES,
    };
    let tree = walk_tree(root, root, &mut acc);
    let dir_name = root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    Ok(RawSkill {
        root: root.to_string_lossy().into_owned(),
        dir_name,
        raw,
        tree,
        files: acc.files,
        file_count: acc.file_count,
        dir_count: acc.dir_count,
        total_bytes: acc.total_bytes,
    })
}

pub fn read_file_impl(root: &str, rel: &str) -> Result<FileView, String> {
    let root_path = PathBuf::from(root);
    let abs = resolve_within_real(&root_path, rel, true)?;
    let meta = std::fs::metadata(&abs).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("Not a file: {rel}"));
    }
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (category, language, label) = filetypes::file_type(&name);
    let size = meta.len();

    let mut view = FileView {
        rel: rel.to_string(),
        category: category.into(),
        language: language.into(),
        label: label.into(),
        size,
        content: None,
        too_large: None,
        is_binary: None,
    };

    if filetypes::is_image(&name) {
        return Ok(view);
    }
    if size > MAX_TEXT_BYTES {
        view.too_large = Some(true);
        return Ok(view);
    }
    let bytes = std::fs::read(&abs).map_err(|e| e.to_string())?;
    if !filetypes::is_textual(&name) && bytes.contains(&0u8) {
        view.is_binary = Some(true);
        view.category = "binary".into();
        return Ok(view);
    }
    view.content = Some(String::from_utf8_lossy(&bytes).into_owned());
    Ok(view)
}

pub fn write_file_impl(root: &str, rel: &str, content: &str) -> Result<(), String> {
    let root_path = PathBuf::from(root);
    let abs = resolve_within_real(&root_path, rel, false)?;
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&abs, content).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn read_image_impl(root: &str, rel: &str) -> Result<ImageData, String> {
    let root_path = PathBuf::from(root);
    let abs = resolve_within_real(&root_path, rel, true)?;
    let meta = std::fs::metadata(&abs).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("File not found: {rel}"));
    }
    let bytes = std::fs::read(&abs).map_err(|e| e.to_string())?;
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(ImageData {
        mime: filetypes::image_mime(&name).into(),
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

/// List subdirectories of `path` (for a remote folder picker). Shows hidden dirs
/// (skills live under e.g. ~/.codex) and flags which dirs are skills.
pub fn list_dir_impl(path: &str) -> Result<DirListing, String> {
    let p = if path.trim().is_empty() {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
    } else {
        resolve_root(path)
    };
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_dir() {
        return Err(format!("Not a directory: {}", p.display()));
    }
    let mut entries = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&p) {
        for e in rd.filter_map(|e| e.ok()) {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let is_skill = p.join(&name).join("SKILL.md").exists();
            entries.push(DirEntry {
                name,
                is_dir: true,
                is_skill,
            });
        }
    }
    entries.sort_by_key(|e| e.name.to_lowercase());
    Ok(DirListing {
        path: p.to_string_lossy().into_owned(),
        parent: p.parent().map(|pp| pp.to_string_lossy().into_owned()),
        entries,
    })
}

/// Resolve + validate a skill root and return (filename, zip bytes). When
/// `env_vars` is non-empty, the values of those (managed) secrets are rendered
/// into a `.env` inside the bundle so the recipient can run it immediately —
/// the opt-in "bundle secrets" path. Names absent from the store are skipped.
pub fn zip_skill_bytes(root_input: &str, env_vars: &[String]) -> Result<(String, Vec<u8>), String> {
    let root = resolve_root(root_input);
    let meta = std::fs::metadata(&root).map_err(|_| format!("Skill not found: {}", root.display()))?;
    if !meta.is_dir() {
        return Err(format!("Skill not found: {}", root.display()));
    }
    if !root.join("SKILL.md").exists() {
        return Err("Not a skill directory (no SKILL.md).".into());
    }
    let dir_name = root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "skill".into());
    let buf = build_zip(&root, &dir_name, env_vars)?;
    Ok((format!("{dir_name}.zip"), buf))
}

fn build_zip(root: &Path, dir_name: &str, env_vars: &[String]) -> Result<Vec<u8>, String> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::<u8>::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut total: u64 = 0;
    walk_zip(root, "", dir_name, &mut zip, &options, &mut total)?;
    if !env_vars.is_empty() {
        let body = crate::secrets::render_dotenv(env_vars)?;
        if !body.is_empty() {
            zip.start_file(format!("{dir_name}/.env"), options)
                .map_err(|e| e.to_string())?;
            zip.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
        }
    }
    let cursor = zip.finish().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

fn walk_zip(
    dir: &Path,
    prefix: &str,
    dir_name: &str,
    zip: &mut zip::ZipWriter<Cursor<Vec<u8>>>,
    options: &SimpleFileOptions,
    total: &mut u64,
) -> Result<(), String> {
    let rd = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in rd.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        let abs = entry.path();
        if ft.is_dir() {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_zip(&abs, &format!("{prefix}{name}/"), dir_name, zip, options, total)?;
        } else if ft.is_file() {
            // Never ship a `.env` from disk — it's secret-bearing, and the opt-in
            // bundle writes an authoritative one (so this also avoids a duplicate
            // `{dir_name}/.env` zip entry when both exist).
            if name == ".env" {
                continue;
            }
            let data = match std::fs::read(&abs) {
                Ok(d) => d,
                Err(_) => continue,
            };
            *total += data.len() as u64;
            if *total > MAX_TOTAL {
                return Err("Skill is too large to download.".into());
            }
            zip.start_file(format!("{dir_name}/{prefix}{name}"), *options)
                .map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Extract a `.zip`'s bytes into `dest_dir`, returning the directory that holds
/// SKILL.md — the inverse of [`zip_skill_bytes`]. Defends against zip-slip (entries
/// that escape `dest_dir` via `..`/absolute paths) and the 100 MB total cap. The
/// returned path is `dest_dir` itself when SKILL.md sits at the archive root, or the
/// single wrapping subdir (our export's `name/SKILL.md` layout).
pub fn extract_zip(bytes: &[u8], dest_dir: &Path) -> Result<PathBuf, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Not a valid .zip: {e}"))?;
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // `enclosed_name` is None for any entry that would escape the root.
        let out = match entry.enclosed_name() {
            Some(rel) => dest_dir.join(rel),
            None => return Err("Refusing to extract: the archive contains an unsafe path.".into()),
        };
        if !out.starts_with(dest_dir) {
            return Err("Refusing to extract: the archive contains an unsafe path.".into());
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        total += entry.size();
        if total > MAX_TOTAL {
            return Err("Archive is too large to import.".into());
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&out, &buf).map_err(|e| e.to_string())?;
    }
    find_skill_root(dest_dir).ok_or_else(|| "The archive has no SKILL.md (not a skill).".into())
}

/// Locate the directory containing SKILL.md: `base` itself, or a single top-level
/// subdirectory (the common `name/SKILL.md` layout). Searches one level deep.
fn find_skill_root(base: &Path) -> Option<PathBuf> {
    if base.join("SKILL.md").exists() {
        return Some(base.to_path_buf());
    }
    let rd = std::fs::read_dir(base).ok()?;
    for entry in rd.filter_map(|e| e.ok()) {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let cand = entry.path();
            if cand.join("SKILL.md").exists() {
                return Some(cand);
            }
        }
    }
    None
}

/// Scan a skill's text files for which of `candidates` (env-var names) appear as
/// whole tokens, so the `metadata.required-env` declaration can be auto-detected
/// from the secrets the scripts actually reference. Skips symlinks, IGNORED_DIRS,
/// oversized files, and binaries. Returns the matched names, sorted.
pub fn scan_for_env_vars(root: &Path, candidates: &[String]) -> Vec<String> {
    let mut found: BTreeSet<String> = BTreeSet::new();
    scan_dir(root, candidates, &mut found);
    found.into_iter().collect()
}

fn scan_dir(dir: &Path, candidates: &[String], found: &mut BTreeSet<String>) {
    if candidates.iter().all(|c| found.contains(c)) {
        return; // nothing left to look for
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        let abs = entry.path();
        if ft.is_dir() {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            scan_dir(&abs, candidates, found);
        } else if ft.is_file() {
            let meta = match std::fs::metadata(&abs) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() > MAX_TEXT_BYTES {
                continue;
            }
            let bytes = match std::fs::read(&abs) {
                Ok(b) => b,
                Err(_) => continue,
            };
            if bytes.contains(&0u8) {
                continue; // binary
            }
            let text = String::from_utf8_lossy(&bytes);
            for c in candidates {
                if !found.contains(c) && contains_token(&text, c) {
                    found.insert(c.clone());
                }
            }
        }
    }
}

/// True if `needle` occurs in `hay` not flanked by another identifier char, so
/// `OPENAI_API_KEY` matches `$OPENAI_API_KEY` but not `MY_OPENAI_API_KEY_2`.
fn contains_token(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let bytes = hay.as_bytes();
    for (pos, _) in hay.match_indices(needle) {
        let before_ok = pos == 0 || !is_ident_byte(bytes[pos - 1]);
        let after = pos + needle.len();
        let after_ok = after >= bytes.len() || !is_ident_byte(bytes[after]);
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

fn is_ident_byte(b: u8) -> bool {
    b == b'_' || b.is_ascii_alphanumeric()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_boundary_rejects_substrings() {
        assert!(contains_token("export OPENAI_API_KEY=x", "OPENAI_API_KEY"));
        assert!(contains_token("\"OPENAI_API_KEY\"", "OPENAI_API_KEY"));
        assert!(contains_token("os.environ['GITHUB_TOKEN']", "GITHUB_TOKEN"));
        assert!(!contains_token("MY_OPENAI_API_KEY_2", "OPENAI_API_KEY"));
        assert!(!contains_token("OPENAI_API_KEYS", "OPENAI_API_KEY"));
    }

    #[test]
    fn scan_detects_referenced_keys_only() {
        let base = std::env::temp_dir().join(format!("ass_scan_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("scripts")).unwrap();
        std::fs::write(base.join("SKILL.md"), "Reads OPENAI_API_KEY at runtime.").unwrap();
        std::fs::write(base.join("scripts/run.sh"), "#!/bin/sh\necho \"$GITHUB_TOKEN\"\n").unwrap();
        // A near-miss substring must NOT trigger UNUSED_KEY's cousin.
        std::fs::write(base.join("notes.txt"), "see MY_OPENAI_API_KEY_2 elsewhere").unwrap();

        let candidates = vec![
            "OPENAI_API_KEY".to_string(),
            "GITHUB_TOKEN".to_string(),
            "UNUSED_KEY".to_string(),
        ];
        let found = scan_for_env_vars(&base, &candidates);
        assert_eq!(found, vec!["GITHUB_TOKEN".to_string(), "OPENAI_API_KEY".to_string()]);
        let _ = std::fs::remove_dir_all(&base);
    }
}
