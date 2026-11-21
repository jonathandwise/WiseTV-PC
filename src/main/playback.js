'use strict';
// Owns the single mpv player shared by the guide preview and the full-screen player, and the
// provider connection it uses. Port of the Fire TV app's PlaybackManager.
const db = require('./db');
const bus = require('./bus');
const settings = require('./settings');
const connections = require('./connections');
const relay = require('./relay');
const plex = require('./plex');
const log = require('./log');
const playlists = require('./playlists');
const http = require('./http');
const { inUseMessage } = require('./xtream');
const { pathToFileURL } = require('url');

let mpv = null;
let nowPlaying = null; // {type:'live', channel} | {type:'vod', item}
let viaRelay = false;
let previousChannel = null;
let queue = [];
let queueIndex = -1;
let lease = null;
let currentUrl = null;
let currentUa = null;
let currentLive = false;
let retries = 0;
let connCheckDone = false;
let connBlocked = false;
let progressTimer = null;
let parked = null;
let loadToken = 0;
let bufferingSince = 0;
let retryTimer = null;
let pendingSubs = [];
let resizeMode = 'fit';
const props = { pause: false, 'paused-for-cache': false, 'core-idle': true, 'time-pos': 0, duration: 0, 'track-list': [], 'video-params': null, volume: 100, mute: false, speed: 1, 'idle-active': true, 'seeking': false };

function emitState() {
  // Throttled: position changes arrive many times a second.
  if (emitState.t) return;
  emitState.t = setTimeout(() => {
    emitState.t = null;
    bus.emit('player', state());
  }, 100);
}

function state() {
  const buffering = !!nowPlaying && !props.pause && (props['paused-for-cache'] || (props['core-idle'] && !props['idle-active']) || props.seeking || props['idle-active']);
  return {
    nowPlaying,
    viaRelay,
    previousChannel,
    paused: !!props.pause,
    buffering,
    position: (props['time-pos'] || 0) * 1000,
    duration: (props.duration || 0) * 1000,
    volume: props.volume,
    mute: props.mute,
    speed: props.speed,
    hasNext: !!queue[queueIndex + 1],
    nextItem: queue[queueIndex + 1] || null,
    resizeMode,
  };
}

function emitEvent(ev) {
  bus.emit('player-event', ev);
}

function init(m) {
  mpv = m;
  resizeMode = settings.resizeMode;
  for (const name of Object.keys(props)) mpv.observe(name);
  mpv.on('property', (name, value) => {
    props[name] = value;
    if (name === 'paused-for-cache' || name === 'core-idle') {
      const buf = props['paused-for-cache'] || (props['core-idle'] && !props.pause);
      bufferingSince = buf ? bufferingSince || Date.now() : 0;
    }
    if (name === 'time-pos' && value != null) bufferingSince = 0;
    emitState();
  });
  mpv.on('event', onEvent);
  mpv.on('ready', () => {
    applyResize();
    // Interlaced TV channels: deinterlace only frames marked interlaced (newer mpv), else leave off.
    mpv.set('deinterlace', 'auto').catch(() => {});
    if (nowPlaying && currentUrl) start(currentUrl, currentUa, currentLive ? 0 : (props['time-pos'] || 0) * 1000, currentLive, true);
  });
  setInterval(watchdog, 1000);
}

function watchdog() {
  // A live stream that keeps buffering for 20 seconds is reconnected.
  if (nowPlaying && nowPlaying.type === 'live' && !props.pause && bufferingSince && Date.now() - bufferingSince > 20000) {
    bufferingSince = 0;
    log.i('player stalled, reconnecting');
    scheduleRetry(nowPlaying);
  }
}

