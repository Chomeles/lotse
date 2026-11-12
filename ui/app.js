import { api } from './api.js';
import { tick } from './sound.js';
import { alertBox, esc, openDialog } from './dialog.js';
import { createFiles } from './views/files.js';
import { editHost, renderHosts } from './views/hosts.js';
import { editSettings } from './views/settings.js';
import { applySettings, createTerminal } from './views/terminal.js';

const $ = (id) => document.getElementById(id);

let store = { version: 1, hosts: [], settings: { scrollback: 10000, font_size: 14, typing_sound: true } };
const tabs = new Set();

// ---------- Speicher und Hostliste ----------

async function save() {
  try {
    await api.storeSave(store);
  } catch (e) {
    await alertBox('Speichern fehlgeschlagen', String(e));
  }
}

function refreshHosts() {
  renderHosts($('host-list'), store.hosts, $('host-search').value, { onConnect: connect, onEdit: edit });
}

async function edit(host, hint) {
  const result = await editHost(host, store.hosts, hint);
  if (!result) return null;
  const index = store.hosts.indexOf(host);
  if (result.remove) store.hosts.splice(index, 1);
  else if (index >= 0) store.hosts[index] = result.host;
  else store.hosts.push(result.host);
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
    t.button.setAttribute('aria-current', t === tab);
  }
  $('empty').hidden = tabs.size > 0;
  tab?.terminal.term.focus();
}

function setStatus(tab, text, dead = false) {
  const status = tab.pane.querySelector('.status');
  status.textContent = text;
  status.classList.toggle('dead', dead);
  tab.button.classList.toggle('dead', dead);
  tab.pane.querySelector('.reconnect').hidden = !dead;
}

function markClosed(tab, text = 'Verbindung getrennt') {
  if (!tabs.has(tab)) return;
  tab.id = null;
  tab.connecting = false;
  setStatus(tab, text, true);
  tab.terminal.term.write(`\r\n\x1b[90m[${text}. Enter verbindet neu.]\x1b[0m\r\n`);
}

function closeTab(tab) {
  tabs.delete(tab);
  if (tab.id) api.sshDisconnect(tab.id);
  tab.terminal.dispose();
  tab.pane.remove();
  tab.button.remove();
  selectTab([...tabs].at(-1));
}

