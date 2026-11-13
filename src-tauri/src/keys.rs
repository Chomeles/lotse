//! Private Schlüssel auf der Platte: auflisten, erzeugen, löschen.
//! Nach außen geht nur Öffentliches (Typ, Fingerabdruck, öffentlicher Schlüssel), nie der Inhalt eines privaten Schlüssels.

use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use russh::keys::{
    decode_secret_key, key::safe_rng, ssh_key::LineEnding, Algorithm, Error, PrivateKey, PublicKey,
};
use serde::Serialize;

use crate::known_hosts::{fingerprint, kind};

#[derive(Debug, PartialEq, Serialize)]
pub struct KeyInfo {
    pub path: String,
    pub name: String,
    /// Zum Beispiel „ED25519“. Leer wie `fingerprint`, wenn die Datei fehlt oder nicht lesbar ist.
    pub kind: String,
    pub fingerprint: String,
    /// Mit Passphrase geschützt.
    pub encrypted: bool,
    /// Namen der Hosts, die diesen Schlüssel verwenden.
    pub hosts: Vec<String>,
}

/// Die privaten Schlüssel in `dir` und dazu alle Schlüsseldateien aus `used` (Hostname, Pfad), auch wenn sie woanders liegen.
pub fn list(dir: &Path, used: &[(String, PathBuf)]) -> Vec<KeyInfo> {
    let mut paths: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_private_key(path))
        .collect();
    paths.sort();
    for (_, path) in used {
        if !paths.iter().any(|p| same(p, path)) {
            paths.push(path.clone());
        }
    }
    paths
        .iter()
        .map(|path| {
            let (public, encrypted) = inspect(path);
            KeyInfo {
                path: path.to_string_lossy().into_owned(),
                name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                kind: public.as_ref().map(kind).unwrap_or_default(),
                fingerprint: public.as_ref().map(fingerprint).unwrap_or_default(),
                encrypted,
                hosts: used.iter().filter(|(_, p)| same(p, path)).map(|(name, _)| name.clone()).collect(),
            }
        })
        .collect()
}

/// Der öffentliche Schlüssel als eine Zeile, wie sie auf dem Server in `authorized_keys` gehört.
pub fn public_key(path: &Path) -> Result<String, String> {
    // Die .pub daneben hat Vorrang: sie trägt den Kommentar, den der Nutzer kennt.
    let beside = fs::read_to_string(pub_path(path)).ok().filter(|text| PublicKey::from_openssh(text).is_ok());
    match (beside, inspect(path).0) {
        (Some(text), _) => Ok(text.trim().to_string()),
        (None, Some(key)) => key.to_openssh().map_err(|e| e.to_string()),
        (None, None) => Err(format!(
            "Zu {} gibt es keine .pub-Datei, und der öffentliche Teil lässt sich ohne Passphrase nicht lesen.",
            path.display()
        )),
    }
}

/// Erzeugt einen ED25519-Schlüssel `dir/name` samt `.pub`. Überschreibt nie eine vorhandene Datei.
pub fn generate(dir: &Path, name: &str, passphrase: Option<&str>) -> Result<PathBuf, String> {
    let plain = !name.is_empty()
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !plain {
        return Err("Der Name darf nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich enthalten.".into());
    }
    // Diese Namen liest OpenSSH selbst; ein Schlüssel dort würde die Datei unbrauchbar machen.
    if name.ends_with(".pub") || ["config", "known_hosts", "authorized_keys"].contains(&name) {
        return Err(format!("„{name}“ ist als Name für einen Schlüssel nicht erlaubt."));
    }
    let path = dir.join(name);
    let public = pub_path(&path);
    if path.exists() || public.exists() {
        return Err(format!("{} oder die .pub-Datei dazu gibt es schon. Wähle einen anderen Namen.", path.display()));
    }

    let failed = |e: russh::keys::ssh_key::Error| format!("Schlüssel nicht erzeugt: {e}");
    let mut rng = safe_rng();
    let mut key = PrivateKey::random(&mut rng, Algorithm::Ed25519).map_err(failed)?;
    key.set_comment(name);
    let key = match passphrase.filter(|p| !p.is_empty()) {
        Some(passphrase) => key.encrypt(&mut rng, passphrase).map_err(failed)?,
        None => key,
    };
    let private_text = key.to_openssh(LineEnding::LF).map_err(failed)?;
    let public_text = format!("{}\n", key.public_key().to_openssh().map_err(failed)?);

    let write = |path: &Path, bytes: &[u8]| {
        // `create_new` schlägt fehl, wenn inzwischen doch eine Datei da ist.
        fs::OpenOptions::new().write(true).create_new(true).open(path)?.write_all(bytes)
    };
    fs::create_dir_all(dir)
        .and_then(|()| write(&path, private_text.as_bytes()))
        .map_err(|e| format!("{} nicht geschrieben: {e}", path.display()))?;
    if let Err(e) = write(&public, public_text.as_bytes()) {
        // Kein halbes Paar hinterlassen. Die private Datei wurde eben erst hier angelegt.
        let _ = fs::remove_file(&path);
        return Err(format!("{} nicht geschrieben: {e}", public.display()));
    }
    Ok(path)
}

