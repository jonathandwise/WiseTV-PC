'use strict';
// App preferences, kept as JSON in the user data folder.
const fs = require('fs');
const path = require('path');
const bus = require('./bus');

const DEFAULTS = {
  activePlaylistId: 0,
  lastChannelId: 0,
  lastGroup: '__all__',
  liveFormat: 'ts', // "ts" or "m3u8" for Xtream live streams
  epgDays: 4,
  refreshHours: 12,
  padBefore: 1,
  padAfter: 5,
  connectionLimit: 0, // 0 = use the provider's limit
  invertChannelKeys: false,
  autoplayLast: true,
  resizeMode: 'fit', // fit | zoom | stretch
  recordingRoot: '', // '' = Videos\WiseTV
  audioPassthrough: false,
  hwdec: true,
  volume: 100,
  searchHistory: [],
  closeToTray: true,
  startWithWindows: false,
  overlayMode: '', // '' = automatic; 'transparent' | 'shape'
  plexToken: '',
  plexUser: '',
  plexClientId: '',
  plexServers: [],
  plexRemoteKbps: 8000,
  windowBounds: null,
};

let file = null;
let data = { ...DEFAULTS };
let saveTimer = null;

function load(dir) {
  file = path.join(dir, 'settings.json');
  try {
    data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (_) {
    data = { ...DEFAULTS };
  }
}

function saveNow() {
  if (!file) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

function set(key, value) {
  if (!(key in DEFAULTS)) throw new Error('Unknown setting ' + key);
  data[key] = value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
  bus.emit('settings', key, value);
}

const s = new Proxy({}, {
  get(_, key) {
    if (key === 'load') return load;
    if (key === 'saveNow') return saveNow;
    if (key === 'all') return () => ({ ...data });
    if (key === 'set') return set;
    if (key === 'ALL_GROUP') return '__all__';
    if (key === 'FAV_GROUP') return '__fav__';
    return data[key];
  },
  set(_, key, value) {
    set(key, value);
    return true;
  },
});

module.exports = s;
