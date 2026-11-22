// Full-screen player: live TV (info banner, channel list, options) and movies/episodes/recordings.
import { useEffect, useRef, useState } from 'preact/hooks';
import { call, win, useNow, useEvent, Fmt } from './lib';
import { useStore, setState, getState, nav, tune, toggleFavorite, isFavorite } from './store';
import { useKeys } from './keys';
import { useFullVideo, pointerMoved } from './video';
import { MenuRow, ProgressLine, RecDot, Img, Spinner, Icon, VolumeControl } from './components';
import { useGuideChannels, useProgramCache, useRecordState, groupTitle, programAt } from './guide';

const RESIZE = [['fit', 'Fit'], ['zoom', 'Zoom'], ['stretch', 'Stretch']];
const SPEEDS = [1, 1.25, 1.5, 2, 0.75];

export function PlayerScreen() {
  const np = useStore((s) => s.player.nowPlaying);
  useFullVideo(true);
  useEffect(() => {
    if (!np) {
      const t = setTimeout(() => { if (!getState().player.nowPlaying) nav.pop(); }, 400);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [np]);
  if (!np) return <div class="player" />;
  return np.type === 'live' ? <LivePlayer channel={np.channel} /> : <VodPlayer item={np.item} />;
}

/** Shows controls on activity, hides them (and the mouse pointer) after a few seconds. */
function useAutoHide(ms, keepOpen) {
  const [visible, setVisible] = useState(true);
  const timer = useRef(null);
  const poke = (forMs) => {
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), typeof forMs === 'number' ? forMs : ms);
  };
  useEffect(() => { poke(); return () => clearTimeout(timer.current); }, []);
  return [visible || keepOpen, poke];
}

function useMessage() {
  const [message, setMessage] = useState(null);
  const timer = useRef(null);
  useEvent('player-event', (ev) => {
    if (ev.type === 'error') {
      setMessage(ev.message);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setMessage(null), ev.everywhere ? 20000 : ev.transient ? 4000 : 8000);
    }
  });
  return [message, setMessage];
}

function VolumeOsd() {
  const vol = useStore((s) => s.player.volume);
  const mute = useStore((s) => s.player.mute);
  const [show, setShow] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    setShow(true);
    const t = setTimeout(() => setShow(false), 1500);
    return () => clearTimeout(t);
  }, [vol, mute]);
  if (!show) return null;
  return (
    <div class="volume-osd ov">
      <Icon name={mute ? 'mute' : 'volume'} size={20} />
      <ProgressLine value={mute ? 0 : (vol || 0) / 100} style={{ width: 140 }} />
      <span>{mute ? 'Muted' : `${Math.round(vol || 0)}%`}</span>
    </div>
  );
}

const volumeBy = (d) => call('player.setVolume', (getState().player.volume || 0) + d);


function commonKeys(e) {
  switch (e.key) {
    case '+': case '=': case 'AudioVolumeUp': volumeBy(5); return true;
    case '-': case '_': case 'AudioVolumeDown': volumeBy(-5); return true;
    case 'AudioVolumeMute': case 'u': case 'U': call('player.toggleMute'); return true;
    default: return false;
  }
}

// ============================================================================ live

