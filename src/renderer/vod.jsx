// Movies and Series: categories on the left, posters on the right; detail pages for provider and Plex titles.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { call, useQuery, Fmt, ratingText } from './lib';
import { useStore, setState, getState, nav, playQueue, playPlex, showToast } from './store';
import { CenterMessage, ProgressLine, Img, Btn, Card } from './components';

const CONTINUE = '__continue';
const FAVORITES = '__fav';
const RECENT = '__recent';
const PLEX_ERROR = 'plexerror:';

// Where you were in each browser (category, scroll, last poster), kept while the app runs.
const memory = {};

export function VodBrowser({ kind }) {
  const pid = useStore((s) => s.playlistId);
  const playlists = useStore((s) => s.playlists);
  const pl = (playlists || []).find((p) => p.id === pid);
  const gen = pl ? pl.vodGen : 0;
  const mem = memory[kind] || (memory[kind] = { selected: RECENT, scroll: 0, lastCard: null });
  const [selected, setSelected] = useState(getState().vodCategory[kind] || mem.selected);
  const cats = useQuery(() => call('vod.categories', pid, kind), [pid, kind], ['channel_groups']);
  const plexEntries = useQuery(() => call('vod.plexEntries', kind), [kind]);
  const entries = useMemo(() => [
    [CONTINUE, 'Continue watching'], [FAVORITES, 'Favorites'], [RECENT, 'Recently added'],
    ...(plexEntries.data || []),
    ...((cats.data || []).map((c) => [c.categoryId, c.name])),
  ], [cats.data, plexEntries.data]);
  const tables = selected === FAVORITES ? ['favorites', 'vod', 'series'] : selected === CONTINUE ? ['progress'] : ['vod', 'series'];
  const cards = useQuery(() => call('vod.cards', kind, pid, selected), [kind, pid, selected, gen], tables);
  const grid = useRef(null);
  const catBox = useRef(null);

  useEffect(() => {
    mem.selected = selected;
    setState({ vodCategory: { ...getState().vodCategory, [kind]: selected } });
  }, [selected]);

  // Back from a title: return to the poster that was open.
  const restored = useRef(false);
  useEffect(() => {
    if (!cards.data || restored.current) return;
    restored.current = true;
    if (grid.current) grid.current.scrollTop = mem.scroll;
    const el = mem.lastCard && grid.current && grid.current.querySelector(`[data-id="${CSS.escape(mem.lastCard)}"]`);
    if (el) el.focus({ preventScroll: true });
    else {
      const c = catBox.current && catBox.current.querySelector('.selected');
      if (c) c.focus({ preventScroll: true });
    }
  }, [cards.data]);

  const open = (card) => {
    mem.lastCard = card.id;
    mem.scroll = grid.current ? grid.current.scrollTop : 0;
    if (card.id.startsWith('plex:')) {
      const [server, rk] = card.id.substring(5).split(':');
      nav.push({ name: kind === 'movie' ? 'plexMovie' : 'plexShow', serverId: server, ratingKey: rk });
    } else {
      nav.push({ name: kind === 'movie' ? 'movie' : 'series', playlistId: pid, id: card.id });
    }
  };

  const nothing = pl && !gen && cats.data && !cats.data.length && !(plexEntries.data || []).length;
  if (nothing) {
    return <CenterMessage title={kind === 'movie' ? 'No movies yet' : 'No series yet'} subtitle="They'll appear after the playlist finishes updating." />;
  }

  const list = cards.data;
  let body;
  if (!list) body = <CenterMessage title="Loading…" />;
  else if (!list.length) {
    const t = selected.startsWith(PLEX_ERROR) ? `Can't reach the Plex server “${selected.substring(PLEX_ERROR.length)}”`
      : cards.error ? "Couldn't load this" : selected === CONTINUE ? 'Nothing in progress' : selected === FAVORITES ? 'No favorites yet' : 'Nothing here';
    const s = selected.startsWith(PLEX_ERROR) ? 'It may be switched off, or not shared any more. Choose servers in Settings → Plex servers.'
      : cards.error || (selected === FAVORITES ? 'Open a title and choose Add to favorites.' : null);
    body = <CenterMessage title={t} subtitle={s} />;
  } else {
    body = (
      <div class="poster-grid">
        {list.map((c) => <PosterCard key={c.id} card={c} onClick={() => open(c)} />)}
      </div>
    );
  }
  return (
    <div class="vod">
      <div class="cat-list" ref={catBox}>
        {entries.map(([id, name]) => (
          <button
            key={id}
            data-nav
            class={`list-item ${id === selected ? 'selected' : ''}`}
            onClick={() => { if (id !== selected) { setSelected(id); if (grid.current) grid.current.scrollTop = 0; } }}
            title={name}
          >{name}</button>
        ))}
      </div>
      <div class="grow scroll-y" ref={grid}>{body}</div>
    </div>
  );
}

