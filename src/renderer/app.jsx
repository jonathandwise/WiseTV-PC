// The app shell: menu rail, screen routing, global keys, toasts and dialogs.
import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { call, win } from './lib';
import { useStore, setState, getState, nav, current, boot, showToast, tune } from './store';
import { installKeys, setBackHandler } from './keys';
import { startVideoLayout, setShapeMode } from './video';
import { CenterMessage, Icon } from './components';
import { GuideScreen } from './guide';
import { PlayerScreen } from './player';
import { VodBrowser, MovieDetail, SeriesDetail, PlexMovie, PlexShow } from './vod';
import { RecordingsScreen } from './recordings';
import { SearchScreen } from './search';
import { SettingsScreen, PlaylistsScreen, ManageGroupsScreen, HiddenChannelsScreen, AddPlaylistScreen } from './settings';
import { ProgramDialog, BlockedDialog, TookOverDialog, UpdateDialog } from './dialogs';

const SECTIONS = [
  ['guide', 'TV Guide'],
  ['movies', 'Movies'],
  ['series', 'Series'],
  ['recordings', 'Recordings'],
  ['search', 'Search'],
  ['settings', 'Settings'],
];

function Rail({ section }) {
  return (
    <div class="rail">
      <img class="rail-logo" src="../assets/logo_owl.png" alt="WiseTV" draggable={false} />
      {SECTIONS.map(([id, label], i) => (
        <button
          key={id}
          data-nav
          class={`rail-item ${id === section ? 'selected' : ''}`}
          title={`${label} (Ctrl+${i + 1})`}
          onClick={() => { if (id !== section) nav.replaceTop({ name: 'main', section: id }); }}
        >
          <Icon name={id} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

function MainScreen({ section }) {
  // Live TV belongs to the guide; elsewhere it would be sound with no picture.
  useEffect(() => {
    if (section === 'guide') call('player.unpark');
    else call('player.park');
  }, [section]);
  let body;
  switch (section) {
    case 'movies': body = <VodBrowser kind="movie" key="movie" />; break;
    case 'series': body = <VodBrowser kind="series" key="series" />; break;
    case 'recordings': body = <RecordingsScreen />; break;
    case 'search': body = <SearchScreen />; break;
    case 'settings': body = <SettingsScreen />; break;
    default: body = <GuideScreen />;
  }
  return (
    <div class="main">
      <Rail section={section} />
      <div class="main-body">{body}</div>
    </div>
  );
}

function Screen({ s }) {
  switch (s.name) {
    case 'main': return <MainScreen section={s.section} />;
    case 'player': return <PlayerScreen />;
    case 'movie': return <MovieDetail playlistId={s.playlistId} id={s.id} />;
    case 'series': return <SeriesDetail playlistId={s.playlistId} id={s.id} />;
    case 'plexMovie': return <PlexMovie serverId={s.serverId} ratingKey={s.ratingKey} />;
    case 'plexShow': return <PlexShow serverId={s.serverId} ratingKey={s.ratingKey} />;
    case 'playlists': return <PlaylistsScreen />;
    case 'manageGroups': return <ManageGroupsScreen playlistId={s.playlistId} kind={s.kind} firstRun={!!s.firstRun} />;
    case 'hiddenChannels': return <HiddenChannelsScreen playlistId={s.playlistId} />;
    case 'addPlaylist': return <AddPlaylistScreen editId={s.editId} firstRun={!!s.firstRun} tab={s.tab} />;
    default: return <CenterMessage title="Unknown screen" />;
  }
}

function SubHeader({ s }) {
  // Screens opened on top of the main ones get a back button.
  if (s.name === 'main' || s.name === 'player' || (s.name === 'addPlaylist' && s.firstRun) || (s.name === 'manageGroups' && s.firstRun)) return null;
  return (
    <div class="subheader">
      <button class="back-btn" data-nav title="Back (Esc)" onClick={() => nav.pop()}>
        <Icon name="back" size={18} /> Back
      </button>
    </div>
  );
}

function goBack() {
  const st = getState();
  if (st.programMenu) { setState({ programMenu: null }); return; }
  const cur = current();
  if (cur.name === 'addPlaylist' && cur.firstRun) return;
  if (cur.name === 'player' && st.fullscreen) {
    // Esc in full-screen video first leaves full screen, like other players.
    win('setFullscreen', false);
    return;
  }
  if (nav.pop()) return;
  if (cur.name === 'main' && cur.section !== 'guide') nav.replaceTop({ name: 'main', section: 'guide' });
}

function globalKeys(e) {
  const typing = document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (e.key === 'F11' || ((e.key === 'f' || e.key === 'F') && !typing && !e.ctrlKey && !e.altKey)) {
    win('toggleFullscreen');
    return true;
  }
  if (e.ctrlKey && /^[1-6]$/.test(e.key) && !getState().programMenu) {
    const sec = SECTIONS[Number(e.key) - 1][0];
    nav.resetTo({ name: 'main', section: sec });
    return true;
  }
  if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
    nav.resetTo({ name: 'main', section: 'search' });
    return true;
  }
  return false;
}

/** The update prompt waits until you're not watching full screen and no other dialog is open. */
function showUpdate(st, isPlayer) {
  const u = st.update;
  if (!u || isPlayer || st.programMenu || st.blocked || st.tookOver) return false;
  if (!['available', 'downloading', 'ready', 'installing', 'error'].includes(u.status)) return false;
  if (u.status === 'error' && !u.latest) return !!st.updateManual && st.updateDismissed !== 'error';
  const v = u.latest ? u.latest.version : '';
  return st.updateDismissed !== v || u.status === 'installing';
}

function App() {
  const st = useStore();
  const s = st.nav[st.nav.length - 1];
  const started = useRef(false);

  // One-time startup: play the last channel.
  useEffect(() => {
    if (!st.ready || started.current || !st.playlistId) return;
    started.current = true;
    if (st.settings.autoplayLast && !st.player.nowPlaying && st.settings.lastChannelId) {
      call('channels.get', st.settings.lastChannelId).then((ch) => {
        if (ch && ch.playlistId === getState().playlistId && current().name === 'main' && current().section === 'guide') tune(ch, false);
      });
    }
  }, [st.ready, st.playlistId]);

  // Hidden to the tray and back: the guide picks its channel up again.
  useEffect(() => {
    if (st.shown && current().name === 'main' && current().section === 'guide') call('player.unpark');
  }, [st.shown]);

  if (!st.ready) return <CenterMessage title="Loading…" />;
  const isPlayer = s.name === 'player';
  return (
    <div class={`app ${isPlayer ? 'video-mode' : ''}`}>
      <SubHeader s={s} />
      <div class="screen">
      <Screen s={s} key={`${st.nav.length}|${s.name}|${s.section || ''}|${s.id || s.ratingKey || s.kind || s.tab || ''}`} />
      </div>
      {st.toast ? <div class="toast ov">{st.toast}</div> : null}
      {st.programMenu ? <ProgramDialog menu={st.programMenu} onDismiss={() => setState({ programMenu: null })} /> : null}
      {st.blocked ? <BlockedDialog b={st.blocked} /> : null}
      {st.tookOver ? <TookOverDialog t={st.tookOver} /> : null}
      {showUpdate(st, isPlayer) ? <UpdateDialog u={st.update} /> : null}
    </div>
  );
}

(async () => {
  window.__wt = { getState, nav };
  setBackHandler(goBack);
  installKeys(globalKeys);
  render(<App />, document.getElementById('app'));
  await boot();
  const info = getState().info;
  setShapeMode(info.overlayMode === 'shape');
  document.body.classList.toggle('shape-mode', info.overlayMode === 'shape');
  startVideoLayout();
  window.addEventListener('contextmenu', (e) => {
    if (!e.defaultPrevented && !(e.target && e.target.tagName === 'INPUT')) e.preventDefault();
  });
  void showToast;
})();
