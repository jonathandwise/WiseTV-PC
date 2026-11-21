'use strict';
// Tracks how many provider connections are in use (player + recordings) so we never exceed the
// provider's limit. Recordings always win over the player.
const db = require('./db');
const settings = require('./settings');
const bus = require('./bus');

let counter = 0;
let leases = [];

function providerLimit(playlistId) {
  const p = db.get('SELECT maxConnections FROM playlists WHERE id = ?', playlistId);
  return p ? Math.max(1, p.maxConnections) : 1;
}

function maxFor(playlistId) {
  const o = settings.connectionLimit;
  return o > 0 ? o : providerLimit(playlistId);
}

const recordingLeases = (pid) => leases.filter((l) => l.playlistId === pid && l.kind === 'recording');
const activeRecordingFor = (pid, url) => recordingLeases(pid).find((l) => l.url === url) || null;
const isRecording = (recordingId) => leases.some((l) => l.recordingId === recordingId);

function setLeases(list) {
  leases = list;
  bus.emit('leases');
}

function tryAcquirePlayer(playlistId, url, label, onPreempt) {
  const others = leases.filter((l) => l.kind !== 'player');
  const used = others.filter((l) => l.playlistId === playlistId).length;
  if (used >= maxFor(playlistId)) return null;
  const l = { id: ++counter, playlistId, kind: 'player', url, label, recordingId: null, programStop: Infinity, onPreempt };
  setLeases([...others, l]);
  return l;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until a connection is free for `rec`. Stops the player, or a recording that is only in its
 * end-padding, if needed. Returns null if no connection became free before the recording window ended.
 */
async function acquireRecording(rec, onPreempt, isCancelled = () => false) {
  const max = maxFor(rec.playlistId);
  while (Date.now() < rec.stop && !isCancelled()) {
    const used = leases.filter((l) => l.playlistId === rec.playlistId);
    if (used.length < max) {
      const l = {
        id: ++counter, playlistId: rec.playlistId, kind: 'recording', url: rec.streamUrl,
        label: `“${rec.title}” on ${rec.channelName}`, recordingId: rec.id, programStop: rec.programStop, onPreempt,
      };
      setLeases([...leases, l]);
      return l;
    }
    const now = Date.now();
    const toPreempt = used.find((l) => l.kind === 'player') ||
      used.filter((l) => l.kind === 'recording' && l.programStop <= now).sort((a, b) => a.programStop - b.programStop)[0];
    if (toPreempt && toPreempt.onPreempt) toPreempt.onPreempt(rec);
    await sleep(toPreempt ? 1500 : 5000);
  }
  return null;
}

function release(lease) {
  if (!lease) return;
  setLeases(leases.filter((l) => l.id !== lease.id));
}

async function awaitRecordingReleased(recordingId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (isRecording(recordingId) && Date.now() < end) await sleep(200);
  await sleep(500); // give the provider a moment to notice the closed connection
}

module.exports = {
  providerLimit, maxFor, recordingLeases, activeRecordingFor, isRecording, tryAcquirePlayer, acquireRecording, release,
  awaitRecordingReleased, get leases() { return leases; },
};