export function PosterCard({ card, onClick }) {
  return (
    <div class="poster" data-nav tabIndex={0} data-id={card.id} onClick={onClick} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onClick(); } }} title={card.title}>
      <div class="poster-img">
        {card.image ? <Img src={card.image} alt={card.title} /> : null}
        {!card.image ? <div class="poster-fallback">{card.title}</div> : null}
        {ratingText(card.rating) ? <span class="badge">{ratingText(card.rating)}</span> : null}
        {card.progress != null ? <ProgressLine value={card.progress} className="poster-progress" /> : null}
      </div>
      <div class="poster-title clamp2">{card.title}</div>
    </div>
  );
}

function Backdrop({ src, opacity = 0.25 }) {
  return (
    <>
      {src ? <div class="backdrop-img" style={{ backgroundImage: `url("${src}")`, opacity }} /> : null}
      <div class="backdrop-fade" />
    </>
  );
}

function ResumeInfo({ position, duration }) {
  if (!(position > 60000) || !(duration > 0)) return null;
  return (
    <div class="row center-v gap8 mb12">
      <ProgressLine value={position / duration} style={{ width: 200 }} />
      <span class="muted small">{Fmt.duration(duration - position)} left</span>
    </div>
  );
}

// ============================================================================ movie

export function MovieDetail({ playlistId: pid, id }) {
  const key = `movie:${pid}:${id}`;
  const data = useQuery(() => call('vod.movie', pid, id), [pid, id]);
  const info = useQuery(() => call('vod.movieInfo', pid, id), [pid, id]);
  const progress = useQuery(() => call('progress.get', key), [key], ['progress']);
  const favs = useQuery(() => call('favorites.keys', pid), [pid], ['favorites']);
  if (!data.data) return <CenterMessage title="Loading…" />;
  const { vod } = data.data;
  if (!vod) return <CenterMessage title="This movie is no longer available" />;
  const inf = info.data || {};
  const p = progress.data;
  const isFav = (favs.data || []).includes(key);
  const play = async (fromStart) => {
    try {
      const item = await call('vod.moviePlayable', pid, id, inf.ext);
      await playQueue([item], 0, !fromStart && p && !p.finished ? p.position : 0);
    } catch (e) { showToast(e.message); }
  };
  const resumable = p && !p.finished && p.position > 60000;
  const meta = [(inf.releaseDate || '').substring(0, 4) || vod.year, inf.genre, inf.duration && inf.duration !== '00:00:00' ? inf.duration : null, ratingText(inf.rating || vod.rating)].filter(Boolean).join('   ·   ');
  return (
    <div class="detail">
      <Backdrop src={inf.backdrop || inf.image || vod.poster} />
      <div class="detail-body">
        <div class="detail-poster"><Img src={inf.image || vod.poster} alt={vod.name} /></div>
        <div class="grow minw0">
          <div class="detail-title clamp2">{vod.name}</div>
          {meta ? <div class="muted mt6">{meta}</div> : null}
          <div class="mt18" />
          {resumable ? <ResumeInfo position={p.position} duration={p.duration} /> : null}
          <div class="row gap12 wrap">
            {resumable ? (
              <>
                <Btn primary autoFocus onClick={() => play(false)}>▶&nbsp; Resume from {Fmt.clock(p.position)}</Btn>
                <Btn onClick={() => play(true)}>Play from start</Btn>
              </>
            ) : <Btn primary autoFocus onClick={() => play(true)}>▶&nbsp; Play</Btn>}
            <Btn onClick={() => call('favorites.toggle', key, pid)}>{isFav ? '★ In favorites' : '☆ Add to favorites'}</Btn>
          </div>
          {inf.plot ? <div class="plot mt22 clamp7">{inf.plot}</div> : null}
          {inf.director ? <div class="muted small mt8 clamp2">Director: {inf.director}</div> : null}
          {inf.cast ? <div class="muted small mt8 clamp2">Cast: {inf.cast}</div> : null}
        </div>
      </div>
    </div>
  );
}

