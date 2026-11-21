// Tells the main process where the video should show through the interface: the guide's preview
// box, the whole window (player), or nowhere. Also cuts the matching hole in the backdrop and,
// in "shape" mode, clips the interface window to its visible parts.
import { useEffect, useRef } from 'preact/hooks';
import { win, on } from './lib';

let hole = null; // element showing the video, or 'full'
let shapeMode = false;
let last = '';

export function setShapeMode(v) { shapeMode = v; }

/** A box the video shows through. */
export function useVideoHole(active = true) {
  const ref = useRef(null);
  useEffect(() => {
    if (!active) return undefined;
    const el = ref.current;
    hole = el;
    return () => { if (hole === el) hole = null; };
  }, [active]);
  return ref;
}

/** Full-window video (the player). */
export function useFullVideo(active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const marker = 'full';
    hole = marker;
    return () => { if (hole === marker) hole = null; };
  }, [active]);
}

function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
}

function update() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const backdrop = document.getElementById('backdrop');
  const dialogOpen = !!document.querySelector('.dialog-layer');
  let video;
  let shape;
  if (hole === 'full') {
    video = { mode: 'full' };
    backdrop.style.display = 'none';
    if (dialogOpen) shape = [{ x: 0, y: 0, width: W, height: H }];
    else {
      shape = [...document.querySelectorAll('.ov')].map(rectOf).filter((r) => r.w > 0 && r.h > 0)
        .map((r) => ({ x: r.x, y: r.y, width: r.w, height: r.h }));
      if (!shape.length) shape = [{ x: 0, y: 0, width: 1, height: 1 }];
    }
  } else if (hole && hole.isConnected) {
    const r = rectOf(hole);
    video = { mode: 'rect', ...r, W, H };
    backdrop.style.display = '';
    backdrop.style.clipPath = `path(evenodd, "M0 0 H${W} V${H} H0 Z M${r.x} ${r.y} h${r.w} v${r.h} h${-r.w} Z")`;
    if (dialogOpen) shape = [{ x: 0, y: 0, width: W, height: H }];
    else {
      shape = [
        { x: 0, y: 0, width: W, height: r.y },
        { x: 0, y: r.y + r.h, width: W, height: H - r.y - r.h },
        { x: 0, y: r.y, width: r.x, height: r.h },
        { x: r.x + r.w, y: r.y, width: W - r.x - r.w, height: r.h },
      ].filter((x) => x.width > 0 && x.height > 0);
      // Labels drawn over the preview stay visible too.
      for (const el of hole.querySelectorAll('.ov')) {
        const o = rectOf(el);
        if (o.w > 0) shape.push({ x: o.x, y: o.y, width: o.w, height: o.h });
      }
    }
  } else {
    video = { mode: 'hidden' };
    backdrop.style.display = '';
    backdrop.style.clipPath = 'none';
    shape = [{ x: 0, y: 0, width: W, height: H }];
  }
  const key = JSON.stringify([video, shapeMode ? shape : 0]);
  if (key === last) return;
  last = key;
  win('video', video);
  if (shapeMode) win('shape', shape);
}

export function startVideoLayout() {
  const loop = () => {
    try { update(); } catch (_) { /* ignore */ }
  };
  setInterval(loop, 120);
  window.addEventListener('resize', loop);
}

/**
 * Mouse events that happened over the picture (they go to the video player's window, not to this
 * page, in the standard drawing mode) are replayed on whatever element sits at that spot.
 */
export function installVideoMouse(onBack) {
  on('vmouse', ({ type, x, y, arg }) => {
    if (type === 'back') { onBack(); return; }
    const el = document.elementFromPoint(x, y) || document.body;
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    if (type === 'move') el.dispatchEvent(new MouseEvent('mousemove', base));
    else if (type === 'click') el.dispatchEvent(new MouseEvent('click', { ...base, detail: 1 }));
    else if (type === 'dblclick') el.dispatchEvent(new MouseEvent('dblclick', { ...base, detail: 2 }));
    else if (type === 'context') el.dispatchEvent(new MouseEvent('contextmenu', { ...base, button: 2 }));
    else if (type === 'wheel') el.dispatchEvent(new WheelEvent('wheel', { ...base, deltaY: Number(arg) * 100 }));
  });
}
