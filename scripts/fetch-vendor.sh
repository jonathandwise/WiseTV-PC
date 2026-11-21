#!/usr/bin/env bash
# Downloads what the Windows build bundles but git doesn't hold: the Electron runtime for Windows
# and the mpv player. Puts them in vendor/ (or $WISETV_VENDOR).
set -euo pipefail
cd "$(dirname "$0")/.."
VENDOR="${WISETV_VENDOR:-vendor}"
mkdir -p "$VENDOR"

# Electron: the same version npm installed.
EV=$(node -p "require('./node_modules/electron/package.json').version")
if [ ! -f "$VENDOR/electron-win.zip" ] || [ "$(cat "$VENDOR/electron-version" 2>/dev/null)" != "$EV" ]; then
  echo "Downloading Electron $EV for Windows"
  curl -fsSL -o "$VENDOR/electron-win.zip" "https://github.com/electron/electron/releases/download/v$EV/electron-v$EV-win32-x64.zip"
  echo "$EV" > "$VENDOR/electron-version"
fi

# mpv: pinned build from shinchiro/mpv-winbuild-cmake; if that release is gone, use the newest one.
MPV_TAG="20261111"
MPV_FILE="mpv-x86_64-20261111-git-bcde6b93cc.7z"
if [ ! -f "$VENDOR/mpv-win/mpv.exe" ]; then
  if ! curl -fsSL -o "$VENDOR/mpv-win.7z" "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/$MPV_TAG/$MPV_FILE"; then
    echo "Pinned mpv build not found; using the newest release"
    gh release download -R shinchiro/mpv-winbuild-cmake --pattern 'mpv-x86_64-2*.7z' --output "$VENDOR/mpv-win.7z" --clobber
  fi
  rm -rf "$VENDOR/mpv-win"
  7z x -y -o"$VENDOR/mpv-win" "$VENDOR/mpv-win.7z" > /dev/null
  rm -f "$VENDOR/mpv-win.7z"
fi
ls -la "$VENDOR" "$VENDOR/mpv-win" | head -20
