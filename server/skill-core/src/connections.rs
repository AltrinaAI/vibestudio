// MCP connections: VibeStudio is the OAuth 2.1 client for remote MCP servers
// (metadata discovery → dynamic client registration → PKCE authorization-code).
// Tokens live only here — agents reach the MCP through the server's loopback
// /gw/<id>/mcp gateway, which injects Authorization upstream. The connection id
// doubles as the gateway path slug (a capability), so it must be unguessable.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::agents;
use crate::commit_agent;
use crate::process::hidden_command;
use crate::secrets;

/// A consent flow (begin → browser → callback) must finish within this window;
/// a server restart mid-consent kills the flow, which is acceptable.
const FLOW_TTL: Duration = Duration::from_secs(600);
/// Refresh the access token when within this many seconds of expiry.
const EXPIRY_SLACK: u64 = 60;
/// Cap on each `<agent> mcp …` shell-out (local config edit, no network).
const AGENT_CLI_TIMEOUT: Duration = Duration::from_secs(20);

/// One stored connection. Persisted verbatim (camelCase JSON) in
/// `~/.config/vibestudio/connections.json`; never returned over the API —
/// the UI sees the token-free [`ConnectionInfo`] projection.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub label: String,
    pub mcp_url: String,
    /// RFC 8707 resource indicator: the MCP URL normalized (lowercase
    /// scheme/host, no fragment). Sent on every token request.
    pub resource: String,
    pub host: String,
    pub issuer: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    pub token_endpoint: String,
    pub registration_endpoint: String,
    pub authorization_endpoint: String,
    pub access_token: String,
    #[serde(default)]
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// `connected` | `needs_reauth` | `error`.
    pub status: String,
    #[serde(default)]
    pub last_error: Option<String>,
    pub created_at: u64,
    #[serde(default)]
    pub agents_configured: Vec<String>,
    /// The gateway port last written into agent configs — lets a restart on a
    /// different bound port detect and rewrite stale `/gw` URLs.
    #[serde(default)]
    pub gateway_port: Option<u16>,
}

/// The UI-facing projection — deliberately NO token material.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: String,
    pub label: String,
    pub host: String,
    pub scopes: Vec<String>,
    pub status: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub agents_configured: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginOk {
    pub state: String,
    pub authorize_url: String,
}

/// Typed begin/reconnect failure: `code` is the wire `error` field
/// (`no_pkce` | `discovery_failed` | `registration_failed`).
pub struct BeginError {
    pub code: &'static str,
    pub message: String,
}

fn err(code: &'static str, message: impl Into<String>) -> BeginError {
    BeginError { code, message: message.into() }
}

// ───────────────────────────── store ─────────────────────────────

fn store_file() -> Result<PathBuf, String> {
    Ok(secrets::config_dir()?.join("connections.json"))
}

fn load_all() -> Result<Vec<Connection>, String> {
    match std::fs::read(store_file()?) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("Corrupt connections store: {e}"))
        }
        Err(_) => Ok(Vec::new()),
    }
}

/// Every mutation funnels through here: one process-wide lock around the
/// load-modify-save, and an atomic (tmp + rename) 0600 write so a torn write
/// can never lose or leak tokens.
fn with_store<T>(f: impl FnOnce(&mut Vec<Connection>) -> Result<T, String>) -> Result<T, String> {
    static WRITE: Mutex<()> = Mutex::new(());
    let _g = WRITE.lock().map_err(|_| "Connections store is unavailable.".to_string())?;
    let mut list = load_all()?;
    let out = f(&mut list)?;
    secrets::ensure_dir()?;
    let path = store_file()?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&list).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    secrets::set_mode(&tmp, 0o600);
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(out)
}

fn find(id: &str) -> Result<Option<Connection>, String> {
    Ok(load_all()?.into_iter().find(|c| c.id == id))
}

fn upsert(conn: Connection) -> Result<(), String> {
    with_store(|list| {
        list.retain(|c| c.id != conn.id);
        list.push(conn);
        Ok(())
    })
}

pub fn list() -> Result<Vec<ConnectionInfo>, String> {
    let mut out: Vec<ConnectionInfo> = load_all()?
        .into_iter()
        .map(|c| ConnectionInfo {
            id: c.id,
            label: c.label,
            host: c.host,
            scopes: c.scopes,
            status: c.status,
            created_at: c.created_at,
            last_error: c.last_error,
            agents_configured: c.agents_configured,
        })
        .collect();
    out.sort_by_key(|c| c.created_at);
    Ok(out)
}

