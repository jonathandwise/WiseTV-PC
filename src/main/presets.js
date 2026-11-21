'use strict';
// Free channel playlists offered on the Add playlist screen.
module.exports = [
  { id: 'iptv-org', name: 'IPTV-org (worldwide)', url: 'https://iptv-org.github.io/iptv/index.m3u', note: 'Thousands of free public channels from around the world. Large: takes a while to load.' },
  { id: 'samsung', name: 'Samsung TV Plus', url: 'https://apsattv.com/ssungusa.m3u', note: 'Free channels from Samsung TV Plus (US)' },
  { id: 'xumo', name: 'XUMO', url: 'https://www.apsattv.com/xumo.m3u', note: 'Free channels from XUMO Play' },
  { id: 'localnow', name: 'Local Now', url: 'https://www.apsattv.com/localnow.m3u', note: 'Local news, weather and free channels' },
  { id: 'lg', name: 'LG Channels', url: 'https://www.apsattv.com/lg.m3u', note: 'May no longer be updated' },
  { id: 'uslg', name: 'LG US Channels', url: 'https://www.apsattv.com/uslg.m3u', note: 'Free channels from LG Channels (US)' },
  { id: 'roku', name: 'Roku Channel', url: 'https://www.apsattv.com/rok.m3u', note: 'Free live channels from The Roku Channel' },
  { id: 'redbox', name: 'Redbox TV', url: 'https://www.apsattv.com/redbox.m3u', note: 'Free channels from Redbox' },
  { id: 'distro', name: 'DistroTV', url: 'https://www.apsattv.com/distro.m3u', note: 'Free international and niche channels' },
  { id: 'xiaomi', name: 'Xiaomi', url: 'https://www.apsattv.com/xiaomi.m3u', note: 'Free channels from Xiaomi TV+' },
  { id: 'tablo', name: 'Tablo', url: 'https://www.apsattv.com/tablo.m3u', note: 'Free channels from Tablo' },
  { id: 'vizio', name: 'Vizio TV', url: 'https://www.apsattv.com/vizio.m3u', note: 'Free channels from Vizio WatchFree+' },
  { id: 'sports', name: 'Sports', url: 'https://www.apsattv.com/sportstv.m3u', note: 'Free sports channels' },
];

// Test hook: a replacement list for automated tests.
if (process.env.WISETV_PRESETS_JSON) module.exports = JSON.parse(require('fs').readFileSync(process.env.WISETV_PRESETS_JSON, 'utf8'));
