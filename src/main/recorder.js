'use strict';
// Records one stream between its start and stop time. Handles both kinds of live stream: a
// continuous MPEG-TS download, and HLS (a playlist of short segments, optionally AES-128
// encrypted). Reconnects with a growing pause if the stream drops.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const http = require('./http');
const hls = require('./hls');
const relay = require('./relay');
const connections = require('./connections');
const storage = require('./storage');
const log = require('./log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Recorder {
  constructor(id, onFinished) {
    this.id = id;
    this.onFinished = onFinished;
    this.stopRequested = false;
    this.stopReason = null;
    this.current = null; // abort function of the request in progress
    this.file = null;
    this.fd = null;
    this.stopAt = 0;
    this.bytes = 0;
    this.drops = 0;
  }

  requestStop(reason) {
    if (!this.stopReason) this.stopReason = reason;
    this.stopRequested = true;
    if (this.current) this.current();
  }

  done() {
    return this.stopRequested || Date.now() >= this.stopAt;
  }

  setStatus(status, error) {
    db.run('UPDATE recordings SET status = ?, error = ? WHERE id = ?', status, error ?? null, this.id);
    db.changed('recordings');
  }

  async run() {
    const rec0 = db.get('SELECT * FROM recordings WHERE id = ?', this.id);
    if (!rec0 || (rec0.status !== 'scheduled' && rec0.status !== 'recording')) return;
    if (Date.now() >= rec0.stop) {
      this.setStatus('failed', 'Missed: the PC was asleep, off or WiseTV wasn\'t running at the start time');
      return;
    }
    this.stopAt = rec0.stop;
    this.file = rec0.filePath && fs.existsSync(rec0.filePath) ? rec0.filePath : null;
    this.dir = this.file ? path.dirname(this.file) : storage.recordingsDir();
    this.fileBase = storage.fileBase(rec0);
    if (storage.freeBytes(this.dir) < storage.MIN_FREE_BYTES) {
      this.setStatus('failed', 'Not enough free space to record');
      return;
    }
    this.bytes = this.file ? fs.statSync(this.file).size : 0;
    const rec = { ...rec0, status: 'recording' };
    db.run('UPDATE recordings SET status = ?, bytes = ?, error = ? WHERE id = ?', 'recording', this.bytes, 'Waiting for a free connection', this.id);
    db.changed('recordings');

    const lease = await connections.acquireRecording(rec, (by) => {
      this.requestStop(`Ended during the extra minutes so “${by.title}” could start`);
    }, () => this.stopRequested);
    if (!lease) {
      await this.finish(this.stopReason || 'There was no free connection while this programme was on');
      return;
    }
    this.setStatus('recording', null);
    log.i(`rec start id=${this.id} title=${rec.title} channel=${rec.channelName}`);

    this.hub = relay.hubFor(this.id);
    const ticker = setInterval(() => {
      db.run('UPDATE recordings SET filePath = ?, bytes = ? WHERE id = ?', this.file, this.bytes, this.id);
      db.changed('recordings');
      if (storage.freeBytes(this.dir) < storage.MIN_FREE_BYTES) this.requestStop('Stopped early: the disk is full');
    }, 3000);
    let lastError = null;
    try {
      lastError = await this.capture(rec);
    } finally {
      clearInterval(ticker);
      if (this.fd != null) { try { fs.closeSync(this.fd); } catch (_) { /* ignore */ } this.fd = null; }
      relay.remove(this.id);
      connections.release(lease);
    }
    let note = this.stopReason;
    if (!note) {
      if (this.bytes === 0 && lastError) note = `Could not record: ${lastError}`;
      else if (this.drops > 0) note = `The stream dropped ${this.drops} time${this.drops === 1 ? '' : 's'} during this recording`;
    }
    await this.finish(note);
  }

  /** Keeps capturing until the stop time. Returns the last connection error, if any. */
  async capture(rec) {
    let lastError = null;
    let failures = 0;
    while (!this.done()) {
      const before = this.bytes;
      try {
        await this.captureOnce(rec);
      } catch (e) {
        if (!this.done()) lastError = e.message || String(e);
      }
      if (this.done()) break;
      if (this.bytes - before > 512 * 1024) {
        failures = 0;
        this.drops++;
      } else {
        failures++;
      }
      log.i(`rec reconnect id=${this.id} failures=${failures} error=${lastError}`);
      await this.pause(Math.min(30000, 2000 * (failures + 1)));
    }
    return lastError;
  }

  async openStream(url, ua) {
    if (this.stopRequested) throw new Error('stopped');
    try {
      const s = await http.stream(url, { userAgent: ua, connectMs: 20000, idleMs: 20000 });
      this.current = () => s.abort();
      if (this.stopRequested) s.abort();
      return s;
    } catch (e) {
      if (e instanceof http.HttpError) throw new Error(`the stream returned HTTP ${e.status}`);
      throw e;
    }
  }

  async captureOnce(rec) {
    const s = await this.openStream(rec.streamUrl, rec.userAgent);
    const ctype = s.response.headers.get('content-type');
    let first = true;
    let playlistText = null;
    try {
      for await (const chunk of s) {
        if (first) {
          first = false;
          if (hls.isPlaylist(chunk.subarray(0, 16), ctype)) {
            playlistText = chunk;
            continue;
          }
        }
        if (playlistText) {
          playlistText = Buffer.concat([playlistText, chunk]);
          if (playlistText.length > 2 * 1024 * 1024) throw new Error('response too large');
          continue;
        }
        this.write('.ts', chunk);
        if (this.done()) break;
      }
    } finally {
      s.abort();
    }
    if (playlistText) await this.captureHls(s.response.url || rec.streamUrl, playlistText.toString('utf8'), rec.userAgent);
  }

  async fetchBuf(url, ua, cap) {
    const s = await this.openStream(url, ua);
    const parts = [];
    let n = 0;
    try {
      for await (const c of s) {
        parts.push(c);
        n += c.length;
        if (n > cap) throw new Error('response too large');
      }
    } finally {
      s.abort();
    }
    return Buffer.concat(parts);
  }

  async captureHls(startUrl, firstText, ua) {
    let url = startUrl;
    let text = firstText;
    let lastSeq = -1;
    let lastProgress = Date.now();
    let mapWritten = null;
    const keys = new Map();
    while (!this.done()) {
      const body = text != null ? text : (await this.fetchBuf(url, ua, 2 * 1024 * 1024)).toString('utf8');
      text = null;
      const pl = hls.parse(body, url);
      if (pl.master) {
        const best = pl.variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
        if (!best) throw new Error('the HLS playlist is empty');
        url = best.url;
        continue;
      }
      const segs = pl.segments;
      if (lastSeq >= 0 && segs.length && segs[segs.length - 1].seq < lastSeq) lastSeq = -1; // playlist restarted
      const fresh = lastSeq >= 0 ? segs.filter((x) => x.seq > lastSeq) : pl.ended ? segs : segs.slice(-3);
      for (const seg of fresh) {
        if (this.done()) return;
        const ext = seg.mapUrl ? '.mp4' : '.ts';
        if (seg.mapUrl && seg.mapUrl !== mapWritten) {
          const init = await this.fetchBuf(seg.mapUrl, ua, 8 * 1024 * 1024);
          this.hub.header = init;
          this.write(ext, init, false);
          mapWritten = seg.mapUrl;
        }
        let data = await this.fetchBuf(seg.url, ua, 96 * 1024 * 1024);
        if (seg.key) {
          if (seg.key.method !== 'AES-128' || !seg.key.uri) throw new Error(`this stream is protected (${seg.key.method}) and can't be recorded`);
          if (!keys.has(seg.key.uri)) keys.set(seg.key.uri, await this.fetchBuf(seg.key.uri, ua, 1024));
          data = hls.decryptAes128(data, keys.get(seg.key.uri), seg.key.iv || hls.sequenceIv(seg.seq));
        }
        this.write(ext, data);
        lastSeq = seg.seq;
        lastProgress = Date.now();
      }
      if (pl.ended) return;
      if (Date.now() - lastProgress > 45000) throw new Error('the stream stopped sending video');
      await this.pause(Math.min(5000, Math.max(1000, pl.targetDuration * 500)));
    }
  }

  write(ext, buf, publish = true) {
    if (this.fd == null) {
      if (!this.file) this.file = path.join(this.dir, this.fileBase + ext);
      this.fd = fs.openSync(this.file, 'a');
    }
    fs.writeSync(this.fd, buf);
    if (publish && this.hub) this.hub.publish(buf);
    this.bytes += buf.length;
  }

  async pause(ms) {
    const end = Date.now() + ms;
    while (!this.done() && Date.now() < end) await sleep(200);
  }

  async finish(note) {
    const cur = db.get('SELECT * FROM recordings WHERE id = ?', this.id);
    if (!cur) return;
    const f = this.file;
    const size = f && fs.existsSync(f) ? fs.statSync(f).size : 0;
    if (size > 0) {
      db.run('UPDATE recordings SET status = ?, filePath = ?, bytes = ?, error = NULL, note = ? WHERE id = ?', 'completed', f, size, note ?? null, this.id);
    } else {
      if (f) { try { fs.unlinkSync(f); } catch (_) { /* ignore */ } }
      db.run('UPDATE recordings SET status = ?, filePath = NULL, bytes = 0, error = ? WHERE id = ?', 'failed', note || 'No video was received from the stream', this.id);
    }
    db.changed('recordings');
    log.i(`rec finish id=${this.id} bytes=${size} file=${f ? path.basename(f) : ''} note=${note}`);
    if (this.onFinished) this.onFinished(cur);
  }
}

module.exports = Recorder;