// ───────────────────────────── small helpers ─────────────────────────────

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf).expect("getrandom failed");
    buf
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `("https://host:port", "/path")` — scheme/authority lowercased, the path
/// stripped of query/fragment and trailing slashes (well-known suffix form).
fn split_url(url: &str) -> Result<(String, String), String> {
    let (scheme, rest) =
        url.split_once("://").ok_or_else(|| format!("Not an absolute URL: {url}"))?;
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].trim_end_matches('/')),
        None => (rest, ""),
    };
    if authority.is_empty() {
        return Err(format!("Not an absolute URL: {url}"));
    }
    Ok((
        format!("{}://{}", scheme.to_ascii_lowercase(), authority.to_ascii_lowercase()),
        path.to_string(),
    ))
}

/// RFC 8707 normalization: lowercase scheme + authority, drop the fragment,
/// keep the path byte-for-byte.
fn normalize_resource(url: &str) -> String {
    let url = url.split('#').next().unwrap_or(url);
    match url.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, tail) = match rest.find('/') {
                Some(i) => (&rest[..i], &rest[i..]),
                None => (rest, ""),
            };
            format!("{}://{}{}", scheme.to_ascii_lowercase(), authority.to_ascii_lowercase(), tail)
        }
        None => url.to_string(),
    }
}

fn host_of(url: &str) -> String {
    url.split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

// ───────────────────────────── HTTP plumbing ─────────────────────────────

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .build()
}

fn get_json(url: &str) -> Result<Value, String> {
    let resp = agent().get(url).set("Accept", "application/json").call().map_err(|e| match e {
        ureq::Error::Status(code, _) => format!("{url} returned {code}"),
        e => format!("{url} is unreachable: {e}"),
    })?;
    let text = resp.into_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|_| format!("{url} returned non-JSON"))
}

/// First ~200 chars of an error response body, for a readable lastError.
fn body_snippet(resp: ureq::Response) -> String {
    resp.into_string().unwrap_or_default().chars().take(200).collect()
}

enum TokenHttpError {
    /// The AS refused the grant (4xx) — re-authorization is the fix.
    Denied(u16, String),
    /// Transport trouble / 5xx — retrying later may work.
    Transport(String),
}

impl TokenHttpError {
    fn message(&self) -> String {
        match self {
            TokenHttpError::Denied(code, detail) => format!("({code}) {detail}"),
            TokenHttpError::Transport(m) => m.clone(),
        }
    }
}

fn token_post(url: &str, form: &[(&str, &str)]) -> Result<Value, TokenHttpError> {
    let resp = match agent().post(url).set("Accept", "application/json").send_form(form) {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) if (400..500).contains(&code) => {
            return Err(TokenHttpError::Denied(code, body_snippet(r)));
        }
        Err(ureq::Error::Status(code, _)) => {
            return Err(TokenHttpError::Transport(format!("{url} returned {code}")));
        }
        Err(e) => return Err(TokenHttpError::Transport(format!("{url} is unreachable: {e}"))),
    };
    let text = resp.into_string().unwrap_or_default();
    serde_json::from_str(&text).map_err(|_| TokenHttpError::Transport(format!("{url} returned non-JSON")))
}

// ───────────────────────────── discovery ─────────────────────────────

struct Discovered {
    issuer: String,
    scopes: Vec<String>,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
}

/// `resource_metadata="…"` from a WWW-Authenticate challenge.
fn challenge_resource_metadata(header: &str) -> Option<String> {
    let rest = header.split("resource_metadata=").nth(1)?;
    if let Some(quoted) = rest.strip_prefix('"') {
        return quoted.split('"').next().map(str::to_string);
    }
    rest.split([',', ' ']).next().map(str::to_string).filter(|s| !s.is_empty())
}

/// MCP auth-spec step 1: an unauthenticated POST should 401 with a
/// WWW-Authenticate pointing at the protected-resource metadata. Anything
/// else → `None`, and discovery falls back to the well-known paths.
fn prm_from_challenge(mcp_url: &str) -> Option<String> {
    let resp = match agent()
        .post(mcp_url)
        .set("Accept", "application/json, text/event-stream")
        .set("Content-Type", "application/json")
        .send_string("{}")
    {
        Err(ureq::Error::Status(401, r)) => r,
        _ => return None,
    };
    challenge_resource_metadata(resp.header("www-authenticate")?)
}

