mod commands;
pub mod hosts;
pub mod known_hosts;
pub mod sftp;
pub mod ssh;
pub mod store;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // LOTSE_DATA_DIR lenkt den Datenordner um (für Tests, damit echte Hosts unberührt bleiben).
            let dir = match std::env::var_os("LOTSE_DATA_DIR") {
                Some(dir) => dir.into(),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&dir)?;
            app.manage(commands::App::new(dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_disconnect,
            commands::known_host_remove,
            commands::store_load,
            commands::store_save,
            commands::hosts_import,
            commands::sftp_list,
            commands::sftp_upload,
            commands::sftp_download,
            commands::sftp_rename,
            commands::sftp_mkdir,
            commands::sftp_delete,
        ])
        .run(tauri::generate_context!())
        .expect("Fenster konnte nicht starten");
}
