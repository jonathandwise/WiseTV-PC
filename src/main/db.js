'use strict';
// SQLite storage (Node's built-in node:sqlite). Same tables as the Fire TV app's Room database.
const { DatabaseSync } = require('node:sqlite');
const bus = require('./bus');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, url TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '', password TEXT NOT NULL DEFAULT '', epgUrl TEXT NOT NULL DEFAULT '',
  m3uEpgUrl TEXT NOT NULL DEFAULT '', userAgent TEXT NOT NULL DEFAULT '', maxConnections INTEGER NOT NULL DEFAULT 1,
  expiresAt INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT '', lastSync INTEGER NOT NULL DEFAULT 0,
  lastEpgSync INTEGER NOT NULL DEFAULT 0, epgGen INTEGER NOT NULL DEFAULT 0, vodGen INTEGER NOT NULL DEFAULT 0,
  epgShiftMinutes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT, playlistId INTEGER NOT NULL, streamKey TEXT NOT NULL, name TEXT NOT NULL,
  number INTEGER NOT NULL, logo TEXT, groupName TEXT NOT NULL, epgId TEXT NOT NULL DEFAULT '', url TEXT NOT NULL,
  userAgent TEXT, favorite INTEGER NOT NULL DEFAULT 0, favOrder INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
  sortIndex INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ch_pl ON channels(playlistId, sortIndex);
CREATE INDEX IF NOT EXISTS ch_grp ON channels(playlistId, groupName);
CREATE INDEX IF NOT EXISTS ch_epg ON channels(playlistId, epgId);
CREATE TABLE IF NOT EXISTS channel_groups (
  playlistId INTEGER NOT NULL, kind TEXT NOT NULL, categoryId TEXT NOT NULL, name TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0, sortIndex INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (playlistId, kind, categoryId));
CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, playlistId INTEGER NOT NULL, gen INTEGER NOT NULL, epgKey TEXT NOT NULL,
  start INTEGER NOT NULL, stop INTEGER NOT NULL, title TEXT NOT NULL, subtitle TEXT, description TEXT, category TEXT,
  episode TEXT, icon TEXT, isNew INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS pr_key ON programs(playlistId, gen, epgKey, start);
CREATE TABLE IF NOT EXISTS vod (
  id INTEGER PRIMARY KEY AUTOINCREMENT, playlistId INTEGER NOT NULL, gen INTEGER NOT NULL, streamId TEXT NOT NULL,
  name TEXT NOT NULL, poster TEXT, rating TEXT, categoryId TEXT NOT NULL, ext TEXT NOT NULL DEFAULT 'mp4',
  added INTEGER NOT NULL DEFAULT 0, directUrl TEXT, year TEXT);
CREATE INDEX IF NOT EXISTS vod_cat ON vod(playlistId, gen, categoryId);
CREATE INDEX IF NOT EXISTS vod_sid ON vod(playlistId, streamId);
CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY AUTOINCREMENT, playlistId INTEGER NOT NULL, gen INTEGER NOT NULL, seriesId TEXT NOT NULL,
  name TEXT NOT NULL, cover TEXT, plot TEXT, rating TEXT, genre TEXT, categoryId TEXT NOT NULL,
  lastModified INTEGER NOT NULL DEFAULT 0, year TEXT);
CREATE INDEX IF NOT EXISTS ser_cat ON series(playlistId, gen, categoryId);
CREATE INDEX IF NOT EXISTS ser_sid ON series(playlistId, seriesId);
CREATE TABLE IF NOT EXISTS favorites (key TEXT PRIMARY KEY, playlistId INTEGER NOT NULL, addedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS progress (
  key TEXT PRIMARY KEY, playlistId INTEGER NOT NULL, kind TEXT NOT NULL, refId TEXT NOT NULL, title TEXT NOT NULL,
  poster TEXT, position INTEGER NOT NULL, duration INTEGER NOT NULL, updatedAt INTEGER NOT NULL, seriesKey TEXT,
  season INTEGER, episodeNum INTEGER, finished INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS prog_series ON progress(playlistId, seriesKey);
CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, playlistId INTEGER NOT NULL, channelName TEXT NOT NULL, channelLogo TEXT,
  streamUrl TEXT NOT NULL, userAgent TEXT, epgKey TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT, description TEXT,
  episodeKey TEXT NOT NULL DEFAULT '', programStart INTEGER NOT NULL, programStop INTEGER NOT NULL,
  start INTEGER NOT NULL, stop INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', filePath TEXT,
  bytes INTEGER NOT NULL DEFAULT 0, error TEXT, note TEXT, ruleId INTEGER, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rec_prog ON recordings(playlistId, epgKey, programStart);
CREATE INDEX IF NOT EXISTS rec_status ON recordings(status);
CREATE INDEX IF NOT EXISTS rec_rule ON recordings(ruleId);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, playlistId INTEGER NOT NULL, title TEXT NOT NULL, epgKey TEXT,
  channelName TEXT, skipRepeats INTEGER NOT NULL DEFAULT 1, keepLast INTEGER NOT NULL DEFAULT 5,
  padBefore INTEGER NOT NULL, padAfter INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL);
`;

let db = null;
const stmts = new Map();

function open(file) {
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -32000;');
  db.exec(SCHEMA);
}

function prep(sql) {
  let s = stmts.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmts.set(sql, s);
  }
  return s;
}

const norm = (params) => params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v));
const all = (sql, ...p) => prep(sql).all(...norm(p));
const get = (sql, ...p) => prep(sql).get(...norm(p)) || null;
const run = (sql, ...p) => prep(sql).run(...norm(p));

let txDepth = 0;
function tx(fn) {
  if (txDepth > 0) return fn();
  txDepth++;
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    txDepth--;
  }
}

/** Inserts an object into a table (columns = its keys, minus a zero id). Returns the new id. */
function insert(table, obj, mode = 'INSERT') {
  const o = { ...obj };
  if (!o.id) delete o.id;
  const cols = Object.keys(o);
  const sql = `${mode} INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  return Number(run(sql, ...cols.map((c) => o[c])).lastInsertRowid);
}

/** Inserts many rows of the same shape in one transaction. */
function insertMany(table, rows, mode = 'INSERT') {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]).filter((c) => c !== 'id' || rows[0].id);
  const sql = `${mode} INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const s = prep(sql);
  tx(() => { for (const r of rows) s.run(...norm(cols.map((c) => r[c]))); });
}

function update(table, obj) {
  const cols = Object.keys(obj).filter((c) => c !== 'id');
  run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => obj[c]), obj.id);
}

/** Tells the UI which tables changed so it can reload what it shows. */
function changed(...tables) {
  bus.emit('changed', tables);
}

module.exports = { open, all, get, run, tx, insert, insertMany, update, changed };