// ============================================================================ series

export function SeriesDetail({ playlistId: pid, id }) {
  const favKey = `series:${pid}:${id}`;
  const data = useQuery(() => call('vod.series', pid, id), [pid, id]);
  const info = useQuery(() => call('vod.seriesInfo', pid, id), [pid, id]);
  const progress = useQuery(() => call('progress.series', pid, id), [pid, id], ['progress']);
  const favs = useQuery(() => call('favorites.keys', pid), [pid], ['favorites']);
  const [season, setSeason] = useState(null);
  if (!data.data) return <CenterMessage title="Loading…" />;
  const { series } = data.data;
  if (!series) return <CenterMessage title="This series is no longer available" />;
  const inf = info.data ? info.data.info : null;
  const playables = info.data ? info.data.playables : [];
  const episodes = inf ? inf.episodes : [];
  const progList = progress.data || [];
  const byKey = new Map(progList.map((p) => [p.key, p]));
  const lastWatched = progList.reduce((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), null);
  const seasons = [...new Set(episodes.map((e) => e.season))];
  const curSeason = season != null ? season : (lastWatched && seasons.includes(lastWatched.season) ? lastWatched.season : seasons[0]);
  const isFav = (favs.data || []).includes(favKey);

  let continueIndex = null;
  if (lastWatched) {
    const i = playables.findIndex((x) => x.key === lastWatched.key);
    if (i >= 0) continueIndex = lastWatched.finished ? (i + 1 < playables.length ? i + 1 : null) : i;
  }
  const playAt = (index, resume) => {
    const item = playables[index];
    if (!item) return;
    const p = byKey.get(item.key);
    playQueue(playables, index, resume && p && !p.finished ? p.position : 0);
  };
  const meta = [((inf && inf.releaseDate) || '').substring(0, 4) || series.year, (inf && inf.genre) || series.genre,
    seasons.length ? `${seasons.length} season${seasons.length === 1 ? '' : 's'}` : null, ratingText((inf && inf.rating) || series.rating)].filter(Boolean).join('   ·   ');
  return (
    <div class="detail">
      <Backdrop src={(inf && inf.backdrop) || series.cover} opacity={0.18} />
      <div class="detail-col">
        <div class="row series-head">
          <div class="series-poster"><Img src={(inf && inf.cover) || series.cover} alt={series.name} /></div>
          <div class="grow minw0 col">
            <div class="detail-title ell">{series.name}</div>
            {meta ? <div class="muted">{meta}</div> : null}
            <div class="dim clamp3 mt6">{(inf && inf.plot) || series.plot || ''}</div>
            <div class="grow" />
            <div class="row gap12">
              {playables.length ? (continueIndex != null
                ? <Btn primary autoFocus onClick={() => playAt(continueIndex, true)}>▶&nbsp; Continue S{playables[continueIndex].season} E{playables[continueIndex].episode}</Btn>
                : <Btn primary autoFocus onClick={() => playAt(0, false)}>▶&nbsp; Play S{playables[0].season} E{playables[0].episode}</Btn>) : null}
              <Btn onClick={() => call('favorites.toggle', favKey, pid)}>{isFav ? '★ In favorites' : '☆ Add to favorites'}</Btn>
            </div>
          </div>
        </div>
        {info.error ? <div class="warn mt16">{info.error}</div>
          : !info.data ? <div class="muted mt16">Loading episodes…</div>
            : !episodes.length ? <div class="muted mt16">No episodes available</div> : (
              <>
                <div class="row gap8 mt16 wrap">
                  {seasons.map((s) => <Btn key={s} small selected={s === curSeason} onClick={() => setSeason(s)}>Season {s}</Btn>)}
                </div>
                <div class="episode-list">
                  {playables.map((item, idx) => {
                    if (item.season !== curSeason) return null;
                    const ep = episodes[idx];
                    const p = byKey.get(item.key);
                    return (
                      <Card key={item.key} onClick={() => playAt(idx, true)} className="episode">
                        <span class="ep-num">E{ep.number}</span>
                        <div class="grow minw0">
                          <div class="ell">{ep.title || `Episode ${ep.number}`}{p && p.finished ? <span class="muted small">&nbsp;&nbsp;✓ watched</span> : null}</div>
                          {ep.plot ? <div class="small dim ell">{ep.plot}</div> : null}
                          {p && p.duration > 0 && !p.finished ? <ProgressLine value={p.position / p.duration} style={{ width: 180, marginTop: 4 }} /> : null}
                        </div>
                        <span class="muted small">{ep.durationSecs > 0 ? Fmt.duration(ep.durationSecs * 1000) : ''}</span>
                      </Card>
                    );
                  })}
                </div>
              </>
            )}
      </div>
    </div>
  );
}

