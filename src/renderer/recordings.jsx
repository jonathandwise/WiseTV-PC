// Recordings: upcoming, recorded and series rules.
import { useState } from 'preact/hooks';
import { call, win, useQuery, useNow, Fmt } from './lib';
import { useStore, showToast, playRecording, watchRecordingChannel } from './store';
import { CenterMessage, Btn, Card, Dialog, DialogTitle, MenuRow } from './components';

export function RecordingsScreen() {
  const [tab, setTab] = useState(0);
  const list = useQuery(() => call('rec.list'), [], ['recordings']);
  const rules = useQuery(() => call('rec.rules'), [], ['rules', 'recordings']);
  const store = useQuery(() => call('rec.storage'), [], ['recordings']);
  const settings = useStore((s) => s.settings);
  const [openRec, setOpenRec] = useState(null);
  const [openRule, setOpenRule] = useState(null);
  useNow(30000);
  const all = list.data ? list.data.all : [];
  const conflicts = new Set(list.data ? list.data.conflicts : []);
  const upcoming = all.filter((r) => r.status === 'scheduled' || r.status === 'recording').sort((a, b) => a.start - b.start);
  const done = all.filter((r) => r.status === 'completed' || r.status === 'failed').sort((a, b) => b.programStart - a.programStart);
  const ruleList = rules.data || [];
  const st = store.data;
  void settings;

  let body;
  if (tab === 0) {
    body = !upcoming.length ? <CenterMessage title="Nothing scheduled" subtitle="In the TV guide, right-click a programme (or press M) and choose Record." />
      : upcoming.map((r) => <RecordingRow key={r.id} r={r} conflict={conflicts.has(r.id)} onClick={() => setOpenRec(r)} />);
  } else if (tab === 1) {
    body = !done.length ? <CenterMessage title="No recordings yet" />
      : done.map((r) => <RecordingRow key={r.id} r={r} onClick={() => setOpenRec(r)} onDblClick={() => r.status === 'completed' && playRecording(r.id)} />);
  } else {
    body = !ruleList.length ? <CenterMessage title="No series rules" subtitle="In the TV guide, open a programme's menu and choose Record series." />
      : ruleList.map((rule) => {
        const count = upcoming.filter((r) => r.ruleId === rule.id).length;
        const kept = done.filter((r) => r.ruleId === rule.id && r.status === 'completed').length;
        return (
          <Card key={rule.id} onClick={() => setOpenRule(rule)}>
            <div class="pad-row">
              <div class="row-title">{rule.title}</div>
              <div class="small dim">{[rule.channelName || 'Any channel', `${count} upcoming`, `${kept} recorded`, rule.keepLast > 0 ? `keeps last ${rule.keepLast}` : 'keeps all', rule.skipRepeats ? 'skips repeats' : 'records repeats'].join('  ·  ')}</div>
            </div>
          </Card>
        );
      });
  }
  return (
    <div class="page">
      <div class="row center-v">
        <div class="page-title grow">Recordings</div>
        {st ? (
          <div class="row center-v gap8">
            <span class={`small ${st.free < st.minFree * 3 ? 'warn' : 'muted'}`}>
              Free: {Fmt.size(st.free)}  (about {(st.free / st.hdPerHour).toFixed(1)} h of HD)
            </span>
            <Btn small onClick={() => win('openPath', st.dir)} title={st.dir}>Open folder</Btn>
          </div>
        ) : null}
      </div>
      <div class="row gap10 mt12">
        <Btn selected={tab === 0} autoFocus={tab === 0} onClick={() => setTab(0)}>Upcoming ({upcoming.length})</Btn>
        <Btn selected={tab === 1} onClick={() => setTab(1)}>Recorded ({done.length})</Btn>
        <Btn selected={tab === 2} onClick={() => setTab(2)}>Series rules ({ruleList.length})</Btn>
      </div>
      <div class="list mt12">{body}</div>
      {openRec ? <RecordingDialog r={all.find((x) => x.id === openRec.id) || openRec} onDismiss={() => setOpenRec(null)} /> : null}
      {openRule ? <RuleDialog rule={ruleList.find((x) => x.id === openRule.id) || openRule} onDismiss={() => setOpenRule(null)} /> : null}
    </div>
  );
}

function StatusGlyph({ status }) {
  const c = status === 'recording' ? 'var(--rec)' : status === 'scheduled' ? 'var(--accent)' : status === 'completed' ? 'var(--good)' : 'var(--warn)';
  return <span class="status-dot" style={{ background: c }} />;
}

