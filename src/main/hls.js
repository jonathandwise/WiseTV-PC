'use strict';
// Just enough HLS to record a live stream: playlist parsing and AES-128 segment decryption.
const crypto = require('crypto');

function isPlaylist(head, contentType) {
  if (contentType && /mpegurl/i.test(contentType)) return true;
  let i = 0;
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x0a || head[i] === 0x0d)) i++;
  return head.subarray(i, i + 7).toString('latin1') === '#EXTM3U';
}

function attr(line, name) {
  const re = new RegExp('(?:^|[:,])' + name.replace(/[-]/g, '\\-') + '=("([^"]*)"|[^,]*)');
  const m = re.exec(line);
  if (!m) return null;
  return m[2] !== undefined ? m[2] : m[1];
}

function resolve(base, ref) {
  const r = ref.trim();
  try { return new URL(r, base).toString(); } catch (_) { return r; }
}

function hex(s) {
  const h = s.trim().replace(/^0x/i, '').padStart(32, '0');
  if (h.length !== 32 || !/^[0-9a-f]+$/i.test(h)) return null;
  return Buffer.from(h, 'hex');
}

function parse(text, baseUrl) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    let bandwidth = 0;
    let pending = false;
    for (const l of lines) {
      if (l.startsWith('#EXT-X-STREAM-INF')) {
        bandwidth = parseInt(attr(l, 'BANDWIDTH'), 10) || 0;
        pending = true;
      } else if (!l.startsWith('#') && pending) {
        variants.push({ url: resolve(baseUrl, l), bandwidth });
        pending = false;
      }
    }
    return { master: true, variants };
  }
  let seq = 0;
  let target = 6;
  let duration = 0;
  let key = null;
  let map = null;
  let ended = false;
  const segments = [];
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(l.substring(22), 10) || 0;
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) target = parseFloat(l.substring(22)) || 6;
    else if (l.startsWith('#EXTINF:')) duration = parseFloat(l.substring(8).split(',')[0]) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const method = attr(l, 'METHOD') || 'NONE';
      key = method === 'NONE' ? null : { method, uri: attr(l, 'URI') ? resolve(baseUrl, attr(l, 'URI')) : null, iv: attr(l, 'IV') ? hex(attr(l, 'IV')) : null };
    } else if (l.startsWith('#EXT-X-MAP:')) map = attr(l, 'URI') ? resolve(baseUrl, attr(l, 'URI')) : null;
    else if (l.startsWith('#EXT-X-ENDLIST')) ended = true;
    else if (l.startsWith('#')) continue;
    else {
      segments.push({ seq, url: resolve(baseUrl, l), duration, key, mapUrl: map });
      seq++;
      duration = 0;
    }
  }
  return { master: false, targetDuration: target, segments, ended };
}

/** Default IV when the playlist gives none: the segment's sequence number, big-endian. */
function sequenceIv(seq) {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(seq), 8);
  return iv;
}

function decryptAes128(data, key, iv) {
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([d.update(data), d.final()]);
}

module.exports = { isPlaylist, parse, attr, resolve, hex, sequenceIv, decryptAes128 };
