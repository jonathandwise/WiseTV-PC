'use strict';
// WiseTV for Windows: app lifecycle, the two windows (video underneath, interface on top), tray.
const { app, BaseWindow, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, dialog, Notification, powerSaveBlocker, powerMonitor, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const settings = require('./settings');
const log = require('./log');
const db = require('./db');
const bus = require('./bus');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('com.wisetv.player');
if (process.env.WISETV_USER_DATA) app.setPath('userData', process.env.WISETV_USER_DATA);

// mpv draws into a child window of WiseTV's video window. Since Chromium 139, Windows windows made by
// Chromium with DirectComposition get no redirection surface, so child windows like mpv's stay
// invisible (sound, but a black picture). Turning DirectComposition off restores them.
if (process.platform === 'win32' && process.env.WISETV_DCOMP !== '1') {
  app.commandLine.appendSwitch('disable-direct-composition');
}

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const startHidden = process.argv.includes('--hidden');
let videoWin = null;
let uiWin = null;
let tray = null;
let quitting = false;
let overlayMode = 'transparent';
let mpv = null;
let shownTrayHint = false;

function decideOverlayMode() {
  const forced = process.env.WISETV_OVERLAY || settings.overlayMode;
  if (forced === 'transparent' || forced === 'shape') return forced;
  // "shape" works without DirectComposition (see the top of this file), so it is the default.
  return 'shape';
}

function send(name, payload) {
  if (uiWin && !uiWin.isDestroyed()) uiWin.webContents.send('ev', name, payload);
}

function syncBounds() {
  if (!videoWin || !uiWin || videoWin.isDestroyed() || uiWin.isDestroyed()) return;
  const b = videoWin.getContentBounds();
  uiWin.setBounds(b);
}

function saveBounds() {
  if (!videoWin || videoWin.isDestroyed() || videoWin.isFullScreen() || videoWin.isMinimized()) return;
  settings.windowBounds = { ...videoWin.getNormalBounds(), maximized: videoWin.isMaximized() };
}

function initialBounds() {
  const saved = settings.windowBounds;
  const work = screen.getPrimaryDisplay().workArea;
  if (saved && saved.width >= 800 && saved.height >= 500) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return saved.x < a.x + a.width - 100 && saved.x + saved.width > a.x + 100 && saved.y < a.y + a.height - 50 && saved.y + 30 > a.y;
    });
    if (visible) return saved;
  }
  const width = Math.min(1600, Math.round(work.width * 0.85));
  const height = Math.min(900, Math.round(work.height * 0.85));
  return { x: work.x + Math.round((work.width - width) / 2), y: work.y + Math.round((work.height - height) / 2), width, height };
}

function iconPath() {
  const ico = path.join(ASSETS, 'icon.ico');
  return process.platform === 'win32' && fs.existsSync(ico) ? ico : path.join(ASSETS, 'icon.png');
}

function createWindows() {
  const b = initialBounds();
  // The video window holds no web page (a BaseWindow, not a BrowserWindow): on Windows a browser
  // surface would be painted over mpv's picture, leaving only the sound.
  videoWin = new BaseWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    minWidth: 960, minHeight: 600,
    backgroundColor: '#000000',
    title: 'WiseTV',
    icon: iconPath(),
    show: false,
    autoHideMenuBar: true,
  });
  videoWin.setMenu(null);

  const transparent = overlayMode === 'transparent';
  uiWin = new BrowserWindow({
    parent: videoWin,
    frame: false,
    transparent,
    backgroundColor: transparent ? '#00000000' : '#0D1015',
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  uiWin.setMenu(null);
  syncBounds();

  for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'show']) videoWin.on(ev, syncBounds);
  for (const ev of ['enter-full-screen', 'leave-full-screen']) {
    videoWin.on(ev, () => {
      syncBounds();
      setTimeout(syncBounds, 150);
      send('fullscreen', videoWin.isFullScreen());
    });
  }
  videoWin.on('moved', saveBounds);
  videoWin.on('resized', saveBounds);
  videoWin.on('maximize', saveBounds);
  videoWin.on('unmaximize', saveBounds);
  videoWin.on('focus', () => { if (uiWin && !uiWin.isDestroyed() && uiWin.isVisible()) uiWin.focus(); });
  videoWin.on('minimize', () => { if (process.platform !== 'win32') uiWin.hide(); });
  videoWin.on('restore', () => { if (!uiWin.isVisible()) uiWin.show(); syncBounds(); });
  videoWin.on('close', (e) => {
    if (!quitting && settings.closeToTray) {
      e.preventDefault();
      hideToTray();
    }
  });
  videoWin.on('closed', () => {
    videoWin = null;
    if (!quitting) app.quit();
  });

  uiWin.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  uiWin.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && process.env.WISETV_DEVTOOLS) uiWin.webContents.openDevTools({ mode: 'detach' });
  });
  uiWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  uiWin.webContents.on('will-navigate', (e) => e.preventDefault());
  uiWin.webContents.on('render-process-gone', (_e, d) => log.i(`ui process gone ${d.reason}`));

  uiWin.once('ready-to-show', () => {
    if (b.maximized) videoWin.maximize();
    if (!startHidden) showWindows();
  });
}

