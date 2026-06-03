//! Generate a Conventional-Commits message from a skill's uncommitted diff,
//! using the on-device `engine`. Transport-agnostic: both the Tauri command and
//! the headless server route call `generate`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::engine::{self, ChatMessage};
use crate::gitops;

/// Diff bytes we put into the prompt. The worktree diff is capped at 2 MB
/// (gitops) — far more than a small model's context — so we further trim here.
/// Code tokenizes densely (~2–3 chars/token); ~16 KB is roughly 6–7K tokens,
/// which still leaves room for the system prompt + a short reply within an 8K
/// context. We feed the real diff up to this cutoff (truncated, never reduced to
/// a bare filename) plus a small per-file summary.
const MAX_PROMPT_DIFF_BYTES: usize = 16_000;

/// Draft a commit message for the skill at `root`. Returns a ready-to-edit
/// message (the user still reviews it before committing).
///
/// Cached per `root` by a hash of the working-tree diff: a draft prepared eagerly
/// in the background (once edits settle) is reused instantly when the Save dialog
/// opens, and re-running on an unchanged diff is free. The model is deterministic
/// for a given diff (fixed seed), so a cached message equals a regenerated one.
pub fn generate(root: &str) -> Result<String, String> {
    let diff = gitops::worktree_diff_text(root)?;
    if diff.trim().is_empty() {
        return Err("No changes to describe — make some edits first.".into());
    }
    let hash = diff_hash(&diff);
    if let Some(msg) = cached_for(root, hash) {
        return Ok(msg); // diff is byte-for-byte unchanged → reuse, no model run
    }
    // Minimal prompt: analyse first, then commit. Structured output forces the
    // model to reason in an `analysis` field BEFORE the `commit_message` (the
    // schema's field order = generation order), which makes it actually read the
    // diff instead of anchoring on the top — a big quality win for free.
    //
    // These are version notes for a skill author, NOT code commits: a plain
    // one-line description of what changed, with no `feat:`/`fix:`/type prefix.
    let prompt = format!(
        "Analyze the following git diff in no more than 100 words, then write a commit message. \
The message must be one short, plain-English sentence describing what changed — with no \
\"feat:\"/\"fix:\"/type prefix and no filename prefix, just the description.\n\nDiff:\n{}",
        truncate_on_boundary(&diff, MAX_PROMPT_DIFF_BYTES)
    );
    let messages = vec![ChatMessage::new("user", prompt)];

    let raw = engine::chat(&messages, 400, 0.2, Some(commit_schema()))?;
    let msg = post_process(&extract_commit_message(&raw));
    debug_log(root, &messages, &raw, &msg);
    if msg.is_empty() {
        return Err("The AI didn't produce a usable message — try again.".into());
    }
    store_cached(root, hash, &msg);
    Ok(msg)
}

/// Return the cached draft for `root` IF the working-tree diff is unchanged since
/// it was generated — instant, and never runs the model or downloads anything (it
/// only computes the cheap diff + a hash). `Ok(None)` means nothing is ready for
/// the current diff, so the caller keeps its default. Used to pre-fill the Save
/// dialog the moment it opens, so the eagerly-drafted message shows with no wait.
pub fn peek(root: &str) -> Result<Option<String>, String> {
    let diff = gitops::worktree_diff_text(root)?;
    if diff.trim().is_empty() {
        return Ok(None);
    }
    Ok(cached_for(root, diff_hash(&diff)))
}

// ─────────────────────────────── draft cache ───────────────────────────────

/// The last generated message for a skill, tagged with the diff it describes.
struct Cached {
    diff_hash: u64,
    message: String,
}

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn diff_hash(diff: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    diff.hash(&mut h);
    h.finish()
}

/// The cached message for `root` only when it was drafted from this exact diff.
fn cached_for(root: &str, hash: u64) -> Option<String> {
    let guard = cache().lock().ok()?;
    guard.get(root).filter(|c| c.diff_hash == hash).map(|c| c.message.clone())
}

/// Replace the cached entry for `root` (a new diff hash supersedes the old draft).
fn store_cached(root: &str, hash: u64, message: &str) {
    if let Ok(mut guard) = cache().lock() {
        guard.insert(root.to_string(), Cached { diff_hash: hash, message: message.to_string() });
    }
}

/// The JSON-schema `response_format` passed to the engine: an `analysis` (the
/// model's reasoning, generated first because it's listed first) followed by the
/// `commit_message`. Constraining to this schema is what guarantees the model
/// thinks before it writes — and that we can parse the result.
fn commit_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "json_schema",
        "json_schema": {
            "name": "commit",
            "schema": {
                "type": "object",
                "properties": {
                    "analysis": { "type": "string", "maxLength": 700 },
                    "commit_message": { "type": "string" }
                },
                "required": ["analysis", "commit_message"],
                "additionalProperties": false
            }
        }
    })
}

