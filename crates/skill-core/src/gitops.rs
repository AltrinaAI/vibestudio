// Per-skill git version control. Shells out to the system `git` (like editors do)
// so no native git library is bundled. Every op is a no-op or a clear error when
// git is unavailable or the directory isn't a repository.
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    available: bool,
    is_repo: bool,
    in_parent_repo: bool,
    toplevel: Option<String>,
    branch: Option<String>,
    dirty: bool,
    has_remote: bool,
    has_identity: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    sha: String,
    summary: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// Full SHA — the handle used to fetch this commit's diff.
    sha: String,
    short: String,
    message: String,
    author: String,
    /// ISO-8601 author date (for an absolute-date tooltip).
    iso_date: String,
    relative_date: String,
    /// 1-based version number: the commit's position in linear history (first
    /// commit = 1, newest = total). Monotonic for the single-user, no-merge repos
    /// the studio creates.
    number: usize,
}

/// One entry in the working tree's change set (a `git status` line).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Path relative to the repo root (the new path for a rename).
    path: String,
    /// The previous path for a rename/copy.
    orig_path: Option<String>,
    /// added | modified | deleted | renamed | copied | untracked | typechange | unmerged
    kind: String,
    /// Recorded in the index (staged for the next commit).
    staged: bool,
    /// Differs in the working tree beyond what's staged.
    unstaged: bool,
}

/// The working tree's uncommitted state: a per-file summary plus one unified
/// diff covering every change (tracked edits vs HEAD + synthesized adds for
/// untracked files), so the UI can render the whole thing or slice it per file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff {
    files: Vec<FileChange>,
    /// Concatenated unified diff text (empty when the tree is clean).
    diff: String,
    /// The diff hit the size cap and was cut short.
    truncated: bool,
}

/// A single commit's metadata and its full unified diff (vs its first parent;
/// the root commit diffs against the empty tree).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    sha: String,
    short: String,
    subject: String,
    body: String,
    author: String,
    email: String,
    iso_date: String,
    relative_date: String,
    diff: String,
    truncated: bool,
    /// 1-based version number (this commit's position in linear history).
    number: usize,
}

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))
}

/// Run a git command, returning trimmed stdout only on success.
fn git_ok(root: &Path, args: &[&str]) -> Option<String> {
    let out = git(root, args).ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The skill's path within its repo, with a trailing slash (e.g. "skills/foo/"),
/// or "" when the skill *is* the repo's top level. git reports status/diff paths
/// from the repo root, so inside a parent repo we strip this to recover
/// skill-relative paths (what the rest of the studio works in).
fn repo_prefix(root: &Path) -> String {
    git_ok(root, &["rev-parse", "--show-prefix"]).unwrap_or_default()
}

/// Strip the repo prefix off a repo-root-relative path, yielding a skill-relative
/// one. A no-op when `prefix` is empty (the skill is its own repo).
fn strip_repo_prefix(path: &str, prefix: &str) -> String {
    path.strip_prefix(prefix).unwrap_or(path).to_string()
}

pub fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn git_info(root: &str) -> Result<GitInfo, String> {
    let root_path = PathBuf::from(root);
    let mut info = GitInfo {
        available: git_available(),
        ..Default::default()
    };
    if !info.available {
        return Ok(info);
    }
    let canon_root = std::fs::canonicalize(&root_path).unwrap_or_else(|_| root_path.clone());
    if let Some(top) = git_ok(&root_path, &["rev-parse", "--show-toplevel"]) {
        let canon_top = std::fs::canonicalize(&top).unwrap_or_else(|_| PathBuf::from(&top));
        info.toplevel = Some(canon_top.to_string_lossy().into_owned());
        if canon_top == canon_root {
            info.is_repo = true;
        } else {
            info.in_parent_repo = true;
        }
    }
    if info.is_repo {
        info.branch = git_ok(&root_path, &["branch", "--show-current"]).filter(|s| !s.is_empty());
        info.has_remote = git_ok(&root_path, &["remote"]).map(|s| !s.is_empty()).unwrap_or(false);
    }
    // `dirty` + identity are meaningful for your own repo AND for a skill living
    // inside a parent repo — scope the status to this folder (`-- .`) so changes
    // elsewhere in a parent repo don't count this skill as dirty.
    if info.is_repo || info.in_parent_repo {
        info.dirty = git_ok(&root_path, &["status", "--porcelain", "--", "."])
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        info.has_identity = git_ok(&root_path, &["config", "user.email"])
            .map(|s| !s.is_empty())
            .unwrap_or(false);
    }
    Ok(info)
}

/// A skill root paired with whether its own folder has uncommitted changes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyState {
    root: String,
    dirty: bool,
}

