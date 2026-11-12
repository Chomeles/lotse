# Änderungen

Versionen nach SemVer. Die Nummer steht nur in `src-tauri/Cargo.toml`.
Solange 0.x: neue Funktion = zweite Stelle, Fehlerbehebung = dritte Stelle.
Jede Version bekommt einen Eintrag hier und einen Git-Tag `vX.Y.Z`.

## 0.1.0 – 2026-11-12
Erstes Ergebnis.
- SSH-Verbindung per Schlüssel, Passphrase wird abgefragt und nicht gespeichert
- Known Hosts in eigener Datei, geänderter Server-Schlüssel blockiert die Verbindung
- Terminal: fester Theme, Suche (Strg + Umschalt + F), Schriftgröße (Strg + Plus/Minus), Scrollback einstellbar, Rechtsklick fügt ein, Markieren kopiert
- Hostliste mit Suche, Import aus `~/.ssh/config`, mehrere Verbindungen in Reitern
- Dateimanager: navigieren, hoch- und herunterladen mit Fortschritt, umbenennen, neuer Ordner, löschen
- Löschen nimmt immer den kürzesten Weg: Datei und leerer Ordner je eine Anfrage, voller Ordner ein einziger Befehl statt Datei für Datei. Die Rückfrage nennt, was verschwindet.
- Sehr leiser Tastenton beim Tippen, in den Einstellungen abschaltbar
- Adresse darf IPv4, IPv6 (auch in eckigen Klammern) oder ein Name sein
