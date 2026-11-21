'use strict';
// Serialises playlist / guide updates and publishes a status line for the UI.
const db = require('./db');
const bus = require('./bus');
const settings = require('./settings');
const log = require('./log');
const playlists = require('./playlists');
const epg = require('./epg');

let chain = Promise.resolve();
const state = { status: null, error: null };
let errTimer = null;

function setStatus(s) {
  state.status = s;
  bus.emit('sync', { ...state });
}

function report(msg) {
  state.error = msg;
  bus.emit('sync', { ...state });
  clearTimeout(errTimer);
  errTimer = setTimeout(() => {
    if (state.error === msg) {
      state.error = null;
      bus.emit('sync', { ...state });
    }
  }, 12000);
}

/** Runs jobs one at a time. */
function locked(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

let rules = null; // set by recordings module (avoids a require cycle)
const applyRules = () => { try { if (rules) rules.apply(); } catch (e) { log.i('rules failed ' + e.message); } };

async function importEpg(id, progress) {
  const pl = db.get('SELECT * FROM playlists WHERE id = ?', id);
  if (!pl) return;
  setStatus('Loading TV guide…');
  await epg.importEpg(pl, (s) => { setStatus(s); progress(s); });
}

/** Used right after adding a playlist; errors are thrown to the caller. */
function syncPlaylist(id, withEpg, progress = () => {}) {
  return locked(async () => {
    try {
      await playlists.sync(id, (s) => { setStatus(s); progress(s); });
      log.i(`sync done playlist=${id}`);
      if (withEpg) await importEpg(id, progress);
      applyRules();
    } finally {
      setStatus(null);
    }
  });
}

function launchEpg(id) {
  return locked(async () => {
    try {
      await importEpg(id, () => {});
      applyRules();
    } catch (e) {
      report(`Couldn't load the TV guide: ${e.message}`);
    } finally {
      setStatus(null);
    }
  });
}

async function refreshAll(force) {
  const now = Date.now();
  const interval = settings.refreshHours * 3600000;
  for (const pl of db.all('SELECT * FROM playlists ORDER BY id')) {
    const stale = now - pl.lastSync > interval || now - pl.lastEpgSync > interval;
    if (!force && !stale) continue;
    await locked(async () => {
      try {
        await playlists.sync(pl.id, setStatus);
        await importEpg(pl.id, () => {});
      } catch (e) {
        report(`Couldn't update ${pl.name}: ${e.message}`);
      } finally {
        setStatus(null);
      }
    });
  }
  applyRules();
}

let timer = null;
function startAuto() {
  clearInterval(timer);
  // Checks every 15 minutes whether anything is due (the PC may have been asleep).
  timer = setInterval(() => refreshAll(false).catch(() => {}), 15 * 60000);
}

module.exports = {
  state, syncPlaylist, launchEpg, refreshAll, startAuto,
  setRules(r) { rules = r; },
};
