import { openDialog } from '../dialog.js';

// Liefert geänderte Einstellungen oder null.
export async function editSettings(settings) {
  const { action, data } = await openDialog(`
    <h2>Einstellungen</h2>
    <label><span>Scrollback (Zeilen, die das Terminal behält)</span>
      <input name="scrollback" type="number" min="100" max="1000000" step="100" required value="${settings.scrollback}" autofocus></label>
    <label><span>Schriftgröße (auch mit Strg + Plus/Minus)</span>
      <input name="font_size" type="number" min="8" max="40" required value="${settings.font_size}"></label>
    <label class="check"><input name="typing_sound" type="checkbox" ${settings.typing_sound ? 'checked' : ''}> Leiser Tastenton beim Tippen</label>
    <div class="buttons">
      <button value="" formnovalidate>Abbrechen</button>
      <button value="save" class="primary">Speichern</button>
    </div>`).done;
  if (action !== 'save') return null;
  return {
    ...settings,
    scrollback: Number(data.scrollback),
    font_size: Number(data.font_size),
    typing_sound: data.typing_sound === 'on',
  };
}
