//! The MCP gateway: `GET|POST|DELETE /gw/<id>/mcp` reverse-proxies to the
//! connection's MCP URL with the stored OAuth token injected upstream, so agent
//! CLIs hold only an unguessable loopback URL — never a token. Mounted BEFORE
//! the bearer guard in `worker_loop`: local CLIs can't send our bearer; the
//! from-this-machine check (which also rejects tailscale-fronted traffic) + the
//! capability id are the gate. Each request runs on its own thread — MCP
//! responses can be lifetime-long SSE streams.
use std::io::{Read, Write};
use std::time::Duration;

use serde_json::{json, Value};
use tiny_http::{Method, Request};

use skill_core::connections::{self, FreshToken, TokenError};

use crate::{from_this_machine, reply_status, send_reply, write_chunk, Reply};

/// Connect timeout upstream; deliberately NO read timeout — an idle-but-alive
/// SSE stream blocks on `read` indefinitely (same rule as `proxy_sse`).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The only request headers forwarded upstream. Everything else — an inbound
/// `Authorization` above all — is dropped; the fresh Bearer is injected here.
const FORWARD: [&str; 5] =
    ["Content-Type", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-Id"];

/// `/gw/<id>/mcp` → the connection id.
fn gw_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/gw/")?.strip_suffix("/mcp")?;
    (!id.is_empty() && !id.contains('/')).then_some(id)
}

pub(crate) fn handle(mut request: Request, method: &Method, url: &str) {
    // This machine's own webview/browser only. `tailscale serve` preserves the
    // ts.net Host and adds X-Forwarded-*, and the Host is peer-controlled — so a
    // bare loopback-Host check is spoofable. Reuse the app-wide predicate, which
    // also rejects forwarded traffic, keeping /gw off the tailnet.
    if !from_this_machine(&request) {
        return reply_status(request, 403, "The MCP gateway answers loopback callers only.");
    }
    let path = url.split('?').next().unwrap_or(url);
    let Some(id) = gw_id(path).map(str::to_string) else {
        return reply_status(request, 404, "Unknown gateway path.");
    };
    if !matches!(method, Method::Get | Method::Post | Method::Delete) {
        return reply_status(request, 405, "Use GET, POST, or DELETE.");
    }
    // Bound concurrent gateway requests like the other long-lived streams: an
    // SSE relay whose client vanished can otherwise pin a thread + upstream
    // socket until the process exits. Held until `relay` returns.
    let _slot = match crate::acquire_stream_slot() {
        Some(s) => s,
        None => return reply_status(request, 503, "Too many active streams."),
    };

    let fwd: Vec<(String, String)> = request
        .headers()
        .iter()
        .filter(|h| FORWARD.iter().any(|&f| h.field.equiv(f)))
        .map(|h| (h.field.as_str().as_str().to_string(), h.value.as_str().to_string()))
        .collect();
    // JSON-RPC messages are small; buffering makes the 401 retry safe.
    let mut body = Vec::new();
    let _ = request.as_reader().read_to_end(&mut body);

    let fresh = match connections::ensure_fresh_token(&id, None) {
        Ok(f) => f,
        Err(e) => return token_failure(request, method, &body, e),
    };
    let resp = match send_upstream(method, &fresh, &fwd, &body) {
        Ok(r) => r,
        Err(t) => return reply_status(request, 502, &t),
    };
    // One retry on an upstream 401: force a refresh keyed to the token just
    // rejected (a parallel request may already have refreshed it).
    let resp = if resp.status() == 401 {
        match connections::ensure_fresh_token(&id, Some(&fresh.access_token)) {
            Ok(f2) => match send_upstream(method, &f2, &fwd, &body) {
                Ok(r) => r,
                Err(t) => return reply_status(request, 502, &t),
            },
            Err(e) => return token_failure(request, method, &body, e),
        }
    } else {
        resp
    };
    relay(request, resp);
}

