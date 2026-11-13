import { api } from '../api.js';
import { ask, errorHint, esc, openDialog } from '../dialog.js';
import { icon } from '../icons.js';

// Antwortzeit als Text und Farbklasse. `undefined` = nicht gemessen, `Infinity` = keine Antwort.
const pingLabel = (ms) => {
  if (ms === undefined) return { text: '', cls: '' };
  if (ms === Infinity) return { text: '> 5 s', cls: 'r' };
  return { text: `${ms} ms`, cls: ms < 200 ? 'g' : ms < 1000 ? 'a' : 'r' };
};

// Setzt nur die Antwortzeiten der gezeichneten Zeilen neu, ohne die Liste neu zu bauen.
export function updatePings(list, ping) {
  for (const ms of list.querySelectorAll('.ms')) {
    const { text, cls } = pingLabel(ping(ms.closest('.host').host));
    ms.textContent = text;
    ms.className = `ms ${cls}`;
  }
}

// Zeichnet die Hostliste, gefiltert nach dem Suchtext.
// `state(host)` liefert die Klasse des Statuspunkts, `ping(host)` die Antwortzeit in Millisekunden,
// `active` ist der Host des sichtbaren Reiters.
export function renderHosts(list, hosts, filter, { onConnect, onEdit, state, ping, active }) {
  const needle = filter.trim().toLowerCase();
  const shown = hosts.filter((h) => `${h.name} ${h.user} ${h.address}`.toLowerCase().includes(needle));
  list.replaceChildren(...shown.map((host) => {
    const li = document.createElement('div');
    li.className = host === active ? 'host on' : 'host';
    li.host = host;
    const ms = pingLabel(ping(host));
    li.innerHTML = `
      <button type="button" class="hmain" title="Verbinden">
        <span class="hs"><span class="dot ${state(host)}"></span><span class="ms ${ms.cls}">${ms.text}</span></span>
        <span class="ht"><span class="n">${esc(host.name)}</span>
          <span class="a">${esc(host.user || '?')}@${esc(host.address)}${host.port === 22 ? '' : `:${host.port}`}</span></span>
      </button>
      <button type="button" class="ib edit" aria-label="${esc(host.name)} bearbeiten" title="Bearbeiten">${icon('edit')}</button>`;
    li.querySelector('.hmain').addEventListener('click', () => onConnect(host));
    li.querySelector('.edit').addEventListener('click', () => onEdit(host));
    return li;
  }));
  if (!shown.length) {
    list.innerHTML = `<div class="none">${hosts.length
      ? `Kein Treffer für „${esc(filter.trim())}“`
      : 'Noch keine Hosts.<br>„Neuer Host“ legt einen an oder importiert deine SSH-Config.'}</div>`;
  }
}

// Formular zum Anlegen (host = null) oder Ändern. Liefert { host }, { remove: true }, { import: true } oder null.
// Der Import aus der SSH-Config wird nur beim Anlegen angeboten.
export async function editHost(host, hosts, hint = '') {
  const h = host ?? { name: '', address: '', port: 22, user: '', key_path: '' };
  const { dialog, done } = openDialog(`
    <h2>${host ? 'Host bearbeiten' : 'Neuer Host'}</h2>
    ${hint ? errorHint(hint) : ''}
    ${host ? '' : `<div class="rowf offer"><span class="hint">Stehen deine Server schon in ~/.ssh/config? Dann übernimm sie von dort.</span>
      <button value="import" formnovalidate class="btn sm">${icon('download')}Importieren</button></div>`}
    <label class="field"><span>Name</span><input class="in" name="name" required value="${esc(h.name)}" autofocus></label>
    <div class="g2">
      <label class="field"><span>Adresse</span><input class="in mono" name="address" required value="${esc(h.address)}" placeholder="Name oder IP" spellcheck="false"></label>
      <label class="field"><span>Port</span><input class="in mono" name="port" type="number" min="1" max="65535" required value="${h.port}"></label>
    </div>
    <label class="field"><span>Benutzer</span><input class="in mono" name="user" required value="${esc(h.user)}" spellcheck="false"></label>
    <div class="field"><label class="flabel" for="key-path">Schlüsseldatei (freiwillig)</label>
      <div class="rowf"><input class="in mono" id="key-path" name="key_path" value="${esc(h.key_path)}" list="key-list" aria-describedby="key-hint" spellcheck="false"><button type="button" class="btn browse">Durchsuchen</button></div>
      <datalist id="key-list"></datalist>
      <span class="hint" id="key-hint">Ohne Schlüssel fragt Hostess beim Verbinden nach dem Passwort.</span>
    </div>
    <div class="acts">
      ${host ? '<button value="remove" formnovalidate class="btn danger left">Löschen</button>' : ''}
      <button value="" formnovalidate class="btn">Abbrechen</button>
      <button value="save" class="btn pri">Speichern</button>
    </div>`);

  const name = dialog.querySelector('[name=name]');
  name.addEventListener('input', () => {
    const taken = hosts.some((other) => other !== host && other.name === name.value.trim());
    name.setCustomValidity(taken ? 'Diesen Namen gibt es schon.' : '');
  });
  // „benutzer@server:2222“ (auch mit „ssh “ davor) in die Felder aufteilen.
  const address = dialog.querySelector('[name=address]');
  address.addEventListener('change', () => {
    const m = address.value.trim().match(/^(?:ssh\s+)?(?:([^@\s]+)@)?(\[[^\]]+\]|[^:@\s]+)(?::(\d+))?$/);
    if (!m || (!m[1] && !m[3] && !/^ssh\s/.test(address.value.trim()))) return;
    address.value = m[2];
    if (m[1]) dialog.querySelector('[name=user]').value = m[1];
    if (m[3]) dialog.querySelector('[name=port]').value = m[3];
  });
  // Bekannte Schlüssel zur Auswahl anbieten. Ohne Liste bleibt das Feld ein normales Textfeld.
  api.keysList(hosts).then((keys) => {
    dialog.querySelector('#key-list').innerHTML = keys
      .filter((k) => k.fingerprint)
      .map((k) => `<option value="${esc(k.path)}">${esc(k.kind)}${k.encrypted ? ', mit Passphrase' : ''}</option>`)
      .join('');
  }).catch(() => {});
  dialog.querySelector('.browse').addEventListener('click', async () => {
    // Im Ordner .ssh anfangen, dort liegen Schlüssel fast immer.
    const { homeDir, join } = window.__TAURI__.path;
    const defaultPath = await homeDir().then((home) => join(home, '.ssh')).catch(() => undefined);
    const path = await window.__TAURI__.dialog.open({ title: 'Privaten Schlüssel wählen', multiple: false, defaultPath });
    if (path) dialog.querySelector('[name=key_path]').value = path;
  });

  const { action, data } = await done;
  if (action === 'remove') {
    return (await ask(`Host „${h.name}“ löschen?`, 'Der Eintrag verschwindet aus der Liste. Auf dem Server ändert sich nichts.', 'Löschen', true)) ? { remove: true } : null;
  }
  if (action === 'import') return { import: true };
  if (action !== 'save') return null;
  return {
    host: {
      name: data.name.trim(),
      // Eckige Klammern um IPv6-Adressen wie in URLs erlauben: [::1] wird zu ::1.
      address: data.address.trim().replace(/^\[(.*)\]$/, '$1'),
      port: Number(data.port),
      user: data.user.trim(),
      key_path: data.key_path.trim(),
    },
  };
}
