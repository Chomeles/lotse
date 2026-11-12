import { api } from '../api.js';
import { alertBox, esc, openDialog } from '../dialog.js';
import { icon } from '../icons.js';

// Fenster „Verwaltung“ mit drei Bereichen: Einstellungen, Schlüssel, Bekannte Hosts.
// Alles wirkt sofort: geänderte Einstellungen gehen an `onChange`. `hosts` wird nur gelesen
// (welcher Host nutzt welchen Schlüssel).
export async function openSettings(settings, hosts, onChange) {
  const { dialog, done } = openDialog(`
    <nav class="areas" aria-label="Bereiche">
      <h2>Verwaltung</h2>
      <button type="button" class="navbtn on" data-area="settings">${icon('settings')}Einstellungen</button>
      <button type="button" class="navbtn" data-area="keys">${icon('key')}Schlüssel</button>
      <button type="button" class="navbtn" data-area="known">${icon('shield')}Bekannte Hosts</button>
    </nav>
    <div class="area-main">
      <div class="area-body">
        <section data-area="settings">
          <h3>Einstellungen</h3>
          <div>
            <label class="set"><span><span>Scrollback</span><span class="hint">Zeilen, die das Terminal nach oben behält</span></span>
              <input class="in mono" name="scrollback" type="number" min="100" max="1000000" step="100" required value="${settings.scrollback}"></label>
            <label class="set"><span><span>Schriftgröße</span><span class="hint">Im Terminal, in Pixel. Auch mit Strg + Plus / Minus</span></span>
              <input class="in mono" name="font_size" type="number" min="8" max="40" required value="${settings.font_size}"></label>
            <label class="set"><span><span>Ordner für Uploads ins Terminal</span><span class="hint">Auf dem Server, für hereingezogene oder eingefügte Dateien und Bilder. ~/ ist der Startordner, der Ordner wird bei Bedarf angelegt</span></span>
              <input class="in mono" name="paste_dir" required value="${esc(settings.paste_dir)}" spellcheck="false" style="width: 200px; text-align: left"></label>
            <div class="set"><span><span id="sound-label">Leiser Tastenton</span><span class="hint">Weiches Tock bei jedem Tastendruck im Terminal</span></span>
              <button type="button" class="sw ${settings.typing_sound ? 'on' : ''}" role="switch" aria-checked="${settings.typing_sound}" aria-labelledby="sound-label"><span></span></button></div>
          </div>
        </section>
        <section data-area="keys" hidden>
          <div class="area-head"><h3>Schlüssel</h3>
            <button type="button" class="btn pri new-key">${icon('plus')}Neuen Schlüssel erzeugen</button></div>
          <p>Private Schlüssel aus dem Ordner .ssh und die Schlüsseldateien deiner Hosts. Der öffentliche Schlüssel gehört auf den Server, der private bleibt hier.</p>
          <div class="cards"></div>
        </section>
        <section data-area="known" hidden>
          <h3>Bekannte Hosts</h3>
          <p>Server, deren Schlüssel du schon bestätigt hast. Nach dem Entfernen fragt Lotse beim nächsten Verbinden neu.</p>
          <div class="known"></div>
        </section>
      </div>
      <div class="acts"><button value="" formnovalidate class="btn">Schließen</button></div>
    </div>`, 'wide');
  const form = dialog.querySelector('form');
  const section = (area) => dialog.querySelector(`section[data-area=${area}]`);
  const keyList = section('keys').querySelector('.cards');
  const knownList = section('known').querySelector('.known');
  const sound = dialog.querySelector('.sw');
  let keys = [];
  let known = [];

  // Übernimmt die Einstellungen, sobald alle Felder gültig sind und sich etwas geändert hat.
  const apply = () => {
    const { scrollback, font_size, paste_dir } = form.elements;
    if (![scrollback, font_size, paste_dir].every((field) => field.checkValidity()) || !paste_dir.value.trim()) return;
    const next = {
      ...settings,
      scrollback: Number(scrollback.value),
      font_size: Number(font_size.value),
      paste_dir: paste_dir.value.trim(),
      typing_sound: sound.classList.contains('on'),
    };
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    settings = next;
    onChange(next);
  };
  section('settings').addEventListener('change', apply);
  sound.addEventListener('click', () => {
    sound.setAttribute('aria-checked', sound.classList.toggle('on'));
    apply();
  });

  const failed = (e) => `<div class="none red">${esc(e)}</div>`;

  async function showKeys() {
    try {
      keys = await api.keysList(hosts);
    } catch (e) {
      keys = [];
      keyList.innerHTML = failed(e);
      return;
    }
    keyList.innerHTML = keys.map((k, i) => `
      <div class="card">
        <div class="top">
          <div class="info">
            <div class="title"><strong title="${esc(k.path)}">${esc(k.name)}</strong>
              ${k.fingerprint ? `<span class="badge">${esc(k.kind)}</span>` : ''}
              ${k.fingerprint && k.encrypted ? `<span class="locked">${icon('lock')}mit Passphrase</span>` : ''}</div>
            ${k.fingerprint
              ? `<span class="a">${esc(k.fingerprint)}</span>`
              : `<span class="hint err">${icon('warn')}Datei fehlt oder ist kein lesbarer Schlüssel: ${esc(k.path)}</span>`}
            <span class="hint">${k.hosts.length ? `Genutzt von ${esc(k.hosts.join(', '))}` : 'Von keinem Host genutzt'}</span>
          </div>
          ${k.fingerprint ? `
            <button type="button" class="ib" data-do="show" data-i="${i}" aria-expanded="false" aria-label="Öffentlichen Schlüssel von ${esc(k.name)} anzeigen" title="Öffentlichen Schlüssel anzeigen">${icon('eye')}</button>
            <button type="button" class="ib" data-do="copy" data-i="${i}" aria-label="Öffentlichen Schlüssel von ${esc(k.name)} kopieren" title="Öffentlichen Schlüssel kopieren">${icon('copy')}</button>
            <button type="button" class="ib del" data-do="delete" data-i="${i}" aria-label="Schlüssel ${esc(k.name)} löschen" title="Löschen">${icon('trash')}</button>` : ''}
        </div>
        <div class="pub" hidden>
          <div class="fp"></div>
          <span class="hint">Diese Zeile gehört auf dem Server in die Datei ~/.ssh/authorized_keys des Benutzers.</span>
          <div class="acts"><button type="button" class="btn" data-do="copy" data-i="${i}">${icon('copy')}Kopieren</button></div>
        </div>
      </div>`).join('')
      || '<div class="none">Noch keine Schlüssel.<br>„Neuen Schlüssel erzeugen“ legt einen an.</div>';
  }

  async function showKnown() {
    try {
      known = await api.knownHostsList();
    } catch (e) {
      known = [];
      knownList.innerHTML = failed(e);
      return;
    }
    knownList.innerHTML = known.length
      ? `<div class="krow th"><span>Adresse</span><span>Port</span><span>Typ</span><span>Fingerabdruck</span><span></span></div>${
        known.map((h, i) => `
          <div class="krow">
            <span class="mono n" title="${esc(h.address)}">${esc(h.address)}</span>
            <span class="mono">${h.port}</span>
            <span>${esc(h.kind)}</span>
            <span class="a" title="${esc(h.fingerprint)}">${esc(h.fingerprint)}</span>
            <button type="button" class="btn danger sm" data-i="${i}" aria-label="${esc(h.address)} entfernen">Entfernen</button>
          </div>`).join('')}`
      : '<div class="none">Noch keine bekannten Hosts.<br>Ein Server kommt in diese Liste, sobald du beim ersten Verbinden seinen Fingerabdruck bestätigst.</div>';
  }

  function select(area) {
    for (const b of dialog.querySelectorAll('.areas button')) b.classList.toggle('on', b.dataset.area === area);
    for (const s of dialog.querySelectorAll('section')) s.hidden = s.dataset.area !== area;
    if (area === 'keys') showKeys();
    if (area === 'known') showKnown();
  }
  dialog.querySelector('.areas').addEventListener('click', (e) => {
    if (e.target.dataset.area) select(e.target.dataset.area);
  });

  // Nach einer Aktion ist der gedrückte Knopf oft weg; der Fokus geht dann auf den Bereichsknopf statt ins Leere.
  const refocus = () => dialog.querySelector('.areas .on').focus();

  keyList.addEventListener('click', async (e) => {
    const button = e.target;
    const key = keys[button.dataset.i];
    if (!key) return;
    try {
      if (button.dataset.do === 'delete') {
        if (!(await confirmDelete(key))) return;
        await api.keyDelete(key.path);
        await showKeys();
        return refocus();
      }
      const text = await api.keyPublic(key.path);
      if (button.dataset.do === 'show') {
        const pub = button.closest('.card').querySelector('.pub');
        pub.hidden = !pub.hidden;
        pub.querySelector('.fp').textContent = text;
        button.setAttribute('aria-expanded', !pub.hidden);
      } else {
        await window.__TAURI__.clipboardManager.writeText(text);
        // Kurz grün: die Bestätigung, dass der Schlüssel in der Zwischenablage liegt.
        button.classList.add('ok');
        setTimeout(() => button.classList.remove('ok'), 1500);
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
    const show = keyList.querySelector(`[data-do=show][data-i="${keys.findIndex((k) => k.path === created)}"]`);
    show?.click();
    (show ?? dialog.querySelector('.areas .on')).focus();
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

  await done;
  apply();
}

// Liefert den Pfad des neuen Schlüssels oder null.
async function newKey() {
  const { dialog, done } = openDialog(`
    <h2>${icon('key')}Neuer Schlüssel</h2>
    <p>Erzeugt einen ED25519-Schlüssel im Ordner .ssh, zusammen mit der .pub-Datei. Vorhandene Dateien werden nie überschrieben.</p>
    <label class="field"><span>Dateiname</span>
      <input class="in mono" name="name" required pattern="[A-Za-z0-9_\\-][A-Za-z0-9_.\\-]*" value="id_ed25519_lotse" spellcheck="false" autofocus>
      <span class="hint">Buchstaben, Ziffern, Punkt, Binde- und Unterstrich</span></label>
    <label class="field"><span>Passphrase (freiwillig)</span>
      <input class="in" name="passphrase" type="password" autocomplete="new-password">
      <span class="hint">Schützt die Datei auf diesem Rechner</span></label>
    <label class="field"><span>Passphrase wiederholen</span>
      <input class="in" name="repeat" type="password" autocomplete="new-password"></label>
    <div class="acts">
      <button value="" formnovalidate class="btn">Abbrechen</button>
      <button value="ok" class="btn pri">Erzeugen</button>
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
    <h2>${icon('warn')}Schlüssel „${esc(key.name)}“ löschen?</h2>
    <p class="lead">Diese Datei und die .pub-Datei daneben werden endgültig gelöscht. Das lässt sich nicht rückgängig machen.</p>
    <div class="fp">${esc(key.path)}</div>
    <p>${key.hosts.length
      ? `Diese Hosts verwenden den Schlüssel und können sich danach nicht mehr damit anmelden: ${esc(key.hosts.join(', '))}`
      : 'Kein Host in Lotse verwendet diesen Schlüssel.'}</p>
    <div class="acts">
      <button value="" class="btn" autofocus>Abbrechen</button>
      <button value="delete" class="btn dfill">Endgültig löschen</button>
    </div>`, 'warn').done;
  return action === 'delete';
}
