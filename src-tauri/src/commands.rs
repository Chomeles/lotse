//! Einzige Stelle, die Tauri kennt: nimmt Aufrufe der Oberfläche an und reicht sie an die Module weiter.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
};

use russh_sftp::client::SftpSession;
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, State,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::sync::OnceCell;

use crate::{
    hosts, keys, known_hosts, paste, sftp,
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
    /// Passphrasen je Schlüsseldatei und Passwörter je Benutzer und Server (siehe `secret_slot`),
    /// im Arbeitsspeicher, bis Lotse beendet wird. Dauerhaft gespeicherte liegen in `saved`.
    secrets: Mutex<HashMap<String, String>>,
    /// Kennzeichen „abbrechen“ je laufender Übertragung. Die Nummer vergibt die Oberfläche.
    transfers: Mutex<HashMap<u32, Arc<AtomicBool>>>,
}

impl App {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, conns: Arc::default(), next_id: AtomicU32::new(1), secrets: Mutex::default(), transfers: Mutex::default() }
    }

    fn conn(&self, id: u32) -> Result<Arc<Conn>, String> {
        let conns = self.conns.lock().unwrap();
        conns.get(&id).cloned().ok_or_else(|| "Die Verbindung besteht nicht mehr.".to_string())
    }

    /// Das Kennzeichen entsteht beim Start oder beim Abbrechen, je nachdem, was zuerst ankommt.
    fn transfer(&self, transfer: u32) -> Arc<AtomicBool> {
        self.transfers.lock().unwrap().entry(transfer).or_default().clone()
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

/// Der Ordner mit SSH-Config und Schlüsseln. LOTSE_SSH_DIR lenkt ihn um (für Tests, damit `~/.ssh` unberührt bleibt).
fn ssh_dir() -> Result<PathBuf, String> {
    match std::env::var_os("LOTSE_SSH_DIR") {
        Some(dir) => Ok(dir.into()),
        None => Ok(std::env::home_dir().ok_or("Kein Benutzerordner gefunden.")?.join(".ssh")),
    }
}

/// Unter diesem Namen wird das Geheimnis eines Hosts gemerkt.
fn secret_slot(host: &Host) -> String {
    if host.key_path.is_empty() {
        format!("{}@{}:{}", host.user, host.address, host.port)
    } else {
        host.key_path.clone()
    }
}

/// Dauerhaft gespeichertes Geheimnis: ein Eintrag „Lotse“ in der Windows-Anmeldeinformationsverwaltung,
/// verschlüsselt mit dem Windows-Konto. In `store.json` steht nie ein Geheimnis.
fn saved(slot: &str) -> Option<keyring::Entry> {
    keyring::Entry::new("Lotse", slot).ok()
}

#[tauri::command]
pub async fn ssh_connect(
    app: State<'_, App>,
    host: Host,
    secret: Option<String>,
    remember: bool,
    trust: Option<String>,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, ConnectError> {
    // Ohne Eingabe das gemerkte oder gespeicherte Geheimnis probieren, damit Lotse nicht unnötig nachfragt.
    let typed = secret.is_some();
    let slot = secret_slot(&host);
    let secret = secret
        .or_else(|| app.secrets.lock().unwrap().get(&slot).cloned())
        .or_else(|| saved(&slot)?.get_password().ok());
    // Stimmt das gemerkte Geheimnis nicht mehr, wird es überall verworfen.
    let forget = || {
        app.secrets.lock().unwrap().remove(&slot);
        if let Some(entry) = saved(&slot) {
            let _ = entry.delete_credential();
        }
    };
    let handle = match ssh::connect(&host, secret.as_deref(), trust, app.known_hosts()).await {
        Ok(handle) => handle,
        // Das gemerkte Geheimnis stimmt nicht mehr: verwerfen und neu fragen, ohne „war falsch“.
        Err(ConnectError::NeedPassphrase { .. }) if !typed => {
            forget();
            return Err(ConnectError::NeedPassphrase { wrong: false });
        }
        Err(ConnectError::NeedPassword { .. }) if !typed => {
            forget();
            return Err(ConnectError::NeedPassword { wrong: false });
        }
        Err(e) => return Err(e),
    };
    if let Some(secret) = secret {
        if remember {
            // Klappt das Speichern nicht, läuft die Verbindung trotzdem; Lotse fragt dann beim nächsten Start wieder.
            if let Some(entry) = saved(&slot) {
                let _ = entry.set_password(&secret);
            }
        }
        app.secrets.lock().unwrap().insert(slot, secret);
    }
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
pub fn known_hosts_list(app: State<'_, App>) -> Result<Vec<known_hosts::Entry>, String> {
    known_hosts::list(&app.known_hosts()).map_err(|e| format!("Known-Hosts-Datei nicht lesbar: {e}"))
}

/// Schlüssel aus `~/.ssh` und die Schlüsseldateien der übergebenen Hosts.
#[tauri::command]
pub fn keys_list(hosts: Vec<Host>) -> Result<Vec<keys::KeyInfo>, String> {
    let used: Vec<_> = hosts
        .into_iter()
        .filter(|host| !host.key_path.is_empty())
        .map(|host| (host.name, ssh::expand_home(&host.key_path)))
        .collect();
    Ok(keys::list(&ssh_dir()?, &used))
}

#[tauri::command]
pub fn key_public(path: PathBuf) -> Result<String, String> {
    keys::public_key(&path)
}

/// Liefert den Pfad des neuen privaten Schlüssels.
#[tauri::command]
pub fn key_generate(name: String, passphrase: Option<String>) -> Result<PathBuf, String> {
    keys::generate(&ssh_dir()?, name.trim(), passphrase.as_deref())
}

#[tauri::command]
pub fn key_delete(path: PathBuf) -> Result<(), String> {
    keys::delete(&path)
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
pub fn hosts_import(existing: Vec<String>) -> Result<hosts::Import, String> {
    let ssh_dir = ssh_dir()?;
    let path = ssh_dir.join("config");
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("Es gibt keine SSH-Config unter {}.", path.display()))
        }
        Err(e) => return Err(format!("{} nicht lesbar: {e}", path.display())),
    };
    let default_key = ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|name| ssh_dir.join(name))
        .find(|key| key.exists())
        .map(|key| key.to_string_lossy().into_owned())
        .unwrap_or_default();
    hosts::import(&mut std::io::BufReader::new(file), &existing, &default_key)
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

/// Lädt eine lokale Datei in den Einfüge-Ordner und liefert ihren Pfad auf dem Server als Text fürs Terminal.
#[tauri::command]
pub async fn paste_file(
    app: State<'_, App>,
    id: u32,
    transfer: u32,
    local: PathBuf,
    dir: String,
    on_progress: Channel<u8>,
) -> Result<String, String> {
    let cancel = app.transfer(transfer);
    let result = async {
        let conn = app.conn(id)?;
        paste::upload_file(conn.sftp().await?, &dir, &local, &cancel, percent(on_progress)).await
    }
    .await;
    app.transfers.lock().unwrap().remove(&transfer);
    result.map(|path| paste::shell_word(&path))
}

/// Wie `paste_file`, aber mit dem Bild aus der Zwischenablage. `None`, wenn dort kein Bild liegt.
#[tauri::command]
pub async fn paste_image(
    app: State<'_, App>,
    handle: AppHandle,
    id: u32,
    transfer: u32,
    dir: String,
    name: String,
    on_progress: Channel<u8>,
) -> Result<Option<String>, String> {
    // Lesen und Kodieren dauern bei großen Bildschirmfotos spürbar, also nicht auf dem Netzwerk-Thread.
    let png = tauri::async_runtime::spawn_blocking(move || {
        let image = handle.clipboard().read_image().ok()?;
        Some(paste::encode_png(image.rgba(), image.width(), image.height()))
    })
    .await
    .map_err(text)?;
    let Some(png) = png else { return Ok(None) };
    let png = png?;
    let cancel = app.transfer(transfer);
    let result = async {
        let conn = app.conn(id)?;
        paste::upload_bytes(conn.sftp().await?, &dir, &name, &png, &cancel, percent(on_progress)).await
    }
    .await;
    app.transfers.lock().unwrap().remove(&transfer);
    result.map(|path| Some(paste::shell_word(&path)))
}

#[tauri::command]
pub fn transfer_cancel(app: State<'_, App>, transfer: u32) {
    app.transfer(transfer).store(true, Ordering::Relaxed);
}