/// RFC 8414 / OIDC discovery for `issuer`, path-inserted variants first
/// (Robinhood-style issuers carry a path).
fn as_metadata(issuer: &str) -> Result<Value, String> {
    let (origin, path) = split_url(issuer)?;
    let mut candidates = Vec::new();
    if !path.is_empty() {
        candidates.push(format!("{origin}/.well-known/oauth-authorization-server{path}"));
    }
    candidates.push(format!("{origin}/.well-known/oauth-authorization-server"));
    if !path.is_empty() {
        candidates.push(format!("{origin}/.well-known/openid-configuration{path}"));
    }
    candidates.push(format!("{origin}/.well-known/openid-configuration"));
    for c in &candidates {
        if let Ok(v) = get_json(c) {
            if v.get("authorization_endpoint").is_some() && v.get("token_endpoint").is_some() {
                return Ok(v);
            }
        }
    }
    Err(format!("No authorization-server metadata found for {issuer}."))
}

fn discover(mcp_url: &str) -> Result<Discovered, BeginError> {
    let (origin, path) = split_url(mcp_url).map_err(|e| err("discovery_failed", e))?;
    let mut candidates: Vec<String> = prm_from_challenge(mcp_url).into_iter().collect();
    candidates.push(format!("{origin}/.well-known/oauth-protected-resource{path}"));
    if !path.is_empty() {
        candidates.push(format!("{origin}/.well-known/oauth-protected-resource"));
    }
    candidates.dedup();
    let prm = candidates
        .iter()
        .find_map(|c| get_json(c).ok().filter(|v| v.get("authorization_servers").is_some()))
        .ok_or_else(|| {
            err("discovery_failed", format!("No OAuth protected-resource metadata found for {mcp_url}."))
        })?;
    let issuer = prm
        .get("authorization_servers")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            err("discovery_failed", "The protected-resource metadata lists no authorization server.")
        })?
        .to_string();
    let scopes: Vec<String> = prm
        .get("scopes_supported")
        .and_then(|s| s.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let meta = as_metadata(&issuer).map_err(|m| err("discovery_failed", m))?;
    // The MCP auth spec makes PKCE a MUST; an AS that doesn't advertise S256
    // support is refused rather than downgraded.
    let s256 = meta
        .get("code_challenge_methods_supported")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().any(|m| m.as_str() == Some("S256")))
        .unwrap_or(false);
    if !s256 {
        return Err(err(
            "no_pkce",
            format!("{issuer} does not advertise PKCE S256 support, which MCP requires — refusing to connect."),
        ));
    }
    let field = |k: &str| meta.get(k).and_then(|v| v.as_str()).map(str::to_string);
    Ok(Discovered {
        issuer,
        scopes,
        authorization_endpoint: field("authorization_endpoint")
            .ok_or_else(|| err("discovery_failed", "Authorization-server metadata has no authorization_endpoint."))?,
        token_endpoint: field("token_endpoint")
            .ok_or_else(|| err("discovery_failed", "Authorization-server metadata has no token_endpoint."))?,
        registration_endpoint: field("registration_endpoint"),
    })
}

/// RFC 7591 dynamic registration as a public client (PKCE, no secret).
fn register_client(endpoint: &str, redirect_uri: &str) -> Result<String, BeginError> {
    let body = json!({
        "client_name": "VibeStudio",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let resp = match agent()
        .post(endpoint)
        .set("Accept", "application/json")
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
    {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            return Err(err(
                "registration_failed",
                format!("Client registration at {endpoint} failed ({code}): {}", body_snippet(r)),
            ));
        }
        Err(e) => {
            return Err(err("registration_failed", format!("Client registration at {endpoint} failed: {e}")));
        }
    };
    let v: Value = serde_json::from_str(&resp.into_string().unwrap_or_default())
        .map_err(|_| err("registration_failed", "The registration response wasn't JSON."))?;
    v.get("client_id")
        .and_then(|c| c.as_str())
        .map(str::to_string)
        .ok_or_else(|| err("registration_failed", "The registration response carried no client_id."))
}

// ───────────────────────────── consent flow ─────────────────────────────

struct Pending {
    verifier: String,
    draft: Connection,
    created: Instant,
}

struct Outcome {
    status: String,
    id: Option<String>,
    at: Instant,
}

fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static M: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// state → outcome, kept `FLOW_TTL` so /connection-pending can answer after
/// the callback landed.
fn completed() -> &'static Mutex<HashMap<String, Outcome>> {
    static M: OnceLock<Mutex<HashMap<String, Outcome>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn purge_flows() {
    if let Ok(mut p) = pending().lock() {
        p.retain(|_, x| x.created.elapsed() < FLOW_TTL);
    }
    if let Ok(mut c) = completed().lock() {
        c.retain(|_, o| o.at.elapsed() < FLOW_TTL);
    }
}

pub fn begin(url: &str, origin: &str, label: Option<&str>) -> Result<BeginOk, BeginError> {
    let url = url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(err("discovery_failed", "Enter the MCP server's full http(s) URL."));
    }
    start_flow(url, origin, label, None)
}

