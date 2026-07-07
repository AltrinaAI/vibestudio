//! Draft a one-line message from a skill's uncommitted diff. This is the POLICY
//! layer — diff prep, the per-diff cache, post-processing, and debug logging; the
//! actual generation is delegated to `commit_agent`, which picks a backend (a
//! logged-in coding-agent CLI by default, the on-device engine when opted in).
//! Transport-agnostic: reached over `/api` by `skill-server` (in-process in the
//! desktop, or standalone on a remote host).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::commit_agent;
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
    // Auto / eager path: a fixed seed makes the draft deterministic (same diff ⇒
    // same message), so the background draft and a repeat call agree.
    run(root, &diff, hash, 42, 1.0)
}

/// Force a fresh draft, ignoring the cache. The manual ✨ Generate button calls
/// this: each click should offer a genuinely different phrasing, so we vary the
/// seed (the auto path's fixed seed would just reproduce the cached message —
/// clicking would appear to do nothing). The newest result replaces the cache, so
/// the dialog/auto-populate reflect it.
pub fn regenerate(root: &str) -> Result<String, String> {
    let diff = gitops::worktree_diff_text(root)?;
    if diff.trim().is_empty() {
        return Err("No changes to describe — make some edits first.".into());
    }
    let hash = diff_hash(&diff);
    run(root, &diff, hash, next_seed(), 1.0)
}

/// Shared generation core: truncate the diff → `commit_agent` (backend of the
/// day) → post-process → cache. These are version notes for a skill author, NOT
/// code commits: a plain one-line description with no `feat:`/`fix:`/type prefix.
fn run(root: &str, diff: &str, hash: u64, seed: i64, temperature: f32) -> Result<String, String> {
    let g = commit_agent::generate(truncate_on_boundary(diff, MAX_PROMPT_DIFF_BYTES), seed, temperature)?;
    let msg = post_process(&g.text);
    debug_log(root, diff, &g, &msg);
    if msg.is_empty() {
        return Err("The AI didn't produce a usable message — try again.".into());
    }
    store_cached(root, hash, &msg);
    Ok(msg)
}

/// A new sampling seed for each manual re-roll, so repeated clicks vary. The
/// fixed 42 used by the auto path stays separate.
fn next_seed() -> i64 {
    use std::sync::atomic::{AtomicI64, Ordering};
    static SEED: AtomicI64 = AtomicI64::new(0);
    1000 + SEED.fetch_add(1, Ordering::Relaxed)
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

/// Record the diff + raw backend output + final message, so "why did it say
/// that?" is always answerable. The latest generation is ALWAYS written (overwrite)
/// to `<data-dir>/vibestudio/commitmsg-last.log`. Set `VIBESTUDIO_COMMIT_DEBUG=1`
/// to ALSO keep an appended history in `commitmsg-debug.log` (and, for the llama
/// backend, to unsilence the engine logs).
fn debug_log(root: &str, diff: &str, g: &commit_agent::Generated, final_msg: &str) {
    let Some(base) = dirs::data_dir() else { return };
    let dir = base.join("vibestudio");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut entry = String::from("\n========== generate_commit_message ==========\n");
    entry.push_str(&format!("root: {root}\nbackend: {}\n", g.backend));
    entry.push_str(&format!("\n----- diff (truncated) -----\n{}\n", truncate_on_boundary(diff, MAX_PROMPT_DIFF_BYTES)));
    entry.push_str(&format!("\n----- raw backend output -----\n{}\n", g.raw));
    entry.push_str(&format!("\n----- final message -----\n{final_msg}\n"));

    // Always available: the most recent generation, overwritten each call.
    let _ = std::fs::write(dir.join("commitmsg-last.log"), &entry);
    // Opt-in: the full appended history.
    if std::env::var_os("VIBESTUDIO_COMMIT_DEBUG").is_some() {
        if let Ok(mut f) =
            std::fs::OpenOptions::new().create(true).append(true).open(dir.join("commitmsg-debug.log"))
        {
            use std::io::Write;
            let _ = f.write_all(entry.as_bytes());
        }
    }
}

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

    cap_length(&strip_wrapping_quotes(&s))
}

/// Keep drafts terse. The prompt targets ~10 words, but a backend can over-run or
/// tack on an explanation, so as a backstop we keep only the first line and cap
/// the word count — generous enough that a faithful ~10-word message is untouched.
fn cap_length(s: &str) -> String {
    const MAX_WORDS: usize = 12;
    let first_line = s.lines().next().unwrap_or(s).trim();
    first_line.split_whitespace().take(MAX_WORDS).collect::<Vec<_>>().join(" ")
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
    fn post_process_strips_think_fences_and_quotes() {
        assert_eq!(post_process("<think>let me reason</think>\nfeat: add thing"), "feat: add thing");
        assert_eq!(post_process("```\nfix: bug\n```"), "fix: bug");
        assert_eq!(post_process("```text\ndocs: update readme\n```"), "docs: update readme");
        assert_eq!(post_process("\"chore: bump deps\""), "chore: bump deps");
        assert_eq!(post_process("  refactor(core): tidy  "), "refactor(core): tidy");
    }

    #[test]
    fn post_process_caps_length() {
        // An over-long draft is trimmed to the word cap (a faithful short one isn't).
        let long = "Refactor the source control panel to add a shared sync helper and wire everything up";
        assert_eq!(post_process(long).split_whitespace().count(), 12);
        assert_eq!(post_process("Add sync button to versions header"), "Add sync button to versions header");
        // A trailing explanation line is dropped — only the summary survives.
        assert_eq!(post_process("Tidy the remote section\n\nThis also removes the pin."), "Tidy the remote section");
    }
}
