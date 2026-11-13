# Hostess

Eigener SSH-Client für Windows: Terminal, Hostliste und Dateimanager in einem kleinen Programm.
Gebaut mit Tauri 2 (Rust) und xterm.js, ohne Node und ohne Bundler.

## Starten und bauen
Voraussetzung: Rust (`rustup`), die C++-Build-Tools von Visual Studio, einmalig `cargo install tauri-cli --locked`.

```bash
cd src-tauri
cargo run            # Entwicklung
cargo test           # Tests
cargo tauri build    # Installer unter target/release/bundle/nsis
```

Die Oberfläche in `ui/` wird beim Kompilieren eingebettet. Nach Änderungen dort einfach neu `cargo run`.

## Aufbau
- `src-tauri/src/`: je Funktion eine Datei (`ssh.rs`, `known_hosts.rs`, `keys.rs`, `sftp.rs`, `paste.rs`, `hosts.rs`, `store.rs`). Nur `commands.rs` kennt Tauri.
- `ui/`: `app.js` (Reiter, Verbinden), `api.js` (alle Aufrufe ans Backend), `views/` (je Ansicht eine Datei), `theme.js` (Farben).
- Neue Funktion = neue Rust-Datei, ein paar Zeilen in `commands.rs` und `lib.rs`, eine Ansicht.

## Daten
`%APPDATA%\de.hostess.client\store.json` (Hosts, Einstellungen) und `known_hosts` daneben.
Die Umgebungsvariable `HOSTESS_DATA_DIR` lenkt den Ordner um, zum Beispiel für Tests.
Schlüssel und SSH-Config liest Hostess aus `~/.ssh`; `HOSTESS_SSH_DIR` lenkt auch das um.

## Testen ohne echten Server
`cargo run --example testserver` startet einen SSH-Server auf `127.0.0.1:2222`, der Eingaben zurückschickt,
und gibt Testschlüssel aus. Für SFTP und Befehle nutzt er `sftp-server.exe` und `bash.exe` von Git für Windows.
Strg + D beendet dort die Shell wie `exit`.

## Versionen
Siehe [CHANGELOG.md](CHANGELOG.md). Die Nummer steht nur in `src-tauri/Cargo.toml`.
