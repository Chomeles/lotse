# Änderungen

Versionen nach SemVer. Die Nummer steht nur in `src-tauri/Cargo.toml`.
Solange 0.x: neue Funktion = zweite Stelle, Fehlerbehebung = dritte Stelle.
Jede Version bekommt einen Eintrag hier und einen Git-Tag `vX.Y.Z`.

## 0.10.0 – 2026-11-13
- Dateimanager: Mehrfachauswahl wie im Explorer. Strg + Klick nimmt einen Eintrag dazu oder heraus, Umschalt + Klick wählt den Bereich, Strg + A alles, Esc hebt auf. Die Statuszeile zeigt Anzahl und Größe der Auswahl mit „Herunterladen“ und „Löschen“; dasselbe per Rechtsklick und mit Entf. Mehrere Dateien landen in einem Ordner, den man einmal wählt; gelöscht wird nach einer Rückfrage, die die Einträge nennt
- Verwaltung, Spracheingabe: die Sprache lässt sich fest wählen (Deutsch, English und 12 weitere) statt „Automatisch erkennen“. Fest gewählt ist die Erkennung schneller und rutscht bei kurzen Sätzen nicht in eine andere Sprache

## 0.9.0 – 2026-11-13
- Dateimanager: unten rechts steht, wie viel Platz auf dem Datenträger des offenen Ordners frei ist (gelb ab 90 % belegt, rot ab 97 %), daneben die Größe der Dateien im Ordner; der Tooltip nennt Belegung und Rechte des Ordners. Hostess liest das nur über die bestehende Verbindung und installiert nichts auf dem Server; meldet ein Server die Werte nicht, bleibt die Stelle leer

## 0.8.0 – 2026-11-13
- Spracheingabe live: Der Text erscheint schon beim Sprechen, Wort für Wort, und wird nachgebessert, sobald mehr vom Satz bekannt ist. Nach einer Sprechpause steht ein Abschnitt fest. Der Mikrofon-Knopf ist nur noch an (rot) oder aus; er pulsiert mit der Lautstärke
- Das Mikrofon bleibt an, bis man es ausschaltet (spätestens nach 10 Minuten)
- Der Text wird wie getippt geschickt, nicht mehr als Einfügung: Korrekturen kommen als Rücktaste an

## 0.7.0 – 2026-11-13
- Die Spracherkennung rechnet jetzt auf der Grafikkarte (Vulkan: AMD, NVIDIA, Intel). Gemessen auf einer Radeon RX 7900 XT braucht ein Satz von 5 Sekunden mit „Klein“ 0,1 s, „Mittel“ 0,2 s, „Groß“ 0,8 s, „Maximal“ 0,3 s. Ohne passende Grafikkarte rechnet wie bisher der Prozessor; zu installieren ist nichts
- Verwaltung, Spracheingabe: zeigt, ob Grafikkarte oder Prozessor rechnet. Mit eigener Grafikkarte wird „Maximal“ empfohlen

## 0.6.3 – 2026-11-13
- Behoben: Die Spracherkennung war um ein Vielfaches zu langsam (ein Satz mit dem Modell „Groß“ über zwei Minuten), weil die Whisper-Bibliothek ohne Optimierung übersetzt wurde. Jetzt braucht „Klein“ etwa 1 Sekunde, „Mittel“ etwa 4, „Groß“ etwa 20 (gemessen auf einem Ryzen 7 mit 8 Kernen)
- Verwaltung, Spracheingabe: „Mikrofon testen“ zeigt, welches Mikrofon Hostess benutzt, den Pegel in Echtzeit und ob du gut zu verstehen bist
- Beim Aufnehmen wächst ein Ring um den Mikrofon-Knopf mit der Lautstärke; beim Erkennen zählt der Knopf die Sekunden. Kam kein Ton an, sagt Hostess das und nennt das Mikrofon, statt nichts zu tun
- Empfohlen wird jetzt „Mittel“ (ab 8 Kernen) oder „Klein“; die Beschreibungen der großen Modelle sagen ehrlich, dass sie langsam sind

## 0.6.2 – 2026-11-13
- Die Passphrase gilt wieder je Schlüsseldatei, wie bis 0.6.0: einmal entsperrt oder gespeichert, verbinden alle Hosts mit genau dieser Datei ohne Nachfrage. Andere Schlüssel bleiben gesperrt. Die Umstellung auf „je Host“ aus 0.6.1 ist zurückgenommen

## 0.6.1 – 2026-11-13
- Behoben: Eine gespeicherte Passphrase galt für alle Hosts mit derselben Schlüsseldatei, auch wenn sie nur bei einem gespeichert wurde. Gemerkt und gespeichert wird jetzt je Host; nach dem Update fragt jeder Host einmal neu
- Wenige, kurze Übergänge (160 ms): Dialoge und Rechtsklick-Menü blenden weich ein, Reiter-Inhalt und der Wechsel Terminal ↔ Dateien blenden über, der Statuspunkt im Reiter pulst einmal beim Verbinden, Fortschrittsbalken gleiten, Knöpfe geben beim Drücken minimal nach. Wer in Windows Animationen abgeschaltet hat, bekommt keine

