// Shared plumbing for the interface: calls to the main process, live queries, formatting.
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';

const W = window.wise;

export function cleanError(e) {
  const m = String((e && e.message) || e || 'Something went wrong');
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export async function call(method, ...args) {
  try {
    return await W.call(method, ...args);
  } catch (e) {
    throw new Error(cleanError(e));
  }
}

export const win = (what, arg) => W.win(what, arg);
export const on = (name, fn) => W.on(name, fn);

/** Runs an async loader, re-running it when deps change or when any of `tables` change. */
export function useQuery(loader, deps, tables = []) {
  const [state, setState] = useState({ data: undefined, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve().then(loader).then(
      (data) => { if (my === seq.current) setState({ data, error: null, loading: false }); },
      (e) => { if (my === seq.current) setState((s) => ({ data: s.data, error: cleanError(e), loading: false })); },
    );
  }, deps);
  useEffect(() => { run(); }, [run]);
  useEffect(() => {
    if (!tables.length) return undefined;
    let t = null;
    return on('changed', (changed) => {
      if (changed.some((x) => tables.includes(x))) {
        clearTimeout(t);
        t = setTimeout(run, 150);
      }
    });
  }, [run, tables.join(',')]);
  return { ...state, reload: run };
}

export function useEvent(name, fn) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => on(name, (p) => ref.current(p)), [name]);
}

/** Current time, ticking every `ms`. */
export function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ------------------------------------------------------------------ formatting

const t12 = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const shortDayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const dayIndex = (d) => d.getFullYear() * 400 + Math.floor((d - new Date(d.getFullYear(), 0, 1)) / 86400000);

export const Fmt = {
  time: (ms) => t12.format(new Date(ms)),
  range: (a, b) => `${t12.format(new Date(a))} – ${t12.format(new Date(b))}`,
  date: (ms) => dateFmt.format(new Date(ms)),
  day(ms) {
    const diff = dayIndex(new Date(ms)) - dayIndex(new Date());
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return dayFmt.format(new Date(ms));
  },
  shortDay: (ms) => (dayIndex(new Date(ms)) === dayIndex(new Date()) ? 'Today' : shortDayFmt.format(new Date(ms))),
  duration(ms) {
    const total = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
  },
  clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  },
  size(b) {
    if (b >= 2 ** 30) return `${(b / 2 ** 30).toFixed(1)} GB`;
    if (b >= 2 ** 20) return `${Math.round(b / 2 ** 20)} MB`;
    return `${Math.round(b / 1024)} KB`;
  },
};

export const MIN = 60000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const floor30 = (t) => t - (t % (30 * MIN));
export const ratingText = (r) => {
  const n = parseFloat(r);
  return n > 0 ? `★ ${n.toFixed(1)}` : null;
};
