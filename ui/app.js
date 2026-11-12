import { api } from './api.js';
import { tick } from './sound.js';
import { alertBox, errorHint, esc, openDialog } from './dialog.js';
import { icon } from './icons.js';
import { createFiles } from './views/files.js';
import { editHost, renderHosts } from './views/hosts.js';
import { openSettings } from './views/settings.js';
import { applySettings, createTerminal } from './views/terminal.js';
import { createUploads } from './views/uploads.js';

const $ = (id) => document.getElementById(id);

let store = { version: 1, hosts: [], settings: { scrollback: 10000, font_size: 14, typing_sound: true, paste_dir: '~/lotse-paste' } };
const tabs = new Set();

// ---------- Speicher und Hostliste ----------

async function save() {
  try {
    await api.storeSave(store);
  } catch (e) {
    await alertBox('Speichern fehlgeschlagen', String(e));
  }
}

// Zustand eines Hosts über alle seine Reiter: verbunden schlägt verbindet schlägt getrennt.
const hostState = (host) => {
  const states = [...tabs].filter((t) => t.host === host).map((t) => t.state);
  return ['g', 'a', 'r'].find((s) => states.includes(s)) ?? '';
};

function refreshHosts() {
  renderHosts($('host-list'), store.hosts, $('host-search').value, {
    onConnect: connect,
    onEdit: edit,
    state: hostState,
    active: [...tabs].find((t) => !t.pane.hidden)?.host,
  });
}

async function edit(host, hint) {
  const result = await editHost(host, store.hosts, hint);
  if (!result) return null;
  if (result.import) return importHosts().then(() => null);
  const index = store.hosts.indexOf(host);
  if (result.remove) store.hosts.splice(index, 1);
  else if (index >= 0) {
    store.hosts[index] = result.host;
    // Offene Reiter gehören weiter zu diesem Host und verbinden beim nächsten Mal mit den neuen Angaben.
    for (const t of tabs) {
      if (t.host !== host) continue;
      t.host = result.host;
      t.button.querySelector('.n').textContent = result.host.name;
    }
  } else store.hosts.push(result.host);
  store.hosts.sort((a, b) => a.name.localeCompare(b.name));
  refreshHosts();
  await save();
  return result.host ?? null;
}

async function importHosts() {
  try {
    const { hosts: added, skipped } = await api.hostsImport(store.hosts.map((h) => h.name));
    if (added.length) {
      store.hosts.push(...added);
      store.hosts.sort((a, b) => a.name.localeCompare(b.name));
      refreshHosts();
      await save();
    }
    const lines = [added.length
      ? `Importiert: ${added.map((h) => h.name).join(', ')}`
      : 'Keine neuen Hosts in der SSH-Config gefunden.'];
    if (skipped.length) lines.push(`Ausgelassen, weil sie einen Sprung-Host (ProxyJump) brauchen: ${skipped.join(', ')}`);
    await alertBox('Import', lines.join('\n\n'));
  } catch (e) {
    await alertBox('Import fehlgeschlagen', String(e));
  }
}

async function setSettings(settings) {
  store.settings = settings;
  applySettings(settings);
  await save();
}

// ---------- Reiter ----------

function selectTab(tab) {
  for (const t of tabs) {
    t.pane.hidden = t !== tab;
    t.button.classList.toggle('on', t === tab);
    t.button.setAttribute('aria-current', t === tab);
  }
  $('empty').hidden = tabs.size > 0;
  document.querySelector('.main').classList.toggle('empty', !tabs.size);
  refreshHosts();
  tab?.terminal.term.focus();
}

// `state`: 'a' verbindet, 'g' verbunden, 'r' getrennt.
function setStatus(tab, text, state) {
  const dead = state === 'r';
  tab.state = state;
  for (const dot of [tab.button, tab.pane].map((el) => el.querySelector('.dot'))) dot.className = `dot ${state}`;
  const label = tab.pane.querySelector('.stat-text');
  label.textContent = text;
  label.classList.toggle('red', dead);
  tab.button.classList.toggle('off', dead);
  tab.pane.querySelector('.reconnect').hidden = !dead;
  refreshHosts();
}

