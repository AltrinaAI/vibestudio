//! Generate a Conventional-Commits message from a skill's uncommitted diff,
//! using the on-device `engine`. Transport-agnostic: both the Tauri command and
//! the headless server route call `generate`.

use crate::engine::{self, ChatMessage};
use crate::gitops;

/// Diff bytes we put into the prompt. The worktree diff is capped at 2 MB
/// (gitops) — far more than a small model's context — so we further trim to a
/// few thousand tokens' worth here. Code tokenizes densely (~2–3 chars/token),
/// so ~12 KB leaves comfortable room for the system prompt + a short reply
/// within an 8K context.
const MAX_PROMPT_DIFF_BYTES: usize = 12_000;

/// Draft a commit message for the skill at `root`. Returns a ready-to-edit
/// message (the user still reviews it before committing).
pub fn generate(root: &str) -> Result<String, String> {
    let diff = gitops::worktree_diff_text(root)?;
    if diff.trim().is_empty() {
        return Err("No changes to describe — make some edits first.".into());
    }
    let prepared = prepare_diff(&diff, MAX_PROMPT_DIFF_BYTES);
    let subjects = gitops::recent_subjects(root, 5);
    let messages = build_messages(&prepared, &subjects);

    let raw = engine::chat(&messages, 256, 0.2)?;
    let msg = post_process(&raw);
    debug_log(root, &messages, &raw, &msg);
    if msg.is_empty() {
        return Err("The AI didn't produce a usable message — try again.".into());
    }
    Ok(msg)
}

/// Append the exact prompt + raw model output + final message to a log file, so
/// the inputs/outputs are inspectable. Off unless `SKILL_STUDIO_COMMIT_DEBUG` is
/// set; writes to `<data-dir>/skill-studio/commitmsg-debug.log`.
fn debug_log(root: &str, messages: &[ChatMessage], raw: &str, final_msg: &str) {
    if std::env::var_os("SKILL_STUDIO_COMMIT_DEBUG").is_none() {
        return;
    }
    let Some(base) = dirs::data_dir() else { return };
    let path = base.join("skill-studio").join("commitmsg-debug.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut entry = String::from("\n========== generate_commit_message ==========\n");
    entry.push_str(&format!("root: {root}\n"));
    for m in messages {
        entry.push_str(&format!("\n----- {} -----\n{}\n", m.role, m.content));
    }
    entry.push_str(&format!("\n----- raw model output -----\n{raw}\n"));
    entry.push_str(&format!("\n----- final message -----\n{final_msg}\n"));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = f.write_all(entry.as_bytes());
    }
}

// ─────────────────────────────── prompt ───────────────────────────────

const SYSTEM_PROMPT: &str = "\
You write git commit messages in the Conventional Commits format. Rules:
- Format: <type>(<optional-scope>): <subject>
- type is one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore
- subject: imperative present tense, lowercase first word, no trailing period, at most 60 characters
- Optionally add a body after one blank line: 1-4 short bullet points explaining what changed and why, wrapped at 72 characters
- Output ONLY the commit message. No preamble, no explanation, no quotes, no markdown fences.";

const FEWSHOT_DIFF: &str = "\
diff --git a/server.ts b/server.ts
--- a/server.ts
+++ b/server.ts
@@
-app.listen(3000)
+const PORT = process.env.PORT || 3000
+app.listen(PORT)";

const FEWSHOT_ANSWER: &str = "refactor(server): read listen port from environment";

fn build_messages(prepared_diff: &str, subjects: &[String]) -> Vec<ChatMessage> {
    let mut user = String::from("Generate a Conventional Commits message for the following diff.");
    if !subjects.is_empty() {
        user.push_str("\nRecent commit subjects in this repo (match their style):\n");
        for s in subjects {
            user.push_str("- ");
            user.push_str(s);
            user.push('\n');
        }
    }
    user.push_str("\nDiff:\n");
    user.push_str(prepared_diff);

    vec![
        ChatMessage::new("system", SYSTEM_PROMPT),
        ChatMessage::new("user", format!("Generate a Conventional Commits message for the following diff.\n\nDiff:\n{FEWSHOT_DIFF}")),
        ChatMessage::new("assistant", FEWSHOT_ANSWER),
        ChatMessage::new("user", user),
    ]
}

// ───────────────────────────── diff prep ─────────────────────────────

