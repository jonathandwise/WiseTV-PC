'use strict';
// Plex client: links the account with a code (plex.tv/link), then uses every server the user
// picks (their own and shared ones). Finds the best address for each (home network first, then
// internet, then relay), browses libraries, and plays files directly (mpv decodes anything) or,
// away from home with a bitrate limit, converted by the server.
const crypto = require('crypto');
const os = require('os');
const settings = require('./settings');
const http = require('./http');
const log = require('./log');
const bus = require('./bus');
const { app } = require('electron');

const PRODUCT = 'WiseTV';
const plexTv = () => process.env.WISETV_PLEX_TV || 'https://plex.tv';

class PlexAuthError extends Error {
  constructor() { super('Plex no longer accepts the saved sign-in. Link your account again in Settings.'); this.plexAuth = true; }
}

const linked = () => !!settings.plexToken;
const servers = () => (Array.isArray(settings.plexServers) ? settings.plexServers : []);
const hasServer = () => linked() && servers().length > 0;
const server = (id) => servers().find((s) => s.id === id) || null;
function save(list) { settings.plexServers = list; bus.emit('plex'); }
function updateServer(id, change) { save(servers().map((s) => (s.id === id ? change(s) : s))); }

function clientId() {
  if (!settings.plexClientId) settings.plexClientId = crypto.randomUUID();
  return settings.plexClientId;
}

let cachedLibs = null;
const cachedItems = new Map();
const recentOffsets = new Map();
const connLocks = new Map();

function headers(token) {
  const h = {
    Accept: 'application/json',
    'X-Plex-Client-Identifier': clientId(),
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': app.getVersion(),
    'X-Plex-Platform': 'Windows',
    'X-Plex-Platform-Version': os.release(),
    'X-Plex-Device': 'PC',
    'X-Plex-Device-Name': `WiseTV (${os.hostname()})`,
  };
  if (token) h['X-Plex-Token'] = token;
  return h;
}

