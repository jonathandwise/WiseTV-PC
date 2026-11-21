'use strict';
// Recording scheduler, series rules and the user-facing recording actions.
const fs = require('fs');
const db = require('./db');
const bus = require('./bus');
const settings = require('./settings');
const connections = require('./connections');
const storage = require('./storage');
const log = require('./log');
const Recorder = require('./recorder');

const active = new Map(); // recording id -> Recorder
const timers = new Map(); // recording id -> timeout
let blocker = null; // keeps the PC awake while recording
let powerSaveBlocker = null;
let notify = () => {};

function init(deps) {
  powerSaveBlocker = deps.powerSaveBlocker;
  notify = deps.notify || notify;
}

function updatePower() {
  if (!powerSaveBlocker) return;
  const soon = db.get("SELECT COUNT(*) AS n FROM recordings WHERE status = 'scheduled' AND start < ?", Date.now() + 2 * 60000).n;
  const want = active.size > 0 || soon > 0;
  if (want && blocker == null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && blocker != null) {
    powerSaveBlocker.stop(blocker);
    blocker = null;
  }
}

function episodeKey(p) {
  if (!p) return '';
  const sub = (p.subtitle || '').trim().toLowerCase();
  const ep = (p.episode || '').trim().toLowerCase();
  return sub || ep || '';
}

// ------------------------------------------------------------------ scheduler

function startNow(id) {
  if (active.has(id)) return;
  const r = new Recorder(id, (rec) => {
    if (rec.ruleId) enforceKeepLast(rec.ruleId);
    const done = db.get('SELECT * FROM recordings WHERE id = ?', id);
    if (done) notify(done.status === 'completed' ? `Recorded “${done.title}”` : `Recording failed: “${done.title}”`, done.status === 'completed' ? (done.note || '') : (done.error || ''));
  });
  active.set(id, r);
  bus.emit('recorders');
  updatePower();
  r.run().catch((e) => {
    log.i(`rec crash id=${id} ${e.stack || e}`);
    db.run('UPDATE recordings SET status = ?, error = ? WHERE id = ?', 'failed', e.message || 'Recording failed', id);
    db.changed('recordings');
  }).finally(() => {
    active.delete(id);
    bus.emit('recorders');
    updatePower();
  });
}

function schedule(rec) {
  if (rec.status !== 'scheduled') return;
  cancelTimer(rec.id);
  const now = Date.now();
  if (rec.start <= now) {
    if (rec.stop > now) startNow(rec.id);
    return;
  }
  // Timers longer than ~24 days overflow; the minute check below catches those.
  const wait = rec.start - now;
  if (wait < 2 ** 31 - 1) timers.set(rec.id, setTimeout(() => { timers.delete(rec.id); startNow(rec.id); }, wait));
  updatePower();
}

function cancelTimer(id) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

/** Every minute: start anything due (timers can drift while the PC sleeps), tidy missed ones. */
function tick() {
  const now = Date.now();
  for (const r of db.all("SELECT * FROM recordings WHERE status = 'scheduled' AND start <= ?", now)) {
    if (r.stop > now) startNow(r.id);
    else {
      db.run('UPDATE recordings SET status = ?, error = ? WHERE id = ?', 'failed', 'Missed: the PC was asleep or off', r.id);
      db.changed('recordings');
    }
  }
  updatePower();
}

/** At startup: re-arm timers and tidy recordings interrupted by closing the app. */
function rescheduleAll() {
  const now = Date.now();
  db.run("DELETE FROM recordings WHERE status = 'cancelled' AND stop < ?", now - 14 * 86400000);
  for (const rec of db.all("SELECT * FROM recordings WHERE status = 'recording'")) {
    if (rec.stop > now) startNow(rec.id);
    else {
      const size = rec.filePath && fs.existsSync(rec.filePath) ? fs.statSync(rec.filePath).size : 0;
      if (size > 0) db.run('UPDATE recordings SET status = ?, bytes = ?, note = ? WHERE id = ?', 'completed', size, 'Interrupted (WiseTV was closed)', rec.id);
      else db.run('UPDATE recordings SET status = ?, error = ? WHERE id = ?', 'failed', 'Interrupted before any video was saved', rec.id);
    }
  }
  for (const rec of db.all("SELECT * FROM recordings WHERE status = 'scheduled'")) {
    if (rec.stop <= now) db.run('UPDATE recordings SET status = ?, error = ? WHERE id = ?', 'failed', 'Missed: the PC was off or WiseTV wasn\'t running', rec.id);
    else schedule(rec);
  }
  db.changed('recordings');
  setInterval(tick, 60000);
}

// ------------------------------------------------------------------ rules

