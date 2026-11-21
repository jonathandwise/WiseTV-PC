// App-wide state and actions (the Fire TV app's AppState).
import { useEffect, useState } from 'preact/hooks';
import { call, win, on } from './lib';

const listeners = new Set();
let state = {
  ready: false,
  nav: [{ name: 'main', section: 'guide' }],
  playlistId: 0,
  playlists: null,
  settings: {},
  info: {},
  toast: null,
  programMenu: null,
  blocked: null,
  tookOver: null,
  player: { nowPlaying: null, paused: false, buffering: false, position: 0, duration: 0, volume: 100 },
  sync: { status: null, error: null },
  fullscreen: false,
  shown: true,
  favoriteChanges: {},
  vodCategory: {},
  guideGroup: '__all__',
  update: null,
  updateDismissed: null,
};

export const getState = () => state;

export function setState(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const l of listeners) l();
}

export function useStore(selector = (s) => s) {
  const [, force] = useState(0);
  useEffect(() => {
    let last = selector(state);
    const l = () => {
      const next = selector(state);
      if (next !== last) {
        last = next;
        force((x) => x + 1);
      }
    };
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return selector(state);
}

// ------------------------------------------------------------------ navigation

export const current = () => state.nav[state.nav.length - 1];
export const nav = {
  push(screen) { setState({ nav: [...state.nav, screen] }); },
  pop() {
    if (state.nav.length <= 1) return false;
    setState({ nav: state.nav.slice(0, -1) });
    return true;
  },
  replaceTop(screen) { setState({ nav: [...state.nav.slice(0, -1), screen] }); },
  resetTo(screen) { setState({ nav: [screen] }); },
};

let toastTimer = null;
export function showToast(msg, ms = 4500) {
  setState({ toast: msg });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (state.toast === msg) setState({ toast: null }); }, ms);
}

export function setSetting(key, value) {
  setState({ settings: { ...state.settings, [key]: value } });
  return call('settings.set', key, value);
}

// ------------------------------------------------------------------ playlists

export async function setActivePlaylist(id) {
  if (id === state.playlistId) return;
  await setSetting('activePlaylistId', id);
  await setSetting('lastGroup', '__all__');
  setState({ playlistId: id, vodCategory: {}, guideGroup: '__all__' });
}

// ------------------------------------------------------------------ playback

const isPlayer = () => current().name === 'player';

export async function tune(ch, fullscreen) {
  const r = await call('player.tune', ch);
  if (r.blocked) {
    setState({ blocked: { ...r.blocked, channel: ch, vod: null, vodStart: 0, fullscreen } });
  } else if (fullscreen && !isPlayer()) {
    nav.push({ name: 'player' });
  }
  return r;
}

export async function playVod(item, startMs) {
  const r = await call('player.playVod', item, startMs);
  if (r.blocked) setState({ blocked: { ...r.blocked, channel: null, vod: item, vodStart: startMs, fullscreen: true } });
  else if (!isPlayer()) nav.push({ name: 'player' });
  return r;
}

export async function playQueue(items, index, startMs) {
  await call('player.setQueue', items, index);
  return playVod(items[index], startMs);
}

export async function playRecording(id, fromStart = false) {
  const r = await call('player.playRecording', id, fromStart);
  if (r.ok && !isPlayer()) nav.push({ name: 'player' });
}

export async function playPlex(items, index, resume) {
  try {
    const r = await call('player.playPlex', items, index, resume);
    if (r.blocked) showToast('A recording is using the connection');
    else if (!isPlayer()) nav.push({ name: 'player' });
  } catch (e) {
    showToast(`Plex: ${e.message}`);
  }
}

export async function watchRecordingChannel(recId) {
  const r = await call('player.watchRecordingChannel', recId);
  if (r.ok && !isPlayer()) nav.push({ name: 'player' });
}

/** Stops a recording, waits for its connection to close, then does `then`. */
export async function stopRecordingThen(recId, then) {
  await call('rec.stopAndWait', recId);
  await then();
}

export function retryBlocked(b) {
  if (b.channel) tune(b.channel, b.fullscreen);
  if (b.vod) playVod(b.vod, b.vodStart);
}

export async function toggleFavorite(ch) {
  if (!ch || ch.id <= 0) return;
  const r = await call('channels.toggleFavorite', ch.id);
  if (!r) return;
  setState({ favoriteChanges: { ...state.favoriteChanges, [ch.id]: r.favorite } });
  showToast(r.favorite ? `★ Added ${r.name} to favorites` : `Removed ${r.name} from favorites`);
}

export function isFavorite(ch) {
  if (!ch || ch.id <= 0) return false;
  const c = state.favoriteChanges[ch.id];
  return c !== undefined ? c : !!ch.favorite;
}

// ------------------------------------------------------------------ startup

export async function boot() {
  const [settings, info, player, sync] = await Promise.all([call('settings.all'), win('info'), call('player.state'), call('sync.state')]);
  setState({ settings, info, player, sync, fullscreen: info.fullscreen, guideGroup: settings.lastGroup || '__all__' });
  on('player', (p) => setState({ player: p }));
  on('sync', (s) => setState({ sync: s }));
  on('fullscreen', (f) => setState({ fullscreen: f }));
  on('update', (u) => setState({ update: u }));
  call('update.state').then((u) => setState({ update: u }));
  on('shown', (v) => setState({ shown: v }));
  on('settings', ({ key, value }) => setState({ settings: { ...state.settings, [key]: value } }));
  on('player-event', (ev) => {
    if (ev.type === 'tookOver') setState({ tookOver: ev });
    if (ev.type === 'notice') showToast(ev.message);
    if (ev.type === 'error' && ev.everywhere && !isPlayer()) showToast(ev.message, 12000);
  });
  await refreshPlaylists();
  on('changed', (t) => { if (t.includes('playlists')) refreshPlaylists(); });
  setState({ ready: true });
}

export async function refreshPlaylists() {
  const list = await call('playlists.list');
  const patch = { playlists: list };
  if (!list.length) {
    patch.playlistId = 0;
    const cur = current().name;
    if (cur !== 'addPlaylist' && cur !== 'manageGroups') patch.nav = [{ name: 'addPlaylist', firstRun: true }];
  } else {
    const active = list.find((p) => p.id === (state.playlistId || state.settings.activePlaylistId)) || list[0];
    patch.playlistId = active.id;
    if (active.id !== state.settings.activePlaylistId) call('settings.set', 'activePlaylistId', active.id);
  }
  setState(patch);
}
