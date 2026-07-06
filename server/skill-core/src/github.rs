// The GitHub provider layer over `remotesync` (the provider-agnostic, pure-git
// sync engine). Everything here is OPTIONAL sugar — a skill connected to any
// other remote (GitLab, Bitbucket, self-hosted, a bare repo on a share) syncs
// through the same engine using the machine's own git credentials; this module
// only adds what GitHub's API enables:
//   * auth reuse + the OAuth device flow (so private-repo HTTPS works with no
//     setup), * one-click repo creation (user or org, private by default,
//     EMPTY — no auto_init/README; the first push populates it), * the owner
//     picker (orgs the user can create repos in), * the `agent-skill` +
//     `skill-studio` topic badges (GitHub has no repo folders or slashed
//     names; topics are its grouping primitive).
//
// Auth reuses what's already on the machine, most explicit first:
//   1. a token the user connected in the Studio (stored 0600 in the config dir),
//   2. GH_TOKEN / GITHUB_TOKEN env vars,
//   3. the gh CLI's login (`gh auth token` — never parse hosts.yml: tokens live
//      in the OS keyring since gh 2.26, and `gh auth token` also honors the env
//      overrides). gh's OAuth app is GitHub-privileged, so its tokens work even
//      in orgs that restrict third-party OAuth apps — the best default source.
//   4. git's credential helpers (`git credential fill`, prompts suppressed).
// Every candidate is validated against `GET /user` before use; the first valid
// one wins and is cached for the session. The device flow (no client secret —
// public client per RFC 8628) covers machines with none of the above, gated on
// a client id (env `SKILL_STUDIO_GITHUB_CLIENT_ID`); pasting a PAT is the
// universal fallback. The token is handed to the sync engine for github.com
// remotes only, and rides an env var into a one-shot credential helper — never
// argv or the remote URL.
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::process::hidden_command;
use crate::remotesync;

const API: &str = "https://api.github.com";
const USER_AGENT: &str = "skill-studio";
/// Topics set on repos we create: `agent-skill` is the ecosystem-wide marker
/// (this repo IS an Agent Skill), `skill-studio` marks it as managed by Skill
/// Studio. All of an owner's skills are one filter away
/// (`gh search repos --topic skill-studio`).
const SKILL_TOPICS: [&str; 2] = ["agent-skill", "skill-studio"];
/// OAuth device-flow client id. Baked in when the VibeStudio OAuth app is
/// registered; until then the env var enables the flow for development.
const DEFAULT_CLIENT_ID: &str = "";
/// Scopes the device flow asks for: `repo` (create/push incl. private),
/// `read:org` (list orgs for the owner picker).
const DEVICE_SCOPES: &str = "repo read:org";

// ───────────────────────────── HTTP plumbing ─────────────────────────────

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(60))
        .build()
}

/// A GitHub API response, success or error alike — callers branch on `status`.
struct ApiResp {
    status: u16,
    body: Value,
    /// `X-GitHub-SSO` header — present when a SAML org wants the token authorized.
    sso: Option<String>,
    /// `X-OAuth-Scopes` header — classic tokens only.
    scopes: Option<String>,
}

/// One authenticated REST call. Transport failures are `Err`; HTTP error
/// statuses come back as `Ok` with their status + parsed body, so callers can
/// read GitHub's `message` and the SSO header.
fn api(token: &str, method: &str, url: &str, body: Option<&Value>) -> Result<ApiResp, String> {
    let req = agent()
        .request(method, url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .set("X-GitHub-Api-Version", "2022-11-28");
    let result = match body {
        Some(b) => req.set("Content-Type", "application/json").send_string(&b.to_string()),
        None => req.call(),
    };
    let resp = match result {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("GitHub is unreachable: {e}")),
    };
    let status = resp.status();
    let sso = resp.header("x-github-sso").map(str::to_string);
    let scopes = resp.header("x-oauth-scopes").map(str::to_string);
    let text = resp.into_string().unwrap_or_default();
    let body = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok(ApiResp { status, body, sso, scopes })
}

