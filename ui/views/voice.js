// Spracheingabe für einen Reiter: aufnehmen, auf dem eigenen Rechner erkennen lassen, Text liefern.
// Erkannt wird laufend, während gesprochen wird: der Text erscheint Wort für Wort und wird nachgebessert,
// sobald Whisper mehr vom Satz kennt.
import { api } from '../api.js';
import { alertBox } from '../dialog.js';

const RATE = 16000;
// Nach so langer Aufnahme schaltet sich das Mikrofon von selbst ab (vergessen, auszuschalten).
const MAX_MS = 600000;
// Erst ab so viel Ton lohnt ein Erkennungslauf: aus kürzeren Schnipseln erfindet Whisper Wörter („Thank you“).
const MIN = RATE * 1.2;
// So lange Stille beendet einen Abschnitt: sein Text steht dann fest und wird nicht mehr angefasst.
const PAUSE = RATE * 0.7;
// Spätestens hier endet ein Abschnitt. Whisper verarbeitet höchstens 30 s am Stück.
const LONGEST = RATE * 25;

export const micError = (e) => ({
  NotFoundError: 'Es wurde kein Mikrofon gefunden. Schließe eins an und versuch es noch einmal.',
  NotAllowedError: 'Der Zugriff auf das Mikrofon wurde verweigert. Erlaube ihn in den Windows-Einstellungen unter Datenschutz und Sicherheit, Mikrofon.',
  NotReadableError: 'Das Mikrofon ließ sich nicht öffnen. Vielleicht benutzt es gerade ein anderes Programm.',
})[e?.name] ?? String(e);

// Was am Ende von `old` zu löschen und was danach zu schreiben ist, damit `next` dasteht. Gezählt wird in
// Zeichen, nicht in UTF-16-Einheiten: das Terminal löscht je Rücktaste ein Zeichen.
export function edit(old, next) {
  const [a, b] = [Array.from(old), Array.from(next)];
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  return { del: a.length - same, text: b.slice(same).join('') };
}

