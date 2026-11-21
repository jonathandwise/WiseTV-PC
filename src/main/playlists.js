'use strict';
// Adding, syncing and deleting playlists (Xtream logins and M3U links).
const db = require('./db');
const http = require('./http');
const settings = require('./settings');
const log = require('./log');
const m3u = require('./m3u');
const { XtreamApi, credsFromM3uUrl } = require('./xtream');

const xtream = (pl) => new XtreamApi(pl.url, pl.username, pl.password, pl.userAgent);

function hostOf(url) {
  try { return new URL(url).host || url; } catch (_) { return url; }
}

let addedWhileInUse = null;

async function addXtream({ name = '', server, username, password, epgUrl = '', userAgent = '' }) {
  const api = new XtreamApi(server, username.trim(), password.trim(), userAgent);
  const auth = await api.authenticate();
  addedWhileInUse = auth.inUse ? auth.maxConnections : null;
  const id = db.insert('playlists', {
    name: name.trim() || hostOf(api.base),
    type: 'xtream',
    url: api.base,
    username: username.trim(),
    password: password.trim(),
    epgUrl: epgUrl.trim(),
    userAgent: userAgent.trim(),
    maxConnections: auth.maxConnections,
    expiresAt: auth.expiresAt,
    status: auth.status,
  });
  if (settings.activePlaylistId <= 0) settings.activePlaylistId = id;
  db.changed('playlists');
  return id;
}

/** Adds an M3U link. Xtream "get.php" links are upgraded to full Xtream logins (adds movies and series). */
async function addM3u({ name = '', url, epgUrl = '', userAgent = '', maxConnections = 1 }) {
  const trimmed = url.trim();
  const c = credsFromM3uUrl(trimmed);
  if (c) {
    try {
      return await addXtream({ name, server: c.server, username: c.username, password: c.password, epgUrl, userAgent });
    } catch (_) {
      // Not a working Xtream panel; treat it as a plain M3U link.
    }
  }
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('The playlist link must start with http:// or https://');
  addedWhileInUse = null;
  const id = db.insert('playlists', {
    name: name.trim() || hostOf(trimmed),
    type: 'm3u',
    url: trimmed,
    epgUrl: epgUrl.trim(),
    userAgent: userAgent.trim(),
    maxConnections,
  });
  if (settings.activePlaylistId <= 0) settings.activePlaylistId = id;
  db.changed('playlists');
  return id;
}

/** Builds the channel list while keeping ids, favourites and hidden flags from the previous sync. */
class ChannelListBuilder {
  constructor(existing) {
    this.old = new Map(existing.map((c) => [c.streamKey, c]));
    this.usedIds = new Set();
    this.list = [];
    this.groups = new Set();
  }

  add(c) {
    const prev = this.old.get(c.streamKey);
    const keepId = prev && !this.usedIds.has(prev.id);
    if (keepId) this.usedIds.add(prev.id);
    this.list.push({
      ...c,
      id: keepId ? prev.id : 0,
      favorite: prev ? prev.favorite : 0,
      favOrder: prev ? prev.favOrder : 0,
      hidden: prev ? prev.hidden : 0,
      number: c.number > 0 ? c.number : this.list.length + 1,
    });
    this.groups.add(c.groupName);
  }

  build() {
    return this.list.map((v, index) => ({ v, index }))
      .sort((a, b) => a.v.number - b.v.number || a.index - b.index)
      .map(({ v }, i) => ({ ...v, sortIndex: i }));
  }
}

function replaceChannels(pid, channels, groups) {
  db.tx(() => {
    const hidden = new Set(db.all("SELECT categoryId FROM channel_groups WHERE playlistId = ? AND kind = 'live' AND hidden = 1", pid).map((r) => r.categoryId));
    db.run("DELETE FROM channel_groups WHERE playlistId = ? AND kind = 'live'", pid);
    db.insertMany('channel_groups', groups.map((g, i) => ({ playlistId: pid, kind: 'live', categoryId: g, name: g, hidden: hidden.has(g) ? 1 : 0, sortIndex: i })), 'INSERT OR REPLACE');
    db.run('DELETE FROM channels WHERE playlistId = ?', pid);
    const withId = channels.filter((c) => c.id);
    const without = channels.filter((c) => !c.id).map(({ id, ...rest }) => rest);
    const cols = (c) => ({
      playlistId: c.playlistId, streamKey: c.streamKey, name: c.name, number: c.number, logo: c.logo ?? null,
      groupName: c.groupName, epgId: c.epgId || '', url: c.url, userAgent: c.userAgent ?? null, favorite: c.favorite ? 1 : 0,
      favOrder: c.favOrder || 0, hidden: c.hidden ? 1 : 0, sortIndex: c.sortIndex,
    });
    if (withId.length) db.insertMany('channels', withId.map((c) => ({ id: c.id, ...cols(c) })), 'INSERT OR REPLACE');
    if (without.length) db.insertMany('channels', without.map(cols));
  });
}

