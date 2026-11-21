// App-wide dialogs: programme options, "a recording is using your connection", "recording started".
import { useEffect, useState } from 'preact/hooks';
import { call, win, useQuery, Fmt } from './lib';
import { useStore, setState, getState, tune, playVod, toggleFavorite, isFavorite, showToast, stopRecordingThen, retryBlocked, watchRecordingChannel, current, nav } from './store';
import { Dialog, DialogTitle, MenuRow, ProgressLine } from './components';

export function ProgramDialog({ menu, onDismiss }) {
  const ch = menu.channel;
  const p = menu.program;
  const now = Date.now();
  const recs = useQuery(() => call('rec.list'), [], ['recordings']);
  const rules = useQuery(() => call('rec.rules'), [], ['rules']);
  const all = recs.data ? recs.data.all : [];
  const existing = p ? all.find((r) => r.playlistId === ch.playlistId && r.epgKey === p.epgKey && r.programStart === p.start && (r.status === 'scheduled' || r.status === 'recording')) : null;
  const rule = p ? (rules.data || []).find((r) => r.playlistId === ch.playlistId && r.title.toLowerCase() === p.title.toLowerCase() && r.epgKey === p.epgKey) : null;
  const airing = !p || (p.start <= now && p.stop > now);
  const finished = p && p.stop <= now;
  const loading = !recs.data || !rules.data;

  // Close first, then do the work: nothing lingers on screen to be pressed twice.
  const act = async (fn) => {
    onDismiss();
    try {
      const msg = await fn();
      if (msg) showToast(msg, 6000);
    } catch (e) {
      showToast(e.message);
    }
  };

  const actions = [];
  if (airing) actions.push({ label: 'Watch now', onClick: () => { onDismiss(); tune(ch, true); } });
  if (!finished && !loading) {
    if (existing && existing.status === 'recording') actions.push({ label: 'Stop recording', danger: true, onClick: () => act(async () => { await call('rec.stop', existing.id); return 'Recording stopped'; }) });
    else if (existing) actions.push({ label: 'Cancel recording', danger: true, onClick: () => act(async () => { await call('rec.cancel', existing.id); return 'Recording cancelled'; }) });
    else if (!p) {
      for (const m of [30, 60, 120, 180]) {
        actions.push({ label: `Record the next ${m < 60 ? `${m} minutes` : m === 60 ? 'hour' : `${m / 60} hours`}`, onClick: () => act(() => call('rec.record', ch, null, m)) });
      }
    } else actions.push({ label: airing ? 'Record (from now)' : 'Record', onClick: () => act(() => call('rec.record', ch, p)) });
  }
  if (p && !loading) {
    if (rule) actions.push({ label: 'Stop recording this series', danger: true, onClick: () => act(async () => { await call('rec.deleteRule', rule.id); return 'Series recording removed'; }) });
    else if (!finished) actions.push({ label: 'Record series', detail: 'every airing on this channel', onClick: () => act(() => call('rec.addSeriesRule', ch, p)) });
  }
  if (ch.id > 0) {
    actions.push({ label: isFavorite(ch) ? 'Remove from favorites' : 'Add to favorites', detail: 'or press Space in the guide', onClick: () => { onDismiss(); toggleFavorite(ch); } });
    actions.push({ label: 'Hide this channel', onClick: () => act(async () => { await call('channels.setHidden', ch.id, true); return `${ch.name} is hidden. Unhide it in Settings → Hidden channels.`; }) });
  }
  actions.push({ label: 'Close', onClick: onDismiss });

  const sub = p ? [p.episode, p.subtitle, p.category].filter(Boolean).join(' · ') : '';
  return (
    <Dialog onDismiss={onDismiss}>
      <DialogTitle title={p ? p.title : ch.name} subtitle={[`${ch.number}  ${ch.name}`, p ? `${Fmt.day(p.start)}  ${Fmt.range(p.start, p.stop)}` : null].filter(Boolean).join('   ·   ')} />
      {sub ? <div class="accent">{sub}</div> : null}
      {p && p.description ? <div class="dim clamp5">{p.description}</div> : null}
      <div class="mt6" />
      {actions.map((a, i) => <MenuRow key={a.label} text={a.label} detail={a.detail} danger={a.danger} autoFocus={i === 0} onClick={a.onClick} />)}
    </Dialog>
  );
}

