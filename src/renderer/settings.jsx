// Settings, playlists, channel groups, hidden channels, adding a playlist, Plex linking.
import { useEffect, useRef, useState } from 'preact/hooks';
import { call, win, useQuery, Fmt } from './lib';
import { useStore, setState, getState, nav, showToast, setSetting, setActivePlaylist } from './store';
import { CenterMessage, Btn, Card, Dialog, DialogTitle, MenuRow, TextInput, SectionHeader, CheckGlyph } from './components';

const cycle = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];

function SettingRow({ title, value, subtitle, onClick, autoFocus }) {
  return (
    <Card onClick={onClick} autoFocus={autoFocus} className="setting-row">
      <div class="grow minw0">
        <div class="row-title">{title}</div>
        {subtitle ? <div class="small dim">{subtitle}</div> : null}
      </div>
      {value != null ? <div class="setting-value">{value}</div> : null}
    </Card>
  );
}

export function SettingsScreen() {
  const s = useStore((x) => x.settings);
  const info = useStore((x) => x.info);
  const pid = useStore((x) => x.playlistId);
  const playlists = useStore((x) => x.playlists) || [];
  const sync = useStore((x) => x.sync);
  const p = playlists.find((x) => x.id === pid);
  const plex = useQuery(() => call('plex.status'), [], []);
  const storage = useQuery(() => call('rec.storage'), [s.recordingRoot], ['recordings']);
  const provider = useQuery(() => call('conn.providerLimit', pid), [pid], ['playlists']);
  const [plexDialog, setPlexDialog] = useState(null);
  const pl = plex.data;
  const when = (t) => (t > 0 ? `${Fmt.day(t)} ${Fmt.time(t)}` : 'never');

  useEffect(() => {
    const off = window.wise.on('plex', () => plex.reload());
    return off;
  }, []);

  return (
    <div class="page scroll-y">
      <div class="page-title mb10">Settings</div>
      <SectionHeader>Playlists</SectionHeader>
      <SettingRow title="Playlists" value={p ? p.name : 'None'} subtitle="Add, edit, switch or remove playlists" autoFocus onClick={() => nav.push({ name: 'playlists' })} />
      <SettingRow title="Update playlist and TV guide now" subtitle={sync.status || (p ? `Channels updated ${when(p.lastSync)}  ·  guide ${when(p.lastEpgSync)}` : null)}
        onClick={() => { call('sync.refreshAll', true); showToast('Updating in the background…'); }} />
      <SettingRow title="Update automatically every" value={`${s.refreshHours} hours`} onClick={() => setSetting('refreshHours', cycle([6, 12, 24, 48], s.refreshHours))} />

      <SectionHeader>Plex</SectionHeader>
      {!pl ? null : !pl.linked ? (
        <SettingRow title="Link your Plex account" subtitle="Your Plex movies and shows appear in Movies and Series" onClick={() => setPlexDialog('link')} />
      ) : (
        <>
          <SettingRow title="Plex account" value={pl.user} onClick={() => setPlexDialog('account')} />
          <SettingRow title="Plex servers"
            value={pl.servers.length === 0 ? 'Choose…' : pl.servers.length === 1 ? pl.servers[0].name : `${pl.servers.length} servers`}
            subtitle={pl.servers.length > 1 ? pl.servers.map((x) => x.name).join(', ') : pl.servers[0] && pl.servers[0].uri ? (pl.servers[0].local ? 'Connected on your home network' : 'Connected over the internet') : null}
            onClick={() => setPlexDialog('servers')} />
          <SettingRow title="Plex quality away from home" value={s.plexRemoteKbps === 0 ? 'Original' : `${s.plexRemoteKbps / 1000} Mbps`} subtitle="At home, files always play at full quality"
            onClick={() => setSetting('plexRemoteKbps', cycle([0, 20000, 12000, 8000, 4000, 2000], s.plexRemoteKbps))} />
        </>
      )}

      <SectionHeader>Channels & guide</SectionHeader>
      <SettingRow title="Channel groups" subtitle="Show or hide groups. Hidden groups aren't loaded into the guide." onClick={() => nav.push({ name: 'manageGroups', playlistId: pid, kind: 'live' })} />
      <SettingRow title="Hidden channels" onClick={() => nav.push({ name: 'hiddenChannels', playlistId: pid })} />
      <SettingRow title="Movie categories" onClick={() => nav.push({ name: 'manageGroups', playlistId: pid, kind: 'movie' })} />
      <SettingRow title="Series categories" onClick={() => nav.push({ name: 'manageGroups', playlistId: pid, kind: 'series' })} />
      <SettingRow title="Days of TV guide to keep" value={`${s.epgDays} days`} subtitle="Fewer days = faster updates. Applies at the next guide update." onClick={() => setSetting('epgDays', cycle([2, 3, 4, 5, 7, 10], s.epgDays))} />

      <SectionHeader>Playback</SectionHeader>
      <SettingRow title="Live stream format" value={s.liveFormat === 'ts' ? 'MPEG-TS' : 'HLS'} subtitle="Xtream playlists only. Try the other one if channels stutter or won't start."
        onClick={() => { setSetting('liveFormat', s.liveFormat === 'ts' ? 'm3u8' : 'ts'); showToast('Applies after the next playlist update'); }} />
      <SettingRow title="Up/Down in the player" value={s.invertChannelKeys ? 'Up = next channel' : 'Up = previous channel'} onClick={() => setSetting('invertChannelKeys', !s.invertChannelKeys)} />
      <SettingRow title="Play last channel at startup" value={s.autoplayLast ? 'On' : 'Off'} onClick={() => setSetting('autoplayLast', !s.autoplayLast)} />
      <SettingRow title="Hardware video decoding" value={s.hwdec ? 'On' : 'Off'} subtitle="Uses your graphics card. Turn off if the picture shows glitches. Takes effect after restarting WiseTV."
        onClick={() => { setSetting('hwdec', !s.hwdec); showToast('Restart WiseTV for this to take effect'); }} />
      <SettingRow title="Dolby / DTS passthrough" value={s.audioPassthrough ? 'On' : 'Off'} subtitle="Sends surround sound to an AV receiver as-is (over HDMI or optical). Leave off for speakers or headphones. Takes effect after restarting WiseTV."
        onClick={() => { setSetting('audioPassthrough', !s.audioPassthrough); showToast('Restart WiseTV for this to take effect'); }} />

      <SectionHeader>Recording</SectionHeader>
      <SettingRow title="Save recordings to" value={storage.data ? `${Fmt.size(storage.data.free)} free` : null} subtitle={storage.data ? storage.data.dir : null}
        onClick={async () => {
          const dir = await win('chooseFolder', storage.data && storage.data.dir);
          if (dir) setSetting('recordingRoot', dir);
        }} />
      {s.recordingRoot ? <SettingRow title="Use the standard folder again" subtitle="Videos\\WiseTV" onClick={() => setSetting('recordingRoot', '')} /> : null}
      <SettingRow title="Start recordings early by" value={`${s.padBefore} min`} onClick={() => setSetting('padBefore', cycle([0, 1, 2, 5, 10], s.padBefore))} />
      <SettingRow title="Keep recording after the end by" value={`${s.padAfter} min`} subtitle="Covers shows that run late" onClick={() => setSetting('padAfter', cycle([0, 2, 5, 10, 15, 30], s.padAfter))} />
      <SettingRow title="Connection limit" value={s.connectionLimit === 0 ? `Provider (${provider.data || 1})` : String(s.connectionLimit)} subtitle="How many streams can play or record at once"
        onClick={() => setSetting('connectionLimit', cycle([0, 1, 2, 3, 4], s.connectionLimit))} />

      <SectionHeader>Windows</SectionHeader>
      <SettingRow title="Closing the window" value={s.closeToTray ? 'Keeps WiseTV running' : 'Quits WiseTV'} subtitle="Keep it running (by the clock) so scheduled recordings still happen"
        onClick={() => setSetting('closeToTray', !s.closeToTray)} />
      <SettingRow title="Start with Windows" value={s.startWithWindows ? 'On' : 'Off'} subtitle="Starts quietly by the clock when you sign in, ready for recordings"
        onClick={() => setSetting('startWithWindows', !s.startWithWindows)} />
      <SettingRow title="Video drawing" value={info.overlayMode === 'shape' ? 'Compatibility' : 'Standard'} subtitle="Try Compatibility if the picture doesn't show behind the menus. Takes effect after restarting WiseTV."
        onClick={() => { setSetting('overlayMode', info.overlayMode === 'shape' ? 'transparent' : 'shape'); showToast('Restart WiseTV for this to take effect'); }} />

      <SectionHeader>About</SectionHeader>
      <SettingRow title="WiseTV for Windows" value={`Version ${info.version}`} subtitle="Keyboard: arrows move · Enter selects · Esc goes back · M options · F full screen" onClick={() => {}} />
      <UpdateRow />
      <SettingRow title="Open the log file" subtitle="Useful if something isn't working" onClick={() => win('openPath', info.logFile)} />
      <SettingRow title="Quit WiseTV" onClick={() => win('quit')} />
      <div style={{ height: 40 }} />
      {plexDialog ? <PlexDialogs which={plexDialog} onChange={setPlexDialog} /> : null}
    </div>
  );
}