// ============================================================================ Plex

export function PlexMovie({ serverId, ratingKey }) {
  const q = useQuery(() => call('plex.movie', serverId, ratingKey), [serverId, ratingKey]);
  const source = useQuery(() => call('plex.serverName', serverId), [serverId]);
  if (q.error && !q.data) return <CenterMessage title="Couldn't load this from Plex" subtitle={q.error} />;
  if (!q.data) return <CenterMessage title="Loading…" />;
  const it = q.data;
  const off = it.offset;
  const meta = [it.year, it.genres.slice(0, 3).join(', ') || null, it.durationMs > 0 ? Fmt.duration(it.durationMs) : null, it.contentRating, it.rating > 0 ? `★ ${it.rating.toFixed(1)}` : null, source.data].filter(Boolean).join('   ·   ');
  return (
    <div class="detail">
      <Backdrop src={it.artImg} />
      <div class="detail-body">
        <div class="detail-poster"><Img src={it.img} alt={it.title} /></div>
        <div class="grow minw0">
          <div class="detail-title clamp2">{it.title}</div>
          <div class="muted mt6">{meta}</div>
          {it.convertNote ? <div class="accent small mt4">{it.convertNote}</div> : null}
          <div class="mt18" />
          <ResumeInfo position={off} duration={it.durationMs} />
          <div class="row gap12 wrap">
            {off > 60000 ? (
              <>
                <Btn primary autoFocus onClick={() => playPlex([it], 0, true)}>▶&nbsp; Resume from {Fmt.clock(off)}</Btn>
                <Btn onClick={() => playPlex([it], 0, false)}>Play from start</Btn>
              </>
            ) : <Btn primary autoFocus onClick={() => playPlex([it], 0, false)}>▶&nbsp; Play</Btn>}
            {!it.watched ? <Btn onClick={async () => { await call('plex.markWatched', serverId, it.ratingKey); q.reload(); }}>Mark as watched</Btn> : null}
          </div>
          {it.summary ? <div class="plot mt22 clamp7">{it.summary}</div> : null}
          {it.directors.length ? <div class="muted small mt8">Director: {it.directors.join(', ')}</div> : null}
          {it.cast.length ? <div class="muted small mt8">Cast: {it.cast.join(', ')}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function PlexShow({ serverId, ratingKey }) {
  const q = useQuery(() => call('plex.show', serverId, ratingKey), [serverId, ratingKey]);
  const [season, setSeason] = useState(null);
  if (q.error && !q.data) return <CenterMessage title="Couldn't load this from Plex" subtitle={q.error} />;
  if (!q.data) return <CenterMessage title="Loading…" />;
  const { show, episodes } = q.data;
  const seasons = [...new Set(episodes.map((e) => e.parentIndex).filter((x) => x != null))].sort((a, b) => a - b);
  let continueIndex = episodes.findIndex((e) => e.offset > 60000 && !e.watched);
  if (continueIndex < 0) {
    let lastWatched = -1;
    episodes.forEach((e, i) => { if (e.watched) lastWatched = i; });
    continueIndex = episodes.findIndex((e, i) => i > lastWatched && !e.watched);
    if (continueIndex < 0) continueIndex = null;
  }
  const curSeason = season != null ? season : (continueIndex != null ? episodes[continueIndex].parentIndex : seasons[0]);
  const meta = [show.year, show.genres.slice(0, 3).join(', ') || null, seasons.length ? `${seasons.length} season${seasons.length === 1 ? '' : 's'}` : null,
    show.leafCount ? `${show.viewedLeafCount}/${show.leafCount} watched` : null].filter(Boolean).join('   ·   ');
  return (
    <div class="detail">
      <Backdrop src={show.artImg} opacity={0.18} />
      <div class="detail-col">
        <div class="row series-head">
          <div class="series-poster"><Img src={show.img} alt={show.title} /></div>
          <div class="grow minw0 col">
            <div class="detail-title ell">{show.title}</div>
            {meta ? <div class="muted">{meta}</div> : null}
            <div class="dim clamp3 mt6">{show.summary || ''}</div>
            <div class="grow" />
            <div class="row gap12">
              {episodes.length ? (continueIndex != null
                ? <Btn primary autoFocus onClick={() => playPlex(episodes, continueIndex, true)}>▶&nbsp; {episodes[continueIndex].offset > 60000 ? 'Continue' : 'Play'} S{episodes[continueIndex].parentIndex} E{episodes[continueIndex].index}</Btn>
                : <Btn primary autoFocus onClick={() => playPlex(episodes, 0, false)}>▶&nbsp; Play from the start</Btn>) : null}
            </div>
          </div>
        </div>
        <div class="row gap8 mt16 wrap">
          {seasons.map((s) => <Btn key={s} small selected={s === curSeason} onClick={() => setSeason(s)}>Season {s}</Btn>)}
        </div>
        <div class="episode-list">
          {episodes.map((e, idx) => (e.parentIndex !== curSeason ? null : (
            <Card key={e.ratingKey} onClick={() => playPlex(episodes, idx, true)} className="episode">
              <div class="ep-thumb"><Img src={e.img} /></div>
              <span class="ep-num">E{e.index}</span>
              <div class="grow minw0">
                <div class="ell">{e.title}{e.watched ? <span class="muted small">&nbsp;&nbsp;✓ watched</span> : null}</div>
                {e.summary ? <div class="small dim clamp2">{e.summary}</div> : null}
                {e.offset > 0 && e.durationMs > 0 && !e.watched ? <ProgressLine value={e.offset / e.durationMs} style={{ width: 180, marginTop: 4 }} /> : null}
              </div>
              <span class="muted small">{e.durationMs > 0 ? Fmt.duration(e.durationMs) : ''}</span>
            </Card>
          )))}
        </div>
      </div>
    </div>
  );
}
