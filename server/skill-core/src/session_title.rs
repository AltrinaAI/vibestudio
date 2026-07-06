//! A short human title for a live terminal, read from the agent's OWN session
//! record — far more meaningful than the raw cwd. Hung off `AgentDef.session_title`
//! (the common agent interface) so each agent contributes what it can and the rest
//! degrade to `None`. Pure Rust (no SQLite): Claude, Codex, Gemini, Cursor are
//! covered; opencode's store is SQLite-only and is a follow-up.
//!
//! Correlation: a terminal maps to the session whose file was CREATED closest to
//! the terminal's spawn time (`created`) — this disambiguates several sessions in
//! the same cwd (which plain newest-by-activity cannot). Falls back to newest
//! activity when birth time is unavailable.

use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

const MAX_LEN: usize = 72;

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Parsed titles keyed by (file, mtime). `terminal/list` is polled every few
/// seconds but a title only moves when the agent writes a new turn — so a file is
/// re-read only when its mtime advances, keeping polling cheap even on multi-MB
/// transcripts.
type TitleCache = HashMap<PathBuf, (u64, Option<String>)>;
static CACHE: LazyLock<Mutex<TitleCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn cached(file: &Path, parse: impl FnOnce(&Path) -> Option<String>) -> Option<String> {
    let mt = file_time(file, false).unwrap_or(0);
    if let Ok(c) = CACHE.lock() {
        if let Some((cmt, title)) = c.get(file) {
            if *cmt == mt {
                return title.clone();
            }
        }
    }
    let title = parse(file);
    if let Ok(mut c) = CACHE.lock() {
        c.insert(file.to_path_buf(), (mt, title.clone()));
    }
    title
}

/// mtime (false) or btime/creation (true) as unix seconds.
fn file_time(p: &Path, creation: bool) -> Option<u64> {
    let m = fs::metadata(p).ok()?;
    let t = if creation { m.created().ok()? } else { m.modified().ok()? };
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
}

/// The session file for a live terminal: the one being actively written (newest
/// activity) — a long-lived terminal outlives several agent sessions, so its
/// CURRENT session is the most recent, not the one born when the terminal started.
///
/// LIMITATION: several terminals in the SAME cwd can't be told apart this way —
/// they resolve to the newest shared session. Robust per-terminal correlation
/// needs a launch-time session id (e.g. `claude --session-id <uuid>`) recorded on
/// the terminal; that's a follow-up. `created` is kept for that future use.
fn pick_for_terminal(files: Vec<PathBuf>, _created: i64) -> Option<PathBuf> {
    files
        .into_iter()
        .max_by_key(|p| file_time(p, false).unwrap_or(0))
}

fn tidy(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(s: &str) -> String {
    if s.chars().count() <= MAX_LEN {
        return s.to_string();
    }
    let cut: String = s.chars().take(MAX_LEN).collect();
    // back off to the last space so we don't slice a word
    let trimmed = cut.rsplit_once(' ').map(|(a, _)| a).unwrap_or(&cut);
    format!("{}…", trimmed.trim_end())
}

/// Known system/slash-command wrappers a first user message may carry. A message
/// that is ONLY these (or starts with a caveat) is not a real prompt → skip it.
const SKIP_PREFIXES: &[&str] = &[
    "<local-command-caveat>",
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-stdout>",
    "<task-notification>",
    "<environment_context>",
    "Caveat:",
    "[Request interrupted",
    "# AGENTS.md",
    "# Context from my IDE setup:",
];

/// Remove `<tag …>…</tag>` blocks (system-reminder, ide_*, etc.) from a prompt so
/// the human text is left. Non-regex: repeatedly splice out the first `<…>…</…>`
/// whose open tag name is in `tags`.
fn strip_tag_blocks(text: &str, tags: &[&str]) -> String {
    let mut out = text.to_string();
    for tag in tags {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        while let Some(a) = out.find(&open) {
            let Some(rel) = out[a..].find(&close) else { break };
            let b = a + rel + close.len();
            out.replace_range(a..b, " ");
        }
    }
    out
}

/// Clean a raw first-user-message into a title, or None if it's a system artifact.
fn clean_prompt(raw: &str) -> Option<String> {
    let stripped = strip_tag_blocks(raw, &["system-reminder", "ide_selection", "ide_opened"]);
    let t = tidy(&stripped);
    if t.is_empty() {
        return None;
    }
    if SKIP_PREFIXES.iter().any(|p| t.starts_with(p)) {
        return None;
    }
    Some(t)
}

/// Extract the human text of a Claude/OpenClaw-style `user` record's message.
/// Returns None when the content is entirely tool results (not a real turn).
fn claude_user_text(rec: &Value) -> Option<String> {
    let content = rec.get("message")?.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    let arr = content.as_array()?;
    let mut parts = Vec::new();
    let mut saw_non_tool = false;
    for b in arr {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                saw_non_tool = true;
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    parts.push(t);
                }
            }
            Some("tool_result") => {}
            _ => saw_non_tool = true,
        }
    }
    if !saw_non_tool {
        return None; // all tool_result → skip
    }
    Some(parts.join(" "))
}

