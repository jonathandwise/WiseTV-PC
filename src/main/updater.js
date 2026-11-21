'use strict';
// Checks GitHub (jonathandwise/WiseTV-PC releases) for a newer WiseTV, downloads the installer and
// runs it silently; the installer closes WiseTV, updates it and starts it again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const bus = require('./bus');
const http = require('./http');
const log = require('./log');

const REPO = 'jonathandwise/WiseTV-PC';
const API = process.env.WISETV_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;

const state = { status: 'idle', latest: null, error: null, progress: 0, file: null, checkedAt: 0 };

function emit() { bus.emit('update', { ...state }); }

/** "1.10.2" > "1.9.0" */
function newer(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function check({ manual = false } = {}) {
  if (state.status === 'downloading' || state.status === 'installing') return { ...state };
  state.status = 'checking';
  state.error = null;
  if (manual) emit();
  try {
    const rel = await http.json(API, { headers: { Accept: 'application/vnd.github+json' }, totalMs: 20000 });
    state.checkedAt = Date.now();
    const version = String(rel.tag_name || '').replace(/^v/i, '');
    const asset = (rel.assets || []).find((a) => /^WiseTV-Setup-.*\.exe$/i.test(a.name));
    if (version && asset && newer(version, app.getVersion())) {
      state.latest = { version, notes: (rel.body || '').trim(), url: asset.browser_download_url, size: asset.size, name: asset.name };
      state.status = state.file ? 'ready' : 'available';
      log.i(`update available ${version} (running ${app.getVersion()})`);
    } else {
      state.latest = null;
      state.status = 'current';
    }
  } catch (e) {
    state.status = 'error';
    state.error = e instanceof http.HttpError && e.status === 404 ? 'No releases have been published yet.' : `Couldn't check for updates: ${e.message}`;
    log.i(`update check failed: ${e.message}`);
  }
  emit();
  return { ...state };
}

async function download() {
  const l = state.latest;
  if (!l || state.status === 'downloading') return { ...state };
  state.status = 'downloading';
  state.progress = 0;
  state.error = null;
  emit();
  const file = path.join(os.tmpdir(), l.name);
  try {
    const input = await http.stream(l.url, { connectMs: 30000, idleMs: 60000 });
    const outFile = fs.createWriteStream(file);
    let got = 0;
    let lastEmit = 0;
    await new Promise((resolve, reject) => {
      input.on('data', (c) => {
        got += c.length;
        if (!outFile.write(c)) {
          input.pause();
          outFile.once('drain', () => input.resume());
        }
        if (Date.now() - lastEmit > 250) {
          lastEmit = Date.now();
          state.progress = l.size ? got / l.size : 0;
          emit();
        }
      });
      input.on('end', () => outFile.end(resolve));
      input.on('error', reject);
      outFile.on('error', reject);
    });
    if (l.size && fs.statSync(file).size !== l.size) throw new Error('the download was incomplete');
    state.file = file;
    state.progress = 1;
    state.status = 'ready';
    log.i(`update downloaded ${file}`);
  } catch (e) {
    state.status = 'error';
    state.error = `The download failed: ${e.message}`;
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
  }
  emit();
  return { ...state };
}

/** Starts the installer in the background and quits; the installer reopens WiseTV when done. */
function install(quit) {
  if (!state.file || !fs.existsSync(state.file)) throw new Error('The update has not been downloaded');
  state.status = 'installing';
  emit();
  log.i('update installing');
  const child = spawn(state.file, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
  // Quit only once the installer is really running; otherwise report the problem and stay open.
  child.once('spawn', () => {
    child.unref();
    setTimeout(quit, 300);
  });
  child.once('error', (e) => {
    log.i(`update installer failed to start: ${e.message}`);
    state.status = 'error';
    state.error = `The installer couldn't start: ${e.message}`;
    emit();
  });
}

let timer = null;
function start() {
  if (!app.isPackaged && !process.env.WISETV_UPDATE_URL) return;
  setTimeout(() => check(), 8000);
  clearInterval(timer);
  timer = setInterval(() => check(), 6 * 3600000);
}

module.exports = { state, check, download, install, start, newer };
