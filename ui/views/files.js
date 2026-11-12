import { api } from '../api.js';
import { ask, esc, openDialog } from '../dialog.js';
import { icon } from '../icons.js';

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
  seconds
    ? new Date(seconds * 1000)
      .toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      .replace(',', '')
    : '';
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const askName = async (title, value = '', ok = 'OK') => {
  const { action, data } = await openDialog(`
    <h2>${esc(title)}</h2>
    <label class="field"><span>Name</span>
      <input class="in mono" name="name" required pattern="[^/]+" title="Ohne Schrägstrich" value="${esc(value)}" spellcheck="false" autofocus></label>
    <div class="acts">
      <button value="" formnovalidate class="btn">Abbrechen</button>
      <button value="ok" class="btn pri">${ok}</button>
    </div>`).done;
  return action === 'ok' ? data.name.trim() : null;
};

// Dateimanager einer Verbindung. `getId()` liefert die Verbindungsnummer oder null, wenn getrennt.
export function createFiles(el, getId) {
  el.innerHTML = `
    <div class="fbar">
      <button type="button" class="ib" data-act="up" aria-label="Einen Ordner nach oben" title="Nach oben">${icon('up')}</button>
      <input class="in path" aria-label="Ordner auf dem Server" spellcheck="false">
      <button type="button" class="ib" data-act="reload" aria-label="Aktualisieren" title="Aktualisieren">${icon('reload')}</button>
      <button type="button" class="btn" data-act="mkdir">${icon('folderPlus')}Neuer Ordner</button>
      <button type="button" class="btn pri" data-act="upload">${icon('upload')}Hochladen</button>
    </div>
    <div class="row th"><span>Name</span><span class="r">Größe</span><span>Geändert</span><span></span></div>
    <div class="list"><div class="none"><span class="dot a big"></span>Ordner wird geladen …</div></div>
    <div class="sbar" role="status">
      <span class="smsg"></span>
      <div class="bar" hidden><span></span></div>
      <span class="mono pct" hidden></span>
    </div>`;
  const pathInput = el.querySelector('.path');
  const list = el.querySelector('.list');
  const status = el.querySelector('.sbar');
  const bar = status.querySelector('.bar');
  const pct = status.querySelector('.pct');
  const uploadButton = el.querySelector('[data-act=upload]');
  let path = null;
  let entries = [];
  let busy = false;

  // Statuszeile: ohne Text steht dort, was der Ordner enthält.
  const say = (text, error = false) => {
    const dirs = entries.filter((e) => e.is_dir).length;
    const rest = path === null ? '' : `${count(dirs, 'Ordner', 'Ordner')}, ${count(entries.length - dirs, 'Datei', 'Dateien')}`;
    status.querySelector('.smsg').textContent = text || rest;
    status.className = `sbar ${error ? 'err' : text ? 'msg' : ''}`;
    bar.hidden = pct.hidden = true;
    uploadButton.disabled = false;
  };
  // Laufende Übertragung: Text, Balken und Prozentzahl.
  const progress = (text, percent) => {
    say(text);
    bar.hidden = pct.hidden = false;
    bar.firstChild.style.width = `${percent}%`;
    pct.textContent = `${percent} %`;
    uploadButton.disabled = true;
  };
  const note = (text) => {
    list.innerHTML = `<div class="none">${esc(text)}</div>`;
  };
  const join = (name) => `${path === '/' ? '' : path}/${name}`;

  function render() {
    pathInput.value = path;
    if (!entries.length) return note('Dieser Ordner ist leer');
    list.replaceChildren(...entries.map((entry) => {
      const name = esc(entry.name);
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <button type="button" class="nm" data-act="open">${icon(entry.is_dir ? 'folder' : 'file', entry.is_dir ? 'fold' : 'mute')}<span class="n">${name}</span></button>
        <span class="r sm">${entry.is_dir ? '–' : size(entry.size)}</span>
        <span class="sm">${date(entry.modified)}</span>
        <span class="acts">
          ${entry.is_dir ? '' : `<button type="button" class="ib" data-act="download" aria-label="${name} herunterladen" title="Herunterladen">${icon('download')}</button>`}
          <button type="button" class="ib" data-act="rename" aria-label="${name} umbenennen" title="Umbenennen">${icon('edit')}</button>
          <button type="button" class="ib del" data-act="delete" aria-label="${name} löschen" title="Löschen">${icon('trash')}</button>
        </span>`;
      row.addEventListener('click', (e) => run(e.target.dataset.act, entry));
      return row;
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
      const name = await askName('Neuer Ordner', '', 'Anlegen');
      if (!name) return;
      await api.sftpMkdir(getId(), join(name));
      await load(path);
    },
    async rename(entry) {
      const name = await askName(`„${entry.name}“ umbenennen`, entry.name, 'Umbenennen');
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
        else what = `Ordner „${entry.name}“ samt Inhalt (${count(inside, 'Eintrag', 'Einträge')} auf oberster Ebene)`;
      }
      if (!(await ask(`${what} löschen?`, 'Das passiert auf dem Server und lässt sich nicht rückgängig machen.', 'Löschen', true))) return;
      await api.sftpDelete(getId(), join(entry.name), entry.is_dir);
      await load(path);
    },
    // `dropped` sind hereingezogene Dateien; ohne sie fragt der Auswahldialog.
    async upload(_, dropped) {
      const locals = dropped ?? await window.__TAURI__.dialog.open({ title: 'Dateien hochladen', multiple: true });
      if (!locals?.length) return;
      let done = 0;
      try {
        for (const local of locals) {
          const name = local.split(/[\\/]/).pop();
          if (entries.some((e) => e.name === name)
            && !(await ask(`„${name}“ überschreiben?`, 'Eine Datei mit diesem Namen gibt es auf dem Server schon.', 'Überschreiben', true))) continue;
          const nth = locals.length > 1 ? ` (${done + 1} von ${locals.length})` : '';
          await api.sftpUpload(getId(), local, join(name), (percent) => progress(`${name} wird hochgeladen${nth}`, percent));
          done += 1;
        }
      } finally {
        // Auch nach einem Fehler zeigen, was schon angekommen ist.
        await load(path).catch(() => {});
      }
      return done === 1 ? 'Eine Datei hochgeladen' : `${done} Dateien hochgeladen`;
    },
    async download(entry) {
      const local = await window.__TAURI__.dialog.save({ title: 'Speichern unter', defaultPath: entry.name });
      if (!local) return;
      await api.sftpDownload(getId(), join(entry.name), local, (percent) => progress(`${entry.name} wird heruntergeladen`, percent));
      return `${entry.name} heruntergeladen nach ${local}`;
    },
  };

  // Führt eine Aktion aus, immer nur eine zur Zeit, und zeigt Ergebnis oder Fehler in der Statuszeile.
  async function run(act, entry, extra) {
    if (!actions[act]) return;
    if (busy) return;
    if (!getId()) {
      if (path === null) note('Nicht verbunden');
      return say('Nicht verbunden. Der Dateimanager braucht eine offene Verbindung.', true);
    }
    busy = true;
    try {
      say((await actions[act](entry, extra)) ?? '');
    } catch (e) {
      if (path === null) note('Der Ordner konnte nicht geladen werden');
      say(String(e), true);
    } finally {
      busy = false;
    }
  }

  el.querySelector('.fbar').addEventListener('click', (e) => run(e.target.dataset.act));
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run('go');
  });

  return { show: () => run('reload'), drop: (paths) => run('upload', undefined, paths) };
}