function LivePlayer({ channel }) {
  const st = useStore((s) => s.player);
  const group = useStore((s) => s.guideGroup);
  const settings = useStore((s) => s.settings);
  const fullscreen = useStore((s) => s.fullscreen);
  const chQ = useGuideChannels();
  const channels = chQ.data || [];
  const [listOpen, setListOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState(null);
  const [digits, setDigits] = useState('');
  const [message, setMessage] = useMessage();
  const [hover, setHover] = useState(false);
  const [bannerVisible, poke] = useAutoHide(5000, false);
  const [mouseActive, pokeMouse] = useAutoHide(3500, listOpen || menuOpen || hover || st.paused);
  const curIndex = channels.findIndex((c) => c.id === channel.id);
  const shown = pending != null && channels[pending] ? channels[pending] : channel;

  useEffect(() => { setMessage(null); poke(); }, [channel.id]);

  // Changing channel waits a moment, so several presses go straight to the one you want.
  useEffect(() => {
    if (pending == null) return undefined;
    const t = setTimeout(() => {
      const ch = channels[pending];
      setPending(null);
      if (ch && ch.id !== channel.id) tune(ch, true);
    }, 450);
    return () => clearTimeout(t);
  }, [pending]);

  // Typed channel numbers.
  useEffect(() => {
    if (!digits) return undefined;
    const t = setTimeout(() => {
      const n = parseInt(digits, 10);
      const ch = channels.find((c) => c.number === n);
      setDigits('');
      if (ch && ch.id !== channel.id) tune(ch, true);
    }, 1400);
    return () => clearTimeout(t);
  }, [digits]);

  const step = (dir) => {
    if (!channels.length) return;
    const d = settings.invertChannelKeys ? -dir : dir;
    const base = pending != null ? pending : Math.max(0, curIndex);
    setPending((base + d + channels.length) % channels.length);
    poke();
  };

  useKeys((e) => {
    if (commonKeys(e)) return true;
    if (/^[0-9]$/.test(e.key)) { setDigits((d) => (d + e.key).slice(0, 5)); poke(); return true; }
    switch (e.key) {
      case 'ArrowUp': case 'PageUp': case 'MediaTrackPrevious': step(-1); return true;
      case 'ArrowDown': case 'PageDown': case 'MediaTrackNext': step(1); return true;
      case 'ArrowLeft': case 'ArrowRight': case 'i': case 'I': poke(); return true;
      case 'Enter': setListOpen(true); return true;
      case 'm': case 'M': case 'ContextMenu': setMenuOpen(true); return true;
      case ' ': case 'MediaPlayPause': if (!e.repeat) { call('player.togglePause'); poke(); } return true;
      case 'p': case 'P': case 'MediaRewind':
        if (st.previousChannel && !e.repeat) tune(st.previousChannel, true);
        return true;
      default: return false;
    }
  }, !listOpen && !menuOpen);

  const showControls = (bannerVisible || mouseActive) && !listOpen && !menuOpen;
  return (
    <div
      class={`player ${showControls || listOpen || menuOpen ? '' : 'no-cursor'}`}
      onMouseMove={(e) => { setHover(!!(e.target.closest && e.target.closest('.info-banner'))); if (pointerMoved(e)) { pokeMouse(); poke(); } }}
      onClick={(e) => { if (!(e.target.closest && e.target.closest('.ov'))) { pokeMouse(8000); poke(8000); } }}
      onDblClick={(e) => { if (!(e.target.closest && e.target.closest('.ov'))) win('toggleFullscreen'); }}
      onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true); }}
      onWheel={(e) => { volumeBy(e.deltaY < 0 ? 5 : -5); }}
    >
      {st.buffering && pending == null ? <div class="center-abs"><Spinner /></div> : null}
      {st.paused ? <div class="center-abs"><div class="pill ov">❚❚&nbsp; Paused</div></div> : null}
      {message ? <div class="top-message ov">{message}</div> : null}
      {digits ? <div class="digits ov">{digits}</div> : null}
      <VolumeOsd />
      {showControls ? (
        <>
          <InfoBanner channel={shown} viaRelay={st.viaRelay && pending == null}>
            <div class="live-controls" onClick={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
              <CtlButton icon={st.paused ? 'play' : 'pause'} label={st.paused ? 'Play' : 'Pause'} title="Pause / play (Space)" onClick={() => call('player.togglePause')} />
              <CtlButton icon="chevU" label="Channel up" title="Previous channel in the list (↑)" onClick={() => step(-1)} />
              <CtlButton icon="chevD" label="Channel down" title="Next channel in the list (↓)" onClick={() => step(1)} />
              {st.previousChannel ? <CtlButton icon="swap" label="Last channel" title={`Back to ${st.previousChannel.name} (P)`} onClick={() => tune(st.previousChannel, true)} /> : null}
              <div class="ctl-volume"><VolumeControl /></div>
              <span class="grow" />
              <CtlButton icon="rec" label="Record" title="Record this programme or series" onClick={() => setState({ programMenu: { channel, program: programAt(channel, Date.now()) } })} />
              <CtlButton icon="list" label="Channels" title="Channel list (Enter)" onClick={() => setListOpen(true)} />
              <CtlButton icon="guide" label="TV Guide" title="Back to the guide; the channel keeps playing in the corner (Esc)" onClick={() => nav.pop()} />
              <CtlButton icon="menu" label="Options" title="Audio, subtitles, picture size and more (M or right-click)" onClick={() => setMenuOpen(true)} />
              <CtlButton icon={fullscreen ? 'exitfull' : 'fullscreen'} label={fullscreen ? 'Exit full screen' : 'Full screen'} title="Full screen on / off (F)" onClick={() => win('toggleFullscreen')} />
            </div>
          </InfoBanner>
        </>
      ) : null}
      {listOpen ? (
        <ChannelListPanel
          channels={channels}
          current={channel}
          title={groupTitle(group, null)}
          onPick={(ch) => { setListOpen(false); if (ch.id !== channel.id) tune(ch, true); }}
          onGuide={() => { setListOpen(false); nav.pop(); }}
          onClose={() => setListOpen(false)}
        />
      ) : null}
      {menuOpen ? <PlayerMenu live={channel} onClose={() => setMenuOpen(false)} /> : null}
    </div>
  );
}

