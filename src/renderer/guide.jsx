// The TV guide: programme info and live preview on top, channel groups and the programme grid below.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { call, useQuery, useNow, Fmt, MIN, HOUR, DAY, floor30 } from './lib';
import { useStore, setState, getState, tune, nav, toggleFavorite, isFavorite, setSetting, setActivePlaylist } from './store';
import { useKeys } from './keys';
import { useVideoHole } from './video';
import { CenterMessage, ProgressLine, RecDot, Img, Btn, Icon, VolumeControl } from './components';

const PX_PER_MIN = 5;
const ROW_H = 46;
const CHANNEL_W = 220;
const MAX_CACHED = 600;

// Guide position survives going to the player and back.
const G = {
  row: 0,
  focusTime: Date.now(),
  windowStart: floor30(Date.now()),
  programs: new Map(),
  gen: 0,
  pid: 0,
  pendingFocusId: null,
};

function programsOf(ch) {
  return (ch && ch.epgId && G.programs.get(ch.epgId)) || null;
}
export function programAt(ch, t) {
  const list = programsOf(ch);
  return list ? list.find((p) => p.start <= t && p.stop > t) || null : null;
}

/** Loads programmes for channels not cached yet, in batches. */
const loading = new Set();
let loadTimer = null;
let wantKeys = new Set();
const loadedListeners = new Set();
const onLoaded = () => { for (const l of loadedListeners) l(); };
function ensureLoaded(chs) {
  for (const c of chs) if (c.epgId && !G.programs.has(c.epgId) && !loading.has(c.epgId)) wantKeys.add(c.epgId);
  if (!wantKeys.size) return;
  clearTimeout(loadTimer);
  loadTimer = setTimeout(async () => {
    const keys = [...wantKeys];
    wantKeys = new Set();
    keys.forEach((k) => loading.add(k));
    const pid = G.pid;
    const gen = G.gen;
    const now = Date.now();
    try {
      const res = await call('guide.programs', pid, keys, now - 3 * HOUR, now + 15 * DAY);
      if (pid !== G.pid || gen !== G.gen) return;
      for (const k of keys) G.programs.set(k, res[k] || []);
      while (G.programs.size > MAX_CACHED) G.programs.delete(G.programs.keys().next().value);
    } finally {
      keys.forEach((k) => loading.delete(k));
    }
    onLoaded();
  }, 40);
}

export function useGuideChannels() {
  const pid = useStore((s) => s.playlistId);
  const group = useStore((s) => s.guideGroup);
  return useQuery(() => (pid ? call('guide.channels', pid, group) : []), [pid, group], ['channels', 'channel_groups']);
}

/** Programme data shared by the guide, player banner and channel list. */
export function useProgramCache(channels) {
  const pid = useStore((s) => s.playlistId);
  const playlists = useStore((s) => s.playlists);
  const gen = (playlists || []).find((p) => p.id === pid)?.epgGen || 0;
  const [, setTick] = useState(0);
  if (pid !== G.pid || gen !== G.gen) {
    if (pid !== G.pid) { G.row = 0; }
    G.pid = pid;
    G.gen = gen;
    G.programs = new Map();
  }
  useEffect(() => {
    const me = () => setTick((x) => x + 1);
    loadedListeners.add(me);
    return () => loadedListeners.delete(me);
  }, []);
  useEffect(() => { if (channels) ensureLoaded(channels); });
  return { programsOf, programAt };
}

export function useRecordState() {
  const pid = useStore((s) => s.playlistId);
  const q = useQuery(() => call('guide.recordState', pid), [pid], ['recordings']);
  return useMemo(() => ({
    recordKeys: new Set(q.data ? q.data.recordKeys : []),
    recordingNowUrls: new Set(q.data ? q.data.recordingNowUrls : []),
  }), [q.data]);
}

export function groupTitle(id, groups) {
  if (id === '__all__') return 'All channels';
  if (id === '__fav__') return 'Favorites';
  return (groups || []).find((g) => g.categoryId === id)?.name || id;
}

/** "Group" or, with several playlists, "Playlist · Group". */
function guideTitle(group, groups) {
  const st = getState();
  const list = st.playlists || [];
  const g = groupTitle(group, groups);
  if (list.length < 2) return g;
  const pl = list.find((p) => p.id === st.playlistId);
  return pl ? `${pl.name} · ${g}` : g;
}

