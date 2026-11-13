use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use russh::{
    client,
    keys::{load_secret_key, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    ChannelMsg, ChannelReadHalf, ChannelWriteHalf, MethodKind,
};
use serde::Serialize;

use crate::{
    known_hosts::{self, fingerprint, HostKey},
    store::Host,
};

pub type Handle = client::Handle<Client>;
pub type ShellWriter = ChannelWriteHalf<client::Msg>;

/// Warum eine Verbindung nicht zustande kam. Die Oberfläche reagiert auf `kind`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnectError {
    UnknownHost { fingerprint: String },
    HostChanged { fingerprint: String, old: Vec<String> },
    NeedPassphrase { wrong: bool },
    NeedPassword { wrong: bool },
    Other { message: String },
}

fn other(message: impl Into<String>) -> ConnectError {
    ConnectError::Other { message: message.into() }
}

pub struct Client {
    known_hosts: PathBuf,
    address: String,
    port: u16,
    trust: Option<String>,
    issue: Arc<Mutex<Option<ConnectError>>>,
    why: Why,
}

/// Warum eine stehende Verbindung endete, in einem Satz ohne Punkt. Leer, solange sie steht.
pub type Why = Arc<Mutex<Option<String>>>;

fn why_text(reason: &client::DisconnectReason<russh::Error>) -> String {
    use client::DisconnectReason::{Error, ReceivedDisconnect};
    match reason {
        ReceivedDisconnect(info) if info.message.is_empty() => {
            format!("Der Server hat die Verbindung beendet ({:?})", info.reason_code)
        }
        ReceivedDisconnect(info) => format!("Der Server hat die Verbindung beendet: {}", info.message),
        // Vier Keepalives im Abstand von 30 Sekunden blieben ohne Antwort.
        Error(russh::Error::KeepaliveTimeout) => "Der Server antwortet seit zwei Minuten nicht mehr".into(),
        Error(russh::Error::Disconnect) => "Der Server hat die Leitung ohne Meldung geschlossen".into(),
        Error(russh::Error::IO(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
            "Der Server hat die Leitung ohne Meldung geschlossen".into()
        }
        Error(russh::Error::IO(e)) => format!("Die Leitung ist abgerissen ({e})"),
        Error(e) => format!("Verbindungsfehler: {e}"),
    }
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn disconnected(&mut self, reason: client::DisconnectReason<Self::Error>) -> Result<(), Self::Error> {
        *self.why.lock().unwrap() = Some(why_text(&reason));
        match reason {
            client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            client::DisconnectReason::Error(e) => Err(e),
        }
    }

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let issue = match key {
            // shortcut: Host-Zertifikate werden abgelehnt, bei Bedarf Prüfung gegen eine CA ergänzen
            PublicKeyOrCertificate::Certificate(_) => {
                other("Der Server weist sich mit einem Zertifikat aus. Das wird noch nicht unterstützt.")
            }
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                let shown = fingerprint(key);
                match known_hosts::check(&self.known_hosts, &self.address, self.port, key) {
                    Ok(HostKey::Known) => return Ok(true),
                    // Vertraut wird nur genau dem Fingerabdruck, den der Nutzer gesehen und bestätigt hat.
                    Ok(HostKey::Unknown) if self.trust.as_deref() == Some(shown.as_str()) => {
                        match known_hosts::learn(&self.known_hosts, &self.address, self.port, key) {
                            Ok(()) => return Ok(true),
                            Err(e) => other(format!("Known-Hosts-Datei nicht schreibbar: {e}")),
                        }
                    }
                    Ok(HostKey::Unknown) => ConnectError::UnknownHost { fingerprint: shown },
                    Ok(HostKey::Changed { old }) => ConnectError::HostChanged { fingerprint: shown, old },
                    Err(e) => other(format!("Known-Hosts-Datei nicht lesbar: {e}")),
                }
            }
        };
        *self.issue.lock().unwrap() = Some(issue);
        Ok(false)
    }
}

/// Baut die Verbindung auf und meldet sich an: mit dem Schlüssel des Hosts oder, wenn keiner eingetragen ist,
/// mit Passwort. `secret` ist die Passphrase des Schlüssels oder das Passwort.
/// `trust` ist der Fingerabdruck, den der Nutzer für einen unbekannten Host bestätigt hat.
pub async fn connect(
    host: &Host,
    secret: Option<&str>,
    trust: Option<String>,
    known_hosts: PathBuf,
) -> Result<Handle, ConnectError> {
    connect_why(host, secret, trust, known_hosts, Why::default()).await
}

