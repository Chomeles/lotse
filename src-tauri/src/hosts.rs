use std::{collections::HashSet, io::BufRead};

use ssh2_config::{ParseRule, SshConfig};

use serde::Serialize;

use crate::store::Host;

#[derive(Debug, Serialize)]
pub struct Import {
    pub hosts: Vec<Host>,
    /// Namen, die Lotse noch nicht verbinden kann (Umweg über einen Sprung-Host).
    pub skipped: Vec<String>,
}

/// Liest Hosts aus einer OpenSSH-Config. Ausgelassen werden Platzhalter (`Host *`),
/// verneinte Muster und Namen, die es in `existing` schon gibt. Hosts ohne `IdentityFile`
/// bekommen `default_key` (wie OpenSSH den Standardschlüssel nimmt).
pub fn import(reader: &mut impl BufRead, existing: &[String], default_key: &str) -> Result<Import, String> {
    let rules = ParseRule::ALLOW_UNKNOWN_FIELDS | ParseRule::ALLOW_UNSUPPORTED_FIELDS;
    let config = SshConfig::default()
        .parse(reader, rules)
        .map_err(|e| format!("SSH-Config nicht lesbar: {e}"))?;
    let mut seen: HashSet<&str> = existing.iter().map(String::as_str).collect();
    let mut hosts = vec![];
    let mut skipped = vec![];
    for clause in config.get_hosts().iter().flat_map(|entry| &entry.pattern) {
        let name = clause.pattern.as_str();
        if clause.negated || name.contains(['*', '?']) || !seen.insert(name) {
            continue;
        }
        // `query` mischt die Vorgaben aus `Host *` mit ein, wie es OpenSSH auch tut.
        let params = config.query(name);
        if params.proxy_jump.is_some() {
            skipped.push(name.to_string());
            continue;
        }
        hosts.push(Host {
            name: name.to_string(),
            address: params.host_name.unwrap_or_else(|| name.to_string()),
            port: params.port.unwrap_or(22),
            user: params.user.unwrap_or_default(),
            key_path: params
                .identity_file
                .and_then(|files| files.into_iter().next())
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|| default_key.to_string()),
        });
    }
    Ok(Import { hosts, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Wie bei OpenSSH gewinnt der erste Wert, deshalb stehen die Vorgaben (`Host *`) am Ende.
    const CONFIG: &str = r#"
Host web
    HostName 203.0.113.7
    Port 2222
    IdentityFile "C:/Users/test/Documents/web key"

Host db alt
    HostName db.example.org
    User postgres

Host intern
    HostName 10.0.0.5
    ProxyJump web

Host *.intern !db
    User niemand

Host *
    User admin
"#;

    #[test]
    fn liest_hosts_und_ueberspringt_platzhalter() {
        let Import { hosts, skipped } = import(&mut CONFIG.as_bytes(), &["alt".to_string()], "C:/keys/standard").unwrap();
        assert_eq!(skipped, ["intern"]);
        let names: Vec<&str> = hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["web", "db"]);

        let web = &hosts[0];
        assert_eq!((web.address.as_str(), web.port, web.user.as_str()), ("203.0.113.7", 2222, "admin"));
        assert_eq!(web.key_path, "C:/Users/test/Documents/web key");

        let db = &hosts[1];
        assert_eq!((db.address.as_str(), db.port, db.user.as_str()), ("db.example.org", 22, "postgres"));
        assert_eq!(db.key_path, "C:/keys/standard");
    }
}