function CtlButton({ icon, label, title, onClick }) {
  return (
    <button class="ctl-btn" title={title} onClick={onClick}>
      <Icon name={icon} size={24} />
      <span>{label}</span>
    </button>
  );
}

function InfoBanner({ channel: ch, viaRelay, children }) {
  const now = useNow(10000);
  useProgramCache([ch]);
  const rec = useRecordState();
  const cur = programAt(ch, now);
  const list = [];
  const next = (() => {
    const p = programAt(ch, cur ? cur.stop : now + 1);
    return p && p !== cur ? p : null;
  })();
  void list;
  const recording = rec.recordingNowUrls.has(ch.url);
  return (
    <div class="info-banner ov">
      <div class="banner-main">
      <div class="banner-logo">{ch.logo ? <Img src={ch.logo} fit="contain" /> : <span>{ch.number}</span>}</div>
      <div class="grow minw0">
        <div class="row center-v gap8">
          <span class="accent semibold">{ch.number}&nbsp;&nbsp;{ch.name}</span>
          {recording ? <><RecDot /><span class="rec-text">REC</span></> : null}
          {isFavorite(ch) ? <span class="fav">★</span> : null}
          {viaRelay ? <span class="muted small">·  watching through the recording</span> : null}
        </div>
        <div class="banner-title ell">{cur ? cur.title : 'No programme information'}</div>
        {cur ? (
          <div class="row center-v gap12">
            <span class="muted">{Fmt.range(cur.start, cur.stop)}</span>
            <ProgressLine value={(now - cur.start) / (cur.stop - cur.start)} style={{ width: 260 }} />
            <span class="muted small">{Math.max(0, Math.floor((cur.stop - now) / 60000))} min left</span>
          </div>
        ) : null}
        {cur && [cur.episode, cur.subtitle].filter(Boolean).length ? <div class="dim ell">{[cur.episode, cur.subtitle].filter(Boolean).join(' · ')}</div> : null}
        {next ? <div class="muted ell mt4">Next&nbsp; {Fmt.time(next.start)}&nbsp; {next.title}</div> : null}
      </div>
      <div class="banner-right">
        <div class="clock">{Fmt.time(now)}</div>
        <div class="muted small">↑↓ channels · Enter list · M options · P previous</div>
      </div>
      </div>
      {children}
    </div>
  );
}