fn jsonl_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "jsonl"))
        .collect()
}

fn read_lines(file: &Path) -> Option<impl Iterator<Item = String>> {
    let f = fs::File::open(file).ok()?;
    Some(BufReader::new(f).lines().map_while(Result::ok))
}

// ─── Claude Code (and any Claude fork) ───

/// cwd → project dir name: every '/' and '.' becomes '-'.
fn claude_encode(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

pub fn claude_title(cwd: &Path, created: i64) -> Option<String> {
    claude_from_dir(home()?.join(".claude/projects"), cwd, created)
}

fn claude_from_dir(projects: PathBuf, cwd: &Path, created: i64) -> Option<String> {
    let dir = projects.join(claude_encode(cwd));
    let file = pick_for_terminal(jsonl_files(&dir), created)?;
    cached(&file, parse_claude)
}

fn parse_claude(file: &Path) -> Option<String> {
    let mut last_title: Option<String> = None;
    let mut first_user: Option<String> = None;
    for line in read_lines(file)? {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            // Claude regenerates the title as the convo evolves → keep the last one.
            Some("ai-title") => {
                if let Some(t) = v.get("aiTitle").and_then(|x| x.as_str()) {
                    if !t.trim().is_empty() {
                        last_title = Some(t.trim().to_string());
                    }
                }
            }
            Some("user") if first_user.is_none() => {
                if v.get("isMeta").and_then(|x| x.as_bool()) == Some(true) {
                    continue;
                }
                if let Some(txt) = claude_user_text(&v) {
                    first_user = clean_prompt(&txt);
                }
            }
            _ => {}
        }
    }
    let raw = last_title.or(first_user)?;
    Some(truncate(&tidy(&raw)))
}

// ─── Codex ───
// Rollout transcripts are date-organized (not by cwd), so scan the most recently
// active ones, keep those whose session_meta.cwd matches, and title from the first
// human `user_message` event. (The state_*.sqlite store holds nicer titles but is
// SQLite — deferred.)

pub fn codex_title(cwd: &Path, created: i64) -> Option<String> {
    let base = home()?.join(".codex/sessions");
    let mut rollouts: Vec<PathBuf> = walkdir::WalkDir::new(&base)
        .into_iter()
        .filter_map(|e| e.ok())
        .map(|e| e.into_path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
        })
        .collect();
    // Bound the scan to the most recently active rollouts.
    rollouts.sort_by_key(|p| std::cmp::Reverse(file_time(p, false).unwrap_or(0)));
    rollouts.truncate(48);
    let want = cwd.to_string_lossy();
    let mine: Vec<PathBuf> = rollouts
        .into_iter()
        .filter(|p| codex_meta_cwd(p).as_deref() == Some(&want))
        .collect();
    let file = pick_for_terminal(mine, created)?;
    cached(&file, parse_codex)
}

fn parse_codex(file: &Path) -> Option<String> {
    for line in read_lines(file)? {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // The `user_message` event carries the clean typed human text.
        if v.get("type").and_then(|t| t.as_str()) == Some("event_msg") {
            let pl = v.get("payload");
            if pl.and_then(|p| p.get("type")).and_then(|t| t.as_str()) == Some("user_message") {
                if let Some(m) = pl.and_then(|p| p.get("message")).and_then(|m| m.as_str()) {
                    // IDE-launched Codex wraps the real ask under this marker,
                    // after an "## Open tabs:" context dump.
                    let ask = m
                        .rsplit_once("## My request for Codex:")
                        .map(|(_, a)| a)
                        .unwrap_or(m);
                    if let Some(c) = clean_prompt(ask) {
                        return Some(truncate(&c));
                    }
                }
            }
        }
    }
    None
}

fn codex_meta_cwd(file: &Path) -> Option<String> {
    // session_meta is the first line.
    let first = read_lines(file)?.next()?;
    let v: Value = serde_json::from_str(&first).ok()?;
    v.get("payload")?
        .get("cwd")?
        .as_str()
        .map(|s| s.to_string())
}

// ─── Gemini CLI ───
// Sessions live under ~/.gemini/tmp/<slug>/chats/; the slug maps to a cwd via a
// sibling `.project_root` file. Title = the LLM `summary` if present, else the
// first user message (a live session usually has no summary yet).