/// Re-run discovery + registration against the current origin, preserving the
/// existing id/label/mcpUrl so the gateway URL agents already hold stays valid.
pub fn reconnect(id: &str, origin: &str) -> Result<BeginOk, BeginError> {
    let existing = find(id)
        .map_err(|e| err("discovery_failed", e))?
        .ok_or_else(|| err("discovery_failed", "No such connection."))?;
    let mcp_url = existing.mcp_url.clone();
    start_flow(&mcp_url, origin, None, Some(existing))
}

fn start_flow(
    mcp_url: &str,
    origin: &str,
    label: Option<&str>,
    existing: Option<Connection>,
) -> Result<BeginOk, BeginError> {
    purge_flows();
    let disc = discover(mcp_url)?;
    let redirect_uri = format!("{}/api/connections/callback", origin.trim_end_matches('/'));
    let reg_endpoint = disc.registration_endpoint.clone().ok_or_else(|| {
        err("registration_failed", format!("{} offers no dynamic client registration.", disc.issuer))
    })?;
    let client_id = register_client(&reg_endpoint, &redirect_uri)?;

    let host = host_of(mcp_url);
    let resource = normalize_resource(mcp_url);
    let draft = match existing {
        Some(mut e) => {
            e.resource = resource.clone();
            e.host = host;
            e.issuer = disc.issuer.clone();
            e.client_id = client_id;
            e.redirect_uri = redirect_uri;
            e.scopes = disc.scopes.clone();
            e.token_endpoint = disc.token_endpoint.clone();
            e.registration_endpoint = reg_endpoint;
            e.authorization_endpoint = disc.authorization_endpoint.clone();
            e
        }
        None => Connection {
            id: hex(&rand_bytes::<16>()),
            label: label
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| host.clone()),
            mcp_url: mcp_url.to_string(),
            resource: resource.clone(),
            host,
            issuer: disc.issuer.clone(),
            client_id,
            redirect_uri,
            scopes: disc.scopes.clone(),
            token_endpoint: disc.token_endpoint.clone(),
            registration_endpoint: reg_endpoint,
            authorization_endpoint: disc.authorization_endpoint.clone(),
            access_token: String::new(),
            expires_at: None,
            refresh_token: None,
            status: "connected".into(),
            last_error: None,
            created_at: now_secs(),
            agents_configured: Vec::new(),
            gateway_port: None,
        },
    };

    let state = hex(&rand_bytes::<16>());
    let verifier = b64url(&rand_bytes::<32>());
    let challenge = b64url(Sha256::digest(verifier.as_bytes()).as_slice());
    let enc = urlencoding::encode;
    let sep = if disc.authorization_endpoint.contains('?') { '&' } else { '?' };
    // `resource` (RFC 8707) rides along regardless of advertised AS support —
    // MCP requires clients to bind tokens to the resource.
    let mut authorize_url = format!(
        "{}{}response_type=code&client_id={}&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256&resource={}",
        disc.authorization_endpoint,
        sep,
        enc(&draft.client_id),
        enc(&draft.redirect_uri),
        state,
        challenge,
        enc(&resource),
    );
    if !draft.scopes.is_empty() {
        authorize_url.push_str(&format!("&scope={}", enc(&draft.scopes.join(" "))));
    }
    if let Ok(mut p) = pending().lock() {
        p.insert(state.clone(), Pending { verifier, draft, created: Instant::now() });
    }
    Ok(BeginOk { state, authorize_url })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingStatus {
    /// `waiting` | `done` | `denied` | `expired`.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

pub fn pending_status(state: &str) -> PendingStatus {
    purge_flows();
    if pending().lock().map(|p| p.contains_key(state)).unwrap_or(false) {
        return PendingStatus { status: "waiting".into(), id: None };
    }
    if let Ok(c) = completed().lock() {
        if let Some(o) = c.get(state) {
            return PendingStatus { status: o.status.clone(), id: o.id.clone() };
        }
    }
    PendingStatus { status: "expired".into(), id: None }
}

pub enum CallbackOutcome {
    Success { label: String },
    Denied,
    Failed { message: String },
}

/// The browser redirect from the authorization server. Exchanges the code,
/// persists the connection, then points Claude Code at the gateway on
/// `gw_port` (this server's actual bound port).
pub fn finish_callback(state: &str, code: &str, error: &str, gw_port: u16) -> CallbackOutcome {
    purge_flows();
    let Some(pend) = pending().lock().ok().and_then(|mut p| p.remove(state)) else {
        return CallbackOutcome::Failed {
            message: "This authorization link is unknown or has expired. Return to VibeStudio and start again."
                .into(),
        };
    };
    let mark = |status: &str, id: Option<String>| {
        if let Ok(mut c) = completed().lock() {
            c.insert(state.to_string(), Outcome { status: status.into(), id, at: Instant::now() });
        }
    };
    // Hold the poll in `waiting` across the exchange + agent-config step (network
    // plus two `claude` shell-outs); without it the state is briefly in neither
    // map and a successful connect momentarily reads as `expired`.
    mark("waiting", None);
    if error == "access_denied" {
        mark("denied", None);
        return CallbackOutcome::Denied;
    }
    if !error.is_empty() {
        mark("denied", None);
        return CallbackOutcome::Failed {
            message: format!("The authorization server reported an error: {error}."),
        };
    }
    if code.is_empty() {
        mark("denied", None);
        return CallbackOutcome::Failed { message: "The authorization server sent no code.".into() };
    }

    let mut conn = pend.draft;
    let v = match token_post(
        &conn.token_endpoint,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &conn.redirect_uri),
            ("client_id", &conn.client_id),
            ("code_verifier", &pend.verifier),
            ("resource", &conn.resource),
        ],
    ) {
        Ok(v) => v,
        // A failed exchange marks `expired`, so the UI drops back to a clean retry.
        Err(e) => {
            mark("expired", None);
            return CallbackOutcome::Failed {
                message: format!("Exchanging the authorization code failed: {}", e.message()),
            };
        }
    };
    let Some(access) = v.get("access_token").and_then(|t| t.as_str()) else {
        mark("expired", None);
        return CallbackOutcome::Failed { message: "The token response carried no access token.".into() };
    };
    conn.access_token = access.to_string();
    conn.expires_at = v.get("expires_in").and_then(|x| x.as_u64()).map(|s| now_secs() + s);
    conn.refresh_token = v.get("refresh_token").and_then(|t| t.as_str()).map(str::to_string);
    conn.status = "connected".into();
    conn.last_error = None;
    conn.agents_configured = Vec::new();
    let (id, label) = (conn.id.clone(), conn.label.clone());
    if let Err(e) = upsert(conn) {
        mark("expired", None);
        return CallbackOutcome::Failed { message: format!("Saving the connection failed: {e}") };
    }
    // Best-effort: agents that aren't installed are skipped, so agentsConfigured
    // holds whatever we actually wired — the connection itself is fine regardless.
    let wired = configure_agents(&server_name(&label, &id), &format!("http://127.0.0.1:{gw_port}/gw/{id}/mcp"));
    if !wired.is_empty() {
        let _ = with_store(|list| {
            if let Some(c) = list.iter_mut().find(|c| c.id == id) {
                c.agents_configured = wired;
                c.gateway_port = Some(gw_port);
            }
            Ok(())
        });
    }
    mark("done", Some(id));
    CallbackOutcome::Success { label }
}