/// Löscht den privaten Schlüssel und die `.pub` daneben.
pub fn delete(path: &Path) -> Result<(), String> {
    // Nur löschen, was die Liste auch als Schlüssel zeigt: schützt vor einem falschen Pfad.
    if !is_private_key(path) {
        return Err(format!("{} ist kein privater Schlüssel und wird nicht gelöscht.", path.display()));
    }
    let failed = |e: io::Error| format!("Löschen fehlgeschlagen: {e}");
    let public = pub_path(path);
    fs::remove_file(path).map_err(failed)?;
    match fs::remove_file(public) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(failed(e)),
        _ => Ok(()),
    }
}

fn pub_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".pub");
    name.into()
}

// shortcut: Vergleich als Text ohne Groß/Klein und Schrägstrich-Richtung; Verknüpfungen und `..` gelten als
// verschiedene Dateien. Bei Bedarf `fs::canonicalize` nehmen.
fn same(a: &Path, b: &Path) -> bool {
    let text = |p: &Path| p.to_string_lossy().replace('\\', "/").to_lowercase();
    text(a) == text(b)
}

/// Erkennt private Schlüssel an der `.pub` daneben oder am Kopf der Datei, ohne sie ganz zu lesen.
fn is_private_key(path: &Path) -> bool {
    if !path.is_file() || path.extension().is_some_and(|ext| ext == "pub") {
        return false;
    }
    if pub_path(path).is_file() {
        return true;
    }
    let mut head = [0u8; 40];
    let read = fs::File::open(path).and_then(|mut file| file.read(&mut head)).unwrap_or(0);
    let head = String::from_utf8_lossy(&head[..read]);
    (head.starts_with("-----BEGIN ") && head.contains("PRIVATE KEY")) || head.starts_with("PuTTY-User-Key-File-")
}

/// Öffentlicher Teil und „mit Passphrase geschützt“, ohne die Passphrase zu kennen.
fn inspect(path: &Path) -> (Option<PublicKey>, bool) {
    // Schlüsseldateien sind klein; alles Größere ist keine und wird gar nicht erst gelesen.
    let text = fs::metadata(path)
        .ok()
        .filter(|meta| meta.len() <= 64 * 1024)
        .and_then(|_| fs::read_to_string(path).ok())
        .unwrap_or_default();
    let beside = || fs::read_to_string(pub_path(path)).ok().and_then(|text| PublicKey::from_openssh(&text).ok());
    // Im OpenSSH-Format steht der öffentliche Teil unverschlüsselt in der Datei.
    if let Ok(key) = PrivateKey::from_openssh(&text) {
        return (Some(key.public_key().clone()), key.is_encrypted());
    }
    match decode_secret_key(&text, None) {
        Ok(key) => (Some(key.public_key().clone()), false),
        // Verschlüsseltes PEM oder ppk: Typ und Fingerabdruck verrät nur die .pub daneben.
        Err(Error::KeyIsEncrypted) => (beside(), true),
        Err(_) => (beside(), false),
    }
}