function replaceGroups(pid, kind, cats) {
  db.tx(() => {
    const hidden = new Set(db.all('SELECT categoryId FROM channel_groups WHERE playlistId = ? AND kind = ? AND hidden = 1', pid, kind).map((r) => r.categoryId));
    db.run('DELETE FROM channel_groups WHERE playlistId = ? AND kind = ?', pid, kind);
    const seen = new Set();
    const rows = [];
    for (const c of cats) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      rows.push({ playlistId: pid, kind, categoryId: c.id, name: c.name, hidden: hidden.has(c.id) ? 1 : 0, sortIndex: rows.length });
    }
    db.insertMany('channel_groups', rows, 'INSERT OR REPLACE');
  });
}

function categoriesWithFallback(cats, used) {
  const known = new Set(cats.map((c) => c.id));
  const extra = [...used].filter((u) => !known.has(u)).map((u) => ({ id: u, name: u === '0' ? 'Uncategorized' : 'Other' }));
  return cats.filter((c) => used.has(c.id)).concat(extra);
}

const yieldNow = () => new Promise((r) => setImmediate(r));

async function syncXtream(pl, progress) {
  const api = xtream(pl);
  progress(`Signing in to ${pl.name}…`);
  const auth = await api.authenticate();
  db.run('UPDATE playlists SET maxConnections = ?, expiresAt = ?, status = ? WHERE id = ?', auth.maxConnections, auth.expiresAt, auth.status, pl.id);

  progress('Loading channels…');
  const liveCats = await api.categories('get_live_categories');
  const catNames = new Map(liveCats.map((c) => [c.id, c.name]));
  const builder = new ChannelListBuilder(db.all('SELECT * FROM channels WHERE playlistId = ?', pl.id));
  const ext = settings.liveFormat;
  await api.eachItem('get_live_streams', (m) => {
    if (m.stream_id === undefined || m.stream_id === null) return;
    const sid = String(m.stream_id);
    builder.add({
      playlistId: pl.id,
      streamKey: sid,
      name: String(m.name || `Channel ${sid}`).trim(),
      number: Math.trunc(parseFloat(m.num)) || 0,
      logo: m.stream_icon && String(m.stream_icon).trim() ? String(m.stream_icon).trim() : null,
      groupName: catNames.get(String(m.category_id)) || 'Uncategorized',
      epgId: m.epg_channel_id ? String(m.epg_channel_id).trim().toLowerCase() : '',
      url: api.liveUrl(sid, ext),
      userAgent: pl.userAgent || null,
    });
  });
  const groupOrder = [...new Set(liveCats.map((c) => c.name).concat([...builder.groups]))].filter((g) => builder.groups.has(g));
  replaceChannels(pl.id, builder.build(), groupOrder);
  db.changed('channels', 'channel_groups');
  await yieldNow();

  const gen = Date.now();
  let vodOk = false;
  try {
    progress('Loading movies…');
    const vodCats = await api.categories('get_vod_categories');
    let batch = [];
    const used = new Set();
    await api.eachItem('get_vod_streams', (m) => {
      if (m.stream_id === undefined || m.stream_id === null) return;
      const sid = String(m.stream_id);
      const cat = m.category_id !== undefined && m.category_id !== null && String(m.category_id).trim() ? String(m.category_id) : '0';
      used.add(cat);
      const rating = m.rating !== undefined && m.rating !== null ? String(m.rating) : '';
      batch.push({
        playlistId: pl.id, gen, streamId: sid, name: String(m.name || `Movie ${sid}`).trim(),
        poster: m.stream_icon && String(m.stream_icon).trim() ? String(m.stream_icon).trim() : null,
        rating: rating && rating !== '0' ? rating : null, categoryId: cat,
        ext: m.container_extension && String(m.container_extension).trim() ? String(m.container_extension).trim() : 'mp4',
        added: (parseInt(m.added, 10) || 0) * 1000, directUrl: null, year: m.year ? String(m.year) : null,
      });
      if (batch.length >= 2000) { db.insertMany('vod', batch); batch = []; }
    });
    db.insertMany('vod', batch);
    replaceGroups(pl.id, 'movie', categoriesWithFallback(vodCats, used));
    await yieldNow();

    progress('Loading series…');
    const seriesCats = await api.categories('get_series_categories');
    let sBatch = [];
    const sUsed = new Set();
    await api.eachItem('get_series', (m) => {
      if (m.series_id === undefined || m.series_id === null) return;
      const sid = String(m.series_id);
      const cat = m.category_id !== undefined && m.category_id !== null && String(m.category_id).trim() ? String(m.category_id) : '0';
      sUsed.add(cat);
      const rating = m.rating !== undefined && m.rating !== null ? String(m.rating) : '';
      sBatch.push({
        playlistId: pl.id, gen, seriesId: sid, name: String(m.name || `Series ${sid}`).trim(),
        cover: m.cover && String(m.cover).trim() ? String(m.cover).trim() : null,
        plot: m.plot ? String(m.plot).substring(0, 600) : null,
        rating: rating && rating !== '0' ? rating : null, genre: m.genre ? String(m.genre) : null, categoryId: cat,
        lastModified: (parseInt(m.last_modified, 10) || 0) * 1000,
        year: m.year ? String(m.year) : m.releaseDate ? String(m.releaseDate).substring(0, 4) : null,
      });
      if (sBatch.length >= 2000) { db.insertMany('series', sBatch); sBatch = []; }
    });
    db.insertMany('series', sBatch);
    replaceGroups(pl.id, 'series', categoriesWithFallback(seriesCats, sUsed));
    vodOk = true;
  } catch (e) {
    log.i(`vod sync failed: ${e.message}`);
    db.run('DELETE FROM vod WHERE playlistId = ? AND gen = ?', pl.id, gen);
    db.run('DELETE FROM series WHERE playlistId = ? AND gen = ?', pl.id, gen);
  }
  if (vodOk) {
    db.run('UPDATE playlists SET vodGen = ? WHERE id = ?', gen, pl.id);
    db.run('DELETE FROM vod WHERE playlistId = ? AND gen <> ?', pl.id, gen);
    db.run('DELETE FROM series WHERE playlistId = ? AND gen <> ?', pl.id, gen);
  }
  db.changed('vod', 'series', 'channel_groups', 'playlists');
}