// ───────────────────────────── token refresh ─────────────────────────────

/// What the gateway needs for one upstream call — never persisted, never serialized.
pub struct FreshToken {
    pub access_token: String,
    pub mcp_url: String,
    pub label: String,
}

pub enum TokenError {
    /// No connection with that id.
    Unknown,
    /// The grant is dead — the user must re-authorize in the UI.
    NeedsReauth { label: String },
    /// Network trouble reaching the token endpoint; nothing was marked.
    Transient(String),
}

fn flight_lock(id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let cell = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = cell.lock().unwrap_or_else(|p| p.into_inner());
    map.entry(id.to_string()).or_default().clone()
}

fn mark_needs_reauth(id: &str, why: &str) {
    let _ = with_store(|list| {
        if let Some(c) = list.iter_mut().find(|c| c.id == id) {
            c.status = "needs_reauth".into();
            c.last_error = Some(why.to_string());
        }
        Ok(())
    });
}

/// A usable access token for `id`, refreshed when within `EXPIRY_SLACK` of
/// expiry — or force-refreshed when `stale` matches the stored token (the
/// gateway's upstream-401 retry). Single-flight per connection: concurrent
/// requests serialize here, and a waiter whose `stale` token was already
/// replaced skips the second refresh. OAuth 2.1 rotates refresh tokens, so the
/// rotated one is persisted BEFORE the new access token is returned.
pub fn ensure_fresh_token(id: &str, stale: Option<&str>) -> Result<FreshToken, TokenError> {
    let lock = flight_lock(id);
    let _g = lock.lock().unwrap_or_else(|p| p.into_inner());
    let conn = find(id).ok().flatten().ok_or(TokenError::Unknown)?;
    let stale_hit = stale.map(|s| s == conn.access_token).unwrap_or(false);
    let due = conn.expires_at.map(|e| now_secs() + EXPIRY_SLACK >= e).unwrap_or(false);
    if !stale_hit && !due && !conn.access_token.is_empty() {
        return Ok(FreshToken {
            access_token: conn.access_token,
            mcp_url: conn.mcp_url,
            label: conn.label,
        });
    }
    let Some(refresh) = conn.refresh_token.clone().filter(|r| !r.is_empty()) else {
        mark_needs_reauth(id, "The access token expired and no refresh token was issued.");
        return Err(TokenError::NeedsReauth { label: conn.label });
    };
    match token_post(
        &conn.token_endpoint,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh),
            ("client_id", &conn.client_id),
            ("resource", &conn.resource),
        ],
    ) {
        Ok(v) => {
            let Some(access) = v.get("access_token").and_then(|t| t.as_str()).map(str::to_string)
            else {
                mark_needs_reauth(id, "The refresh response carried no access token.");
                return Err(TokenError::NeedsReauth { label: conn.label });
            };
            let expires_at = v.get("expires_in").and_then(|x| x.as_u64()).map(|s| now_secs() + s);
            let rotated = v.get("refresh_token").and_then(|t| t.as_str()).map(str::to_string);
            with_store(|list| {
                if let Some(c) = list.iter_mut().find(|c| c.id == id) {
                    c.access_token = access.clone();
                    c.expires_at = expires_at;
                    if rotated.is_some() {
                        c.refresh_token = rotated.clone();
                    }
                    c.status = "connected".into();
                    c.last_error = None;
                }
                Ok(())
            })
            .map_err(TokenError::Transient)?;
            Ok(FreshToken { access_token: access, mcp_url: conn.mcp_url, label: conn.label })
        }
        Err(TokenHttpError::Denied(code, detail)) => {
            mark_needs_reauth(id, &format!("Token refresh was refused ({code}): {detail}"));
            Err(TokenError::NeedsReauth { label: conn.label })
        }
        Err(TokenHttpError::Transport(m)) => Err(TokenError::Transient(m)),
    }
}

