// Spracheingabe für einen Reiter: aufnehmen, auf dem eigenen Rechner erkennen lassen, Text liefern.
import { api } from '../api.js';
import { alertBox } from '../dialog.js';

const RATE = 16000;
const MAX_MS = 120000;

const micError = (e) => ({
  NotFoundError: 'Es wurde kein Mikrofon gefunden. Schließe eins an und versuch es noch einmal.',
  NotAllowedError: 'Der Zugriff auf das Mikrofon wurde verweigert. Erlaube ihn in den Windows-Einstellungen unter Datenschutz und Sicherheit, Mikrofon.',
  NotReadableError: 'Das Mikrofon ließ sich nicht öffnen. Vielleicht benutzt es gerade ein anderes Programm.',
})[e?.name] ?? String(e);

// `button` ist der Mikrofon-Knopf. `getModel()` liefert die id des gewählten Modells, `onText(text)` bekommt das
// Erkannte, `onSetup(grund, zuruecksetzen)` führt in die Verwaltung, wenn kein brauchbares Modell gewählt ist.
export function createVoice(button, { getModel, onText, onSetup }) {
  // '' wartet, 'start' öffnet das Mikrofon, 'rec' nimmt auf, 'busy' erkennt.
  let state = '';
  let rec = null;
  // Zählt hoch, wenn etwas Laufendes verworfen wird (Reiter zu, Verbindung weg).
  let run = 0;

  function show(next) {
    state = next;
    button.classList.toggle('rec', state === 'rec');
    button.classList.toggle('busy', state === 'start' || state === 'busy');
    button.setAttribute('aria-pressed', state === 'rec');
    const label = { rec: 'Aufnahme beenden', start: 'Spracheingabe startet …', busy: 'Sprache wird erkannt …' }[state] ?? 'Spracheingabe';
    button.setAttribute('aria-label', label);
    button.title = `${label} (Strg + Umschalt + M)`;
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
    return done;
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
      // Das Modell lädt schon, während gesprochen wird. Scheitert das nach der Aufnahme, meldet es die Erkennung.
      api.voicePreload(id).catch((e) => {
        if (run !== mine || state !== 'rec') return;
        end();
        show('');
        failed(id, e);
      });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (run !== mine) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const context = new AudioContext({ sampleRate: RATE });
      const node = context.createScriptProcessor(4096, 1, 1);
      const taken = { id, stream, context, chunks: [], peak: 0, timer: setTimeout(finish, MAX_MS) };
      node.onaudioprocess = (e) => {
        const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
        for (const sample of chunk) taken.peak = Math.max(taken.peak, Math.abs(sample));
        taken.chunks.push(chunk);
      };
      context.createMediaStreamSource(stream).connect(node);
      // Der Knoten läuft nur, wenn er am Ausgang hängt. Er gibt selbst nichts aus.
      node.connect(context.destination);
      rec = taken;
      show('rec');
    } catch (e) {
      if (run !== mine) return;
      show('');
      await alertBox('Spracheingabe', micError(e));
    }
  }

  async function finish() {
    const mine = run;
    const { id, chunks, peak } = end();
    const samples = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      samples.set(chunk, at);
      at += chunk.length;
    }
    // Zu kurz (unter 0,3 s) oder nur Stille: nichts einfügen und nichts melden.
    if (samples.length < RATE * 0.3 || peak < 0.01) return show('');
    show('busy');
    try {
      const text = await api.voiceTranscribe(id, samples);
      if (run === mine && text) onText(text);
    } catch (e) {
      if (run === mine) await failed(id, e);
    }
    if (run === mine) show('');
  }

  return {
    // Startet die Aufnahme oder beendet sie und lässt erkennen.
    toggle() {
      if (state === 'rec') finish();
      else if (!state) start();
    },
    // Verwirft alles Laufende, ohne etwas einzufügen.
    stop() {
      run++;
      if (rec) end();
      show('');
    },
  };
}