/// Human-readable failure for an unexpected API status, surfacing GitHub's own
/// `message` plus targeted hints for the two classic org gotchas (SAML SSO and
/// OAuth-app access restrictions).
fn api_err(action: &str, r: &ApiResp) -> String {
    let msg = r.body.get("message").and_then(|m| m.as_str()).unwrap_or("");
    let mut out = format!("Couldn't {action} ({})", r.status);
    if !msg.is_empty() {
        out.push_str(&format!(": {msg}"));
    }
    if r.sso.is_some() {
        out.push_str(". Your token needs SAML SSO authorization for this organization — authorize it on github.com (or `gh auth refresh`).");
    } else if r.status == 403 && msg.to_lowercase().contains("oauth") {
        out.push_str(". The organization restricts OAuth apps — an org owner must approve the app, or use the GitHub CLI's login instead.");
    }
    out
}

/// `true` for a string safe to embed in a GitHub URL path segment
/// (owner / repo names — also what GitHub itself allows).
fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

// ───────────────────────────── token sources ─────────────────────────────

fn token_file() -> Result<PathBuf, String> {
    Ok(crate::secrets::config_dir()?.join("github-token"))
}

fn stored_token() -> Option<String> {
    let t = std::fs::read_to_string(token_file().ok()?).ok()?;
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}

