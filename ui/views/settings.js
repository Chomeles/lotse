import { api } from '../api.js';
import { alertBox, ask, errorHint, esc, openDialog } from '../dialog.js';
import { icon } from '../icons.js';
import { checkUpdate } from '../update.js';
import { micError } from './voice.js';

const size = (bytes) =>
  (bytes < 1e9 ? `${Math.round(bytes / 1e6)} MB` : `${(bytes / 1e9).toFixed(1).replace('.', ',')} GB`);

// Vier Punkte, davon `n` gefüllt, und das Wort dazu: die Stufe ist nicht nur an der Farbe zu erkennen.
const level = (label, n, word) =>
  `<div class="vrow"><span>${label}</span><span class="pips" aria-hidden="true">${'●'.repeat(n)}${'○'.repeat(4 - n)}</span><span>${word}</span></div>`;

// Lädt ein Sprachmodell und macht es danach zum aktiven. Läuft weiter, wenn die Verwaltung geschlossen wird;
// den Stand kennt Rust (`voiceModels`), nicht dieses Fenster.
async function downloadModel(model, getSettings, onChange) {
  try {
    if (await api.voiceDownload(model.id)) onChange({ ...getSettings(), voice_model: model.id });
  } catch (e) {
    await alertBox(`Modell „${model.name}“ nicht geladen`, String(e));
  }
}

