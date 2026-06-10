// Skill mining: run the bundled `skill-miner` skill as an agent terminal
// session and land its outputs in the app's existing review loops (new skills
// → the `generated-skills/` Proposed staging area; improvements → ordinary
// uncommitted changes reviewed with the worktree diff).
//
// The judgment work (cluster, judge, author) is the agent's, per the skill's
// own instructions; this module owns the run lifecycle around it: refresh the
// installed copy of the skill, snapshot which skills were already dirty (so
// mined edits are attributable — and user WIP is off-limits), compose the run
// prompt, and report progress by watching the run dir's artifacts.
//
// skill-term depends on this crate, so this module cannot spawn terminals
// itself; the route layer (skill-server) passes the spawn/alive/kill
// operations in. Everything else lives here.
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::sync::copy_tree;
use crate::{discover, gitops, secrets};

/// Where the miner's transcript adapters look, mirrored here only to give the
/// source-picker honest per-agent session counts (a cheap mtime walk — the
/// real parsing happens inside the run).
const SOURCES: [(&str, &str); 2] = [("claude-code", "Claude Code"), ("codex", "Codex")];

const MINER_SKILL: &str = "skill-miner";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MineSource {
    pub id: String,
    pub label: String,
    /// Transcript files modified within the window.
    pub sessions: usize,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    root: String,
    dirty: bool,
}

/// The persisted record of the (single, most recent) run.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunRecord {
    id: String,
    started_unix: u64,
    days: u64,
    sources: Vec<String>,
    agent: String,
    improve: bool,
    terminal_id: String,
    /// "running" | "done" | "stopped" — "done" / "stopped" are sticky.
    status: String,
    /// Every personal skill at run start with its dirty flag: the fixed set we
    /// re-check to attribute in-place edits to the run (user WIP stays out).
    candidates: Vec<Candidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MineState {
    /// "idle" (never ran / no record) | "running" | "done" | "stopped".
    pub status: String,
    /// While running: "scanning" | "analyzing" | "reviewing".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    /// Sessions found by the discover step (inventory rows).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub found: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_unix: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    /// The run report, once written (open via the markdown route).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_path: Option<String>,
    /// The agent-written results.json, verbatim (proposals with evidence).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<serde_json::Value>,
    /// Existing skills the run dirtied (clean at start, dirty now). Self-
    /// clearing: once the user saves a version or discards, the root drops out.
    pub improved: Vec<String>,
}