function selectGroup(id) {
  if (id === getState().guideGroup) return;
  setState({ guideGroup: id });
  setSetting('lastGroup', id);
  G.row = 0;
}

export function GuideScreen() {
  const pid = useStore((s) => s.playlistId);
  const group = useStore((s) => s.guideGroup);
  const player = useStore((s) => s.player);
  const programMenu = useStore((s) => !!s.programMenu);
  const chQ = useGuideChannels();
  const channels = chQ.data || [];
  const groupsQ = useQuery(() => (pid ? call('guide.groups', pid) : []), [pid], ['channel_groups']);
  const rec = useRecordState();
  useProgramCache(null);
  const [, force] = useState(0);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const now = useNow(20000);
  const playingId = player.nowPlaying && player.nowPlaying.type === 'live' ? player.nowPlaying.channel.id : null;

  // Opening the guide always starts at what's on now, on the channel playing.
  useEffect(() => {
    G.focusTime = Date.now();
    G.windowStart = floor30(Date.now());
    if (playingId) G.pendingFocusId = playingId;
  }, []);

  // Keep the selection on the same channel when the list changes.
  const prevList = useRef(null);
  if (chQ.data && chQ.data !== prevList.current) {
    const old = prevList.current;
    const selId = old && old[G.row] ? old[G.row].id : null;
    const want = G.pendingFocusId != null ? G.pendingFocusId : selId;
    const idx = want != null ? channels.findIndex((c) => c.id === want) : -1;
    if (idx >= 0) { G.row = idx; G.pendingFocusId = null; }
    else if (G.row >= channels.length) G.row = Math.max(0, channels.length - 1);
    prevList.current = chQ.data;
  }

  // Time moves on while the guide stays open.
  if (G.focusTime < now) G.focusTime = now;
  if (G.windowStart < floor30(now)) G.windowStart = floor30(now);

  const refresh = () => force((x) => x + 1);
  const selected = channels[G.row] || null;
  const selProgram = programAt(selected, G.focusTime);

  return (
    <div class="guide">
      <div class="guide-top">
        <GuideInfo channel={selected} program={selProgram} count={channels.length} title={guideTitle(group, groupsQ.data)} rec={rec} now={now} onGroups={() => setGroupsOpen(true)} />
        <Preview player={player} />
      </div>
      <div class="guide-bottom">
        {groupsOpen ? (
          <GroupsPanel
            groups={groupsQ.data || []}
            current={group}
            onPick={(id) => { selectGroup(id); G.focusTime = Date.now(); G.windowStart = floor30(Date.now()); setGroupsOpen(false); }}
            onPlaylist={(id) => { setGroupsOpen(false); if (id !== pid) { call('player.stop'); setActivePlaylist(id); } }}
            onClose={() => setGroupsOpen(false)}
          />
        ) : null}
        {channels.length === 0 ? (
          <div class="grow rel">
            {chQ.data ? (
              <CenterMessage
                title={group === '__fav__' ? 'No favorite channels yet' : 'No channels to show'}
                subtitle={group === '__fav__' ? 'Right-click a channel in the guide (or press M) and choose Add to favorites.' : 'Pick another group, or check Settings → Channel groups.'}
              >
                <Btn onClick={() => setGroupsOpen(true)} autoFocus>Channel groups</Btn>
              </CenterMessage>
            ) : <CenterMessage title="Loading…" />}
          </div>
        ) : (
          <EpgGrid
            channels={channels}
            playingId={playingId}
            rec={rec}
            now={now}
            active={!groupsOpen && !programMenu}
            onChange={refresh}
            onExitLeft={() => setGroupsOpen(true)}
          />
        )}
      </div>
    </div>
  );
}

