'use strict';
// Everything the window can ask the main process for. Called as api.call('name', ...args).
const db = require('./db');
const settings = require('./settings');
const playlists = require('./playlists');
const sync = require('./sync');
const plex = require('./plex');
const connections = require('./connections');
const recordings = require('./recordings');
const playback = require('./playback');
const storage = require('./storage');
const log = require('./log');
const { XtreamApi, normalizeServer } = require('./xtream');

const visibleChannels = `SELECT * FROM channels WHERE playlistId = ? AND hidden = 0
  AND groupName NOT IN (SELECT categoryId FROM channel_groups WHERE playlistId = ? AND kind = 'live' AND hidden = 1)
  ORDER BY sortIndex`;

const playlist = (id) => db.get('SELECT * FROM playlists WHERE id = ?', id);
const CONTINUE = '__continue';
const FAVORITES = '__fav';
const RECENT = '__recent';
const PLEX_ERROR = 'plexerror:';

function inList(sql, ids, ...before) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(...db.all(sql.replace('(?)', `(${chunk.map(() => '?').join(',')})`), ...before, ...chunk));
  }
  return out;
}

function plexCard(it) {
  const off = plex.offsetOf(it);
  return {
    id: `plex:${it.uid}`,
    title: it.title + (it.year ? ` (${it.year})` : ''),
    image: plex.image(it.serverId, it.thumb, 300, 450),
    rating: it.rating != null ? String(it.rating) : null,
    progress: off > 0 && it.durationMs > 0 ? off / it.durationMs : null,
  };
}

async function loadCards(kind, pid, cat) {
  const pl = playlist(pid);
  const gen = pl ? pl.vodGen : 0;
  if (cat.startsWith(PLEX_ERROR)) return [];
  if (cat.startsWith('plex:')) {
    const parts = cat.substring(5).split(':');
    const libId = `${parts[0]}:${parts[1] || ''}`;
    const lib = (await plex.libraries()).libraries.find((l) => l.id === libId);
    if (!lib) return [];
    return (await plex.items(lib, (parts[2] || 'all') === 'new')).map(plexCard);
  }
  if (cat === CONTINUE && plex.hasServer()) {
    const mine = await loadCards(kind, pid, `${CONTINUE}-local`);
    let deck = [];
    try { deck = await plex.onDeck(); } catch (_) { /* ignore */ }
    const cards = deck.map((item) => {
      if (kind === 'movie' && item.type === 'movie') return plexCard(item);
      if (kind === 'series' && item.type === 'episode' && item.grandparentRatingKey) {
        return { id: `plex:${item.serverId}:${item.grandparentRatingKey}`, title: item.grandparentTitle || item.title, image: plex.image(item.serverId, item.grandparentThumb || item.thumb, 300, 450), rating: null, progress: null };
      }
      return null;
    }).filter(Boolean);
    return dedupe(mine.concat(cards));
  }
  const c = cat === `${CONTINUE}-local` ? CONTINUE : cat;
  let out;
  if (kind === 'movie') {
    const card = (v) => ({ id: v.streamId, title: v.name, image: v.poster, rating: v.rating, progress: null });
    if (c === CONTINUE) {
      out = db.all("SELECT * FROM progress WHERE playlistId = ? AND kind = 'movie' AND finished = 0 AND position > 60000 ORDER BY updatedAt DESC LIMIT 40", pid)
        .map((p) => ({ id: p.refId, title: p.title, image: p.poster, rating: null, progress: p.position / Math.max(1, p.duration) }));
    } else if (c === FAVORITES) {
      const prefix = `movie:${pid}:`;
      const ids = db.all('SELECT key FROM favorites WHERE playlistId = ? ORDER BY addedAt DESC', pid).map((r) => r.key).filter((k) => k.startsWith(prefix)).map((k) => k.substring(prefix.length));
      const rows = new Map(inList('SELECT * FROM vod WHERE playlistId = ? AND gen = ? AND streamId IN (?)', ids, pid, gen).map((r) => [r.streamId, r]));
      out = ids.map((i) => rows.get(i)).filter(Boolean).map(card);
    } else if (c === RECENT) {
      out = db.all('SELECT * FROM vod WHERE playlistId = ? AND gen = ? ORDER BY added DESC, id DESC LIMIT 300', pid, gen).map(card);
    } else {
      out = db.all('SELECT * FROM vod WHERE playlistId = ? AND gen = ? AND categoryId = ? ORDER BY id', pid, gen, cat).map(card);
    }
  } else {
    const card = (s) => ({ id: s.seriesId, title: s.name, image: s.cover, rating: s.rating, progress: null });
    if (c === CONTINUE) {
      const keys = db.all("SELECT seriesKey FROM progress WHERE playlistId = ? AND kind = 'episode' AND seriesKey IS NOT NULL GROUP BY seriesKey ORDER BY MAX(updatedAt) DESC LIMIT 40", pid).map((r) => r.seriesKey);
      const rows = new Map(inList('SELECT * FROM series WHERE playlistId = ? AND gen = ? AND seriesId IN (?)', keys, pid, gen).map((r) => [r.seriesId, r]));
      out = keys.map((k) => rows.get(k)).filter(Boolean).map(card);
    } else if (c === FAVORITES) {
      const prefix = `series:${pid}:`;
      const ids = db.all('SELECT key FROM favorites WHERE playlistId = ? ORDER BY addedAt DESC', pid).map((r) => r.key).filter((k) => k.startsWith(prefix)).map((k) => k.substring(prefix.length));
      const rows = new Map(inList('SELECT * FROM series WHERE playlistId = ? AND gen = ? AND seriesId IN (?)', ids, pid, gen).map((r) => [r.seriesId, r]));
      out = ids.map((i) => rows.get(i)).filter(Boolean).map(card);
    } else if (c === RECENT) {
      out = db.all('SELECT * FROM series WHERE playlistId = ? AND gen = ? ORDER BY lastModified DESC, id DESC LIMIT 300', pid, gen).map(card);
    } else {
      out = db.all('SELECT * FROM series WHERE playlistId = ? AND gen = ? AND categoryId = ? ORDER BY id', pid, gen, cat).map(card);
    }
  }
  return dedupe(out);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => !seen.has(x.id) && seen.add(x.id));
}

