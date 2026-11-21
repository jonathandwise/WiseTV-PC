// Search across channels, the TV guide, movies, series and Plex.
import { useEffect, useState } from 'preact/hooks';
import { call, Fmt } from './lib';
import { useStore, setState, nav, tune, toggleFavorite, isFavorite, setSetting, showToast } from './store';
import { CenterMessage, TextInput, Card, Img } from './components';
import { programAt } from './guide';

let lastQuery = '';

export function SearchScreen() {
  const pid = useStore((s) => s.playlistId);
  const history = useStore((s) => s.settings.searchHistory) || [];
  const [query, setQuery] = useState(lastQuery);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  useStore((s) => s.favoriteChanges);

  useEffect(() => {
    lastQuery = query;
    const q = query.trim();
    if (q.length < 2) { setResults(null); return undefined; }
    setBusy(true);
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await call('search.run', pid, q);
        if (alive) setResults(r);
      } catch (e) {
        if (alive) showToast(e.message);
      } finally {
        if (alive) setBusy(false);
      }
    }, 250);
    // Remember searches once typing pauses.
    const h = setTimeout(() => {
      const list = [q, ...history.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 10);
      setSetting('searchHistory', list);
    }, 1500);
    return () => { alive = false; clearTimeout(t); clearTimeout(h); };
  }, [query, pid]);

  const channelMenu = async (c) => {
    const prog = programAt(c, Date.now()) || (c.epgId ? await call('programs.nowOn', pid, c.epgId) : null);
    setState({ programMenu: { channel: c, program: prog } });
  };

  const q = query.trim();
  let body;
  if (q.length < 2 && history.length) {
    body = (
      <>
        <div class="section-header">Recent searches</div>
        {history.map((h) => <Card key={h} onClick={() => setQuery(h)}><div class="pad-row">↺&nbsp; {h}</div></Card>)}
        <Card onClick={() => { setSetting('searchHistory', []); showToast('Search history cleared'); }}><div class="pad-row muted">Clear search history</div></Card>
      </>
    );
  } else if (q.length < 2) body = <CenterMessage title="Type at least two letters" />;
  else if (!results) body = <CenterMessage title="Searching…" />;
  else {
    const empty = !results.channels.length && !results.programs.length && !results.movies.length && !results.series.length && !results.plex.length;
    if (empty) body = <CenterMessage title={busy ? 'Searching…' : `Nothing found for “${q}”`} />;
    else {
      body = (
        <>
          {results.channels.length ? <div class="section-header">Channels</div> : null}
          {results.channels.map((c) => (
            <Result key={`c${c.id}`} title={(isFavorite(c) ? '★ ' : '') + c.name} sub={`${c.number} · ${c.groupName}`} img={c.logo}
              onClick={() => tune(c, true)} onMenu={() => channelMenu(c)} onFav={() => toggleFavorite(c)} />
          ))}
          {results.programs.length ? <div class="section-header">On TV</div> : null}
          {results.programs.map(({ p, c }) => (
            <Result key={`p${p.id}`} title={p.title} sub={`${Fmt.day(p.start)} ${Fmt.range(p.start, p.stop)} · ${isFavorite(c) ? '★ ' : ''}${c.name}`}
              onClick={() => (p.start <= Date.now() && p.stop > Date.now() ? tune(c, true) : setState({ programMenu: { channel: c, program: p } }))}
              onMenu={() => setState({ programMenu: { channel: c, program: p } })} onFav={() => toggleFavorite(c)} />
          ))}
          {results.movies.length ? <div class="section-header">Movies</div> : null}
          {results.movies.map((v) => <Result key={`m${v.id}`} title={v.name} sub={v.year || 'Movie'} img={v.poster} poster onClick={() => nav.push({ name: 'movie', playlistId: pid, id: v.streamId })} />)}
          {results.series.length ? <div class="section-header">Series</div> : null}
          {results.series.map((s) => <Result key={`s${s.id}`} title={s.name} sub={s.year || 'Series'} img={s.cover} poster onClick={() => nav.push({ name: 'series', playlistId: pid, id: s.seriesId })} />)}
          {results.plex.length ? <div class="section-header">Plex</div> : null}
          {results.plex.map((it) => (
            <Result key={`x${it.uid}`} poster img={it.img}
              title={it.type === 'episode' ? `${it.grandparentTitle} · S${it.parentIndex} E${it.index}` : it.title}
              sub={it.type === 'movie' ? `Movie${it.year ? ` · ${it.year}` : ''}` : it.type === 'show' ? 'Series' : it.title}
              onClick={() => {
                if (it.type === 'movie') nav.push({ name: 'plexMovie', serverId: it.serverId, ratingKey: it.ratingKey });
                else if (it.type === 'show') nav.push({ name: 'plexShow', serverId: it.serverId, ratingKey: it.ratingKey });
                else nav.push({ name: 'plexShow', serverId: it.serverId, ratingKey: it.grandparentRatingKey });
              }} />
          ))}
        </>
      );
    }
  }
  return (
    <div class="page">
      <div class="page-title">Search</div>
      <div class="mt12 mb12 search-box">
        <TextInput label="Search channels, programmes, movies and series" value={query} onInput={setQuery} autoFocus placeholder="Type to search…" />
      </div>
      {results && (results.channels.length || results.programs.length) && q.length >= 2
        ? <div class="small muted mb8">On a channel: right-click (or M) for options · Space to add or remove a favorite</div> : null}
      <div class="list">{body}</div>
    </div>
  );
}

function Result({ title, sub, img, poster, onClick, onMenu, onFav }) {
  return (
    <div
      class="card result"
      data-nav
      tabIndex={0}
      onClick={onClick}
      onContextMenu={(e) => { if (onMenu) { e.preventDefault(); onMenu(); } }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onClick(); }
        else if ((e.key === 'm' || e.key === 'M' || e.key === 'ContextMenu') && onMenu) { e.preventDefault(); onMenu(); }
        else if (e.key === ' ' && onFav) { e.preventDefault(); onFav(); }
      }}
    >
      <div class={`result-img ${poster ? 'poster-thumb' : ''}`}><Img src={img} fit={poster ? 'cover' : 'contain'} /></div>
      <div class="grow minw0">
        <div class="ell">{title}</div>
        <div class="small dim ell">{sub}</div>
      </div>
      {onMenu ? <button class="icon-btn" title="Options" onClick={(e) => { e.stopPropagation(); onMenu(); }}>⋯</button> : null}
    </div>
  );
}