## 0.6.0 – 2026-11-13
- Spracheingabe: Mikrofon-Knopf rechts in der Kopfzeile des Reiters (oder Strg + Umschalt + M) nimmt auf, der erkannte Text landet an der Schreibmarke, ohne Enter. Die Erkennung läuft mit Whisper auf dem eigenen Rechner, es wird nichts hochgeladen
- Verwaltung, neuer Bereich „Spracheingabe“: vier Modelle von 148 MB bis 1,6 GB auf einem Regler, mit Genauigkeit, Tempo und Empfehlung für den eigenen Rechner. Das Modell wird einmalig geladen und bleibt, bis man es löscht; Wechseln lädt nie neu, ein abgebrochener Download wird fortgesetzt und läuft weiter, wenn die Verwaltung zu ist
- Automatische Updates: Hostess prüft beim Start und alle 6 Stunden, zeigt „Version … verfügbar“ unten in der Seitenleiste und installiert auf Klick; Hosts, Einstellungen, Passphrasen und Sprachmodelle bleiben erhalten. Updates sind signiert und kommen von `sharko-it.de/hostess`. In der Verwaltung gibt es „Nach Updates suchen“
- Die Webseite liegt jetzt unter https://sharko-it.de/hostess/

## 0.5.0 – 2026-11-13
- Das Programm heißt jetzt „Hostess“ statt „Lotse“ (Fenster, Installer, Programmdatei `hostess.exe`, Webseite). Daten und gespeicherte Passphrasen ziehen beim ersten Start von selbst um: der Ordner `%APPDATA%\de.lotse.client` wird zu `de.hostess.client`, Einträge „Lotse“ in der Windows-Anmeldeinformationsverwaltung werden zu „Hostess“
- Die Umgebungsvariablen heißen `HOSTESS_DATA_DIR` und `HOSTESS_SSH_DIR`; neue Installationen laden eingefügte Dateien nach `~/hostess-paste` (eine schon gespeicherte Einstellung bleibt)
- Hostliste: unter dem Statuspunkt eines verbundenen Hosts steht die Antwortzeit der SSH-Verbindung, alle 5 Sekunden neu gemessen; grün unter 200 ms, gelb ab 200 ms, rot ab 1 s oder wenn der Server 5 s lang nicht antwortet

## 0.4.0 – 2026-11-12
- Neues Aussehen nach dem Design-Entwurf: eigene Titelleiste mit Reitern und Fensterknöpfen, Statuspunkte (verbunden, verbindet, getrennt) in Hostliste, Reiter und Kopfzeile, Leerzustand mit Tastenkürzeln, Dateimanager mit Symbolknöpfen und Fortschrittsbalken, Suche mit Trefferzahl, neues Logo und App-Icon
- „Verwaltung“ statt Einstellungs-Dialog: Bereiche links, Einstellungen wirken sofort (kein Speichern-Knopf), öffentlicher Schlüssel klappt in der Karte auf
- Alle Rückfragen (Löschen, Überschreiben) sind eigene Dialoge im selben Stil statt Windows-Meldungen
- „Aus SSH-Config importieren“ sitzt jetzt im Dialog „Neuer Host“ statt als eigener Knopf in der Seitenleiste
- Dateimanager: Rechtsklick auf eine Zeile öffnet ein Menü mit Öffnen oder Herunterladen, Umbenennen und Löschen; das Standardmenü des Browsers erscheint nirgends mehr (außer in Textfeldern)
- Passphrase und Passwort lassen sich speichern: Haken im Dialog, abgelegt in der Windows-Anmeldeinformationsverwaltung (verschlüsselt mit dem Windows-Konto, nie in `store.json`); stimmt ein gespeichertes Geheimnis nicht mehr, wird es verworfen und neu gefragt
- Tastenton entfernt (samt Schalter in den Einstellungen)
- Behoben: Enter in einem Dialogfeld löst die Hauptaktion aus (Entsperren, Speichern) statt „Abbrechen“ oder „Löschen“; dadurch schien die Passphrase nicht zu stimmen

## 0.3.0 – 2026-11-12
- Anmeldung mit Passwort: ein Host ohne Schlüsseldatei fragt nach dem Passwort (gemerkt nur im Arbeitsspeicher, nie gespeichert); Server, die nur Schlüssel erlauben, bekommen eine klare Meldung
- „Einstellungen“ ist jetzt ein Fenster mit drei Bereichen: Einstellungen, Schlüssel, Bekannte Hosts
- Schlüssel: Liste aus `~/.ssh` mit Typ, Fingerabdruck, Passphrase-Schutz und zugehörigen Hosts; öffentlichen Schlüssel anzeigen und kopieren, neuen ED25519-Schlüssel erzeugen (überschreibt nie etwas), Schlüssel löschen mit Rückfrage; das Host-Formular bietet die Schlüssel zur Auswahl an
- IPv4-Adressen in der Terminal-Ausgabe erscheinen pink, wie in Termius; Farben vom Server bleiben
- Datei ins Terminal ziehen oder Bild aus der Zwischenablage einfügen: Lotse lädt es im Hintergrund nach `~/lotse-paste` (einstellbar) und schreibt den Pfad an die Schreibmarke, z. B. für Claude Code auf dem Server; mit Fortschritt, Abbrechen und ohne je etwas zu überschreiben. Ziehen auf den Dateimanager lädt in den offenen Ordner
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
