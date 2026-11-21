'use strict';
// Streaming M3U / M3U8 (extended) playlist parser.
const readline = require('readline');

const quotedAttr = /([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g;
const bareAttr = /([A-Za-z0-9_-]+)=([^\s",]+)/g;
const videoExt = /\.(mp4|mkv|avi|mov|m4v|wmv|flv)(\?.*)?$/i;

function parseAttrs(s) {
  const m = {};
  for (const x of s.matchAll(quotedAttr)) m[x[1].toLowerCase()] = x[2].trim();
  const rest = s.replace(quotedAttr, ' ');
  for (const x of rest.matchAll(bareAttr)) {
    const k = x[1].toLowerCase();
    if (!(k in m)) m[k] = x[2].trim();
  }
  return m;
}

/** Index of the comma separating attributes from the display name, ignoring commas inside quotes. */
function findNameComma(s) {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) return i;
  }
  return -1;
}

function classify(url) {
  const u = url.toLowerCase();
  if (u.includes('/series/')) return 'series';
  if (u.includes('/movie/')) return 'movie';
  if (videoExt.test(u)) return 'movie';
  return 'live';
}

function extensionOf(url) {
  const last = url.split('?')[0].split('/').pop() || '';
  const i = last.lastIndexOf('.');
  return (i >= 0 ? last.substring(i + 1) : '').toLowerCase() || 'mp4';
}

/** Parses a readable stream. Calls onHeader(epgUrls) and onEntry(entry). */
async function parse(input, onHeader, onEntry) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let name = null;
  let attrs = {};
  let group = null;
  let ua = null;
  let first = true;
  for await (const raw of rl) {
    let line = raw.trim();
    if (first) {
      line = line.replace(/^﻿/, '');
      first = false;
    }
    if (!line) continue;
    const up = line.substring(0, 12).toUpperCase();
    if (up.startsWith('#EXTM3U')) {
      const a = parseAttrs(line.substring(7));
      const urls = [a['url-tvg'], a['x-tvg-url'], a['tvg-url']].filter(Boolean)
        .flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
      if (urls.length) onHeader([...new Set(urls)]);
    } else if (up.startsWith('#EXTINF')) {
      const ci = line.indexOf(':');
      const body = ci >= 0 ? line.substring(ci + 1) : '';
      const comma = findNameComma(body);
      const attrPart = comma >= 0 ? body.substring(0, comma) : body;
      name = comma >= 0 ? body.substring(comma + 1).trim() : '';
      attrs = parseAttrs(attrPart);
      group = attrs['group-title'] || null;
    } else if (up.startsWith('#EXTGRP:')) {
      if (!group || !group.trim()) group = line.substring(8).trim();
    } else if (up.startsWith('#EXTVLCOPT')) {
      const opt = line.substring(line.indexOf(':') + 1);
      if (opt.toLowerCase().startsWith('http-user-agent=')) ua = opt.substring(opt.indexOf('=') + 1).trim();
    } else if (line.startsWith('#')) {
      // ignore
    } else {
      const finalName = (name && name.trim()) || (attrs['tvg-name'] && attrs['tvg-name'].trim()) ||
        line.split('/').pop().split('?')[0];
      const num = parseInt((attrs['tvg-chno'] || attrs['channel-number'] || '').trim(), 10);
      onEntry({
        name: finalName,
        url: line,
        attrs,
        group: (group && group.trim()) || 'Uncategorized',
        userAgent: ua && ua.trim() ? ua.trim() : null,
        tvgId: attrs['tvg-id'] || '',
        logo: attrs['tvg-logo'] && attrs['tvg-logo'].trim() ? attrs['tvg-logo'].trim() : null,
        number: Number.isFinite(num) ? num : null,
      });
      name = null;
      attrs = {};
      group = null;
      ua = null;
    }
  }
}

module.exports = { parse, parseAttrs, findNameComma, classify, extensionOf };