fn env_token() -> Option<String> {
    ["GH_TOKEN", "GITHUB_TOKEN"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .map(|t| t.trim().to_string())
        .find(|t| !t.is_empty())
}

pub fn gh_cli_available() -> bool {
    hidden_command("gh").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}

/// The gh CLI's active token (`gh auth token`): exit 0 + non-empty stdout means
/// logged in. Honors GH_TOKEN/GITHUB_TOKEN itself, reads keyring or hosts.yml —
/// the single correct read path across gh versions.
fn gh_cli_token() -> Option<String> {
    let out = hidden_command("gh").args(["auth", "token"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// Ask git's configured credential helpers for a github.com credential, never
/// prompting: terminal prompts off, askpass pointed at a non-existent program
/// (priority over the terminal — an inherited GIT_ASKPASS could hijack the
/// call), and Git Credential Manager's GUI flow disabled. A helper that hangs
/// anyway is killed after 5s. Run in `cwd` so repo-local helper config counts.
fn git_credential_token(cwd: &Path) -> Option<String> {
    let mut child = hidden_command("git")
        .args(["credential", "fill"])
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "skill-studio-no-askpass")
        .env("GCM_INTERACTIVE", "never")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    child
        .stdin
        .take()?
        .write_all(b"protocol=https\nhost=github.com\n\n")
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return None, // no credential
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
    let mut text = String::new();
    use std::io::Read as _;
    child.stdout.take()?.read_to_string(&mut text).ok()?;
    parse_credential_password(&text)
}

/// Pull `password=…` out of `git credential fill` output (key=value lines).
fn parse_credential_password(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|l| l.strip_prefix("password="))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

// ───────────────────────────── auth resolution ─────────────────────────────

/// How the active token was found — shown in the UI so the user knows whose
/// identity a sync will use.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuthInfo {
    /// "studio" | "env" | "gh-cli" | "git-credential"
    pub source: String,
    pub login: String,
    /// Classic-token scopes (the X-OAuth-Scopes header); fine-grained PATs
    /// don't report scopes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<String>,
}

struct CachedAuth {
    token: String,
    info: AuthInfo,
}

static AUTH_CACHE: Mutex<Option<CachedAuth>> = Mutex::new(None);

/// `GET /user` — proves the token is alive and identifies it.
fn validate(token: &str) -> Result<(String, Option<String>), String> {
    let r = api(token, "GET", &format!("{API}/user"), None)?;
    if r.status != 200 {
        return Err(api_err("verify the token", &r));
    }
    let login = r
        .body
        .get("login")
        .and_then(|l| l.as_str())
        .ok_or_else(|| "GitHub returned no account for this token.".to_string())?
        .to_string();
    Ok((login, r.scopes))
}

/// Probe the token sources in priority order; first one that validates wins.
fn probe_auth(root: Option<&Path>) -> Option<CachedAuth> {
    let cwd = root.map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir);
    let try_source = |source: &str, token: Option<String>| -> Option<CachedAuth> {
        let token = token?;
        let (login, scopes) = validate(&token).ok()?;
        Some(CachedAuth { token, info: AuthInfo { source: source.to_string(), login, scopes } })
    };
    try_source("studio", stored_token())
        .or_else(|| try_source("env", env_token()))
        .or_else(|| try_source("gh-cli", gh_cli_token()))
        .or_else(|| try_source("git-credential", git_credential_token(&cwd)))
}

/// The session's working auth: cached token (revalidated when `revalidate`),
/// else a fresh probe. Returns None when nothing on the machine authenticates.
fn resolve_auth(root: Option<&Path>, revalidate: bool) -> Option<(String, AuthInfo)> {
    let mut guard = AUTH_CACHE.lock().ok()?;
    if let Some(cached) = guard.as_ref() {
        if !revalidate {
            return Some((cached.token.clone(), cached.info.clone()));
        }
        if let Ok((login, scopes)) = validate(&cached.token) {
            let info = AuthInfo { source: cached.info.source.clone(), login, scopes };
            let token = cached.token.clone();
            *guard = Some(CachedAuth { token: token.clone(), info: info.clone() });
            return Some((token, info));
        }
        *guard = None; // token died (revoked / expired) — fall through to a probe
    }
    let fresh = probe_auth(root)?;
    let pair = (fresh.token.clone(), fresh.info.clone());
    *guard = Some(fresh);
    Some(pair)
}

/// Validate + persist a pasted token (the manual fallback). 0600, like secrets.
pub fn connect_token(token: &str) -> Result<AuthInfo, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Paste a GitHub token.".into());
    }
    let (login, scopes) = validate(token)?;
    let path = token_file()?;
    crate::secrets::ensure_dir()?;
    std::fs::write(&path, token).map_err(|e| format!("Couldn't store the token: {e}"))?;
    crate::secrets::set_mode(&path, 0o600);
    let info = AuthInfo { source: "studio".into(), login, scopes };
    if let Ok(mut guard) = AUTH_CACHE.lock() {
        *guard = Some(CachedAuth { token: token.to_string(), info: info.clone() });
    }
    Ok(info)
}

/// Forget the Studio-stored token. Ambient sources (env, gh, git) are untouched
/// — the next status probe may still find those.
pub fn disconnect() -> Result<(), String> {
    if let Ok(path) = token_file() {
        let _ = std::fs::remove_file(path);
    }
    if let Ok(mut guard) = AUTH_CACHE.lock() {
        *guard = None;
    }
    Ok(())
}

// ───────────────────────────── device flow ─────────────────────────────

fn client_id() -> Option<String> {
    std::env::var("SKILL_STUDIO_GITHUB_CLIENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| (!DEFAULT_CLIENT_ID.is_empty()).then(|| DEFAULT_CLIENT_ID.to_string()))
}

struct DeviceFlow {
    client_id: String,
    device_code: String,
    interval: u64,
    expires_at: Instant,
}

static DEVICE: Mutex<Option<DeviceFlow>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    user_code: String,
    verification_uri: String,
    /// Seconds between polls (the client drives polling via `device_poll`).
    interval: u64,
    expires_in: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePoll {
    /// "pending" (keep polling) | "ok" (connected).
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    login: Option<String>,
    /// Current poll interval — grows when GitHub says `slow_down`.
    interval: u64,
}

/// Unauthenticated POST to github.com's OAuth endpoints (form in, JSON out).
fn oauth_post(url: &str, form: &[(&str, &str)]) -> Result<Value, String> {
    let resp = match agent()
        .post(url)
        .set("Accept", "application/json")
        .set("User-Agent", USER_AGENT)
        .send_form(form)
    {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("GitHub is unreachable: {e}")),
    };
    let text = resp.into_string().unwrap_or_default();
    serde_json::from_str(&text).map_err(|_| "Unexpected response from GitHub.".to_string())
}

