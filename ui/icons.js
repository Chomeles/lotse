// Alle Symbole an einer Stelle: Strichzeichnungen auf 16 × 16, Farbe kommt vom Text.
const paths = {
  edit: 'M3 13l.5-2.5L11 3l2 2-7.5 7.5L3 13z',
  plus: 'M8 3v10M3 8h10',
  x: 'M4 4l8 8M12 4l-8 8',
  prev: 'M4 10l4-4 4 4',
  next: 'M4 6l4 4 4-4',
  up: 'M8 13V3m0 0L4 7m4-4 4 4',
  reload: 'M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5',
  folderPlus: 'M2 5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5zM8 7.5v3M6.5 9h3',
  folder: 'M2 5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z',
  file: 'M4 2h5l3 3v9H4V2zM9 2v3h3',
  upload: 'M8 11V3m0 0L5 6m3-3 3 3M3 13h10',
  download: 'M8 2v8m0 0L5 7m3 3 3-3M3 13h10',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5',
  lock: 'M5 7h6a1.5 1.5 0 0 1 1.5 1.5V12A1.5 1.5 0 0 1 11 13.5H5A1.5 1.5 0 0 1 3.5 12V8.5A1.5 1.5 0 0 1 5 7zM5.5 7V5a2.5 2.5 0 0 1 5 0v2',
  warn: 'M8 2.5 14.5 13.5h-13L8 2.5zM8 6.5v3.5M8 12v.2',
  settings: 'M2.5 5h5M11 5h2.5M2.5 11h2M8.5 11h5M7.5 5a1.75 1.75 0 1 0 3.5 0 1.75 1.75 0 0 0-3.5 0zM5 11a1.75 1.75 0 1 0 3.5 0A1.75 1.75 0 0 0 5 11z',
  key: 'M7.5 11a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM7 9l6-6M11 5l1.5 1.5',
  shield: 'M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4l5-2zM6 8l1.5 1.5L10.5 6.5',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  copy: 'M7 5.5h5A1.5 1.5 0 0 1 13.5 7v5a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 12V7A1.5 1.5 0 0 1 7 5.5zM3 10.5v-7a1 1 0 0 1 1-1h6.5',
};

export const icon = (name, cls = '') =>
  `<svg class="i ${cls}" viewBox="0 0 16 16" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
