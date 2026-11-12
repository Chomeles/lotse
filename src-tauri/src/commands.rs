//! Einzige Stelle, die Tauri kennt: nimmt Aufrufe der Oberfläche an und reicht sie an die Module weiter.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
};

use russh_sftp::client::SftpSession;
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    State,
};
use tokio::sync::OnceCell;

use crate::{
    hosts, known_hosts, sftp,
    ssh::{self, ConnectError},
    store::{self, Host, Store},
};

struct Conn {
    handle: ssh::Handle,
    shell: ssh::ShellWriter,
    sftp: OnceCell<SftpSession>,
}

impl Conn {
    /// Der Dateikanal wird erst beim ersten Gebrauch geöffnet.
    async fn sftp(&self) -> Result<&SftpSession, String> {
        self.sftp.get_or_try_init(|| sftp::open(&self.handle)).await
    }
}

pub struct App {
    dir: PathBuf,
    conns: Arc<Mutex<HashMap<u32, Arc<Conn>>>>,
    next_id: AtomicU32,
}

impl App {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, conns: Arc::default(), next_id: AtomicU32::new(1) }
    }

    fn conn(&self, id: u32) -> Result<Arc<Conn>, String> {
        let conns = self.conns.lock().unwrap();
        conns.get(&id).cloned().ok_or_else(|| "Die Verbindung besteht nicht mehr.".to_string())
    }

    fn known_hosts(&self) -> PathBuf {
        self.dir.join("known_hosts")
    }

    fn store(&self) -> PathBuf {
        self.dir.join("store.json")
    }
}

fn text(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn ssh_connect(
    app: State<'_, App>,
    host: Host,
    passphrase: Option<String>,
    trust: Option<String>,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, ConnectError> {
    let handle = ssh::connect(&host, passphrase.as_deref(), trust, app.known_hosts()).await?;
    let (reader, shell) = ssh::open_shell(&handle, cols, rows)
        .await
        .map_err(|e| ConnectError::Other { message: format!("Die Shell ließ sich nicht öffnen: {e}") })?;

    let id = app.next_id.fetch_add(1, Ordering::Relaxed);
    app.conns.lock().unwrap().insert(id, Arc::new(Conn { handle, shell, sftp: OnceCell::new() }));
    let conns = app.conns.clone();
    tauri::async_runtime::spawn(async move {
        ssh::pump(reader, |data| {
            let _ = on_data.send(InvokeResponseBody::Raw(data.to_vec()));
        })
        .await;
        conns.lock().unwrap().remove(&id);
        let _ = on_data.send(InvokeResponseBody::Json(r#"{"closed":true}"#.into()));
    });
    Ok(id)
}

#[tauri::command]
pub async fn ssh_write(app: State<'_, App>, id: u32, data: String) -> Result<(), String> {
    app.conn(id)?.shell.data(data.as_bytes()).await.map_err(text)
}

#[tauri::command]
pub async fn ssh_resize(app: State<'_, App>, id: u32, cols: u32, rows: u32) -> Result<(), String> {
    app.conn(id)?.shell.window_change(cols, rows, 0, 0).await.map_err(text)
}

#[tauri::command]
pub async fn ssh_disconnect(app: State<'_, App>, id: u32) -> Result<(), String> {
    let conn = app.conns.lock().unwrap().remove(&id);
    if let Some(conn) = conn {
        let _ = conn.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
    }
    Ok(())
}

#[tauri::command]
pub fn known_host_remove(app: State<'_, App>, address: String, port: u16) -> Result<(), String> {
    known_hosts::remove(&app.known_hosts(), &address, port).map_err(text)
}

#[tauri::command]
pub fn store_load(app: State<'_, App>) -> Result<Store, String> {
    store::load(&app.store())
}

#[tauri::command]
pub fn store_save(app: State<'_, App>, store: Store) -> Result<(), String> {
    store::save(&app.store(), &store)
}

/// Liefert die Hosts aus `~/.ssh/config`, die es unter den Namen in `existing` noch nicht gibt.
#[tauri::command]
pub fn hosts_import(existing: Vec<String>) -> Result<Vec<Host>, String> {
    let path = std::env::home_dir().ok_or("Kein Benutzerordner gefunden.")?.join(".ssh").join("config");
    let file = std::fs::File::open(&path).map_err(|e| format!("{} nicht lesbar: {e}", path.display()))?;
    hosts::import(&mut std::io::BufReader::new(file), &existing)
}

#[tauri::command]
pub async fn sftp_list(app: State<'_, App>, id: u32, path: Option<String>) -> Result<sftp::Listing, String> {
    sftp::list(app.conn(id)?.sftp().await?, path.as_deref()).await
}

/// Meldet den Fortschritt nur, wenn sich die Prozentzahl ändert.
fn percent(on_progress: Channel<u8>) -> impl FnMut(u64, u64) {
    let mut last = u8::MAX;
    move |done, total| {
        let now = done.saturating_mul(100).checked_div(total).unwrap_or(100) as u8;
        if now != last {
            last = now;
            let _ = on_progress.send(now);
        }
    }
}

#[tauri::command]
pub async fn sftp_upload(
    app: State<'_, App>,
    id: u32,
    local: PathBuf,
    remote: String,
    on_progress: Channel<u8>,
) -> Result<(), String> {
    sftp::upload(app.conn(id)?.sftp().await?, &local, &remote, percent(on_progress)).await
}

#[tauri::command]
pub async fn sftp_download(
    app: State<'_, App>,
    id: u32,
    remote: String,
    local: PathBuf,
    on_progress: Channel<u8>,
) -> Result<(), String> {
    sftp::download(app.conn(id)?.sftp().await?, &remote, &local, percent(on_progress)).await
}

#[tauri::command]
pub async fn sftp_rename(app: State<'_, App>, id: u32, from: String, to: String) -> Result<(), String> {
    sftp::rename(app.conn(id)?.sftp().await?, &from, &to).await
}

#[tauri::command]
pub async fn sftp_mkdir(app: State<'_, App>, id: u32, path: String) -> Result<(), String> {
    sftp::mkdir(app.conn(id)?.sftp().await?, &path).await
}

#[tauri::command]
pub async fn sftp_delete(app: State<'_, App>, id: u32, path: String, is_dir: bool) -> Result<(), String> {
    // Immer der kürzeste Weg: Datei und leerer Ordner sind je eine SFTP-Anfrage (geht auf jedem Server),
    // ein voller Ordner ist ein einziger Befehl statt einer Anfrage je Datei.
    let conn = app.conn(id)?;
    let sftp = conn.sftp().await?;
    if !is_dir {
        sftp::delete_file(sftp, &path).await
    } else if sftp::delete_empty_dir(sftp, &path).await.is_ok() {
        Ok(())
    } else {
        ssh::remove_tree(&conn.handle, &path).await
    }
}
