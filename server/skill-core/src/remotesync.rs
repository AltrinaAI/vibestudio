// Provider-agnostic skill ↔ remote sync. Everything in this module speaks ONLY
// native git — fetch / merge --ff-only / rebase / push against whatever URL the
// skill repo's `origin` points at: GitHub, GitLab, Bitbucket, Gitea, a
// self-hosted server, or a bare repo on a file share. No REST APIs, no
// provider assumptions. Provider sugar (GitHub auth, repo creation, the device
// flow, topics) layers on top in `github.rs` and hands us at most a bearer
// token to answer HTTPS credential callbacks with.
//
// **The remote is the source of truth once connected**: syncs pull first
// (fast-forward when possible), local versions are rebased on top of remote
// history, and conflicting hunks resolve toward the remote (the pre-sync state
// stays reachable via the reflog).
//
// Secrets safety: local version commits run `git add -A`, so `.env` files can
// end up in history. A published repo's history is shared, so connecting/syncing
// is blocked while any `.env*` exists in the repo's history (the `env_in_history`
// guard) — we refuse rather than upload a secret.
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::gitops;
use crate::process::hidden_command;

/// Env var a one-shot git credential helper reads the token from (kept out of
/// argv and remote URLs, so it never shows in `ps` or `git remote -v`).
const TOKEN_ENV: &str = "VIBESTUDIO_GH_TOKEN";

/// `.env` and friends never leave the machine.
pub(crate) fn is_env_file(name: &str) -> bool {
    name == ".env" || name.starts_with(".env.")
}

/// Run a *networked* git command (fetch/push) with prompts fully suppressed.
/// With a token, a one-shot credential helper answers HTTPS auth with it (the
/// user's configured helpers are cleared for the call so a stale one can't
/// shadow it); without one, the user's own helpers / ssh-agent do their normal
/// job — that's the native path for GitLab & friends. SSH gets BatchMode so a
/// key-less setup fails fast instead of waiting on a prompt (only when the
/// user hasn't configured their own ssh command).
pub(crate) fn git_net(root: &Path, token: Option<&str>, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = hidden_command("git");
    cmd.arg("-C")
        .arg(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "vibestudio-no-askpass")
        .env("GCM_INTERACTIVE", "never");
    if std::env::var_os("GIT_SSH_COMMAND").is_none()
        && gitops::git_ok(root, &["config", "core.sshcommand"]).is_none()
    {
        cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
    }
    if let Some(token) = token {
        let helper = format!(
            "!f() {{ echo username=x-access-token; echo \"password=${{{TOKEN_ENV}}}\"; }}; f"
        );
        cmd.env(TOKEN_ENV, token)
            .args(["-c", "credential.helper="])
            .arg("-c")
            .arg(format!("credential.helper={helper}"));
    }
    cmd.args(args).output().map_err(|e| format!("Failed to run git: {e}"))
}

// ───────────────────────────── remote URLs ─────────────────────────────

/// (owner, repo) when `url` points at github.com — the signal for the provider
/// layer to add its sugar (token auth, html links). Handles
/// `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`, and
/// `ssh://git@github.com/o/r(.git)`.
pub(crate) fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().filter(|s| !s.is_empty())?;
    if parts.next().is_some() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

/// A browser URL for the repo, when one can be derived: the big forges all
/// serve the repo page at the HTTPS clone URL minus `.git`, and `git@host:path`
/// conventionally maps to `https://host/path`. Best-effort, cosmetic only.
fn html_url_for(url: &str) -> Option<String> {
    let clean = |s: &str| s.strip_suffix(".git").unwrap_or(s).trim_end_matches('/').to_string();
    if let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) {
        let rest = rest.split_once('@').map_or(rest, |(_, r)| r); // drop user:pass@
        return Some(format!("https://{}", clean(rest)));
    }
    if let Some(rest) = url.strip_prefix("ssh://") {
        let rest = rest.split_once('@').map_or(rest, |(_, r)| r);
        return Some(format!("https://{}", clean(rest)));
    }
    if let Some(rest) = url.strip_prefix("git@") {
        return Some(format!("https://{}", clean(&rest.replacen(':', "/", 1))));
    }
    None
}

