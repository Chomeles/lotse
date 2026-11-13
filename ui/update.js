// Auto-Update: fragt den eigenen Server nach einer neueren Version und zeigt sie unten in der Seitenleiste.
// Geladen und installiert wird erst nach einem Klick. Prüfen, Laden und die Signaturprüfung macht das
// Updater-Plugin in Rust.
import { alertBox } from './dialog.js';

const row = document.getElementById('update');
const label = row.querySelector('span');
const button = row.querySelector('button');
// Die gefundene Version, solange sie nicht installiert ist.
let found = null;
let installing = false;

// Prüft sofort. Liefert die Nummer der neueren Version oder null, wenn Hostess aktuell ist.
// Wirft, wenn die Prüfung scheitert (kein Netz, Server nicht erreichbar, kaputte Antwort).
export async function checkUpdate() {
  if (installing) return found.version;
  found = await window.__TAURI__.updater.check();
  row.hidden = !found;
  if (found) label.textContent = `Version ${found.version} verfügbar`;
  return found?.version ?? null;
}

// Prüft beim Start und danach alle 6 Stunden, ohne bei Fehlern zu stören.
// `confirm()` fragt vor dem Installieren nach, falls nötig, und liefert, ob es weitergehen darf.
export function watchUpdates(confirm) {
  const quiet = () => checkUpdate().catch((e) => console.warn('Update-Prüfung fehlgeschlagen:', e));
  quiet();
  setInterval(quiet, 6 * 60 * 60 * 1000);

  button.addEventListener('click', async () => {
    if (installing || !found || !(await confirm())) return;
    installing = true;
    button.disabled = true;
    const text = label.textContent;
    let total = 0;
    let done = 0;
    try {
      // Unter Windows beendet der Installer Hostess und startet es danach neu: hinter dieser Zeile geht es
      // nur bei einem Fehler weiter.
      await found.downloadAndInstall((e) => {
        if (e.event === 'Started') total = e.data.contentLength ?? 0;
        if (e.event === 'Progress') done += e.data.chunkLength;
        if (e.event === 'Finished') label.textContent = 'Wird installiert …';
        else label.textContent = total ? `Lädt … ${Math.floor(done * 100 / total)} %` : 'Lädt …';
      });
    } catch (e) {
      console.warn('Update fehlgeschlagen:', e);
      label.textContent = text;
      await alertBox('Update fehlgeschlagen', /signature/i.test(String(e))
        ? 'Die Signatur des Updates stimmt nicht. Es wurde nicht installiert, deine Version läuft unverändert weiter.'
        : 'Das Update ließ sich nicht laden oder installieren. Deine Version läuft unverändert weiter. Versuch es später noch einmal.');
    }
    installing = false;
    button.disabled = false;
  });
}