function ChannelListPanel({ channels, current, title, onPick, onGuide, onClose }) {
  const now = useNow(30000);
  const box = useRef(null);
  const rec = useRecordState();
  const [scrollTop, setScrollTop] = useState(0);
  const ROW = 50;
  const curIdx = Math.max(0, channels.findIndex((c) => c.id === current.id));
  const [sel, setSel] = useState(curIdx);
  const height = box.current ? box.current.clientHeight : 800;
  const first = Math.max(0, Math.floor(scrollTop / ROW) - 3);
  const last = Math.min(channels.length, Math.ceil((scrollTop + height) / ROW) + 3);
  const visible = channels.slice(first, last);
  useProgramCache(visible);

  useEffect(() => {
    if (box.current) box.current.scrollTop = Math.max(0, curIdx * ROW - ROW * 4);
  }, []);
  const keep = (i) => {
    const el = box.current;
    if (!el) return;
    if (i * ROW < el.scrollTop) el.scrollTop = i * ROW;
    else if ((i + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (i + 1) * ROW - el.clientHeight;
  };
  useKeys((e) => {
    const n = channels.length;
    if (e.key === 'ArrowUp') { const i = Math.max(0, sel - 1); setSel(i); keep(i); return true; }
    if (e.key === 'ArrowDown') { const i = Math.min(n - 1, sel + 1); setSel(i); keep(i); return true; }
    if (e.key === 'PageUp') { const i = Math.max(0, sel - 8); setSel(i); keep(i); return true; }
    if (e.key === 'PageDown') { const i = Math.min(n - 1, sel + 8); setSel(i); keep(i); return true; }
    if (e.key === 'Enter') { if (channels[sel]) onPick(channels[sel]); return true; }
    if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'ArrowLeft') { onClose(); return true; }
    if (e.key === ' ') { if (channels[sel]) toggleFavorite(channels[sel]); return true; }
    return false;
  });
  return (
    <div class="side-panel left ov" onClick={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div class="row center-v gap8 panel-head">
        <span class="panel-title grow ell">{title}</span>
        <button class="btn small" onClick={onGuide}>TV Guide</button>
        <button class="icon-btn" title="Close" onClick={onClose}>✕</button>
      </div>
      <div class="panel-scroll" ref={box} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: channels.length * ROW, position: 'relative' }}>
          {visible.map((ch, k) => {
            const i = first + k;
            const prog = programAt(ch, now);
            return (
              <div
                key={ch.id}
                class={`list-ch ${i === sel ? 'focused' : ''} ${ch.id === current.id ? 'selected' : ''}`}
                style={{ top: i * ROW, height: ROW - 4 }}
                onClick={() => onPick(ch)}
                onMouseEnter={() => setSel(i)}
              >
                <span class="ch-num">{ch.number}</span>
                <span class="ch-logo small"><Img src={ch.logo} fit="contain" /></span>
                <span class="grow minw0">
                  <div class="ell">{ch.name}</div>
                  {prog ? <div class="ell small dim">{prog.title}</div> : null}
                </span>
                {rec.recordingNowUrls.has(ch.url) ? <RecDot size={8} /> : null}
                {isFavorite(ch) ? <span class="fav">★</span> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============================================================================ menu

function PlayerMenu({ live, onClose }) {
  const st = useStore((s) => s.player);
  const [page, setPage] = useState('main');
  const [tracks, setTracks] = useState([]);
  const [info, setInfo] = useState([]);
  useKeys((e) => {
    if (e.key === 'Escape' || e.key === 'Backspace') {
      if (page !== 'main') setPage('main'); else onClose();
      return true;
    }
    if (e.key === 'm' || e.key === 'M' || e.key === 'ContextMenu') { onClose(); return true; }
    return false;
  });
  useEffect(() => {
    if (page === 'audio' || page === 'sub') call('player.tracks', page).then(setTracks);
    if (page === 'info') {
      const load = () => call('player.streamInfo').then(setInfo);
      load();
      const t = setInterval(load, 1000);
      return () => clearInterval(t);
    }
    return undefined;
  }, [page]);
  const resizeLabel = (RESIZE.find((r) => r[0] === st.resizeMode) || RESIZE[0])[1];
  const nextResize = () => {
    const i = RESIZE.findIndex((r) => r[0] === st.resizeMode);
    call('player.setResize', RESIZE[(i + 1) % RESIZE.length][0]);
  };
  let content;
  if (page === 'main') {
    content = (
      <>
        <div class="panel-title mb8">Options</div>
        {live ? (
          <>
            <MenuRow text="Record / programme options" autoFocus onClick={() => { onClose(); setState({ programMenu: { channel: live, program: programAt(live, Date.now()) } }); }} />
            {live.id > 0 ? <MenuRow text={isFavorite(live) ? 'Remove from favorites' : 'Add to favorites'} onClick={() => { onClose(); toggleFavorite(live); }} /> : null}
            {st.previousChannel ? <MenuRow text="Previous channel" detail={st.previousChannel.name} onClick={() => { onClose(); tune(st.previousChannel, true); }} /> : null}
          </>
        ) : (
          <MenuRow text="Speed" detail={`${st.speed || 1}x`} autoFocus onClick={() => {
            const i = SPEEDS.indexOf(st.speed || 1);
            call('player.setSpeed', SPEEDS[(i + 1) % SPEEDS.length]);
          }} />
        )}
        <MenuRow text="Audio track" onClick={() => setPage('audio')} />
        <MenuRow text="Subtitles" onClick={() => setPage('sub')} />
        <MenuRow text="Picture size" detail={resizeLabel} onClick={nextResize} />
        <MenuRow text="Volume" detail={st.mute ? 'Muted' : `${Math.round(st.volume || 0)}%  (+/−)`} onClick={() => call('player.toggleMute')} />
        <MenuRow text="Stream info" onClick={() => setPage('info')} />
        <MenuRow text="Close" onClick={onClose} />
      </>
    );
  } else if (page === 'info') {
    content = (
      <>
        <div class="panel-title mb8">Stream info</div>
        {info.map(([k, v]) => <div class="row info-row" key={k}><span class="muted k">{k}</span><span>{v}</span></div>)}
        <MenuRow text="Back" autoFocus onClick={() => setPage('main')} />
      </>
    );
  } else {
    const usable = page === 'sub' ? tracks.length > 1 : tracks.length > 0;
    content = (
      <>
        <div class="panel-title mb8">{page === 'audio' ? 'Audio track' : 'Subtitles'}</div>
        {!usable ? <div class="muted">None available for this stream</div> : (
          <div class="panel-list">
            {tracks.map((t, i) => (
              <MenuRow key={t.id} text={t.label} detail={t.selected ? '✓' : null} selected={t.selected}
                autoFocus={t.selected || (i === 0 && !tracks.some((x) => x.selected))}
                onClick={() => { call('player.selectTrack', page, t.id); setPage('main'); }} />
            ))}
          </div>
        )}
        <MenuRow text="Back" autoFocus={!usable} onClick={() => setPage('main')} />
      </>
    );
  }
  return (
    <div class="side-panel right ov" onClick={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }} onWheel={(e) => e.stopPropagation()}>
      {content}
    </div>
  );
}

// ============================================================================ VOD

function VodPlayer({ item }) {
  const st = useStore((s) => s.player);
  const fullscreen = useStore((s) => s.fullscreen);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingSeek, setPendingSeek] = useState(0);
  const [message, setMessage] = useMessage();
  const [nextUp, setNextUp] = useState(null);
  const [countdown, setCountdown] = useState(10);
  const [dragPos, setDragPos] = useState(null);
  const [visible, poke] = useAutoHide(4500, menuOpen || st.paused || pendingSeek !== 0 || dragPos != null);
  const isEpisode = item.kind.endsWith('episode');
  const seekTimer = useRef(null);
  const bar = useRef(null);

  useEffect(() => () => { call('player.stopVod'); }, []);
  useEffect(() => { setMessage(null); setNextUp(null); }, [item.key]);

  useEvent('player-event', (ev) => {
    if (ev.type === 'ended') {
      const s = getState().player;
      if (isEpisode && s.nextItem) setNextUp(s.nextItem);
      else nav.pop();
    }
  });

  useEffect(() => {
    if (!nextUp) return undefined;
    setCountdown(10);
    const t = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => clearInterval(t);
  }, [nextUp]);
  useEffect(() => {
    if (nextUp && countdown <= 0) { setNextUp(null); setMessage(null); call('player.playNext'); }
  }, [countdown]);

  const seekBy = (ms) => {
    setPendingSeek((p) => {
      const n = p + ms;
      clearTimeout(seekTimer.current);
      seekTimer.current = setTimeout(() => { call('player.seekBy', n); setPendingSeek(0); }, 600);
      return n;
    });
    poke();
  };

  useKeys((e) => {
    if (nextUp) {
      if (e.key === 'Enter') { setNextUp(null); setMessage(null); call('player.playNext'); return true; }
      if (e.key === 'Escape' || e.key === 'Backspace') { setNextUp(null); return true; }
      return false;
    }
    if (commonKeys(e)) return true;
    const accel = 1 + Math.floor((e.repeat ? 4 : 0) / 4);
    switch (e.key) {
      case 'ArrowLeft': seekBy(-10000 * accel); return true;
      case 'ArrowRight': seekBy(10000 * accel); return true;
      case ',': case 'MediaRewind': case 'j': case 'J': seekBy(-60000); return true;
      case '.': case 'MediaFastForward': case 'l': case 'L': seekBy(60000); return true;
      case 'Enter': case ' ': case 'MediaPlayPause': case 'k': case 'K':
        if (!e.repeat) { call('player.togglePause'); poke(); }
        return true;
      case 'ArrowUp': volumeBy(5); poke(); return true;
      case 'ArrowDown': volumeBy(-5); poke(); return true;
      case 'm': case 'M': case 'ContextMenu': setMenuOpen(true); return true;
      case 'n': case 'N': case 'MediaTrackNext': if (st.hasNext) call('player.playNext'); return true;
      default: return false;
    }
  }, !menuOpen);

  const dur = st.duration;
  const shownPos = dragPos != null ? dragPos : Math.max(0, Math.min(dur > 0 ? dur : Infinity, st.position + pendingSeek));
  const posFromEvent = (e) => {
    const r = bar.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur;
  };
  const onBarDown = (e) => {
    if (!(dur > 0)) return;
    e.preventDefault();
    setDragPos(posFromEvent(e));
    const move = (ev) => setDragPos(posFromEvent(ev));
    const up = (ev) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      call('player.seekTo', posFromEvent(ev));
      setTimeout(() => setDragPos(null), 300);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      class={`player ${visible ? '' : 'no-cursor'}`}
      onMouseMove={(e) => { if (pointerMoved(e)) poke(); }}
      onClick={(e) => { if (e.target === e.currentTarget) { call('player.togglePause'); poke(); } }}
      onDblClick={(e) => { if (e.target === e.currentTarget) { call('player.togglePause'); win('toggleFullscreen'); } }}
      onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true); }}
      onWheel={(e) => volumeBy(e.deltaY < 0 ? 5 : -5)}
    >
      {st.buffering && !st.paused ? <div class="center-abs"><Spinner /></div> : null}
      {message ? <div class="top-message ov">{message}</div> : null}
      <VolumeOsd />
      {visible && !menuOpen ? (
        <>
          <div class="player-topbar ov">
            <button class="icon-btn big" title="Back (Esc)" onClick={() => nav.pop()}><Icon name="back" /></button>
            <span class="grow" />
            <VolumeControl />
            <button class="icon-btn big" title="Audio, subtitles and more (M)" onClick={() => setMenuOpen(true)}><Icon name="menu" /></button>
            <button class="icon-btn big" title="Full screen (F)" onClick={() => win('toggleFullscreen')}><Icon name={fullscreen ? 'exitfull' : 'fullscreen'} /></button>
          </div>
          <div class="vod-controls ov">
            <div class="banner-title ell">{item.title}</div>
            {item.subtitle ? <div class="muted ell">{item.subtitle}</div> : null}
            <div class="seekbar" ref={bar} onMouseDown={onBarDown}>
              <div class="seek-fill" style={{ width: `${dur > 0 ? (shownPos / dur) * 100 : 0}%` }} />
              <div class="seek-knob" style={{ left: `${dur > 0 ? (shownPos / dur) * 100 : 0}%` }} />
            </div>
            <div class="row center-v gap8">
              <button class="icon-btn" title="Back 10 s (←)" onClick={() => seekBy(-10000)}><Icon name="rew" /></button>
              <button class="icon-btn big" title="Play / pause (Space)" onClick={() => call('player.togglePause')}><Icon name={st.paused ? 'play' : 'pause'} /></button>
              <button class="icon-btn" title="Forward 10 s (→)" onClick={() => seekBy(10000)}><Icon name="ff" /></button>
              {st.hasNext ? <button class="icon-btn" title="Next episode (N)" onClick={() => call('player.playNext')}><Icon name="next" /></button> : null}
              <span class="time">
                {Fmt.clock(shownPos)}
                {pendingSeek ? `   (${pendingSeek > 0 ? '+' : '−'}${Fmt.clock(Math.abs(pendingSeek))})` : ''}
              </span>
              <span class="grow" />
              <span class="muted time">{dur > 0 ? `-${Fmt.clock(dur - shownPos)}` : ''}</span>
            </div>
          </div>
        </>
      ) : null}
      {nextUp ? (
        <div class="next-up ov">
          <div class="accent">Next episode in {countdown}</div>
          <div class="next-title">{nextUp.subtitle || nextUp.title}</div>
          <div class="row gap8 mt8">
            <button class="btn primary small" onClick={() => { setNextUp(null); call('player.playNext'); }}>Play now</button>
            <button class="btn small" onClick={() => setNextUp(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
      {menuOpen ? <PlayerMenu live={null} onClose={() => setMenuOpen(false)} /> : null}
    </div>
  );
}
