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

## Veröffentlichen
Hostess sucht beim Start und danach alle 6 Stunden unter `https://sharko-it.de/hostess/dl/latest.json` nach einer
neueren Version und installiert sie nach einem Klick. Der Installer muss mit dem privaten Schlüssel signiert sein,
dessen öffentlicher Teil in `tauri.conf.json` steht. Der private Schlüssel liegt außerhalb des Repos.

1. Nummer in `src-tauri/Cargo.toml` erhöhen.
2. Signiert bauen (PowerShell, in `src-tauri`). Für die Spracherkennung auf der Grafikkarte braucht der Bau das
   Vulkan SDK (`winget install KhronosGroup.VulkanSDK`, setzt `VULKAN_SDK`) und Ninja. `build.cmd` richtet die
   MSVC-Umgebung ein, nimmt Ninja und den kurzen Bauordner `C:\ht`: mit MSBuild oder im Projektordner werden die
   Pfade der Vulkan-Shader länger als die 260 Zeichen, die Windows erlaubt.
   ```
   $env:TAURI_SIGNING_PRIVATE_KEY = "<Pfad zur Schlüsseldatei>"
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
   .\build.cmd cargo tauri build
   ```
3. Unter `C:\ht\release\bundle\nsis` liegen danach `Hostess_<Version>_x64-setup.exe` und daneben
   `Hostess_<Version>_x64-setup.exe.sig`.
4. Die `-setup.exe` auf den Server legen und zuletzt die `latest.json` ersetzen:
   ```json
   {
     "version": "<Version>",
     "notes": "Was neu ist, in einem Satz",
     "pub_date": "2026-01-31T12:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<Inhalt der .sig-Datei>",
         "url": "https://sharko-it.de/hostess/dl/Hostess_<Version>_x64-setup.exe"
       }
     }
   }
   ```

Die Daten in `%APPDATA%\de.hostess.client` fasst ein Update nicht an.

## Versionen
Siehe [CHANGELOG.md](CHANGELOG.md). Die Nummer steht nur in `src-tauri/Cargo.toml`.
