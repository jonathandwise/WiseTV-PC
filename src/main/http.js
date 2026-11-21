'use strict';
// HTTP helpers on Node's fetch: user agent, timeouts, gzip detection and streaming bodies.
const { Readable, PassThrough } = require('stream');
const zlib = require('zlib');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 WiseTV/1.0';

const ua = (custom) => (custom && custom.trim() ? custom.trim() : DEFAULT_UA);

class HttpError extends Error {
  constructor(status, msg) {
    super(msg || `HTTP ${status}`);
    this.status = status;
  }
}

/**
 * Starts a request and resolves once headers arrive. `connectMs` limits the wait for headers.
 * The returned object has `res` (fetch Response) and `abort()`.
 */
async function open(url, { userAgent, headers = {}, method = 'GET', body, connectMs = 20000, signal } = {}) {
  const ac = new AbortController();
  const onOuter = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onOuter, { once: true });
  }
  const timer = setTimeout(() => ac.abort(new Error('timeout')), connectMs);
  try {
    const res = await fetch(url, {
      method,
      body,
      headers: { 'User-Agent': ua(userAgent), ...headers },
      redirect: 'follow',
      signal: ac.signal,
    });
    return { res, abort: () => ac.abort(), signal: ac.signal };
  } catch (e) {
    if (ac.signal.aborted && !(signal && signal.aborted)) throw new Error('The server did not answer in time.');
    throw friendlyNetError(e);
  } finally {
    clearTimeout(timer);
  }
}

function friendlyNetError(e) {
  const c = e && (e.cause || e);
  const code = c && c.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Error("Couldn't find the server. Check the address.");
  if (code === 'ECONNREFUSED') return new Error('The server refused the connection.');
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return new Error('The connection was interrupted.');
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return new Error('The server did not answer in time.');
  if (e && e.name === 'AbortError') return e;
  return new Error((c && c.message) || (e && e.message) || 'Network error');
}

/** Reads the whole body as text, with an overall timeout. */
async function text(url, opts = {}) {
  const totalMs = opts.totalMs || 90000;
  const { res, abort } = await open(url, opts);
  const t = setTimeout(abort, totalMs);
  try {
    if (!res.ok) throw new HttpError(res.status);
    return await res.text();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw friendlyNetError(e);
  } finally {
    clearTimeout(t);
  }
}

async function json(url, opts = {}) {
  const t = await text(url, opts);
  return JSON.parse(t);
}

/**
 * Opens a streaming body as a Node Readable, transparently gunzipping when the data starts with
 * the gzip magic bytes. An idle timer aborts the request if no data arrives for `idleMs`.
 */
async function stream(url, opts = {}) {
  const idleMs = opts.idleMs || 90000;
  const { res, abort } = await open(url, opts);
  if (!res.ok) {
    try { res.body && res.body.cancel(); } catch (_) { /* ignore */ }
    throw new HttpError(res.status);
  }
  const src = Readable.fromWeb(res.body);
  let idle = setTimeout(() => abort(), idleMs);
  src.on('data', () => {
    clearTimeout(idle);
    idle = setTimeout(() => abort(), idleMs);
  });
  const cleanup = () => clearTimeout(idle);
  src.on('end', cleanup);
  src.on('error', cleanup);
  src.on('close', cleanup);

  // Peek at the first bytes for gzip.
  const out = new PassThrough({ highWaterMark: 1 << 20 });
  let decided = false;
  let gunzip = null;
  src.on('data', (chunk) => {
    if (!decided) {
      decided = true;
      const enc = (res.headers.get('content-encoding') || '').toLowerCase();
      if (chunk.length >= 2 && chunk[0] === 0x1f && chunk[1] === 0x8b && !enc.includes('gzip')) {
        gunzip = zlib.createGunzip();
        gunzip.on('data', (d) => { if (!out.write(d)) src.pause(); });
        gunzip.on('end', () => out.end());
        gunzip.on('error', (e) => out.destroy(e));
        out.on('drain', () => src.resume());
      }
    }
    if (gunzip) gunzip.write(chunk);
    else if (!out.write(chunk)) src.pause();
  });
  out.on('drain', () => src.resume());
  src.on('end', () => (gunzip ? gunzip.end() : out.end()));
  src.on('error', (e) => out.destroy(friendlyNetError(e)));
  out.on('close', () => { if (!src.destroyed) { abort(); src.destroy(); } });
  out.response = res;
  out.abort = () => { abort(); src.destroy(); };
  return out;
}

module.exports = { DEFAULT_UA, ua, open, text, json, stream, HttpError, friendlyNetError };
