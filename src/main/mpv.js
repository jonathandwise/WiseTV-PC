'use strict';
// Runs the bundled mpv player embedded in the video window and talks to it over JSON IPC.
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const log = require('./log');

class Mpv extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.reqId = 0;
    this.pending = new Map();
    this.buf = '';
    this.ready = false;
    this.observed = [];
    this.wantRunning = false;
  }

  exePath() {
    if (process.env.WISETV_MPV) return process.env.WISETV_MPV;
    const name = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
    const candidates = [
      process.resourcesPath && path.join(process.resourcesPath, 'mpv', name),
      path.join(__dirname, '..', '..', 'vendor', 'mpv', name),
    ].filter(Boolean);
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return name; // on PATH (development on Linux)
  }

  ipcPath() {
    return process.platform === 'win32' ? `\\\\.\\pipe\\wisetv-mpv-${process.pid}` : path.join(require('os').tmpdir(), `wisetv-mpv-${process.pid}.sock`);
  }

  /** Starts mpv drawing into the native window `wid`. */
  async start(wid, opts) {
    this.wantRunning = true;
    this.wid = wid;
    this.opts = opts;
    const ipc = this.ipcPath();
    if (process.platform !== 'win32') { try { fs.unlinkSync(ipc); } catch (_) { /* ignore */ } }
    const args = [
      `--wid=${wid}`,
      '--no-config',
      '--idle=yes',
      '--force-window=yes',
      `--input-ipc-server=${ipc}`,
      '--keep-open=no',
      '--osc=no',
      '--osd-level=0',
      '--input-default-bindings=no',
      '--input-vo-keyboard=no',
      '--input-cursor=yes',
      '--cursor-autohide=no',
      '--no-input-terminal',
      '--terminal=no',
      '--ytdl=no',
      `--hwdec=${opts.hwdec ? 'auto-safe' : 'no'}`,
      '--cache=yes',
      '--demuxer-max-bytes=64MiB',
      '--demuxer-max-back-bytes=48MiB',
      '--network-timeout=20',
      `--volume=${opts.volume}`,
      '--volume-max=150',
      '--sub-auto=no',
      '--audio-file-auto=no',
      '--screenshot-directory=~~desktop/',
    ];
    if (opts.passthrough) args.push('--audio-spdif=ac3,eac3,dts');
    if (opts.logFile) args.push(`--log-file=${opts.logFile}`);
    if (opts.inputConf) {
      // Mouse over the picture reaches mpv's window, not the interface: pass it on.
      fs.writeFileSync(opts.inputConf, [
        'MBTN_LEFT script-message wt-mouse click',
        'MBTN_LEFT_DBL script-message wt-mouse dblclick',
        'MBTN_RIGHT script-message wt-mouse context',
        'WHEEL_UP script-message wt-mouse wheel -1',
        'WHEEL_DOWN script-message wt-mouse wheel 1',
        'MOUSE_MOVE script-message wt-mouse move',
        'MBTN_BACK script-message wt-mouse back',
        '',
      ].join('\n'));
      args.push(`--input-conf=${opts.inputConf}`);
    }
    if (process.env.WISETV_MPV_ARGS) args.push(...process.env.WISETV_MPV_ARGS.split(' ').filter(Boolean));
    const exe = this.exePath();
    log.i(`mpv start ${exe}`);
    this.proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
    this.proc.on('error', (e) => log.i(`mpv spawn error ${e.message}`));
    this.proc.on('exit', (code) => {
      log.i(`mpv exited code=${code}`);
      this.ready = false;
      this.proc = null;
      for (const p of this.pending.values()) p.reject(new Error('mpv exited'));
      this.pending.clear();
      if (this.sock) this.sock.destroy();
      this.sock = null;
      this.emit('exit');
      if (this.wantRunning) setTimeout(() => this.start(this.wid, this.opts).catch(() => {}), 1000);
    });
    await this.connect(ipc);
    this.ready = true;
    for (const name of this.observed) this.send(['observe_property', 0, name]).catch(() => {});
    this.emit('ready');
  }

  async connect(ipc) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      try {
        await new Promise((resolve, reject) => {
          const s = net.connect(ipc);
          s.once('connect', () => {
            this.sock = s;
            s.setEncoding('utf8');
            s.on('data', (d) => this.onData(d));
            s.on('error', () => {});
            s.on('close', () => { if (this.sock === s) this.sock = null; });
            resolve();
          });
          s.once('error', reject);
        });
        return;
      } catch (_) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('mpv did not start');
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.substring(0, i);
      this.buf = this.buf.substring(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
        const p = this.pending.get(msg.request_id);
        this.pending.delete(msg.request_id);
        if (msg.error && msg.error !== 'success') p.reject(new Error(msg.error));
        else p.resolve(msg.data);
      } else if (msg.event === 'property-change') {
        this.emit('property', msg.name, msg.data);
      } else if (msg.event) {
        this.emit('event', msg);
      }
    }
  }

  send(command) {
    if (!this.sock) return Promise.reject(new Error('mpv is not running'));
    const id = ++this.reqId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(JSON.stringify({ command, request_id: id }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('mpv timeout'));
        }
      }, 10000);
    });
  }

  command(...args) { return this.send(args); }
  set(name, value) { return this.send(['set_property', name, value]); }
  get(name) { return this.send(['get_property', name]); }

  observe(name) {
    this.observed.push(name);
    if (this.ready) this.send(['observe_property', 0, name]).catch(() => {});
  }

  quit() {
    this.wantRunning = false;
    if (this.sock) this.send(['quit']).catch(() => {});
    const p = this.proc;
    setTimeout(() => { if (p && !p.killed) try { p.kill(); } catch (_) { /* ignore */ } }, 1500);
  }
}

module.exports = Mpv;
