# WiseTV for Windows

Windows version of the WiseTV Fire TV app (the Fire TV app lives in the private repo `jonathandwise/wisetv`).
Electron app with mpv (bundled) as the video engine. Owner: Jonathan. He installs it from GitHub releases;
installed copies update themselves from the latest release of this repo.

## Releasing an update (every change the user should get)
1. Make the change; run `npm run build` and test (see Testing).
2. Bump `version` in `package.json` (semver; patch for fixes, minor for features).
3. Add a `## <version>` section at the top of `CHANGELOG.md`: short, plain-language bullets. This text is shown to
   the user in the app's update dialog.
4. Commit and push to `main`. The "Build and release" workflow sees a version with no release yet, builds
   `WiseTV-Setup-<version>.exe` and publishes release `v<version>` (creating the tag). No tag push is needed
   (tag pushes are refused from Claude sessions anyway). Check the run with `gh run list -R jonathandwise/WiseTV-PC`.
5. Running copies find it at their next start (or within 6 hours), offer "Update now", download the installer and run
   it with `/S`; the installer closes WiseTV, updates it in place and starts it again.

Never delete or re-use a published version: apps compare version numbers, so a re-used one would not reach them.

## Layout
- `src/main/` – main process. `main.js` (windows, tray, IPC), `api.js` (every call the UI makes), `db.js`
  (node:sqlite), `playlists.js`/`xtream.js`/`m3u.js`/`epg.js`/`sync.js` (playlist + guide import), `presets.js`
  (free playlists), `plex.js`, `recordings.js`/`recorder.js`/`hls.js`/`relay.js`/`connections.js` (recording and the
  provider connection limit), `mpv.js`/`playback.js` (player), `updater.js` (GitHub update check).
- `src/renderer/` – interface (Preact, bundled by `build.js` to `dist/`). `guide.jsx`, `player.jsx`, `vod.jsx`,
  `recordings.jsx`, `search.jsx`, `settings.jsx`, `dialogs.jsx`, `app.jsx` (shell), `store.js` (state/actions).
- Video: mpv draws into the main (framed) window; the interface is a frameless child window on top. "transparent"
  mode lets the picture show through; "shape" mode (Settings → Video drawing → Compatibility) clips the window.
- `package-win.js` + `installer.nsi` – Windows build (runs on Linux: needs `zip`, `makensis`, `7z`).
  `scripts/fetch-vendor.sh` downloads Electron for Windows and mpv into `vendor/`.

## Testing (Linux)
`npm start` needs mpv on PATH (`apt-get install mpv`) and a display (Xvfb). Useful environment variables:
`WISETV_USER_DATA` (separate profile), `WISETV_MPV_ARGS="--vo=x11 --ao=null"`, `WISETV_OVERLAY=shape`,
`WISETV_PLEX_TV` (mock plex.tv), `WISETV_UPDATE_URL` (fake release JSON), `WISETV_PRESETS_JSON` (test presets),
`WISETV_DEBUG=1`. The Fire TV repo's `ci/mock_server.py` + `ci/make_media.sh` provide a mock Xtream/Plex server.

User data on Windows: `%APPDATA%\WiseTV` (settings.json, wisetv.db, wisetv.log, mpv.log). Recordings: `Videos\WiseTV`.