function openTab(host) {
  const button = document.createElement('div');
  button.className = 'tab';
  button.innerHTML = `
    <button type="button" class="name">${esc(host.name)}</button>
    <button type="button" class="close" aria-label="${esc(host.name)} schließen" title="Schließen">×</button>`;
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.innerHTML = `
    <div class="pane-bar">
      <button type="button" data-view="term" aria-pressed="true">Terminal</button>
      <button type="button" data-view="files" aria-pressed="false">Dateien</button>
      <span class="status" role="status"></span>
      <button type="button" class="reconnect" hidden>Neu verbinden</button>
    </div>
    <div class="pane-body"><div class="term-view"></div><div class="files-view" hidden></div></div>`;
  $('tabs').append(button);
  $('panes').append(pane);

  const tab = { host, id: null, button, pane, sending: Promise.resolve() };
  tab.terminal = createTerminal(pane.querySelector('.term-view'), store.settings, (delta) => {
    const size = delta === 0 ? 14 : Math.min(40, Math.max(8, store.settings.font_size + delta));
    setSettings({ ...store.settings, font_size: size });
  });
  const { term } = tab.terminal;
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
  pane.querySelector('.pane-bar').addEventListener('click', (e) => {
    const { view } = e.target.dataset;
    if (!view) return;
    for (const b of pane.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', b.dataset.view === view);
    pane.querySelector('.term-view').hidden = view !== 'term';
    pane.querySelector('.files-view').hidden = view !== 'files';
    if (view === 'term') return term.focus();
    tab.files ??= createFiles(pane.querySelector('.files-view'), () => tab.id);
    tab.files.show();
  });

  button.querySelector('.name').addEventListener('click', () => selectTab(tab));
  button.querySelector('.close').addEventListener('click', () => closeTab(tab));
  pane.querySelector('.reconnect').addEventListener('click', () => attach(tab));
  tabs.add(tab);
  selectTab(tab);
  return tab;
}

// ---------- Verbinden ----------

const askPassphrase = async (host, wrong) => {
  const { action, data } = await openDialog(`
    <h2>Passphrase für den Schlüssel</h2>
    <p>${esc(host.key_path)}</p>
    ${wrong ? '<p class="warn">Die Passphrase war falsch.</p>' : ''}
    <label><span>Passphrase (bleibt nur im Arbeitsspeicher, bis du Lotse beendest)</span>
      <input name="passphrase" type="password" required autocomplete="off" autofocus></label>
    <div class="buttons">
      <button value="" formnovalidate>Abbrechen</button>
      <button value="ok" class="primary">Verbinden</button>
    </div>`).done;
  return action === 'ok' ? data.passphrase : null;
};

const askPassword = async (host, wrong) => {
  const { action, data } = await openDialog(`
    <h2>Passwort</h2>
    <p>${esc(host.user)}@${esc(host.address)}</p>
    ${wrong ? '<p class="warn">Das Passwort war falsch.</p>' : ''}
    <label><span>Passwort (bleibt nur im Arbeitsspeicher, bis du Lotse beendest)</span>
      <input name="password" type="password" required autocomplete="off" autofocus></label>
    <div class="buttons">
      <button value="" formnovalidate>Abbrechen</button>
      <button value="ok" class="primary">Verbinden</button>
    </div>`).done;
  return action === 'ok' ? data.password : null;
};

const confirmHost = async (host, fingerprint) =>
  (await openDialog(`
    <h2>Unbekannter Host</h2>
    <p>${esc(host.address)}:${host.port} ist noch nicht bekannt. Fingerabdruck des Servers:</p>
    <p><code>${esc(fingerprint)}</code></p>
    <p>Vertraue ihm nur, wenn der Fingerabdruck zu deinem Server gehört.</p>
    <div class="buttons">
      <button value="" autofocus>Abbrechen</button>
      <button value="ok" class="primary">Vertrauen und verbinden</button>
    </div>`).done).action === 'ok';

const warnChanged = async (host, error) =>
  (await openDialog(`
    <h2>Der Schlüssel des Servers hat sich geändert</h2>
    <p class="warn">Die Verbindung wurde blockiert. Entweder wurde der Server neu aufgesetzt, oder jemand gibt sich als ${esc(host.address)} aus.</p>
    <p>Hinterlegt:\n<code>${error.old.map(esc).join('\n')}</code></p>
    <p>Jetzt gezeigt:\n<code>${esc(error.fingerprint)}</code></p>
    <div class="buttons">
      <button value="remove" class="danger left">Eintrag entfernen</button>
      <button value="" autofocus>Abbrechen</button>
    </div>`).done).action === 'remove';

// Verbindet den Reiter mit seinem Host und führt durch Passphrase, Passwort und Host-Schlüssel-Fragen.
async function attach(tab) {
  const { host } = tab;
  const { term } = tab.terminal;
  if (tab.connecting || tab.id) return;
  tab.connecting = true;
  let secret = null;
  let trust = null;
  setStatus(tab, `Verbinde mit ${host.address} …`);
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
      setStatus(tab, `${host.user}@${host.address}`);
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

// ---------- Start ----------

$('host-search').addEventListener('input', refreshHosts);
// Enter im Suchfeld verbindet mit dem ersten Treffer.
$('host-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('host-list').querySelector('.connect')?.click();
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
$('host-add').addEventListener('click', () => edit(null));
$('host-import').addEventListener('click', importHosts);
$('settings-open').addEventListener('click', async () => {
  const settings = await editSettings(store.settings);
  if (settings) setSettings(settings);
});

window.__TAURI__.app.getVersion().then((v) => { $('version').textContent = `v${v}`; });

try {
  store = await api.storeLoad();
} catch (e) {
  await alertBox('Gespeicherte Hosts nicht lesbar', String(e));
}
refreshHosts();
