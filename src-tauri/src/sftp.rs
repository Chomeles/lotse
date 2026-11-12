use std::path::Path;

use russh_sftp::client::SftpSession;
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

/// Öffnet den Dateikanal auf einer bestehenden Verbindung.
pub async fn open(handle: &ssh::Handle) -> Result<SftpSession, String> {
    let channel = handle.channel_open_session().await.map_err(text)?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("Der Server bietet kein SFTP an: {e}"))?;
    SftpSession::new(channel.into_stream()).await.map_err(text)
}

/// Listet einen Ordner, Ordner zuerst. `path = None` ist der Startordner des Benutzers.
pub async fn list(sftp: &SftpSession, path: Option<&str>) -> Result<Listing, String> {
    let path = sftp.canonicalize(path.unwrap_or(".")).await.map_err(text)?;
    let mut entries = vec![];
    for entry in sftp.read_dir(path.as_str()).await.map_err(text)? {
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
async fn copy(
    mut from: impl AsyncRead + Unpin,
    mut to: impl AsyncWrite + Unpin,
    total: u64,
    mut progress: impl FnMut(u64, u64),
) -> std::io::Result<()> {
    let mut buf = vec![0; 32 * 1024];
    let mut done = 0;
    loop {
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
    let to = sftp.create(remote).await.map_err(text)?;
    copy(from, to, total, progress).await.map_err(text)
}

pub async fn download(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    let total = sftp.metadata(remote).await.map_err(text)?.size.unwrap_or(0);
    let from = sftp.open(remote).await.map_err(text)?;
    // Erst in eine Nachbardatei laden: bricht es ab, bleibt eine vorhandene Datei gleichen Namens heil.
    let mut part = local.as_os_str().to_owned();
    part.push(".part");
    let part = Path::new(&part);
    let result = async {
        let to = tokio::fs::File::create(part).await?;
        copy(from, to, total, progress).await?;
        tokio::fs::rename(part, local).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(part).await;
    }
    result.map_err(|e| format!("{} nicht schreibbar: {e}", local.display()))
}

pub async fn rename(sftp: &SftpSession, from: &str, to: &str) -> Result<(), String> {
    sftp.rename(from, to).await.map_err(text)
}

pub async fn mkdir(sftp: &SftpSession, path: &str) -> Result<(), String> {
    sftp.create_dir(path).await.map_err(text)
}

pub async fn delete(sftp: &SftpSession, path: &str, is_dir: bool) -> Result<(), String> {
    if is_dir {
        // shortcut: nur leere Ordner, rekursives Löschen bei Bedarf ergänzen
        sftp.remove_dir(path).await.map_err(|e| format!("Ordner nicht gelöscht (nur leere Ordner): {e}"))
    } else {
        sftp.remove_file(path).await.map_err(text)
    }
}
