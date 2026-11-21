'use strict';
// The bridge between the interface and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();
ipcRenderer.on('ev', (_e, name, payload) => {
  const set = listeners.get(name);
  if (set) for (const fn of set) fn(payload);
});

contextBridge.exposeInMainWorld('wise', {
  call: (method, ...args) => ipcRenderer.invoke('call', method, args),
  win: (what, arg) => ipcRenderer.invoke('win', what, arg),
  on: (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name).delete(fn);
  },
});