function onEvent(ev) {
  if (ev.event === 'end-file') {
    if (ev.reason === 'stop' || ev.reason === 'quit' || ev.reason === 'redirect') return;
    const src = nowPlaying;
    if (!src) return;
    log.i(`player end-file reason=${ev.reason} error=${ev.file_error || ''} live=${currentLive}`);
    if (src.type === 'live') {
      scheduleRetry(src);
    } else if (ev.reason === 'eof') {
      saveProgress({ finished: true });
      emitEvent({ type: 'ended' });
    } else {
      emitEvent({ type: 'error', message: friendly(ev.file_error) });
    }
  } else if (ev.event === 'file-loaded') {
    retries = 0;
    for (const s of pendingSubs) mpv.command('sub-add', s.url, 'auto', s.title || s.language || 'Subtitles', s.language || '').catch(() => {});
    pendingSubs = [];
    emitState();
  }
}

function friendly(err) {
  const e = String(err || '').toLowerCase();
  if (e.includes('loading failed') || e.includes('unrecognized')) return "Couldn't play this. The server may have refused it, or your connection limit may be reached.";
  if (e.includes('no audio or video')) return 'This file has no playable audio or video.';
  if (e.includes('not found')) return 'The file is missing.';
  return `Playback error${err ? `: ${err}` : ''}`;
}

// ---------------------------------------------------------------- live

/** Returns {ok:true} or {blocked:{label, recordingId}}. */
async function playChannel(ch, force = false) {
  const cur = nowPlaying;
  if (!force && cur && cur.type === 'live' && cur.channel.id === ch.id && !props['idle-active']) return { ok: true };
  endCurrent();
  const rec = connections.activeRecordingFor(ch.playlistId, ch.url);
  const recId = rec ? rec.recordingId : null;
  releaseLease();
  if (recId == null) {
    const l = connections.tryAcquirePlayer(ch.playlistId, ch.url, ch.name, (by) => onPreempted(by));
    if (!l) {
      const blocking = connections.recordingLeases(ch.playlistId)[0];
      log.i(`tune blocked channel=${ch.name} by=${blocking && blocking.label}`);
      return { blocked: { label: blocking ? blocking.label : 'A recording', recordingId: blocking ? blocking.recordingId : null } };
    }
    lease = l;
  }
  if (cur && cur.type === 'live' && cur.channel.id !== ch.id) previousChannel = cur.channel;
  viaRelay = recId != null;
  nowPlaying = { type: 'live', channel: ch };
  log.i(`tune channel=${ch.name} relay=${viaRelay}`);
  const url = recId != null ? await relay.urlFor(recId) : ch.url;
  start(url, ch.userAgent, 0, true);
  if (ch.id > 0) settings.lastChannelId = ch.id;
  emitState();
  return { ok: true };
}

// ---------------------------------------------------------------- movies, episodes, recordings

function setQueue(items, index) {
  queue = items;
  queueIndex = index;
}

function playVod(item, startMs) {
  endCurrent();
  releaseLease();
  if (!item.local) {
    const l = connections.tryAcquirePlayer(item.playlistId, item.url, item.title, (by) => onPreempted(by));
    if (!l) {
      const blocking = connections.recordingLeases(item.playlistId)[0];
      return { blocked: { label: blocking ? blocking.label : 'A recording', recordingId: blocking ? blocking.recordingId : null } };
    }
    lease = l;
  }
  viaRelay = false;
  const idx = queue.findIndex((q) => q.key === item.key);
  if (idx >= 0) queueIndex = idx;
  nowPlaying = { type: 'vod', item };
  log.i(`play kind=${item.kind} title=${item.title} [${item.subtitle || ''}] from=${Math.round(startMs / 1000)}s`);
  start(item.url, item.userAgent, startMs, false);
  startProgressSaver();
  emitState();
  return { ok: true };
}

function playNext() {
  const next = queue[queueIndex + 1];
  if (!next) return { ok: false };
  return playVod(next, 0);
}

function recordingPlayable(rec) {
  if (!rec.filePath) return null;
  return {
    key: `rec:${rec.id}`, playlistId: rec.playlistId, kind: 'recording', refId: String(rec.id), title: rec.title,
    subtitle: [rec.subtitle, rec.channelName].filter(Boolean).join(' · '), url: pathToFileURL(rec.filePath).toString(),
    poster: rec.channelLogo, userAgent: null, local: true,
  };
}

