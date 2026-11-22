'use strict';
// Mouse catcher window (see catcher.js): reports mouse events to the main process.
const { ipcRenderer } = require('electron');

let mode = 'full';
let timer = null;
const setCursor = (c) => {
  document.documentElement.style.cursor = c;
  if (document.body) document.body.style.cursor = c;
};
const showCursor = () => {
  setCursor('');
  clearTimeout(timer);
  if (mode === 'full') timer = setTimeout(() => setCursor('none'), 3000);
};
const send = (type, e, arg) => ipcRenderer.send('catcher', { type, x: e.clientX, y: e.clientY, arg });

window.addEventListener('mousemove', (e) => { showCursor(); send('move', e); });
window.addEventListener('click', (e) => { if (e.button === 0) send('click', e); });
window.addEventListener('dblclick', (e) => { if (e.button === 0) send('dblclick', e); });
window.addEventListener('contextmenu', (e) => { e.preventDefault(); send('context', e); });
window.addEventListener('wheel', (e) => send('wheel', e, Math.sign(e.deltaY)), { passive: true });
window.addEventListener('mouseup', (e) => { if (e.button === 3) send('back', e); });
window.addEventListener('mousedown', (e) => { if (e.button === 1 || e.button === 3) e.preventDefault(); });
ipcRenderer.on('catcher-mode', (_e, m) => { mode = m; showCursor(); });