async function plexPlayable(it) {
  const pb = await plex.playback(it);
  const episode = it.type === 'episode';
  return {
    key: `plex:${it.uid}`, playlistId: 0, kind: episode ? 'plex-episode' : 'plex-movie', refId: it.ratingKey,
    title: episode ? it.grandparentTitle || it.title : it.title,
    subtitle: episode ? `S${it.parentIndex || 0} E${it.index || 0} · ${it.title}` : it.year,
    url: pb.url, poster: plex.image(it.serverId, it.thumb, 300, 450), userAgent: null, local: true,
    plexKey: it.ratingKey, plexServer: it.serverId, plexSession: pb.session, headers: pb.headers, subtitles: pb.subtitles,
  };
}

function withPlexImages(item, w = 300, h = 450) {
  return { ...item, img: plex.image(item.serverId, item.thumb, w, h), artImg: plex.image(item.serverId, item.art || item.thumb, 1280, 720), offset: plex.offsetOf(item) };
}

const handlers = {
  // ---------------------------------------------------------------- app
  'settings.all': () => settings.all(),
  'settings.set': (k, v) => { settings.set(k, v); return true; },

  // ---------------------------------------------------------------- playlists & sync
  'playlists.list': () => db.all('SELECT * FROM playlists ORDER BY id'),
  'playlists.get': (id) => playlist(id),
  'playlists.addXtream': async (form) => {
    const id = await playlists.addXtream(form);
    return { id, inUseMax: playlists.addedWhileInUse };
  },
  'playlists.addM3u': async (form) => {
    const id = await playlists.addM3u(form);
    return { id, inUseMax: playlists.addedWhileInUse };
  },
  'playlists.save': async (id, f) => {
    const old = playlist(id);
    if (!old) throw new Error('Playlist not found');
    if (old.type === 'xtream') await new XtreamApi(f.server, f.username, f.password, f.userAgent).authenticate();
    db.update('playlists', {
      id,
      name: (f.name || '').trim() || old.name,
      url: old.type === 'xtream' ? normalizeServer(f.server) : f.url.trim(),
      username: (f.username || '').trim(),
      password: (f.password || '').trim(),
      epgUrl: (f.epgUrl || '').trim(),
      userAgent: (f.userAgent || '').trim(),
      epgShiftMinutes: f.epgShiftMinutes || 0,
    });
    db.changed('playlists');
    return true;
  },
  'playlists.delete': (id) => {
    for (const r of db.all("SELECT id FROM recordings WHERE playlistId = ? AND status IN ('scheduled','recording')", id)) recordings.cancel(r.id);
    playlists.deletePlaylist(id);
    return settings.activePlaylistId;
  },
  'presets.list': () => {
    const have = new Set(db.all("SELECT url FROM playlists WHERE type = 'm3u'").map((r) => r.url));
    return require('./presets').map((p) => ({ ...p, added: have.has(p.url) }));
  },
  /** Adds one of the free playlists and loads its channels. Free channels have no connection limit. */
  'playlists.addPreset': async (presetId) => {
    const p = require('./presets').find((x) => x.id === presetId);
    if (!p) throw new Error('Unknown playlist');
    const existing = db.get("SELECT id FROM playlists WHERE type = 'm3u' AND url = ?", p.url);
    if (existing) return { id: existing.id, existed: true };
    const id = await playlists.addM3u({ name: p.name, url: p.url, maxConnections: 10 });
    try {
      await sync.syncPlaylist(id, false);
    } catch (e) {
      playlists.deletePlaylist(id);
      throw new Error(`${p.name} couldn't be loaded: ${e.message}`);
    }
    sync.launchEpg(id);
    return { id };
  },
  'playlists.hasChannels': (id) => !!db.get('SELECT id FROM channels WHERE playlistId = ? LIMIT 1', id),
  'sync.playlist': (id, withEpg) => sync.syncPlaylist(id, withEpg),
  'sync.epg': (id) => { sync.launchEpg(id); return true; },
  'sync.refreshAll': (force) => { sync.refreshAll(force); return true; },
  'sync.state': () => sync.state,

  // ---------------------------------------------------------------- guide
  'guide.groups': (pid) => db.all("SELECT * FROM channel_groups WHERE playlistId = ? AND kind = 'live' AND hidden = 0 ORDER BY sortIndex", pid),
  'guide.channels': (pid, group) => {
    if (group === '__all__') return db.all(visibleChannels, pid, pid);
    if (group === '__fav__') return db.all('SELECT * FROM channels WHERE playlistId = ? AND favorite = 1 ORDER BY favOrder, sortIndex', pid);
    return db.all('SELECT * FROM channels WHERE playlistId = ? AND groupName = ? AND hidden = 0 ORDER BY sortIndex', pid, group);
  },
  'guide.programs': (pid, keys, from, to) => {
    const pl = playlist(pid);
    const out = {};
    if (!pl) return out;
    for (const k of keys) out[k] = db.all('SELECT * FROM programs WHERE playlistId = ? AND gen = ? AND epgKey = ? AND stop > ? AND start < ? ORDER BY start', pid, pl.epgGen, k, from, to);
    return out;
  },
  'guide.recordState': (pid) => {
    const mine = db.all("SELECT epgKey, programStart, streamUrl, status FROM recordings WHERE playlistId = ? AND status IN ('scheduled','recording')", pid);
    return {
      recordKeys: mine.map((r) => `${r.epgKey}@${r.programStart}`),
      recordingNowUrls: mine.filter((r) => r.status === 'recording').map((r) => r.streamUrl),
    };
  },
  'programs.nowOn': (pid, key) => {
    const pl = playlist(pid);
    if (!pl || !key) return null;
    const now = Date.now();
    return db.get('SELECT * FROM programs WHERE playlistId = ? AND gen = ? AND epgKey = ? AND start <= ? AND stop > ? LIMIT 1', pid, pl.epgGen, key, now, now);
  },
  'channels.get': (id) => db.get('SELECT * FROM channels WHERE id = ?', id),
  'channels.toggleFavorite': (id) => {
    const ch = db.get('SELECT * FROM channels WHERE id = ?', id);
    if (!ch) return null;
    const order = (db.get('SELECT COALESCE(MAX(favOrder), 0) AS m FROM channels WHERE playlistId = ?', ch.playlistId).m || 0) + 1;
    db.run('UPDATE channels SET favorite = ?, favOrder = ? WHERE id = ?', ch.favorite ? 0 : 1, order, id);
    db.changed('channels');
    return { favorite: !ch.favorite, name: ch.name };
  },
  'channels.setHidden': (id, hidden) => { db.run('UPDATE channels SET hidden = ? WHERE id = ?', hidden ? 1 : 0, id); db.changed('channels'); return true; },
  'channels.hidden': (pid) => db.all('SELECT * FROM channels WHERE playlistId = ? AND hidden = 1 ORDER BY sortIndex', pid),
  'groups.all': (pid, kind) => db.all('SELECT * FROM channel_groups WHERE playlistId = ? AND kind = ? ORDER BY sortIndex', pid, kind),
  'groups.counts': (pid) => Object.fromEntries(db.all('SELECT groupName AS name, COUNT(*) AS cnt FROM channels WHERE playlistId = ? GROUP BY groupName', pid).map((r) => [r.name, r.cnt])),
  'groups.setHidden': (pid, kind, cat, hidden) => { db.run('UPDATE channel_groups SET hidden = ? WHERE playlistId = ? AND kind = ? AND categoryId = ?', hidden ? 1 : 0, pid, kind, cat); db.changed('channel_groups', 'channels'); return true; },
  'groups.setAllHidden': (pid, kind, hidden) => { db.run('UPDATE channel_groups SET hidden = ? WHERE playlistId = ? AND kind = ?', hidden ? 1 : 0, pid, kind); db.changed('channel_groups', 'channels'); return true; },

  // ---------------------------------------------------------------- movies & series
  'vod.categories': (pid, kind) => db.all('SELECT * FROM channel_groups WHERE playlistId = ? AND kind = ? AND hidden = 0 ORDER BY sortIndex', pid, kind),
  'vod.plexEntries': async (kind) => {
    if (!plex.hasServer()) return [];
    const type = kind === 'movie' ? 'movie' : 'show';
    const r = await plex.libraries();
    const several = plex.servers().length > 1;
    return r.libraries.filter((l) => l.type === type).flatMap((l) => {
      const label = several ? `${l.title} · ${l.serverName}` : `${l.title} · Plex`;
      return [[`plex:${l.id}:new`, `${label} · New`], [`plex:${l.id}:all`, label]];
    }).concat(r.unreachable.map((n) => [`${PLEX_ERROR}${n}`, `${n} · can't connect`]));
  },
  'vod.cards': (kind, pid, cat) => loadCards(kind, pid, cat),
  'vod.movie': (pid, streamId) => ({ vod: db.get('SELECT * FROM vod WHERE playlistId = ? AND streamId = ? ORDER BY gen DESC LIMIT 1', pid, streamId), playlist: playlist(pid) }),
  'vod.movieInfo': async (pid, streamId) => {
    const pl = playlist(pid);
    if (!pl || pl.type !== 'xtream') return null;
    try { return await playlists.xtream(pl).vodInfo(streamId); } catch (_) { return null; }
  },
  'vod.moviePlayable': (pid, streamId, ext) => {
    const pl = playlist(pid);
    const v = db.get('SELECT * FROM vod WHERE playlistId = ? AND streamId = ? ORDER BY gen DESC LIMIT 1', pid, streamId);
    if (!pl || !v) throw new Error('This movie is no longer available');
    return {
      key: `movie:${pid}:${streamId}`, playlistId: pid, kind: 'movie', refId: streamId, title: v.name, subtitle: v.year,
      url: v.directUrl || playlists.xtream(pl).movieUrl(streamId, ext || v.ext), poster: v.poster, userAgent: pl.userAgent || null,
    };
  },
  'vod.series': (pid, seriesId) => ({ series: db.get('SELECT * FROM series WHERE playlistId = ? AND seriesId = ? ORDER BY gen DESC LIMIT 1', pid, seriesId), playlist: playlist(pid) }),
  'vod.seriesInfo': async (pid, seriesId) => {
    const pl = playlist(pid);
    const s = db.get('SELECT * FROM series WHERE playlistId = ? AND seriesId = ? ORDER BY gen DESC LIMIT 1', pid, seriesId);
    if (!pl || !s) throw new Error('This series is no longer available');
    const api = playlists.xtream(pl);
    const info = await api.seriesInfo(seriesId);
    const playables = info.episodes.map((e) => ({
      key: `ep:${pid}:${e.id}`, playlistId: pid, kind: 'episode', refId: e.id, title: s.name,
      subtitle: `S${e.season} E${e.number}` + (e.title ? ` · ${e.title}` : ''), url: api.episodeUrl(e.id, e.ext), poster: s.cover,
      userAgent: pl.userAgent || null, seriesKey: seriesId, season: e.season, episode: e.number,
    }));
    return { info, playables };
  },
  'favorites.keys': (pid) => db.all('SELECT key FROM favorites WHERE playlistId = ? ORDER BY addedAt DESC', pid).map((r) => r.key),
  'favorites.toggle': (key, pid) => {
    if (db.get('SELECT key FROM favorites WHERE key = ?', key)) db.run('DELETE FROM favorites WHERE key = ?', key);
    else db.insert('favorites', { key, playlistId: pid, addedAt: Date.now() }, 'INSERT OR REPLACE');
    db.changed('favorites');
    return !!db.get('SELECT key FROM favorites WHERE key = ?', key);
  },
  'progress.get': (key) => db.get('SELECT * FROM progress WHERE key = ?', key),
  'progress.series': (pid, sid) => db.all('SELECT * FROM progress WHERE playlistId = ? AND seriesKey = ?', pid, sid),

  // ---------------------------------------------------------------- plex
  'plex.status': () => ({ linked: plex.linked(), user: settings.plexUser, servers: plex.servers(), remoteKbps: settings.plexRemoteKbps }),
  'plex.startPin': () => plex.startPin(),
  'plex.pollPin': async (pin) => { try { return await plex.pollPin(pin); } catch (_) { return null; } },
  'plex.finishLink': (token) => plex.finishLink(token),
  'plex.unlink': () => { plex.unlink(); return true; },
  'plex.accountServers': () => plex.accountServers(),
  'plex.setServers': (list) => plex.setServers(list),
  'plex.movie': async (serverId, rk) => {
    const it = await plex.metadata(serverId, rk);
    return { ...withPlexImages(it), convertNote: plex.willConvert(serverId, it.media) ? `Away from home: converted to ${Math.round(settings.plexRemoteKbps / 1000)} Mbps` : null };
  },
  'plex.show': async (serverId, rk) => {
    const [show, eps] = await Promise.all([plex.metadata(serverId, rk), plex.episodes(serverId, rk)]);
    return { show: withPlexImages(show), episodes: eps.map((e) => withPlexImages(e, 320, 180)) };
  },
  'plex.markWatched': (serverId, rk) => plex.markWatched(serverId, rk),
  'plex.serverName': (serverId) => (plex.servers().length > 1 ? (plex.server(serverId) || {}).name || 'Plex' : 'Plex'),

  // ---------------------------------------------------------------- playback
  'player.state': () => playback.state(),
  'player.tune': (ch, force) => playback.playChannel(ch, force),
  'player.setQueue': (items, index) => { playback.setQueue(items, index); return true; },
  'player.playVod': (item, startMs) => playback.playVod(item, startMs),
  'player.playNext': () => playback.playNext(),
  'player.playPlex': async (items, index, resume) => {
    const chosen = items[index];
    let full = chosen;
    try { full = await plex.metadata(chosen.serverId, chosen.ratingKey); } catch (_) { /* use what we have */ }
    const playables = [];
    for (let i = 0; i < items.length; i++) playables.push(await plexPlayable(i === index ? full : items[i]));
    playback.setQueue(playables, index);
    return playback.playVod(playables[index], resume ? plex.offsetOf(full) : 0);
  },
  'player.playRecording': (id, fromStart) => {
    const rec = db.get('SELECT * FROM recordings WHERE id = ?', id);
    const item = rec && playback.recordingPlayable(rec);
    if (!item) return { ok: false };
    const p = fromStart ? null : db.get('SELECT * FROM progress WHERE key = ?', item.key);
    playback.setQueue([item], 0);
    return playback.playVod(item, p && !p.finished ? p.position : 0);
  },
  'player.resumeVod': (item) => {
    const p = db.get('SELECT * FROM progress WHERE key = ?', item.key);
    return playback.playVod(item, p ? p.position : 0);
  },
  'player.stop': () => { playback.stop(); return true; },
  'player.stopVod': () => { const np = playback.nowPlaying; if (np && np.type === 'vod') playback.stop(); return true; },
  'player.park': () => { playback.park(); return true; },
  'player.unpark': () => playback.unpark(),
  'player.togglePause': () => { playback.togglePause(); return true; },
  'player.seekBy': (ms) => { playback.seekBy(ms); return true; },
  'player.seekTo': (ms) => { playback.seekTo(ms); return true; },
  'player.setVolume': (v) => { playback.setVolume(v); return true; },
  'player.toggleMute': () => { playback.toggleMute(); return true; },
  'player.setSpeed': (v) => { playback.setSpeed(v); return true; },
  'player.setResize': (m) => { playback.setResize(m); return true; },
  'player.tracks': (type) => playback.trackOptions(type),
  'player.selectTrack': (type, id) => { playback.selectTrack(type, id); return true; },
  'player.streamInfo': () => playback.streamInfo(),
  /** Watch the channel a recording is capturing (uses the recorder's feed, no extra connection). */
  'player.watchRecordingChannel': (recId) => {
    const rec = db.get('SELECT * FROM recordings WHERE id = ?', recId);
    if (!rec) return { ok: false };
    const ch = db.get('SELECT * FROM channels WHERE playlistId = ? AND url = ? LIMIT 1', rec.playlistId, rec.streamUrl) || {
      id: -rec.id, playlistId: rec.playlistId, streamKey: rec.streamUrl, name: rec.channelName, number: 0, logo: rec.channelLogo,
      groupName: '', epgId: rec.epgKey, url: rec.streamUrl, userAgent: rec.userAgent, favorite: 0, hidden: 0,
    };
    return playback.playChannel(ch).then((r) => ({ ...r, channel: ch }));
  },

  // ---------------------------------------------------------------- recordings
  'rec.list': () => {
    const all = db.all('SELECT * FROM recordings ORDER BY start');
    return { all, conflicts: recordings.conflicts(all) };
  },
  'rec.rules': () => db.all('SELECT * FROM rules ORDER BY title COLLATE NOCASE'),
  'rec.storage': () => {
    const dir = storage.recordingsDir();
    return { dir, free: storage.freeBytes(dir), minFree: storage.MIN_FREE_BYTES, hdPerHour: storage.HD_BYTES_PER_HOUR, isDefault: !settings.recordingRoot };
  },
  'rec.record': (ch, p, minutes) => recordings.record(ch, p, minutes),
  'rec.stop': (id) => { recordings.stop(id); return true; },
  'rec.cancel': (id) => { recordings.cancel(id); return true; },
  'rec.delete': (id) => recordings.remove(id),
  'rec.addSeriesRule': (ch, p) => recordings.addSeriesRule(ch, p),
  'rec.updateRule': (rule) => { recordings.updateRule(rule); return true; },
  'rec.deleteRule': (id) => { recordings.deleteRule(id); return true; },
  'rec.stopAndWait': async (id) => {
    if (id != null) {
      recordings.stop(id);
      await connections.awaitRecordingReleased(id, 6000);
    }
    return true;
  },
  'conn.maxFor': (pid) => connections.maxFor(pid),
  'conn.providerLimit': (pid) => connections.providerLimit(pid),

  // ---------------------------------------------------------------- updates
  'update.state': () => ({ ...require('./updater').state, recording: recordings.activeCount }),
  'update.check': () => require('./updater').check({ manual: true }),
  'update.download': () => require('./updater').download(),

  // ---------------------------------------------------------------- search
  'search.run': async (pid, q) => {
    const pl = playlist(pid);
    const gen = pl ? pl.epgGen : 0;
    const vodGen = pl ? pl.vodGen : 0;
    const now = Date.now();
    const like = `%${q}%`;
    const chans = db.all('SELECT * FROM channels WHERE playlistId = ? AND hidden = 0 AND name LIKE ? ORDER BY sortIndex LIMIT 40', pid, like);
    const progs = db.all('SELECT * FROM programs WHERE playlistId = ? AND gen = ? AND stop > ? AND title LIKE ? ORDER BY start LIMIT 60', pid, gen, now, like)
      .map((p) => ({ p, c: db.get('SELECT * FROM channels WHERE playlistId = ? AND epgId = ? ORDER BY hidden, sortIndex LIMIT 1', pid, p.epgKey) }))
      .filter((x) => x.c);
    let plexHits = [];
    if (plex.hasServer()) {
      try { plexHits = (await plex.search(q)).map((it) => withPlexImages(it)); } catch (_) { /* ignore */ }
    }
    return {
      channels: chans,
      programs: progs,
      movies: db.all('SELECT * FROM vod WHERE playlistId = ? AND gen = ? AND name LIKE ? ORDER BY name LIMIT 40', pid, vodGen, like),
      series: db.all('SELECT * FROM series WHERE playlistId = ? AND gen = ? AND name LIKE ? ORDER BY name LIMIT 40', pid, vodGen, like),
      plex: plexHits,
    };
  },
};

async function call(method, args) {
  const h = handlers[method];
  if (!h) throw new Error(`Unknown call ${method}`);
  try {
    return await h(...(args || []));
  } catch (e) {
    log.i(`call ${method} failed: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
    throw e;
  }
}

module.exports = { call, handlers };