/// Batch "has uncommitted changes?" for the home page — one cheap
/// `git status --porcelain -- .` per skill root (scoped to the skill's own folder,
/// so changes elsewhere in a parent repo don't count). Roots not under git (or
/// when git is missing) report `dirty: false`. Far less chatter than a full
/// `git_info` round-trip per card.
pub fn git_dirty_many(roots: &[String]) -> Vec<DirtyState> {
    let available = git_available();
    roots
        .iter()
        .map(|r| {
            let dirty = available
                && git_ok(Path::new(r), &["status", "--porcelain", "--", "."])
                    .map(|s| !s.is_empty())
                    .unwrap_or(false);
            DirtyState { root: r.clone(), dirty }
        })
        .collect()
}

pub fn git_init(root: &str) -> Result<GitInfo, String> {
    if !git_available() {
        return Err("Git isn't installed.".into());
    }
    let root_path = PathBuf::from(root);
    let out = git(&root_path, &["init"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    git_info(root)
}

pub fn git_commit(root: &str, message: &str) -> Result<CommitResult, String> {
    if !git_available() {
        return Err("Git isn't installed.".into());
    }
    let root_path = PathBuf::from(root);
    let msg = message.trim();
    if msg.is_empty() {
        return Err("Enter a commit message.".into());
    }
    if git_ok(&root_path, &["config", "user.email"]).map(|s| s.is_empty()).unwrap_or(true) {
        return Err(
            "No git identity set. Run: git config --global user.email \"you@example.com\" (and user.name).".into(),
        );
    }
    let add = git(&root_path, &["add", "-A"])?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
    }
    let out = git(&root_path, &["commit", "-m", msg])?;
    if !out.status.success() {
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        if combined.contains("nothing to commit") {
            return Err("Nothing to commit — no changes since the last version.".into());
        }
        return Err(combined.trim().to_string());
    }
    Ok(CommitResult {
        sha: git_ok(&root_path, &["rev-parse", "HEAD"]).unwrap_or_default(),
        summary: git_ok(&root_path, &["log", "-1", "--pretty=%s"]).unwrap_or_default(),
    })
}

pub fn git_log(root: &str, limit: usize) -> Result<Vec<Commit>, String> {
    if !git_available() {
        return Ok(vec![]);
    }
    let root_path = PathBuf::from(root);
    let n = limit.clamp(1, 200).to_string();
    // Unit-separator (0x1f) between fields; newline between commits.
    let out = git(&root_path, &["log", "-n", &n, "--pretty=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%ar"])?;
    if !out.status.success() {
        return Ok(vec![]); // not a repo yet / no commits
    }
    // Total commits reachable from HEAD → the newest commit's version number.
    // Each line (newest first) is one history position, so line i has number
    // total - i, correct even when the log is capped below the total.
    let total: usize = git_ok(&root_path, &["rev-list", "--count", "HEAD"])
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let text = String::from_utf8_lossy(&out.stdout);
    let mut commits = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let parts: Vec<&str> = line.split('\u{1f}').collect();
        if parts.len() == 6 {
            commits.push(Commit {
                sha: parts[0].to_string(),
                short: parts[1].to_string(),
                message: parts[2].to_string(),
                author: parts[3].to_string(),
                iso_date: parts[4].to_string(),
                relative_date: parts[5].to_string(),
                number: total.saturating_sub(i),
            });
        }
    }
    Ok(commits)
}

