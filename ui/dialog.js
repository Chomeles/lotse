// Kleine Helfer rund um das <dialog>-Element des Browsers.
import { icon } from './icons.js';

export const esc = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Öffnet einen Dialog mit Formular. `done` liefert { action, data }:
// `action` ist der value des gedrückten Knopfs ('' bei Esc), `data` sind die Formularfelder.
// `cls` ist eine Zusatzklasse: 'warn' (roter Rahmen) oder 'wide' (Verwaltung).
export function openDialog(html, cls = '') {
  const dialog = document.createElement('dialog');
  dialog.className = cls;
  dialog.innerHTML = `<form method="dialog">${html}</form>`;
  document.body.append(dialog);
  dialog.showModal();
  const done = new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const data = Object.fromEntries(new FormData(dialog.querySelector('form')));
      dialog.remove();
      resolve({ action: dialog.returnValue, data });
    }, { once: true });
  });
  return { dialog, done };
}

// Rote Fehlerzeile unter einem Feld oder Titel.
export const errorHint = (text) => `<span class="hint err">${icon('warn')}${esc(text)}</span>`;

export const alertBox = (title, text) =>
  openDialog(`
    <h2>${esc(title)}</h2>
    <p class="pre">${esc(text)}</p>
    <div class="acts"><button value="ok" class="btn pri" autofocus>OK</button></div>`).done;

// Rückfrage. `danger` färbt den Bestätigungsknopf rot (für alles, was sich nicht rückgängig machen lässt).
export const ask = async (title, text = '', ok = 'OK', danger = false) =>
  (await openDialog(`
    <h2>${esc(title)}</h2>
    ${text ? `<p class="pre">${esc(text)}</p>` : ''}
    <div class="acts">
      <button value="" class="btn" autofocus>Abbrechen</button>
      <button value="ok" class="btn ${danger ? 'dfill' : 'pri'}">${esc(ok)}</button>
    </div>`).done).action === 'ok';