function UpdateRow() {
  const u = useStore((x) => x.update);
  const st = u ? u.status : 'idle';
  const value = st === 'checking' ? 'Checking…' : st === 'current' ? 'Up to date'
    : st === 'available' || st === 'ready' ? `Version ${u.latest.version} available` : st === 'downloading' ? `Downloading ${Math.round(u.progress * 100)}%` : st === 'error' ? 'Problem' : null;
  const sub = st === 'error' ? u.error : u && u.checkedAt ? `Checked ${Fmt.day(u.checkedAt)} ${Fmt.time(u.checkedAt)}. WiseTV also checks by itself when it starts.` : 'WiseTV checks by itself when it starts.';
  return (
    <SettingRow title="Check for updates" value={value} subtitle={sub} onClick={async () => {
      setState({ updateDismissed: null, updateManual: true });
      const r = await call('update.check');
      if (r.status === 'current') showToast('WiseTV is up to date');
    }} />
  );
}

// ============================================================================ playlists

function describe(p) {
  return [p.type === 'xtream' ? 'Xtream Codes' : 'M3U', p.expiresAt > 0 ? `expires ${Fmt.date(p.expiresAt)}` : null,
    p.type === 'xtream' ? `${p.maxConnections} connection${p.maxConnections === 1 ? '' : 's'}` : null,
    p.lastSync > 0 ? `updated ${Fmt.day(p.lastSync)}` : 'not loaded yet'].filter(Boolean).join('  ·  ');
}