/// Largest diff we ship to the UI. Skill repos are small; this only guards
/// against a stray huge/binary blob blowing up the payload.
const MAX_DIFF_BYTES: usize = 2_000_000;

/// True for a string git can safely take as a revision: a hex SHA (full or
/// abbreviated). Keeps caller-supplied values from being read as git options.
fn is_hex_rev(rev: &str) -> bool {
    let len = rev.len();
    (4..=64).contains(&len) && rev.chars().all(|c| c.is_ascii_hexdigit())
}

/// Map a porcelain XY code to (kind, staged, unstaged).
fn classify(code: &str) -> (&'static str, bool, bool) {
    if code == "??" {
        return ("untracked", false, true);
    }
    let x = code.chars().next().unwrap_or(' ');
    let y = code.chars().nth(1).unwrap_or(' ');
    let staged = x != ' ' && x != '?';
    let unstaged = y != ' ' && y != '?';
    let kind = if x == 'U' || y == 'U' || code == "AA" || code == "DD" {
        "unmerged"
    } else if x == 'R' || y == 'R' {
        "renamed"
    } else if x == 'C' || y == 'C' {
        "copied"
    } else if x == 'A' {
        "added"
    } else if x == 'D' || y == 'D' {
        "deleted"
    } else if x == 'T' || y == 'T' {
        "typechange"
    } else {
        "modified"
    };
    (kind, staged, unstaged)
}

/// Parse `git status --porcelain=v1 -z -uall` into a change list. The `-z`
/// stream is NUL-separated; a rename/copy entry is followed by its old path in
/// the next field, so we walk the tokens with a cursor rather than line-split.
fn parse_status(root: &Path) -> Vec<FileChange> {
    // `-- .` scopes the status to this folder so, when the skill lives inside a
    // larger parent repo, that repo's changes elsewhere don't show up here.
    let out = match git(root, &["status", "--porcelain=v1", "-z", "-uall", "--", "."]) {
        Ok(o) if o.status.success() => o.stdout,
        _ => return vec![],
    };
    // Paths come back relative to the repo root; inside a parent repo that carries
    // the skill's own sub-path prefix, which we strip to keep them skill-relative.
    let prefix = repo_prefix(root);
    let text = String::from_utf8_lossy(&out);
    let tokens: Vec<&str> = text.split('\0').filter(|t| !t.is_empty()).collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let entry = tokens[i];
        i += 1;
        if entry.len() < 3 {
            continue;
        }
        let code = &entry[..2];
        let path = strip_repo_prefix(&entry[3..], &prefix); // skip the single space after XY
        let (kind, staged, unstaged) = classify(code);
        let orig_path = if kind == "renamed" || kind == "copied" {
            // The old path is the following NUL-separated token.
            let p = tokens.get(i).map(|s| strip_repo_prefix(s, &prefix));
            i += 1;
            p
        } else {
            None
        };
        files.push(FileChange { path, orig_path, kind: kind.to_string(), staged, unstaged });
    }
    files
}

pub fn git_status(root: &str) -> Result<Vec<FileChange>, String> {
    if !git_available() {
        return Ok(vec![]);
    }
    Ok(parse_status(&PathBuf::from(root)))
}

/// Append `text` to `buf`, stopping once `buf` reaches `cap` bytes; returns true
/// if `text` was cut short.
fn push_capped(buf: &mut String, text: &str, cap: usize) -> bool {
    let room = cap.saturating_sub(buf.len());
    if text.len() <= room {
        buf.push_str(text);
        false
    } else {
        // Back off to a UTF-8 char boundary — slicing mid-character panics.
        let mut end = room;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        buf.push_str(&text[..end]);
        true
    }
}

