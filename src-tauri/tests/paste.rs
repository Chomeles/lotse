//! Prüft „Datei oder Bild ins Terminal einfügen“ gegen den echten `sftp-server` von Git für Windows.
//! Fehlt der auf dem Rechner, wird der Test übersprungen.

mod common;

use std::sync::atomic::{AtomicBool, Ordering};

use common::{new_key, start_server, temp, write_key, SFTP_SERVER};
use hostess::{paste, sftp, ssh, store::Host};

#[tokio::test]
async fn hochladen_ohne_ueberschreiben_und_abbrechen() {
    if !std::path::Path::new(SFTP_SERVER).exists() {
        eprintln!("übersprungen: {SFTP_SERVER} fehlt");
        return;
    }
    let remote_dir = temp("paste-remote");
    let _ = std::fs::remove_dir_all(&remote_dir);
    std::fs::create_dir_all(&remote_dir).unwrap();

    let key = new_key();
    let (port, host_key) = start_server(key.public_key().clone(), 0, remote_dir.clone()).await;
    let host = Host {
        name: "test".into(),
        address: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        key_path: write_key("id_paste", &key),
    };
    let known = temp("known_hosts_paste");
    let _ = std::fs::remove_file(&known);
    let trust = Some(hostess::known_hosts::fingerprint(&host_key));
    let handle = ssh::connect(&host, None, trust, known).await.unwrap();
    let sftp = sftp::open(&handle).await.unwrap();
    let base = sftp::list(&sftp, None).await.unwrap().path;
    let go = AtomicBool::new(false);
    let target = remote_dir.join("hostess-paste");
    let files = || {
        let mut names: Vec<String> =
            std::fs::read_dir(&target).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    };

    // Der Ordner wird angelegt, die Datei kommt vollständig an, der Pfad ist absolut, keine .part bleibt liegen.
    let content: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let local = temp("mein bild.bin");
    std::fs::write(&local, &content).unwrap();
    let mut steps = vec![];
    let path = paste::upload_file(&sftp, "~/hostess-paste", &local, &go, |done, total| steps.push((done, total)))
        .await
        .unwrap();
    assert_eq!(path, format!("{base}/hostess-paste/mein bild.bin"));
    assert_eq!(steps.last(), Some(&(200_000, 200_000)));
    assert_eq!(std::fs::read(target.join("mein bild.bin")).unwrap(), content);
    assert_eq!(files(), ["mein bild.bin"]);

    // Gleicher Name noch einmal: -2 vor der Endung, die erste Datei bleibt unberührt.
    std::fs::write(&local, b"zweite").unwrap();
    let second = paste::upload_file(&sftp, "~/hostess-paste", &local, &go, |_, _| {}).await.unwrap();
    assert_eq!(second, format!("{base}/hostess-paste/mein bild-2.bin"));
    assert_eq!(std::fs::read(target.join("mein bild.bin")).unwrap(), content);
    assert_eq!(std::fs::read(target.join("mein bild-2.bin")).unwrap(), b"zweite");

    // Bildweg: Bytes aus dem Speicher kommen genau so an. Ein absoluter Zielordner geht auch.
    let png = paste::encode_png(&[7; 16], 2, 2).unwrap();
    let image = paste::upload_bytes(&sftp, &format!("{base}/hostess-paste"), "bild-2026-11-12-231405.png", &png, &go, |_, _| {})
        .await
        .unwrap();
    assert_eq!(image, format!("{base}/hostess-paste/bild-2026-11-12-231405.png"));
    assert_eq!(std::fs::read(target.join("bild-2026-11-12-231405.png")).unwrap(), png);
    let again = paste::upload_bytes(&sftp, "~/hostess-paste", "bild-2026-11-12-231405.png", &png, &go, |_, _| {}).await;
    assert_eq!(again.unwrap(), format!("{base}/hostess-paste/bild-2026-11-12-231405-2.png"));

    // Abbruch mitten in der Datei: weder Datei noch .part bleibt, vorhandene Dateien sind unberührt.
    let before = files();
    let cancel = AtomicBool::new(false);
    let mut blocks = 0;
    let stopped = paste::upload_bytes(&sftp, "~/hostess-paste", "gross.bin", &content, &cancel, |_, _| {
        blocks += 1;
        cancel.store(true, Ordering::Relaxed);
    })
    .await;
    assert_eq!(stopped, Err("Abgebrochen.".to_string()));
    assert_eq!(blocks, 1);
    assert_eq!(files(), before);

    // Schon vor dem Start abgebrochen: es wird nichts angelegt.
    assert!(paste::upload_bytes(&sftp, "~/hostess-paste", "nie.bin", &content, &cancel, |_, _| {}).await.is_err());
    assert_eq!(files(), before);

    // Ordner werden abgelehnt, ebenso Namen, die aus dem Zielordner herausführen. Tiefe Zielordner entstehen stufenweise.
    let folder = paste::upload_file(&sftp, "~/hostess-paste", &remote_dir, &go, |_, _| {}).await;
    assert_eq!(folder, Err("Ordner werden noch nicht übertragen.".to_string()));
    assert!(paste::upload_bytes(&sftp, "~/hostess-paste", "../raus.bin", b"x", &go, |_, _| {}).await.is_err());
    assert!(!remote_dir.join("raus.bin").exists());
    let deep = paste::upload_bytes(&sftp, "~/a/b/c", "x.txt", b"x", &go, |_, _| {}).await.unwrap();
    assert_eq!(deep, format!("{base}/a/b/c/x.txt"));
    assert_eq!(files(), before);
}
