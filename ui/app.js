import { createTerminal } from './views/terminal.js';

// Stufe 0: nur das Terminal mit dem Theme zeigen.
const panes = document.getElementById('panes');
panes.innerHTML = '<div class="pane"><div class="pane-body"><div class="term-view"></div></div></div>';
const { term } = createTerminal(panes.querySelector('.term-view'), { fontSize: 14, scrollback: 10000 }, () => {});
term.write([
  'Linux debian 6.12.0-amd64 #1 SMP Debian x86_64',
  '',
  'The programs included with the Debian GNU/Linux system are free software.',
  'Last login: Thu Nov 12 21:58:03 2026 from \x1b[35m192.168.1.20\x1b[0m',
  '\x1b[1;32mroot@debian\x1b[0m:\x1b[34m~\x1b[0m# ',
].join('\r\n'));
