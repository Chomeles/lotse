mod commands;
pub mod hosts;
pub mod keys;
pub mod known_hosts;
pub mod paste;
pub mod sftp;
pub mod ssh;
pub mod store;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // HOSTESS_DATA_DIR lenkt den Datenordner um (für Tests, damit echte Hosts unberührt bleiben).
            let dir = match std::env::var_os("HOSTESS_DATA_DIR") {
                Some(dir) => dir.into(),
                None => {
                    let dir = app.path().app_data_dir()?;
                    // Bis 0.4.0 hieß das Programm „Lotse“: dessen Datenordner zieht einmalig um.
                    let old = dir.with_file_name("de.lotse.client");
                    if !dir.exists() && old.exists() {
                        std::fs::rename(old, &dir)?;
                    }
                    dir
                }
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
            commands::ssh_ping,
            commands::known_host_remove,
            commands::known_hosts_list,
            commands::keys_list,
            commands::key_public,
            commands::key_generate,
            commands::key_delete,
            commands::store_load,
            commands::store_save,
            commands::hosts_import,
            commands::sftp_list,
            commands::sftp_upload,
            commands::sftp_download,
            commands::sftp_rename,
            commands::sftp_mkdir,
            commands::sftp_delete,
            commands::paste_file,
            commands::paste_image,
            commands::transfer_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("Fenster konnte nicht starten");
}