fn mining_dir() -> Result<PathBuf, String> {
    Ok(secrets::config_dir()?.join("mining"))
}
fn run_dir() -> Result<PathBuf, String> {
    Ok(mining_dir()?.join("current"))
}
fn run_file() -> Result<PathBuf, String> {
    Ok(run_dir()?.join("run.json"))
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn load_run() -> Option<RunRecord> {
    let raw = std::fs::read_to_string(run_file().ok()?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_run(rec: &RunRecord) -> Result<(), String> {
    let path = run_file()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

fn count_lines(path: &Path) -> Option<usize> {
    let raw = std::fs::read_to_string(path).ok()?;
    Some(raw.lines().filter(|l| !l.trim().is_empty()).count())
}

/// Per-source transcript counts within the window — powers the source picker.
pub fn sources(days: u64) -> Vec<MineSource> {
    let cutoff = SystemTime::now() - std::time::Duration::from_secs(days.max(1) * 86400);
    let home = dirs::home_dir().unwrap_or_default();
    SOURCES
        .iter()
        .map(|(id, label)| {
            let n = match *id {
                "claude-code" => count_recent(&home.join(".claude/projects"), "jsonl", 2, cutoff),
                "codex" => count_recent(&home.join(".codex/sessions"), "jsonl", 8, cutoff),
                _ => 0,
            };
            MineSource { id: (*id).into(), label: (*label).into(), sessions: n }
        })
        .collect()
}

/// Count files with `ext` under `base` (up to `depth` levels) modified after
/// `cutoff`. Cheap stat-only walk; never recurses past the depth budget.
fn count_recent(base: &Path, ext: &str, depth: usize, cutoff: SystemTime) -> usize {
    fn walk(dir: &Path, ext: &str, depth: usize, cutoff: SystemTime, n: &mut usize) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.is_dir() {
                if depth > 0 {
                    walk(&p, ext, depth - 1, cutoff, n);
                }
            } else if p.extension().and_then(|x| x.to_str()) == Some(ext)
                && e.metadata().and_then(|m| m.modified()).map(|m| m >= cutoff).unwrap_or(false)
            {
                *n += 1;
            }
        }
    }
    let mut n = 0;
    walk(base, ext, depth, cutoff, &mut n);
    n
}

/// First-use install of the bundled skill-miner, into every canonical skills
/// location whose agent cohort is present — the same destinations the
/// load-secrets activation skill uses (the shared `~/.agents/skills`, plus the
/// holdouts that don't read it: Claude Code's `~/.claude/skills`, OpenClaw's).
/// Per location it installs only when missing: each installed copy is the
/// user's afterwards — editable and versionable — and runs never overwrite it;
/// deleting a copy restores the official version on the next run. Returns the
/// primary copy (the shared dir when eligible) for the run prompt to reference.
fn ensure_installed_in(home: &Path, bundled: Option<&Path>) -> Result<PathBuf, String> {
    let bundled = bundled.filter(|s| s.join("SKILL.md").exists());
    let missing_src = || "Bundled skill-miner skill not found.".to_string();
    let mut primary: Option<PathBuf> = None;
    for dest in &secrets::INSTALL_DESTS {
        if !dest.triggers.iter().any(|t| home.join(t).exists()) {
            continue;
        }
        let target = home.join(dest.skills_rel).join(MINER_SKILL);
        if !target.join("SKILL.md").exists() {
            install_skill(bundled.ok_or_else(missing_src)?, &target)?;
        }
        primary.get_or_insert(target);
    }
    match primary {
        Some(p) => Ok(p),
        // No canonical dir on this machine (bare home) — fall back to creating
        // the shared standard dir rather than dead-ending the run.
        None => {
            let target = home.join(".agents/skills").join(MINER_SKILL);
            if !target.join("SKILL.md").exists() {
                install_skill(bundled.ok_or_else(missing_src)?, &target)?;
            }
            Ok(target)
        }
    }
}

/// Install (or reinstall) a bundled skill into `dest`, replacing its content
/// while preserving any `.git` the user created there. A versioned copy thus
/// receives an official update as ordinary uncommitted changes — reviewable
/// and revertable chunk by chunk — never as silent loss of their history.
fn install_skill(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let rd = std::fs::read_dir(dest).map_err(|e| e.to_string())?;
    for entry in rd.filter_map(|e| e.ok()) {
        if entry.file_name() == ".git" {
            continue;
        }
        let p = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false);
        let res = if is_dir { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        res.map_err(|e| e.to_string())?;
    }
    let mut total = 0;
    copy_tree(src, dest, &mut total)
}

/// Everything the route layer needs to spawn the run's terminal.
pub struct PreparedRun {
    pub run_dir: String,
    pub prompt: String,
    days: u64,
    sources: Vec<String>,
    improve: bool,
    candidates: Vec<Candidate>,
}

/// Set up a run: refresh the installed skill-miner from the bundled copy,
/// snapshot the dirty set, reset the run dir, and compose the agent prompt.
/// The caller spawns the terminal and then calls [`record_run`].
pub fn prepare_run(
    days: u64,
    sources: &[String],
    improve: bool,
    bundled_miner: Option<&Path>,
) -> Result<PreparedRun, String> {
    if load_run().map(|r| r.status == "running").unwrap_or(false) {
        return Err("A mining run is already in progress.".into());
    }
    let home = dirs::home_dir().ok_or_else(|| "Cannot locate home directory.".to_string())?;

    let installed = ensure_installed_in(&home, bundled_miner)?;

    // Snapshot the dirty flag of every personal skill: dirty ones are off-limits
    // to the run (user WIP), and clean ones that turn dirty are the run's edits.
    let roots = discover::personal_roots();
    let candidates: Vec<Candidate> = gitops::git_dirty_many(&roots)
        .into_iter()
        .map(|d| Candidate { root: d.root, dirty: d.dirty })
        .collect();

    // Reset the single retained run dir.
    let rdir = run_dir()?;
    if rdir.exists() {
        std::fs::remove_dir_all(&rdir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(rdir.join("out")).map_err(|e| e.to_string())?;

    let sources = if sources.is_empty() {
        SOURCES.iter().map(|(id, _)| (*id).to_string()).collect()
    } else {
        sources.to_vec()
    };
    let prompt = compose_prompt(&rdir, &installed, days, &sources, improve, &candidates);
    Ok(PreparedRun {
        run_dir: rdir.to_string_lossy().into_owned(),
        prompt,
        days,
        sources,
        improve,
        candidates,
    })
}

fn compose_prompt(
    run_dir: &Path,
    skill_dir: &Path,
    days: u64,
    sources: &[String],
    improve: bool,
    candidates: &[Candidate],
) -> String {
    let rd = run_dir.to_string_lossy();
    let sd = skill_dir.to_string_lossy();
    let improve_clause = if improve {
        let dirty: Vec<&str> = candidates.iter().filter(|c| c.dirty).map(|c| c.root.as_str()).collect();
        let skip = if dirty.is_empty() {
            String::new()
        } else {
            format!(
                " EXCEPT these skills, which have uncommitted user changes — do not touch them, list them as deferred instead:\n{}",
                dirty.iter().map(|r| format!("  - {r}")).collect::<Vec<_>>().join("\n")
            )
        };
        format!("- You may extend existing skills by editing them in place, as the skill instructs.{skip}")
    } else {
        "- Do NOT edit any existing skill in place. Only stage brand-new skills.".to_string()
    };
    format!(
        "Read and follow the skill at {sd}/SKILL.md to mine my recent agent sessions and propose Agent Skills.\n\
         \n\
         Parameters for this run:\n\
         - Transcript window: the last {days} days. Sources (--agents): {sources}. Cap analysis at the newest 100 conversations.\n\
         - Write the script outputs under {rd}/out (pass --out {rd}/out/inventory.jsonl and --out {rd}/out/conversations.jsonl).\n\
         {improve_clause}\n\
         - Stage brand-new skills under ~/.agents/skills/generated-skills/<name>/ as the skill instructs.\n\
         - Sanitize everything you write: never copy secrets, tokens, email addresses, or other personal data into a skill, report, or commit — paraphrase evidence instead.\n\
         \n\
         When you are done, write exactly two files into {rd}:\n\
         1. report.md — what you created/modified, deferred candidates, every sizeable rejected group with the quality-bar gate it failed, and any repo-doc updates you recommend instead of skills.\n\
         2. results.json — exactly this shape: {{\"proposals\": [{{\"name\": \"<skill name>\", \"root\": \"<absolute staged path>\", \"sessions\": <count>, \"projects\": <count>}}], \"improved\": [\"<absolute path of each skill you edited in place>\"], \"deferred\": [\"<short description>\"]}}\n\
         \n\
         results.json is the completion signal — write it last.",
        sources = sources.join(","),
    )
}

/// Persist the run record once the terminal is up.
pub fn record_run(prep: PreparedRun, agent: &str, terminal_id: &str) -> Result<MineState, String> {
    let rec = RunRecord {
        id: format!("mine-{}", now_unix()),
        started_unix: now_unix(),
        days: prep.days,
        sources: prep.sources,
        agent: agent.to_string(),
        improve: prep.improve,
        terminal_id: terminal_id.to_string(),
        status: "running".into(),
        candidates: prep.candidates,
    };
    save_run(&rec)?;
    state(|_| true) // the session was just created; it's alive
}

/// Current run state. `terminal_alive` is supplied by the route layer (it owns
/// skill-term); it's only consulted while the record still says "running".
pub fn state(terminal_alive: impl Fn(&str) -> bool) -> Result<MineState, String> {
    let Some(mut rec) = load_run() else {
        return Ok(MineState {
            status: "idle".into(),
            stage: None,
            found: None,
            started_unix: None,
            terminal_id: None,
            report_path: None,
            results: None,
            improved: Vec::new(),
        });
    };
    let rdir = run_dir()?;
    let results_path = rdir.join("results.json");
    let report = rdir.join("report.md");

    let results: Option<serde_json::Value> = std::fs::read_to_string(&results_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());

    if rec.status == "running" {
        if results.is_some() {
            rec.status = "done".into();
            let _ = save_run(&rec);
        } else if !terminal_alive(&rec.terminal_id) {
            rec.status = "stopped".into();
            let _ = save_run(&rec);
        }
    }

    let stage = (rec.status == "running").then(|| {
        if rdir.join("out/conversations.jsonl").exists() {
            "reviewing".to_string()
        } else if rdir.join("out/inventory.jsonl").exists() {
            "analyzing".to_string()
        } else {
            "scanning".to_string()
        }
    });
    let found = count_lines(&rdir.join("out/inventory.jsonl"));

    // In-place edits attributable to the run: clean at start, dirty now. The
    // check stays cheap because the candidate list is fixed at run start.
    let clean_at_start: Vec<String> =
        rec.candidates.iter().filter(|c| !c.dirty).map(|c| c.root.clone()).collect();
    let improved: Vec<String> = if rec.status == "running" || rec.status == "done" {
        gitops::git_dirty_many(&clean_at_start)
            .into_iter()
            .filter(|d| d.dirty)
            .map(|d| d.root)
            .collect()
    } else {
        Vec::new()
    };

    Ok(MineState {
        status: rec.status.clone(),
        stage,
        found,
        started_unix: Some(rec.started_unix),
        terminal_id: Some(rec.terminal_id.clone()),
        report_path: report.exists().then(|| report.to_string_lossy().into_owned()),
        results,
        improved,
    })
}

/// Stop a running run: the route layer kills the terminal; we mark the record.
pub fn stop(kill: impl Fn(&str) -> Result<(), String>) -> Result<(), String> {
    let Some(mut rec) = load_run() else { return Ok(()) };
    if rec.status == "running" {
        let _ = kill(&rec.terminal_id);
        rec.status = "stopped".into();
        save_run(&rec)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_skill_preserves_git_and_replaces_content() {
        let base = std::env::temp_dir().join(format!("ass_mine_install_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        std::fs::create_dir_all(src.join("scripts")).unwrap();
        std::fs::write(src.join("SKILL.md"), "official v2").unwrap();
        std::fs::write(src.join("scripts/new.py"), "new").unwrap();
        // Installed copy: user-versioned (.git), user-edited, with a stale file.
        let dest = base.join("dest");
        std::fs::create_dir_all(dest.join(".git")).unwrap();
        std::fs::write(dest.join(".git/HEAD"), "ref: refs/heads/master").unwrap();
        std::fs::write(dest.join("SKILL.md"), "user-edited").unwrap();
        std::fs::write(dest.join("stale.md"), "removed upstream").unwrap();

        install_skill(&src, &dest).unwrap();

        assert_eq!(std::fs::read_to_string(dest.join("SKILL.md")).unwrap(), "official v2");
        assert!(dest.join(".git/HEAD").exists(), ".git must survive a reinstall");
        assert!(!dest.join("stale.md").exists(), "files dropped upstream are removed");
        assert!(dest.join("scripts/new.py").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ensure_installed_covers_claude_and_never_overwrites() {
        let base = std::env::temp_dir().join(format!("ass_mine_ensure_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        // Claude Code (own folder) and Codex (shared-dir cohort) are present.
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        let src = base.join("bundled/skill-miner");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("SKILL.md"), "official").unwrap();

        let primary = ensure_installed_in(&home, Some(&src)).unwrap();

        // Both the shared dir and Claude's own dir get a copy; the shared one
        // is primary (it's what the run prompt references).
        let shared = home.join(".agents/skills/skill-miner");
        let claude = home.join(".claude/skills/skill-miner");
        assert_eq!(primary, shared);
        assert!(shared.join("SKILL.md").exists());
        assert!(claude.join("SKILL.md").exists());

        // User edits are never overwritten by later runs — per copy.
        std::fs::write(shared.join("SKILL.md"), "user-tuned").unwrap();
        let again = ensure_installed_in(&home, Some(&src)).unwrap();
        assert_eq!(again, shared);
        assert_eq!(std::fs::read_to_string(shared.join("SKILL.md")).unwrap(), "user-tuned");

        // Deleting one copy restores just that copy on the next run.
        std::fs::remove_dir_all(&claude).unwrap();
        ensure_installed_in(&home, Some(&src)).unwrap();
        assert_eq!(std::fs::read_to_string(claude.join("SKILL.md")).unwrap(), "official");
        assert_eq!(std::fs::read_to_string(shared.join("SKILL.md")).unwrap(), "user-tuned");

        // A bare home (no agent dotdirs) falls back to the shared standard dir.
        let bare = base.join("bare-home");
        std::fs::create_dir_all(&bare).unwrap();
        let p = ensure_installed_in(&bare, Some(&src)).unwrap();
        assert_eq!(p, bare.join(".agents/skills/skill-miner"));
        assert!(p.join("SKILL.md").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