/// Kick off the OAuth device flow: returns the code the user types at
/// github.com/login/device. Requires a registered client id.
pub fn device_start() -> Result<DeviceStart, String> {
    let id = client_id().ok_or_else(|| {
        "Device sign-in isn't configured in this build — paste a personal access token instead.".to_string()
    })?;
    let v = oauth_post(
        "https://github.com/login/device/code",
        &[("client_id", &id), ("scope", DEVICE_SCOPES)],
    )?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(format!("GitHub rejected the sign-in request: {err}"));
    }
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let n = |k: &str, d: u64| v.get(k).and_then(|x| x.as_u64()).unwrap_or(d);
    let (interval, expires_in) = (n("interval", 5), n("expires_in", 900));
    let start = DeviceStart {
        user_code: s("user_code"),
        verification_uri: {
            let u = s("verification_uri");
            if u.is_empty() { "https://github.com/login/device".into() } else { u }
        },
        interval,
        expires_in,
    };
    if start.user_code.is_empty() || s("device_code").is_empty() {
        return Err("GitHub didn't return a device code.".into());
    }
    if let Ok(mut guard) = DEVICE.lock() {
        *guard = Some(DeviceFlow {
            client_id: id,
            device_code: s("device_code"),
            interval,
            expires_at: Instant::now() + Duration::from_secs(expires_in),
        });
    }
    Ok(start)
}

/// One poll of the device flow. The client calls this every `interval` seconds
/// until "ok" (token stored, same as a pasted token) or an error (start over).
pub fn device_poll() -> Result<DevicePoll, String> {
    let (id, code, interval, expired) = {
        let guard = DEVICE.lock().map_err(|_| "Sign-in state unavailable.".to_string())?;
        let flow = guard.as_ref().ok_or_else(|| "No sign-in in progress — start again.".to_string())?;
        (
            flow.client_id.clone(),
            flow.device_code.clone(),
            flow.interval,
            Instant::now() >= flow.expires_at,
        )
    };
    if expired {
        let _ = DEVICE.lock().map(|mut g| *g = None);
        return Err("The sign-in code expired — start again.".into());
    }
    let v = oauth_post(
        "https://github.com/login/oauth/access_token",
        &[
            ("client_id", &id),
            ("device_code", &code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ],
    )?;
    if let Some(token) = v.get("access_token").and_then(|t| t.as_str()) {
        let info = connect_token(token)?; // validate + persist + cache
        let _ = DEVICE.lock().map(|mut g| *g = None);
        return Ok(DevicePoll { status: "ok".into(), login: Some(info.login), interval });
    }
    match v.get("error").and_then(|e| e.as_str()).unwrap_or("") {
        "authorization_pending" => Ok(DevicePoll { status: "pending".into(), login: None, interval }),
        "slow_down" => {
            let bumped = interval + 5;
            if let Ok(mut guard) = DEVICE.lock() {
                if let Some(flow) = guard.as_mut() {
                    flow.interval = bumped;
                }
            }
            Ok(DevicePoll { status: "pending".into(), login: None, interval: bumped })
        }
        "expired_token" => {
            let _ = DEVICE.lock().map(|mut g| *g = None);
            Err("The sign-in code expired — start again.".into())
        }
        "access_denied" => {
            let _ = DEVICE.lock().map(|mut g| *g = None);
            Err("Sign-in was cancelled on GitHub.".into())
        }
        other => Err(format!("GitHub sign-in failed: {other}")),
    }
}

// ───────────────────────────── owners ─────────────────────────────

/// A place the user can put the skill's repo: their account, or an org.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub login: String,
    /// "user" | "org"
    pub kind: String,
    /// The org's policy lets this user create repositories there.
    pub can_create: bool,
}

