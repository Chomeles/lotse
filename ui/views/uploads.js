import { api } from '../api.js';
import { icon } from '../icons.js';

// Übertragungsnummern gelten für das ganze Programm, nicht je Reiter.
let nextTransfer = 1;

const pad = (n) => String(n).padStart(2, '0');
// Name für ein Bild aus der Zwischenablage, in Ortszeit: bild-2026-11-12-231405.png
export const imageName = (d = new Date()) =>
  `bild-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;

// Uploads eines Reiters: legt Dateien oder das Bild der Zwischenablage in den Einfüge-Ordner auf dem Server
// und meldet den fertigen Pfad über `onPath`. In `parent` erscheint unten rechts je Upload eine schmale Zeile.
export function createUploads(parent, { getId, getDir, onPath }) {
  const box = document.createElement('div');
  box.className = 'uploads';
  // Vor dem Terminal im Dokument, damit die Knöpfe per Tab von der Leiste darüber erreichbar sind.
  parent.prepend(box);
  // Ein Klick in die Liste nimmt dem Terminal nicht den Fokus.
  box.addEventListener('mousedown', (e) => e.preventDefault());

  const running = new Set();
  // Einer nach dem anderen: so stehen die Pfade in der Reihenfolge der Dateien im Terminal.
  let queue = Promise.resolve();

  // `send(transfer, onProgress)` lädt hoch und liefert den Pfad-Text oder null (nichts zu tun).
  // `quiet` zeigt die Zeile erst, wenn wirklich etwas übertragen wird.
  function start(name, send, quiet = false) {
    const transfer = nextTransfer++;
    const row = document.createElement('div');
    row.className = 'up';
    row.hidden = quiet;
    row.innerHTML = `
      <div class="top">${icon('upload', 'ok')}<span class="n"></span><span class="mono mute pct">0 %</span>
        <button type="button" class="ib" title="Abbrechen">${icon('x')}</button></div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span></span></div>`;
    row.querySelector('.n').textContent = name;
    const bar = row.querySelector('.bar');
    const button = row.querySelector('button');
    const show = (percent) => {
      row.hidden = false;
      bar.firstChild.style.width = `${percent}%`;
      bar.setAttribute('aria-valuenow', percent);
      row.querySelector('.pct').textContent = `${percent} %`;
    };
    bar.setAttribute('aria-label', `Fortschritt von ${name}`);
    button.setAttribute('aria-label', `Upload von ${name} abbrechen`);
    box.append(row);

    let cancelled = false;
    let sending = false;
    const entry = {
      cancel() {
        cancelled = true;
        // Rust löscht die halbe Datei auf dem Server; wartende Uploads haben dort noch nichts angelegt.
        if (sending) api.transferCancel(transfer);
        row.remove();
      },
    };
    button.addEventListener('click', () => entry.cancel());
    running.add(entry);

    entry.done = queue = queue.then(async () => {
      if (cancelled) return;
      try {
        sending = true;
        const word = await send(transfer, show);
        sending = false;
        if (cancelled) return;
        if (word === null) return row.remove();
        show(100);
        onPath(word);
        setTimeout(() => row.remove(), 2000);
      } catch (e) {
        sending = false;
        if (cancelled) return;
        // Fehler bleiben stehen, bis man sie schließt.
        row.hidden = false;
        row.classList.add('err');
        row.querySelector('.i').outerHTML = icon('warn', 'red');
        row.querySelector('.pct').remove();
        const message = document.createElement('span');
        message.className = 'message red';
        message.setAttribute('role', 'alert');
        message.textContent = String(e);
        bar.replaceWith(message);
        button.title = 'Meldung schließen';
        button.setAttribute('aria-label', `Meldung zu ${name} schließen`);
      } finally {
        running.delete(entry);
      }
    });
  }

  const connected = () => getId() ?? Promise.reject('Dieser Reiter ist nicht verbunden.');

  return {
    // Lokale Dateien (Pfade), z. B. aus dem Explorer hereingezogen.
    files(paths) {
      for (const path of paths) {
        start(path.split(/[\\/]/).pop(), async (transfer, onProgress) =>
          api.pasteFile(await connected(), transfer, path, getDir(), onProgress));
      }
    },
    // Bild aus der Zwischenablage. Liegt dort keins, passiert nichts.
    image() {
      const name = imageName();
      // Ohne Verbindung meldet Rust den Fehler erst, wenn wirklich ein Bild da ist (0 ist nie eine Verbindung).
      start(name, (transfer, onProgress) => api.pasteImage(getId() ?? 0, transfer, getDir(), name, onProgress), true);
    },
    // Bricht alles ab. Fertig ist es erst, wenn der Server aufgeräumt hat; so lange muss die Verbindung noch stehen.
    close() {
      return Promise.allSettled([...running].map((entry) => {
        entry.cancel();
        return entry.done;
      }));
    },
  };
}
