//! Terminal lifecycle events over SSE (`GET /api/events`) — the push channel the
//! turn-finish notifier rides. tmux stays the source of truth (bells land in
//! `@ass_bell_at` via a tmux hook; this process never observes them directly),
//! so a watcher thread diffs `skill_term::list_sessions()` once a second and
//! fans edge events out to every subscriber. Events are HINTS, not state: the
//! client re-fetches `/api/terminal/list` on (re)connect and on every event, so
//! there is no replay buffer and a missed frame costs nothing.
//!
//! The watcher also feeds `push::notify_bells` on every bell edge — Web Push
//! must fire precisely when NO browser is connected, so it runs from server
//! boot ([`start`]) and never pauses.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, MutexGuard, Once, OnceLock};
use std::time::Duration;

use serde_json::json;
use skill_term::SessionInfo;

/// Watcher cadence: one `tmux list-sessions` per tick, which also bounds the
/// bell → SSE-push latency.
const TICK: Duration = Duration::from_secs(1);

fn subscribers() -> MutexGuard<'static, Vec<Sender<String>>> {
    static SUBS: OnceLock<Mutex<Vec<Sender<String>>>> = OnceLock::new();
    SUBS.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}

/// Start the watcher (idempotent). Called at server boot so bell edges reach
/// Web Push subscribers with zero browsers connected.
pub(crate) fn start() {
    static START: Once = Once::new();
    START.call_once(|| {
        std::thread::spawn(watcher_loop);
    });
}

/// Register a stream, and push a comment frame through the registry so senders
/// whose stream died between events get pruned even on a quiet server.
pub(crate) fn subscribe() -> Receiver<String> {
    start();
    let (tx, rx) = mpsc::channel();
    subscribers().push(tx);
    emit(": sub\n\n".to_string());
    rx
}

/// Fan a pre-framed SSE string out to every subscriber, pruning dead senders.
fn emit(frame: String) {
    subscribers().retain(|tx| tx.send(frame.clone()).is_ok());
}

/// One SSE frame: a named event plus one JSON data line, so the client demuxes
/// with `EventSource.addEventListener(<event>, …)`.
fn frame(event: &str, data: &serde_json::Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

fn payload(s: &SessionInfo) -> serde_json::Value {
    json!({ "id": s.id, "label": s.label, "agent": s.agent, "cwd": s.cwd, "at": s.bell_at })
}

fn bell_secs(s: &SessionInfo) -> u64 {
    s.bell_at.trim().parse().unwrap_or(0)
}

/// Sessions whose bell advanced between two snapshots — present in BOTH: one
/// that arrives already-belled is just `opened`, and its stale bell must not
/// re-announce (or re-push) on a server restart.
pub(crate) fn bell_edges<'a>(
    prev: &HashMap<String, SessionInfo>,
    now: &'a [SessionInfo],
) -> Vec<&'a SessionInfo> {
    now.iter()
        .filter(|s| prev.get(&s.id).is_some_and(|p| bell_secs(s) > bell_secs(p)))
        .collect()
}

/// Frames for what changed between two snapshots.
pub(crate) fn diff(prev: &HashMap<String, SessionInfo>, now: &[SessionInfo]) -> Vec<String> {
    let mut frames = Vec::new();
    for s in now {
        if !prev.contains_key(&s.id) {
            frames.push(frame("opened", &payload(s)));
        }
    }
    for s in bell_edges(prev, now) {
        frames.push(frame("bell", &payload(s)));
    }
    for (id, p) in prev {
        if !now.iter().any(|s| &s.id == id) {
            frames.push(frame("closed", &payload(p)));
        }
    }
    frames
}

/// Seed silently, then emit edges each tick — continuously from boot: pausing
/// while unsubscribed (as this once did) would blind Web Push exactly when it
/// matters, and a paused-then-resumed snapshot would burst-replay stale edges.
fn watcher_loop() {
    let mut prev: Option<HashMap<String, SessionInfo>> = None;
    let mut tick: u32 = 0;
    loop {
        // A dead stream's Sender lingers until a send fails, which a quiet server
        // may never do — periodically push a comment frame purely to prune.
        tick = tick.wrapping_add(1);
        if tick.is_multiple_of(30) {
            emit(": prune\n\n".to_string());
        }
        let now = skill_term::list_sessions().unwrap_or_default();
        if let Some(p) = &prev {
            for f in diff(p, &now) {
                emit(f);
            }
            let bells = bell_edges(p, &now)
                .into_iter()
                .map(|s| crate::push::Bell { id: s.id.clone(), label: s.label.clone() })
                .collect();
            crate::push::notify_bells(bells);
        }
        prev = Some(now.into_iter().map(|s| (s.id.clone(), s)).collect());
        std::thread::sleep(TICK);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sess(id: &str, bell: &str) -> SessionInfo {
        SessionInfo {
            id: id.into(),
            label: format!("Claude Code · {id}"),
            agent: "claude".into(),
            cwd: "/tmp".into(),
            created: "100".into(),
            activity: "200".into(),
            bell_at: bell.into(),
        }
    }

    fn snap(list: &[SessionInfo]) -> HashMap<String, SessionInfo> {
        list.iter().map(|s| (s.id.clone(), s.clone())).collect()
    }

    #[test]
    fn new_session_is_opened_never_bell() {
        // Even with a nonzero bell: pre-existing bells are state, not an edge.
        let frames = diff(&HashMap::new(), &[sess("ass-1", "500")]);
        assert_eq!(frames.len(), 1);
        assert!(frames[0].starts_with("event: opened\n"), "{frames:?}");
    }

    #[test]
    fn bell_fires_only_on_increase() {
        let prev = snap(&[sess("ass-1", "500"), sess("ass-2", "0"), sess("ass-3", "")]);
        let now = [sess("ass-1", "500"), sess("ass-2", "600"), sess("ass-3", "")];
        let frames = diff(&prev, &now);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert!(frames[0].starts_with("event: bell\n"));
        assert!(frames[0].contains("\"id\":\"ass-2\""));
        assert!(frames[0].contains("\"at\":\"600\""));
    }

    #[test]
    fn vanished_session_is_closed() {
        let prev = snap(&[sess("ass-1", "0"), sess("ass-2", "0")]);
        let frames = diff(&prev, &[sess("ass-1", "0")]);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert!(frames[0].starts_with("event: closed\n"));
        assert!(frames[0].contains("\"id\":\"ass-2\""));
    }

    #[test]
    fn unchanged_snapshot_is_silent() {
        let list = [sess("ass-1", "500"), sess("ass-2", "0")];
        assert!(diff(&snap(&list), &list).is_empty());
    }

    #[test]
    fn frames_are_well_formed_sse() {
        let frames = diff(&HashMap::new(), &[sess("ass-1", "0")]);
        assert!(frames[0].ends_with("\n\n"));
        let data_line = frames[0].lines().nth(1).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(data_line.strip_prefix("data: ").unwrap()).unwrap();
        assert_eq!(v["label"], "Claude Code · ass-1");
        assert_eq!(v["agent"], "claude");
    }
}
