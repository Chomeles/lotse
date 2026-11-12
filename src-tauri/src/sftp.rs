use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

use russh_sftp::{
    client::{error::Error, SftpSession},
    protocol::StatusCode,
};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::ssh;

#[derive(Debug, Serialize)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// Sekunden seit 1970, 0 wenn der Server nichts meldet.
    pub modified: u32,
}

#[derive(Debug, Serialize)]
pub struct Listing {
    pub path: String,
    pub entries: Vec<Entry>,
}

fn text(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Übersetzt die häufigen Antworten des Servers in verständliche Sätze.
pub(crate) fn refused(e: Error) -> String {
    match &e {
        Error::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => "Die Datei oder den Ordner gibt es nicht.".into(),
            StatusCode::PermissionDenied => "Dafür fehlt dem Benutzer die Berechtigung.".into(),
            StatusCode::Failure => "Der Server hat den Vorgang abgelehnt.".into(),
            _ => e.to_string(),
        },
        Error::Timeout => "Der Server antwortet nicht.".into(),
        _ => e.to_string(),
    }
}

/// Öffnet den Dateikanal auf einer bestehenden Verbindung.
pub async fn open(handle: &ssh::Handle) -> Result<SftpSession, String> {
    let channel = handle.channel_open_session().await.map_err(text)?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("Der Server bietet kein SFTP an: {e}"))?;
    SftpSession::new(channel.into_stream()).await.map_err(refused)
}

/// Listet einen Ordner, Ordner zuerst. `path = None` ist der Startordner des Benutzers.
pub async fn list(sftp: &SftpSession, path: Option<&str>) -> Result<Listing, String> {
    // `~` meint den Startordner: SFTP beginnt dort, also reicht der Rest als relativer Pfad.
    let path = match path {
        None | Some("~") => ".",
        Some(path) => path.strip_prefix("~/").unwrap_or(path),
    };
    let path = sftp.canonicalize(path).await.map_err(refused)?;
    let mut entries = vec![];
    for entry in sftp.read_dir(path.as_str()).await.map_err(refused)? {
        let meta = entry.metadata();
        // Bei Verknüpfungen zählt das Ziel, damit verlinkte Ordner begehbar sind.
        let is_dir = if meta.is_symlink() {
            sftp.metadata(entry.path()).await.is_ok_and(|target| target.is_dir())
        } else {
            meta.is_dir()
        };
        entries.push(Entry {
            name: entry.file_name(),
            is_dir,
            size: meta.size.unwrap_or(0),
            modified: meta.mtime.unwrap_or(0),
        });
    }
    entries.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));
    Ok(Listing { path, entries })
}

// shortcut: ein Block nach dem anderen, bei sehr großen Dateien langsam; dann parallele Anfragen ergänzen
/// `cancel` wird zwischen den Blöcken geprüft; ist es gesetzt, endet die Schleife mit `ErrorKind::Interrupted`.
pub(crate) async fn copy(
    mut from: impl AsyncRead + Unpin,
    mut to: impl AsyncWrite + Unpin,
    total: u64,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> std::io::Result<()> {
    let mut buf = vec![0; 32 * 1024];
    let mut done = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            // Erst schließen, damit der Aufrufer die halbe Datei gleich löschen kann.
            let _ = to.shutdown().await;
            return Err(std::io::ErrorKind::Interrupted.into());
        }
        let n = from.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        to.write_all(&buf[..n]).await?;
        done += n as u64;
        progress(done, total);
    }
    to.shutdown().await
}

pub async fn upload(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    let from = tokio::fs::File::open(local).await.map_err(|e| format!("{} nicht lesbar: {e}", local.display()))?;
    let total = from.metadata().await.map_err(text)?.len();
    let to = sftp.create(remote).await.map_err(refused)?;
    copy(from, to, total, &AtomicBool::new(false), progress).await.map_err(text)
}

pub async fn download(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    let total = sftp.metadata(remote).await.map_err(refused)?.size.unwrap_or(0);
    let from = sftp.open(remote).await.map_err(refused)?;
    // Erst in eine Nachbardatei laden: bricht es ab, bleibt eine vorhandene Datei gleichen Namens heil.
    let mut part = local.as_os_str().to_owned();
    part.push(".part");
    let part = Path::new(&part);
    let result = async {
        let to = tokio::fs::File::create(part).await?;
        copy(from, to, total, &AtomicBool::new(false), progress).await?;
        tokio::fs::rename(part, local).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(part).await;
    }
    result.map_err(|e| format!("{} nicht schreibbar: {e}", local.display()))
}

pub async fn rename(sftp: &SftpSession, from: &str, to: &str) -> Result<(), String> {
    sftp.rename(from, to).await.map_err(refused)
}

pub async fn mkdir(sftp: &SftpSession, path: &str) -> Result<(), String> {
    sftp.create_dir(path).await.map_err(refused)
}

pub async fn delete_file(sftp: &SftpSession, path: &str) -> Result<(), String> {
    sftp.remove_file(path).await.map_err(refused)
}

/// Löscht einen leeren Ordner. Volle Ordner lehnt der Server ab, die löscht `ssh::remove_tree`.
pub async fn delete_empty_dir(sftp: &SftpSession, path: &str) -> Result<(), String> {
    sftp.remove_dir(path).await.map_err(refused)
}
