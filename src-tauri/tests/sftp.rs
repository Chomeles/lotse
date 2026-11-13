//! Prüft den Dateimanager gegen den echten `sftp-server` von Git für Windows.
//! Fehlt der auf dem Rechner, wird der Test übersprungen.

mod common;

use common::{new_key, start_server, temp, write_key, SFTP_SERVER};
use hostess::{sftp, ssh, store::Host};

#[tokio::test]
async fn ordner_hochladen_herunterladen_umbenennen_loeschen() {
    if !std::path::Path::new(SFTP_SERVER).exists() {
        eprintln!("übersprungen: {SFTP_SERVER} fehlt");
        return;
    }
    let remote_dir = temp("sftp-remote");
    let _ = std::fs::remove_dir_all(&remote_dir);
    std::fs::create_dir_all(&remote_dir).unwrap();

    let key = new_key();
    let (port, host_key) = start_server(key.public_key().clone(), 0, remote_dir.clone()).await;
    let host = Host {
        name: "test".into(),
        address: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        key_path: write_key("id_sftp", &key),
    };
    let known = temp("known_hosts_sftp");
    let _ = std::fs::remove_file(&known);
    let trust = Some(hostess::known_hosts::fingerprint(&host_key));
    let handle = ssh::connect(&host, None, trust, known).await.unwrap();
    let sftp = sftp::open(&handle).await.unwrap();

    // Startordner ist leer.
    let start = sftp::list(&sftp, None).await.unwrap();
    assert!(start.entries.is_empty(), "{start:?}");
    let base = start.path;

    // Ordner anlegen, Datei hochladen: Fortschritt endet bei der vollen Größe.
    let content: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let local = temp("hoch.bin");
    std::fs::write(&local, &content).unwrap();
    sftp::mkdir(&sftp, &format!("{base}/ordner")).await.unwrap();
    let mut steps = vec![];
    sftp::upload(&sftp, &local, &format!("{base}/ordner/datei.bin"), |done, total| steps.push((done, total)))
        .await
        .unwrap();
    assert_eq!(steps.last(), Some(&(200_000, 200_000)));
    assert_eq!(std::fs::read(remote_dir.join("ordner/datei.bin")).unwrap(), content);

    // Auflistung: Ordner zuerst, Größe stimmt, ".." wird aufgelöst.
    std::fs::write(remote_dir.join("a.txt"), "x").unwrap();
    let top = sftp::list(&sftp, Some(&base)).await.unwrap();
    let names: Vec<_> = top.entries.iter().map(|e| (e.name.as_str(), e.is_dir)).collect();
    assert_eq!(names, [("ordner", true), ("a.txt", false)]);
    let inner = sftp::list(&sftp, Some(&format!("{base}/ordner/../ordner"))).await.unwrap();
    assert_eq!(inner.path, format!("{base}/ordner"));
    assert_eq!((inner.entries[0].name.as_str(), inner.entries[0].size), ("datei.bin", 200_000));

    // Herunterladen liefert dieselben Bytes und hinterlässt keine .part-Datei.
    let back = temp("runter.bin");
    sftp::download(&sftp, &format!("{base}/ordner/datei.bin"), &back, |_, _| {}).await.unwrap();
    assert_eq!(std::fs::read(&back).unwrap(), content);
    assert!(!temp("runter.bin.part").exists());

    // Schlägt das Herunterladen fehl, bleibt eine vorhandene Datei unverändert.
    assert!(sftp::download(&sftp, &format!("{base}/gibt-es-nicht"), &back, |_, _| {}).await.is_err());
    assert_eq!(std::fs::read(&back).unwrap(), content);

    // Umbenennen und Datei löschen.
    sftp::rename(&sftp, &format!("{base}/a.txt"), &format!("{base}/b.txt")).await.unwrap();
    assert!(remote_dir.join("b.txt").exists() && !remote_dir.join("a.txt").exists());
    sftp::delete_file(&sftp, &format!("{base}/b.txt")).await.unwrap();

    // Ein voller Ordner mit Unterordnern verschwindet in einem Zug, auch mit Leer- und Anführungszeichen im Namen.
    let tricky = remote_dir.join("it's ein ordner");
    std::fs::create_dir_all(tricky.join("tief/tiefer")).unwrap();
    for i in 0..300 {
        std::fs::write(tricky.join(format!("tief/datei{i}")), "x").unwrap();
    }
    std::fs::write(remote_dir.join("bleibt.txt"), "x").unwrap();
    ssh::remove_tree(&handle, &format!("{base}/it's ein ordner")).await.unwrap();
    ssh::remove_tree(&handle, &format!("{base}/ordner")).await.unwrap();
    let rest = sftp::list(&sftp, None).await.unwrap();
    assert_eq!(rest.entries.len(), 1);
    assert_eq!(rest.entries[0].name, "bleibt.txt");

    // Leerer Ordner geht über SFTP, ein voller wird dort abgelehnt (dann übernimmt remove_tree).
    std::fs::create_dir_all(remote_dir.join("leer")).unwrap();
    std::fs::create_dir_all(remote_dir.join("voll/innen")).unwrap();
    sftp::delete_empty_dir(&sftp, &format!("{base}/leer")).await.unwrap();
    assert!(sftp::delete_empty_dir(&sftp, &format!("{base}/voll")).await.is_err());
    assert!(!remote_dir.join("leer").exists() && remote_dir.join("voll/innen").exists());

    // Wurzel und unvollständige Pfade werden nie gelöscht.
    assert!(ssh::remove_tree(&handle, "/").await.is_err());
    assert!(ssh::remove_tree(&handle, "ordner").await.is_err());
    assert!(ssh::remove_tree(&handle, "").await.is_err());
}
