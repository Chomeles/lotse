//! Datei oder Bild in einen Ordner auf dem Server legen und den fertigen Pfad liefern,
//! damit die Oberfläche ihn ins Terminal schreiben kann.

use std::{io::ErrorKind, path::Path, sync::atomic::AtomicBool};

use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use tokio::io::AsyncRead;

use crate::{
    sftp::{copy, refused},
    ssh::quote,
};

/// Lädt eine lokale Datei unter ihrem Namen nach `dir` und liefert den absoluten Pfad auf dem Server.
pub async fn upload_file(
    sftp: &SftpSession,
    dir: &str,
    local: &Path,
    cancel: &AtomicBool,
    progress: impl FnMut(u64, u64),
) -> Result<String, String> {
    let unreadable = |e| format!("{} nicht lesbar: {e}", local.display());
    let meta = tokio::fs::metadata(local).await.map_err(unreadable)?;
    if meta.is_dir() {
        return Err("Ordner werden noch nicht übertragen.".into());
    }
    let name = local.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let from = tokio::fs::File::open(local).await.map_err(unreadable)?;
    store(sftp, dir, &name, from, meta.len(), cancel, progress).await
}

/// Wie `upload_file`, aber mit Bytes aus dem Arbeitsspeicher (Bild aus der Zwischenablage).
pub async fn upload_bytes(
    sftp: &SftpSession,
    dir: &str,
    name: &str,
    bytes: &[u8],
    cancel: &AtomicBool,
    progress: impl FnMut(u64, u64),
) -> Result<String, String> {
    store(sftp, dir, name, bytes, bytes.len() as u64, cancel, progress).await
}

async fn store(
    sftp: &SftpSession,
    dir: &str,
    name: &str,
    from: impl AsyncRead + Unpin,
    total: u64,
    cancel: &AtomicBool,
    progress: impl FnMut(u64, u64),
) -> Result<String, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(format!("„{name}“ ist kein gültiger Dateiname."));
    }
    let dir = make_dir(sftp, dir).await?;
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    };
    // Ersten freien Namen suchen: name, name-2, name-3 … Nie etwas überschreiben.
    let mut n = 1;
    let (path, part, to) = loop {
        let path = if n == 1 { format!("{dir}/{name}") } else { format!("{dir}/{stem}-{n}{ext}") };
        n += 1;
        if sftp.metadata(path.as_str()).await.is_ok() {
            continue;
        }
        // Erst als .part hochladen: der fertige Name zeigt nie auf eine halbe Datei.
        // EXCLUDE lässt den Server ablehnen, wenn gerade ein anderer Upload denselben Namen belegt hat.
        let part = format!("{path}.part");
        let flags = OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE;
        match sftp.open_with_flags(part.as_str(), flags).await {
            Ok(to) => break (path, part, to),
            Err(_) if sftp.metadata(part.as_str()).await.is_ok() => continue,
            Err(e) => return Err(format!("In {dir} lässt sich keine Datei anlegen: {}", refused(e))),
        }
    };
    let result = match copy(from, to, total, cancel, progress).await {
        // SFTP-Umbenennen schlägt fehl, wenn es das Ziel inzwischen doch gibt; überschrieben wird also auch hier nichts.
        Ok(()) => sftp.rename(part.as_str(), path.as_str()).await.map_err(refused),
        Err(e) if e.kind() == ErrorKind::Interrupted => Err("Abgebrochen.".into()),
        Err(e) => Err(format!("Übertragung fehlgeschlagen: {e}")),
    };
    if let Err(e) = result {
        // Reißt die Verbindung ab, geht auch das nicht mehr; dann bleibt die .part-Datei auf dem Server liegen.
        let _ = sftp.remove_file(part).await;
        return Err(e);
    }
    Ok(path)
}

/// Legt den Zielordner an, falls er fehlt, und liefert seinen absoluten Pfad. `~/` meint den Startordner.
async fn make_dir(sftp: &SftpSession, dir: &str) -> Result<String, String> {
    // SFTP beginnt im Startordner, also reicht der Rest als relativer Pfad.
    let dir = match dir.trim() {
        "" | "~" => ".",
        dir => dir.strip_prefix("~/").unwrap_or(dir),
    };
    for (end, _) in dir.match_indices('/').chain([(dir.len(), "")]) {
        let prefix = &dir[..end];
        if !prefix.is_empty() && sftp.metadata(prefix).await.is_err() {
            sftp.create_dir(prefix)
                .await
                .map_err(|e| format!("Der Ordner {prefix} lässt sich nicht anlegen: {}", refused(e)))?;
        }
    }
    let path = sftp.canonicalize(dir).await.map_err(refused)?;
    Ok(path.trim_end_matches('/').to_string())
}

/// Der Pfad so, wie er ins Terminal geschrieben wird: in Anführungszeichen, sobald die Shell ihn sonst zerlegen könnte.
pub fn shell_word(path: &str) -> String {
    if !path.is_empty() && path.chars().all(|c| c.is_ascii_alphanumeric() || "_./-".contains(c)) {
        path.to_string()
    } else {
        quote(path)
    }
}

/// Kodiert ein RGBA-Bild (wie es die Zwischenablage liefert) als PNG.
pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let failed = |e: png::EncodingError| format!("Bild nicht als PNG kodierbar: {e}");
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    // Der Nutzer wartet auf den Pfad: lieber schnell als die letzten Prozent kleiner.
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header().map_err(failed)?;
    writer.write_image_data(rgba).map_err(failed)?;
    writer.finish().map_err(failed)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pfad_text_mit_und_ohne_anfuehrungszeichen() {
        assert_eq!(shell_word("/root/lotse-paste/bild-2026-11-12-231405.png"), "/root/lotse-paste/bild-2026-11-12-231405.png");
        assert_eq!(shell_word("/home/a_b/x.tar.gz"), "/home/a_b/x.tar.gz");
        assert_eq!(shell_word("/root/lotse-paste/mein bild.png"), "'/root/lotse-paste/mein bild.png'");
        assert_eq!(shell_word("/tmp/it's $(rm).png"), r"'/tmp/it'\''s $(rm).png'");
        assert_eq!(shell_word("/tmp/größe.png"), "'/tmp/größe.png'");
    }

    #[test]
    fn png_enthaelt_genau_die_pixel() {
        let rgba: Vec<u8> = (0..3 * 2 * 4).map(|i| (i * 9) as u8).collect();
        let bytes = encode_png(&rgba, 3, 2).unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes)).read_info().unwrap();
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut pixels).unwrap();
        assert_eq!((info.width, info.height, info.color_type), (3, 2, png::ColorType::Rgba));
        assert_eq!(pixels, rgba);
        // Falsche Maße sind ein Fehler, kein kaputtes Bild.
        assert!(encode_png(&rgba, 4, 2).is_err());
    }
}