pub fn git_worktree_diff(root: &str) -> Result<WorktreeDiff, String> {
    if !git_available() {
        return Err("Git isn't installed.".into());
    }
    let root_path = PathBuf::from(root);
    let files = parse_status(&root_path);

    let mut diff = String::new();
    let mut truncated = false;

    // Tracked edits vs the last commit (covers staged + unstaged). Skipped when
    // there are no commits yet (unborn HEAD) — those files show up as untracked.
    if git_ok(&root_path, &["rev-parse", "--verify", "HEAD"]).is_some() {
        // -M detects renames so a moved file reads as a rename (matching the
        // per-commit diff from `git show`) rather than a delete + add pair.
        // --relative confines the diff to this folder and rewrites its a/b paths
        // to be skill-relative — so a skill nested in a parent repo diffs cleanly
        // (a no-op when the skill is its own repo and already at the root).
        if let Ok(out) = git(&root_path, &["-c", "core.quotepath=false", "diff", "--no-color", "-M", "--relative", "HEAD"]) {
            if out.status.success() {
                truncated |= push_capped(&mut diff, &String::from_utf8_lossy(&out.stdout), MAX_DIFF_BYTES);
            }
        }
    }

    // Untracked files have no HEAD blob to diff against; `--no-index` against
    // /dev/null renders them as clean "new file" additions (exit 1 == differs).
    // The leading `--` stops a dash-prefixed filename being read as an option;
    // quotepath=false keeps unicode/space paths literal (matching the tracked half).
    for f in files.iter().filter(|f| f.kind == "untracked") {
        if truncated {
            break;
        }
        if let Ok(out) = git(
            &root_path,
            &["-c", "core.quotepath=false", "diff", "--no-index", "--no-color", "--", "/dev/null", &f.path],
        ) {
            let code = out.status.code().unwrap_or(-1);
            if code == 0 || code == 1 {
                // A binary file with no NUL in its leading bytes comes back as raw
                // bytes; emit a synthetic new-file header instead of lossy junk.
                let chunk = match std::str::from_utf8(&out.stdout) {
                    Ok(s) => s.to_string(),
                    Err(_) => format!("diff --git a/{p} b/{p}\nnew file mode 100644\n--- /dev/null\n+++ b/{p}\n", p = f.path),
                };
                truncated |= push_capped(&mut diff, &chunk, MAX_DIFF_BYTES);
            }
        }
    }

    Ok(WorktreeDiff { files, diff, truncated })
}

/// The worktree's unified diff text only — the input for on-device commit-message
/// generation (same content as `git_worktree_diff().diff`). Lives here so it can
/// read the otherwise-private field; `commitmsg` consumes it.
pub fn worktree_diff_text(root: &str) -> Result<String, String> {
    Ok(git_worktree_diff(root)?.diff)
}

/// The subjects of the most recent `n` commits (newest first), for seeding the
/// generator with the repo's existing commit style. Empty when there's no
/// history yet or git is unavailable.
pub fn recent_subjects(root: &str, n: usize) -> Vec<String> {
    git_log(root, n)
        .map(|commits| commits.into_iter().map(|c| c.message).collect())
        .unwrap_or_default()
}

