pub mod git;

#[cfg(feature = "desktop")]
mod commands;

#[cfg(feature = "desktop")]
pub fn run() {
    use tauri::Manager;

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            commands::runtime_info,
            commands::repository_snapshot,
            commands::commit_details,
            commands::file_diff,
            commands::git_action,
            commands::create_repository,
            commands::choose_directory,
            commands::cancel_git_operation,
            commands::open_resource,
        ])
        .build(tauri::generate_context!())
        .expect("GitK failed to start")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if let Some(engine) = app.state::<commands::DesktopState>().begin_shutdown() {
                    api.prevent_exit();
                    let app = app.clone();
                    // Let the process runner reap Git and its children before
                    // the desktop runtime exits. Queued jobs are invalidated.
                    tauri::async_runtime::spawn_blocking(move || {
                        let _guard = engine.lock();
                        app.exit(0);
                    });
                }
            }
        });
}
