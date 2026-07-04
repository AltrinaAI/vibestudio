//! Reverse proxy for the Remote-SSH switchboard. While the desktop is connected to
//! a remote, the local in-process server forwards `/api/*` to the remote
//! `skill-server` over the `ssh -L` tunnel (`http://127.0.0.1:<Lport>`), injecting
//! the bearer token on the upstream side. The browser only ever talks to the local
//! origin, so the token never reaches it and the SSE `EventSource` (which has no
//! header API) works unchanged.
use std::io::{Read, Write};
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::json;
use tiny_http::{Method, Request};

use crate::{acquire_stream_slot, reply_status, send_reply, write_chunk, RemoteTarget, Reply};

/// Connect timeout for upstream calls. The forward is loopback, so this only has to
/// cover the tunnel being momentarily wedged, not real network latency.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Read timeout for buffered (non-streaming) calls. Generous so a slow remote op
/// (e.g. on-device commit-message generation) isn't cut off, but bounded so a hung
/// remote can't pin a local worker thread forever.
const READ_TIMEOUT: Duration = Duration::from_secs(300);

/// One process-wide pooled agent for all buffered proxy calls. `ureq::Agent` is an
/// `Arc` internally (cheap to clone) and keeps a per-host keep-alive connection
/// pool — so reusing it lets serialized terminal input (one POST per keystroke
/// batch, now on the critical path) reuse the SSH-tunnel connection instead of
/// opening a fresh TCP + SSH channel each time, roughly halving per-batch latency.
/// The pool keys on host:port, so a reconnected tunnel (new local port) never
/// reuses a stale connection. NOT shared with `proxy_sse`, which must run with no
/// read timeout for its lifetime-long stream.
fn buffered_agent() -> ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            ureq::AgentBuilder::new()
                .timeout_connect(CONNECT_TIMEOUT)
                .timeout_read(READ_TIMEOUT)
                .build()
        })
        .clone()
}

/// Request headers we must NOT copy upstream: hop-by-hop, the length (the body is
/// re-sent), our own injected auth, and `Accept-Encoding` (let ureq negotiate gzip).
fn skip_req_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host" | "connection" | "content-length" | "authorization" | "accept-encoding"
    )
}

/// Response headers we must NOT copy back: ureq transparently gunzips, so the
/// upstream length/encoding no longer match the bytes we relay; hop-by-hop headers
/// don't apply downstream; and `send_reply` re-adds CORS + `Cache-Control` itself.
fn skip_resp_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "content-length"
            | "content-encoding"
            | "transfer-encoding"
            | "connection"
            | "cache-control"
            | "access-control-allow-origin"
            | "access-control-allow-methods"
            | "access-control-allow-headers"
    )
}

fn upstream_url(target: &RemoteTarget, url: &str) -> String {
    format!("{}{}", target.base_url.trim_end_matches('/'), url)
}

fn bad_gateway(msg: &str) -> Reply {
    Reply {
        status: 502,
        body: serde_json::to_vec(&json!({ "error": msg })).unwrap_or_default(),
        content_type: "application/json".into(),
        extra: vec![],
    }
}

/// Forward a buffered request (everything except the SSE attach) and relay the
/// response. Occupies the calling worker for the round-trip.
pub fn proxy_buffered(mut request: Request, method: &Method, url: &str, target: &RemoteTarget) {
    // Snapshot the headers to forward, then drain the body — both borrow `request`,
    // so collect into owned values before the upstream call moves on.
    let fwd: Vec<(String, String)> = request
        .headers()
        .iter()
        .filter(|h| !skip_req_header(h.field.as_str().as_str()))
        .map(|h| (h.field.as_str().as_str().to_string(), h.value.as_str().to_string()))
        .collect();
    let mut body: Vec<u8> = Vec::new();
    let _ = request.as_reader().read_to_end(&mut body);

    let agent = buffered_agent();
    let mut req = agent.request(method.as_str(), &upstream_url(target, url));
    for (k, v) in &fwd {
        req = req.set(k, v);
    }
    req = req.set("Authorization", &format!("Bearer {}", target.token));

    // ureq returns non-2xx as `Err(Status(code, resp))` — relay it faithfully rather
    // than collapsing every remote 4xx/5xx into a proxy 500.
    let resp = match if body.is_empty() { req.call() } else { req.send_bytes(&body) } {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(ureq::Error::Transport(t)) => {
            return send_reply(request, bad_gateway(&format!("remote unreachable: {t}")));
        }
    };

    let status = resp.status();
    let mut content_type = "application/octet-stream".to_string();
    let mut extra: Vec<(String, String)> = Vec::new();
    for name in resp.headers_names() {
        if skip_resp_header(&name) {
            continue;
        }
        if let Some(val) = resp.header(&name) {
            if name.eq_ignore_ascii_case("content-type") {
                content_type = val.to_string();
            } else {
                extra.push((name, val.to_string()));
            }
        }
    }
    let mut data = Vec::new();
    let _ = resp.into_reader().read_to_end(&mut data);
    send_reply(request, Reply { status, body: data, content_type, extra });
}

/// Forward the SSE terminal stream. Mirrors `stream_terminal`: take over the local
/// socket and hand-roll chunked `text/event-stream`, pumping the remote's already
/// SSE-framed bytes straight through. Runs on its own thread (it blocks for the
/// session's lifetime), so it must NOT use a read timeout — an idle-but-alive stream
/// blocks on `read` indefinitely, which is correct (the remote sends 15s keepalives).
pub fn proxy_sse(request: Request, url: &str, target: &RemoteTarget) {
    // Share the local stream cap so proxied attaches can't spawn unbounded threads
    // either (each blocks for the stream's lifetime). Released on every exit (Drop).
    let _slot = match acquire_stream_slot() {
        Some(s) => s,
        None => return reply_status(request, 503, "Too many terminal streams are open."),
    };
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .build();
    let resp = match agent
        .request("GET", &upstream_url(target, url))
        .set("Authorization", &format!("Bearer {}", target.token))
        .call()
    {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => return reply_status(request, code, "remote stream error"),
        Err(ureq::Error::Transport(t)) => {
            // Keep the transport detail (host/port/cause) in the log — it's the prime
            // clue for a flaky tunnel; the client only sees the generic message.
            log::error!("proxy(sse) {url}: remote unreachable: {t}");
            return reply_status(request, 502, "remote unreachable");
        }
    };
    let mut up = resp.into_reader();

    let head = crate::sse_head(&request);
    let mut w = request.into_writer();
    if w.write_all(head.as_bytes()).is_err() || w.flush().is_err() {
        return; // client gone before we started
    }
    let mut buf = [0u8; 8192];
    loop {
        match up.read(&mut buf) {
            Ok(0) => break,                // upstream closed
            Ok(n) => {
                if write_chunk(w.as_mut(), &buf[..n]).is_err() {
                    break; // local client gone
                }
            }
            Err(_) => break,
        }
    }
    let _ = write_chunk(w.as_mut(), b""); // terminating 0-length chunk
}