async function get(url, token, { quick = false } = {}) {
  const { res, abort } = await http.open(url, { headers: headers(token), userAgent: `WiseTV/${app.getVersion()}`, connectMs: quick ? 4000 : 20000 });
  const t = setTimeout(abort, quick ? 6000 : 60000);
  try {
    if (res.status === 401) throw new PlexAuthError();
    if (!res.ok) throw new Error(`Plex answered HTTP ${res.status}`);
    const text = await res.text();
    return text.trim() ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

async function send(url, token, method = 'GET') {
  try {
    const { res } = await http.open(url, { method, headers: headers(token), connectMs: 15000 });
    await res.arrayBuffer().catch(() => {});
  } catch (_) { /* ignore */ }
}

const container = (j) => (j && j.MediaContainer) || {};
const arr = (o, k) => (o && Array.isArray(o[k]) ? o[k] : []);
const s = (o, k) => (o && o[k] !== undefined && o[k] !== null && typeof o[k] !== 'object' ? String(o[k]) : null);
const bool = (o, k) => !!o && (o[k] === true || o[k] === 1 || o[k] === '1' || o[k] === 'true');
const tags = (o, k) => arr(o, k).map((t) => t && t.tag).filter(Boolean);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ------------------------------------------------------------------ account

async function startPin() {
  const { res } = await http.open(`${plexTv()}/api/v2/pins?strong=false`, { method: 'POST', headers: headers(null) });
  if (!res.ok) throw new Error(`plex.tv answered HTTP ${res.status}`);
  const o = await res.json();
  return { id: o.id, code: o.code };
}

async function pollPin(pin) {
  const o = await get(`${plexTv()}/api/v2/pins/${pin.id}`, null);
  return o.authToken || null;
}

async function finishLink(token) {
  let user = null;
  try { user = await get(`${plexTv()}/api/v2/user`, token); } catch (_) { /* ignore */ }
  settings.plexToken = token;
  settings.plexUser = (user && (user.username || user.title)) || 'Plex account';
  log.i(`plex linked user=${settings.plexUser}`);
  bus.emit('plex');
}

function unlink() {
  settings.plexToken = '';
  settings.plexUser = '';
  save([]);
  invalidate();
}

/** Every server on the account: the user's own and ones shared with them. */
async function accountServers() {
  const list = await get(`${plexTv()}/api/v2/resources?includeHttps=1&includeRelay=1`, settings.plexToken);
  const out = [];
  for (const o of Array.isArray(list) ? list : []) {
    if (!String(o.provides || '').includes('server') || !o.clientIdentifier) continue;
    const conns = arr(o, 'connections').map((c) => ({ uri: s(c, 'uri') || '', local: bool(c, 'local'), relay: bool(c, 'relay') }));
    // Plain address too: some home routers refuse to resolve Plex's *.plex.direct names.
    for (const c of arr(o, 'connections')) {
      if (c.address && bool(c, 'local') && !bool(c, 'relay')) conns.push({ uri: `http://${c.address}:${c.port || 32400}`, local: true, relay: false });
    }
    const seen = new Set();
    out.push({
      name: o.name || 'Plex server',
      id: o.clientIdentifier,
      accessToken: o.accessToken || settings.plexToken,
      owned: bool(o, 'owned'),
      connections: conns.filter((c) => c.uri && !seen.has(c.uri) && seen.add(c.uri)),
    });
  }
  return out.sort((a, b) => (b.owned - a.owned) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** Uses exactly `chosen` from now on and connects to each one. Returns {name: error|null}. */
async function setServers(chosen) {
  const keep = new Map(servers().map((x) => [x.id, x]));
  save(chosen.map((srv) => ({ id: srv.id, name: srv.name, token: srv.accessToken, owned: srv.owned, uri: keep.get(srv.id)?.uri || '', local: keep.get(srv.id)?.local ?? true })));
  invalidate();
  const results = {};
  await Promise.all(chosen.map(async (srv) => {
    try { await connection(srv.id, srv); results[srv.name] = null; } catch (e) { results[srv.name] = e.message || "couldn't connect"; }
  }));
  return results;
}

// ------------------------------------------------------------------ connections

async function connection(serverId, known) {
  while (connLocks.get(serverId)) await connLocks.get(serverId).catch(() => {});
  const p = (async () => {
    const saved = server(serverId);
    if (!saved) throw new Error('That Plex server is no longer in use.');
    if (saved.uri) return { uri: saved.uri, local: saved.local };
    const fresh = known || (await accountServers()).find((x) => x.id === serverId);
    if (!fresh) throw new Error(`The Plex server “${saved.name}” isn't on your account any more.`);
    const token = fresh.accessToken || saved.token;
    const rank = (c) => (c.local && !c.relay ? 0 : !c.relay ? 1 : 2);
    const ordered = [...fresh.connections].sort((a, b) => rank(a) - rank(b));
    for (const c of ordered) {
      let ok = false;
      try { await get(`${c.uri}/identity`, token, { quick: true }); ok = true; } catch (_) { /* next */ }
      log.i(`plex try ${c.uri} local=${c.local} relay=${c.relay} ok=${ok}`);
      if (ok) {
        updateServer(serverId, (x) => ({ ...x, token, uri: c.uri, local: c.local }));
        return { uri: c.uri, local: c.local };
      }
    }
    throw new Error(`Can't reach the Plex server “${saved.name}”. Is it switched on?`);
  })();
  connLocks.set(serverId, p);
  try { return await p; } finally { connLocks.delete(serverId); }
}

/** Runs `block` against one server, finding a new address once if the saved one stopped working. */
async function onServer(serverId, block) {
  if (!linked()) throw new Error('Link Plex in Settings first.');
  const c = await connection(serverId);
  try {
    return await block(c.uri, server(serverId)?.token || '');
  } catch (e) {
    if (e.plexAuth) throw e;
    log.i(`plex ${c.uri} failed (${e.message}); looking for another address`);
    updateServer(serverId, (x) => ({ ...x, uri: '' }));
    const c2 = await connection(serverId);
    return block(c2.uri, server(serverId)?.token || '');
  }
}

async function onAll(block) {
  const results = await Promise.all(servers().map((srv) => block(srv).catch(() => [])));
  return results.flat();
}

const isLocal = (serverId) => server(serverId)?.local ?? true;

// ------------------------------------------------------------------ browsing

function parseItem(serverId, o) {
  const mediaO = arr(o, 'Media')[0] || null;
  const partO = mediaO ? arr(mediaO, 'Part')[0] || null : null;
  const subtitles = partO ? arr(partO, 'Stream').filter((st) => s(st, 'streamType') === '3' && st.key).map((st) => ({
    key: st.key, codec: (s(st, 'codec') || '').toLowerCase(), language: s(st, 'languageCode') || s(st, 'language'), title: s(st, 'displayTitle') || s(st, 'title'),
  })) : [];
  const viewCount = num(o.viewCount);
  const viewOffsetMs = num(o.viewOffset);
  return {
    serverId,
    ratingKey: s(o, 'ratingKey') || '',
    uid: `${serverId}:${s(o, 'ratingKey') || ''}`,
    type: s(o, 'type') || '',
    title: s(o, 'title') || '',
    year: s(o, 'year'),
    summary: (s(o, 'summary') || '').trim() || null,
    thumb: s(o, 'thumb'),
    art: s(o, 'art'),
    rating: o.audienceRating != null ? num(o.audienceRating) : o.rating != null ? num(o.rating) : null,
    addedAt: num(o.addedAt) * 1000,
    durationMs: num(o.duration),
    viewOffsetMs,
    viewCount,
    watched: viewCount > 0 && viewOffsetMs === 0,
    index: o.index != null ? num(o.index) : null,
    parentIndex: o.parentIndex != null ? num(o.parentIndex) : null,
    grandparentTitle: s(o, 'grandparentTitle'),
    grandparentRatingKey: s(o, 'grandparentRatingKey'),
    grandparentThumb: s(o, 'grandparentThumb'),
    parentTitle: s(o, 'parentTitle'),
    parentRatingKey: s(o, 'parentRatingKey'),
    parentThumb: s(o, 'parentThumb'),
    genres: tags(o, 'Genre'),
    directors: tags(o, 'Director'),
    cast: tags(o, 'Role').slice(0, 6),
    contentRating: s(o, 'contentRating'),
    leafCount: num(o.leafCount),
    viewedLeafCount: num(o.viewedLeafCount),
    media: mediaO ? {
      container: (s(partO, 'container') || s(mediaO, 'container') || '').toLowerCase() || null,
      videoCodec: (s(mediaO, 'videoCodec') || '').toLowerCase() || null,
      audioCodec: (s(mediaO, 'audioCodec') || '').toLowerCase() || null,
      bitrateKbps: num(mediaO.bitrate),
      height: num(mediaO.height),
      partKey: s(partO, 'key'),
    } : null,
    subtitles,
  };
}

async function libraries(force = false) {
  if (!force && cachedLibs && Date.now() - cachedLibs.at < 10 * 60000) return cachedLibs.value;
  const results = await Promise.all(servers().map(async (srv) => {
    try {
      const libs = await onServer(srv.id, async (base, tok) => arr(container(await get(`${base}/library/sections`, tok)), 'Directory')
        .map((o) => ({ serverId: srv.id, serverName: srv.name, key: s(o, 'key') || '', title: s(o, 'title') || 'Library', type: s(o, 'type') || '' }))
        .filter((l) => l.type === 'movie' || l.type === 'show')
        .map((l) => ({ ...l, id: `${l.serverId}:${l.key}` })));
      return { srv, libs };
    } catch (e) {
      return { srv, error: e.message };
    }
  }));
  const value = {
    libraries: results.flatMap((r) => r.libs || []),
    unreachable: results.filter((r) => r.error).map((r) => r.srv.name),
  };
  if (!value.unreachable.length) cachedLibs = { at: Date.now(), value };
  return value;
}

/** A TV library's "recently added" holds seasons and episodes; turn each into its show. */
function asShows(items) {
  const out = [];
  const seen = new Set();
  for (const it of items) {
    let x = null;
    if (it.type === 'show') x = it;
    else if (it.type === 'season' && it.parentRatingKey) x = { ...it, ratingKey: it.parentRatingKey, type: 'show', title: it.parentTitle || it.title, thumb: it.parentThumb || it.thumb, year: null, rating: null };
    else if (it.type === 'episode' && it.grandparentRatingKey) x = { ...it, ratingKey: it.grandparentRatingKey, type: 'show', title: it.grandparentTitle || it.title, thumb: it.grandparentThumb || it.thumb, year: null, rating: null };
    if (!x || seen.has(x.ratingKey)) continue;
    seen.add(x.ratingKey);
    out.push({ ...x, uid: `${x.serverId}:${x.ratingKey}`, viewOffsetMs: 0, durationMs: 0 });
  }
  return out;
}

async function items(lib, recent) {
  const key = `${lib.id}|${recent}`;
  const c = cachedItems.get(key);
  if (c && Date.now() - c.at < 5 * 60000) return c.value;
  let list = await onServer(lib.serverId, async (base, tok) => {
    const path = recent ? 'recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=100' : 'all';
    return arr(container(await get(`${base}/library/sections/${lib.key}/${path}`, tok)), 'Metadata').map((o) => parseItem(lib.serverId, o));
  });
  if (lib.type === 'show') list = asShows(list);
  cachedItems.set(key, { at: Date.now(), value: list });
  return list;
}

async function metadata(serverId, ratingKey) {
  return onServer(serverId, async (base, tok) => {
    const m = arr(container(await get(`${base}/library/metadata/${ratingKey}`, tok)), 'Metadata')[0];
    if (!m) throw new Error('This title is no longer on that Plex server.');
    return parseItem(serverId, m);
  });
}

async function episodes(serverId, showKey) {
  return onServer(serverId, async (base, tok) => arr(container(await get(`${base}/library/metadata/${showKey}/allLeaves`, tok)), 'Metadata').map((o) => parseItem(serverId, o)));
}

async function onDeck() {
  return onAll((srv) => onServer(srv.id, async (base, tok) => arr(container(await get(`${base}/library/onDeck`, tok)), 'Metadata').map((o) => parseItem(srv.id, o))));
}

async function search(query) {
  return onAll((srv) => onServer(srv.id, async (base, tok) => {
    const j = await get(`${base}/hubs/search?query=${encodeURIComponent(query)}&limit=15`, tok);
    return arr(container(j), 'Hub').flatMap((h) => arr(h, 'Metadata').map((o) => parseItem(srv.id, o)))
      .filter((it) => ['movie', 'show', 'episode'].includes(it.type));
  }));
}

function invalidate() {
  cachedLibs = null;
  cachedItems.clear();
}

/** A server-resized poster or still. */
function image(serverId, path, width, height) {
  const srv = server(serverId);
  if (!path || !srv || !srv.uri) return null;
  return `${srv.uri}/photo/:/transcode?width=${width}&height=${height}&minSize=1&upscale=1&url=${encodeURIComponent(path)}&X-Plex-Token=${srv.token}`;
}

const offsetOf = (item) => (recentOffsets.has(item.uid) ? recentOffsets.get(item.uid) : item.viewOffsetMs);

// ------------------------------------------------------------------ playback

function playHeaders(token, session) {
  const h = { 'X-Plex-Token': token, 'X-Plex-Client-Identifier': clientId(), 'X-Plex-Product': PRODUCT, 'X-Plex-Platform': 'Windows' };
  if (session) h['X-Plex-Session-Identifier'] = session;
  return h;
}

function willConvert(serverId, m) {
  if (!m || !m.partKey) return true;
  const limit = isLocal(serverId) ? 0 : settings.plexRemoteKbps;
  return limit > 0 && !(m.bitrateKbps > 0 && m.bitrateKbps <= limit);
}

/** Works out how to play `item`: the file as-is (mpv plays anything), or converted away from home. */
async function playback(item) {
  const conn = await connection(item.serverId);
  const base = conn.uri;
  const tok = server(item.serverId)?.token || '';
  const m = item.media;
  const subs = item.subtitles.map((sub) => ({ url: `${base}${sub.key}?X-Plex-Token=${tok}`, language: sub.language, title: sub.title }));
  if (!willConvert(item.serverId, m)) {
    log.i(`plex play direct ${item.title} ${m?.container}/${m?.videoCodec}/${m?.audioCodec}`);
    return { url: `${base}${m.partKey}?X-Plex-Token=${tok}`, session: null, subtitles: subs, headers: playHeaders(tok, null) };
  }
  const limit = conn.local ? 0 : settings.plexRemoteKbps;
  const session = crypto.randomUUID();
  const profile = 'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264,hevc&audioCodec=aac,ac3,eac3)' +
    '+add-limitation(scope=videoAudioCodec&scopeName=*&type=upperBound&name=audio.channels&value=6)';
  const q = {
    hasMDE: '1', path: `/library/metadata/${item.ratingKey}`, mediaIndex: '0', partIndex: '0', protocol: 'hls', fastSeek: '1',
    directPlay: '0', directStream: '1', directStreamAudio: '1', copyts: '1', subtitles: 'auto', location: conn.local ? 'lan' : 'wan',
    session, 'X-Plex-Session-Identifier': session, 'X-Plex-Client-Identifier': clientId(), 'X-Plex-Product': PRODUCT,
    'X-Plex-Platform': 'Windows', 'X-Plex-Device': 'PC', 'X-Plex-Client-Profile-Extra': profile, 'X-Plex-Token': tok,
  };
  if (limit > 0) {
    q.maxVideoBitrate = String(limit);
    q.videoBitrate = String(limit);
    q.videoResolution = limit >= 12000 ? '1920x1080' : limit >= 4000 ? '1280x720' : '854x480';
  }
  const qs = Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  log.i(`plex play transcode ${item.title} limit=${limit}`);
  return { url: `${base}/video/:/transcode/universal/start.m3u8?${qs}`, session, subtitles: [], headers: playHeaders(tok, session) };
}

/** Tells the server where playback is, so other Plex apps resume from the same spot. */
async function timeline(serverId, ratingKey, state, positionMs, durationMs, session) {
  recentOffsets.set(`${serverId}:${ratingKey}`, positionMs >= durationMs * 0.95 ? 0 : positionMs);
  try {
    await onServer(serverId, (base, tok) => send(`${base}/:/timeline?ratingKey=${ratingKey}&key=%2Flibrary%2Fmetadata%2F${ratingKey}&state=${state}` +
      `&time=${Math.round(positionMs)}&duration=${Math.round(durationMs)}` + (session ? `&X-Plex-Session-Identifier=${session}` : ''), tok));
  } catch (_) { /* ignore */ }
}

async function markWatched(serverId, ratingKey) {
  recentOffsets.set(`${serverId}:${ratingKey}`, 0);
  try { await onServer(serverId, (base, tok) => send(`${base}/:/scrobble?key=${ratingKey}&identifier=com.plexapp.plugins.library`, tok)); } catch (_) { /* ignore */ }
  cachedItems.clear();
}

async function stopTranscode(serverId, session) {
  try { await onServer(serverId, (base, tok) => send(`${base}/video/:/transcode/universal/stop?session=${session}`, tok)); } catch (_) { /* ignore */ }
}

module.exports = {
  linked, servers, hasServer, server, isLocal, startPin, pollPin, finishLink, unlink, accountServers, setServers,
  libraries, items, metadata, episodes, onDeck, search, invalidate, image, offsetOf, willConvert, playback, timeline,
  markWatched, stopTranscode,
};
