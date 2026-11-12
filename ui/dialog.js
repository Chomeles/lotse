// Kleine Helfer rund um das <dialog>-Element des Browsers.

export const esc = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Öffnet einen Dialog mit Formular. `done` liefert { action, data }:
// `action` ist der value des gedrückten Knopfs ('' bei Esc), `data` sind die Formularfelder.
export function openDialog(html) {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<form method="dialog">${html}</form>`;
  document.body.append(dialog);
  dialog.showModal();
  const done = new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const data = Object.fromEntries(new FormData(dialog.querySelector('form')));
      dialog.remove();
      resolve({ action: dialog.returnValue, data });
    }, { once: true });
  });
  return { dialog, done };
}

export const alertBox = (title, text) =>
  openDialog(`
    <h2>${esc(title)}</h2>
    <p>${esc(text)}</p>
    <div class="buttons"><button value="ok" class="primary" autofocus>OK</button></div>`).done;

export const ask = (text) => window.__TAURI__.dialog.ask(text, { title: 'Lotse', kind: 'warning' });