export function BlockedDialog({ b }) {
  const dismiss = () => setState({ blocked: null });
  const pid = b.channel ? b.channel.playlistId : b.vod ? b.vod.playlistId : 0;
  const max = useQuery(() => call('conn.maxFor', pid), [pid]).data || 1;
  const target = b.channel ? b.channel.name : b.vod ? b.vod.title : 'this';
  return (
    <Dialog onDismiss={dismiss}>
      <DialogTitle title="A recording is using your connection" subtitle={`${b.label} is recording. Your provider allows ${max} connection${max === 1 ? '' : 's'} at a time.`} />
      {b.recordingId != null ? <MenuRow text="Watch the channel being recorded" autoFocus onClick={() => { dismiss(); watchRecordingChannel(b.recordingId); }} /> : null}
      <MenuRow text={`Stop the recording and play ${target}`} danger autoFocus={b.recordingId == null} onClick={() => { dismiss(); stopRecordingThen(b.recordingId, () => retryBlocked(b)); }} />
      <MenuRow text="Cancel" onClick={dismiss} />
    </Dialog>
  );
}

export function TookOverDialog({ t }) {
  const dismiss = () => setState({ tookOver: null });
  const rec = t.rec;
  const max = useQuery(() => call('conn.maxFor', rec.playlistId), [rec.playlistId]).data || 1;
  const prev = t.previous;
  return (
    <Dialog onDismiss={dismiss}>
      <DialogTitle title="Recording started" subtitle={`“${rec.title}” on ${rec.channelName} is recording. Your provider allows ${max} connection${max === 1 ? '' : 's'}, so playback stopped.`} />
      <MenuRow text={`Watch ${rec.channelName}`} autoFocus onClick={() => { dismiss(); watchRecordingChannel(rec.id); }} />
      {prev ? (
        <MenuRow text="Stop the recording and keep watching" danger onClick={() => {
          dismiss();
          stopRecordingThen(rec.id, async () => {
            if (prev.type === 'live') await tune(prev.channel, current().name === 'player');
            else {
              const p = await call('progress.get', prev.item.key);
              await playVod(prev.item, p ? p.position : 0);
            }
          });
        }} />
      ) : null}
      <MenuRow text="OK" onClick={() => { dismiss(); if (current().name === 'player' && !getState().player.nowPlaying) nav.pop(); }} />
    </Dialog>
  );
}

/** "A new version is available": download, then install and reopen. */
export function UpdateDialog({ u }) {
  const [autoInstall, setAutoInstall] = useState(false);
  const [recording, setRecording] = useState(0);
  const v = u.latest ? u.latest.version : '';
  const later = () => setState({ updateDismissed: v || 'error' });
  useEffect(() => { call('update.state').then((s) => setRecording(s.recording || 0)); }, [u.status]);
  useEffect(() => {
    if (autoInstall && u.status === 'ready' && !recording) win('installUpdate');
  }, [autoInstall, u.status, recording]);
  const notes = u.latest && u.latest.notes ? u.latest.notes.split(/\r?\n/).filter((l) => l.trim()).slice(0, 8) : [];
  return (
    <Dialog onDismiss={later}>
      <DialogTitle title={u.status === 'error' ? 'Update problem' : `WiseTV ${v} is available`}
        subtitle={u.status === 'error' ? u.error : `You have version ${getState().info.version}.`} />
      {notes.length && u.status !== 'error' ? <div class="dim small update-notes">{notes.map((l, i) => <div key={i}>{l.replace(/^[-*]\s*/, '• ')}</div>)}</div> : null}
      {u.status === 'downloading' ? (
        <>
          <div class="muted">Downloading… {Math.round((u.progress || 0) * 100)}%</div>
          <ProgressLine value={u.progress} />
          <MenuRow text="Hide (keeps downloading)" autoFocus onClick={later} />
        </>
      ) : u.status === 'ready' || u.status === 'installing' ? (
        <>
          {recording ? <div class="warn">WiseTV is recording right now. Updating stops the recording (what's recorded so far is kept).</div> : null}
          <MenuRow text={u.status === 'installing' ? 'Updating…' : recording ? 'Stop recording, update and restart' : 'Update and restart'} autoFocus danger={!!recording}
            onClick={() => win('installUpdate')} />
          <MenuRow text="Later" onClick={later} />
        </>
      ) : u.status === 'error' ? (
        <>
          {u.latest ? <MenuRow text="Try again" autoFocus onClick={() => { setAutoInstall(true); call('update.download'); }} /> : null}
          <MenuRow text="Close" autoFocus={!u.latest} onClick={later} />
        </>
      ) : (
        <>
          <div class="small muted">WiseTV downloads the update, closes for a moment, and opens again. Your settings, guide and recordings are kept.</div>
          <MenuRow text="Update now" autoFocus onClick={() => { setAutoInstall(true); call('update.download'); }} />
          <MenuRow text="Later" onClick={later} />
        </>
      )}
    </Dialog>
  );
}