const rules = {
  /** Turns series-recording rules into scheduled recordings for every matching airing in the guide. */
  apply() {
    const out = [];
    const now = Date.now();
    db.tx(() => {
      for (const rule of db.all('SELECT * FROM rules WHERE enabled = 1')) {
        const pl = db.get('SELECT * FROM playlists WHERE id = ?', rule.playlistId);
        if (!pl) continue;
        const programs = rule.epgKey != null
          ? db.all('SELECT * FROM programs WHERE playlistId = ? AND gen = ? AND epgKey = ? AND title = ? COLLATE NOCASE AND stop > ? ORDER BY start LIMIT 300', pl.id, pl.epgGen, rule.epgKey, rule.title, now)
          : db.all('SELECT * FROM programs WHERE playlistId = ? AND gen = ? AND title = ? COLLATE NOCASE AND stop > ? ORDER BY start LIMIT 300', pl.id, pl.epgGen, rule.title, now);
        const seen = new Set();
        for (const p of programs) {
          // Only airings that haven't started: a rule never grabs the connection out of the blue.
          if (p.start <= now) continue;
          if (db.get('SELECT id FROM recordings WHERE playlistId = ? AND epgKey = ? AND programStart = ? LIMIT 1', pl.id, p.epgKey, p.start)) continue;
          const ek = episodeKey(p);
          if (rule.skipRepeats && ek) {
            if (seen.has(ek)) continue;
            seen.add(ek);
            if (db.get("SELECT COUNT(*) AS n FROM recordings WHERE ruleId = ? AND episodeKey = ? AND status IN ('scheduled','recording','completed')", rule.id, ek).n > 0) continue;
          }
          const ch = db.get('SELECT * FROM channels WHERE playlistId = ? AND epgId = ? ORDER BY hidden, sortIndex LIMIT 1', pl.id, p.epgKey);
          if (!ch) continue;
          const rec = {
            playlistId: rule.playlistId, channelName: ch.name, channelLogo: ch.logo, streamUrl: ch.url, userAgent: ch.userAgent,
            epgKey: p.epgKey, title: p.title, subtitle: [p.episode, p.subtitle].filter(Boolean).join(' · ') || null,
            description: p.description, episodeKey: ek, programStart: p.start, programStop: p.stop,
            start: p.start - rule.padBefore * 60000, stop: p.stop + rule.padAfter * 60000, status: 'scheduled',
            bytes: 0, ruleId: rule.id, createdAt: now,
          };
          rec.id = db.insert('recordings', rec);
          out.push(rec);
        }
      }
    });
    out.forEach(schedule);
    if (out.length) db.changed('recordings');
    return out.length;
  },
};

// ------------------------------------------------------------------ actions

function hasConflict(rec) {
  const others = db.all("SELECT * FROM recordings WHERE playlistId = ? AND status IN ('scheduled','recording') AND id <> ?", rec.playlistId, rec.id);
  const overlapping = others.filter((o) => o.programStart < rec.programStop && rec.programStart < o.programStop).length;
  return overlapping + 1 > connections.maxFor(rec.playlistId);
}

/** Records `p`, or the next `minutes` of the channel when it has no guide entry. */
function record(ch, p, minutes = 60) {
  const now = Date.now();
  if (p && p.stop <= now) return 'That programme has already finished';
  if (storage.freeBytes() < storage.MIN_FREE_BYTES) return 'Not enough free space to record';
  if (p) {
    const existing = db.get('SELECT * FROM recordings WHERE playlistId = ? AND epgKey = ? AND programStart = ? LIMIT 1', ch.playlistId, p.epgKey, p.start);
    if (existing) {
      if (existing.status === 'scheduled' || existing.status === 'recording') return 'Already set to record';
      if (existing.status === 'cancelled') db.run('DELETE FROM recordings WHERE id = ?', existing.id);
    }
  }
  const ps = p ? p.start : now;
  const pe = p ? p.stop : now + minutes * 60000;
  const rec = {
    playlistId: ch.playlistId, channelName: ch.name, channelLogo: ch.logo, streamUrl: ch.url, userAgent: ch.userAgent,
    epgKey: p ? p.epgKey : ch.epgId, title: p ? p.title : ch.name,
    subtitle: p ? [p.episode, p.subtitle].filter(Boolean).join(' · ') || null : null,
    description: p ? p.description : null, episodeKey: episodeKey(p), programStart: ps, programStop: pe,
    start: ps <= now ? now : ps - settings.padBefore * 60000, stop: pe + (p ? settings.padAfter * 60000 : 0),
    status: 'scheduled', bytes: 0, ruleId: null, createdAt: now,
  };
  rec.id = db.insert('recordings', rec);
  db.changed('recordings');
  schedule(rec);
  if (hasConflict(rec)) return `Set to record, but it overlaps another recording and your provider allows ${connections.maxFor(ch.playlistId)} connection(s)`;
  return ps <= now ? 'Recording started' : 'Recording scheduled';
}