/// A shape git can take as a remote URL and that can't be read as an option.
fn valid_remote_url(url: &str) -> bool {
    !url.is_empty()
        && !url.starts_with('-')
        && (url.starts_with("https://")
            || url.starts_with("http://")
            || url.starts_with("ssh://")
            || url.starts_with("git@")
            || url.starts_with("file://")
            || url.starts_with('/'))
}

/// The skill repo's `origin` URL, if any. Having an origin IS being connected
/// — a teammate's plain clone is connected automatically.
pub(crate) fn origin_url(root: &Path) -> Option<String> {
    gitops::git_ok(root, &["remote", "get-url", "origin"]).filter(|s| !s.is_empty())
}

/// The skill's remote, described for the UI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLink {
    /// "github" (provider sugar applies) | "git" (any other remote).
    pub provider: String,
    /// Short display label — "owner/repo" on GitHub, host/path elsewhere.
    pub label: String,
    /// Browser URL, when derivable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_url: Option<String>,
    pub url: String,
}

pub fn link_of(root: &Path) -> Option<RemoteLink> {
    let url = origin_url(root)?;
    let html_url = html_url_for(&url);
    if let Some((owner, repo)) = parse_github_remote(&url) {
        return Some(RemoteLink {
            provider: "github".into(),
            label: format!("{owner}/{repo}"),
            html_url: Some(format!("https://github.com/{owner}/{repo}")),
            url,
        });
    }
    Some(RemoteLink {
        provider: "git".into(),
        label: html_url
            .as_deref()
            .map(|h| h.trim_start_matches("https://").to_string())
            .unwrap_or_else(|| url.clone()),
        html_url,
        url,
    })
}

// ───────────────────────────── guards ─────────────────────────────

/// True when any commit anywhere in this repo's history touched a `.env*`
/// file — sharing would upload it with the history, so we refuse.
pub(crate) fn env_in_history(root: &Path) -> Result<bool, String> {
    let out = gitops::git(root, &["log", "--all", "--format=", "--name-only", "-z"])?;
    if !out.status.success() {
        return Ok(false); // no commits yet — nothing to leak
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text
        .split('\0')
        .filter(|p| !p.is_empty())
        .any(|p| is_env_file(p.rsplit('/').next().unwrap_or(p))))
}

fn env_history_error(verb: &str) -> String {
    format!(
        "This skill's version history contains a .env file — {verb} would upload it. \
         Remove the .env from history (or start fresh versioning) first."
    )
}

/// Common gates for every remote operation: the skill must be its own repo,
/// on a branch (not mid version-preview), with at least one version saved.
/// Returns (root, branch).
pub(crate) fn syncable(root: &str) -> Result<(PathBuf, String), String> {
    let root_path = PathBuf::from(root);
    if !root_path.join("SKILL.md").exists() {
        return Err("This folder has no SKILL.md — not a skill.".into());
    }
    let info = gitops::git_info(root)?;
    if !info.is_repo {
        return Err("Turn on versioning for this skill first (Source control → Start versioning).".into());
    }
    if gitops::git_ok(&root_path, &["rev-parse", "--verify", "HEAD"]).is_none() {
        return Err("Save a version first — there's nothing to publish yet.".into());
    }
    let branch = gitops::current_branch(&root_path)
        .ok_or_else(|| "Exit version preview before syncing.".to_string())?;
    Ok((root_path, branch))
}

// ───────────────────────────── sync state ─────────────────────────────

/// ahead = local versions the remote doesn't have; behind = remote versions we
/// don't. Reads the already-fetched `origin/<branch>` — no network.
fn ahead_behind(root: &Path, branch: &str) -> Result<(usize, usize), String> {
    let count = |range: String| -> Result<usize, String> {
        gitops::git_ok(root, &["rev-list", "--count", &range])
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| "Couldn't compare with the remote.".to_string())
    };
    Ok((count(format!("origin/{branch}..HEAD"))?, count(format!("HEAD..origin/{branch}"))?))
}

