# WiseTV for Windows

A Windows version of the WiseTV Fire TV app (Electron + the bundled mpv player).

## Install

Download `WiseTV-Setup-<version>.exe` from the latest [release](https://github.com/jonathandwise/WiseTV-PC/releases/latest)
and run it. After that, WiseTV checks for new versions by itself and offers to update.

## Releasing a new version

Bump `version` in `package.json`, add a section to `CHANGELOG.md`, commit, then tag and push:

    git tag v1.2.0 && git push && git push --tags

GitHub Actions ("Build and release") builds the installer and publishes the release.

## Build locally

Needs Node.js 22+, `zip`, `makensis` and `7z`.

    npm install
    bash scripts/fetch-vendor.sh   # Electron for Windows + mpv into vendor/
    npm start                      # run from source (needs mpv on PATH outside Windows)
    node package-win.js            # build/WiseTV-Setup-<version>.exe and a portable zip

## Layout

- `src/main/` – main process: database (node:sqlite), Xtream/M3U/XMLTV import, Plex, recordings
  (recorder, series rules, scheduler, local relay), mpv control and playback, IPC (`api.js`), windows (`main.js`).
- `src/renderer/` – the interface (Preact), bundled by `build.js` into `dist/`.
- Video: mpv draws into the main window; the interface is a second window on top of it. In the default
  ("transparent") mode the interface lets the picture show through; "shape" mode clips the interface window instead
  (Settings → Video drawing → Compatibility).

User data: `%APPDATA%\WiseTV` (settings.json, wisetv.db, wisetv.log, mpv.log). Recordings: `Videos\WiseTV`.
