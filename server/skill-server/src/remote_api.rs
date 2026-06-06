//! The connection-manager API (`/api/remote/*`), handled LOCALLY by the desktop's
//! in-process server — never proxied. `ctx.remote` is the desktop's SSH controller;
//! it's `None` on the standalone (remote) binary, where these routes 404. The token
//! is deliberately never surfaced here (it lives only in the proxy and the ssh
//! command line).
use serde_json::{json, Value};
use tiny_http::Method;

use crate::{Reply, ServerCtx};

pub fn handle(method: &Method, path: &str, body: &str, ctx: &ServerCtx) -> Reply {
    let Some(remote) = ctx.remote.as_ref() else {
        return err(404, "Remote control is not available on this server.");
    };
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);

    match (method, path) {
        (Method::Get, "/api/remote/list") => match remote.list_hosts() {
            Ok(hosts) => ok(&hosts),
            Err(e) => err(400, &e),
        },
        (Method::Get, "/api/remote/status") => ok(&remote.status()),
        (Method::Post, "/api/remote/connect") => {
            let host = v.get("host").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            if host.is_empty() {
                return err(400, "A host is required.");
            }
            // Reject anything that isn't a plain ssh destination. Critically, a value
            // starting with `-` (or carrying odd characters) could be parsed by the
            // `ssh` client as an OPTION (e.g. `-oProxyCommand=…`) rather than a host,
            // which is local command execution. The desktop also passes `--` before
            // the host as defense-in-depth, but the API rejects it outright.
            if !valid_host(&host) {
                return err(400, "Invalid host. Use an SSH alias or user@host[:port].");
            }
            match remote.connect(&host) {
                Ok(()) => ok(&json!({ "ok": true })),
                Err(e) => err(400, &e),
            }
        }
        (Method::Post, "/api/remote/disconnect") => match remote.disconnect() {
            Ok(()) => ok(&json!({ "ok": true })),
            Err(e) => err(400, &e),
        },
        _ => err(404, "Not found"),
    }
}

/// A plain ssh destination: an alias or `user@host[:port]`. No leading `-` (option
/// injection) and only characters that appear in real hostnames/users/aliases.
fn valid_host(h: &str) -> bool {
    !h.starts_with('-')
        && h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@' | ':'))
}

fn ok<T: serde::Serialize>(v: &T) -> Reply {
    Reply {
        status: 200,
        body: serde_json::to_vec(v).unwrap_or_default(),
        content_type: "application/json".into(),
        extra: vec![],
    }
}

fn err(status: u16, msg: &str) -> Reply {
    Reply {
        status,
        body: serde_json::to_vec(&json!({ "error": msg })).unwrap_or_default(),
        content_type: "application/json".into(),
        extra: vec![],
    }
}