/// The personal account plus orgs (with repo-creation permission when the
/// token can see it). Org listing needs `read:org`; without it we fall back to
/// the basic org list and let an actual create fail with a clear error.
pub fn list_owners() -> Result<Vec<Owner>, String> {
    let (token, info) =
        resolve_auth(None, false).ok_or_else(|| "Connect GitHub first.".to_string())?;
    let mut owners =
        vec![Owner { login: info.login.clone(), kind: "user".into(), can_create: true }];

    let r = api(&token, "GET", &format!("{API}/user/memberships/orgs?state=active&per_page=100"), None)?;
    if r.status == 200 {
        for m in r.body.as_array().map(|a| a.as_slice()).unwrap_or_default() {
            let Some(login) = m.pointer("/organization/login").and_then(|l| l.as_str()) else {
                continue;
            };
            let can_create = m
                .pointer("/permissions/can_create_repository")
                .and_then(|c| c.as_bool())
                .unwrap_or(true);
            owners.push(Owner { login: login.to_string(), kind: "org".into(), can_create });
        }
    } else {
        // No read:org (e.g. a minimal PAT) — degrade to the plain org list.
        let r = api(&token, "GET", &format!("{API}/user/orgs?per_page=100"), None)?;
        if r.status == 200 {
            for o in r.body.as_array().map(|a| a.as_slice()).unwrap_or_default() {
                if let Some(login) = o.get("login").and_then(|l| l.as_str()) {
                    owners.push(Owner { login: login.to_string(), kind: "org".into(), can_create: true });
                }
            }
        }
    }
    Ok(owners)
}

// ───────────────────────────── publish (create + connect) ─────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhPublishResult {
    pub html_url: String,
    pub branch: String,
    /// Versions pushed by the initial publish.
    pub pushed: usize,
    pub login: String,
}

/// Create `owner/repo` EMPTY (no auto_init — the first push populates it with
/// the skill's real history; no README junk). A 422 "name already exists" is
/// tolerated only when the existing repo has no branches (safe to push into).
fn create_repo(token: &str, login: &str, owner: &str, repo: &str, private: bool) -> Result<String, String> {
    let html = |r: &ApiResp| {
        r.body
            .get("html_url")
            .and_then(|u| u.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("https://github.com/{owner}/{repo}"))
    };
    let body = json!({
        "name": repo,
        "private": private,
        "auto_init": false,
        "description": "Agent Skill — published from VibeStudio",
    });
    let url = if owner.eq_ignore_ascii_case(login) {
        format!("{API}/user/repos")
    } else {
        format!("{API}/orgs/{owner}/repos")
    };
    let c = api(token, "POST", &url, Some(&body))?;
    if c.status == 201 {
        return Ok(html(&c));
    }
    if c.status == 422 {
        // Exists already. Pushing into an EMPTY repo is safe; anything else
        // needs a deliberate decision from the user, not a silent merge.
        let b = api(token, "GET", &format!("{API}/repos/{owner}/{repo}/branches?per_page=1"), None)?;
        if b.status == 200 && b.body.as_array().map(|a| a.is_empty()).unwrap_or(false) {
            let r = api(token, "GET", &format!("{API}/repos/{owner}/{repo}"), None)?;
            return Ok(html(&r));
        }
        return Err(format!(
            "{owner}/{repo} already exists and isn't empty — pick a different name, or connect it by URL."
        ));
    }
    Err(api_err(&format!("create {owner}/{repo}"), &c))
}