export function PlaylistsScreen() {
  const playlists = useStore((s) => s.playlists) || [];
  const pid = useStore((s) => s.playlistId);
  const [open, setOpen] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const close = () => { setOpen(null); setConfirm(false); };
  return (
    <div class="page">
      <div class="row center-v">
        <div class="page-title grow">Playlists</div>
        <div class="row gap10">
          <Btn onClick={() => nav.push({ name: 'addPlaylist', tab: 'free' })}>+ Free channels</Btn>
          <Btn primary autoFocus onClick={() => nav.push({ name: 'addPlaylist' })}>+ Add playlist</Btn>
        </div>
      </div>
      <div class="list mt14">
        {playlists.map((p) => (
          <Card key={p.id} selected={p.id === pid} onClick={() => setOpen(p)}>
            <div class="pad-row">
              <div class="row-title">{p.name}{p.id === pid ? '   (active)' : ''}</div>
              <div class="small dim ell">{describe(p)}</div>
            </div>
          </Card>
        ))}
      </div>
      {open ? (
        <Dialog onDismiss={close}>
          <DialogTitle title={open.name} subtitle={describe(open)} />
          {!confirm ? (
            <>
              {open.id !== pid ? <MenuRow text="Use this playlist" autoFocus onClick={async () => { close(); await setActivePlaylist(open.id); nav.resetTo({ name: 'main', section: 'guide' }); }} /> : null}
              <MenuRow text="Update now" autoFocus={open.id === pid} onClick={async () => {
                const p = open;
                close();
                showToast(`Updating ${p.name}…`);
                try { await call('sync.playlist', p.id, true); showToast(`${p.name} updated`); } catch (e) { showToast(`Update failed: ${e.message}`); }
              }} />
              <MenuRow text="Edit" onClick={() => { const id = open.id; close(); nav.push({ name: 'addPlaylist', editId: id }); }} />
              <MenuRow text="Delete" danger onClick={() => setConfirm(true)} />
              <MenuRow text="Close" onClick={close} />
            </>
          ) : (
            <>
              <div>Delete “{open.name}” and its channels, guide and favorites? Finished recordings are kept.</div>
              <MenuRow text="Delete" danger autoFocus onClick={async () => {
                const id = open.id;
                close();
                const next = await call('playlists.delete', id);
                if (next > 0) setState({ playlistId: next });
                showToast('Playlist deleted');
              }} />
              <MenuRow text="Cancel" onClick={() => setConfirm(false)} />
            </>
          )}
        </Dialog>
      ) : null}
    </div>
  );
}