pub fn git_commit_diff(root: &str, sha: &str) -> Result<CommitDetail, String> {
    if !git_available() {
        return Err("Git isn't installed.".into());
    }
    if !is_hex_rev(sha) {
        return Err("Invalid commit reference.".into());
    }
    let root_path = PathBuf::from(root);

    // Metadata in one shot: SHA, short, subject, body, author, email, dates.
    let meta = git(
        &root_path,
        &["show", "-s", "--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1f%ar", sha],
    )?;
    if !meta.status.success() {
        return Err(String::from_utf8_lossy(&meta.stderr).trim().to_string());
    }
    let meta_text = String::from_utf8_lossy(&meta.stdout);
    let p: Vec<&str> = meta_text.trim_end_matches('\n').split('\u{1f}').collect();
    if p.len() < 8 {
        return Err("Couldn't read that commit.".into());
    }

    // The patch on its own. Empty --format suppresses the commit header so we
    // get just the diff; --root makes the first commit diff against nothing.
    let patch = git(&root_path, &["show", "--no-color", "--format=", "--patch", "--root", sha])?;
    if !patch.status.success() {
        return Err(String::from_utf8_lossy(&patch.stderr).trim().to_string());
    }
    let mut diff = String::new();
    let truncated = push_capped(&mut diff, String::from_utf8_lossy(&patch.stdout).trim_start_matches('\n'), MAX_DIFF_BYTES);

    // Version number = commits reachable from this sha (its position in history).
    let number: usize = git_ok(&root_path, &["rev-list", "--count", sha])
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    Ok(CommitDetail {
        sha: p[0].to_string(),
        short: p[1].to_string(),
        subject: p[2].to_string(),
        body: p[3].trim().to_string(),
        author: p[4].to_string(),
        email: p[5].to_string(),
        iso_date: p[6].to_string(),
        relative_date: p[7].to_string(),
        diff,
        truncated,
        number,
    })
}

