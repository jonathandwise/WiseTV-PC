// Small building blocks shared by every screen.
import { useEffect, useRef, useState } from 'preact/hooks';
import { useKeys } from './keys';
import { call } from './lib';
import { useStore, getState } from './store';

export function Btn({ children, onClick, primary, selected, danger, disabled, autoFocus, className = '', title, small }) {
  const ref = useAutoFocus(autoFocus);
  return (
    <button
      ref={ref}
      data-nav
      data-autofocus={autoFocus ? '' : undefined}
      disabled={disabled}
      title={title}
      class={`btn ${primary ? 'primary' : ''} ${selected ? 'selected' : ''} ${danger ? 'danger' : ''} ${small ? 'small' : ''} ${className}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function useAutoFocus(on) {
  const ref = useRef(null);
  useEffect(() => {
    if (on && ref.current) {
      const el = ref.current;
      setTimeout(() => { if (el.isConnected) el.focus({ preventScroll: false }); }, 30);
    }
  }, [on]);
  return ref;
}

/** A row in a menu or dialog: label on the left, optional detail on the right. */
export function MenuRow({ text, detail, onClick, autoFocus, danger, selected }) {
  const ref = useAutoFocus(autoFocus);
  return (
    <button ref={ref} data-nav class={`menu-row ${danger ? 'danger' : ''} ${selected ? 'selected' : ''}`} onClick={onClick}>
      <span class="grow">{text}</span>
      {detail ? <span class="mr-detail">{detail}</span> : null}
    </button>
  );
}

/** A clickable card (list rows, settings rows). */
export function Card({ children, onClick, onContextMenu, selected, className = '', autoFocus, title, onDblClick }) {
  const ref = useAutoFocus(autoFocus);
  return (
    <div
      ref={ref}
      data-nav
      tabIndex={0}
      title={title}
      class={`card ${selected ? 'selected' : ''} ${className}`}
      onClick={onClick}
      onDblClick={onDblClick}
      onContextMenu={(e) => { if (onContextMenu) { e.preventDefault(); onContextMenu(e); } }}
      onKeyDown={(e) => { if (e.key === 'Enter' && onClick) { e.preventDefault(); e.stopPropagation(); onClick(e); } }}
    >
      {children}
    </div>
  );
}

export function Dialog({ onDismiss, children, wide }) {
  useKeys((e) => {
    if (e.key === 'Escape' || (e.key === 'Backspace' && !(document.activeElement && document.activeElement.tagName === 'INPUT'))) {
      onDismiss();
      return true;
    }
    return false;
  });
  // Keep keyboard focus inside the dialog.
  const box = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    setTimeout(() => {
      if (box.current && !box.current.contains(document.activeElement)) {
        const first = box.current.querySelector('[data-autofocus]') || box.current.querySelector('[data-nav]');
        if (first) first.focus();
      }
    }, 40);
    return () => { if (prev && prev.isConnected) try { prev.focus({ preventScroll: true }); } catch (_) { /* ignore */ } };
  }, []);
  return (
    <div class="dialog-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) onDismiss(); }}>
      <div ref={box} class={`dialog ${wide ? 'wide' : ''}`}>{children}</div>
    </div>
  );
}

export function DialogTitle({ title, subtitle }) {
  return (
    <div class="dialog-title">
      <div class="t">{title}</div>
      {subtitle ? <div class="s">{subtitle}</div> : null}
    </div>
  );
}

export function CenterMessage({ title, subtitle, children }) {
  return (
    <div class="center-message">
      <div class="t">{title}</div>
      {subtitle ? <div class="s">{subtitle}</div> : null}
      {children}
    </div>
  );
}

export function ProgressLine({ value, className = '', style }) {
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <div class={`progress ${className}`} style={style}>
      <div style={{ width: `${v * 100}%` }} />
    </div>
  );
}

export const RecDot = ({ size = 10 }) => <span class="rec-dot" style={{ width: size, height: size }} />;

export function TextInput({ label, value, onInput, hint, secret, autoFocus, onEnter, placeholder }) {
  const ref = useAutoFocus(autoFocus);
  const [show, setShow] = useState(false);
  return (
    <label class="text-input">
      <span class="label">{label}</span>
      <span class="row">
        <input
          ref={ref}
          data-nav
          type={secret && !show ? 'password' : 'text'}
          value={value}
          placeholder={placeholder}
          spellcheck={false}
          onInput={(e) => onInput(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } }}
        />
        {secret ? <button type="button" class="btn small" tabIndex={-1} onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button> : null}
      </span>
      {hint ? <span class="hint">{hint}</span> : null}
    </label>
  );
}

export function Img({ src, className = '', alt = '', fit = 'cover' }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [src]);
  if (!src || bad) return null;
  return <img class={className} src={src} alt={alt} loading="lazy" draggable={false} style={{ objectFit: fit }} onError={() => setBad(true)} />;
}

export function Spinner({ text = 'Loading' }) {
  return <div class="spinner ov"><span class="wheel" />{text}</div>;
}

export function SectionHeader({ children }) {
  return <div class="section-header">{children}</div>;
}

export function CheckGlyph({ on }) {
  return <span class={`check ${on ? 'on' : ''}`}>{on ? '✓' : ''}</span>;
}

/** Icons for the menu rail and buttons (simple strokes, colour from the text). */
export function Icon({ name, size = 22 }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  switch (name) {
    case 'guide': return <svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M9 10v9" /></svg>;
    case 'movies': return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M10 9l5 3-5 3z" fill="currentColor" /></svg>;
    case 'series': return <svg {...p}><rect x="4" y="7" width="16" height="12" rx="2" /><path d="M8 3l4 4 4-4" /></svg>;
    case 'recordings': return <svg {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" fill="#E5484D" stroke="none" /></svg>;
    case 'search': return <svg {...p}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></svg>;
    case 'settings': return <svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></svg>;
    case 'play': return <svg {...p}><path d="M7 4l13 8-13 8z" fill="currentColor" /></svg>;
    case 'pause': return <svg {...p}><path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor" stroke="none" /></svg>;
    case 'back': return <svg {...p}><path d="M15 5l-7 7 7 7" /></svg>;
    case 'list': return <svg {...p}><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
    case 'menu': return <svg {...p}><circle cx="12" cy="5" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="19" r="1.5" fill="currentColor" /></svg>;
    case 'fullscreen': return <svg {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>;
    case 'exitfull': return <svg {...p}><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>;
    case 'rew': return <svg {...p}><path d="M11 6L4 12l7 6zM20 6l-7 6 7 6z" fill="currentColor" stroke="none" /></svg>;
    case 'ff': return <svg {...p}><path d="M13 6l7 6-7 6zM4 6l7 6-7 6z" fill="currentColor" stroke="none" /></svg>;
    case 'next': return <svg {...p}><path d="M5 5l10 7-10 7z" fill="currentColor" /><path d="M19 5v14" /></svg>;
    case 'volume': return <svg {...p}><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" /><path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11" /></svg>;
    case 'mute': return <svg {...p}><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" /><path d="M17 9l5 6M22 9l-5 6" /></svg>;
    case 'star': return <svg {...p}><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></svg>;
    case 'rec': return <svg {...p}><circle cx="12" cy="12" r="6" fill="#E5484D" stroke="none" /></svg>;
    case 'chevL': return <svg {...p}><path d="M15 6l-6 6 6 6" /></svg>;
    case 'chevR': return <svg {...p}><path d="M9 6l6 6-6 6" /></svg>;
    default: return null;
  }
}

/** Speaker button (mute) and a volume slider, for the player's top bar. */
export function VolumeControl({ compact = false }) {
  const vol = useStore((s) => s.player.volume);
  const mute = useStore((s) => s.player.mute);
  const [drag, setDrag] = useState(null);
  const shown = drag != null ? drag : mute ? 0 : Math.round(vol || 0);
  return (
    <div class={`volume-control ${compact ? 'compact' : ''}`} onClick={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}
      onWheel={(e) => { e.stopPropagation(); call('player.setVolume', (getState().player.volume || 0) + (e.deltaY < 0 ? 5 : -5)); }}>
      <button class={`icon-btn ${compact ? '' : 'big'}`} title={mute ? 'Unmute (U)' : 'Mute (U)'} onClick={() => call('player.toggleMute')}>
        <Icon name={mute || shown === 0 ? 'mute' : 'volume'} />
      </button>
      <input
        type="range" min="0" max="100" step="1" value={Math.min(100, shown)}
        title="Volume (+ / − or the mouse wheel)"
        style={{ '--fill': `${Math.min(100, shown)}%` }}
        onInput={(e) => { const v = Number(e.currentTarget.value); setDrag(v); call('player.setVolume', v); }}
        onChange={() => setDrag(null)}
        onMouseUp={() => setDrag(null)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <span class="volume-num">{shown}</span>
    </div>
  );
}
