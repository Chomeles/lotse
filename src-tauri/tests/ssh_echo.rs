//! Prüft den Verbindungsweg gegen einen eingebauten SSH-Server, der alles zurückschickt:
//! Host-Schlüssel-Prüfung, Anmeldung mit Schlüssel, Passphrase oder Passwort, Daten durch die Shell.

mod common;

use std::time::Duration;

use common::{new_key, start_key_only_server, start_server, temp, write_key, PASSWORD};
use hostess::{
    known_hosts,
    ssh::{self, ConnectError},
    store::Host,
};

#[tokio::test]
async fn verbinden_pruefen_anmelden_echo() {
    let client_key = new_key();
    let (port, host_key) = start_server(client_key.public_key().clone(), 0, temp("")).await;
    let shown = known_hosts::fingerprint(&host_key);
    let known = temp("known_hosts");
    let _ = std::fs::remove_file(&known);
    let host = |key_path: String| Host {
        name: "test".into(),
        address: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        key_path,
    };
    let plain = host(write_key("id_plain", &client_key));
    let connect = |host: Host, passphrase: Option<&'static str>, trust: Option<&str>| {
        let (known, trust) = (known.clone(), trust.map(String::from));
        async move { ssh::connect(&host, passphrase, trust, known).await.map(|_| ()) }
    };

    // Unbekannter Host: Fingerabdruck wird gemeldet, nichts wird gespeichert.
    assert_eq!(
        connect(plain.clone(), None, None).await,
        Err(ConnectError::UnknownHost { fingerprint: shown.clone() })
    );
    // Ein anderer als der gezeigte Fingerabdruck schaltet nichts frei.
    assert!(matches!(
        connect(plain.clone(), None, Some("SHA256:falsch")).await,
        Err(ConnectError::UnknownHost { .. })
    ));
    assert!(!known.exists());

    // Bestätigter Fingerabdruck: Verbindung steht, Daten laufen durch die Shell und zurück.
    let handle = ssh::connect(&plain, None, Some(shown.clone()), known.clone()).await.unwrap();
    let (reader, writer) = ssh::open_shell(&handle, 80, 24).await.unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(ssh::pump(reader, move |data| {
        let _ = tx.send(data.to_vec());
    }));
    writer.data(&b"hallo"[..]).await.unwrap();
    let echoed = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
    assert_eq!(echoed, b"hallo");

    // Der Host ist jetzt bekannt, es braucht keine Bestätigung mehr.
    assert_eq!(connect(plain.clone(), None, None).await, Ok(()));

    // Geänderter Schlüssel blockiert, auch wenn jemand dem neuen Fingerabdruck „vertraut“.
    known_hosts::remove(&known, "127.0.0.1", port).unwrap();
    let old = new_key().public_key().clone();
    known_hosts::learn(&known, "127.0.0.1", port, &old).unwrap();
    let changed = Err(ConnectError::HostChanged {
        fingerprint: shown.clone(),
        old: vec![known_hosts::fingerprint(&old)],
    });
    assert_eq!(connect(plain.clone(), None, None).await, changed);
    assert_eq!(connect(plain.clone(), None, Some(shown.as_str())).await, changed);

    // Nach dem Entfernen des Eintrags geht es wieder über die Bestätigung.
    known_hosts::remove(&known, "127.0.0.1", port).unwrap();
    assert_eq!(connect(plain.clone(), None, Some(shown.as_str())).await, Ok(()));

    // Ein Schlüssel, den der Server nicht kennt, wird abgelehnt.
    let stranger = host(write_key("id_fremd", &new_key()));
    assert!(matches!(connect(stranger, None, None).await, Err(ConnectError::Other { .. })));

    // Verschlüsselter Schlüssel: ohne Passphrase nachfragen, falsche melden, richtige annehmen.
    let locked = client_key.encrypt(&mut rand::rng(), "geheim").unwrap();
    let locked = host(write_key("id_passphrase", &locked));
    assert_eq!(
        connect(locked.clone(), None, None).await,
        Err(ConnectError::NeedPassphrase { wrong: false })
    );
    assert_eq!(
        connect(locked.clone(), Some("falsch"), None).await,
        Err(ConnectError::NeedPassphrase { wrong: true })
    );
    assert_eq!(connect(locked, Some("geheim"), None).await, Ok(()));

    // Fehlende Schlüsseldatei gibt eine lesbare Meldung statt einer Passphrase-Frage.
    assert!(matches!(
        connect(host(temp("gibt_es_nicht").to_string_lossy().into_owned()), None, None).await,
        Err(ConnectError::Other { .. })
    ));
}

