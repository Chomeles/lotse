import { api } from '../api.js';
import { alertBox, esc, openDialog } from '../dialog.js';

// Ein Fenster mit drei Bereichen: Einstellungen, Schlüssel, Bekannte Hosts.
// Liefert geänderte Einstellungen oder null. `hosts` wird nur gelesen (welcher Host nutzt welchen Schlüssel).
export async function openSettings(settings, hosts) {
  const { dialog, done } = openDialog(`
    <div class="areas">
      <button type="button" data-area="settings" aria-pressed="true">Einstellungen</button>
      <button type="button" data-area="keys" aria-pressed="false">Schlüssel</button>
      <button type="button" data-area="known" aria-pressed="false">Bekannte Hosts</button>
    </div>
    <section data-area="settings">
      <label><span>Scrollback (Zeilen, die das Terminal behält)</span>
        <input name="scrollback" type="number" min="100" max="1000000" step="100" required value="${settings.scrollback}" autofocus></label>
      <label><span>Schriftgröße (auch mit Strg + Plus/Minus)</span>
        <input name="font_size" type="number" min="8" max="40" required value="${settings.font_size}"></label>
      <label><span>Ordner auf dem Server für ins Terminal gezogene oder eingefügte Dateien und Bilder</span>
        <input name="paste_dir" required value="${esc(settings.paste_dir)}" spellcheck="false" aria-describedby="paste-hint">
        <small id="paste-hint">~/ meint den Startordner des angemeldeten Benutzers. Der Ordner wird bei Bedarf angelegt.</small></label>
      <label class="check"><input name="typing_sound" type="checkbox" ${settings.typing_sound ? 'checked' : ''}> Leiser Tastenton beim Tippen</label>
    </section>
    <section data-area="keys" hidden>
      <p>Private Schlüssel aus dem Ordner .ssh und die Schlüsseldateien deiner Hosts. Der öffentliche Schlüssel gehört auf den Server, der private bleibt hier.</p>
      <ul class="cards"></ul>
      <button type="button" class="new-key">Neuer Schlüssel</button>
    </section>
    <section data-area="known" hidden>
      <p>Server, deren Fingerabdruck du bestätigt hast. Nach „Entfernen“ fragt Lotse beim nächsten Verbinden wieder nach.</p>
      <ul class="cards"></ul>
    </section>
    <div class="buttons">
      <button value="" formnovalidate class="close">Abbrechen</button>
      <button value="save" class="primary">Speichern</button>
    </div>`);
  dialog.classList.add('wide');
  const section = (area) => dialog.querySelector(`section[data-area=${area}]`);
  const keyList = section('keys').querySelector('.cards');
  const knownList = section('known').querySelector('.cards');
  let keys = [];
  let known = [];

  const failed = (e) => `<li class="none warn">${esc(e)}</li>`;

  async function showKeys() {
    try {
      keys = await api.keysList(hosts);
    } catch (e) {
      keys = [];
      keyList.innerHTML = failed(e);
      return;
    }
    keyList.innerHTML = keys.map((k, i) => `
      <li>
        <div>
          <strong>${esc(k.name)}</strong>
          ${k.fingerprint
            ? `<small>${esc(k.kind)}, ${k.encrypted ? 'mit Passphrase geschützt' : 'ohne Passphrase'}</small>
               <code>${esc(k.fingerprint)}</code>`
            : '<small class="warn">Datei fehlt oder ist kein lesbarer Schlüssel</small>'}
          <small>${esc(k.path)}</small>
          <small>${k.hosts.length ? `Verwendet von: ${esc(k.hosts.join(', '))}` : 'Von keinem Host verwendet'}</small>
        </div>
        ${k.fingerprint ? `<div class="actions">
          <button type="button" data-do="public" data-i="${i}">Öffentlicher Schlüssel</button>
          <button type="button" data-do="delete" data-i="${i}" class="danger">Löschen</button>
        </div>` : ''}
      </li>`).join('')
      || '<li class="none">Noch keine Schlüssel. „Neuer Schlüssel“ legt einen an.</li>';
  }

  async function showKnown() {
    try {
      known = await api.knownHostsList();
    } catch (e) {
      known = [];
      knownList.innerHTML = failed(e);
      return;
    }
    knownList.innerHTML = known.map((h, i) => `
      <li>
        <div>
          <strong>${esc(h.address)}${h.port === 22 ? '' : `:${h.port}`}</strong>
          <small>${esc(h.kind)}</small>
          <code>${esc(h.fingerprint)}</code>
        </div>
        <div class="actions"><button type="button" data-i="${i}">Entfernen</button></div>
      </li>`).join('')
      || '<li class="none">Noch keine bekannten Hosts. Ein Server kommt in diese Liste, sobald du beim ersten Verbinden seinen Fingerabdruck bestätigst.</li>';
  }

  function select(area) {
    for (const b of dialog.querySelectorAll('.areas button')) b.setAttribute('aria-pressed', b.dataset.area === area);
    for (const s of dialog.querySelectorAll('section')) s.hidden = s.dataset.area !== area;
    // Nur die Einstellungen werden gespeichert; Schlüssel und bekannte Hosts wirken sofort.
    dialog.querySelector('[value=save]').hidden = area !== 'settings';
    dialog.querySelector('.close').textContent = area === 'settings' ? 'Abbrechen' : 'Schließen';
    if (area === 'keys') showKeys();
    if (area === 'known') showKnown();
  }
  dialog.querySelector('.areas').addEventListener('click', (e) => {
    if (e.target.dataset.area) select(e.target.dataset.area);
  });

  // Nach einer Aktion ist der gedrückte Knopf oft weg; der Fokus geht dann auf den Bereichsknopf statt ins Leere.
  const refocus = () => dialog.querySelector('.areas [aria-pressed=true]').focus();

  keyList.addEventListener('click', async (e) => {
    const key = keys[e.target.dataset.i];
    if (!key) return;
    try {
      if (e.target.dataset.do === 'public') {
        await showPublic(key.name, await api.keyPublic(key.path));
        e.target.focus();
      } else if (await confirmDelete(key)) {
        await api.keyDelete(key.path);
        await showKeys();
        refocus();
      }
    } catch (err) {
      await alertBox('Schlüssel', String(err));
    }
  });
  section('keys').querySelector('.new-key').addEventListener('click', async () => {
    const created = await newKey();
    if (!created) return;
    await showKeys();
    // Der nächste Schritt ist fast immer, den öffentlichen Schlüssel auf den Server zu bringen.
    const key = keys.find((k) => k.path === created);
    if (key) await showPublic(key.name, await api.keyPublic(key.path)).catch(() => {});
    refocus();
  });
  knownList.addEventListener('click', async (e) => {
    const entry = known[e.target.dataset.i];
    if (!entry) return;
    try {
      await api.knownHostRemove(entry.address, entry.port);
    } catch (err) {
      await alertBox('Bekannte Hosts', String(err));
    }
    await showKnown();
    refocus();
  });

  const { action, data } = await done;
  if (action !== 'save') return null;
  return {
    ...settings,
    scrollback: Number(data.scrollback),
    font_size: Number(data.font_size),
    typing_sound: data.typing_sound === 'on',
    paste_dir: data.paste_dir.trim(),
  };
}

