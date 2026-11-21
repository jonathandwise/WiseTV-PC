// Keyboard handling. Screens and dialogs push handlers; the newest gets keys first. Keys nobody
// handles fall back to remote-style behaviour: arrows move between buttons, Esc/Backspace go back.
import { useEffect, useRef } from 'preact/hooks';

const stack = [];
let backHandler = () => {};

export function setBackHandler(fn) { backHandler = fn; }

/** Registers a key handler while `active`. The handler returns true when it used the key. */
export function useKeys(handler, active = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return undefined;
    const entry = { fn: (e) => ref.current(e) };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

const isTyping = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
};

function visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

/** Moves focus to the nearest focusable element in a direction. */
export function moveFocus(dir, scope = document) {
  const layer = document.querySelector('.dialog-layer:last-of-type') || scope;
  const items = [...layer.querySelectorAll('[data-nav]:not([disabled])')].filter(visible);
  if (!items.length) return false;
  const cur = document.activeElement;
  if (!cur || !items.includes(cur)) {
    const pick = items.find((x) => x.hasAttribute('data-autofocus')) || items[0];
    pick.focus();
    pick.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    let main;
    let cross;
    if (dir === 'ArrowRight') { main = b.left - a.right + 1; cross = Math.abs(by - ay); if (bx <= ax) continue; }
    else if (dir === 'ArrowLeft') { main = a.left - b.right + 1; cross = Math.abs(by - ay); if (bx >= ax) continue; }
    else if (dir === 'ArrowDown') { main = b.top - a.bottom + 1; cross = Math.abs(bx - ax); if (by <= ay) continue; }
    else { main = a.top - b.bottom + 1; cross = Math.abs(bx - ax); if (by >= ay) continue; }
    const score = Math.max(0, main) + cross * 2.2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (!best) return false;
  best.focus();
  best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

export function installKeys(onGlobal) {
  window.addEventListener('keydown', (e) => {
    if (onGlobal && onGlobal(e)) { e.preventDefault(); return; }
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].fn(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    const typing = isTyping();
    if (e.key === 'Escape' || (e.key === 'Backspace' && !typing) || e.key === 'BrowserBack') {
      if (typing && e.key === 'Escape') { document.activeElement.blur(); e.preventDefault(); return; }
      e.preventDefault();
      backHandler();
      return;
    }
    if (!typing && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      if (moveFocus(e.key)) e.preventDefault();
    }
  });
  // Mouse "back" button.
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) { e.preventDefault(); backHandler(); }
  });
}
