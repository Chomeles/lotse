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

// Kleines Menü an der Mausposition. `items` sind [Text, Symbol, Aktion, Klasse]. Es schließt bei Auswahl,
// Klick daneben, Esc, Scrollen oder wenn das Fenster den Fokus verliert.
function showMenu(x, y, items) {
  document.querySelector('.menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  const off = new AbortController();
  // Erst die Lauscher lösen: das Entfernen nimmt dem Knopf den Fokus und würde `close` sonst erneut auslösen.
  const close = () => {
    off.abort();
    menu.remove();
  };
  for (const [label, symbol, run, cls = ''] of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = cls;
    button.setAttribute('role', 'menuitem');
    button.innerHTML = icon(symbol) + esc(label);
    button.addEventListener('click', () => {
      close();
      run();
    });
    menu.append(button);
  }
  document.body.append(menu);
  // Am Fensterrand nach innen rücken, damit nichts abgeschnitten wird.
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector('button').focus();
  const opts = { signal: off.signal, capture: true };
  window.addEventListener('pointerdown', (e) => menu.contains(e.target) || close(), opts);
  window.addEventListener('keydown', (e) => e.key === 'Escape' && close(), opts);
  window.addEventListener('wheel', close, opts);
  window.addEventListener('blur', (e) => e.target === window && close(), opts);
  window.addEventListener('resize', close, opts);
}

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
    <div class="list" tabindex="0" aria-label="Dateien, Mehrfachauswahl mit Strg oder Umschalt" aria-multiselectable="true"><div class="none"><span class="dot a big"></span>Ordner wird geladen …</div></div>
    <div class="sbar" role="status">
      <span class="smsg"></span>
      <div class="bar" hidden><span></span></div>
      <span class="mono pct" hidden></span>
      <span class="ssel" hidden>
        <button type="button" class="btn sm" data-act="downloadSel">${icon('download')}Herunterladen</button>
        <button type="button" class="btn sm danger" data-act="deleteSel">${icon('trash')}Löschen</button>
      </span>
      <span class="sdisk" hidden></span>
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
  const diskLabel = status.querySelector('.sdisk');
  // Mehrfachauswahl wie im Explorer: Namen der markierten Einträge und die Zeile, von der Umschalt aus zählt.
  const selected = new Set();
  let anchor = null;
  const chosen = () => entries.filter((e) => selected.has(e.name));

  // Zeigt die Auswahl in der Liste und in der Statuszeile.
  const mark = () => {
    [...list.children].forEach((row, i) => {
      const on = selected.has(entries[i]?.name);
      row.classList.toggle('sel', on);
      row.setAttribute('aria-selected', on);
    });
    if (!busy) say('');
  };
  // Klick auf Zeile `i`: allein wählt nur sie, Strg nimmt sie dazu oder heraus, Umschalt wählt den Bereich
  // ab der zuletzt angeklickten Zeile (mit Strg zusätzlich zur bisherigen Auswahl).
  const pick = (i, e) => {
    if (e.shiftKey && anchor !== null) {
      if (!e.ctrlKey) selected.clear();
      for (let n = Math.min(anchor, i); n <= Math.max(anchor, i); n++) selected.add(entries[n].name);
    } else if (e.ctrlKey) {
      if (!selected.delete(entries[i].name)) selected.add(entries[i].name);
      anchor = i;
    } else {
      selected.clear();
      selected.add(entries[i].name);
      anchor = i;
    }
    mark();
  };

  // Rechts in der Statuszeile: freier Platz auf dem Datenträger des Ordners, gelb ab 90 % belegt, rot ab 97 %.
  // Meldet der Server nichts (kein OpenSSH), bleibt die Stelle leer.
  const showDisk = (disk, mode) => {
    diskLabel.hidden = !disk;
    if (!disk) return;
    const used = Math.round((1 - disk.free / disk.total) * 100);
    diskLabel.textContent = `${size(disk.free)} frei von ${size(disk.total)}`;
    diskLabel.className = `sdisk ${used >= 97 ? 'r' : used >= 90 ? 'a' : ''}`;
    diskLabel.title = `Datenträger zu ${used} % belegt${mode === null ? '' : ` · Rechte des Ordners: ${mode.toString(8).padStart(3, '0')}`}`;
  };

  // Statuszeile: ohne Text steht dort, was der Ordner enthält.
  const say = (text, error = false) => {
    const dirs = entries.filter((e) => e.is_dir).length;
    const bytes = entries.reduce((sum, e) => sum + (e.is_dir ? 0 : e.size), 0);
    const picked = chosen();
    const pickedBytes = picked.reduce((sum, e) => sum + (e.is_dir ? 0 : e.size), 0);
    const rest = path === null ? ''
      : picked.length ? `${picked.length} ausgewählt${pickedBytes ? ` · ${size(pickedBytes)}` : ''}`
        : `${count(dirs, 'Ordner', 'Ordner')}, ${count(entries.length - dirs, 'Datei', 'Dateien')}${bytes ? ` · ${size(bytes)}` : ''}`;
    status.querySelector('.ssel').hidden = Boolean(text) || !picked.length;
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
    list.replaceChildren(...entries.map((entry, i) => {
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
      // Wie im Explorer: ein Klick wählt aus (mit Strg oder Umschalt mehrere), ein Doppelklick öffnet.
      // Die Symbole rechts wirken sofort.
      row.addEventListener('click', (e) => {
        const act = e.target.dataset.act;
        if (act && act !== 'open') return run(act, entry);
        pick(i, e);
        list.focus();
      });
      row.addEventListener('dblclick', (e) => {
        if (!e.ctrlKey && !e.shiftKey && !e.target.closest('.acts')) run('open', entry);
      });
      // Umschalt + Klick würde sonst Text in der Liste markieren.
      row.addEventListener('mousedown', (e) => e.shiftKey && e.preventDefault());
      // Rechtsklick: dieselben Aktionen wie die Symbole rechts, als Menü. Auf einer Mehrfachauswahl gelten sie
      // für alle markierten Einträge.
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (selected.size > 1 && selected.has(entry.name)) {
          return showMenu(e.clientX, e.clientY, [
            [`${selected.size} herunterladen`, 'download', () => run('downloadSel')],
            [`${selected.size} löschen`, 'trash', () => run('deleteSel'), 'del'],
          ]);
        }
        showMenu(e.clientX, e.clientY, [
          entry.is_dir ? ['Öffnen', 'folder', () => run('open', entry)] : ['Herunterladen', 'download', () => run('download', entry)],
          ['Umbenennen', 'edit', () => run('rename', entry)],
          ['Löschen', 'trash', () => run('delete', entry), 'del'],
        ]);
      });
      return row;
    }));
  }

  async function load(target) {
    const listing = await api.sftpList(getId(), target);
    path = listing.path;
    entries = listing.entries;
    // Die Auswahl gilt nur für das, was gerade zu sehen ist.
    selected.clear();
    anchor = null;
    showDisk(listing.disk, listing.mode);
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
      // Der volle Pfad steht dabei, weil gleiche Namen in verschiedenen Ordnern vorkommen. Ordner direkt unter /
      // sind fast immer Systemordner und bekommen eine eigene Warnung.
      const warning = [
        join(entry.name),
        'Das passiert auf dem Server und lässt sich nicht rückgängig machen. Einen Papierkorb gibt es dort nicht.',
        entry.is_dir && path === '/' ? 'Achtung: Dieser Ordner liegt direkt unter /. Das ist vermutlich ein Systemordner.' : '',
      ].filter(Boolean).join('\n\n');
      if (!(await ask(`${what} löschen?`, warning, 'Löschen', true))) return;
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
    // Alle markierten Dateien in einen Ordner auf diesem Rechner. Ordner lädt Hostess nicht herunter.
    async downloadSel() {
      const files = chosen().filter((e) => !e.is_dir);
      const skipped = selected.size - files.length;
      if (!files.length) throw 'Ordner lassen sich nicht herunterladen, nur Dateien.';
      const dir = await window.__TAURI__.dialog.open({ title: `${count(files.length, 'Datei', 'Dateien')} speichern in`, directory: true });
      if (!dir) return;
      let done = 0;
      for (const file of files) {
        const nth = files.length > 1 ? ` (${done + 1} von ${files.length})` : '';
        await api.sftpDownload(getId(), join(file.name), `${dir}\\${file.name}`, (percent) => progress(`${file.name} wird heruntergeladen${nth}`, percent));
        done += 1;
      }
      return `${count(done, 'Datei', 'Dateien')} heruntergeladen nach ${dir}${skipped ? ` · ${count(skipped, 'Ordner', 'Ordner')} übersprungen` : ''}`;
    },
    async deleteSel() {
      const picked = chosen();
      if (!picked.length) return;
      if (picked.length === 1) return actions.delete(picked[0]);
      const dirs = picked.filter((e) => e.is_dir).length;
      const names = picked.slice(0, 8).map((e) => (e.is_dir ? `${e.name}/` : e.name)).join('\n');
      const warning = [
        `In ${path}:\n${names}${picked.length > 8 ? `\n… und ${picked.length - 8} weitere` : ''}`,
        dirs ? `${count(dirs, 'Ordner wird', 'Ordner werden')} samt Inhalt gelöscht.` : '',
        'Das passiert auf dem Server und lässt sich nicht rückgängig machen. Einen Papierkorb gibt es dort nicht.',
        dirs && path === '/' ? 'Achtung: Diese Ordner liegen direkt unter /. Das sind vermutlich Systemordner.' : '',
      ].filter(Boolean).join('\n\n');
      if (!(await ask(`${picked.length} Einträge löschen?`, warning, 'Löschen', true))) return;
      let done = 0;
      try {
        for (const entry of picked) {
          await api.sftpDelete(getId(), join(entry.name), entry.is_dir);
          done += 1;
        }
      } finally {
        // Auch nach einem Fehler zeigen, was schon weg ist.
        await load(path).catch(() => {});
      }
      return `${count(done, 'Eintrag', 'Einträge')} gelöscht`;
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
  status.addEventListener('click', (e) => run(e.target.dataset.act));
  // Tastatur in der Liste: Strg + A wählt alles, Esc hebt die Auswahl auf, Entf löscht sie, Enter öffnet den
  // einen gewählten Eintrag, Rücktaste geht einen Ordner nach oben.
  list.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      for (const entry of entries) selected.add(entry.name);
      mark();
    } else if (e.key === 'Escape' && selected.size) {
      selected.clear();
      mark();
    } else if (e.key === 'Delete' && selected.size) {
      run('deleteSel');
    } else if (e.key === 'Enter' && selected.size === 1) {
      run('open', chosen()[0]);
    } else if (e.key === 'Backspace') {
      run('up');
    }
  });
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run('go');
  });

  return { show: () => run('reload'), drop: (paths) => run('upload', undefined, paths) };
}