function showWindows() {
  if (!videoWin) return;
  if (videoWin.isMinimized()) videoWin.restore();
  videoWin.show();
  uiWin.show();
  syncBounds();
  uiWin.focus();
  send('shown', true);
}

function hideToTray() {
  require('./playback').park();
  if (videoWin && videoWin.isFullScreen()) videoWin.setFullScreen(false);
  uiWin.hide();
  videoWin.hide();
  send('shown', false);
  if (!shownTrayHint && Notification.isSupported()) {
    shownTrayHint = true;
    new Notification({ title: 'WiseTV is still running', body: 'Scheduled recordings will still happen. Right-click the WiseTV icon by the clock to quit.', icon: iconPath() }).show();
  }
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ASSETS, 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('WiseTV');
  const update = () => {
    const recs = require('./recordings').activeCount;
    tray.setToolTip(recs ? `WiseTV · recording ${recs} programme${recs === 1 ? '' : 's'}` : 'WiseTV');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open WiseTV', click: showWindows },
      ...(recs ? [{ label: `Recording ${recs} programme${recs === 1 ? '' : 's'}`, enabled: false }] : []),
      { type: 'separator' },
      { label: 'Quit WiseTV', click: () => confirmQuit() },
    ]));
  };
  update();
  bus.on('recorders', update);
  tray.on('click', showWindows);
  tray.on('double-click', showWindows);
}

async function confirmQuit() {
  const recs = require('./recordings').activeCount;
  if (recs > 0) {
    const r = await dialog.showMessageBox(videoWin && videoWin.isVisible() ? videoWin : null, {
      type: 'warning',
      buttons: ['Quit and stop recording', 'Keep running'],
      defaultId: 1,
      cancelId: 1,
      title: 'WiseTV',
      message: `WiseTV is recording ${recs} programme${recs === 1 ? '' : 's'}.`,
      detail: 'Quitting stops the recording. What was recorded so far is kept.',
    });
    if (r.response !== 0) return;
  }
  quitting = true;
  app.quit();
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body: body || '', icon: iconPath() }).show();
}

function applyLoginItem() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!settings.startWithWindows, name: 'WiseTV', args: ['--hidden'] });
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  const api = require('./api');
  ipcMain.handle('call', (_e, method, args) => api.call(method, args));
  ipcMain.handle('win', (_e, what, arg) => {
    switch (what) {
      case 'info':
        return { version: app.getVersion(), platform: process.platform, overlayMode, fullscreen: videoWin.isFullScreen(), logFile: log.file, packaged: app.isPackaged };
      case 'toggleFullscreen':
        videoWin.setFullScreen(!videoWin.isFullScreen());
        return videoWin.isFullScreen();
      case 'setFullscreen':
        videoWin.setFullScreen(!!arg);
        return !!arg;
      case 'minimize':
        videoWin.minimize();
        return true;
      case 'hideToTray':
        hideToTray();
        return true;
      case 'quit':
        confirmQuit();
        return true;
      case 'installUpdate':
        require('./updater').install(() => { quitting = true; app.quit(); });
        return true;
      case 'video':
        require('./playback').setVideoRect(arg);
        return true;
      case 'shape':
        if (overlayMode === 'shape' && uiWin && Array.isArray(arg)) uiWin.setShape(arg);
        return true;
      case 'openExternal':
        if (/^https?:\/\//i.test(String(arg))) shell.openExternal(String(arg));
        return true;
      case 'openDataFolder':
        shell.openPath(app.getPath('userData'));
        return true;
      case 'openPath':
        if (arg && fs.existsSync(arg)) shell.openPath(arg);
        return true;
      case 'showItem':
        if (arg && fs.existsSync(arg)) shell.showItemInFolder(arg);
        return true;
      case 'chooseFolder': {
        const r = dialog.showOpenDialogSync(videoWin, { title: 'Choose where to save recordings', properties: ['openDirectory', 'createDirectory'], defaultPath: arg || undefined });
        return r && r[0] ? r[0] : null;
      }
      default:
        throw new Error('Unknown window action ' + what);
    }
  });
  for (const name of ['changed', 'player', 'player-event', 'sync', 'plex', 'leases', 'recorders', 'update']) {
    bus.on(name, (payload) => send(name, payload));
  }
  bus.on('settings', (key, value) => {
    send('settings', { key, value });
    if (key === 'startWithWindows') applyLoginItem();
  });
}

