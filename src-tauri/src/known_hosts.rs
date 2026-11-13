use std::{fs, io, path::Path};

use russh::keys::{known_hosts, Algorithm, Error, HashAlg, PublicKey};
use serde::Serialize;

use crate::store::write_atomic;

#[derive(Debug, PartialEq)]
pub enum HostKey {
    Known,
    Unknown,
    /// Für den Host sind Schlüssel hinterlegt, aber keiner passt. `old` sind deren Fingerabdrücke.
    Changed { old: Vec<String> },
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// Schlüsseltyp, wie man ihn von `ssh-keygen` kennt.
pub fn kind(key: &PublicKey) -> String {
    match key.algorithm() {
        Algorithm::Ed25519 => "ED25519".into(),
        Algorithm::Rsa { .. } => "RSA".into(),
        Algorithm::Ecdsa { .. } => "ECDSA".into(),
        Algorithm::Dsa => "DSA".into(),
        other => other.as_str().to_string(),
    }
}

/// Ein Eintrag der Known-Hosts-Datei, so wie ihn die Oberfläche zeigt.
#[derive(Debug, PartialEq, Serialize)]
pub struct Entry {
    pub address: String,
    pub port: u16,
    pub kind: String,
    pub fingerprint: String,
}

/// Alle Einträge der Datei. Sie wird nur von `learn` geschrieben: ein Name je Zeile, im Klartext.
pub fn list(path: &Path) -> io::Result<Vec<Entry>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    Ok(text
        .lines()
        .filter_map(|line| {
            let (name, key) = line.split_once(' ')?;
            let key = PublicKey::from_openssh(key).ok()?;
            let (address, port) = match name.strip_prefix('[').and_then(|rest| rest.split_once("]:")) {
                Some((address, port)) => (address, port.parse().ok()?),
                None => (name, 22),
            };
            Some(Entry { address: address.to_string(), port, kind: kind(&key), fingerprint: fingerprint(&key) })
        })
        .collect())
}

/// Strenger als `russh::keys::check_known_hosts_path`: dort gilt ein Host als unbekannt,
/// wenn der Server einen anderen Schlüsseltyp zeigt. Hier ist das „geändert“.
pub fn check(path: &Path, host: &str, port: u16, key: &PublicKey) -> Result<HostKey, Error> {
    let known = known_hosts::known_host_keys_path(host, port, path)?;
    Ok(if known.is_empty() {
        HostKey::Unknown
    } else if known.iter().any(|(_, k)| k.key_data() == key.key_data()) {
        HostKey::Known
    } else {
        HostKey::Changed { old: known.iter().map(|(_, k)| fingerprint(k)).collect() }
    })
}

pub fn learn(path: &Path, host: &str, port: u16, key: &PublicKey) -> Result<(), Error> {
    known_hosts::learn_known_hosts_path(host, port, key, path)
}

/// Entfernt alle Einträge des Hosts. Die Datei schreibt nur `learn`, also stehen die Namen im Klartext.
pub fn remove(path: &Path, host: &str, port: u16) -> io::Result<()> {
    let name = if port == 22 { host.to_string() } else { format!("[{host}]:{port}") };
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let kept: String = text
        .lines()
        .filter(|line| !line.split(' ').next().is_some_and(|hosts| hosts.split(',').any(|h| h == name)))
        .map(|line| format!("{line}\n"))
        .collect();
    write_atomic(path, kept.as_bytes())
}

#[cfg(test)]
mod tests {
    use russh::keys::{Algorithm, PrivateKey};

    use super::*;

    fn key() -> PublicKey {
        PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap().public_key().clone()
    }

    #[test]
    fn unbekannt_bekannt_geaendert_entfernt() {
        let path = std::env::temp_dir().join(format!("hostess-known-hosts-{}", std::process::id()));
        let _ = fs::remove_file(&path);
        let (a, b, other) = (key(), key(), key());

        assert_eq!(check(&path, "srv", 22, &a).unwrap(), HostKey::Unknown);
        learn(&path, "srv", 22, &a).unwrap();
        learn(&path, "srv", 2222, &other).unwrap();
        assert_eq!(check(&path, "srv", 22, &a).unwrap(), HostKey::Known);
        assert_eq!(check(&path, "srv", 22, &b).unwrap(), HostKey::Changed { old: vec![fingerprint(&a)] });
        // Anderer Port ist ein anderer Eintrag.
        assert_eq!(check(&path, "srv", 2222, &other).unwrap(), HostKey::Known);

        let entry = |port, key: &PublicKey| Entry {
            address: "srv".into(),
            port,
            kind: "ED25519".into(),
            fingerprint: fingerprint(key),
        };
        assert_eq!(list(&path).unwrap(), [entry(22, &a), entry(2222, &other)]);

        remove(&path, "srv", 22).unwrap();
        assert_eq!(list(&path).unwrap(), [entry(2222, &other)]);
        assert_eq!(check(&path, "srv", 22, &b).unwrap(), HostKey::Unknown);
        assert_eq!(check(&path, "srv", 2222, &other).unwrap(), HostKey::Known);
    }

    #[test]
    fn fehlende_datei_ist_eine_leere_liste() {
        assert_eq!(list(&std::env::temp_dir().join("hostess-known-hosts-gibt-es-nicht")).unwrap(), []);
    }

    #[test]
    fn anderer_schluesseltyp_gilt_als_geaendert() {
        let path = std::env::temp_dir().join(format!("hostess-known-hosts-typ-{}", std::process::id()));
        let _ = fs::remove_file(&path);
        learn(&path, "srv", 22, &key()).unwrap();
        let ecdsa = PrivateKey::random(&mut rand::rng(), Algorithm::Ecdsa { curve: russh::keys::EcdsaCurve::NistP256 })
            .unwrap()
            .public_key()
            .clone();
        assert!(matches!(check(&path, "srv", 22, &ecdsa).unwrap(), HostKey::Changed { .. }));
    }
}
