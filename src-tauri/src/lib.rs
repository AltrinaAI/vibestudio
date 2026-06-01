// Tauri desktop app: thin #[tauri::command] wrappers over skill-core.
use skill_core::{discover, gitops, secrets, skill, sync};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_skill,
            read_file,
            write_file,
            read_image_base64,
            discover_skills,
            pick_skill_folder,
            export_skill_zip,
            detect_required_env,
            sync_targets,
            sync_skill,
            delete_skill,
            git_info,
            git_init,
            git_commit,
            git_log,
            secrets_status,
            secrets_list,
            secret_set,
            secret_delete,
            secrets_setup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