// ───────────────────────────── delete ─────────────────────────────

/// Best-effort RFC 7009 revoke (only if the AS advertises a
/// revocation_endpoint — re-read from metadata; the record stores none),
/// remove the agent config entries, then drop the record. Idempotent.
pub fn delete(id: &str) -> Result<(), String> {
    let Some(conn) = find(id)? else { return Ok(()) };
    if let Ok(meta) = as_metadata(&conn.issuer) {
        if let Some(rev) = meta.get("revocation_endpoint").and_then(|v| v.as_str()) {
            let (token, hint) = match conn.refresh_token.as_deref().filter(|r| !r.is_empty()) {
                Some(r) => (r, "refresh_token"),
                None => (conn.access_token.as_str(), "access_token"),
            };
            if !token.is_empty() {
                let _ = agent().post(rev).send_form(&[
                    ("token", token),
                    ("token_type_hint", hint),
                    ("client_id", &conn.client_id),
                ]);
            }
        }
    }
    unconfigure_agents(&server_name(&conn.label, &conn.id));
    with_store(|list| {
        list.retain(|c| c.id != id);
        Ok(())
    })
}

// ─────────────────────────── agent MCP config ───────────────────────────

/// The label slugged to kebab-case (e.g. "robinhood-trading").
fn kebab_slug(label: &str) -> String {
    let mut out = String::new();
    for c in label.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() { "mcp-connection".into() } else { out.to_string() }
}

/// The MCP server name a connection registers under, in EVERY agent: the label
/// slug plus a short id suffix, so two connections that share (or slug to) the
/// same label can't clobber each other's entry — and delete removes exactly its
/// own.
fn server_name(label: &str, id: &str) -> String {
    format!("{}-{}", kebab_slug(label), &id[..id.len().min(8)])
}