/// Fetch, then report (ahead, behind). A branch that doesn't exist on the
/// remote yet reads as "everything is to push".
pub(crate) fn remote_check(root: &Path, branch: &str, token: Option<&str>) -> Result<(usize, usize), String> {
    let fetch = git_net(root, token, &["fetch", "origin", branch])?;
    if !fetch.status.success() {
        let err = String::from_utf8_lossy(&fetch.stderr);
        if err.contains("couldn't find remote ref") {
            let n = gitops::git_ok(root, &["rev-list", "--count", "HEAD"])
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            return Ok((n, 0));
        }
        return Err(format!("Couldn't reach the remote: {}", err.trim()));
    }
    ahead_behind(root, branch)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    /// "upToDate" | "pushed" | "pulled" | "rebased"
    pub action: String,
    /// Versions pulled down / pushed up by this sync.
    pub pulled: usize,
    pub pushed: usize,
    /// Both sides had changed the same lines; the remote side won those hunks
    /// (local versions were kept, rebased on top).
    pub conflict_resolved: bool,
}

/// Push the branch, returning how many versions went up (counted just before).
fn push_branch(root: &Path, token: Option<&str>, branch: &str) -> Result<usize, String> {
    let ahead = gitops::git_ok(root, &["rev-list", "--count", &format!("refs/remotes/origin/{branch}..HEAD")])
        .and_then(|s| s.parse().ok())
        .or_else(|| gitops::git_ok(root, &["rev-list", "--count", "HEAD"]).and_then(|s| s.parse().ok()))
        .unwrap_or(0);
    let push = git_net(root, token, &["push", "-u", "origin", branch])?;
    if !push.status.success() {
        return Err(format!("Couldn't push: {}", String::from_utf8_lossy(&push.stderr).trim()));
    }
    Ok(ahead)
}

// ───────────────────────────── the operations ─────────────────────────────

/// Reconcile with the remote, remote-first: fetch, fast-forward pull when only
/// the remote moved, push when only we did, and when BOTH moved rebase the
/// local versions on top of the remote (conflicting hunks resolve toward the
/// remote — it's the source of truth; nothing local is lost: non-conflicting
/// edits survive and the pre-sync state stays in the reflog), then push.
pub fn sync_now(root: &str, token: Option<&str>) -> Result<SyncOutcome, String> {
    let (root_path, branch) = syncable(root)?;
    if origin_url(&root_path).is_none() {
        return Err("This skill isn't connected to a remote yet.".into());
    }
    if env_in_history(&root_path)? {
        return Err(env_history_error("syncing"));
    }

    let (ahead, behind) = remote_check(&root_path, &branch, token)?;
    match (ahead, behind) {
        (0, 0) => Ok(SyncOutcome { action: "upToDate".into(), pulled: 0, pushed: 0, conflict_resolved: false }),
        (a, 0) => {
            push_branch(&root_path, token, &branch)?;
            Ok(SyncOutcome { action: "pushed".into(), pulled: 0, pushed: a, conflict_resolved: false })
        }
        (0, b) => {
            // Only the remote moved — fast-forward. git refuses if uncommitted
            // local edits overlap the incoming files, which is exactly right.
            let m = gitops::git(&root_path, &["merge", "--ff-only", &format!("origin/{branch}")])?;
            if !m.status.success() {
                return Err(
                    "Pulling would overwrite unsaved local edits — save a version first, then sync again.".into(),
                );
            }
            Ok(SyncOutcome { action: "pulled".into(), pulled: b, pushed: 0, conflict_resolved: false })
        }
        (_, b) => {
            // Both moved: replay local versions on top of the remote (linear
            // history preserved). Rebase needs a clean tree and an identity.
            let dirty = gitops::git_ok(&root_path, &["status", "--porcelain"]).map(|s| !s.is_empty()).unwrap_or(false);
            if dirty {
                return Err("Both this skill and the remote changed — save a version first, then sync again.".into());
            }
            let upstream = format!("origin/{branch}");
            let mut conflict_resolved = false;
            let plain = gitops::git(&root_path, &["rebase", &upstream])?;
            if !plain.status.success() {
                let _ = gitops::git(&root_path, &["rebase", "--abort"]);
                // `-X ours` during a rebase favors the side being rebased ONTO
                // (the remote) for conflicting hunks — remote is the truth.
                let theirs = gitops::git(&root_path, &["rebase", "-X", "ours", &upstream])?;
                if !theirs.status.success() {
                    let _ = gitops::git(&root_path, &["rebase", "--abort"]);
                    return Err(
                        "Couldn't reconcile with the remote automatically (e.g. a file/folder clash). \
                         Resolve it with git, or disconnect and re-publish."
                            .into(),
                    );
                }
                conflict_resolved = true;
            }
            // A local version whose every change was superseded by the remote
            // rebases to empty and is dropped (remote is the truth), so the
            // actual push count can be lower than the pre-rebase `ahead`.
            let pushed = push_branch(&root_path, token, &branch)?;
            Ok(SyncOutcome { action: "rebased".into(), pulled: b, pushed, conflict_resolved })
        }
    }
}