function markClosed(tab, text = 'Verbindung getrennt') {
  if (!tabs.has(tab)) return;
  tab.id = null;
  tab.connecting = false;
  setStatus(tab, text, 'r');
  tab.terminal.term.write(`\r\n\x1b[90m[${text}. Enter verbindet neu.]\x1b[0m\r\n`);
}

function closeTab(tab) {
  tabs.delete(tab);
  // Laufende Uploads abbrechen. Getrennt wird erst danach, damit der Server die halben Dateien noch löschen kann.
  const { id } = tab;
  tab.uploads.close().then(() => id && api.sshDisconnect(id));
  tab.terminal.dispose();
  tab.pane.remove();
  tab.button.remove();
  selectTab([...tabs].at(-1));
}

function openTab(host) {
  const button = document.createElement('div');
  button.className = 'tab';
  button.innerHTML = `
    <button type="button" class="tmain"><span class="dot"></span><span class="n">${esc(host.name)}</span></button>
    <button type="button" class="ib close" aria-label="Reiter ${esc(host.name)} schließen" title="Schließen">${icon('x')}</button>`;
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.innerHTML = `
    <div class="head">
      <div class="seg">
        <button type="button" class="on" data-view="term" aria-pressed="true">Terminal</button>
        <button type="button" data-view="files" aria-pressed="false">Dateien</button>
      </div>
      <div class="stat" role="status"><span class="dot"></span><span class="stat-text n"></span></div>
      <button type="button" class="btn sm reconnect" hidden>Neu verbinden</button>
    </div>
    <div class="pane-body"><div class="term-view"></div><div class="files" hidden></div></div>`;
  $('tabs').append(button);
  $('panes').append(pane);

  const tab = { host, id: null, button, pane, sending: Promise.resolve() };
  tab.terminal = createTerminal(pane.querySelector('.term-view'), store.settings, (delta) => {
    const size = delta === 0 ? 14 : Math.min(40, Math.max(8, store.settings.font_size + delta));
    setSettings({ ...store.settings, font_size: size });
  }, () => tab.uploads.image());
  const { term } = tab.terminal;
  // Der Pfad geht den normalen Einfüge-Weg, ohne Zeilenende: Enter drückt der Nutzer selbst.
  tab.uploads = createUploads(pane.querySelector('.term-view'), {
    getId: () => tab.id,
    getDir: () => store.settings.paste_dir,
    onPath: (word) => term.paste(`${word} `),
  });
  // Eingaben nacheinander schicken: gleichzeitige Aufrufe könnten sich sonst überholen.
  term.onData((data) => {
    if (!tab.id) {
      if (data === '\r') attach(tab);
      return;
    }
    tab.sending = tab.sending.then(() => tab.id && api.sshWrite(tab.id, data)).catch(() => {});
  });
  // Ton nur bei echten Tastendrücken, nicht bei Mausmeldungen oder eingefügtem Text.
  term.onKey(() => {
    if (store.settings.typing_sound) tick();
  });
  term.onResize(({ cols, rows }) => {
    if (tab.id) api.sshResize(tab.id, cols, rows).catch(() => {});
  });

  // Umschalten zwischen Terminal und Dateien. Der Dateimanager entsteht beim ersten Öffnen.
  pane.querySelector('.seg').addEventListener('click', (e) => {
    const { view } = e.target.dataset;
    if (!view) return;
    for (const b of pane.querySelectorAll('[data-view]')) {
      b.classList.toggle('on', b.dataset.view === view);
      b.setAttribute('aria-pressed', b.dataset.view === view);
    }
    pane.querySelector('.term-view').hidden = view !== 'term';
    pane.querySelector('.files').hidden = view !== 'files';
    if (view === 'term') return term.focus();
    tab.files ??= createFiles(pane.querySelector('.files'), () => tab.id);
    tab.files.show();
  });

  button.querySelector('.tmain').addEventListener('click', () => selectTab(tab));
  button.querySelector('.close').addEventListener('click', () => closeTab(tab));
  pane.querySelector('.reconnect').addEventListener('click', () => attach(tab));
  tabs.add(tab);
  selectTab(tab);
  return tab;
}