#[cfg(test)]
mod tests {
    use russh::keys::load_secret_key;

    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hostess-keys-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn erzeugen_ueberschreibt_nichts() {
        let dir = temp("neu");
        let path = generate(&dir, "id_a", None).unwrap();
        assert_eq!(path, dir.join("id_a"));
        let before = fs::read(&path).unwrap();
        assert!(dir.join("id_a.pub").is_file());

        assert!(generate(&dir, "id_a", None).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        // Auch eine einzelne .pub ohne private Datei wird nicht überschrieben.
        fs::write(dir.join("id_b.pub"), "fremd").unwrap();
        assert!(generate(&dir, "id_b", None).is_err());
        assert_eq!(fs::read_to_string(dir.join("id_b.pub")).unwrap(), "fremd");
        assert!(!dir.join("id_b").exists());

        for name in ["", "../id_x", "unter/id_x", "id x", ".versteckt", "id_x.pub", "config"] {
            assert!(generate(&dir, name, None).is_err(), "{name}");
        }
        // Der erzeugte Schlüssel ist benutzbar, mit Passphrase nur mit der richtigen.
        assert!(load_secret_key(&path, None).is_ok());
        let locked = generate(&dir, "id_c", Some("geheim")).unwrap();
        assert!(load_secret_key(&locked, None).is_err());
        assert!(load_secret_key(&locked, Some("geheim")).is_ok());
    }

    #[test]
    fn auflisten_anzeigen_loeschen() {
        let dir = temp("liste");
        let plain = generate(&dir, "id_a", None).unwrap();
        let locked = generate(&dir, "id_b", Some("geheim")).unwrap();
        // Ohne .pub wird der Schlüssel am Kopf der Datei erkannt.
        fs::remove_file(dir.join("id_b.pub")).unwrap();
        fs::write(dir.join("config"), "Host web\n").unwrap();
        fs::write(dir.join("notiz.txt"), "kein Schlüssel").unwrap();
        let missing = dir.join("woanders").join("id_weg");
        let used = [
            // Andere Schreibweise desselben Pfads zählt als derselbe Schlüssel.
            ("web".to_string(), PathBuf::from(plain.to_string_lossy().to_uppercase().replace('\\', "/"))),
            ("db".to_string(), plain.clone()),
            ("alt".to_string(), missing.clone()),
        ];

        let keys = list(&dir, &used);
        let names: Vec<&str> = keys.iter().map(|k| k.name.as_str()).collect();
        assert_eq!(names, ["id_a", "id_b", "id_weg"]);

        let public = PublicKey::from_openssh(&fs::read_to_string(dir.join("id_a.pub")).unwrap()).unwrap();
        assert_eq!((keys[0].kind.as_str(), keys[0].encrypted), ("ED25519", false));
        assert_eq!(keys[0].fingerprint, fingerprint(&public));
        assert!(keys[0].fingerprint.starts_with("SHA256:"));
        assert_eq!(keys[0].hosts, ["web", "db"]);

        assert_eq!((keys[1].kind.as_str(), keys[1].encrypted), ("ED25519", true));
        assert!(keys[1].hosts.is_empty());
        assert_eq!((keys[2].fingerprint.as_str(), keys[2].hosts.as_slice()), ("", &["alt".to_string()][..]));

        // Der öffentliche Schlüssel kommt aus der .pub oder, ohne sie, aus der privaten Datei (auch verschlüsselt).
        assert_eq!(public_key(&plain).unwrap(), fs::read_to_string(dir.join("id_a.pub")).unwrap().trim());
        let shown = public_key(&locked).unwrap();
        assert!(shown.starts_with("ssh-ed25519 "), "{shown}");
        assert_eq!(fingerprint(&PublicKey::from_openssh(&shown).unwrap()), keys[1].fingerprint);
        assert!(public_key(&missing).is_err());

        // Gelöscht wird nur, was ein Schlüssel ist, dann aber beide Dateien.
        assert!(delete(&dir.join("notiz.txt")).is_err());
        assert!(delete(&dir.join("id_a.pub")).is_err());
        assert!(dir.join("notiz.txt").exists() && dir.join("id_a.pub").exists());
        delete(&plain).unwrap();
        delete(&locked).unwrap();
        assert!(!plain.exists() && !dir.join("id_a.pub").exists() && !locked.exists());
        assert!(list(&dir, &[]).is_empty());
    }
}
