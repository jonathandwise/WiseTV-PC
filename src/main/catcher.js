'use strict';
// A nearly invisible window laid over the picture (the whole window in the player, the preview
// box in the guide) that catches the mouse. On Windows, mouse input over the embedded video
// reaches neither mpv nor the interface, so clicks and movement there are caught here and passed
// to the interface as if they had happened on it. Used on Windows in the standard drawing mode.
const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const log = require('./log');

let win = null;
let ui = null;
let parent = null;
let video = null; // last layout from the interface: { mode: 'full' | 'rect' | 'hidden', x, y, w, h }
let lastMode = '';

function create(videoWin, uiWin, onEvent) {
  ui = uiWin;
  parent = videoWin;
  win = new BrowserWindow({
    parent: videoWin,
    frame: false,
    show: false,
    backgroundColor: '#000000',
    skipTaskbar: true,
    resizable: process.platform !== 'win32', // Linux (tests) ignores setBounds on fixed-size windows
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'catcher-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenu(null);
  // 1% black: invisible over the picture, but Windows still sends it the mouse.
  win.setOpacity(Number(process.env.WISETV_CATCHER_OPACITY) || 0.01);
  win.loadURL(`data:text/html,${encodeURIComponent('<!doctype html><html><head><meta charset="utf-8"><title>WiseTV mouse</title></head><body style="margin:0;width:100vw;height:100vh;overflow:hidden;background:#000"></body></html>')}`);
  win.webContents.on('did-finish-load', () => { lastMode = ''; update(); });
  ipcMain.on('catcher', (e, ev) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents || !ev) return;
    onEvent(ev, win.getContentBounds());
  });
  log.i('mouse catcher window on');
}

function place(v) {
  video = v;
  update();
}

function update() {
  if (!win || win.isDestroyed() || !ui || ui.isDestroyed()) return;
  const ub = ui.getContentBounds();
  let b = null;
  const shown = ui.isVisible() && parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized();
  if (shown && video && video.mode === 'full') b = ub;
  else if (shown && video && video.mode === 'rect' && video.w > 0 && video.h > 0) {
    b = { x: ub.x + Math.round(video.x), y: ub.y + Math.round(video.y), width: Math.round(video.w), height: Math.round(video.h) };
  }
  if (!b) {
    if (win.isVisible()) win.hide();
    return;
  }
  const cur = win.getBounds();
  if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) {
    win.setBounds(b);
    if (process.env.WISETV_DEBUG) log.i(`catcher ${video.mode} ${JSON.stringify(b)}`);
  }
  if (!win.isVisible()) {
    win.showInactive();
    // Windows keeps it above the main window by itself (it's owned by it); Linux needs a raise.
    if (process.platform !== 'win32') { try { win.moveTop(); } catch (_) { /* ignore */ } }
    try { ui.moveAbove(win.getMediaSourceId()); } catch (_) { try { ui.moveTop(); } catch (__) { /* ignore */ } }
  }
  const mode = video.mode;
  if (mode !== lastMode) {
    lastMode = mode;
    win.webContents.send('catcher-mode', mode);
  }
}

module.exports = { create, place, update };