function GuideInfo({ channel, program: p, count, title, rec, now, onGroups }) {
  const sync = useStore((s) => s.sync);
  const line = sync.error || sync.status;
  return (
    <div class="guide-info">
      <div class="row gap8 center-v">
        <button class="group-chip" data-nav onClick={onGroups} title="Choose a channel group">{title.toUpperCase()} ▾</button>
        <span class="muted small">{count} channels · Right-click for options · Space: favorite · Enter twice: full screen</span>
      </div>
      {channel ? <div class="muted ell mt6">{channel.number}&nbsp;&nbsp;{channel.name}</div> : null}
      <div class="info-title ell">{p ? p.title : channel ? channel.name : ''}</div>
      {p ? (
        <>
          <div class="row center-v gap6 muted ell">
            {rec.recordKeys.has(`${p.epgKey}@${p.start}`) ? <RecDot /> : null}
            <span class="ell">
              {Fmt.day(p.start) !== 'Today' ? `${Fmt.day(p.start)}  ·  ` : ''}{Fmt.range(p.start, p.stop)}  ·  {Fmt.duration(p.stop - p.start)}
              {[p.episode, p.subtitle].filter(Boolean).length ? `  ·  ${[p.episode, p.subtitle].filter(Boolean).join(' · ')}` : ''}
            </span>
          </div>
          {p.start <= now && p.stop > now ? <ProgressLine value={(now - p.start) / (p.stop - p.start)} style={{ width: 220, marginTop: 6 }} /> : null}
          <div class="desc clamp3 mt6">{p.description || ''}</div>
        </>
      ) : null}
      <div class="grow" />
      {line ? <div class={`small ell ${sync.error ? 'warn' : 'muted'}`}>{line}</div> : null}
    </div>
  );
}