/// Badge the repo (agent-skill + skill-studio) so all of an owner's skills are
/// one topic-filter away and Studio-managed repos are identifiable.
/// Best-effort — a policy that forbids topics shouldn't fail the publish.
fn set_skill_topics(token: &str, owner: &str, repo: &str) {
    let body = json!({ "names": SKILL_TOPICS });
    let _ = api(token, "PUT", &format!("{API}/repos/{owner}/{repo}/topics"), Some(&body));
}

/// Publish the skill's repository to GitHub: create `owner/repo` (empty,
/// private by default), set it as `origin`, and push the local history.
pub fn publish(root: &str, owner: &str, repo: &str, private: bool) -> Result<GhPublishResult, String> {
    if !valid_name(owner) || !valid_name(repo) {
        return Err("Repository names can use letters, digits, '-', '_' and '.'.".into());
    }
    let (root_path, branch) = remotesync::syncable(root)?;
    let (token, info) = resolve_auth(Some(&root_path), false)
        .ok_or_else(|| "Connect GitHub first — no usable GitHub sign-in was found on this machine.".to_string())?;

    match remotesync::origin_url(&root_path) {
        // Re-publishing the same destination is just a sync.
        Some(url)
            if remotesync::parse_github_remote(&url).as_ref().map(|(o, r)| (o.as_str(), r.as_str()))
                == Some((owner, repo)) =>
        {
            let out = remotesync::sync_now(root, Some(&token))?;
            Ok(GhPublishResult {
                html_url: format!("https://github.com/{owner}/{repo}"),
                branch,
                pushed: out.pushed,
                login: info.login,
            })
        }
        Some(url) => Err(format!("This skill is already connected to {url} — disconnect it first.")),
        None => {
            let html_url = create_repo(&token, &info.login, owner, repo, private)?;
            // connect_remote sets origin, pushes, and unwinds the origin if the
            // first push fails.
            let out = remotesync::connect_remote(
                root,
                &format!("https://github.com/{owner}/{repo}.git"),
                Some(&token),
            )?;
            set_skill_topics(&token, owner, repo);
            Ok(GhPublishResult { html_url, branch, pushed: out.pushed, login: info.login })
        }
    }
}

// ───────────────────────────── orchestration over remotesync ─────────────────────────────

/// The token for a remote op when this layer can supply one: github.com
/// remotes get our resolved token (private repos just work); any other remote
/// proceeds token-less on the machine's own git credentials.
fn token_for(root: &Path, url: &str) -> Result<Option<String>, String> {
    if remotesync::parse_github_remote(url).is_none() {
        return Ok(None);
    }
    resolve_auth(Some(root), false)
        .map(|(t, _)| Some(t))
        .ok_or_else(|| "Connect GitHub first — no usable GitHub sign-in was found on this machine.".to_string())
}

/// Reconcile the skill with its remote (any provider; remote-first semantics).
pub fn sync_now(root: &str) -> Result<remotesync::SyncOutcome, String> {
    let root_path = PathBuf::from(root);
    let token = match remotesync::origin_url(&root_path) {
        Some(url) => token_for(&root_path, &url)?,
        None => None, // remotesync reports the missing remote cleanly
    };
    remotesync::sync_now(root, token.as_deref())
}

/// Connect the skill to an existing remote by URL (any provider).
pub fn connect_remote(root: &str, url: &str) -> Result<remotesync::SyncOutcome, String> {
    let root_path = PathBuf::from(root);
    // For a github.com URL a token makes private repos work; for anything else
    // the machine's own git credentials are the native path — don't require
    // a GitHub sign-in to connect to GitLab.
    let token = if remotesync::parse_github_remote(url.trim()).is_some() {
        resolve_auth(Some(&root_path), false).map(|(t, _)| t)
    } else {
        None
    };
    remotesync::connect_remote(root, url, token.as_deref())
}

