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

use crate::agents::{self, ResumeCtx, TriggerCtx};
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
    /// Model / effort overrides the run was started with ("" = CLI default);
    /// reviving the conversation resumes with the same tuning.
    #[serde(default)]
    model: String,
    #[serde(default)]
    effort: String,
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
/// primary copy (the shared dir when eligible).
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

/// Force-reinstall the bundled skill-miner into every canonical location a
/// run would use — the mine dialog's explicit "reinstall official version"
/// action, for when an installed copy has drifted or broken. Same destination
/// walk as [`ensure_installed_in`], but unconditional. Returns the restored
/// roots.
pub fn reinstall_miner(bundled: Option<&Path>) -> Result<Vec<String>, String> {
    let bundled = bundled
        .filter(|s| s.join("SKILL.md").exists())
        .ok_or_else(|| "Bundled skill-miner skill not found.".to_string())?;
    let home = dirs::home_dir().ok_or_else(|| "Cannot locate home directory.".to_string())?;
    let mut restored = Vec::new();
    for dest in &secrets::INSTALL_DESTS {
        if !dest.triggers.iter().any(|t| home.join(t).exists()) {
            continue;
        }
        let target = home.join(dest.skills_rel).join(MINER_SKILL);
        install_skill(bundled, &target)?;
        restored.push(target.to_string_lossy().into_owned());
    }
    if restored.is_empty() {
        let target = home.join(".agents/skills").join(MINER_SKILL);
        install_skill(bundled, &target)?;
        restored.push(target.to_string_lossy().into_owned());
    }
    Ok(restored)
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

/// Snapshot the dirty flag of every personal skill: dirty ones are off-limits
/// to the run (user WIP), and clean ones that turn dirty are the run's edits.
fn dirty_candidates() -> Vec<Candidate> {
    let roots = discover::personal_roots();
    gitops::git_dirty_many(&roots)
        .into_iter()
        .map(|d| Candidate { root: d.root, dirty: d.dirty })
        .collect()
}

fn default_sources(sources: &[String]) -> Vec<String> {
    if sources.is_empty() {
        SOURCES.iter().map(|(id, _)| (*id).to_string()).collect()
    } else {
        sources.to_vec()
    }
}

/// The prompt a run with these settings would send — the dialog's editable
/// preview. Pure read: no run-dir reset, no skill install, no record. The
/// dirty set is re-snapshotted at start, so an unedited preview and the real
/// prompt can only differ if a skill's dirtiness changed in between.
pub fn preview_prompt(days: u64, sources: &[String], improve: bool) -> Result<String, String> {
    Ok(compose_prompt(&run_dir()?, days, &default_sources(sources), improve, &dirty_candidates()))
}

/// Set up a run: install the skill-miner where missing, snapshot the dirty
/// set, reset the run dir, and compose the agent prompt (or take the dialog's
/// edited `prompt_override` verbatim). The caller spawns the terminal and then
/// calls [`record_run`].
pub fn prepare_run(
    agent_family: &str,
    days: u64,
    sources: &[String],
    improve: bool,
    prompt_override: Option<&str>,
    bundled_miner: Option<&Path>,
) -> Result<PreparedRun, String> {
    if load_run().map(|r| r.status == "running").unwrap_or(false) {
        return Err("A mining run is already in progress.".into());
    }
    let agent = agents::by_family(agent_family)
        .filter(|a| a.trigger.is_some())
        .ok_or_else(|| format!("{agent_family} has no headless mode — mining needs an agent that can run unattended."))?;
    let home = dirs::home_dir().ok_or_else(|| "Cannot locate home directory.".to_string())?;

    ensure_installed_in(&home, bundled_miner)?;

    let candidates = dirty_candidates();

    // Reset the single retained run dir.
    let rdir = run_dir()?;
    if rdir.exists() {
        std::fs::remove_dir_all(&rdir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(rdir.join("out")).map_err(|e| e.to_string())?;
    // Helper files the agent's trigger line needs (e.g. claude's stream-json renderer).
    if let Some(prep) = agent.prepare {
        prep(&rdir)?;
    }

    let sources = default_sources(sources);
    let prompt = match prompt_override.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => p.to_string(),
        None => compose_prompt(&rdir, days, &sources, improve, &candidates),
    };
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
    days: u64,
    sources: &[String],
    improve: bool,
    candidates: &[Candidate],
) -> String {
    let rd = run_dir.to_string_lossy();
    // Run-specific parameters and the app's output contract ONLY — the skill's
    // own SKILL.md covers the pipeline, caps, staging area, quality bar and
    // report content. Don't repeat any of it here. The skill is invoked by
    // name: ensure_installed_in put it in the agent's skills dir, so it's
    // already in the agent's available-skills list.
    let mut lines = vec![
        "Use skill-miner to analyze conversations on this machine for skills to create / update".to_string(),
        String::new(),
        "Run settings:".to_string(),
        format!("- Window: last {days} days; sources: {}.", sources.join(", ")),
        format!("- Write the script outputs under {rd}/out/."),
    ];
    if improve {
        let dirty: Vec<&str> = candidates.iter().filter(|c| c.dirty).map(|c| c.root.as_str()).collect();
        if !dirty.is_empty() {
            lines.push(format!(
                "- These skills have uncommitted user changes — don't touch them; list them as deferred:\n{}",
                dirty.iter().map(|r| format!("    {r}")).collect::<Vec<_>>().join("\n")
            ));
        }
    } else {
        lines.push("- Do not edit any existing skill in place; only stage brand-new skills.".into());
    }
    lines.push(String::new());
    // No report file: the skill's own report step is the final message (visible
    // in the terminal, and the conversation stays resumable for follow-ups).
    // No structured results either — staged proposals surface via the skills
    // scan and in-place edits via git dirty tracking, so the run's only output
    // contract is the completion sentinel.
    lines.push(format!("When finished, create an empty file at {rd}/done — last, as the completion signal."));
    lines.join("\n")
}

/// The full shell line for a mining run: the agent's headless TRIGGER (from
/// the agent registry — zero-interaction, narrated live in the pane, session
/// id recorded), chained — only after a SUCCESSFUL run (the done sentinel
/// written) — into the agent's RESUME line, so opening the terminal afterwards lands
/// in the very conversation that did the mining: ask it why it proposed
/// something, or steer a refinement. (Interactive mode may show the agent's
/// own one-time per-directory trust prompt there; nothing is blocked — the
/// work is done.) Failed runs skip the chain so the pane ends at a shell and
/// the run-state probe can see the agent exited.
///
/// None when the family has no headless trigger — the caller surfaces that
/// as "this agent can't power mining runs".
pub fn launch_cmd(
    agent_family: &str,
    bin: &str,
    run_dir: &Path,
    prompt: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Option<String> {
    let def = agents::by_family(agent_family)?;
    let trigger = (def.trigger?)(&TriggerCtx { bin, run_dir, prompt, model, effort });
    let Some(resume) = def.resume else { return Some(trigger) };
    let resume = resume(&ResumeCtx { bin, run_dir, model, effort });
    let done = secrets::sh_quote(&run_dir.join("done").to_string_lossy());
    Some(format!("{trigger}; [ -f {done} ] && {{ {resume}; }}"))
}

/// Persist the run record once the terminal is up.
pub fn record_run(
    prep: PreparedRun,
    agent: &str,
    model: &str,
    effort: &str,
    terminal_id: &str,
) -> Result<MineState, String> {
    let rec = RunRecord {
        id: format!("mine-{}", now_unix()),
        started_unix: now_unix(),
        days: prep.days,
        sources: prep.sources,
        agent: agent.to_string(),
        model: model.to_string(),
        effort: effort.to_string(),
        improve: prep.improve,
        terminal_id: terminal_id.to_string(),
        status: "running".into(),
        candidates: prep.candidates,
    };
    save_run(&rec)?;
    state(|_| true, |_| true) // the session was just created; it's alive
}

/// "Continue the conversation" target: the run's terminal if it's still
/// alive, else a fresh terminal reviving the recorded session — the
/// conversation outlives the pane (both the record and the agent's own
/// session store live on disk). `spawn_resume` is the route layer's
/// `create_session_resume(agent_id, cwd, model, effort)` — the terminal
/// API's resume path, so the resume line is built in exactly one place.
pub fn continue_run(
    session_exists: impl Fn(&str) -> bool,
    spawn_resume: impl Fn(&str, &str, Option<&str>, Option<&str>) -> Result<String, String>,
) -> Result<String, String> {
    let mut rec = load_run().ok_or_else(|| "No mining run on record.".to_string())?;
    if rec.status == "running" || session_exists(&rec.terminal_id) {
        return Ok(rec.terminal_id);
    }
    let rdir = run_dir()?;
    let id = spawn_resume(
        &rec.agent,
        &rdir.to_string_lossy(),
        Some(rec.model.as_str()).filter(|m| !m.is_empty()),
        Some(rec.effort.as_str()).filter(|e| !e.is_empty()),
    )?;
    rec.terminal_id = id.clone();
    save_run(&rec)?;
    Ok(id)
}

/// Current run state. The two probes are supplied by the route layer (it owns
/// skill-term) and only consulted while the record still says "running":
/// `session_exists` = the tmux session is listed; `agent_running` = its
/// foreground command isn't back to a plain shell. Headless runs exit when
/// done, so "agent gone but no done sentinel" means the run ended without
/// completing — surfaced as "stopped". A startup grace period covers the
/// moment the launch line is still spinning up under the pane's shell.
pub fn state(
    session_exists: impl Fn(&str) -> bool,
    agent_running: impl Fn(&str) -> bool,
) -> Result<MineState, String> {
    let Some(mut rec) = load_run() else {
        return Ok(MineState {
            status: "idle".into(),
            stage: None,
            found: None,
            started_unix: None,
            terminal_id: None,
            improved: Vec::new(),
        });
    };
    let rdir = run_dir()?;

    // The done sentinel is the completion signal and outranks liveness probes:
    // it also recovers a record a flaky probe wrongly marked "stopped" while
    // the agent was in fact still working.
    if rdir.join("done").exists() && (rec.status == "running" || rec.status == "stopped") {
        rec.status = "done".into();
        let _ = save_run(&rec);
    } else if rec.status == "running" {
        let past_grace = now_unix().saturating_sub(rec.started_unix) > 60;
        if !session_exists(&rec.terminal_id) || (past_grace && !agent_running(&rec.terminal_id)) {
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
    fn launch_cmd_uses_headless_modes() {
        let rd = Path::new("/tmp/run");
        // claude: print mode (skips the workspace-trust dialog by design),
        // stream-json piped through the bundled live renderer.
        let c = launch_cmd("claude", "/bin/claude", rd, "do the thing", Some("opus"), Some("max"))
            .expect("claude has a trigger");
        assert!(c.starts_with("'/bin/claude' -p 'do the thing'"));
        assert!(c.contains("--permission-mode auto"));
        assert!(c.contains("--output-format stream-json"));
        assert!(c.contains("--model 'opus'"));
        assert!(c.contains("--effort 'max'"));
        assert!(c.contains("| python3 -u '/tmp/run/watch.py' '/tmp/run/session-id'"));
        // A successful run chains into the resumed interactive session, with
        // the same model/effort tuning.
        assert!(c.contains("[ -f '/tmp/run/done' ] && {"));
        assert!(c.contains("--resume \"$(cat '/tmp/run/session-id')\" --model 'opus' --effort 'max'"));
        // model/effort omitted entirely when unset.
        let c2 = launch_cmd("claude", "/bin/claude", rd, "p", None, None).unwrap();
        assert!(!c2.contains("--model") && !c2.contains("--effort"));
        // codex: exec subcommand, approvals off, effort via -c; the chained
        // resume self-captures the session id from rollouts (not just --last).
        let x = launch_cmd("codex", "/bin/codex", rd, "do the thing", Some("gpt-5.5"), Some("xhigh"))
            .expect("codex has a trigger");
        assert!(x.starts_with("'/bin/codex' exec --skip-git-repo-check"));
        assert!(x.contains("'do the thing' </dev/null"));
        assert!(x.contains("'approval_policy=\"never\"'"));
        assert!(x.contains("-m 'gpt-5.5'"));
        assert!(x.contains("'model_reasoning_effort=\"xhigh\"'"));
        assert!(x.contains("[ -f '/tmp/run/done' ] && {"));
        assert!(x.contains("resume \"$(cat '/tmp/run/session-id')\""));
        // No headless trigger (discovery-only or unknown family) ⇒ no line.
        assert!(launch_cmd("cursor", "/bin/c", rd, "p", None, None).is_none());
        assert!(launch_cmd("shell", "/bin/bash", rd, "p", None, None).is_none());
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