/** Stops an in-progress recording; what was recorded so far is kept. */
function stop(id) {
  const r = active.get(id);
  if (r) {
    r.requestStop('Stopped early by you');
    return;
  }
  const rec = db.get('SELECT * FROM recordings WHERE id = ?', id);
  if (!rec) return;
  const size = rec.filePath && fs.existsSync(rec.filePath) ? fs.statSync(rec.filePath).size : 0;
  if (size > 0) db.run('UPDATE recordings SET status = ?, bytes = ? WHERE id = ?', 'completed', size, id);
  else db.run('UPDATE recordings SET status = ?, error = ? WHERE id = ?', 'failed', 'Stopped before any video was saved', id);
  db.changed('recordings');
}

function cancel(id) {
  const r = db.get('SELECT * FROM recordings WHERE id = ?', id);
  if (!r) return;
  if (r.status === 'scheduled') {
    cancelTimer(id);
    db.run('UPDATE recordings SET status = ?, error = NULL WHERE id = ?', 'cancelled', id);
    db.changed('recordings');
  } else if (r.status === 'recording') {
    stop(id);
  }
}

async function remove(id) {
  const r = db.get('SELECT * FROM recordings WHERE id = ?', id);
  if (!r) return;
  if (r.status === 'recording') {
    stop(id);
    await connections.awaitRecordingReleased(id, 5000);
  }
  cancelTimer(id);
  if (r.filePath) {
    try { fs.unlinkSync(r.filePath); } catch (_) { /* ignore */ }
  }
  db.run('DELETE FROM recordings WHERE id = ?', id);
  db.run('DELETE FROM progress WHERE key = ?', `rec:${id}`);
  db.changed('recordings', 'progress');
}

function addSeriesRule(ch, p) {
  if (db.get('SELECT id FROM rules WHERE playlistId = ? AND title = ? COLLATE NOCASE AND epgKey IS ? LIMIT 1', ch.playlistId, p.title, p.epgKey)) {
    return 'This series is already being recorded';
  }
  db.insert('rules', {
    playlistId: ch.playlistId, title: p.title, epgKey: p.epgKey, channelName: ch.name, skipRepeats: 1, keepLast: 5,
    padBefore: settings.padBefore, padAfter: settings.padAfter, enabled: 1, createdAt: Date.now(),
  });
  db.changed('rules');
  rules.apply();
  const upcoming = db.all("SELECT title FROM recordings WHERE playlistId = ? AND status IN ('scheduled','recording')", ch.playlistId)
    .filter((r) => r.title.toLowerCase() === p.title.toLowerCase()).length;
  return `Series recording set: ${upcoming} airing${upcoming === 1 ? '' : 's'} scheduled. Keeps the newest 5 (change it under Recordings → Series rules).`;
}

function updateRule(rule) {
  db.update('rules', {
    id: rule.id, keepLast: rule.keepLast, skipRepeats: rule.skipRepeats ? 1 : 0, padBefore: rule.padBefore, padAfter: rule.padAfter,
  });
  db.changed('rules');
  rules.apply();
}

function deleteRule(ruleId) {
  for (const r of db.all("SELECT id FROM recordings WHERE ruleId = ? AND status = 'scheduled'", ruleId)) {
    cancelTimer(r.id);
    db.run('DELETE FROM recordings WHERE id = ?', r.id);
  }
  db.run('DELETE FROM rules WHERE id = ?', ruleId);
  db.changed('rules', 'recordings');
}

function enforceKeepLast(ruleId) {
  const rule = db.get('SELECT * FROM rules WHERE id = ?', ruleId);
  if (!rule || rule.keepLast <= 0) return;
  const done = db.all("SELECT id FROM recordings WHERE ruleId = ? AND status = 'completed' ORDER BY programStart DESC", ruleId);
  done.slice(rule.keepLast).forEach((r) => remove(r.id));
}

/** Ids of upcoming recordings that overlap more recordings than the connection limit allows. */
function conflicts(all) {
  const act = all.filter((r) => r.status === 'scheduled' || r.status === 'recording');
  const out = [];
  for (const a of act) {
    const overlapping = act.filter((b) => b.id !== a.id && b.playlistId === a.playlistId && b.programStart < a.programStop && a.programStart < b.programStop).length;
    if (overlapping + 1 > connections.maxFor(a.playlistId)) out.push(a.id);
  }
  return out;
}

/** Asks running recorders to stop cleanly (app quitting). */
function stopAll(reason) {
  for (const r of active.values()) r.requestStop(reason);
}

module.exports = {
  init, rules, schedule, startNow, rescheduleAll, record, stop, cancel, remove, addSeriesRule, updateRule, deleteRule,
  conflicts, stopAll, episodeKey, get activeCount() { return active.size; },
};