async function syncM3u(pl, progress) {
  progress(`Downloading ${pl.name}…`);
  const builder = new ChannelListBuilder(db.all('SELECT * FROM channels WHERE playlistId = ?', pl.id));
  const gen = Date.now();
  let vodBatch = [];
  const vodGroups = new Set();
  let vodCount = 0;
  let headerEpg = '';
  let input;
  try {
    input = await http.stream(pl.url, { userAgent: pl.userAgent, connectMs: 30000, idleMs: 60000 });
  } catch (e) {
    if (e instanceof http.HttpError) throw new Error(`Playlist download failed (HTTP ${e.status})`);
    throw e;
  }
  await m3u.parse(input, (urls) => { headerEpg = urls.join('\n'); }, (e) => {
    if (m3u.classify(e.url) === 'live') {
      builder.add({
        playlistId: pl.id, streamKey: e.url, name: e.name, number: e.number || 0, logo: e.logo, groupName: e.group,
        epgId: e.tvgId.trim().toLowerCase(), url: e.url, userAgent: e.userAgent || pl.userAgent || null,
      });
    } else {
      vodGroups.add(e.group);
      vodBatch.push({
        playlistId: pl.id, gen, streamId: e.url, name: e.name, poster: e.logo, rating: null, categoryId: e.group,
        ext: m3u.extensionOf(e.url), added: 0, directUrl: e.url, year: null,
      });
      vodCount++;
      if (vodBatch.length >= 2000) { db.insertMany('vod', vodBatch); vodBatch = []; }
    }
  });
  db.insertMany('vod', vodBatch);
  if (builder.list.length === 0 && vodCount === 0) {
    db.run('DELETE FROM vod WHERE playlistId = ? AND gen = ?', pl.id, gen);
    throw new Error('No channels were found in this playlist.');
  }
  db.run('UPDATE playlists SET m3uEpgUrl = ? WHERE id = ?', headerEpg, pl.id);
  replaceChannels(pl.id, builder.build(), [...builder.groups]);
  replaceGroups(pl.id, 'movie', [...vodGroups].map((g) => ({ id: g, name: g })));
  db.run('UPDATE playlists SET vodGen = ? WHERE id = ?', gen, pl.id);
  db.run('DELETE FROM vod WHERE playlistId = ? AND gen <> ?', pl.id, gen);
  db.run('DELETE FROM series WHERE playlistId = ?', pl.id);
  db.changed('channels', 'channel_groups', 'vod', 'series', 'playlists');
}

async function sync(id, progress) {
  const pl = db.get('SELECT * FROM playlists WHERE id = ?', id);
  if (!pl) return;
  if (pl.type === 'xtream') await syncXtream(pl, progress);
  else await syncM3u(pl, progress);
  db.run('UPDATE playlists SET lastSync = ? WHERE id = ?', Date.now(), id);
  db.changed('playlists');
}

function deletePlaylist(id) {
  db.tx(() => {
    for (const t of ['channels', 'channel_groups', 'programs', 'vod', 'series', 'favorites', 'rules']) db.run(`DELETE FROM ${t} WHERE playlistId = ?`, id);
    db.run("DELETE FROM progress WHERE playlistId = ? AND kind <> 'recording'", id);
    db.run('DELETE FROM playlists WHERE id = ?', id);
  });
  if (settings.activePlaylistId === id) {
    const first = db.get('SELECT id FROM playlists ORDER BY id LIMIT 1');
    settings.activePlaylistId = first ? first.id : 0;
  }
  db.changed('playlists', 'channels', 'channel_groups', 'programs', 'vod', 'series', 'favorites', 'rules', 'progress');
}

module.exports = {
  xtream, addXtream, addM3u, sync, deletePlaylist, hostOf,
  get addedWhileInUse() { return addedWhileInUse; },
};