async function showPublic(name, text) {
  const { dialog, done } = openDialog(`
    <h2>Öffentlicher Schlüssel von ${esc(name)}</h2>
    <p>Diese Zeile gehört auf dem Server in die Datei ~/.ssh/authorized_keys des Benutzers.</p>
    <label><span>Öffentlicher Schlüssel</span>
      <textarea rows="4" readonly>${esc(text)}</textarea></label>
    <div class="buttons">
      <button type="button" class="copy" autofocus>In die Zwischenablage kopieren</button>
      <button value="" class="primary">Schließen</button>
    </div>`);
  const copy = dialog.querySelector('.copy');
  copy.addEventListener('click', async () => {
    try {
      await window.__TAURI__.clipboardManager.writeText(text);
      copy.textContent = 'Kopiert';
    } catch (e) {
      copy.textContent = 'Kopieren fehlgeschlagen';
    }
  });
  await done;
}

// Liefert den Pfad des neuen Schlüssels oder null.
async function newKey() {
  const { dialog, done } = openDialog(`
    <h2>Neuer Schlüssel</h2>
    <p>Erzeugt einen ED25519-Schlüssel im Ordner .ssh, zusammen mit der .pub-Datei. Vorhandene Dateien werden nie überschrieben.</p>
    <label><span>Dateiname (Buchstaben, Ziffern, Punkt, Binde- und Unterstrich)</span>
      <input name="name" required pattern="[A-Za-z0-9_\\-][A-Za-z0-9_.\\-]*" value="id_ed25519_lotse" autofocus></label>
    <label><span>Passphrase (optional, schützt die Datei auf diesem Rechner)</span>
      <input name="passphrase" type="password" autocomplete="new-password"></label>
    <label><span>Passphrase wiederholen</span>
      <input name="repeat" type="password" autocomplete="new-password"></label>
    <div class="buttons">
      <button value="" formnovalidate>Abbrechen</button>
      <button value="ok" class="primary">Erzeugen</button>
    </div>`);
  // Ein Tippfehler in der Passphrase würde den neuen Schlüssel sofort unbrauchbar machen.
  const [first, repeat] = ['passphrase', 'repeat'].map((name) => dialog.querySelector(`[name=${name}]`));
  const check = () => repeat.setCustomValidity(first.value === repeat.value ? '' : 'Die Passphrasen stimmen nicht überein.');
  first.addEventListener('input', check);
  repeat.addEventListener('input', check);

  const { action, data } = await done;
  if (action !== 'ok') return null;
  try {
    return await api.keyGenerate(data.name, data.passphrase || null);
  } catch (e) {
    await alertBox('Schlüssel nicht erzeugt', String(e));
    return null;
  }
}

async function confirmDelete(key) {
  const { action } = await openDialog(`
    <h2>Schlüssel „${esc(key.name)}“ löschen?</h2>
    <p class="warn">${esc(key.path)} und die .pub-Datei daneben werden endgültig gelöscht. Das lässt sich nicht rückgängig machen.</p>
    <p>${key.hosts.length
      ? `Diese Hosts verwenden den Schlüssel und können sich danach nicht mehr damit anmelden: ${esc(key.hosts.join(', '))}`
      : 'Kein Host in Lotse verwendet diesen Schlüssel.'}</p>
    <div class="buttons">
      <button value="" autofocus>Abbrechen</button>
      <button value="delete" class="danger">Endgültig löschen</button>
    </div>`).done;
  return action === 'delete';
}