/// Import a skill by cloning its repository (any provider). github.com URLs
/// borrow our token when one is available (private repos); public repos and
/// other hosts clone on the machine's own git credentials — no sign-in needed.
pub fn import_skill_from_remote(
    url: &str,
    target: &str,
    overwrite: bool,
) -> Result<crate::sync::ImportResult, String> {
    let token = if remotesync::parse_github_remote(url.trim()).is_some() {
        resolve_auth(None, false).map(|(t, _)| t)
    } else {
        None
    };
    remotesync::import_from_remote(url, target, overwrite, token.as_deref())
}

/// Quiet background fast-forward pull (see `remotesync::auto_pull`).
pub fn auto_pull(root: &str) -> Result<remotesync::SyncOutcome, String> {
    let root_path = PathBuf::from(root);
    let token = remotesync::origin_url(&root_path)
        .and_then(|url| token_for(&root_path, &url).ok())
        .flatten();
    remotesync::auto_pull(root, token.as_deref())
}

pub use remotesync::unlink;

// ───────────────────────────── status ─────────────────────────────

/// Everything the "Publish to GitHub" panel needs in one call.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    /// Working GitHub sign-in, when one was found on this machine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<AuthInfo>,
    /// The gh CLI is installed (for the "run `gh auth login`" hint).
    pub gh_cli: bool,
    /// The OAuth device flow is available (a client id is configured).
    pub device_flow: bool,
    /// The skill is its own git repository (publishing requires it).
    pub tracked: bool,
    /// At least one version has been saved.
    pub has_version: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The skill's remote (any provider), when connected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<remotesync::RemoteLink>,
    /// Uncommitted changes exist (they sync only once saved as a version).
    pub dirty: bool,
    /// Versions to push / pull vs the remote — present only when `check_remote`
    /// was requested and the fetch succeeded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<usize>,
    /// The remote couldn't be reached (offline, auth) — shown, not fatal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_error: Option<String>,
}

pub fn github_status(root: &str, check_remote: bool) -> Result<GhStatus, String> {
    let root_path = PathBuf::from(root);
    let auth = resolve_auth(Some(&root_path), true).map(|(_, info)| info);
    let info = crate::gitops::git_info(root)?;
    let tracked = info.is_repo;
    let has_version =
        tracked && crate::gitops::git_ok(&root_path, &["rev-parse", "--verify", "HEAD"]).is_some();
    let branch = crate::gitops::current_branch(&root_path);
    let link = if tracked { remotesync::link_of(&root_path) } else { None };
    let dirty = crate::gitops::git_dirty_many(&[root.to_string()])
        .first()
        .map(|d| d.dirty)
        .unwrap_or(false);

    let (mut ahead, mut behind, mut remote_error) = (None, None, None);
    if check_remote {
        if let (Some(link), Some(b)) = (&link, &branch) {
            let token = token_for(&root_path, &link.url).unwrap_or(None);
            match remotesync::remote_check(&root_path, b, token.as_deref()) {
                Ok((a, bh)) => (ahead, behind) = (Some(a), Some(bh)),
                Err(e) => remote_error = Some(e),
            }
        }
    }

    Ok(GhStatus {
        auth,
        gh_cli: gh_cli_available(),
        device_flow: client_id().is_some(),
        tracked,
        has_version,
        branch,
        link,
        dirty,
        ahead,
        behind,
        remote_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_output_parses() {
        let out = "protocol=https\nhost=github.com\nusername=x\npassword=gho_abc123\n";
        assert_eq!(parse_credential_password(out).as_deref(), Some("gho_abc123"));
        assert_eq!(parse_credential_password("username=x\n"), None);
        assert_eq!(parse_credential_password(""), None);
    }

    #[test]
    fn names_validated() {
        assert!(valid_name("my-skill"));
        assert!(valid_name("My_Repo.2"));
        assert!(!valid_name(""));
        assert!(!valid_name("a/b"));
        assert!(!valid_name("a b"));
    }
}