#[tokio::test]
async fn nicht_erreichbar_wird_verstaendlich_gemeldet() {
    let key_path = write_key("id_weg", &new_key());
    let message = |address: &'static str, port: u16| {
        let host = Host { name: "x".into(), address: address.into(), port, user: "u".into(), key_path: key_path.clone() };
        async move {
            match ssh::connect(&host, None, None, temp("known_hosts_weg")).await {
                Err(ConnectError::Other { message }) => message,
                other => panic!("unerwartet: {:?}", other.map(|_| ())),
            }
        }
    };
    // Port 1 auf dem eigenen Rechner: dort lauscht nichts.
    let refused = message("127.0.0.1", 1).await;
    assert!(refused.contains("nimmt auf Port 1 keine Verbindung an"), "{refused}");
    // `.invalid` ist für Namen reserviert, die es nie gibt.
    let unknown = message("gibt-es-nicht.invalid", 22).await;
    assert!(unknown.contains("lässt sich nicht auflösen"), "{unknown}");

    // Die .pub-Datei statt des privaten Schlüssels ist ein häufiger Fehlgriff.
    let host = Host { name: "x".into(), address: "127.0.0.1".into(), port: 1, user: "u".into(), key_path: "C:/keys/id.pub".into() };
    let Err(ConnectError::Other { message }) = ssh::connect(&host, None, None, temp("known_hosts_weg")).await else {
        panic!("öffentlicher Schlüssel wurde angenommen")
    };
    assert!(message.contains("öffentliche Schlüssel"), "{message}");
}

#[tokio::test]
async fn anmelden_mit_passwort() {
    let (port, host_key) = start_server(new_key().public_key().clone(), 0, temp("")).await;
    let known = temp("known_hosts_passwort");
    let _ = std::fs::remove_file(&known);
    // Ohne Schlüsseldatei meldet sich der Host mit Passwort an.
    let host = Host { name: "neu".into(), address: "127.0.0.1".into(), port, user: "root".into(), key_path: String::new() };
    let connect = |host: Host, password: Option<&'static str>, trust: Option<String>| {
        let known = known.clone();
        async move { ssh::connect(&host, password, trust, known).await.map(|_| ()) }
    };

    // Der Server-Schlüssel wird vor dem Passwort geprüft: unbekannter Host bricht ab, auch mit richtigem Passwort.
    let shown = known_hosts::fingerprint(&host_key);
    assert_eq!(
        connect(host.clone(), Some(PASSWORD), None).await,
        Err(ConnectError::UnknownHost { fingerprint: shown.clone() })
    );

    assert_eq!(connect(host.clone(), None, Some(shown)).await, Err(ConnectError::NeedPassword { wrong: false }));
    assert_eq!(connect(host.clone(), Some("falsch"), None).await, Err(ConnectError::NeedPassword { wrong: true }));
    assert_eq!(connect(host.clone(), Some(PASSWORD), None).await, Ok(()));

    // Server, der nur Schlüssel erlaubt: klare Meldung statt Passwort-Frage, mit und ohne Passwort.
    let (port, host_key) = start_key_only_server(new_key().public_key().clone(), temp("")).await;
    let host = Host { port, ..host };
    let shown = known_hosts::fingerprint(&host_key);
    for password in [None, Some(PASSWORD)] {
        let Err(ConnectError::Other { message }) = connect(host.clone(), password, Some(shown.clone())).await else {
            panic!("Passwort-Frage trotz Server ohne Passwort-Anmeldung")
        };
        assert!(message.contains("keine Anmeldung mit Passwort"), "{message}");
    }
}

#[tokio::test]
async fn ping_wird_beantwortet() {
    let key = new_key();
    let (port, host_key) = start_server(key.public_key().clone(), 0, temp("")).await;
    let known = temp("known_hosts_ping");
    let _ = std::fs::remove_file(&known);
    let host = Host { name: "ping".into(), address: "127.0.0.1".into(), port, user: "tester".into(), key_path: write_key("id_ping", &key) };
    let handle = ssh::connect(&host, None, Some(known_hosts::fingerprint(&host_key)), known).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), handle.send_ping()).await.expect("keine Antwort auf den Ping").unwrap();
    assert!(!handle.is_closed());
}
