# Änderungen

Versionen nach SemVer. Die Nummer steht nur in `src-tauri/Cargo.toml`.
Solange 0.x: neue Funktion = zweite Stelle, Fehlerbehebung = dritte Stelle.
Jede Version bekommt einen Eintrag hier und einen Git-Tag `vX.Y.Z`.

## 0.3.0 – 2026-11-12
- Anmeldung mit Passwort: ein Host ohne Schlüsseldatei fragt nach dem Passwort (gemerkt nur im Arbeitsspeicher, nie gespeichert); Server, die nur Schlüssel erlauben, bekommen eine klare Meldung
- „Einstellungen“ ist jetzt ein Fenster mit drei Bereichen: Einstellungen, Schlüssel, Bekannte Hosts
- Schlüssel: Liste aus `~/.ssh` mit Typ, Fingerabdruck, Passphrase-Schutz und zugehörigen Hosts; öffentlichen Schlüssel anzeigen und kopieren, neuen ED25519-Schlüssel erzeugen (überschreibt nie etwas), Schlüssel löschen mit Rückfrage; das Host-Formular bietet die Schlüssel zur Auswahl an
- Bekannte Hosts: Liste mit Adresse, Port, Schlüsseltyp und Fingerabdruck, „Entfernen“ je Eintrag

## 0.2.0 – 2026-11-12
Alltags-Szenarien durchgespielt und nachgebessert.
- Passphrase wird je Schlüssel bis zum Beenden gemerkt (nur im Arbeitsspeicher): Neuverbinden und weitere Reiter fragen nicht erneut
- Nach einer getrennten Verbindung steht ein Hinweis im Terminal, Enter verbindet neu
- Strg + V fügt ein, Strg + C kopiert, wenn etwas markiert ist (sonst Abbruch wie gewohnt), Strg + Umschalt + C kopiert immer
- Strg + Tab wechselt den Reiter, Enter im Suchfeld verbindet mit dem ersten Treffer
- Adressfeld versteht `benutzer@server:port` und `ssh benutzer@server`
- Klare Meldungen: Server nimmt keine Verbindung an, Name nicht auflösbar, `.pub` statt privatem Schlüssel gewählt, Schlüsseldatei fehlt
- `~/` in Schlüsselpfaden und im Dateimanager meint den Benutzerordner
- Import: Hosts ohne `IdentityFile` bekommen den Standardschlüssel aus `~/.ssh`, Hosts mit ProxyJump werden genannt statt still falsch importiert
- Mehrere Dateien auf einmal hochladen
- Tastenton neu: weiches „Tock“ statt Rauschen, nur bei echten Tastendrücken
- Schlüsselauswahl startet im Ordner `.ssh`

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