// ---------------------------------------------------------------- control

function stop() {
  endCurrent();
  clearTimeout(retryTimer);
  loadToken++;
  if (mpv && mpv.ready) mpv.command('stop').catch(() => {});
  releaseLease();
  nowPlaying = null;
  viaRelay = false;
  emitState();
}

/** Stops live TV but remembers the channel (leaving the guide, or the window is hidden). */
function park() {
  if (nowPlaying && nowPlaying.type === 'live') parked = nowPlaying;
  if (nowPlaying) stop();
}

/** Resumes the channel stopped by park(), if any. */
async function unpark() {
  const src = parked;
  parked = null;
  if (src && !nowPlaying) return playChannel(src.channel, true);
  return null;
}

function togglePause() {
  if (!mpv || !nowPlaying) return;
  mpv.set('pause', !props.pause).catch(() => {});
}

function seekBy(ms) {
  if (!mpv || !nowPlaying) return;
  mpv.command('seek', ms / 1000, 'relative').catch(() => {});
}

function seekTo(ms) {
  if (!mpv || !nowPlaying) return;
  mpv.command('seek', Math.max(0, ms / 1000), 'absolute').catch(() => {});
}

function setVolume(v) {
  const vol = Math.max(0, Math.min(150, Math.round(v)));
  settings.volume = vol;
  if (mpv) { mpv.set('volume', vol).catch(() => {}); mpv.set('mute', false).catch(() => {}); }
}

function toggleMute() { if (mpv) mpv.set('mute', !props.mute).catch(() => {}); }
function setSpeed(v) { if (mpv) mpv.set('speed', v).catch(() => {}); }

function applyResize() {
  if (!mpv || !mpv.ready) return;
  mpv.set('keepaspect', resizeMode !== 'stretch').catch(() => {});
  mpv.set('panscan', resizeMode === 'zoom' ? 1.0 : 0.0).catch(() => {});
}

function setResize(mode) {
  resizeMode = mode;
  settings.resizeMode = mode;
  applyResize();
  emitState();
}

function langName(code) {
  if (!code || code === 'und') return null;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch (_) {
    return code;
  }
}