/// Point every cohort agent that declares MCP support (see [`agents::AGENTS`])
/// at the gateway `url` under the shared server `name`. Best-effort per agent —
/// a missing binary or config dir is skipped — returning the families actually
/// wired (persisted as `agents_configured`). CLI agents re-add idempotently; the
/// JSON-file agents merge without disturbing the user's other servers.
fn configure_agents(name: &str, url: &str) -> Vec<String> {
    let mut wired = Vec::new();
    for a in agents::AGENTS {
        if let Some(w) = a.mcp {
            if wire_add(&w, name, url) {
                wired.push(a.family.to_string());
            }
        }
    }
    wired
}

/// Remove the connection's server `name` from every cohort agent. Idempotent.
fn unconfigure_agents(name: &str) {
    for a in agents::AGENTS {
        if let Some(w) = a.mcp {
            wire_remove(&w, name);
        }
    }
}

fn wire_add(w: &agents::McpWiring, name: &str, url: &str) -> bool {
    match *w {
        agents::McpWiring::Cli { bin, add, remove } => {
            let Some(path) = commit_agent::resolve(&[bin]) else { return false };
            let _ = run_agent_cli(&path, &remove(name)); // idempotent pre-clean
            run_agent_cli(&path, &add(name, url)).unwrap_or(false)
        }
        agents::McpWiring::JsonFile { present_dir, path, servers_key, entry } => {
            json_file_set(present_dir, path, servers_key, name, Some(entry(url)))
        }
    }
}

fn wire_remove(w: &agents::McpWiring, name: &str) {
    match *w {
        agents::McpWiring::Cli { bin, remove, .. } => {
            if let Some(path) = commit_agent::resolve(&[bin]) {
                let _ = run_agent_cli(&path, &remove(name));
            }
        }
        agents::McpWiring::JsonFile { present_dir, path, servers_key, .. } => {
            let _ = json_file_set(present_dir, path, servers_key, name, None);
        }
    }
}

/// Run `<bin> <args…>` (an `mcp add|remove` subcommand). `Ok(true)` = the add
/// reported success.
fn run_agent_cli(bin: &Path, args: &[String]) -> Result<bool, String> {
    let mut cmd = hidden_command(bin);
    cmd.args(args);
    commit_agent::run_proc(cmd, None, AGENT_CLI_TIMEOUT).map(|(ok, _)| ok)
}

/// Merge (or, with `entry = None`, remove) `servers_key.<name>` in the agent's
/// home-relative JSON config, preserving every other key. Only acts when
/// `present_dir` exists (the agent is installed), and never creates a file just
/// to delete a key.
fn json_file_set(
    present_dir: &str,
    path: &str,
    servers_key: &str,
    name: &str,
    entry: Option<Value>,
) -> bool {
    // One writer at a time (two OAuth callbacks completing at once would
    // otherwise read-modify-write the same shared file and lose an entry).
    static WRITE: Mutex<()> = Mutex::new(());
    let _g = WRITE.lock().unwrap_or_else(|p| p.into_inner());
    let Some(home) = dirs::home_dir() else { return false };
    if !home.join(present_dir).is_dir() {
        return false;
    }
    let file = home.join(path);
    // Absent/empty ⇒ start fresh; present-but-unparseable ⇒ bail rather than
    // clobber a config we can't safely round-trip (would drop the user's servers).
    let existing: Option<Value> = match std::fs::read(&file) {
        Ok(bytes) if bytes.iter().any(|b| !b.is_ascii_whitespace()) => {
            match serde_json::from_slice(&bytes) {
                Ok(v) => Some(v),
                Err(_) => return false,
            }
        }
        _ => None,
    };
    if entry.is_none() && existing.is_none() {
        return true; // nothing to remove
    }
    let mut root = existing.unwrap_or_else(|| json!({}));
    let Some(obj) = root.as_object_mut() else { return false };
    let servers = obj.entry(servers_key.to_string()).or_insert_with(|| json!({}));
    let Some(map) = servers.as_object_mut() else { return false };
    match entry {
        Some(v) => {
            map.insert(name.to_string(), v);
        }
        None => {
            if map.remove(name).is_none() {
                return true; // wasn't wired here
            }
        }
    }
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(mut bytes) = serde_json::to_vec_pretty(&root) else { return false };
    bytes.push(b'\n');
    // Atomic tmp+rename (the store's own convention) so a crash mid-write can't
    // truncate the user's config.
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes).is_ok() && std::fs::rename(&tmp, &file).is_ok()
}