fn send_upstream(
    method: &Method,
    fresh: &FreshToken,
    fwd: &[(String, String)],
    body: &[u8],
) -> Result<ureq::Response, String> {
    let agent = ureq::AgentBuilder::new().timeout_connect(CONNECT_TIMEOUT).build();
    let mut req = agent.request(method.as_str(), &fresh.mcp_url);
    for (k, v) in fwd {
        req = req.set(k, v);
    }
    req = req.set("Authorization", &format!("Bearer {}", fresh.access_token));
    match if body.is_empty() { req.call() } else { req.send_bytes(body) } {
        Ok(r) => Ok(r),
        // Non-2xx is a real upstream answer (incl. the 401 the caller retries on).
        Err(ureq::Error::Status(_, r)) => Ok(r),
        Err(ureq::Error::Transport(t)) => Err(format!("MCP upstream unreachable: {t}")),
    }
}

/// Token lookup/refresh failed. POSTs get a 200 JSON-RPC error the agent can
/// relay verbatim to the user; GET (SSE) and DELETE get plain statuses.
fn token_failure(request: Request, method: &Method, body: &[u8], err: TokenError) {
    match err {
        TokenError::Unknown => reply_status(request, 404, "Unknown connection."),
        TokenError::Transient(m) => reply_status(request, 502, &m),
        TokenError::NeedsReauth { label } => {
            if *method != Method::Post {
                return reply_status(request, 401, "Connection needs re-authorizing.");
            }
            let id = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|v| v.get("id").cloned())
                .unwrap_or(Value::Null);
            let message = format!(
                "{label} connection needs re-authorizing — open VibeStudio → Secrets and click Reconnect."
            );
            send_reply(
                request,
                Reply {
                    status: 200,
                    body: serde_json::to_vec(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32001, "message": message },
                    }))
                    .unwrap_or_default(),
                    content_type: "application/json".into(),
                    extra: vec![],
                },
            );
        }
    }
}

/// Mirror status + content-type + mcp-session-id and pump the body through as
/// flushed chunks (`write_chunk` flushes per read), so upstream SSE passes
/// through unbuffered.
fn relay(request: Request, resp: ureq::Response) {
    let status = resp.status();
    let status_text = resp.status_text().to_string();
    let content_type = resp.header("content-type").unwrap_or("application/octet-stream").to_string();
    let session = resp.header("mcp-session-id").map(str::to_string);
    let mut head =
        format!("HTTP/1.1 {status} {status_text}\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\n");
    if let Some(sess) = &session {
        head.push_str(&format!("Mcp-Session-Id: {sess}\r\n"));
    }
    // Bodiless statuses (RFC 9112) end at the head — chunked TE is invalid there.
    let bodiless = status == 204 || status == 304;
    if !bodiless {
        head.push_str("Transfer-Encoding: chunked\r\nX-Accel-Buffering: no\r\n");
    }
    head.push_str("\r\n");
    let mut upstream = resp.into_reader();
    let mut w = request.into_writer();
    if w.write_all(head.as_bytes()).is_err() || w.flush().is_err() || bodiless {
        return;
    }
    let mut buf = [0u8; 8192];
    loop {
        match upstream.read(&mut buf) {
            Ok(0) => break, // upstream closed
            Ok(n) => {
                if write_chunk(w.as_mut(), &buf[..n]).is_err() {
                    break; // client gone
                }
            }
            Err(_) => break,
        }
    }
    let _ = write_chunk(w.as_mut(), b""); // terminating 0-length chunk
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_paths_parse_strictly() {
        assert_eq!(gw_id("/gw/abc123/mcp"), Some("abc123"));
        assert_eq!(gw_id("/gw//mcp"), None);
        assert_eq!(gw_id("/gw/a/b/mcp"), None);
        assert_eq!(gw_id("/gw/abc123/other"), None);
        assert_eq!(gw_id("/api/gw/abc123/mcp"), None);
    }
}
