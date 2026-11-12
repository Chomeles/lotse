import { ask, esc, openDialog } from '../dialog.js';

// Zeichnet die Hostliste, gefiltert nach dem Suchtext.
export function renderHosts(list, hosts, filter, { onConnect, onEdit }) {
  const needle = filter.trim().toLowerCase();
  const shown = hosts.filter((h) => `${h.name} ${h.user} ${h.address}`.toLowerCase().includes(needle));
  list.replaceChildren(...shown.map((host) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <button type="button" class="connect" title="Verbinden">
        <strong>${esc(host.name)}</strong>
        <small>${esc(host.user || '?')}@${esc(host.address)}${host.port === 22 ? '' : `:${host.port}`}</small>
      </button>
      <button type="button" class="edit" aria-label="${esc(host.name)} bearbeiten" title="Bearbeiten">✎</button>`;
    li.querySelector('.connect').addEventListener('click', () => onConnect(host));
    li.querySelector('.edit').addEventListener('click', () => onEdit(host));
    return li;
  }));
  if (!shown.length) {
    list.innerHTML = `<li class="none">${hosts.length ? 'Kein Treffer.' : 'Noch keine Hosts.'}</li>`;
  }
}

// Formular zum Anlegen (host = null) oder Ändern. Liefert { host }, { remove: true } oder null.
export async function editHost(host, hosts, hint = '') {
  const h = host ?? { name: '', address: '', port: 22, user: '', key_path: '' };
  const { dialog, done } = openDialog(`
    <h2>${host ? 'Host bearbeiten' : 'Neuer Host'}</h2>
    ${hint ? `<p class="warn">${esc(hint)}</p>` : ''}
    <label><span>Name</span><input name="name" required value="${esc(h.name)}" autofocus></label>
    <label><span>Adresse</span><input name="address" required value="${esc(h.address)}" placeholder="server.example.org, IP oder benutzer@server:port"></label>
    <label><span>Port</span><input name="port" type="number" min="1" max="65535" required value="${h.port}"></label>
    <label><span>Benutzer</span><input name="user" required value="${esc(h.user)}"></label>
    <label><span>Schlüsseldatei (privater Schlüssel)</span>
      <span class="row"><input name="key_path" value="${esc(h.key_path)}" aria-describedby="key-hint"><button type="button" class="browse">Durchsuchen</button></span>
      <small id="key-hint">Leer lassen = Anmeldung mit Passwort.</small>
    </label>
    <div class="buttons">
      ${host ? '<button value="remove" formnovalidate class="danger left">Löschen</button>' : ''}
      <button value="" formnovalidate>Abbrechen</button>
      <button value="save" class="primary">Speichern</button>
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
  dialog.querySelector('.browse').addEventListener('click', async () => {
    // Im Ordner .ssh anfangen, dort liegen Schlüssel fast immer.
    const { homeDir, join } = window.__TAURI__.path;
    const defaultPath = await homeDir().then((home) => join(home, '.ssh')).catch(() => undefined);
    const path = await window.__TAURI__.dialog.open({ title: 'Privaten Schlüssel wählen', multiple: false, defaultPath });
    if (path) dialog.querySelector('[name=key_path]').value = path;
  });

  const { action, data } = await done;
  if (action === 'remove') return (await ask(`Host „${h.name}“ löschen?`)) ? { remove: true } : null;
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
