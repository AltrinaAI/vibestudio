// Tauri desktop app: thin #[tauri::command] wrappers over skill-core / skill-term.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use skill_core::{discover, gitops, secrets, skill, sync};
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Live PTY attachments, keyed by session id. Holding the `Arc` keeps the
/// tmux-attach client alive until the UI detaches (the tmux session itself
/// outlives any attachment — see `skill_term`).
#[derive(Default)]
struct TermState {
    atts: Mutex<HashMap<String, Arc<skill_term::Attachment>>>,
}

#[tauri::command]
async fn read_skill(app: tauri::AppHandle, path: String) -> Result<skill::RawSkill, String> {
    let base = app.path().resource_dir().ok();
    let root = skill::resolve_skill_input(&path, base.as_deref());
    skill::build_raw_skill(&root)
}

#[tauri::command]
async fn read_file(root: String, rel: String) -> Result<skill::FileView, String> {
    skill::read_file_impl(&root, &rel)
}

#[tauri::command]
async fn write_file(root: String, rel: String, content: String) -> Result<(), String> {
    skill::write_file_impl(&root, &rel, &content)
}

#[tauri::command]
async fn read_image_base64(root: String, rel: String) -> Result<skill::ImageData, String> {
    skill::read_image_impl(&root, &rel)
}

#[tauri::command]
async fn discover_skills() -> Result<Vec<discover::AgentSkills>, String> {
    discover::discover_all()
}

#[tauri::command]
async fn pick_skill_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(app.dialog().file().blocking_pick_folder().map(|p| p.to_string()))
}

#[tauri::command]
async fn export_skill_zip(app: tauri::AppHandle, root: String, env_vars: Vec<String>) -> Result<bool, String> {
    let (filename, buf) = skill::zip_skill_bytes(&root, &env_vars)?;
    let chosen = app
        .dialog()
        .file()
        .set_file_name(filename)
        .add_filter("Zip archive", &["zip"])
        .blocking_save_file();
    let Some(dest) = chosen else {
        return Ok(false);
    };
    std::fs::write(std::path::PathBuf::from(dest.to_string()), buf).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn pick_zip_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(app
        .dialog()
        .file()
        .add_filter("Zip archive", &["zip"])
        .blocking_pick_file()
        .map(|p| p.to_string()))
}

#[tauri::command]
async fn import_skill_folder(source: String, target: String, overwrite: bool) -> Result<sync::ImportResult, String> {
    sync::import_skill_folder(&source, &target, overwrite)
}

#[tauri::command]
async fn import_skill_zip(path: String, target: String, overwrite: bool) -> Result<sync::ImportResult, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    sync::import_skill_zip(&bytes, &target, overwrite)
}

#[tauri::command]
async fn detect_required_env(root: String) -> Result<Vec<String>, String> {
    let candidates = secrets::secret_keys()?;
    Ok(skill::scan_for_env_vars(std::path::Path::new(&root), &candidates))
}

#[tauri::command]
async fn sync_targets(root: String) -> Result<Vec<sync::SyncTarget>, String> {
    sync::sync_targets(&root)
}

#[tauri::command]
async fn sync_skill(root: String, target: String, overwrite: bool, link: bool) -> Result<sync::SyncResult, String> {
    sync::sync_skill(&root, &target, overwrite, link)
}

#[tauri::command]
async fn delete_skill(root: String) -> Result<sync::DeleteResult, String> {
    sync::delete_skill(&root)
}

#[tauri::command]
async fn skill_homes() -> Result<Vec<sync::SkillHome>, String> {
    sync::skill_homes()
}

#[tauri::command]
async fn create_skill(target: String, name: String, content: String) -> Result<String, String> {
    sync::create_skill(&target, &name, &content)
}

#[tauri::command]
async fn git_info(root: String) -> Result<gitops::GitInfo, String> {
    gitops::git_info(&root)
}

#[tauri::command]
async fn git_init(root: String) -> Result<gitops::GitInfo, String> {
    gitops::git_init(&root)
}

#[tauri::command]
async fn git_commit(root: String, message: String) -> Result<gitops::CommitResult, String> {
    gitops::git_commit(&root, &message)
}

