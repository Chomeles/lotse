import { theme } from '../theme.js';

const open = new Set();

// IPv4-Adresse: jede Zahl 0–255, nicht Teil eines Worts, einer längeren Ziffernfolge oder einer Versionsnummer wie 1.2.3.4.5.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const IPV4 = new RegExp(`(?<![\\w.])${OCTET}(?:\\.${OCTET}){3}(?!\\w|\\.\\d)`, 'g');

// Liefert [Anfang, Länge] je IPv4-Adresse im Text.
export const findIps = (text) => [...text.matchAll(IPV4)].map((m) => [m.index, m[0].length]);

// Wie `findIps`, aber als Spalten der Terminal-Zeile. Adressen, die der Server selbst eingefärbt hat, fallen weg.
function ipCells(line, cell) {
  let x = 0;
  let pos = 0;
  return findIps(line.translateToString(true)).flatMap(([index, width]) => {
    // Hinter breiten Zeichen (CJK, Emoji) ist die Spalte nicht mehr die Position im Text.
    for (; pos < index; x++) pos += line.getCell(x, cell).getWidth() ? cell.getChars().length || 1 : 0;
    while (line.getCell(x, cell)?.getWidth() === 0) x++;
    return cell.isFgDefault() ? [[x, width]] : [];
  });
}

// Färbt IPv4-Adressen pink. Der Datenstrom bleibt unberührt: die Farbe liegt als Dekoration über dem Text.
// Geprüft werden nur sichtbare Zeilen, die xterm gerade neu gezeichnet hat. Starke Ausgabe kostet so höchstens
// einen Bildschirm je Bild, egal wie viel durchläuft; älterer Text wird gefärbt, sobald man zu ihm scrollt.
// shortcut: eine Adresse, die über den Zeilenumbruch läuft, bleibt ungefärbt; ebenso alles in Vollbild-Programmen
// (vim, htop), denn Dekorationen gibt es bei xterm nur im normalen Puffer. Bei Bedarf umbrochene Zeilen zusammensetzen.
function highlightIps(term) {
  let marks = [];
  const drop = (mark) => mark.marker.dispose();
  term.onRender(({ start, end }) => {
    const buffer = term.buffer.active;
    const top = buffer.viewportY;
    const visible = (line) => buffer.type === 'normal' && line >= top && line < top + term.rows;
    // Dekorationen außerhalb des Bildschirms werden nicht gebraucht, und jede kostet bei jeder neuen Zeile etwas.
    marks = marks.filter((mark) => visible(mark.marker.line) || drop(mark));
    if (buffer.type !== 'normal') return;
    const cell = buffer.getNullCell();
    for (let y = top + start; y <= top + end; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const found = ipCells(line, cell);
      const have = marks.filter((mark) => mark.marker.line === y);
      // Eine neue Dekoration lässt xterm neu zeichnen und ruft damit wieder hierher. Was schon stimmt, bleibt
      // deshalb unangetastet, sonst dreht sich das im Kreis.
      if (have.length === found.length && have.every((mark, i) => mark.x === found[i][0] && mark.width === found[i][1])) continue;
      have.forEach(drop);
      marks = marks.filter((mark) => !have.includes(mark));
      for (const [x, width] of found) {
        const marker = term.registerMarker(y - buffer.baseY - buffer.cursorY);
        if (term.registerDecoration({ marker, x, width, foregroundColor: theme.magenta })) marks.push({ marker, x, width });
        else marker.dispose();
      }
    }
  });
}

// Baut ein Terminal samt Suchleiste in `parent`. `onFontSize(delta)` meldet Strg + Plus/Minus (0 = zurücksetzen).
export function createTerminal(parent, settings, onFontSize) {
  parent.innerHTML = `
    <div class="search" hidden>
      <input type="search" placeholder="Suchen" aria-label="Im Terminal suchen">
      <button type="button" data-dir="prev" aria-label="Vorheriger Treffer">↑</button>
      <button type="button" data-dir="next" aria-label="Nächster Treffer">↓</button>
      <button type="button" data-dir="close" aria-label="Suche schließen">×</button>
    </div>
    <div class="term"></div>`;
  const bar = parent.querySelector('.search');
  const input = bar.querySelector('input');

  const term = new Terminal({
    theme,
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: settings.font_size,
    scrollback: settings.scrollback,
    cursorStyle: 'block',
    cursorBlink: true,
    // Dekorationen (für die IP-Adressen) zählt xterm zur „proposed API“.
    allowProposedApi: true,
  });
  highlightIps(term);
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.open(parent.querySelector('.term'));
  fit.fit();
  const observer = new ResizeObserver(() => fit.fit());
  observer.observe(parent);

  const { readText, writeText } = window.__TAURI__.clipboardManager;
  term.onSelectionChange(() => {
    const text = term.getSelection();
    if (text) writeText(text);
  });
  const paste = async () => {
    const text = await readText().catch(() => '');
    if (text) term.paste(text);
  };
  parent.querySelector('.term').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    paste();
  });

  const closeSearch = () => {
    bar.hidden = true;
    search.clearDecorations();
    term.focus();
  };
  const find = (back) => (back ? search.findPrevious(input.value) : search.findNext(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') find(e.shiftKey);
    if (e.key === 'Escape') closeSearch();
  });
  bar.addEventListener('click', (e) => {
    const dir = e.target.dataset.dir;
    if (dir === 'close') closeSearch();
    else if (dir) find(dir === 'prev');
  });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey) return true;
    if (e.shiftKey && e.code === 'KeyF') {
      bar.hidden = false;
      input.select();
      return false;
    }
    // Wie im Windows-Terminal: Strg + V fügt ein. Strg + C kopiert, wenn etwas markiert ist, sonst bricht es ab.
    if (e.code === 'KeyV') {
      e.preventDefault();
      paste();
      return false;
    }
    if (e.code === 'KeyC' && (e.shiftKey || term.hasSelection())) {
      e.preventDefault();
      writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    const delta = { '+': 1, '=': 1, '-': -1, '0': 0 }[e.key];
    if (delta === undefined || e.shiftKey && e.key !== '+') return true;
    onFontSize(delta);
    return false;
  });

  const entry = { term, fit };
  open.add(entry);
  return {
    term,
    dispose() {
      open.delete(entry);
      observer.disconnect();
      term.dispose();
    },
  };
}

// Übernimmt geänderte Einstellungen in alle offenen Terminals.
export function applySettings(settings) {
  for (const { term, fit } of open) {
    term.options.fontSize = settings.font_size;
    term.options.scrollback = settings.scrollback;
    fit.fit();
  }
}