/// Pull `commit_message` out of the model's structured JSON reply. Falls back to
/// the raw text if it somehow isn't the expected JSON (grammar-constrained output
/// makes that unlikely, but we never want to surface a raw JSON blob to the user).
fn extract_commit_message(raw: &str) -> String {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| v.get("commit_message").and_then(|m| m.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| raw.to_string())
}

/// Record the exact prompt + raw model output + final message, so "why did it say
/// that?" is always answerable. The latest generation is ALWAYS written (overwrite)
/// to `<data-dir>/skill-studio/commitmsg-last.log`. Set `SKILL_STUDIO_COMMIT_DEBUG=1`
/// to ALSO keep an appended history in `commitmsg-debug.log` (and to unsilence the
/// llama-server logs).
fn debug_log(root: &str, messages: &[ChatMessage], raw: &str, final_msg: &str) {
    let Some(base) = dirs::data_dir() else { return };
    let dir = base.join("skill-studio");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut entry = String::from("\n========== generate_commit_message ==========\n");
    entry.push_str(&format!("root: {root}\n"));
    for m in messages {
        entry.push_str(&format!("\n----- {} -----\n{}\n", m.role, m.content));
    }
    entry.push_str(&format!("\n----- raw model output -----\n{raw}\n"));
    entry.push_str(&format!("\n----- final message -----\n{final_msg}\n"));

    // Always available: the most recent generation, overwritten each call.
    let _ = std::fs::write(dir.join("commitmsg-last.log"), &entry);
    // Opt-in: the full appended history.
    if std::env::var_os("SKILL_STUDIO_COMMIT_DEBUG").is_some() {
        if let Ok(mut f) =
            std::fs::OpenOptions::new().create(true).append(true).open(dir.join("commitmsg-debug.log"))
        {
            use std::io::Write;
            let _ = f.write_all(entry.as_bytes());
        }
    }
}

// The prompt is deliberately minimal: a single user message of "Generate a commit
// message for the following git diff:" + the raw worktree diff, truncated to
// `MAX_PROMPT_DIFF_BYTES` on a line boundary. No system prompt, few-shot, recent
// subjects, or per-file summary — see `generate`.

fn truncate_on_boundary(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ─────────────────────────── post-processing ───────────────────────────

/// Clean the model's raw output into a bare commit message: drop any reasoning
/// block, surrounding code fence, and wrapping quotes.
fn post_process(raw: &str) -> String {
    // A thinking model may emit <think>…</think> — keep only what follows.
    let after_think = match raw.rfind("</think>") {
        Some(i) => &raw[i + "</think>".len()..],
        None => raw,
    };
    let mut s = after_think.trim().to_string();

    // Strip a wrapping markdown code fence.
    if s.starts_with("```") {
        if let Some(nl) = s.find('\n') {
            s = s[nl + 1..].to_string();
        }
        if let Some(i) = s.rfind("```") {
            s = s[..i].to_string();
        }
        s = s.trim().to_string();
    }

    strip_wrapping_quotes(&s).trim().to_string()
}

fn strip_wrapping_quotes(s: &str) -> String {
    let t = s.trim();
    let mut chars = t.chars();
    if let (Some(first), Some(last)) = (chars.next(), t.chars().last()) {
        if first == last && (first == '"' || first == '\'' || first == '`') && t.len() >= 2 {
            return t[first.len_utf8()..t.len() - last.len_utf8()].trim().to_string();
        }
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_roundtrip_is_diff_scoped() {
        // Unique root so this never collides with another test sharing the static.
        let root = "/tmp/skill-commitmsg-cache-test";
        let h = diff_hash("diff --git a/x b/x\n+hello\n");
        assert_eq!(cached_for(root, h), None, "empty cache is a miss");
        store_cached(root, h, "feat: add hello");
        assert_eq!(cached_for(root, h).as_deref(), Some("feat: add hello"));
        // A different diff (different hash) must NOT return the stale draft.
        assert_eq!(cached_for(root, diff_hash("other diff")), None);
    }

    #[test]
    fn extract_commit_message_reads_structured_field() {
        let raw = r#"{"analysis":"removed the body","commit_message":"docs: trim SKILL.md"}"#;
        assert_eq!(extract_commit_message(raw), "docs: trim SKILL.md");
        // Falls back to the raw text when it isn't the expected JSON object.
        assert_eq!(extract_commit_message("docs: plain text"), "docs: plain text");
    }

    #[test]
    fn post_process_strips_think_fences_and_quotes() {
        assert_eq!(post_process("<think>let me reason</think>\nfeat: add thing"), "feat: add thing");
        assert_eq!(post_process("```\nfix: bug\n```"), "fix: bug");
        assert_eq!(post_process("```text\ndocs: update readme\n```"), "docs: update readme");
        assert_eq!(post_process("\"chore: bump deps\""), "chore: bump deps");
        assert_eq!(post_process("  refactor(core): tidy  "), "refactor(core): tidy");
    }
}
