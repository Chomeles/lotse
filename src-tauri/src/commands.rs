//! Einzige Stelle, die Tauri kennt: nimmt Aufrufe der Oberfläche an und reicht sie an die Module weiter.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use russh_sftp::client::SftpSession;
use tauri::{
    ipc::{Channel, InvokeBody, InvokeResponseBody, Request},
    AppHandle, State,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::sync::OnceCell;

use crate::{
    hosts, keys, known_hosts, paste, sftp,
    ssh::{self, ConnectError},
    store::{self, Host, Store},
    voice,
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
    /// im Arbeitsspeicher, bis Hostess beendet wird. Dauerhaft gespeicherte liegen in `saved`.
    secrets: Mutex<HashMap<String, String>>,
    /// Kennzeichen „abbrechen“ je laufender Übertragung. Die Nummer vergibt die Oberfläche.
    transfers: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    /// Das Sprachmodell im Arbeitsspeicher samt seiner id, damit es nicht bei jeder Aufnahme neu geladen wird.
    voice: Arc<Mutex<Option<(&'static str, voice::WhisperContext)>>>,
    /// Kennzeichen „abbrechen“ je laufendem Modell-Download.
    downloads: Mutex<HashMap<&'static str, Arc<AtomicBool>>>,
    /// Modelle, die sich trotz richtiger Größe nicht laden ließen.
    broken: Arc<Mutex<HashSet<&'static str>>>,
}

impl App {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            conns: Arc::default(),
            next_id: AtomicU32::new(1),
            secrets: Mutex::default(),
            transfers: Mutex::default(),
            voice: Arc::default(),
            downloads: Mutex::default(),
            broken: Arc::default(),
        }
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

    /// Ordner der heruntergeladenen Sprachmodelle.
    fn models(&self) -> PathBuf {
        self.dir.join("models")
    }
}

fn text(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Der Ordner mit SSH-Config und Schlüsseln. HOSTESS_SSH_DIR lenkt ihn um (für Tests, damit `~/.ssh` unberührt bleibt).
fn ssh_dir() -> Result<PathBuf, String> {
    match std::env::var_os("HOSTESS_SSH_DIR") {
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

/// Dauerhaft gespeichertes Geheimnis: ein Eintrag „Hostess“ in der Windows-Anmeldeinformationsverwaltung,
/// verschlüsselt mit dem Windows-Konto. In `store.json` steht nie ein Geheimnis.
fn saved(slot: &str) -> Option<keyring::Entry> {
    keyring::Entry::new("Hostess", slot).ok()
}

/// Liest das gespeicherte Geheimnis. Bis 0.4.0 hieß der Eintrag „Lotse“: ein solcher zieht beim ersten Lesen um.
fn saved_secret(slot: &str) -> Option<String> {
    let entry = saved(slot)?;
    entry.get_password().ok().or_else(|| {
        let old = keyring::Entry::new("Lotse", slot).ok()?;
        let secret = old.get_password().ok()?;
        entry.set_password(&secret).ok()?;
        let _ = old.delete_credential();
        Some(secret)
    })
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
    // Ohne Eingabe das gemerkte oder gespeicherte Geheimnis probieren, damit Hostess nicht unnötig nachfragt.
    let typed = secret.is_some();
    let slot = secret_slot(&host);
    let secret = secret
        .or_else(|| app.secrets.lock().unwrap().get(&slot).cloned())
        .or_else(|| saved_secret(&slot));
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
            // Klappt das Speichern nicht, läuft die Verbindung trotzdem; Hostess fragt dann beim nächsten Start wieder.
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

/// Antwortzeit der Verbindung in Millisekunden: eine Keepalive-Anfrage, die jeder Server beantwortet.
#[tauri::command]
pub async fn ssh_ping(app: State<'_, App>, id: u32) -> Result<u32, String> {
    let conn = app.conn(id)?;
    let start = Instant::now();
    tokio::time::timeout(Duration::from_secs(5), conn.handle.send_ping())
        .await
        .map_err(|_| "keine Antwort")?
        .map_err(text)?;
    // russh meldet auch dann Erfolg, wenn die Verbindung beim Warten abgerissen ist.
    if conn.handle.is_closed() {
        return Err("keine Antwort".into());
    }
    Ok(start.elapsed().as_millis() as u32)
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

#[tauri::command]
pub fn voice_models(app: State<'_, App>) -> Vec<voice::ModelInfo> {
    let mut models = voice::list(&app.models());
    let (downloads, broken) = (app.downloads.lock().unwrap(), app.broken.lock().unwrap());
    for model in &mut models {
        model.downloading = downloads.contains_key(model.id);
        model.installed &= !broken.contains(model.id);
    }
    models
}

/// Lädt ein Sprachmodell herunter oder setzt den angefangenen Download fort. Liefert `false`, wenn mit
/// `voice_cancel` abgebrochen wurde. Den Stand zeigt `voice_models`.
#[tauri::command]
pub async fn voice_download(app: State<'_, App>, id: String) -> Result<bool, String> {
    let model = voice::find(&id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut downloads = app.downloads.lock().unwrap();
        if downloads.contains_key(model.id) {
            return Err("Dieses Modell wird schon heruntergeladen.".into());
        }
        downloads.insert(model.id, cancel.clone());
    }
    let dir = app.models();
    let result = tauri::async_runtime::spawn_blocking(move || voice::download(&dir, model, &cancel)).await;
    app.downloads.lock().unwrap().remove(model.id);
    let done = result.map_err(text)??;
    if done {
        app.broken.lock().unwrap().remove(model.id);
    }
    Ok(done)
}

#[tauri::command]
pub fn voice_cancel(app: State<'_, App>, id: String) {
    if let Some(cancel) = app.downloads.lock().unwrap().get(id.as_str()) {
        cancel.store(true, Ordering::Relaxed);
    }
}

/// Löscht das Modell von der Platte und aus dem Arbeitsspeicher, samt einem angefangenen Download.
#[tauri::command]
pub fn voice_delete(app: State<'_, App>, id: String) -> Result<(), String> {
    let model = voice::find(&id)?;
    if app.downloads.lock().unwrap().contains_key(model.id) {
        return Err("Der Download läuft noch. Brich ihn zuerst ab.".into());
    }
    // Der Platz ist belegt, solange eine Erkennung läuft.
    let mut loaded = app.voice.try_lock().map_err(|_| "Das Modell wird gerade benutzt.")?;
    if loaded.as_ref().is_some_and(|(loaded, _)| *loaded == model.id) {
        *loaded = None;
    }
    voice::delete(&app.models(), model)?;
    app.broken.lock().unwrap().remove(model.id);
    Ok(())
}

/// Führt `job` mit dem Modell `id` aus und lädt es vorher, wenn ein anderes oder keins im Arbeitsspeicher liegt.
/// Dort liegt immer nur ein Modell. Eine laufende Erkennung wird mit ihrem Modell fertig, erst dann wird getauscht.
async fn with_voice<T: Send + 'static>(
    app: &App,
    id: &str,
    job: impl FnOnce(&voice::WhisperContext) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let model = voice::find(id)?;
    let (dir, slot, broken) = (app.models(), app.voice.clone(), app.broken.clone());
    // Laden und Erkennen dauern Sekunden, also nicht auf dem Netzwerk-Thread.
    tauri::async_runtime::spawn_blocking(move || {
        let mut loaded = slot.lock().unwrap();
        if !loaded.as_ref().is_some_and(|(loaded, _)| *loaded == model.id) {
            *loaded = None;
            if !voice::installed(&dir, model) {
                return Err("Das gewählte Sprachmodell ist nicht installiert.".to_string());
            }
            match voice::load(&dir.join(model.file)) {
                Ok(context) => *loaded = Some((model.id, context)),
                Err(e) => {
                    // Richtige Größe, aber nicht ladbar: gilt als nicht installiert, bis es neu geladen oder gelöscht ist.
                    broken.lock().unwrap().insert(model.id);
                    return Err(e);
                }
            }
        }
        job(&loaded.as_ref().unwrap().1)
    })
    .await
    .map_err(text)?
}

/// Lädt das Modell schon in den Arbeitsspeicher, damit die erste Erkennung nicht darauf warten muss.
#[tauri::command]
pub async fn voice_preload(app: State<'_, App>, id: String) -> Result<(), String> {
    with_voice(&app, &id, |_| Ok(())).await
}

/// Wandelt eine Aufnahme in Text. Der Körper der Anfrage sind die rohen Samples (Float32, Little Endian,
/// 16 kHz, mono), die id des Modells steht im Kopf `model`. Leerer Text heißt: nichts Gesprochenes erkannt.
#[tauri::command]
pub async fn voice_transcribe(app: State<'_, App>, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Die Aufnahme kam nicht an.".into());
    };
    let id = request.headers().get("model").and_then(|id| id.to_str().ok()).unwrap_or_default();
    let samples: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    with_voice(&app, id, move |context| voice::transcribe(context, &samples)).await
}