function RecordingRow({ r, conflict, onClick, onDblClick }) {
  const warn = conflict ? 'Overlaps another recording — not enough connections for both'
    : r.status === 'failed' ? r.error || 'Failed'
      : r.note || (r.status === 'recording' && r.error ? r.error : null);
  const right = r.status === 'recording' ? `REC  ${Fmt.size(r.bytes)}`
    : r.status === 'completed' ? `${Fmt.duration(r.programStop - r.programStart)}  ·  ${Fmt.size(r.bytes)}`
      : r.status === 'scheduled' ? `in ${Fmt.duration(r.start - Date.now())}` : '';
  return (
    <Card onClick={onClick} onDblClick={onDblClick}>
      <div class="row center-v gap14 pad-row">
        <StatusGlyph status={r.status} />
        <div class="grow minw0">
          <div class="row-title ell">{r.title}{r.subtitle ? `  ·  ${r.subtitle}` : ''}</div>
          <div class="small dim ell">{r.channelName}  ·  {Fmt.day(r.programStart)}  {Fmt.range(r.programStart, r.programStop)}</div>
          {warn ? <div class="small warn ell">{warn}</div> : null}
        </div>
        <span class={`small ${r.status === 'recording' ? 'rec-text' : ''}`}>{right}</span>
      </div>
    </Card>
  );
}

function RecordingDialog({ r, onDismiss }) {
  const act = async (fn, msg) => {
    onDismiss();
    try { await fn(); if (msg) showToast(msg); } catch (e) { showToast(e.message); }
  };
  return (
    <Dialog onDismiss={onDismiss}>
      <DialogTitle title={r.title} subtitle={`${r.channelName}  ·  ${Fmt.day(r.programStart)}  ${Fmt.range(r.programStart, r.programStop)}`} />
      {r.subtitle ? <div class="accent">{r.subtitle}</div> : null}
      {r.description ? <div class="dim clamp4">{r.description}</div> : null}
      <div class="mt6" />
      {r.status === 'recording' ? (
        <>
          <MenuRow text="Watch live" autoFocus onClick={() => { onDismiss(); watchRecordingChannel(r.id); }} />
          <MenuRow text="Stop recording (keep what's recorded)" danger onClick={() => act(() => call('rec.stop', r.id), 'Recording stopped')} />
        </>
      ) : r.status === 'scheduled' ? (
        <MenuRow text="Cancel this recording" danger autoFocus onClick={() => act(() => call('rec.cancel', r.id), 'Recording cancelled')} />
      ) : r.status === 'completed' ? (
        <>
          <MenuRow text="Play" autoFocus onClick={() => { onDismiss(); playRecording(r.id); }} />
          <MenuRow text="Play from the start" onClick={() => { onDismiss(); playRecording(r.id, true); }} />
          <MenuRow text="Show the file in Explorer" onClick={() => { onDismiss(); win('showItem', r.filePath); }} />
          <MenuRow text="Delete recording" danger onClick={() => act(() => call('rec.delete', r.id), 'Recording deleted')} />
        </>
      ) : (
        <MenuRow text="Remove from list" danger autoFocus onClick={() => act(() => call('rec.delete', r.id))} />
      )}
      <MenuRow text="Close" onClick={onDismiss} />
    </Dialog>
  );
}

function RuleDialog({ rule, onDismiss }) {
  const next = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];
  const update = (r) => call('rec.updateRule', r);
  return (
    <Dialog onDismiss={onDismiss}>
      <DialogTitle title={rule.title} subtitle={rule.channelName || 'Any channel'} />
      <MenuRow text="Keep" autoFocus detail={rule.keepLast === 0 ? 'All episodes' : `Last ${rule.keepLast}`} onClick={() => update({ ...rule, keepLast: next([0, 1, 2, 3, 5, 10, 20], rule.keepLast) })} />
      <MenuRow text="Skip repeats" detail={rule.skipRepeats ? 'On' : 'Off'} onClick={() => update({ ...rule, skipRepeats: !rule.skipRepeats })} />
      <MenuRow text="Start early" detail={`${rule.padBefore} min`} onClick={() => update({ ...rule, padBefore: next([0, 1, 2, 5, 10], rule.padBefore) })} />
      <MenuRow text="End late" detail={`${rule.padAfter} min`} onClick={() => update({ ...rule, padAfter: next([0, 2, 5, 10, 15, 30], rule.padAfter) })} />
      <MenuRow text="Delete rule and its upcoming recordings" danger onClick={async () => { await call('rec.deleteRule', rule.id); onDismiss(); showToast('Series recording removed'); }} />
      <MenuRow text="Close" onClick={onDismiss} />
    </Dialog>
  );
}
