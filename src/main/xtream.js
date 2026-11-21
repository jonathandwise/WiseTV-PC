'use strict';
// Minimal Xtream Codes client.
const http = require('./http');

const OTHER_APP_HINT = 'If this login works in another app such as TiviMate, close that app first: your provider may allow only one connection at a time.';

function inUseMessage(max) {
  return `Your provider's ${max === 1 ? '1 connection is' : `${max} connections are`} in use by another app or device ` +
    '(for example the Fire Stick). Close it, then try again.';
}

class ConnectionLimitError extends Error {
  constructor(max) {
    super(inUseMessage(max || 1));
    this.connectionLimit = true;
  }
}

function normalizeServer(input) {
  let s = String(input || '').trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  for (const marker of ['/player_api.php', '/get.php', '/xmltv.php', '/panel_api.php']) {
    const idx = s.toLowerCase().indexOf(marker);
    if (idx > 0) s = s.substring(0, idx);
  }
  return s.replace(/\/+$/, '');
}

/** Recognises an Xtream "get.php" M3U link and extracts the login. */
function credsFromM3uUrl(url) {
  const m = /^(https?:\/\/[^/?#]+)(?:\/[^?#]*)?\/get\.php\?(.+)$/i.exec(String(url).trim());
  if (!m) return null;
  const params = {};
  for (const part of m[2].split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { params[part.substring(0, i).toLowerCase()] = decodeURIComponent(part.substring(i + 1).replace(/\+/g, ' ')); } catch (_) { /* ignore */ }
  }
  if (!params.username || !params.password) return null;
  return { server: m[1], username: params.username, password: params.password };
}

const str = (o, k) => {
  if (!o || o[k] === undefined || o[k] === null) return null;
  const v = o[k];
  if (typeof v === 'object') return null;
  return String(v);
};
const firstString = (o, k) => {
  if (!o) return null;
  const v = o[k];
  if (Array.isArray(v)) return v.find((x) => typeof x === 'string' && x.trim()) || null;
  return typeof v === 'string' && v.trim() ? v : null;
};
const int = (v, d = null) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

class XtreamApi {
  constructor(server, username, password, userAgent) {
    this.base = normalizeServer(server);
    this.username = username;
    this.password = password;
    this.userAgent = userAgent || null;
  }

  apiUrl(action, extra = '') {
    const e = encodeURIComponent;
    return `${this.base}/player_api.php?username=${e(this.username)}&password=${e(this.password)}` +
      (action ? `&action=${action}` : '') + extra;
  }

  epgUrl() {
    const e = encodeURIComponent;
    return `${this.base}/xmltv.php?username=${e(this.username)}&password=${e(this.password)}`;
  }

  liveUrl(id, ext) { return `${this.base}/live/${this.username}/${this.password}/${id}.${ext}`; }
  movieUrl(id, ext) { return `${this.base}/movie/${this.username}/${this.password}/${id}.${ext}`; }
  episodeUrl(id, ext) { return `${this.base}/series/${this.username}/${this.password}/${id}.${ext}`; }

  async tree(url) {
    let text;
    try {
      text = await http.text(url, { userAgent: this.userAgent, totalMs: 180000 });
    } catch (e) {
      if (e instanceof http.HttpError) {
        if (e.status === 401 || e.status === 403) throw new Error(`The server refused the login (HTTP ${e.status}). Check the username and password. ${OTHER_APP_HINT}`);
        if ([429, 456, 458, 509].includes(e.status)) throw new ConnectionLimitError(null);
        throw new Error(`The server returned an error (HTTP ${e.status}).`);
      }
      throw e;
    }
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error("The server didn't return Xtream data. Check the server address.");
    }
  }

  async authenticate() {
    const root = await this.tree(this.apiUrl());
    const ui = root && typeof root === 'object' ? root.user_info : null;
    if (!ui) throw new Error('Login failed. Check the server address, username and password.');
    if (str(ui, 'auth') !== '1') {
      const msg = (str(ui, 'message') || '').trim();
      if (msg && /connection|limit|max/i.test(msg)) throw new ConnectionLimitError(int(str(ui, 'max_connections')));
      throw new Error((msg || 'Login failed. Check the username and password.') + ' ' + OTHER_APP_HINT);
    }
    const status = str(ui, 'status') || '';
    if (status && status.toLowerCase() !== 'active') throw new Error(`Your subscription status is "${status}".`);
    const max = Math.max(1, int(str(ui, 'max_connections'), 1));
    const active = int(str(ui, 'active_cons'), 0);
    return {
      status,
      expiresAt: (int(str(ui, 'exp_date'), 0) || 0) * 1000,
      maxConnections: max,
      activeConnections: active,
      inUse: active >= max,
    };
  }

  async categories(action) {
    const el = await this.tree(this.apiUrl(action));
    if (!Array.isArray(el)) return [];
    return el.filter((o) => o && o.category_id !== undefined && o.category_id !== null).map((o) => ({
      id: String(o.category_id),
      name: (str(o, 'category_name') || '').trim() || `Category ${o.category_id}`,
    }));
  }

  /** Calls `onItem` for every object in a (possibly huge) list answer. */
  async eachItem(action, onItem) {
    const el = await this.tree(this.apiUrl(action));
    const list = Array.isArray(el) ? el : el && typeof el === 'object' ? Object.values(el) : [];
    for (const o of list) if (o && typeof o === 'object') onItem(o);
  }

  async seriesInfo(seriesId) {
    const root = await this.tree(this.apiUrl('get_series_info', `&series_id=${encodeURIComponent(seriesId)}`));
    if (!root || typeof root !== 'object') throw new Error('No details for this series.');
    const info = root.info && typeof root.info === 'object' ? root.info : null;
    const episodes = [];
    const addEp = (o, seasonHint) => {
      if (!o || typeof o !== 'object' || o.id === undefined) return;
      const epInfo = o.info && typeof o.info === 'object' ? o.info : null;
      const season = int(str(o, 'season')) ?? seasonHint ?? 1;
      episodes.push({
        id: String(o.id),
        season,
        number: int(str(o, 'episode_num')) ?? (episodes.filter((e) => e.season === season).length + 1),
        title: (str(o, 'title') || '').trim(),
        ext: (str(o, 'container_extension') || '').trim() || 'mp4',
        plot: str(epInfo, 'plot'),
        image: str(epInfo, 'movie_image'),
        durationSecs: int(str(epInfo, 'duration_secs')),
      });
    };
    const eps = root.episodes;
    if (Array.isArray(eps)) {
      for (const item of eps) Array.isArray(item) ? item.forEach((x) => addEp(x, null)) : addEp(item, null);
    } else if (eps && typeof eps === 'object') {
      for (const [k, v] of Object.entries(eps)) Array.isArray(v) ? v.forEach((x) => addEp(x, int(k))) : addEp(v, int(k));
    }
    episodes.sort((a, b) => a.season - b.season || a.number - b.number);
    return {
      name: str(info, 'name'),
      plot: str(info, 'plot'),
      cast: str(info, 'cast'),
      genre: str(info, 'genre'),
      releaseDate: str(info, 'releaseDate') || str(info, 'release_date'),
      rating: str(info, 'rating'),
      cover: str(info, 'cover'),
      backdrop: firstString(info, 'backdrop_path'),
      episodes,
    };
  }

  async vodInfo(vodId) {
    const root = await this.tree(this.apiUrl('get_vod_info', `&vod_id=${encodeURIComponent(vodId)}`));
    if (!root || typeof root !== 'object') throw new Error('No details for this movie.');
    const info = root.info && typeof root.info === 'object' ? root.info : null;
    const data = root.movie_data && typeof root.movie_data === 'object' ? root.movie_data : null;
    return {
      plot: str(info, 'plot') || str(info, 'description'),
      genre: str(info, 'genre'),
      cast: str(info, 'cast') || str(info, 'actors'),
      director: str(info, 'director'),
      releaseDate: str(info, 'releasedate') || str(info, 'release_date'),
      duration: str(info, 'duration'),
      rating: str(info, 'rating'),
      image: str(info, 'movie_image') || str(info, 'cover_big'),
      backdrop: firstString(info, 'backdrop_path'),
      ext: str(data, 'container_extension'),
    };
  }
}

module.exports = { XtreamApi, normalizeServer, credsFromM3uUrl, inUseMessage, ConnectionLimitError, OTHER_APP_HINT };
