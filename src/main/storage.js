'use strict';
// Where recordings go and how much room is left.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const settings = require('./settings');

const MIN_FREE_BYTES = 1024 * 1024 * 1024; // recordings refuse to start, and stop, below 1 GB free
const HD_BYTES_PER_HOUR = 2500 * 1024 * 1024; // rough size of one hour of HD video

function defaultDir() {
  return path.join(app.getPath('videos'), 'WiseTV');
}

function recordingsDir() {
  const dir = settings.recordingRoot || defaultDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  return dir;
}

function freeBytes(dir = recordingsDir()) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch (_) {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** File name without extension; the recorder adds .ts or .mp4 once it knows the stream format. */
function fileBase(rec) {
  const d = new Date(rec.programStart);
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  const safe = rec.title.replace(/[^A-Za-z0-9 _.-]/g, '').trim().substring(0, 60).trim() || 'Recording';
  return `${ts}_${safe}_${rec.id}`;
}

module.exports = { MIN_FREE_BYTES, HD_BYTES_PER_HOUR, defaultDir, recordingsDir, freeBytes, fileBase };