/// Connect the skill to an existing remote by URL — the universal, provider-
/// free path (GitLab, Bitbucket, self-hosted, a bare repo on a share): create
/// an empty repository anywhere, paste its URL. Sets `origin` and runs a first
/// sync; on failure the origin is removed again, so a typo'd URL leaves no
/// half-connected state. A remote that already has (even unrelated) history is
/// reconciled remote-first, like any sync.
pub fn connect_remote(root: &str, url: &str, token: Option<&str>) -> Result<SyncOutcome, String> {
    let url = url.trim();
    if !valid_remote_url(url) {
        return Err("Enter the repository's clone URL (https://…, ssh://…, or git@host:path).".into());
    }
    let (root_path, _branch) = syncable(root)?;
    if let Some(existing) = origin_url(&root_path) {
        return Err(format!("This skill is already connected to {existing} — disconnect it first."));
    }
    if env_in_history(&root_path)? {
        return Err(env_history_error("connecting"));
    }
    let add = gitops::git(&root_path, &["remote", "add", "origin", url])?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
    }
    match sync_now(root, token) {
        Ok(outcome) => Ok(outcome),
        Err(e) => {
            let _ = gitops::git(&root_path, &["remote", "remove", "origin"]);
            Err(e)
        }
    }
}

/// Quiet best-effort fast-forward pull, for "remote is the source of truth":
/// called in the background when a skill opens. Never pushes, never rebases,
/// never errors the UI — anything unexpected just means "pulled 0".
pub fn auto_pull(root: &str, token: Option<&str>) -> Result<SyncOutcome, String> {
    let none = || SyncOutcome { action: "upToDate".into(), pulled: 0, pushed: 0, conflict_resolved: false };
    let Ok((root_path, branch)) = syncable(root) else { return Ok(none()) };
    if origin_url(&root_path).is_none() {
        return Ok(none());
    }
    let Ok((ahead, behind)) = remote_check(&root_path, &branch, token) else { return Ok(none()) };
    if behind == 0 || ahead > 0 {
        return Ok(none()); // nothing to pull, or diverged — that's for an explicit sync
    }
    let m = gitops::git(&root_path, &["merge", "--ff-only", &format!("origin/{branch}")])?;
    if !m.status.success() {
        return Ok(none()); // unsaved local edits overlap — leave them alone
    }
    Ok(SyncOutcome { action: "pulled".into(), pulled: behind, pushed: 0, conflict_resolved: false })
}

