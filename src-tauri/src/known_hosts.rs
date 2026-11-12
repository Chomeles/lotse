use std::{fs, io, path::Path};

use russh::keys::{known_hosts, Error, HashAlg, PublicKey};

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
        let path = std::env::temp_dir().join(format!("lotse-known-hosts-{}", std::process::id()));
        let _ = fs::remove_file(&path);
        let (a, b, other) = (key(), key(), key());

        assert_eq!(check(&path, "srv", 22, &a).unwrap(), HostKey::Unknown);
        learn(&path, "srv", 22, &a).unwrap();
        learn(&path, "srv", 2222, &other).unwrap();
        assert_eq!(check(&path, "srv", 22, &a).unwrap(), HostKey::Known);
        assert_eq!(check(&path, "srv", 22, &b).unwrap(), HostKey::Changed { old: vec![fingerprint(&a)] });
        // Anderer Port ist ein anderer Eintrag.
        assert_eq!(check(&path, "srv", 2222, &other).unwrap(), HostKey::Known);

        remove(&path, "srv", 22).unwrap();
        assert_eq!(check(&path, "srv", 22, &b).unwrap(), HostKey::Unknown);
        assert_eq!(check(&path, "srv", 2222, &other).unwrap(), HostKey::Known);
    }

    #[test]
    fn anderer_schluesseltyp_gilt_als_geaendert() {
        let path = std::env::temp_dir().join(format!("lotse-known-hosts-typ-{}", std::process::id()));
        let _ = fs::remove_file(&path);
        learn(&path, "srv", 22, &key()).unwrap();
        let ecdsa = PrivateKey::random(&mut rand::rng(), Algorithm::Ecdsa { curve: russh::keys::EcdsaCurve::NistP256 })
            .unwrap()
            .public_key()
            .clone();
        assert!(matches!(check(&path, "srv", 22, &ecdsa).unwrap(), HostKey::Changed { .. }));
    }
}