function trackOptions(type) {
  const list = (props['track-list'] || []).filter((t) => t.type === type);
  const chName = (n) => ({ 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' }[n] || null);
  const out = list.map((t, i) => ({
    id: t.id,
    selected: !!t.selected,
    label: [t.title, langName(t.lang), type === 'audio' ? chName(t['demux-channel-count']) : null, t.codec ? String(t.codec).toUpperCase() : null, t.external ? 'external' : null]
      .filter(Boolean).filter((v, j, a) => a.indexOf(v) === j).join(' · ') || `Track ${i + 1}`,
  }));
  if (type === 'sub') out.unshift({ id: 'no', label: 'Off', selected: !list.some((t) => t.selected) });
  return out;
}

function selectTrack(type, id) {
  if (!mpv) return;
  mpv.set(type === 'audio' ? 'aid' : 'sid', id).catch(() => {});
}

async function streamInfo() {
  if (!mpv || !mpv.ready) return [];
  const g = (n) => mpv.get(n).catch(() => null);
  const [vcodec, vp, fps, vbr, acodec, ap, hw, drops, decDrops, cache] = await Promise.all([
    g('video-codec'), g('video-params'), g('container-fps'), g('video-bitrate'), g('audio-codec-name'), g('audio-params'),
    g('hwdec-current'), g('frame-drop-count'), g('decoder-frame-drop-count'), g('demuxer-cache-duration'),
  ]);
  return [
    ['Video', [vcodec, vp && vp.w ? `${vp.w}×${vp.h}` : null, fps ? `${Math.round(fps)} fps` : null, vbr ? `${(vbr / 1e6).toFixed(1)} Mbps` : null].filter(Boolean).join('  ·  ') || 'none'],
    ['Decoder', hw && hw !== 'no' ? `Hardware (${hw})` : 'Software'],
    ['Frames', `${drops || 0} dropped, ${decDrops || 0} dropped by decoder`],
    ['Audio', [acodec ? String(acodec).toUpperCase() : null, ap && ap['channel-count'] ? `${ap['channel-count']} ch` : null, ap && ap.samplerate ? `${ap.samplerate} Hz` : null].filter(Boolean).join('  ·  ') || 'none'],
    ['Buffer', cache != null ? `${cache.toFixed(1)} s` : '?'],
  ];
}

/** Where the picture goes, in the window's CSS pixels: a rectangle, the whole window, or nowhere. */
function setVideoRect(r) {
  if (!mpv || !mpv.ready) return;
  let l = 0, t = 0, rr = 0, b = 0;
  if (r && r.mode === 'rect' && r.W > 0 && r.H > 0) {
    l = Math.max(0, r.x / r.W);
    t = Math.max(0, r.y / r.H);
    rr = Math.max(0, (r.W - r.x - r.w) / r.W);
    b = Math.max(0, (r.H - r.y - r.h) / r.H);
  } else if (r && r.mode === 'hidden') {
    l = 0.999; t = 0.999; rr = 0; b = 0;
  }
  const key = [l, t, rr, b].map((v) => v.toFixed(4)).join(',');
  if (key === setVideoRect.last) return;
  setVideoRect.last = key;
  mpv.set('video-margin-ratio-left', l).catch(() => {});
  mpv.set('video-margin-ratio-top', t).catch(() => {});
  mpv.set('video-margin-ratio-right', rr).catch(() => {});
  mpv.set('video-margin-ratio-bottom', b).catch(() => {});
}

// ---------------------------------------------------------------- internals

function start(url, ua, startPos, live, isRetry = false) {
  if (!mpv) return;
  currentUrl = url;
  currentUa = ua;
  currentLive = live;
  if (!isRetry) {
    retries = 0;
    connCheckDone = false;
    connBlocked = false;
    if (props.speed !== 1) setSpeed(1);
  }
  bufferingSince = Date.now();
  const token = ++loadToken;
  const item = nowPlaying && nowPlaying.type === 'vod' ? nowPlaying.item : null;
  const headers = item && item.headers ? Object.entries(item.headers).map(([k, v]) => `${k}: ${v}`) : [];
  pendingSubs = item && item.subtitles ? item.subtitles : [];
  const run = async () => {
    if (!mpv.ready) return;
    try {
      await mpv.set('user-agent', http.ua(ua));
      await mpv.set('http-header-fields', headers);
      await mpv.set('start', startPos > 0 ? `+${(startPos / 1000).toFixed(1)}` : 'none');
      // Live: keep latency low; VOD: read ahead more.
      await mpv.set('cache-secs', live ? 10 : 60);
      await mpv.set('pause', false);
      if (token !== loadToken) return;
      await mpv.command('loadfile', url, 'replace');
    } catch (e) {
      log.i(`mpv load failed ${e.message}`);
    }
  };
  run();
}

function scheduleRetry(src) {
  clearTimeout(retryTimer);
  if (connBlocked || nowPlaying !== src) return;
  if (viaRelay) {
    // The recording we were watching through has ended; reconnect directly.
    retryTimer = setTimeout(() => { if (nowPlaying === src) playChannel(src.channel, true); }, 1500);
    return;
  }
  if (retries >= 8) {
    emitEvent({ type: 'error', message: "This channel isn't responding. Try another channel or try again later." });
    return;
  }
  retries++;
  // Checked only after several refusals: a provider can briefly count our own previous stream too.
  if (retries === 3 && !connCheckDone) checkConnections(src);
  // The first retry is silent: providers often refuse a new stream for a moment after a channel change.
  if (retries > 1) emitEvent({ type: 'error', message: 'Reconnecting…', transient: true });
  const url = currentUrl;
  retryTimer = setTimeout(() => {
    if (nowPlaying === src && currentUrl === url && !connBlocked) start(url, currentUa, 0, true, true);
  }, retries === 1 ? 800 : 1500 * retries);
}

/**
 * A channel keeps being refused: ask the provider whether its connections are all in use. If so,
 * another app or device (often the Fire Stick) has it, so say that instead of retrying.
 */
async function checkConnections(src) {
  connCheckDone = true;
  const pl = db.get('SELECT * FROM playlists WHERE id = ?', src.channel.playlistId);
  if (!pl || pl.type !== 'xtream') return;
  let max;
  try {
    const auth = await playlists.xtream(pl).authenticate();
    log.i(`connections active=${auth.activeConnections} max=${auth.maxConnections}`);
    if (!auth.inUse) return;
    max = auth.maxConnections;
  } catch (e) {
    if (!e.connectionLimit) return;
    max = pl.maxConnections;
  }
  if (nowPlaying !== src || connBlocked) return;
  connBlocked = true;
  clearTimeout(retryTimer);
  if (mpv) mpv.command('stop').catch(() => {});
  log.i(`connection in use by another app max=${max}`);
  emitEvent({ type: 'error', message: inUseMessage(max), everywhere: true });
}

async function onPreempted(by) {
  const src = nowPlaying;
  log.i(`player preempted by recording id=${by.id} title=${by.title}`);
  endCurrent();
  clearTimeout(retryTimer);
  loadToken++;
  if (mpv) mpv.command('stop').catch(() => {});
  releaseLease();
  if (src && src.type === 'live' && src.channel.url === by.streamUrl) {
    // Same channel: keep watching through the recorder's local relay.
    viaRelay = true;
    emitState();
    const url = await relay.urlFor(by.id);
    setTimeout(() => { if (nowPlaying === src) start(url, src.channel.userAgent, 0, true); }, 1200);
  } else {
    nowPlaying = null;
    emitState();
    emitEvent({ type: 'tookOver', rec: by, previous: src });
  }
}

function releaseLease() {
  connections.release(lease);
  lease = null;
}

/** Saves where the current title got to and tells Plex to stop converting it. */
function endCurrent() {
  saveProgress({ stopping: true });
  clearInterval(progressTimer);
  progressTimer = null;
  const item = nowPlaying && nowPlaying.type === 'vod' ? nowPlaying.item : null;
  if (item && item.plexSession && item.plexServer) plex.stopTranscode(item.plexServer, item.plexSession);
}

function startProgressSaver() {
  clearInterval(progressTimer);
  progressTimer = setInterval(() => { if (!props.pause) saveProgress({}); }, 10000);
}

function saveProgress({ finished = false, stopping = false }) {
  const src = nowPlaying;
  if (!src || src.type !== 'vod') return;
  const dur = (props.duration || 0) * 1000;
  if (!(dur > 0)) return;
  const pos = finished ? dur : (props['time-pos'] || 0) * 1000;
  const item = src.item;
  if (item.plexKey && item.plexServer) {
    const st = stopping || finished ? 'stopped' : props.pause ? 'paused' : 'playing';
    const done = finished || pos >= dur * 0.95;
    plex.timeline(item.plexServer, item.plexKey, st, pos, dur, item.plexSession).then(() => {
      if (done && (stopping || finished)) plex.markWatched(item.plexServer, item.plexKey);
    });
    return;
  }
  db.insert('progress', {
    key: item.key, playlistId: item.playlistId, kind: item.kind, refId: item.refId, title: item.title, poster: item.poster || null,
    position: Math.round(pos), duration: Math.round(dur), updatedAt: Date.now(), seriesKey: item.seriesKey || null,
    season: item.season ?? null, episodeNum: item.episode ?? null, finished: finished || pos >= dur * 0.95 ? 1 : 0,
  }, 'INSERT OR REPLACE');
  db.changed('progress');
}

function shutdown() {
  endCurrent();
  releaseLease();
}

module.exports = {
  init, state, playChannel, setQueue, playVod, playNext, recordingPlayable, stop, park, unpark, togglePause, seekBy, seekTo,
  setVolume, toggleMute, setSpeed, setResize, trackOptions, selectTrack, streamInfo, setVideoRect, shutdown,
  get nowPlaying() { return nowPlaying; },
};