/// The contents of `path` at revision `rev` (e.g. "HEAD") — the "original" the
/// in-editor diff overlay compares the working buffer against. Returns "" when
/// the file doesn't exist at that rev (a newly added file), so the whole file
/// reads as an addition. `rev` must be "HEAD" or a hex SHA; `path` is relative
/// to `root` and rides as one `rev:./path` arg (the `./` resolves it against the
/// cwd `root`, not the repo top-level, and stops it being read as an option).
pub fn git_file_at(root: &str, rev: &str, path: &str) -> Result<String, String> {
    if !git_available() {
        return Err("Git isn't installed.".into());
    }
    if rev != "HEAD" && !is_hex_rev(rev) {
        return Err("Invalid revision.".into());
    }
    let rel = path.trim_start_matches("./");
    let out = git(&PathBuf::from(root), &["show", &format!("{rev}:./{rel}")])?;
    if !out.status.success() {
        return Ok(String::new()); // absent at that rev → treat as empty (added)
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The tracked file paths at revision `rev` (a commit SHA or "HEAD"), for browsing
/// a past version's files. `-z` keeps unicode/space paths literal (no quoting).
pub fn git_files_at(root: &str, rev: &str) -> Result<Vec<String>, String> {
    if !git_available() {
        return Err("Git isn't installed.".into());
    }
    if rev != "HEAD" && !is_hex_rev(rev) {
        return Err("Invalid revision.".into());
    }
    let out = git(&PathBuf::from(root), &["ls-tree", "-r", "--name-only", "-z", rev])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text.split('\0').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect())
}

/// Discard one path's working-tree changes back to HEAD: a tracked file is
/// restored (index + worktree); an untracked file is removed. `path` is kept
/// inside `root` and passed after `--` so it can't be read as an option.
pub fn git_discard(root: &str, path: &str) -> Result<(), String> {
    if !git_available() {
        return Err("Git isn't installed.".into());
    }
    let root_path = PathBuf::from(root);
    crate::pathsafe::safe_resolve(&root_path, path)?; // reject `..` / absolute escapes
    let tracked = git(&root_path, &["ls-files", "--error-unmatch", "--", path])
        .map(|o| o.status.success())
        .unwrap_or(false);
    let out = if tracked {
        // git >= 2.23: restore index + worktree to HEAD. Fall back to checkout.
        let r = git(&root_path, &["restore", "--staged", "--worktree", "--", path])?;
        if r.status.success() {
            r
        } else {
            git(&root_path, &["checkout", "HEAD", "--", path])?
        }
    } else {
        git(&root_path, &["clean", "-f", "--", path])? // untracked → remove
    };
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Discard ALL uncommitted changes back to HEAD (tracked restored, untracked
/// removed). Destructive — callers must confirm first.
pub fn git_discard_all(root: &str) -> Result<(), String> {
    if !git_available() {
        return Err("Git isn't installed.".into());
    }
    let root_path = PathBuf::from(root);
    let r = git(&root_path, &["restore", "--staged", "--worktree", "."])?;
    if !r.status.success() {
        let _ = git(&root_path, &["checkout", "HEAD", "--", "."]);
    }
    let c = git(&root_path, &["clean", "-fd"])?;
    if !c.status.success() {
        return Err(String::from_utf8_lossy(&c.stderr).trim().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_capped_respects_utf8_boundaries() {
        // "é" is two bytes (0xC3 0xA9). A cap of 1 must NOT slice mid-character.
        let mut buf = String::new();
        let cut = push_capped(&mut buf, "é", 1);
        assert!(cut && buf.is_empty()); // dropped the whole char rather than panic

        let mut buf = String::from("ab");
        let cut = push_capped(&mut buf, "cd", 10);
        assert!(!cut && buf == "abcd"); // fits, no truncation

        let mut buf = String::new();
        let cut = push_capped(&mut buf, "aé", 2);
        assert!(cut && buf == "a"); // keeps the ascii byte, drops the split char
    }

    #[test]
    fn round_trip_when_git_present() {
        if !git_available() {
            return; // skip on machines without git
        }
        let base = std::env::temp_dir().join(format!("ass_git_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("SKILL.md"), "---\nname: t\n---\nhi").unwrap();
        let root = base.to_string_lossy().to_string();

        git_init(&root).unwrap();
        // Local identity so the commit works regardless of global config.
        let _ = git(&base, &["config", "user.email", "test@example.com"]);
        let _ = git(&base, &["config", "user.name", "Test"]);

        let info = git_info(&root).unwrap();
        assert!(info.is_repo && info.available);

        let res = git_commit(&root, "initial version").unwrap();
        assert!(!res.sha.is_empty());

        let log = git_log(&root, 10).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].message, "initial version");

        // Nothing-to-commit path.
        assert!(git_commit(&root, "again").is_err());

        let sha = log[0].sha.clone();
        assert_eq!(sha.len(), 40);

        // Commit diff: the initial commit adds SKILL.md against the empty tree.
        let detail = git_commit_diff(&root, &sha).unwrap();
        assert_eq!(detail.subject, "initial version");
        assert!(detail.diff.contains("new file"));
        assert!(detail.diff.contains("SKILL.md"));
        // A bogus / non-hex ref is rejected before reaching git.
        assert!(git_commit_diff(&root, "not-a-sha!!").is_err());

        // Working tree: edit a tracked file + add untracked ones (incl. a name
        // beginning with '-', which must not be parsed by git as an option).
        std::fs::write(base.join("SKILL.md"), "---\nname: t\n---\nhi there").unwrap();
        std::fs::write(base.join("NOTES.md"), "fresh\n").unwrap();
        std::fs::write(base.join("-dash.md"), "dashed\n").unwrap();
        let wt = git_worktree_diff(&root).unwrap();
        let kinds: Vec<(&str, &str)> =
            wt.files.iter().map(|f| (f.path.as_str(), f.kind.as_str())).collect();
        assert!(kinds.contains(&("SKILL.md", "modified")));
        assert!(kinds.contains(&("NOTES.md", "untracked")));
        // The diff carries the tracked edit and every untracked add, including
        // the dash-prefixed file (would be dropped without the `--` separator).
        assert!(wt.diff.contains("+hi there"));
        assert!(wt.diff.contains("NOTES.md") && wt.diff.contains("+fresh"));
        assert!(wt.diff.contains("-dash.md") && wt.diff.contains("+dashed"));
        assert!(!wt.truncated);

        // File-at-rev: SKILL.md exists at HEAD (its committed text); a never-
        // committed path returns "" (so the overlay shows it all as added).
        let at_head = git_file_at(&root, "HEAD", "SKILL.md").unwrap();
        assert!(at_head.contains("name: t") && !at_head.contains("hi there"));
        assert_eq!(git_file_at(&root, "HEAD", "NOTES.md").unwrap(), "");
        assert!(git_file_at(&root, "zzz", "SKILL.md").is_err()); // non-hex rev rejected

        // Discard: a tracked file is restored to HEAD, an untracked file removed.
        git_discard(&root, "SKILL.md").unwrap();
        let restored = std::fs::read_to_string(base.join("SKILL.md")).unwrap();
        assert!(restored.contains("name: t") && !restored.contains("hi there"));
        git_discard(&root, "NOTES.md").unwrap();
        assert!(!base.join("NOTES.md").exists());
        assert!(git_discard(&root, "../escape").is_err()); // traversal rejected

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parent_repo_paths_are_skill_relative() {
        if !git_available() {
            return; // skip on machines without git
        }
        // A parent repo that holds the skill in a nested sub-path, plus a file
        // OUTSIDE the skill — the studio must never surface that one.
        let base = std::env::temp_dir().join(format!("ass_parent_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let skill = base.join("skills/my-skill");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: t\n---\nhi").unwrap();
        std::fs::write(base.join("README.md"), "outer\n").unwrap();
        let parent = base.to_string_lossy().to_string();
        let skill_root = skill.to_string_lossy().to_string();

        git_init(&parent).unwrap();
        let _ = git(&base, &["config", "user.email", "test@example.com"]);
        let _ = git(&base, &["config", "user.name", "Test"]);
        let _ = git(&base, &["add", "-A"]);
        let _ = git(&base, &["commit", "-m", "init"]);

        // info: the skill is seen as living inside a parent repo, not its own.
        let info = git_info(&skill_root).unwrap();
        assert!(info.in_parent_repo && !info.is_repo);
        assert!(!info.dirty); // clean so far

        // Edit inside the skill, add an untracked file inside it, and touch a file
        // OUTSIDE the skill in the same parent repo.
        std::fs::write(skill.join("SKILL.md"), "---\nname: t\n---\nhi there").unwrap();
        std::fs::write(skill.join("NOTES.md"), "fresh\n").unwrap();
        std::fs::write(base.join("README.md"), "outer changed\n").unwrap();

        // status is scoped to the skill AND paths are skill-relative (no
        // "skills/my-skill/" prefix), and the outside README never appears.
        let changes = git_status(&skill_root).unwrap();
        let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
        assert!(paths.contains(&"SKILL.md"), "got {paths:?}");
        assert!(paths.contains(&"NOTES.md"), "got {paths:?}");
        assert!(!paths.iter().any(|p| p.contains("README") || p.contains("skills/")), "leaked: {paths:?}");

        assert!(git_info(&skill_root).unwrap().dirty); // now dirty (scoped)

        // worktree diff is likewise scoped + skill-relative.
        let wt = git_worktree_diff(&skill_root).unwrap();
        assert!(wt.diff.contains("a/SKILL.md") && wt.diff.contains("+hi there"));
        assert!(wt.diff.contains("NOTES.md") && wt.diff.contains("+fresh"));
        assert!(!wt.diff.contains("README"), "leaked outside change: {}", wt.diff);
        assert!(!wt.diff.contains("skills/my-skill"), "unstripped prefix: {}", wt.diff);

        // file-at-rev resolves against the skill dir (skill-relative path).
        let head = git_file_at(&skill_root, "HEAD", "SKILL.md").unwrap();
        assert!(head.contains("name: t") && !head.contains("hi there"));

        // discard one skill file → restored from the parent's HEAD, untouched
        // outside the skill.
        git_discard(&skill_root, "SKILL.md").unwrap();
        let restored = std::fs::read_to_string(skill.join("SKILL.md")).unwrap();
        assert!(restored.contains("name: t") && !restored.contains("hi there"));
        assert_eq!(std::fs::read_to_string(base.join("README.md")).unwrap(), "outer changed\n");

        let _ = std::fs::remove_dir_all(&base);
    }
}