// `button` ist der Mikrofon-Knopf. `getModel()` liefert die id des gewählten Modells, `getLang()` das
// Sprachkürzel oder '' (Whisper erkennt die Sprache selbst). `onEdit(del, text)` löscht
// die letzten `del` Zeichen und schreibt `text` an die Schreibmarke. `onSetup(grund, zuruecksetzen)` führt in die
// Verwaltung, wenn kein brauchbares Modell gewählt ist.
export function createVoice(button, { getModel, getLang, onEdit, onSetup }) {
  // '' wartet, 'start' öffnet das Mikrofon, 'rec' nimmt auf und erkennt laufend, 'busy' erkennt den Rest.
  let state = '';
  let rec = null;
  // Zählt hoch, wenn etwas Laufendes verworfen wird (Reiter zu, Verbindung weg).
  let run = 0;
  let clock = 0;

  function show(next) {
    state = next;
    button.classList.toggle('rec', state === 'rec');
    button.classList.toggle('busy', state === 'start' || state === 'busy');
    button.setAttribute('aria-pressed', state === 'rec');
    const label = { rec: 'Spracheingabe beenden', start: 'Spracheingabe startet …', busy: 'Sprache wird erkannt …' }[state] ?? 'Spracheingabe';
    button.setAttribute('aria-label', label);
    button.title = `${label} (Strg + Umschalt + M)`;
    // Dauert der letzte Lauf lange (großes Modell ohne Grafikkarte), zählt der Knopf die Sekunden.
    clearInterval(clock);
    delete button.dataset.s;
    if (state === 'busy') {
      const since = Date.now();
      clock = setInterval(() => { button.dataset.s = `${Math.round((Date.now() - since) / 1000)} s`; }, 1000);
    }
  }

  // Fehlt das Modell oder ist es beschädigt, hilft nur die Verwaltung. Alles andere ist eine Fehlermeldung.
  async function failed(id, e) {
    const model = (await api.voiceModels().catch(() => [])).find((m) => m.id === id);
    if (model && !model.installed) onSetup(`Das Modell „${model.name}“ fehlt oder ist beschädigt. Lade es neu herunter oder wähle ein anderes.`, true);
    else await alertBox('Spracheingabe', String(e));
  }

  // Beendet die Aufnahme und gibt das Mikrofon frei.
  function end() {
    const done = rec;
    rec = null;
    clearTimeout(done.timer);
    for (const track of done.stream.getTracks()) track.stop();
    done.context.close();
    button.style.removeProperty('--level');
    return done;
  }

  // Ein Erkennungslauf über den laufenden Abschnitt: bringt den Text im Terminal auf den neuen Stand und
  // schließt den Abschnitt ab, wenn eine Sprechpause folgt (`last`: immer).
  async function pass(taken, mine, last) {
    const chunks = taken.chunks.slice();
    const length = chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
    if (!chunks.some((chunk) => chunk.voiced)) {
      // Nur Stille: nichts erkennen, aber einen kurzen Vorlauf behalten, damit der Satzanfang nicht fehlt.
      taken.chunks.splice(0, Math.max(0, chunks.length - 5));
      return;
    }
    if (!last && length < MIN) return;
    let quiet = 0;
    for (let i = chunks.length - 1; i >= 0 && !chunks[i].voiced; i--) quiet += chunks[i].data.length;
    const samples = new Float32Array(length);
    let at = 0;
    for (const chunk of chunks) {
      samples.set(chunk.data, at);
      at += chunk.data.length;
    }
    const text = (await api.voiceTranscribe(taken.id, samples, getLang())).replace(/\s+/g, ' ').trim();
    if (run !== mine) return;
    const done = last || quiet >= PAUSE || length >= LONGEST;
    // Mitten im Satz rät Whisper das letzte Wort oft falsch und setzt jedes Mal einen Punkt. Gezeigt wird
    // deshalb nur, worin sich dieser und der vorige Lauf einig sind; erst der fertige Abschnitt erscheint ganz.
    const words = text.replace(/[.!?…]+$/, '').split(' ');
    let agreed = 0;
    while (agreed < words.length && words[agreed] === taken.guess[agreed]) agreed++;
    taken.guess = done ? [] : words;
    const shown = done ? text : words.slice(0, agreed).join(' ');
    const change = edit(taken.typed, shown);
    if (change.del || change.text) onEdit(change.del, change.text);
    taken.typed = shown;
    if (done) {
      // Abschnitt fertig: sein Text bleibt stehen, der nächste beginnt nach einem Leerzeichen.
      if (text) onEdit(0, ' ');
      taken.typed = '';
      taken.chunks.splice(0, chunks.length);
    }
  }

  // Erkennt, solange aufgenommen wird, immer wieder den laufenden Abschnitt. Ein langsamer Rechner schafft
  // weniger Läufe: der Text kommt dann in größeren Schritten.
  async function live(taken, mine) {
    while (rec === taken && run === mine) {
      taken.pending = pass(taken, mine, false);
      try {
        await taken.pending;
      } catch (e) {
        if (rec !== taken || run !== mine) return;
        end();
        show('');
        return failed(taken.id, e);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async function start() {
    const mine = ++run;
    show('start');
    const id = getModel();
    try {
      const model = (await api.voiceModels()).find((m) => m.id === id);
      if (run !== mine) return;
      if (!model?.installed) {
        show('');
        return onSetup(model ? `Das Modell „${model.name}“ fehlt oder ist beschädigt. Lade es neu herunter oder wähle ein anderes.` : '', Boolean(model));
      }
      // Das Modell lädt schon, während das Mikrofon öffnet. Scheitert das, meldet es der erste Erkennungslauf.
      api.voicePreload(id).catch(() => {});
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (run !== mine) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const context = new AudioContext({ sampleRate: RATE });
      // Nach der Rückfrage zum Mikrofon kann der Kontext angehalten starten: dann käme kein Ton an.
      await context.resume();
      const node = context.createScriptProcessor(1024, 1, 1);
      const device = stream.getAudioTracks()[0]?.label ?? '';
      // `floor` schätzt das Grundrauschen: Sprache ist, was deutlich darüber liegt.
      const taken = { id, stream, context, device, chunks: [], typed: '', guess: [], peak: 0, level: 0, floor: 1, heard: false, pending: null, timer: setTimeout(finish, MAX_MS) };
      node.onaudioprocess = (e) => {
        const data = new Float32Array(e.inputBuffer.getChannelData(0));
        let loud = 0;
        for (const sample of data) loud = Math.max(loud, Math.abs(sample));
        taken.peak = Math.max(taken.peak, loud);
        // Das Rauschen folgt leisen Momenten sofort und steigt sonst nur langsam.
        taken.floor = Math.min(loud, taken.floor * 1.02 + 0.0001);
        const voiced = loud > Math.max(0.02, taken.floor * 4);
        taken.heard ||= voiced;
        taken.chunks.push({ data, voiced });
        // Der Knopf pulsiert mit der Lautstärke: schnell hoch, langsam runter. So sieht man, dass Ton ankommt.
        taken.level = Math.max(Math.min(1, loud * 4), taken.level * 0.8);
        if (rec === taken) button.style.setProperty('--level', taken.level.toFixed(2));
      };
      context.createMediaStreamSource(stream).connect(node);
      // Der Knoten läuft nur, wenn er am Ausgang hängt. Er gibt selbst nichts aus.
      node.connect(context.destination);
      rec = taken;
      show('rec');
      live(taken, mine);
    } catch (e) {
      if (run !== mine) return;
      show('');
      await alertBox('Spracheingabe', micError(e));
    }
  }

  // Mikrofon aus: der Rest des laufenden Abschnitts wird noch erkannt.
  async function finish() {
    const mine = run;
    const taken = end();
    show('busy');
    try {
      await taken.pending;
      if (run === mine) await pass(taken, mine, true);
    } catch (e) {
      if (run === mine) await failed(taken.id, e);
    }
    if (run !== mine) return;
    show('');
    if (!taken.heard && taken.peak < 0.01) {
      await alertBox('Nichts gehört', `Vom Mikrofon kam kein Ton${taken.device ? ` (${taken.device})` : ''}. Prüfe in den Windows-Einstellungen unter System, Sound, ob das richtige Mikrofon als Standard gewählt und nicht stummgeschaltet ist.`);
    }
  }

  return {
    // Schaltet das Mikrofon ein oder aus.
    toggle() {
      if (state === 'rec') finish();
      else if (!state) start();
    },
    // Verwirft alles Laufende. Schon geschriebener Text bleibt stehen.
    stop() {
      run++;
      if (rec) end();
      show('');
    },
  };
}