pub fn gemini_title(cwd: &Path, created: i64) -> Option<String> {
    let tmp = home()?.join(".gemini/tmp");
    let want = cwd.to_string_lossy();
    let proj = fs::read_dir(&tmp).ok()?.filter_map(|e| e.ok()).find(|e| {
        fs::read_to_string(e.path().join(".project_root"))
            .map(|c| c.trim() == want)
            .unwrap_or(false)
    })?;
    let chats = proj.path().join("chats");
    let file = pick_for_terminal(jsonl_files(&chats), created)?;
    cached(&file, parse_gemini)
}

fn parse_gemini(file: &Path) -> Option<String> {
    let mut summary: Option<String> = None;
    let mut first_user: Option<String> = None;
    for line in read_lines(file)? {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(s) = v.get("summary").and_then(|s| s.as_str()) {
            if !s.trim().is_empty() {
                summary = Some(s.trim().to_string());
            }
        }
        if let Some(set) = v.get("$set").and_then(|s| s.get("summary")).and_then(|s| s.as_str()) {
            if !set.trim().is_empty() {
                summary = Some(set.trim().to_string());
            }
        }
        if first_user.is_none() && v.get("type").and_then(|t| t.as_str()) == Some("user") {
            first_user = gemini_user_text(&v).and_then(|t| clean_prompt(&t));
        }
    }
    let raw = summary.or(first_user)?;
    Some(truncate(&tidy(&raw)))
}

fn gemini_user_text(rec: &Value) -> Option<String> {
    let content = rec.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    let parts: Vec<&str> = content
        .as_array()?
        .iter()
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .collect();
    Some(parts.join(" "))
}

// ─── Cursor (cursor-agent) ───
// ~/.cursor/projects/<enc>/agent-transcripts/<uuid>/<uuid>.jsonl. No stored title;
// the first `<user_query>` is the prompt.

/// cwd → project dir name: runs of non-alphanumerics collapse to a single '-',
/// leading separators dropped.
fn cursor_encode(cwd: &Path) -> String {
    let s = cwd.to_string_lossy();
    let mut out = String::new();
    let mut dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

pub fn cursor_title(cwd: &Path, created: i64) -> Option<String> {
    let base = home()?
        .join(".cursor/projects")
        .join(cursor_encode(cwd))
        .join("agent-transcripts");
    // each session is its own subdir holding <uuid>.jsonl
    let files: Vec<PathBuf> = fs::read_dir(&base)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| jsonl_files(&e.path()).into_iter().next())
        .collect();
    let file = pick_for_terminal(files, created)?;
    cached(&file, parse_cursor)
}

fn parse_cursor(file: &Path) -> Option<String> {
    for line in read_lines(file)? {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let text: String = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        // The real prompt is inside <user_query>…</user_query>.
        let inner = between(&text, "<user_query>", "</user_query>").unwrap_or(&text);
        let cleaned = tidy(&strip_tag_blocks(inner, &["timestamp", "image_files"]));
        // Skip image-only / bare @mention lead turns.
        if cleaned.is_empty() || cleaned.starts_with('@') || cleaned == "[Image]" {
            continue;
        }
        return Some(truncate(&cleaned));
    }
    None
}

fn between<'a>(s: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let a = s.find(open)? + open.len();
    let b = s[a..].find(close)? + a;
    Some(s[a..b].trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_encoding() {
        assert_eq!(
            claude_encode(Path::new("/home/harvey/altrina/skillviewer")),
            "-home-harvey-altrina-skillviewer"
        );
        assert_eq!(
            claude_encode(Path::new("/home/harvey/.agents/skills")),
            "-home-harvey--agents-skills"
        );
    }

    #[test]
    fn cursor_encoding() {
        assert_eq!(
            cursor_encode(Path::new("/home/harvey/altrina/skillviewer")),
            "home-harvey-altrina-skillviewer"
        );
    }

    #[test]
    fn cleans_and_truncates() {
        assert_eq!(clean_prompt("<local-command-caveat>Caveat: …"), None);
        assert_eq!(clean_prompt("   "), None);
        assert_eq!(
            clean_prompt("Fix the <system-reminder>noise</system-reminder> renderer"),
            Some("Fix the renderer".to_string())
        );
        let long = "word ".repeat(40);
        assert!(truncate(&long).ends_with('…'));
        assert!(truncate("short title").eq("short title"));
    }

    #[test]
    fn extracts_user_query() {
        assert_eq!(
            between("a<user_query>\n hi there \n</user_query>b", "<user_query>", "</user_query>"),
            Some("hi there")
        );
    }
}