// ---------- Verbinden ----------

// Fragt nach Passphrase oder Passwort. Beides bleibt nur im Arbeitsspeicher.
const askSecret = async ({ title, intro, subject, label, wrong, ok }) => {
  const { action, data } = await openDialog(`
    <h2>${icon('lock')}${title}</h2>
    <p>${intro}</p>
    <div class="fp">${esc(subject)}</div>
    <label class="field"><span>${label}</span>
      <input class="in ${wrong ? 'err' : ''}" name="secret" type="password" required autocomplete="off" autofocus>
      ${wrong ? errorHint(wrong) : ''}
      <span class="hint">Bleibt nur im Arbeitsspeicher, bis du Lotse beendest.</span></label>
    <div class="acts">
      <button value="" formnovalidate class="btn">Abbrechen</button>
      <button value="ok" class="btn pri">${ok}</button>
    </div>`).done;
  return action === 'ok' ? data.secret : null;
};

const askPassphrase = (host, wrong) => askSecret({
  title: 'Passphrase eingeben',
  intro: 'Dieser Schlüssel ist geschützt:',
  subject: host.key_path,
  label: 'Passphrase',
  wrong: wrong && 'Die Passphrase stimmt nicht. Versuch es noch einmal.',
  ok: 'Entsperren',
});

const askPassword = (host, wrong) => askSecret({
  title: 'Passwort eingeben',
  intro: 'Der Server fragt nach dem Passwort für:',
  subject: `${host.user}@${host.address}`,
  label: 'Passwort',
  wrong: wrong && 'Das Passwort stimmt nicht. Versuch es noch einmal.',
  ok: 'Verbinden',
});

const confirmHost = async (host, fingerprint) =>
  (await openDialog(`
    <h2>Unbekannter Host</h2>
    <p>Mit diesem Server verbindest du dich zum ersten Mal. Vergleiche den Fingerabdruck, bevor du ihm vertraust.</p>
    <div class="field"><span>Adresse</span><div class="fp">${esc(host.address)}:${host.port}</div></div>
    <div class="field"><span>Fingerabdruck</span><div class="fp">${esc(fingerprint)}</div></div>
    <div class="acts">
      <button value="" class="btn" autofocus>Abbrechen</button>
      <button value="ok" class="btn pri">Vertrauen und verbinden</button>
    </div>`).done).action === 'ok';

const warnChanged = async (host, error) =>
  (await openDialog(`
    <h2>${icon('warn')}Warnung: Schlüssel des Servers hat sich geändert</h2>
    <p class="lead">Der Server <span class="mono">${esc(host.address)}:${host.port}</span> zeigt einen anderen Schlüssel als beim letzten Mal. Lotse hat die Verbindung nicht aufgebaut.</p>
    <p>Das passiert, wenn der Server neu aufgesetzt wurde. Es kann aber auch heißen, dass sich jemand zwischen dich und den Server geschaltet hat. Entferne den Eintrag nur, wenn du den Grund kennst.</p>
    <div class="field"><span>Bekannter Fingerabdruck</span><div class="fp">${error.old.map(esc).join('\n')}</div></div>
    <div class="field"><span class="red">Neuer Fingerabdruck</span><div class="fp new">${esc(error.fingerprint)}</div></div>
    <div class="acts">
      <button value="remove" class="btn danger left">Eintrag entfernen</button>
      <button value="" class="btn" autofocus>Abbrechen</button>
    </div>`, 'warn').done).action === 'remove';