// Fenster „Verwaltung“ mit vier Bereichen: Einstellungen, Spracheingabe, Schlüssel, Bekannte Hosts.
// Alles wirkt sofort: geänderte Einstellungen gehen an `onChange`, `getSettings()` liefert den Stand von jetzt.
// `hosts` wird nur gelesen (welcher Host nutzt welchen Schlüssel). `area` ist der Bereich, der zuerst offen ist,
// `hint` ein Satz, warum die Spracheingabe gerade nicht geht.
export async function openSettings(getSettings, hosts, onChange, area = 'settings', hint = '') {
  const settings = getSettings();
  const { dialog, done } = openDialog(`
    <nav class="areas" aria-label="Bereiche">
      <h2>Verwaltung</h2>
      <button type="button" class="navbtn on" data-area="settings">${icon('settings')}Einstellungen</button>
      <button type="button" class="navbtn" data-area="voice">${icon('mic')}Spracheingabe</button>
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
            <div class="set"><span><span class="version">Version</span><span class="hint" role="status"></span></span>
              <button type="button" class="btn check-update">Nach Updates suchen</button></div>
          </div>
        </section>
        <section data-area="voice" hidden>
          <h3>Spracheingabe</h3>
          ${hint ? errorHint(hint) : ''}
          <p>Sprechen statt tippen: Das Mikrofon über dem Terminal oder Strg + Umschalt + M nimmt auf, der erkannte Text landet an der Schreibmarke. Die Erkennung läuft auf deinem Rechner, es wird nichts hochgeladen. Das Modell wird einmalig von huggingface.co geladen und bleibt, bis du es löschst.</p>
          <div class="vrange">
            <input type="range" min="0" max="3" step="1" aria-label="Modell">
            <div class="vticks" aria-hidden="true"></div>
          </div>
          <div class="card"></div>
          <h4>Mikrofon testen</h4>
          <div class="card mictest">
            <div class="info">
              <div class="title"><strong class="micname">Mikrofon</strong></div>
              <div class="meter" role="meter" aria-label="Pegel" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
              <span class="hint micnote" role="status">Zeigt, welches Mikrofon Hostess benutzt und wie laut es dich hört.</span>
            </div>
            <div class="vacts"><button type="button" class="btn" data-do="mic">Test starten</button></div>
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
          <p>Server, deren Schlüssel du schon bestätigt hast. Nach dem Entfernen fragt Hostess beim nächsten Verbinden neu.</p>
          <div class="known"></div>
        </section>
      </div>
      <div class="acts"><button value="" formnovalidate class="btn">Schließen</button></div>
    </div>`, 'wide');
  const form = dialog.querySelector('form');
  const section = (area) => dialog.querySelector(`section[data-area=${area}]`);
  const keyList = section('keys').querySelector('.cards');
  const knownList = section('known').querySelector('.known');
  let keys = [];
  let known = [];

  // Übernimmt die Einstellungen, sobald alle Felder gültig sind und sich etwas geändert hat.
  const apply = () => {
    const { scrollback, font_size, paste_dir } = form.elements;
    if (![scrollback, font_size, paste_dir].every((field) => field.checkValidity()) || !paste_dir.value.trim()) return;
    const current = getSettings();
    const next = {
      ...current,
      scrollback: Number(scrollback.value),
      font_size: Number(font_size.value),
      paste_dir: paste_dir.value.trim(),
    };
    if (JSON.stringify(next) !== JSON.stringify(current)) onChange(next);
  };
  section('settings').addEventListener('change', apply);

  window.__TAURI__.app.getVersion().then((v) => { section('settings').querySelector('.version').textContent = `Version ${v}`; });
  section('settings').querySelector('.check-update').addEventListener('click', async ({ target }) => {
    const status = target.closest('.set').querySelector('.hint');
    target.disabled = true;
    status.textContent = 'Prüfe …';
    try {
      const version = await checkUpdate();
      status.textContent = version
        ? `Version ${version} verfügbar. „Installieren“ steht unten in der Seitenleiste.`
        : 'Hostess ist aktuell.';
    } catch {
      status.textContent = 'Prüfung fehlgeschlagen: kein Internet oder Server nicht erreichbar.';
    }
    target.disabled = false;
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

  // ---------- Spracheingabe ----------
  const voice = section('voice');
  const range = voice.querySelector('input');
  const card = voice.querySelector('.card');
  const recommended = navigator.hardwareConcurrency >= 8 ? 'small' : 'base';
  let models = null;
  let polling = false;

  // Zeichnet die Karte zum Modell unter dem Regler. Neu gebaut wird sie nur, wenn sich der Zustand ändert;
  // läuft ein Download, ändert sich sonst nur der Balken, damit „Abbrechen“ unter der Maus bleibt.
  function showModel() {
    const m = models?.[range.value];
    if (!m) return;
    const active = m.installed && getSettings().voice_model === m.id;
    const part = !m.installed && (m.downloading || m.loaded > 0);
    const percent = Math.floor(m.loaded * 100 / m.bytes);
    range.setAttribute('aria-valuetext', `${m.name}, ${size(m.bytes)}`);
    const key = JSON.stringify([m.id, m.installed, m.downloading, active, part]);
    if (card.dataset.key !== key) {
      const focused = card.contains(document.activeElement);
      const i = Number(range.value);
      card.dataset.key = key;
      card.innerHTML = `
        <div class="info">
          <div class="title"><strong>${esc(m.name)}</strong><span class="badge">${size(m.bytes)}</span>
            ${m.id === recommended ? '<span class="badge">Empfohlen für deinen Rechner</span>' : ''}
            ${active ? '<span class="badge ok">Aktiv</span>' : ''}</div>
          <span class="hint">${esc(m.note)}</span>
          ${level('Genauigkeit', i + 1, ['mäßig', 'gut', 'sehr gut', 'am besten'][i])}
          ${level('Tempo', 4 - i, ['langsam', 'mittel', 'schnell', 'sehr schnell'][3 - i])}
        </div>
        <div class="vacts">
          ${part ? `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Fortschritt von ${esc(m.name)}"><span></span></div><span class="hint mono pct"></span>` : ''}
          ${m.installed && !active ? '<button type="button" class="btn pri" data-do="use">Verwenden</button>' : ''}
          ${m.downloading ? '<button type="button" class="btn" data-do="cancel">Abbrechen</button>' : ''}
          ${!m.installed && !m.downloading ? `<button type="button" class="btn pri" data-do="download">${icon('download')}${part ? 'Fortsetzen' : 'Herunterladen'}</button>` : ''}
          ${!m.downloading && (m.installed || part) ? '<button type="button" class="btn danger" data-do="delete">Löschen</button>' : ''}
        </div>`;
      if (focused) (card.querySelector('button') ?? range).focus();
    }
    if (part) {
      card.querySelector('.bar span').style.width = `${percent}%`;
      card.querySelector('.bar').setAttribute('aria-valuenow', percent);
      card.querySelector('.pct').textContent = `${percent} %`;
    }
  }

  // Fragt den Stand ab, solange der Bereich offen ist: Downloads laufen auch ohne dieses Fenster weiter.
  async function showVoice() {
    if (polling) return;
    polling = true;
    while (dialog.isConnected && !voice.hidden) {
      try {
        const first = !models;
        models = await api.voiceModels();
        if (first) {
          // Der Regler steht auf dem gewählten Modell, sonst auf dem empfohlenen.
          const chosen = models.findIndex((m) => m.id === getSettings().voice_model);
          range.value = chosen >= 0 ? chosen : models.findIndex((m) => m.id === recommended);
          voice.querySelector('.vticks').innerHTML = models.map((m) => `<span>${size(m.bytes)}</span>`).join('');
        }
        showModel();
      } catch (e) {
        card.innerHTML = failed(e);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    polling = false;
  }
  range.addEventListener('input', showModel);
  card.addEventListener('click', async (e) => {
    const m = models?.[range.value];
    const act = e.target.dataset.do;
    if (!m || !act) return;
    try {
      if (act === 'download') {
        // Sofort als laufend zeigen, damit ein zweiter Klick keinen zweiten Download startet.
        m.downloading = true;
        downloadModel(m, getSettings, onChange);
      } else if (act === 'cancel') {
        await api.voiceCancel(m.id);
      } else if (act === 'use') {
        onChange({ ...getSettings(), voice_model: m.id });
      } else if (await ask(`Modell „${m.name}“ löschen?`, 'Die Datei wird von diesem Rechner gelöscht. Du kannst das Modell jederzeit neu herunterladen.', 'Löschen', true)) {
        await api.voiceDelete(m.id);
        m.installed = false;
        m.loaded = 0;
        if (getSettings().voice_model === m.id) onChange({ ...getSettings(), voice_model: '' });
      }
    } catch (err) {
      await alertBox('Spracheingabe', String(err));
    }
    showModel();
  });

  // Mikrofon-Test: derselbe Weg wie bei der Aufnahme (Standard-Mikrofon von Windows), nur mit Pegel statt
  // Erkennung. Das Urteil richtet sich nach dem lautesten Moment seit dem Start.
  const mic = voice.querySelector('.mictest');
  let testing = null;
  function stopTest() {
    if (!testing) return;
    cancelAnimationFrame(testing.frame);
    for (const track of testing.stream.getTracks()) track.stop();
    testing.context.close();
    testing = null;
    mic.querySelector('.meter span').style.width = '0';
    mic.querySelector('button').textContent = 'Test starten';
  }
  async function startTest() {
    const note = mic.querySelector('.micnote');
    const button = mic.querySelector('button');
    button.disabled = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      const bar = mic.querySelector('.meter span');
      mic.querySelector('.micname').textContent = stream.getAudioTracks()[0]?.label.replace(/^Standard - /, '') || 'Mikrofon';
      testing = { stream, context, frame: 0 };
      const mine = testing;
      let level = 0;
      let best = 0;
      const draw = () => {
        if (testing !== mine) return;
        if (!dialog.isConnected || voice.hidden) return stopTest();
        analyser.getFloatTimeDomainData(data);
        let loud = 0;
        for (const sample of data) loud = Math.max(loud, Math.abs(sample));
        best = Math.max(best, loud);
        level = Math.max(loud, level * 0.9);
        const percent = Math.round(Math.min(1, level * 2) * 100);
        bar.style.width = `${percent}%`;
        bar.parentElement.setAttribute('aria-valuenow', percent);
        const [cls, text] = best < 0.01 ? ['', 'Sprich einen Satz. Bisher kommt kein Ton an.']
          : best < 0.08 ? ['amber', 'Ton kommt an, aber leise. Geh näher ans Mikrofon oder dreh es in Windows lauter.']
          : best > 0.98 ? ['amber', 'Zu laut, der Ton übersteuert. Dreh das Mikrofon in Windows leiser.']
          : ['green', 'Gut. So versteht dich die Spracheingabe.'];
        bar.className = cls;
        if (note.textContent !== text) note.textContent = text;
        mine.frame = requestAnimationFrame(draw);
      };
      button.textContent = 'Test beenden';
      draw();
    } catch (e) {
      note.textContent = micError(e);
    }
    button.disabled = false;
  }
  mic.querySelector('button').addEventListener('click', () => (testing ? stopTest() : startTest()));

  function select(area) {
    for (const b of dialog.querySelectorAll('.areas button')) b.classList.toggle('on', b.dataset.area === area);
    for (const s of dialog.querySelectorAll('section')) s.hidden = s.dataset.area !== area;
    if (area === 'voice') showVoice();
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

  if (area !== 'settings') select(area);
  await done;
  stopTest();
  apply();
}

// Liefert den Pfad des neuen Schlüssels oder null.
async function newKey() {
  const { dialog, done } = openDialog(`
    <h2>${icon('key')}Neuer Schlüssel</h2>
    <p>Erzeugt einen ED25519-Schlüssel im Ordner .ssh, zusammen mit der .pub-Datei. Vorhandene Dateien werden nie überschrieben.</p>
    <label class="field"><span>Dateiname</span>
      <input class="in mono" name="name" required pattern="[A-Za-z0-9_\\-][A-Za-z0-9_.\\-]*" value="id_ed25519_hostess" spellcheck="false" autofocus>
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
      : 'Kein Host in Hostess verwendet diesen Schlüssel.'}</p>
    <div class="acts">
      <button value="" class="btn" autofocus>Abbrechen</button>
      <button value="delete" class="btn dfill">Endgültig löschen</button>
    </div>`, 'warn').done;
  return action === 'delete';
}