#[tauri::command]
async fn git_log(root: String, limit: usize) -> Result<Vec<gitops::Commit>, String> {
    gitops::git_log(&root, limit)
}

#[tauri::command]
async fn secrets_status() -> Result<secrets::SecretsStatus, String> {
    secrets::secrets_status()
}

#[tauri::command]
async fn secrets_list() -> Result<Vec<secrets::SecretEntry>, String> {
    secrets::secrets_list()
}

#[tauri::command]
async fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::secret_set(&key, &value)
}

#[tauri::command]
async fn secret_delete(key: String) -> Result<(), String> {
    secrets::secret_delete(&key)
}

#[tauri::command]
async fn secrets_setup(app: tauri::AppHandle) -> Result<secrets::SetupResult, String> {
    let src = app
        .path()
        .resource_dir()
        .ok()
        .map(|r| r.join("skills").join("skill-studio"));
    secrets::secrets_setup(src.as_deref())
}

// ───────────────────────── app-managed agent terminals ─────────────────────────

#[tauri::command]
fn terminal_agents() -> Vec<skill_term::AgentOption> {
    skill_term::detect_agents()
}

#[tauri::command]
fn terminal_list() -> Result<Vec<skill_term::SessionInfo>, String> {
    skill_term::list_sessions()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn terminal_create(
    agent: String,
    cwd: String,
    cols: u16,
    rows: u16,
    ide: bool,
    skip_permissions: bool,
    extra_args: Vec<String>,
) -> Result<skill_term::SessionInfo, String> {
    skill_term::create_session(&agent, &cwd, cols, rows, ide, skip_permissions, &extra_args)
}

#[tauri::command]
fn terminal_kill(id: String) -> Result<(), String> {
    skill_term::kill_session(&id)
}

/// Attach to a session: stream raw PTY output as base64 chunks over `on_event`,
/// and stash the keep-alive handle so write/resize/detach can reach it by id.
#[tauri::command]
fn terminal_attach(
    state: State<'_, TermState>,
    id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<String>,
) -> Result<(), String> {
    let (att, rx) = skill_term::attach(&id, cols, rows)?;
    state
        .atts
        .lock()
        .map_err(|_| "terminal state is unavailable".to_string())?
        .insert(id.clone(), att);
    std::thread::spawn(move || {
        while let Ok(bytes) = rx.recv() {
            if on_event.send(skill_term::b64_encode(&bytes)).is_err() {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn terminal_write(id: String, data: String) -> Result<(), String> {
    skill_term::write(&id, &skill_term::b64_decode(&data))
}

#[tauri::command]
fn terminal_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    skill_term::resize(&id, cols, rows)
}

/// Detach the UI from a session (drops the attach client; the session lives on).
#[tauri::command]
fn terminal_detach(state: State<'_, TermState>, id: String) -> Result<(), String> {
    state
        .atts
        .lock()
        .map_err(|_| "terminal state is unavailable".to_string())?
        .remove(&id);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(TermState::default())
        .invoke_handler(tauri::generate_handler![
            read_skill,
            read_file,
            write_file,
            read_image_base64,
            discover_skills,
            pick_skill_folder,
            pick_zip_file,
            export_skill_zip,
            import_skill_folder,
            import_skill_zip,
            detect_required_env,
            sync_targets,
            sync_skill,
            delete_skill,
            skill_homes,
            create_skill,
            git_info,
            git_init,
            git_commit,
            git_log,
            secrets_status,
            secrets_list,
            secret_set,
            secret_delete,
            secrets_setup,
            terminal_agents,
            terminal_list,
            terminal_create,
            terminal_kill,
            terminal_attach,
            terminal_write,
            terminal_resize,
            terminal_detach,
        ])
        // Reap terminals orphaned by a previous (hard-killed) app process.
        .setup(|_app| {
            skill_term::sweep_orphans();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Closing the desktop app reaps the agents it owns (no zombies).
            if let tauri::RunEvent::Exit = event {
                skill_term::cleanup_owned();
            }
        });
}
