import { theme } from '../theme.js';

const open = new Set();

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
  });
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
  parent.querySelector('.term').addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const text = await readText().catch(() => '');
    if (text) term.paste(text);
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