// ============================================================================ groups

export function ManageGroupsScreen({ playlistId: pid, kind, firstRun }) {
  const groups = useQuery(() => call('groups.all', pid, kind), [pid, kind], ['channel_groups']);
  const counts = useQuery(() => (kind === 'live' ? call('groups.counts', pid) : {}), [pid, kind]);
  const changed = useRef(false);
  const list = groups.data || [];
  const what = kind === 'live' ? 'channel groups' : kind === 'movie' ? 'movie categories' : 'series categories';
  const done = () => {
    if (kind === 'live' && (firstRun || changed.current)) call('sync.epg', pid);
    if (firstRun) {
      nav.resetTo({ name: 'main', section: 'guide' });
      showToast('Loading the TV guide in the background…');
    } else nav.pop();
  };
  return (
    <div class="page">
      <div class="page-title">Choose which {what} to show</div>
      <div class="muted mt4">{firstRun ? "Hiding groups you don't watch keeps the guide fast. You can change this later in Settings." : `${list.filter((g) => !g.hidden).length} of ${list.length} shown.`}</div>
      <div class="row gap10 mt14 mb14">
        <Btn primary autoFocus onClick={done}>Done</Btn>
        <Btn onClick={() => { changed.current = true; call('groups.setAllHidden', pid, kind, false); }}>Show all</Btn>
        <Btn onClick={() => { changed.current = true; call('groups.setAllHidden', pid, kind, true); }}>Hide all</Btn>
      </div>
      {!list.length ? <CenterMessage title={groups.data ? 'Nothing here yet' : 'Loading…'} /> : (
        <div class="list">
          {list.map((g) => (
            <Card key={g.categoryId} onClick={() => { changed.current = true; call('groups.setHidden', pid, kind, g.categoryId, !g.hidden); }}>
              <div class="row center-v gap14 pad-row">
                <CheckGlyph on={!g.hidden} />
                <span class="grow ell">{g.name}</span>
                {counts.data && counts.data[g.categoryId] != null ? <span class="small dim">{counts.data[g.categoryId]} channels</span> : null}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function HiddenChannelsScreen({ playlistId: pid }) {
  const hidden = useQuery(() => call('channels.hidden', pid), [pid], ['channels']);
  const list = hidden.data || [];
  return (
    <div class="page">
      <div class="page-title">Hidden channels</div>
      <div class="muted mt4 mb14">Select a channel to show it again.</div>
      {!list.length ? <CenterMessage title={hidden.data ? 'No hidden channels' : 'Loading…'} /> : (
        <div class="list">
          {list.map((ch, i) => (
            <Card key={ch.id} autoFocus={i === 0} onClick={() => call('channels.setHidden', ch.id, false)}>
              <div class="row center-v pad-row gap14">
                <span class="muted" style={{ width: 50 }}>{ch.number}</span>
                <span class="grow ell">{ch.name}</span>
                <span class="small dim">{ch.groupName}</span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================ add / edit playlist

export function AddPlaylistScreen({ editId, firstRun, tab }) {
  const [type, setType] = useState(tab || 'xtream');
  const [f, setF] = useState({ name: '', server: '', username: '', password: '', url: '', epgUrl: '', userAgent: '', epgShiftMinutes: 0 });
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const editing = editId != null;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (!editing) return;
    call('playlists.get', editId).then((p) => {
      if (!p) return;
      setType(p.type);
      setF({ name: p.name, server: p.type === 'xtream' ? p.url : '', username: p.username, password: p.password, url: p.type === 'm3u' ? p.url : '', epgUrl: p.epgUrl, userAgent: p.userAgent, epgShiftMinutes: p.epgShiftMinutes });
    });
  }, [editId]);

  const submit = async () => {
    setError(null);
    if (type === 'xtream' && (!f.server.trim() || !f.username.trim() || !f.password.trim())) { setError('Enter the server address, username and password.'); return; }
    if (type === 'm3u' && !f.url.trim()) { setError('Enter the M3U link.'); return; }
    let createdId = null;
    try {
      if (editing) {
        setBusy(type === 'xtream' ? 'Checking your login…' : 'Saving…');
        await call('playlists.save', editId, f);
        setBusy('Updating channels…');
        await call('sync.playlist', editId, true);
        showToast('Playlist saved');
        nav.pop();
        return;
      }
      setBusy(type === 'xtream' ? 'Checking your login…' : 'Adding playlist…');
      const r = type === 'xtream' ? await call('playlists.addXtream', f) : await call('playlists.addM3u', f);
      createdId = r.id;
      if (r.inUseMax) showToast(`Your provider's ${r.inUseMax === 1 ? '1 connection is' : `${r.inUseMax} connections are`} in use by another app or device right now.`, 9000);
      setBusy('Loading channels, movies and series…');
      await call('sync.playlist', r.id, false);
      await setActivePlaylist(r.id);
      setState({ playlistId: r.id });
      nav.resetTo({ name: 'manageGroups', playlistId: r.id, kind: 'live', firstRun: true });
    } catch (e) {
      setError(e.message || 'Something went wrong.');
      // A playlist whose first load failed is removed so it can be re-added cleanly.
      if (createdId && !(await call('playlists.hasChannels', createdId))) await call('playlists.delete', createdId);
    } finally {
      setBusy(null);
    }
  };

  // Show progress messages from the sync while busy.
  const sync = useStore((s) => s.sync);
  const busyText = busy && sync.status ? sync.status : busy;

  return (
    <div class="page add-playlist scroll-y">
      <div class="add-col">
        {firstRun ? (
          <>
            <img src="../assets/logo_lockup_light.png" class="lockup" alt="WiseTV" />
            <div class="muted mb18">Welcome! Add your IPTV playlist to get started.</div>
          </>
        ) : <div class="page-title mb18">{editing ? 'Edit playlist' : 'Add a playlist'}</div>}
        <div class="row gap10">
          <Btn selected={type === 'xtream'} disabled={editing} autoFocus={!editing} onClick={() => setType('xtream')}>Xtream Codes</Btn>
          <Btn selected={type === 'm3u'} disabled={editing} onClick={() => setType('m3u')}>M3U link</Btn>
          {!editing ? <Btn selected={type === 'free'} onClick={() => setType('free')}>Free channels</Btn> : null}
        </div>
        {type === 'free' ? <FreePlaylists firstRun={firstRun} /> : (<>
        <div class="form mt14">
          <TextInput label="Playlist name (optional)" value={f.name} onInput={set('name')} autoFocus={editing} onEnter={submit} />
          {type === 'xtream' ? (
            <>
              <TextInput label="Server address" value={f.server} onInput={set('server')} hint="e.g. http://example.com:8080" onEnter={submit} />
              <TextInput label="Username" value={f.username} onInput={set('username')} onEnter={submit} />
              <TextInput label="Password" value={f.password} onInput={set('password')} secret onEnter={submit} />
            </>
          ) : (
            <TextInput label="M3U link" value={f.url} onInput={set('url')} hint="http://…  (an Xtream get.php link also works and adds movies and series)" onEnter={submit} />
          )}
          <TextInput label="Extra TV guide (XMLTV) link (optional)" value={f.epgUrl} onInput={set('epgUrl')} onEnter={submit}
            hint={type === 'xtream' ? "Your provider's guide is used automatically" : "Used if the playlist doesn't include one"} />
          {editing ? (
            <>
              <TextInput label="User agent (optional)" value={f.userAgent} onInput={set('userAgent')} hint="Only if your provider requires one" />
              <div><Btn onClick={() => set('epgShiftMinutes')(f.epgShiftMinutes >= 720 ? -720 : f.epgShiftMinutes + 60)}>Guide time shift: {f.epgShiftMinutes >= 0 ? '+' : ''}{f.epgShiftMinutes / 60} h</Btn></div>
            </>
          ) : null}
        </div>
        {error ? <div class="warn mt12">{error}</div> : null}
        <div class="row gap10 mt18">
          <Btn primary disabled={!!busy} onClick={submit}>{busy ? busyText : editing ? 'Save' : 'Add playlist'}</Btn>
          {!firstRun ? <Btn disabled={!!busy} onClick={() => nav.pop()}>Cancel</Btn> : null}
        </div>
        {!editing ? <div class="small muted mt18">Use the same login as on your Fire Stick. Your provider allows a set number of connections, so the PC and the Fire Stick may not be able to play at the same time.</div> : null}
        </>)}
      </div>
    </div>
  );
}

/** One-click free channel playlists. */
function FreePlaylists({ firstRun }) {
  const presets = useQuery(() => call('presets.list'), [], ['playlists']);
  const playlists = useStore((s) => s.playlists) || [];
  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});
  const add = async (p) => {
    setBusy((b) => ({ ...b, [p.id]: true }));
    setErrors((e) => ({ ...e, [p.id]: null }));
    try {
      const r = await call('playlists.addPreset', p.id);
      if (!r.existed) showToast(`${p.name} added. Its TV guide loads in the background.`);
      if (firstRun || !getState().playlistId) {
        await setActivePlaylist(r.id);
        setState({ playlistId: r.id });
      }
    } catch (e) {
      setErrors((x) => ({ ...x, [p.id]: e.message }));
    } finally {
      setBusy((b) => ({ ...b, [p.id]: false }));
    }
  };
  const anyBusy = Object.values(busy).some(Boolean);
  return (
    <div class="mt14">
      <div class="muted mb12">Free, ad-supported channels. Add as many as you like; switch between playlists from the TV guide's group menu.</div>
      <div class="list free-list">
        {(presets.data || []).map((p) => (
          <Card key={p.id} onClick={() => { if (!p.added && !busy[p.id]) add(p); }}>
            <div class="row center-v gap14 pad-row">
              <div class="grow minw0">
                <div class="row-title">{p.name}</div>
                <div class="small dim ell">{p.note}</div>
                {errors[p.id] ? <div class="small warn">{errors[p.id]}</div> : null}
              </div>
              {p.added ? <span class="accent small">✓ Added</span>
                : busy[p.id] ? <span class="muted small">Adding…</span>
                  : <span class="btn small">+ Add</span>}
            </div>
          </Card>
        ))}
      </div>
      <div class="row gap10 mt14">
        <Btn primary disabled={anyBusy || !playlists.length} onClick={() => nav.resetTo({ name: 'main', section: 'guide' })}>
          {anyBusy ? 'Adding…' : 'Done: go to the TV guide'}
        </Btn>
        {!firstRun ? <Btn disabled={anyBusy} onClick={() => nav.pop()}>Cancel</Btn> : null}
      </div>
    </div>
  );
}

// ============================================================================ Plex

function PlexDialogs({ which, onChange }) {
  if (which === 'link') return <LinkDialog onChange={onChange} />;
  if (which === 'servers') return <ServersDialog onChange={onChange} />;
  return (
    <Dialog onDismiss={() => onChange(null)}>
      <DialogTitle title="Plex account" subtitle={getState().settings.plexUser} />
      <MenuRow text="Choose servers" autoFocus onClick={() => onChange('servers')} />
      <MenuRow text="Unlink Plex" danger onClick={async () => { await call('plex.unlink'); onChange(null); showToast('Plex unlinked'); }} />
      <MenuRow text="Close" onClick={() => onChange(null)} />
    </Dialog>
  );
}

/** Shows a short code to enter at plex.tv/link, and waits until it has been entered. */
function LinkDialog({ onChange }) {
  const [pin, setPin] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    setPin(null);
    (async () => {
      try {
        const p = await call('plex.startPin');
        if (!alive) return;
        setPin(p);
        const end = Date.now() + 15 * 60000;
        while (alive && Date.now() < end) {
          await new Promise((r) => setTimeout(r, 2000));
          const token = await call('plex.pollPin', p);
          if (token && alive) {
            await call('plex.finishLink', token);
            onChange('servers');
            return;
          }
        }
      } catch (e) {
        if (alive) setError(`Couldn't reach plex.tv: ${e.message}`);
      }
    })();
    return () => { alive = false; };
  }, [attempt]);
  return (
    <Dialog onDismiss={() => onChange(null)}>
      <DialogTitle title="Link your Plex account" />
      {error ? (
        <>
          <div class="warn">{error}</div>
          <MenuRow text="Try again" autoFocus onClick={() => setAttempt(attempt + 1)} />
        </>
      ) : !pin ? <div class="muted">Getting a code…</div> : (
        <>
          <div class="muted">In your web browser, go to</div>
          <div class="link-url">plex.tv/link</div>
          <div class="muted mt8">and enter this code:</div>
          <div class="link-code">{pin.code}</div>
          <MenuRow text="Open plex.tv/link in my browser" autoFocus onClick={() => win('openExternal', 'https://plex.tv/link')} />
          <div class="small muted">This continues by itself once you've entered the code.</div>
        </>
      )}
      <MenuRow text="Cancel" onClick={() => onChange(null)} />
    </Dialog>
  );
}

function ServersDialog({ onChange }) {
  const [list, setList] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const apply = async (chosen) => {
    setBusy(`Connecting to ${chosen.map((x) => x.name).join(', ') || 'nothing'}…`);
    const results = await call('plex.setServers', chosen);
    const failed = Object.entries(results).filter(([, v]) => v);
    setBusy(null);
    onChange(null);
    showToast(failed.length ? `Couldn't connect to ${failed.map(([k, v]) => `${k} (${v})`).join(', ')}` : chosen.length ? 'Plex is ready: look in Movies and Series' : 'No Plex servers in use', 7000);
  };
  useEffect(() => {
    (async () => {
      try {
        const st = await call('plex.status');
        const l = await call('plex.accountServers');
        setList(l);
        setChecked(new Set(st.servers.map((x) => x.id)));
        if (!st.servers.length && l.length) apply(l); // first link: use everything
      } catch (e) {
        setError(`Couldn't get your servers from plex.tv: ${e.message}`);
      }
    })();
  }, []);
  return (
    <Dialog onDismiss={() => onChange(null)}>
      <DialogTitle title="Plex servers" subtitle="Choose which servers' movies and shows to show" />
      {busy ? <div class="muted">{busy}</div> : !list && !error ? <div class="muted">Looking for servers…</div> : (
        <>
          {error ? <div class="warn">{error}</div> : null}
          {list && !list.length ? <div>There are no Plex servers on this account.</div> : null}
          {(list || []).map((srv, i) => (
            <Card key={srv.id} autoFocus={i === 0} onClick={() => { const n = new Set(checked); if (n.has(srv.id)) n.delete(srv.id); else n.add(srv.id); setChecked(n); }}>
              <div class="row center-v gap14 pad-row">
                <CheckGlyph on={checked.has(srv.id)} />
                <span class="grow">{srv.name}</span>
                <span class="small dim">{srv.owned ? 'yours' : 'shared with you'}</span>
              </div>
            </Card>
          ))}
          {list && list.length ? <MenuRow text="Save" onClick={() => apply(list.filter((x) => checked.has(x.id)))} /> : null}
        </>
      )}
      <MenuRow text="Cancel" onClick={() => onChange(null)} />
    </Dialog>
  );
}