// ---------------------------------------------------------------- startup

async function startMpv() {
  const Mpv = require('./mpv');
  const playback = require('./playback');
  mpv = new Mpv();
  playback.init(mpv);
  // Mouse events mpv saw over the picture, re-sent to the interface at the pointer's position.
  let lastMove = 0;
  let lastPt = null;
  mpv.on('event', (ev) => {
    if (ev.event !== 'client-message' || !Array.isArray(ev.args) || ev.args[0] !== 'wt-mouse') return;
    const type = ev.args[1];
    if (type === 'move') {
      if (Date.now() - lastMove < 40) return;
      lastMove = Date.now();
    }
    if (!uiWin || uiWin.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = uiWin.getContentBounds();
    // Windows reports a move when windows change shape over a pointer that hasn't moved; skip those.
    // mpv's own pointer position is passed along with moves, so those can be told apart.
    if (type === 'move' && /^\d+$/.test(ev.args[2] || '') && /^\d+$/.test(ev.args[3] || '')) {
      const at = `${ev.args[2]},${ev.args[3]}`;
      if (at === lastPt) return;
      lastPt = at;
    }
    send('vmouse', { type, x: p.x - b.x, y: p.y - b.y, arg: ev.args[2] });
  });
  const h = videoWin.getNativeWindowHandle();
  const wid = process.platform === 'win32' ? h.readBigUInt64LE(0).toString() : String(h.readUInt32LE(0));
  try {
    await mpv.start(wid, {
      hwdec: settings.hwdec,
      volume: settings.volume,
      passthrough: settings.audioPassthrough,
      logFile: path.join(app.getPath('userData'), 'mpv.log'),
      inputConf: path.join(app.getPath('userData'), 'mpv-input.conf'),
    });
  } catch (e) {
    log.i(`mpv failed to start: ${e.message}`);
    send('player-event', { type: 'error', message: "The video player couldn't start. Try restarting WiseTV.", everywhere: true });
  }
}

app.on('second-instance', () => showWindows());

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  settings.load(userData);
  log.init(userData);
  log.i(`WiseTV ${app.getVersion()} starting (${process.platform} ${process.arch}, Windows build ${require('os').release()})`);
  log.i(`switches: ${process.argv.slice(1).join(' ')} dcomp-off=${app.commandLine.hasSwitch('disable-direct-composition')}`);
  app.getGPUInfo('basic').then((g) => log.i(`gpu: ${JSON.stringify((g.gpuDevice || []).map((d) => ({ v: d.vendorId, d: d.deviceId, active: d.active, driver: d.driverVersion })))}`)).catch(() => {});
  setTimeout(() => { try { log.i(`gpu features: ${JSON.stringify(app.getGPUFeatureStatus())}`); } catch (_) { /* ignore */ } }, 3000);
  overlayMode = decideOverlayMode();
  db.open(path.join(userData, 'wisetv.db'));
  Menu.setApplicationMenu(null);

  const recordings = require('./recordings');
  const sync = require('./sync');
  recordings.init({ powerSaveBlocker, notify });
  sync.setRules(recordings.rules);

  registerIpc();
  createWindows();
  createTray();
  applyLoginItem();
  await startMpv();

  recordings.rescheduleAll();
  setTimeout(() => sync.refreshAll(false).catch(() => {}), 3000);
  sync.startAuto();
  require('./updater').start();

  powerMonitor.on('resume', () => {
    log.i('system resumed');
    setTimeout(() => sync.refreshAll(false).catch(() => {}), 15000);
  });
});

app.on('before-quit', () => {
  quitting = true;
  try { saveBounds(); } catch (_) { /* ignore */ }
  try { require('./recordings').stopAll('Interrupted (WiseTV was closed)'); } catch (_) { /* ignore */ }
  try { require('./playback').shutdown(); } catch (_) { /* ignore */ }
  try { settings.saveNow(); } catch (_) { /* ignore */ }
  if (mpv) mpv.quit();
});

app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