/// Disconnect the skill from its remote (nothing is removed on the remote).
pub fn unlink(root: &str) -> Result<(), String> {
    let root_path = PathBuf::from(root);
    let out = gitops::git(&root_path, &["remote", "remove", "origin"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

// ───────────────────────────── import (clone) ─────────────────────────────

/// Bumped per clone import to give each one a unique staging dir.
static CLONE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Import a skill by cloning its repository (any git URL — the inverse of
/// publishing). The clone keeps its `.git` + `origin`, so the imported skill
/// is connected for sync from the first moment: teammates "subscribe" to a
/// skill just by importing it.
pub fn import_from_remote(
    url: &str,
    target: &str,
    overwrite: bool,
    token: Option<&str>,
) -> Result<crate::sync::ImportResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "No home directory.".to_string())?;
    import_from_remote_in(&home, url, target, overwrite, token)
}

fn import_from_remote_in(
    home: &Path,
    url: &str,
    target: &str,
    overwrite: bool,
    token: Option<&str>,
) -> Result<crate::sync::ImportResult, String> {
    let url = url.trim();
    if !valid_remote_url(url) {
        return Err("Enter the repository's clone URL (https://…, ssh://…, or git@host:path).".into());
    }
    let seq = CLONE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let staging = std::env::temp_dir().join(format!("ass_clone_{}_{}", std::process::id(), seq));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let result = (|| {
        let out = git_net(&staging, token, &["clone", "--", url, "skill"])?;
        if !out.status.success() {
            return Err(format!(
                "Couldn't clone the repository: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let cloned = staging.join("skill");
        if !cloned.join("SKILL.md").exists() {
            let inner = sub_skills(&cloned);
            return Err(if inner.is_empty() {
                "That repository isn't a skill (no SKILL.md at its root).".into()
            } else {
                format!(
                    "That repository holds multiple skills ({}) — import a single-skill repository.",
                    inner.join(", ")
                )
            });
        }
        crate::sync::land_cloned_skill(home, &cloned, name_from_url(url).as_deref(), target, overwrite)
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Skill folders inside a non-skill repo (its top level, plus a `skills/`
/// child — the common multi-skill layouts) for a helpful error message.
fn sub_skills(repo: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut scan = |dir: &Path| {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            if e.path().join("SKILL.md").exists() {
                out.push(e.file_name().to_string_lossy().into_owned());
            }
        }
    };
    scan(repo);
    scan(&repo.join("skills"));
    out.sort();
    out.truncate(6);
    out
}

/// A skill-name candidate from the repo URL's last segment (used when the
/// cloned SKILL.md declares no valid name): lowercased, non-name characters
/// collapsed to single hyphens.
fn name_from_url(url: &str) -> Option<String> {
    let tail = url
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()?
        .trim_end_matches(".git");
    let mut name = String::new();
    for c in tail.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            name.push(c);
        } else if !name.ends_with('-') && !name.is_empty() {
            name.push('-');
        }
    }
    let name = name.trim_end_matches('-').to_string();
    (!name.is_empty()).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_remotes_parse() {
        let ok = Some(("org".to_string(), "skill".to_string()));
        assert_eq!(parse_github_remote("https://github.com/org/skill.git"), ok);
        assert_eq!(parse_github_remote("https://github.com/org/skill"), ok);
        assert_eq!(parse_github_remote("git@github.com:org/skill.git"), ok);
        assert_eq!(parse_github_remote("ssh://git@github.com/org/skill"), ok);
        assert_eq!(parse_github_remote("https://gitlab.com/org/skill"), None);
        assert_eq!(parse_github_remote("https://github.com/org"), None);
        assert_eq!(parse_github_remote("/tmp/bare.git"), None);
    }

    #[test]
    fn html_urls_derive_for_common_forges() {
        let h = |u: &str| html_url_for(u);
        assert_eq!(h("https://gitlab.com/acme/skill.git").as_deref(), Some("https://gitlab.com/acme/skill"));
        assert_eq!(h("git@gitlab.com:acme/skill.git").as_deref(), Some("https://gitlab.com/acme/skill"));
        assert_eq!(h("ssh://git@bitbucket.org/acme/skill.git").as_deref(), Some("https://bitbucket.org/acme/skill"));
        assert_eq!(h("https://user:tok@gitea.local/acme/skill.git").as_deref(), Some("https://gitea.local/acme/skill"));
        assert_eq!(h("/srv/git/skill.git"), None);
    }

    #[test]
    fn remote_urls_validated() {
        assert!(valid_remote_url("https://gitlab.com/a/b.git"));
        assert!(valid_remote_url("git@gitlab.com:a/b.git"));
        assert!(valid_remote_url("ssh://git@host/a/b"));
        assert!(valid_remote_url("/srv/git/skill.git"));
        assert!(!valid_remote_url(""));
        assert!(!valid_remote_url("--upload-pack=evil"));
        assert!(!valid_remote_url("ftp://host/x"));
    }

    /// A throwaway skill repo with identity set; returns its root.
    fn make_skill_repo(base: &Path, name: &str) -> PathBuf {
        let root = base.join(name);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("SKILL.md"), "---\nname: t\n---\nv1\n").unwrap();
        // -b main pins the branch so the bare remote/clone agree regardless of
        // the machine's init.defaultBranch.
        assert!(gitops::git(&root, &["init", "-b", "main"]).unwrap().status.success());
        for cfg in [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]] {
            let _ = gitops::git(&root, &["config", cfg[0], cfg[1]]);
        }
        root
    }

    fn commit_all(root: &Path, msg: &str) {
        assert!(gitops::git(root, &["add", "-A"]).unwrap().status.success());
        assert!(gitops::git(root, &["commit", "-m", msg]).unwrap().status.success(), "commit {msg}");
    }

    #[test]
    fn env_history_guard() {
        if !gitops::git_available() {
            return;
        }
        let base = std::env::temp_dir().join(format!("ass_rsenv_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = make_skill_repo(&base, "skill");
        commit_all(&root, "v1");
        assert!(!env_in_history(&root).unwrap());

        // A committed .env anywhere in history trips the guard — and blocks sync.
        std::fs::write(root.join(".env"), "SECRET=1").unwrap();
        assert!(gitops::git(&root, &["add", "-f", ".env"]).unwrap().status.success());
        commit_all(&root, "oops");
        assert!(env_in_history(&root).unwrap());
        let _ = gitops::git(&root, &["remote", "add", "origin", "/nowhere.git"]);
        let err = sync_now(root.to_str().unwrap(), None).unwrap_err();
        assert!(err.contains(".env"), "sync blocked on secret history: {err}");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn connect_remote_validates_unwinds_and_reconciles() {
        if !gitops::git_available() {
            return;
        }
        let base = std::env::temp_dir().join(format!("ass_rsconnect_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let a = make_skill_repo(&base, "skill-a");
        commit_all(&a, "v1");
        let a_root = a.to_str().unwrap();

        // Bad URL shape never touches the repo; a dead path unwinds the origin.
        assert!(connect_remote(a_root, "--upload-pack=evil", None).is_err());
        assert!(connect_remote(a_root, "/nonexistent/nowhere.git", None).is_err());
        assert!(origin_url(&a).is_none(), "failed connect leaves no origin behind");

        // Empty remote (the documented GitLab-and-friends path): connect = push.
        assert!(gitops::git(&base, &["init", "--bare", "-b", "main", "empty.git"]).unwrap().status.success());
        let empty = base.join("empty.git");
        let r = connect_remote(a_root, empty.to_str().unwrap(), None).unwrap();
        // v1 goes up — connect = push to an empty remote.
        assert_eq!((r.action.as_str(), r.pulled), ("pushed", 0));
        assert!(r.pushed >= 1);
        assert!(origin_url(&a).is_some());
        assert!(connect_remote(a_root, empty.to_str().unwrap(), None).is_err(), "second connect refused");
        unlink(a_root).unwrap();

        // A remote with existing UNRELATED history (e.g. created with a README
        // on the forge): reconciled remote-first — its content is preserved,
        // the skill's versions go on top.
        assert!(gitops::git(&base, &["init", "--bare", "-b", "main", "seeded.git"]).unwrap().status.success());
        let seeded = base.join("seeded.git");
        let c = make_skill_repo(&base, "seeder");
        std::fs::remove_file(c.join("SKILL.md")).unwrap();
        std::fs::write(c.join("README.md"), "forge readme\n").unwrap();
        commit_all(&c, "forge init");
        assert!(gitops::git(&c, &["remote", "add", "origin", seeded.to_str().unwrap()]).unwrap().status.success());
        assert!(gitops::git(&c, &["push", "-u", "origin", "main"]).unwrap().status.success());
        let r = connect_remote(a_root, seeded.to_str().unwrap(), None).unwrap();
        assert_eq!(r.action, "rebased");
        assert!(a.join("README.md").exists(), "remote content preserved");
        assert!(a.join("SKILL.md").exists(), "skill content on top");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn url_name_candidates() {
        assert_eq!(name_from_url("https://github.com/o/My_Skill.git").as_deref(), Some("my-skill"));
        assert_eq!(name_from_url("git@gitlab.com:o/pdf.git").as_deref(), Some("pdf"));
        assert_eq!(name_from_url("/tmp/skills/repo.git").as_deref(), Some("repo"));
        assert!(name_from_url("https://host/---").is_none());
    }

    #[test]
    fn import_from_remote_clones_and_links() {
        if !gitops::git_available() {
            return;
        }
        let base = std::env::temp_dir().join(format!("ass_rsimport_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let home = base.join("home");

        // A published skill (frontmatter-named), with a foreign committed .env
        // to exercise the secret-offer path. Its bare clone plays the forge.
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: imported-skill\n---\nv1\n").unwrap();
        std::fs::write(src.join(".env"), "ZZ_IMPROBABLE_TEST_KEY=v\n").unwrap();
        assert!(gitops::git(&src, &["init", "-b", "main"]).unwrap().status.success());
        for cfg in [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]] {
            let _ = gitops::git(&src, &["config", cfg[0], cfg[1]]);
        }
        commit_all(&src, "v1");
        assert!(gitops::git(&base, &["clone", "--bare", "src", "src.git"]).unwrap().status.success());
        let url = base.join("src.git").to_string_lossy().into_owned();

        let res = import_from_remote_in(&home, &url, "universal", false, None).unwrap();
        let root = PathBuf::from(&res.root);
        assert!(res.root.ends_with("imported-skill"), "named from frontmatter: {}", res.root);
        assert!(root.starts_with(home.join(".agents/skills").canonicalize().unwrap_or(home.join(".agents/skills"))) || res.root.contains(".agents/skills"));
        assert!(root.join("SKILL.md").exists());
        assert!(root.join(".git").exists(), "the clone's repository is preserved");
        assert_eq!(origin_url(&root).as_deref(), Some(url.as_str()), "arrives sync-connected");
        assert!(root.join(".env").exists(), "tracked .env left as cloned (deleting would dirty the worktree)");
        assert_eq!(res.env.len(), 1, "its pairs are still offered to the store");
        assert_eq!(res.env[0].key, "ZZ_IMPROBABLE_TEST_KEY");

        // Same name again: refused without overwrite, replaced with it.
        let err = import_from_remote_in(&home, &url, "universal", false, None).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        let res2 = import_from_remote_in(&home, &url, "universal", true, None).unwrap();
        assert!(res2.overwrote);

        // Not a skill repo → clear error, nothing imported.
        let plain = base.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::write(plain.join("README.md"), "hi\n").unwrap();
        assert!(gitops::git(&plain, &["init", "-b", "main"]).unwrap().status.success());
        for cfg in [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]] {
            let _ = gitops::git(&plain, &["config", cfg[0], cfg[1]]);
        }
        commit_all(&plain, "init");
        assert!(gitops::git(&base, &["clone", "--bare", "plain", "plain.git"]).unwrap().status.success());
        let err = import_from_remote_in(&home, base.join("plain.git").to_str().unwrap(), "universal", false, None)
            .unwrap_err();
        assert!(err.contains("isn't a skill"), "{err}");

        // Multi-skill repo → the error names what's inside.
        let multi = base.join("multi");
        std::fs::create_dir_all(multi.join("skills/foo")).unwrap();
        std::fs::write(multi.join("skills/foo/SKILL.md"), "---\nname: foo\n---\nx\n").unwrap();
        assert!(gitops::git(&multi, &["init", "-b", "main"]).unwrap().status.success());
        for cfg in [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]] {
            let _ = gitops::git(&multi, &["config", cfg[0], cfg[1]]);
        }
        commit_all(&multi, "init");
        assert!(gitops::git(&base, &["clone", "--bare", "multi", "multi.git"]).unwrap().status.success());
        let err = import_from_remote_in(&home, base.join("multi.git").to_str().unwrap(), "universal", false, None)
            .unwrap_err();
        assert!(err.contains("foo"), "names the inner skills: {err}");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn sync_round_trip_with_local_bare_remote() {
        if !gitops::git_available() {
            return;
        }
        let base = std::env::temp_dir().join(format!("ass_rssync_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        // Skill A with two versions, and a bare "forge" on disk.
        let a = make_skill_repo(&base, "skill-a");
        commit_all(&a, "v1");
        std::fs::write(a.join("SKILL.md"), "---\nname: t\n---\nv2\n").unwrap();
        commit_all(&a, "v2");
        assert!(gitops::git(&base, &["init", "--bare", "-b", "main", "origin.git"]).unwrap().status.success());
        let bare = base.join("origin.git");
        assert!(gitops::git(&a, &["remote", "add", "origin", bare.to_str().unwrap()]).unwrap().status.success());
        let a_root = a.to_str().unwrap();

        // First sync: remote branch doesn't exist yet → everything pushes.
        let r = sync_now(a_root, None).unwrap();
        assert_eq!((r.action.as_str(), r.pushed, r.pulled), ("pushed", 2, 0));

        // Teammate B clones, commits, pushes.
        assert!(gitops::git(&base, &["clone", "origin.git", "clone-b"]).unwrap().status.success());
        let b = base.join("clone-b");
        for cfg in [["user.email", "b@example.com"], ["user.name", "B"], ["commit.gpgsign", "false"]] {
            let _ = gitops::git(&b, &["config", cfg[0], cfg[1]]);
        }
        std::fs::write(b.join("NOTES.md"), "from B\n").unwrap();
        commit_all(&b, "b: notes");
        assert!(gitops::git(&b, &["push"]).unwrap().status.success());

        // A syncs: remote moved, A didn't → fast-forward pull.
        let r = sync_now(a_root, None).unwrap();
        assert_eq!((r.action.as_str(), r.pulled, r.pushed), ("pulled", 1, 0));
        assert!(a.join("NOTES.md").exists(), "teammate's file arrived");

        // Nothing new → up to date.
        assert_eq!(sync_now(a_root, None).unwrap().action, "upToDate");

        // Divergence WITHOUT overlapping lines: A and B each add their own file.
        std::fs::write(a.join("A.md"), "a\n").unwrap();
        commit_all(&a, "a: own file");
        std::fs::write(b.join("B.md"), "b\n").unwrap();
        commit_all(&b, "b: own file");
        assert!(gitops::git(&b, &["push"]).unwrap().status.success());
        let r = sync_now(a_root, None).unwrap();
        assert_eq!((r.action.as_str(), r.pulled, r.pushed, r.conflict_resolved), ("rebased", 1, 1, false));
        assert!(a.join("B.md").exists());

        // True conflict (same line): the remote wins the hunk, while the
        // NON-conflicting part of A's version survives the rebase.
        let before = gitops::git_ok(&a, &["rev-list", "--count", "HEAD"]).unwrap().parse::<usize>().unwrap();
        std::fs::write(a.join("SKILL.md"), "---\nname: t\n---\nlocal change\n").unwrap();
        std::fs::write(a.join("A-extra.md"), "kept\n").unwrap();
        commit_all(&a, "a: local skill edit");
        assert!(gitops::git(&b, &["pull"]).unwrap().status.success());
        std::fs::write(b.join("SKILL.md"), "---\nname: t\n---\nremote change\n").unwrap();
        commit_all(&b, "b: remote skill edit");
        assert!(gitops::git(&b, &["push"]).unwrap().status.success());
        let r = sync_now(a_root, None).unwrap();
        assert_eq!(r.action, "rebased");
        assert!(r.conflict_resolved, "conflicting hunks auto-resolved");
        assert_eq!(r.pushed, 1, "A's (partially surviving) version was pushed");
        let skill = std::fs::read_to_string(a.join("SKILL.md")).unwrap();
        assert!(skill.contains("remote change"), "remote is the source of truth: {skill}");
        assert_eq!(std::fs::read_to_string(a.join("A-extra.md")).unwrap(), "kept\n", "non-conflicting work survives");
        let after = gitops::git_ok(&a, &["rev-list", "--count", "HEAD"]).unwrap().parse::<usize>().unwrap();
        assert_eq!(after, before + 2, "A's rebased version + B's version");

        // auto_pull: quiet ff when clean…
        assert!(gitops::git(&b, &["pull"]).unwrap().status.success()); // B catches up with A's rebase first
        std::fs::write(b.join("NOTES.md"), "more from B\n").unwrap();
        commit_all(&b, "b: more notes");
        assert!(gitops::git(&b, &["push"]).unwrap().status.success());
        let r = auto_pull(a_root, None).unwrap();
        assert_eq!((r.action.as_str(), r.pulled), ("pulled", 1));
        // …but never under a diverged or dirty-overlap state.
        std::fs::write(b.join("NOTES.md"), "newest from B\n").unwrap();
        commit_all(&b, "b: newest");
        assert!(gitops::git(&b, &["push"]).unwrap().status.success());
        std::fs::write(a.join("NOTES.md"), "uncommitted local edit\n").unwrap();
        let r = auto_pull(a_root, None).unwrap();
        assert_eq!(r.pulled, 0, "overlapping unsaved edit blocks the quiet pull");
        assert_eq!(std::fs::read_to_string(a.join("NOTES.md")).unwrap(), "uncommitted local edit\n");
        let _ = gitops::git(&a, &["checkout", "--", "NOTES.md"]);

        // Disconnect removes origin; nothing remote is touched.
        unlink(a_root).unwrap();
        assert!(origin_url(&a).is_none());

        let _ = std::fs::remove_dir_all(&base);
    }
}