function Preview({ player }) {
  const live = player.nowPlaying && player.nowPlaying.type === 'live' ? player.nowPlaying : null;
  const ref = useVideoHole(true);
  // Controls appear while the pointer is over the preview (or one of its buttons).
  const [hover, setHover] = useState(false);
  const timer = useRef(null);
  const poke = () => {
    setHover(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(false), 2500);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const openPlayer = () => { if (live) nav.push({ name: 'player' }); };
  return (
    <div
      ref={ref}
      class="preview"
      onMouseMove={poke}
      onMouseLeave={() => { clearTimeout(timer.current); timer.current = setTimeout(() => setHover(false), 400); }}
      onClick={openPlayer}
      onDblClick={openPlayer}
      title={live && !hover ? 'Click for full screen' : ''}
    >
      {live ? (
        <>
          {hover ? (
            <div class="preview-controls ov" onClick={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()} onMouseMove={poke}>
              <button class="icon-btn" title="Full screen" onClick={openPlayer}><Icon name="fullscreen" size={20} /></button>
              <VolumeControl compact />
            </div>
          ) : null}
          {player.mute && !hover ? <span class="preview-muted ov" title="Muted"><Icon name="mute" size={16} /></span> : null}
          <span class="preview-label ov">{live.channel.name}</span>
          {player.buffering ? <span class="preview-label ov loading">Loading…</span> : null}
        </>
      ) : (
        <div class="preview-empty">
          <div>Nothing playing</div>
          <div class="muted small mt6">Click a show airing now to watch it here. Click again for full screen.</div>
        </div>
      )}
    </div>
  );
}

function GroupsPanel({ groups, current, onPick, onPlaylist, onClose }) {
  const all = [['__fav__', 'Favorites'], ['__all__', 'All channels'], ...groups.map((g) => [g.categoryId, g.name])];
  const playlists = useStore((s) => s.playlists) || [];
  const pid = useStore((s) => s.playlistId);
  const [filter, setFilter] = useState('');
  const box = useRef(null);
  const input = useRef(null);
  const showFilter = groups.length > 12;
  const q = filter.trim().toLowerCase();
  const entries = q ? all.filter(([, name]) => String(name).toLowerCase().includes(q)) : all;
  useEffect(() => {
    const el = box.current && (box.current.querySelector('.selected') || box.current.querySelector('.list-item'));
    if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
  }, []);
  const typing = () => document.activeElement === input.current;
  useKeys((e) => {
    if (e.key === 'Escape') { if (typing() && filter) { setFilter(''); return true; } onClose(); return true; }
    if (typing()) {
      if (e.key === 'ArrowDown') { const el = box.current.querySelector('.groups-list .list-item'); if (el) el.focus(); return true; }
      if (e.key === 'Enter') { if (entries.length) onPick(entries[0][0]); return true; }
      return false;
    }
    if (e.key === 'Backspace' || e.key === 'ArrowRight') { onClose(); return true; }
    // Typing a letter jumps to the filter box.
    if (showFilter && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.altKey && !e.metaKey && input.current) {
      input.current.focus();
      return false;
    }
    return false;
  });
  return (
    <div class="groups-panel" ref={box}>
      {playlists.length > 1 ? (
        <>
          <div class="panel-label">Playlists</div>
          {playlists.map((p) => (
            <button key={`pl${p.id}`} data-nav class={`list-item ${p.id === pid ? 'current-pl' : ''}`} onClick={() => onPlaylist(p.id)} title={p.name}>
              {p.id === pid ? '● ' : ''}{p.name}
            </button>
          ))}
          <div class="panel-label">Channel groups{showFilter ? ` (${groups.length})` : ''}</div>
        </>
      ) : null}
      {showFilter ? (
        <div class="groups-filter">
          <input
            ref={input} data-nav type="text" placeholder="Find a group…" value={filter}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
          {filter ? <button class="icon-btn" title="Clear" onClick={() => { setFilter(''); input.current && input.current.focus(); }}>✕</button> : null}
        </div>
      ) : null}
      <div class="groups-list">
        {entries.map(([id, name]) => (
          <button key={id} data-nav class={`list-item ${id === current ? 'selected' : ''}`} title={name} onClick={() => onPick(id)}>{name}</button>
        ))}
        {q && !entries.length ? <div class="muted small" style={{ padding: 8 }}>No groups match “{filter.trim()}”</div> : null}
      </div>
    </div>
  );
}

function onProgramOk(ch, p, playingId) {
  const now = Date.now();
  const airing = !p || (p.start <= now && p.stop > now);
  if (!airing) setState({ programMenu: { channel: ch, program: p } });
  else if (ch.id === playingId) nav.push({ name: 'player' });
  else tune(ch, false);
}

function moveRow(channels, delta) {
  if (!channels.length) return;
  G.row = Math.max(0, Math.min(channels.length - 1, G.row + delta));
  const now = Date.now();
  if (G.focusTime < now) G.focusTime = now;
}

function ensureVisible(t, windowMinutes) {
  const now = Date.now();
  const winEnd = G.windowStart + windowMinutes * MIN;
  if (t < G.windowStart) G.windowStart = Math.max(floor30(now), floor30(t));
  else if (t >= winEnd - 20 * MIN) G.windowStart = Math.max(floor30(now), floor30(t) - 30 * MIN);
}

function moveRight(ch, windowMinutes) {
  const now = Date.now();
  const list = programsOf(ch) || [];
  const cur = list.find((p) => p.start <= G.focusTime && p.stop > G.focusTime);
  const next = cur ? list.find((p) => p.start >= cur.stop) : list.find((p) => p.start > G.focusTime);
  const target = next ? next.start : floor30(G.focusTime) + 30 * MIN;
  if (target > now + 14 * DAY) return;
  G.focusTime = target;
  ensureVisible(target, windowMinutes);
}

/** Returns false when the selection is already on what's airing now. */
function moveLeft(ch, windowMinutes) {
  const now = Date.now();
  const list = programsOf(ch) || [];
  const cur = list.find((p) => p.start <= G.focusTime && p.stop > G.focusTime);
  const curStart = cur ? cur.start : floor30(G.focusTime);
  if (curStart <= now) {
    G.focusTime = now;
    G.windowStart = floor30(now);
    return false;
  }
  let prev = null;
  for (const p of list) if (p.stop <= curStart) prev = p;
  const target = prev && prev.stop > now ? Math.max(prev.start, now) : Math.max(now, curStart - 30 * MIN);
  G.focusTime = target;
  ensureVisible(target, windowMinutes);
  return true;
}

function pageTime(delta, windowMinutes) {
  const now = Date.now();
  G.focusTime = Math.max(now, Math.min(now + 14 * DAY, G.focusTime + delta));
  G.windowStart = Math.max(floor30(now), floor30(G.focusTime) - 30 * MIN);
  ensureVisible(G.focusTime, windowMinutes);
}

function EpgGrid({ channels, playingId, rec, now, active, onChange, onExitLeft }) {
  const { programsOf: progs } = useProgramCache(null);
  const scroller = useRef(null);
  const [size, setSize] = useState({ w: 1000, h: 500 });
  const [scrollTop, setScrollTop] = useState(0);
  const hasFocus = active;

  useLayoutEffect(() => {
    const el = scroller.current;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const gridWidth = Math.max(300, size.w - CHANNEL_W);
  const windowMinutes = Math.max(60, Math.floor(gridWidth / PX_PER_MIN));
  const winStart = G.windowStart;
  const winEnd = winStart + windowMinutes * MIN;

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
  const last = Math.min(channels.length, Math.ceil((scrollTop + size.h) / ROW_H) + 4);
  const visible = channels.slice(first, last);
  useEffect(() => { ensureLoaded(visible); });

  // Keep the selected row on screen.
  const keepRowVisible = () => {
    const el = scroller.current;
    if (!el) return;
    const top = G.row * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && G.row * ROW_H > el.clientHeight) el.scrollTop = Math.max(0, G.row * ROW_H - ROW_H * 3);
  }, [channels]);

  const change = () => { keepRowVisible(); onChange(); };

  useKeys((e) => {
    const ch = channels[G.row];
    switch (e.key) {
      case 'ArrowUp': moveRow(channels, -1); change(); return true;
      case 'ArrowDown': moveRow(channels, 1); change(); return true;
      case 'PageUp': moveRow(channels, -8); change(); return true;
      case 'PageDown': moveRow(channels, 8); change(); return true;
      case 'Home': if (e.ctrlKey) { G.row = 0; change(); return true; } G.focusTime = Date.now(); G.windowStart = floor30(Date.now()); change(); return true;
      case 'ArrowRight': moveRight(ch, windowMinutes); change(); return true;
      case 'ArrowLeft': if (!moveLeft(ch, windowMinutes)) onExitLeft(); change(); return true;
      case ']': case '.': case 'MediaFastForward': pageTime(2 * HOUR, windowMinutes); change(); return true;
      case '[': case ',': case 'MediaRewind': pageTime(-2 * HOUR, windowMinutes); change(); return true;
      case 'Enter': if (ch) onProgramOk(ch, programAt(ch, G.focusTime), playingId); return true;
      case 'm': case 'M': case 'ContextMenu': case 'i': case 'I':
        if (ch) setState({ programMenu: { channel: ch, program: programAt(ch, G.focusTime) } });
        return true;
      case ' ': case 'MediaPlayPause': if (ch && !e.repeat) toggleFavorite(ch); return true;
      default: return false;
    }
  }, active);

  const onWheel = (e) => {
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const d = (e.shiftKey ? e.deltaY : e.deltaX) > 0 ? 30 * MIN : -30 * MIN;
      const nowT = Date.now();
      G.windowStart = Math.max(floor30(nowT), Math.min(floor30(nowT + 14 * DAY), G.windowStart + d));
      if (G.focusTime < G.windowStart) G.focusTime = G.windowStart;
      if (G.focusTime >= G.windowStart + windowMinutes * MIN) G.focusTime = Math.max(nowT, G.windowStart);
      onChange();
    }
  };

  const select = (i, t) => {
    G.row = i;
    G.focusTime = Math.max(Date.now(), t);
    onChange();
  };

  const rows = visible.map((ch, k) => {
    const i = first + k;
    const list = progs(ch);
    const rowSel = i === G.row;
    const isPlaying = ch.id === playingId;
    const progsIn = list ? list.filter((p) => p.stop > winStart && p.start < winEnd) : [];
    return (
      <div class="epg-row" key={ch.id} style={{ top: i * ROW_H }}>
        <div
          class={`ch-cell ${rowSel ? (hasFocus ? 'focused' : 'sel') : ''}`}
          style={{ width: CHANNEL_W }}
          onClick={() => { select(i, Date.now()); onProgramOk(ch, programAt(ch, Date.now()), playingId); }}
          onContextMenu={(e) => { e.preventDefault(); select(i, Date.now()); setState({ programMenu: { channel: ch, program: programAt(ch, Date.now()) } }); }}
          title={`${ch.number} ${ch.name}`}
        >
          <span class="ch-num">{ch.number}</span>
          <span class="ch-logo"><Img src={ch.logo} fit="contain" /></span>
          <span class={`ch-name ell ${isPlaying ? 'playing' : ''}`}>{ch.name}</span>
          {rec.recordingNowUrls.has(ch.url) ? <RecDot size={8} /> : null}
          {isFavorite(ch) ? <span class="fav">★</span> : null}
        </div>
        <div class="prog-area">
          {progsIn.length === 0 ? (
            <div
              class={`prog-cell current ${rowSel && hasFocus ? 'selected' : ''}`}
              style={{ left: 0, width: gridWidth - 2 }}
              onClick={() => { select(i, Date.now()); onProgramOk(ch, null, playingId); }}
              onContextMenu={(e) => { e.preventDefault(); select(i, Date.now()); setState({ programMenu: { channel: ch, program: null } }); }}
            >
              <div class="pt ell">{!ch.epgId ? ch.name : list == null ? 'Loading…' : 'No information'}</div>
            </div>
          ) : progsIn.map((p) => {
            const s = Math.max(p.start, winStart);
            const e2 = Math.min(p.stop, winEnd);
            const x = ((s - winStart) / MIN) * PX_PER_MIN;
            const w = ((e2 - s) / MIN) * PX_PER_MIN;
            const sel = rowSel && hasFocus && p.start <= G.focusTime && p.stop > G.focusTime;
            const current = p.start <= now && p.stop > now;
            const past = p.stop <= now;
            const recorded = rec.recordKeys.has(`${p.epgKey}@${p.start}`);
            return (
              <div
                key={p.id}
                class={`prog-cell ${sel ? 'selected' : ''} ${current ? 'current' : ''} ${past ? 'past' : ''}`}
                style={{ left: x, width: Math.max(0, w - 2) }}
                title={`${p.title}\n${Fmt.range(p.start, p.stop)}`}
                onClick={() => {
                  const wasSel = sel;
                  select(i, p.start);
                  if (wasSel || current) onProgramOk(ch, p, playingId);
                }}
                onDblClick={() => { if (current) { if (ch.id !== playingId) tune(ch, true); else nav.push({ name: 'player' }); } }}
                onContextMenu={(e) => { e.preventDefault(); select(i, p.start); setState({ programMenu: { channel: ch, program: p } }); }}
              >
                {recorded ? <RecDot size={8} /> : null}
                <div class="grow minw0">
                  <div class="pt ell">{p.title}</div>
                  {w > 130 ? <div class="ptime ell">{Fmt.range(p.start, p.stop)}</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  });

  const nowX = now >= winStart && now < winEnd ? CHANNEL_W + ((now - winStart) / MIN) * PX_PER_MIN : null;
  const ticks = [];
  for (let t = winStart; t < winEnd; t += 30 * MIN) ticks.push(t);

  return (
    <div class="epg">
      <div class="ruler">
        <div class="ruler-day" style={{ width: CHANNEL_W }}>
          <span class="accent">{Fmt.shortDay(Math.max(winStart, now))}</span>
          <span class="grow" />
          <button class="icon-btn" title="Earlier (,)" onClick={() => { pageTime(-2 * HOUR, windowMinutes); onChange(); }}><Icon name="chevL" size={16} /></button>
          <button class="icon-btn now-btn" title="Back to now (Home)" onClick={() => { G.focusTime = Date.now(); G.windowStart = floor30(Date.now()); onChange(); }}>Now</button>
          <button class="icon-btn" title="Later (.)" onClick={() => { pageTime(2 * HOUR, windowMinutes); onChange(); }}><Icon name="chevR" size={16} /></button>
        </div>
        <div class="ruler-times">
          {ticks.map((t) => (
            <div key={t} class="tick" style={{ left: ((t - winStart) / MIN) * PX_PER_MIN }}>
              <span class="tick-line" />{Fmt.time(t)}
            </div>
          ))}
        </div>
      </div>
      <div class="epg-scroll" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} onWheel={onWheel}>
        <div class="epg-inner" style={{ height: channels.length * ROW_H }}>{rows}</div>
        {nowX != null ? <div class="now-line" style={{ left: nowX, height: Math.max(size.h, channels.length * ROW_H), top: 0 }} /> : null}
      </div>
    </div>
  );
}
