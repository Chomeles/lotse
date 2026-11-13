use std::{fs, io, path::Path};

use serde::{Deserialize, Serialize};

const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Host {
    pub name: String,
    pub address: String,
    pub port: u16,
    pub user: String,
    pub key_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub scrollback: u32,
    pub font_size: u32,
    /// Ordner auf dem Server für ins Terminal gezogene oder eingefügte Dateien. `~/` meint den Startordner.
    pub paste_dir: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self { scrollback: 10_000, font_size: 14, paste_dir: "~/hostess-paste".into() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Store {
    pub version: u32,
    pub hosts: Vec<Host>,
    pub settings: Settings,
}

impl Default for Store {
    fn default() -> Self {
        Self { version: VERSION, hosts: vec![], settings: Settings::default() }
    }
}

pub fn load(path: &Path) -> Result<Store, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Store::default()),
        Err(e) => return Err(format!("{} ist nicht lesbar: {e}", path.display())),
    };
    let store: Store = serde_json::from_str(&text)
        .map_err(|e| format!("{} ist beschädigt und wurde nicht verändert: {e}", path.display()))?;
    if store.version > VERSION {
        return Err(format!("{} stammt von einer neueren Version.", path.display()));
    }
    Ok(store)
}

pub fn save(path: &Path, store: &Store) -> Result<(), String> {
    // Eine vorhandene, aber unlesbare Datei nie überschreiben: sie enthält vielleicht noch alle Hosts.
    load(path)?;
    let json = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    write_atomic(path, &json).map_err(|e| format!("Speichern fehlgeschlagen: {e}"))
}

/// Schreibt erst in eine Nachbardatei und benennt dann um, damit ein Absturz nie eine halbe Datei hinterlässt.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hostess-store-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join("store.json")
    }

    #[test]
    fn schreiben_und_lesen() {
        let path = temp("rw");
        assert_eq!(load(&path).unwrap(), Store::default());
        let mut store = Store::default();
        store.hosts.push(Host {
            name: "web".into(),
            address: "example.org".into(),
            port: 2222,
            user: "root".into(),
            key_path: "C:/keys/web".into(),
        });
        store.settings.scrollback = 500;
        save(&path, &store).unwrap();
        assert_eq!(load(&path).unwrap(), store);
    }

    #[test]
    fn kaputte_datei_bleibt_unberuehrt() {
        let path = temp("kaputt");
        fs::write(&path, "{ kaputt").unwrap();
        assert!(load(&path).is_err());
        assert!(save(&path, &Store::default()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ kaputt");
    }

    #[test]
    fn fehlende_felder_bekommen_standardwerte() {
        let path = temp("alt");
        fs::write(&path, r#"{"hosts":[]}"#).unwrap();
        assert_eq!(load(&path).unwrap(), Store::default());
    }
}