// Verbindet den Reiter mit seinem Host und führt durch Passphrase, Passwort und Host-Schlüssel-Fragen.
async function attach(tab) {
  const { host } = tab;
  const { term } = tab.terminal;
  if (tab.connecting || tab.id) return;
  tab.connecting = true;
  let secret = null;
  let trust = null;
  setStatus(tab, `Verbinde mit ${host.address} …`, 'a');
  for (;;) {
    try {
      tab.id = await api.sshConnect(
        host,
        { secret, trust, cols: term.cols, rows: term.rows },
        (bytes) => term.write(bytes),
        () => markClosed(tab),
      );
      tab.connecting = false;
      if (!tabs.has(tab)) api.sshDisconnect(tab.id);
      setStatus(tab, `${host.user}@${host.address}`, 'g');
      term.focus();
      return;
    } catch (e) {
      if (e.kind === 'need_passphrase') {
        secret = await askPassphrase(host, e.wrong);
        if (secret === null) break;
      } else if (e.kind === 'need_password') {
        secret = await askPassword(host, e.wrong);
        if (secret === null) break;
      } else if (e.kind === 'unknown_host') {
        if (!(await confirmHost(host, e.fingerprint))) break;
        trust = e.fingerprint;
      } else if (e.kind === 'host_changed') {
        if (!(await warnChanged(host, e))) break;
        await api.knownHostRemove(host.address, host.port);
      } else {
        await alertBox('Verbindung fehlgeschlagen', e.message ?? String(e));
        break;
      }
    }
  }
  markClosed(tab, 'Nicht verbunden');
}

async function connect(host) {
  if (!host.user) {
    host = await edit(host, 'Zum Verbinden fehlt noch der Benutzer.');
    if (!host) return;
  }
  attach(openTab(host));
}

// ---------- Dateien hereinziehen ----------

const activeTab = () => [...tabs].find((t) => !t.pane.hidden);

// Aus dem Explorer aufs Fenster gezogene Dateien: über dem Terminal hochladen und den Pfad einfügen,
// über dem Dateimanager in den offenen Ordner hochladen.
export function dropFiles(paths) {
  const tab = activeTab();
  if (!tab || document.querySelector('dialog')) return;
  if (tab.pane.querySelector('.term-view').hidden) tab.files?.drop(paths);
  else tab.uploads.files(paths);
}

window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
  const tab = activeTab();
  const body = tab?.pane.querySelector('.pane-body');
  if (payload.type === 'enter' || payload.type === 'over') {
    if (!body || body.querySelector('.drop') || document.querySelector('dialog')) return;
    const where = tab.pane.querySelector('.term-view').hidden
      ? `Die Datei landet im offenen Ordner auf ${tab.host.name}.`
      : `Die Datei landet auf ${tab.host.name}. Danach steht ihr Pfad als Text im Terminal.`;
    body.insertAdjacentHTML('beforeend',
      `<div class="drop">${icon('upload')}<strong>Loslassen zum Hochladen</strong><span>${esc(where)}</span></div>`);
    return;
  }
  document.querySelector('.drop')?.remove();
  if (payload.type === 'drop') dropFiles(payload.paths);
});

// ---------- Start ----------

$('host-search').addEventListener('input', refreshHosts);
// Enter im Suchfeld verbindet mit dem ersten Treffer.
$('host-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('host-list').querySelector('.hmain')?.click();
});
// Strg + Tab und Strg + Umschalt + Tab wechseln den Reiter, auch wenn das Terminal den Fokus hat.
window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.key !== 'Tab' || tabs.size < 2 || document.querySelector('dialog')) return;
  e.preventDefault();
  e.stopPropagation();
  const list = [...tabs];
  const current = list.findIndex((t) => !t.pane.hidden);
  selectTab(list[(current + (e.shiftKey ? -1 : 1) + list.length) % list.length]);
}, true);
const commands = {
  'host-add': () => edit(null),
  settings: () => openSettings(store.settings, store.hosts, setSettings),
};
for (const button of document.querySelectorAll('[data-do]')) button.addEventListener('click', commands[button.dataset.do]);

// Eigene Fensterknöpfe, weil das Fenster keinen Rahmen von Windows hat.
const win = window.__TAURI__.window.getCurrentWindow();
for (const button of document.querySelectorAll('[data-win]')) button.addEventListener('click', () => win[button.dataset.win]());

window.__TAURI__.app.getVersion().then((v) => { $('version').textContent = v; });

try {
  store = await api.storeLoad();
} catch (e) {
  await alertBox('Gespeicherte Hosts nicht lesbar', String(e));
}
refreshHosts();