/// Rewrite agent MCP configs to this boot's gateway `port`. The desktop may bind
/// an ephemeral port when its preferred one is taken, which would leave a prior
/// boot's `/gw` URL dead; only connections whose recorded port differs (and that
/// wired at least one agent) are touched, so a normal boot does no work.
/// Best-effort; re-wires whatever cohort is installed now.
pub fn resync_agent_configs(port: u16) {
    let Ok(conns) = load_all() else { return };
    for c in conns {
        if c.gateway_port == Some(port) || c.agents_configured.is_empty() {
            continue;
        }
        let wired =
            configure_agents(&server_name(&c.label, &c.id), &format!("http://127.0.0.1:{port}/gw/{}/mcp", c.id));
        // Commit only a real re-wire; an empty result is a transient failure (CLI
        // timeout / momentarily unresolvable binary), so leave the stale port —
        // marking it done would strand the dead URL and never retry.
        if wired.is_empty() {
            continue;
        }
        let _ = with_store(|list| {
            if let Some(x) = list.iter_mut().find(|x| x.id == c.id) {
                x.agents_configured = wired;
                x.gateway_port = Some(port);
            }
            Ok(())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_kebab() {
        assert_eq!(kebab_slug("Robinhood Trading"), "robinhood-trading");
        assert_eq!(kebab_slug("A__B..9"), "a-b-9");
        assert_eq!(kebab_slug("  --  "), "mcp-connection");
    }

    #[test]
    fn server_names_disambiguate_shared_labels() {
        // Same label, different connection ids ⇒ distinct per-agent entries, so
        // one connection's config can't overwrite or delete another's.
        let a = server_name("Robinhood Trading", "0011223344aabbcc");
        let b = server_name("Robinhood Trading", "ffeeddcc99887766");
        assert_ne!(a, b);
        assert!(a.starts_with("robinhood-trading-"));
    }

    #[test]
    fn json_file_set_skips_absent_agent() {
        // An agent whose home dir doesn't exist is a no-op — we never create a
        // config file for an agent that isn't installed (add or remove).
        let missing = ".vibestudio-nonexistent-agent-xyz";
        assert!(!json_file_set(missing, &format!("{missing}/x.json"), "mcpServers", "n", Some(json!({ "url": "u" }))));
        assert!(!json_file_set(missing, &format!("{missing}/x.json"), "mcpServers", "n", None));
    }

    #[test]
    fn in_flight_exchange_reads_as_waiting_not_expired() {
        // While finish_callback holds a flow in `waiting` during the exchange,
        // the poll must keep waiting — not fall through to `expired`, which the
        // UI treats as a terminal failure on an otherwise-successful connect.
        let state = "test-inflight-state";
        completed()
            .lock()
            .unwrap()
            .insert(state.into(), Outcome { status: "waiting".into(), id: None, at: Instant::now() });
        assert_eq!(pending_status(state).status, "waiting");
        completed().lock().unwrap().remove(state);
    }

    #[test]
    fn urls_split_and_normalize() {
        assert_eq!(
            split_url("HTTPS://Agent.Robinhood.com/mcp/trading?x=1#f").unwrap(),
            ("https://agent.robinhood.com".to_string(), "/mcp/trading".to_string())
        );
        assert_eq!(split_url("https://a.b").unwrap(), ("https://a.b".to_string(), String::new()));
        // Path case survives normalization; the fragment does not.
        assert_eq!(
            normalize_resource("HTTPS://Agent.Robinhood.com/MCP/Trading#frag"),
            "https://agent.robinhood.com/MCP/Trading"
        );
        assert_eq!(host_of("https://user@Agent.Robinhood.com:443/mcp"), "agent.robinhood.com:443");
    }

    #[test]
    fn challenge_header_parses_quoted_and_bare() {
        let quoted = r#"Bearer resource_metadata="https://x/.well-known/oauth-protected-resource/mcp", error="unauthorized""#;
        assert_eq!(
            challenge_resource_metadata(quoted).as_deref(),
            Some("https://x/.well-known/oauth-protected-resource/mcp")
        );
        assert_eq!(
            challenge_resource_metadata("Bearer resource_metadata=https://x/prm, foo=bar").as_deref(),
            Some("https://x/prm")
        );
        assert_eq!(challenge_resource_metadata("Bearer realm=\"x\""), None);
    }

    #[test]
    fn unknown_flow_state_is_expired_and_callback_fails_cleanly() {
        assert_eq!(pending_status("no-such-state").status, "expired");
        match finish_callback("no-such-state", "code", "", 1234) {
            CallbackOutcome::Failed { message } => assert!(message.contains("expired")),
            _ => panic!("unknown state must fail"),
        }
    }
}
