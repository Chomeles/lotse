import { api } from '../api.js';
import { ask, esc, openDialog } from '../dialog.js';

const size = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i += 1;
  }
  return `${bytes.toLocaleString('de-DE', { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
};
const date = (seconds) =>
  seconds ? new Date(seconds * 1000).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '';

const askName = async (title, value = '') => {
  const { action, data } = await openDialog(`
    <h2>${esc(title)}</h2>
    <label><span>Name</span><input name="name" required pattern="[^/]+" title="Ohne Schrägstrich" value="${esc(value)}" autofocus></label>
    <div class="buttons">
      <button value="" formnovalidate>Abbrechen</button>
      <button value="ok" class="primary">OK</button>
    </div>`).done;
  return action === 'ok' ? data.name.trim() : null;
};

// Dateimanager einer Verbindung. `getId()` liefert die Verbindungsnummer oder null, wenn getrennt.
export function createFiles(el, getId) {
  el.innerHTML = `
    <div class="files-bar">
      <button type="button" data-act="up" aria-label="Einen Ordner nach oben" title="Nach oben">↑</button>
      <input class="path" aria-label="Ordner auf dem Server" spellcheck="false">
      <button type="button" data-act="reload">Aktualisieren</button>
      <button type="button" data-act="mkdir">Neuer Ordner</button>
      <button type="button" data-act="upload" class="primary">Hochladen</button>
    </div>
    <div class="files-list">
      <table>
        <thead><tr><th>Name</th><th class="size">Größe</th><th class="date">Geändert</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="files-msg" role="status"></div>`;
  const pathInput = el.querySelector('.path');
  const body = el.querySelector('tbody');
  const msg = el.querySelector('.files-msg');
  let path = null;
  let entries = [];
  let busy = false;

  const say = (text, error = false) => {
    msg.textContent = text;
    msg.classList.toggle('error', error);
  };
  const join = (name) => `${path === '/' ? '' : path}/${name}`;

  function render() {
    pathInput.value = path;
    body.replaceChildren(...entries.map((entry) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="name"><button type="button" data-act="open">${entry.is_dir ? '📁' : '📄'} ${esc(entry.name)}</button></td>
        <td class="size">${entry.is_dir ? '' : size(entry.size)}</td>
        <td class="date">${date(entry.modified)}</td>
        <td class="actions">
          ${entry.is_dir ? '' : '<button type="button" data-act="download">Herunterladen</button>'}
          <button type="button" data-act="rename">Umbenennen</button>
          <button type="button" data-act="delete" class="danger">Löschen</button>
        </td>`;
      tr.addEventListener('click', (e) => run(e.target.dataset.act, entry));
      return tr;
    }));
  }

  async function load(target) {
    const listing = await api.sftpList(getId(), target);
    path = listing.path;
    entries = listing.entries;
    render();
  }

  const actions = {
    open: (entry) => (entry.is_dir ? load(join(entry.name)) : actions.download(entry)),
    up: () => load(`${path}/..`),
    reload: () => load(path),
    go: () => load(pathInput.value),
    async mkdir() {
      const name = await askName('Neuer Ordner');
      if (!name) return;
      await api.sftpMkdir(getId(), join(name));
      await load(path);
    },
    async rename(entry) {
      const name = await askName(`„${entry.name}“ umbenennen`, entry.name);
      if (!name || name === entry.name) return;
      await api.sftpRename(getId(), join(entry.name), join(name));
      await load(path);
    },
    async delete(entry) {
      let what = `Datei „${entry.name}“`;
      if (entry.is_dir) {
        // Vorher nachsehen, damit die Rückfrage sagt, was wirklich verschwindet.
        const inside = await api.sftpList(getId(), join(entry.name)).then((l) => l.entries.length, () => null);
        if (inside === 0) what = `Leeren Ordner „${entry.name}“`;
        else if (inside === null) what = `Ordner „${entry.name}“ samt Inhalt (nicht einsehbar)`;
        else what = `Ordner „${entry.name}“ samt Inhalt (${inside} ${inside === 1 ? 'Eintrag' : 'Einträge'} auf oberster Ebene)`;
      }
      if (!(await ask(`${what} auf dem Server löschen? Das lässt sich nicht rückgängig machen.`))) return;
      await api.sftpDelete(getId(), join(entry.name), entry.is_dir);
      await load(path);
    },
    async upload() {
      const local = await window.__TAURI__.dialog.open({ title: 'Datei hochladen', multiple: false });
      if (!local) return;
      const name = local.split(/[\\/]/).pop();
      if (entries.some((e) => e.name === name) && !(await ask(`„${name}“ gibt es auf dem Server schon. Überschreiben?`))) return;
      await api.sftpUpload(getId(), local, join(name), (pct) => say(`Lade hoch: ${name} – ${pct} %`));
      await load(path);
      return `Hochgeladen: ${name}`;
    },
    async download(entry) {
      const local = await window.__TAURI__.dialog.save({ title: 'Speichern unter', defaultPath: entry.name });
      if (!local) return;
      await api.sftpDownload(getId(), join(entry.name), local, (pct) => say(`Lade herunter: ${entry.name} – ${pct} %`));
      return `Gespeichert: ${local}`;
    },
  };

  // Führt eine Aktion aus, immer nur eine zur Zeit, und zeigt Ergebnis oder Fehler in der Statuszeile.
  async function run(act, entry) {
    if (!actions[act]) return;
    if (busy) return say('Bitte warten, es läuft noch ein Vorgang.');
    if (!getId()) return say('Nicht verbunden.', true);
    busy = true;
    try {
      say((await actions[act](entry)) ?? '');
    } catch (e) {
      say(String(e), true);
    } finally {
      busy = false;
    }
  }

  el.querySelector('.files-bar').addEventListener('click', (e) => run(e.target.dataset.act));
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run('go');
  });

  return { show: () => run('reload') };
}