/// Wie `connect`; in `why` steht später, warum die Verbindung endete.
pub async fn connect_why(
    host: &Host,
    secret: Option<&str>,
    trust: Option<String>,
    known_hosts: PathBuf,
    why: Why,
) -> Result<Handle, ConnectError> {
    // Schlüssel zuerst: ohne ihn lohnt sich die Verbindung nicht.
    let key = if host.key_path.is_empty() { None } else { Some(load_key(host, secret)?) };

    let issue = Arc::new(Mutex::new(None));
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let handler = Client {
        known_hosts,
        address: host.address.clone(),
        port: host.port,
        trust,
        issue: issue.clone(),
        why,
    };
    let connecting = client::connect(config, (host.address.as_str(), host.port), handler);
    let mut handle = match tokio::time::timeout(Duration::from_secs(15), connecting).await {
        Err(_) => return Err(other(format!("{} antwortet nicht (Zeitüberschreitung).", host.address))),
        Ok(Err(e)) => {
            let issue = issue.lock().unwrap().take();
            return Err(issue.unwrap_or_else(|| unreachable_host(&e, host)));
        }
        Ok(Ok(handle)) => handle,
    };

    // Ab hier ist der Server-Schlüssel geprüft; erst jetzt gehen Anmeldedaten auf die Leitung.
    let failed = |e: russh::Error| other(format!("Anmeldung fehlgeschlagen: {e}"));
    let Some(key) = key else {
        return match login_password(&mut handle, &host.user, secret).await.map_err(failed)? {
            None => Ok(handle),
            Some(e) => Err(e),
        };
    };
    let hash = handle.best_supported_rsa_hash().await.map_err(failed)?.flatten();
    let auth = handle
        .authenticate_publickey(host.user.as_str(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await
        .map_err(failed)?;
    if !auth.success() {
        return Err(other(format!(
            "Der Server lehnt diesen Schlüssel für den Benutzer {} ab.",
            host.user
        )));
    }
    Ok(handle)
}

fn load_key(host: &Host, passphrase: Option<&str>) -> Result<PrivateKey, ConnectError> {
    let key_path = expand_home(&host.key_path);
    if key_path.extension().is_some_and(|ext| ext == "pub") {
        return Err(other(format!(
            "{} ist der öffentliche Schlüssel. Wähle die gleichnamige Datei ohne „.pub“.",
            host.key_path
        )));
    }
    match load_secret_key(&key_path, passphrase) {
        Ok(key) => Ok(key),
        Err(russh::keys::Error::KeyIsEncrypted) => Err(ConnectError::NeedPassphrase { wrong: false }),
        Err(russh::keys::Error::IO(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(other(format!("Die Schlüsseldatei {} gibt es nicht.", host.key_path)))
        }
        Err(russh::keys::Error::IO(e)) => Err(other(format!("Schlüsseldatei {} nicht lesbar: {e}", host.key_path))),
        Err(_) if passphrase.is_some() => Err(ConnectError::NeedPassphrase { wrong: true }),
        Err(e) => Err(other(format!(
            "{} ist kein privater Schlüssel, den Hostess lesen kann (OpenSSH, PEM oder PuTTY-ppk): {e}",
            host.key_path
        ))),
    }
}

/// Meldet sich mit Passwort an. `None` heißt angemeldet, sonst steht da, woran es lag.
// shortcut: nur die Methode „password“; Server, die das Passwort über „keyboard-interactive“ abfragen
// (z. B. mit Einmalcode), bekommen die Meldung unten. Bei Bedarf `authenticate_keyboard_interactive_*` ergänzen.
async fn login_password(
    handle: &mut Handle,
    user: &str,
    password: Option<&str>,
) -> Result<Option<ConnectError>, russh::Error> {
    // Erst fragen, was der Server anbietet: so geht das Passwort nie an einen Server, der es gar nicht will,
    // und statt einer endlosen Passwort-Abfrage kommt eine klare Meldung.
    let methods = match handle.authenticate_none(user).await? {
        client::AuthResult::Success => return Ok(None),
        client::AuthResult::Failure { remaining_methods, .. } => remaining_methods,
    };
    if !methods.contains(&MethodKind::Password) {
        let offered: Vec<&str> = methods.iter().map(Into::into).collect();
        return Ok(Some(other(format!(
            "Der Server erlaubt keine Anmeldung mit Passwort (er bietet an: {}). \
             Trage im Host eine Schlüsseldatei ein.",
            if offered.is_empty() { "nichts".to_string() } else { offered.join(", ") }
        ))));
    }
    let Some(password) = password else {
        return Ok(Some(ConnectError::NeedPassword { wrong: false }));
    };
    let auth = handle.authenticate_password(user, password).await?;
    Ok(if auth.success() { None } else { Some(ConnectError::NeedPassword { wrong: true }) })
}

/// `~/` am Anfang meint den Benutzerordner, wie in der SSH-Config üblich.
pub fn expand_home(path: &str) -> PathBuf {
    let rest = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\"));
    match (rest, std::env::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

/// Sagt in einem Satz, warum der Server nicht erreichbar war.
fn unreachable_host(e: &russh::Error, host: &Host) -> ConnectError {
    use std::io::ErrorKind;
    let (address, port) = (&host.address, host.port);
    let message = match e {
        russh::Error::IO(io) => match (io.kind(), io.raw_os_error()) {
            (ErrorKind::ConnectionRefused, _) => {
                format!("{address} nimmt auf Port {port} keine Verbindung an. Läuft dort ein SSH-Server?")
            }
            (ErrorKind::TimedOut, _) => format!("{address} antwortet nicht (Zeitüberschreitung)."),
            (ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable, _) => {
                format!("{address} ist nicht erreichbar. Besteht eine Netzwerkverbindung?")
            }
            // 11001/11002/11004: Windows findet den Namen nicht.
            (_, Some(11001 | 11002 | 11004)) => format!("Der Name {address} lässt sich nicht auflösen. Tippfehler?"),
            _ => format!("Verbindung zu {address} fehlgeschlagen: {io}"),
        },
        other => format!("Verbindung zu {address} fehlgeschlagen: {other}"),
    };
    ConnectError::Other { message }
}

/// Öffnet eine Shell mit Terminal der angegebenen Größe.
pub async fn open_shell(handle: &Handle, cols: u32, rows: u32) -> Result<(ChannelReadHalf, ShellWriter), russh::Error> {
    let channel = handle.channel_open_session().await?;
    channel.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await?;
    channel.request_shell(false).await?;
    Ok(channel.split())
}

/// Reicht die Ausgabe der Shell weiter, bis der Kanal oder die Verbindung endet.
/// `true`: die Shell hat sich beendet (etwa `exit`). `false`: die Verbindung ist weg.
pub async fn pump(mut shell: ChannelReadHalf, mut out: impl FnMut(&[u8])) -> bool {
    while let Some(msg) = shell.wait().await {
        match msg {
            ChannelMsg::Data { data } => out(&data),
            ChannelMsg::ExtendedData { data, .. } => out(&data),
            ChannelMsg::Close => return true,
            _ => {}
        }
    }
    false
}

/// Führt einen Befehl auf dem Server aus. Bei Fehlercode kommt die Ausgabe des Befehls als Fehler zurück.
pub async fn exec(handle: &Handle, command: &str) -> Result<(), String> {
    let mut channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.exec(true, command).await.map_err(|e| e.to_string())?;
    let mut output = Vec::new();
    let mut code = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => output.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, .. } => output.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            ChannelMsg::Failure => return Err("Der Server führt keine Befehle aus.".into()),
            _ => {}
        }
    }
    match code {
        Some(0) => Ok(()),
        _ => Err(String::from_utf8_lossy(&output).trim().to_string()),
    }
}

/// Setzt einen Pfad so in einfache Anführungszeichen, dass die Shell ihn wörtlich nimmt.
pub fn quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

/// Löscht einen Ordner samt Inhalt mit einem einzigen Befehl. Über SFTP wäre das eine Anfrage je Datei.
// shortcut: braucht `rm` auf dem Server (Linux, BSD, macOS); für Windows-Server SFTP-Rekursion ergänzen
pub async fn remove_tree(handle: &Handle, path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.trim_end_matches('/').is_empty() {
        return Err(format!("{path} wird nicht gelöscht: nur vollständige Pfade, nie das Wurzelverzeichnis."));
    }
    exec(handle, &format!("rm -rf -- {}", quote(path)))
        .await
        .map_err(|e| format!("Ordner nicht gelöscht: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{expand_home, quote};

    #[test]
    fn tilde_meint_den_benutzerordner() {
        let home = std::env::home_dir().unwrap();
        assert_eq!(expand_home("~/.ssh/id_ed25519"), home.join(".ssh/id_ed25519"));
        assert_eq!(expand_home("C:/keys/web"), std::path::PathBuf::from("C:/keys/web"));
        assert_eq!(expand_home("~fremd/key"), std::path::PathBuf::from("~fremd/key"));
    }

    #[test]
    fn pfade_werden_woertlich_genommen() {
        assert_eq!(quote("/srv/mein ordner"), "'/srv/mein ordner'");
        assert_eq!(quote("/srv/it's; rm -rf $HOME"), r"'/srv/it'\''s; rm -rf $HOME'");
    }
}
