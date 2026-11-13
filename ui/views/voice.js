// Spracheingabe für einen Reiter: aufnehmen, auf dem eigenen Rechner erkennen lassen, Text liefern.
import { api } from '../api.js';
import { alertBox } from '../dialog.js';

const RATE = 16000;
const MAX_MS = 120000;

export const micError = (e) => ({
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
  let clock = 0;

  function show(next) {
    state = next;
    button.classList.toggle('rec', state === 'rec');
    button.classList.toggle('busy', state === 'start' || state === 'busy');
    button.setAttribute('aria-pressed', state === 'rec');
    const label = { rec: 'Aufnahme beenden', start: 'Spracheingabe startet …', busy: 'Sprache wird erkannt …' }[state] ?? 'Spracheingabe';
    button.setAttribute('aria-label', label);
    button.title = `${label} (Strg + Umschalt + M)`;
    // Beim Erkennen zählt der Knopf die Sekunden: große Modelle brauchen lange, und ohne Anzeige sieht das tot aus.
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
      // Nach der Rückfrage zum Mikrofon kann der Kontext angehalten starten: dann käme kein Ton an.
      await context.resume();
      const node = context.createScriptProcessor(1024, 1, 1);
      const device = stream.getAudioTracks()[0]?.label ?? '';
      const taken = { id, stream, context, device, chunks: [], peak: 0, level: 0, timer: setTimeout(finish, MAX_MS) };
      node.onaudioprocess = (e) => {
        const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
        let loud = 0;
        for (const sample of chunk) loud = Math.max(loud, Math.abs(sample));
        taken.peak = Math.max(taken.peak, loud);
        taken.chunks.push(chunk);
        // Der Ring um den Knopf folgt der Lautstärke: schnell hoch, langsam runter. So sieht man, dass Ton ankommt.
        taken.level = Math.max(Math.min(1, loud * 4), taken.level * 0.8);
        if (rec === taken) button.style.setProperty('--level', taken.level.toFixed(2));
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
    const { id, chunks, peak, device } = end();
    const samples = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      samples.set(chunk, at);
      at += chunk.length;
    }
    // Zu kurz (unter 0,3 s): ein versehentlicher Doppelklick, nichts melden.
    if (samples.length < RATE * 0.3) return show('');
    if (peak < 0.01) {
      show('');
      return alertBox('Nichts gehört', `Vom Mikrofon kam kein Ton${device ? ` (${device})` : ''}. Prüfe in den Windows-Einstellungen unter System, Sound, ob das richtige Mikrofon als Standard gewählt und nicht stummgeschaltet ist.`);
    }
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