/// Trim the worktree diff to fit the model: split into per-file sections, drop
/// generated/lock/binary files, and include whole files until the byte budget is
/// hit (breadth over depth). Notes what was left out so the model knows the
/// change set is broader than what it sees.
fn prepare_diff(diff: &str, budget: usize) -> String {
    let sections = split_sections(diff);
    if sections.is_empty() {
        return truncate_on_boundary(diff, budget).to_string();
    }

    let mut body = String::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut omitted: Vec<String> = Vec::new();
    for (path, text) in sections {
        if should_skip_path(&path) {
            skipped.push(path);
            continue;
        }
        if body.len() + text.len() > budget {
            omitted.push(path);
            continue;
        }
        body.push_str(&text);
    }

    if body.is_empty() {
        // Everything was skipped or too large — give the model a file list to
        // summarize rather than nothing.
        let all: Vec<String> = skipped.into_iter().chain(omitted).collect();
        return format!("Changed files (no textual diff shown):\n{}", all.join("\n"));
    }

    let mut notes: Vec<String> = Vec::new();
    if !skipped.is_empty() {
        notes.push(format!("Skipped generated/lock/binary files: {}", skipped.join(", ")));
    }
    if !omitted.is_empty() {
        notes.push(format!("Other changed files not shown (diff too large): {}", omitted.join(", ")));
    }
    if !notes.is_empty() {
        body.push_str("\n# ");
        body.push_str(&notes.join("\n# "));
        body.push('\n');
    }
    body
}

/// Split a unified diff into `(path, section_text)` pairs, one per file (each
/// file's hunk begins with a `diff --git ` line).
fn split_sections(diff: &str) -> Vec<(String, String)> {
    let mut sections = Vec::new();
    let mut cur_path = String::new();
    let mut cur = String::new();
    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            if !cur.is_empty() {
                sections.push((std::mem::take(&mut cur_path), std::mem::take(&mut cur)));
            }
            cur_path = parse_diff_path(line);
        }
        cur.push_str(line);
        cur.push('\n');
    }
    if !cur.is_empty() {
        sections.push((cur_path, cur));
    }
    sections
}

/// The new-side path from a `diff --git a/<old> b/<new>` header.
fn parse_diff_path(line: &str) -> String {
    if let Some(idx) = line.rfind(" b/") {
        return line[idx + 3..].trim().to_string();
    }
    line.trim_start_matches("diff --git ").trim().to_string()
}

/// Files whose textual diff adds noise without helping describe intent:
/// lockfiles, build output, and binaries/assets.
fn should_skip_path(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    if p.ends_with(".lock") || p.contains("-lock.") {
        return true; // Cargo.lock, package-lock.json, pnpm-lock.yaml, yarn.lock, …
    }
    if p.starts_with("dist/")
        || p.contains("/dist/")
        || p.starts_with("target/")
        || p.contains("/target/")
        || p.contains("node_modules/")
    {
        return true;
    }
    const BIN_EXT: &[&str] = &[
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".pdf", ".zip", ".gz", ".tar",
        ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mov", ".mp3", ".wasm", ".bin",
    ];
    BIN_EXT.iter().any(|e| p.ends_with(e))
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

    const SAMPLE_DIFF: &str = "\
diff --git a/Cargo.lock b/Cargo.lock
index 111..222 100644
--- a/Cargo.lock
+++ b/Cargo.lock
@@ -1,2 +1,2 @@
-old-locked-version
+new-locked-version
diff --git a/src/main.rs b/src/main.rs
index aaa..bbb 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1 +1 @@
-fn main() {}
+fn main() { println!(\"hi\"); }
";

    #[test]
    fn prepare_diff_drops_lockfiles_keeps_code() {
        let out = prepare_diff(SAMPLE_DIFF, MAX_PROMPT_DIFF_BYTES);
        assert!(out.contains("src/main.rs"));
        assert!(out.contains("println!"));
        // The lockfile's content must not leak into the prompt.
        assert!(!out.contains("new-locked-version"));
        // …but the model is told it was skipped.
        assert!(out.contains("Skipped generated/lock/binary files: Cargo.lock"));
    }

    #[test]
    fn prepare_diff_falls_back_to_file_list_when_all_skipped() {
        let only_lock = "\
diff --git a/Cargo.lock b/Cargo.lock
--- a/Cargo.lock
+++ b/Cargo.lock
@@ -1 +1 @@
-a
+b
";
        let out = prepare_diff(only_lock, MAX_PROMPT_DIFF_BYTES);
        assert!(out.contains("Changed files"));
        assert!(out.contains("Cargo.lock"));
        assert!(!out.contains("+b"));
    }

    #[test]
    fn should_skip_path_matches_common_generated_files() {
        for p in ["Cargo.lock", "package-lock.json", "pnpm-lock.yaml", "dist/app.js", "icons/logo.png", "node_modules/x/y.js"] {
            assert!(should_skip_path(p), "expected to skip {p}");
        }
        for p in ["src/main.rs", "SKILL.md", "scripts/run.py"] {
            assert!(!should_skip_path(p), "expected to keep {p}");
        }
    }

    #[test]
    fn parse_diff_path_reads_new_side() {
        assert_eq!(parse_diff_path("diff --git a/src/main.rs b/src/main.rs"), "src/main.rs");
        assert_eq!(parse_diff_path("diff --git a/old.rs b/new.rs"), "new.rs");
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
