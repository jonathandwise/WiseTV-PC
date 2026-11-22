'use strict';
// XMLTV guide download and import (streaming; works on guides of any size).
const sax = require('sax');
const { StringDecoder } = require('string_decoder');
const db = require('./db');
const http = require('./http');
const settings = require('./settings');
const log = require('./log');
const { XtreamApi } = require('./xtream');

const HOUR = 3600000;
const DAY = 24 * HOUR;

/** Parses XMLTV times such as "20261025140000 +0000" or "20261025140000". */
function parseTime(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (t.length < 12) return null;
  const n = (a, b) => parseInt(t.substring(a, b), 10);
  const hasSec = t.length >= 14 && /\d/.test(t[12]);
  const year = n(0, 4), month = n(4, 6), day = n(6, 8), hour = n(8, 10), minute = n(10, 12);
  const second = hasSec ? n(12, 14) : 0;
  if ([year, month, day, hour, minute, second].some((x) => !Number.isFinite(x))) return null;
  const rest = t.substring(hasSec ? 14 : 12).trim();
  let offsetMin = 0;
  const m = /^([+-])(\d{2}):?(\d{2})/.exec(rest);
  if (m) offsetMin = (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  return Date.UTC(year, month - 1, day, hour, minute, second) - offsetMin * 60000;
}

/** "0.4.0/1" -> "S1 E5" (xmltv_ns numbers are zero-based). */
function formatXmltvNs(s) {
  const parts = s.split('.');
  if (parts.length < 2) return null;
  const season = parseInt(parts[0].split('/')[0].trim(), 10);
  const ep = parseInt(parts[1].split('/')[0].trim(), 10);
  const S = Number.isFinite(season) ? season + 1 : null;
  const E = Number.isFinite(ep) ? ep + 1 : null;
  if (S != null && E != null) return `S${S} E${E}`;
  if (E != null) return `E${E}`;
  if (S != null) return `S${S}`;
  return null;
}

function normalizeName(s) {
  return s.toLowerCase().replace(/\b(hd|fhd|uhd|4k|sd|hevc|h265)\b/g, '').replace(/[^a-z0-9]/g, '');
}

/**
 * Feeds a readable stream through a lenient XML parser, calling sink.onChannel(id, names) and
 * sink.onProgramme(p). Yields to the event loop regularly so the app stays responsive.
 */
async function parseXmltv(input, sink, shiftMs = 0) {
  const p = sax.parser(false, { lowercase: true, trim: false, normalize: false });
  let chan = null;
  let prog = null;
  let textTarget = null;
  let text = '';
  let epSystem = null;
  let error = null;

  p.onerror = () => {
    // Provider guides are often sloppy XML; carry on.
    p.error = null;
    p.resume();
  };
  p.onopentag = (node) => {
    const a = node.attributes;
    switch (node.name) {
      case 'channel':
        chan = { id: (a.id || '').trim(), names: [] };
        break;
      case 'programme':
        prog = {
          channel: (a.channel || '').trim(),
          start: parseTime(a.start),
          stop: parseTime(a.stop),
          title: null, subTitle: null, desc: null, category: null, epOn: null, epNs: null, icon: null, isNew: false,
        };
        break;
      case 'display-name':
      case 'title':
      case 'sub-title':
      case 'desc':
      case 'category':
        textTarget = node.name;
        text = '';
        break;
      case 'episode-num':
        textTarget = node.name;
        epSystem = a.system || null;
        text = '';
        break;
      case 'icon':
        if (prog && !prog.icon && a.src) prog.icon = a.src;
        break;
      case 'new':
        if (prog) prog.isNew = true;
        break;
      default:
        break;
    }
  };
  p.ontext = (t) => { if (textTarget) text += t; };
  p.oncdata = (t) => { if (textTarget) text += t; };
  p.onclosetag = (name) => {
    if (textTarget && name === textTarget) {
      const t = text.trim();
      if (t) {
        if (name === 'display-name' && chan) chan.names.push(t);
        else if (prog) {
          if (name === 'title' && !prog.title) prog.title = t;
          else if (name === 'sub-title' && !prog.subTitle) prog.subTitle = t;
          else if (name === 'desc' && !prog.desc) prog.desc = t;
          else if (name === 'category' && !prog.category) prog.category = t;
          else if (name === 'episode-num') {
            if (epSystem === 'xmltv_ns') prog.epNs = t;
            else if (epSystem === 'onscreen' || !prog.epOn) prog.epOn = t;
          }
        }
      }
      textTarget = null;
      text = '';
      return;
    }
    if (name === 'channel' && chan) {
      if (chan.id) sink.onChannel(chan.id, chan.names);
      chan = null;
    } else if (name === 'programme' && prog) {
      const x = prog;
      prog = null;
      if (!x.channel || x.start == null) return;
      const stop = x.stop != null && x.stop > x.start ? x.stop : x.start + 30 * 60000;
      try {
        sink.onProgramme({
          channel: x.channel,
          start: x.start + shiftMs,
          stop: stop + shiftMs,
          title: x.title || 'No title',
          subTitle: x.subTitle,
          desc: x.desc,
          category: x.category,
          episode: x.epOn || (x.epNs ? formatXmltvNs(x.epNs) : null),
          icon: x.icon,
          isNew: x.isNew,
        });
      } catch (e) {
        error = e;
      }
    }
  };

  const dec = new StringDecoder('utf8');
  let n = 0;
  for await (const chunk of input) {
    p.write(dec.write(chunk));
    if (error) throw error;
    if (++n % 8 === 0) await new Promise((r) => setImmediate(r));
  }
  p.write(dec.end());
  p.close();
  if (error) throw error;
}

function urlsFor(pl) {
  const urls = [];
  const addAll = (t) => String(t || '').split(/[\n, \t]+/).map((x) => x.trim()).filter((x) => /^http/i.test(x)).forEach((x) => urls.push(x));
  addAll(pl.epgUrl);
  if (pl.type === 'xtream') urls.push(new XtreamApi(pl.url, pl.username, pl.password, pl.userAgent).epgUrl());
  else addAll(pl.m3uEpgUrl);
  return trimSources([...new Set(urls)]);
}

/**
 * epgshare01's "ALL_SOURCES" file already contains every one of its per-country files, so when a
 * playlist lists both (Free-TV lists about 100), only the combined one is downloaded.
 */
function trimSources(urls) {
  const isShare = (u) => /epgshare01\.online\//i.test(u);
  const all = urls.filter((u) => isShare(u) && /ALL_SOURCES/i.test(u));
  if (!all.length) return urls;
  return urls.filter((u) => !isShare(u) || all.includes(u));
}

const visibleChannelsSql = `SELECT * FROM channels WHERE playlistId = ? AND hidden = 0
  AND groupName NOT IN (SELECT categoryId FROM channel_groups WHERE playlistId = ? AND kind = 'live' AND hidden = 1)
  ORDER BY sortIndex`;

/**
 * Downloads every guide source for the playlist and swaps in the new programmes atomically
 * (by generation number) so the guide never shows up empty while updating.
 */
async function importEpg(pl, progress) {
  const urls = urlsFor(pl);
  if (!urls.length) return 0;
  const channels = db.all(visibleChannelsSql, pl.id, pl.id);
  const wanted = new Set();
  const byName = new Map();
  for (const c of channels) {
    if (c.epgId) wanted.add(c.epgId);
    else {
      const k = normalizeName(c.name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(c.id);
    }
  }
  if (!wanted.size && !byName.size) return 0;

  const gen = Date.now();
  const now = gen;
  const from = now - 2 * HOUR;
  const to = now + Math.min(14, Math.max(1, settings.epgDays)) * DAY;
  const filledBefore = new Set();
  let count = 0;
  let anySuccess = false;
  let lastError = null;

  for (let i = 0; i < urls.length; i++) {
    progress(urls.length > 1 ? `Downloading TV guide ${i + 1} of ${urls.length}…` : 'Downloading TV guide…');
    const filledNow = new Set();
    let fromThisSource = 0;
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      db.insertMany('programs', batch);
      count += batch.length;
      batch = [];
      if (count % 25000 < 1000) progress(`Loading TV guide… ${Math.floor(count / 1000)}k programmes`);
    };
    try {
      const input = await http.stream(urls[i], { userAgent: pl.userAgent, connectMs: 30000, idleMs: 60000 });
      try {
        await parseXmltv(input, {
          onChannel(id, names) {
            const key = id.toLowerCase();
            if (wanted.has(key) || !byName.size) return;
            const ids = [];
            for (const n of names) {
              const k = normalizeName(n);
              const got = byName.get(k);
              if (got) { ids.push(...got); byName.delete(k); }
            }
            if (ids.length) {
              db.run(`UPDATE channels SET epgId = ? WHERE id IN (${ids.map(() => '?').join(',')})`, key, ...ids);
              wanted.add(key);
            }
          },
          onProgramme(p) {
            const key = p.channel.toLowerCase();
            if (!wanted.has(key) || filledBefore.has(key)) return;
            if (p.stop <= from || p.start >= to) return;
            filledNow.add(key);
            batch.push({
              playlistId: pl.id,
              gen,
              epgKey: key,
              start: p.start,
              stop: p.stop,
              title: p.title.substring(0, 200),
              subtitle: p.subTitle ? p.subTitle.substring(0, 200) : null,
              description: p.desc ? p.desc.substring(0, 600) : null,
              category: p.category ? p.category.substring(0, 60) : null,
              episode: p.episode ? p.episode.substring(0, 30) : null,
              icon: p.icon || null,
              isNew: p.isNew ? 1 : 0,
            });
            fromThisSource++;
            if (batch.length >= 1000) flush();
          },
        }, (pl.epgShiftMinutes || 0) * 60000);
      } catch (e) {
        // A guide that breaks part-way through is still useful: keep what was read.
        if (fromThisSource === 0) throw e;
        log.i(`epg partial source=${i + 1} programmes=${fromThisSource} error=${e.message}`);
      } finally {
        input.destroy();
      }
      flush();
      anySuccess = true;
    } catch (e) {
      lastError = e;
      log.i(`epg source ${i + 1} failed: ${e.message}`);
    }
    for (const k of filledNow) filledBefore.add(k);
  }

  if (!anySuccess) {
    db.run('DELETE FROM programs WHERE playlistId = ? AND gen = ?', pl.id, gen);
    const e = lastError || new Error('Guide download failed');
    if (e instanceof http.HttpError) throw new Error(`Guide download failed (HTTP ${e.status})`);
    throw e;
  }
  log.i(`epg done playlist=${pl.id} programmes=${count}`);
  db.run('UPDATE playlists SET epgGen = ?, lastEpgSync = ? WHERE id = ?', gen, now, pl.id);
  db.run('DELETE FROM programs WHERE playlistId = ? AND gen <> ?', pl.id, gen);
  db.changed('playlists', 'programs', 'channels');
  return count;
}

module.exports = { importEpg, parseXmltv, parseTime, formatXmltvNs, normalizeName, urlsFor, visibleChannelsSql };
