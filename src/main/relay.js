'use strict';
// Local HTTP server that re-broadcasts a stream being recorded, so the player can watch the
// recorded channel without opening a second provider connection.
const net = require('http');

const hubs = new Map();
let server = null;
let port = 0;
let starting = null;

class RelayHub {
  constructor() {
    this.clients = new Set();
    this.closed = false;
    this.header = null; // init segment of an fMP4 stream
  }

  publish(buf) {
    for (const res of this.clients) {
      // The player fell too far behind; drop it and let it reconnect.
      if (res.writableLength > 32 * 1024 * 1024) {
        this.clients.delete(res);
        res.destroy();
        continue;
      }
      res.write(buf);
    }
  }

  serve(res) {
    if (this.header) res.write(this.header);
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  closeAll() {
    this.closed = true;
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

function hubFor(id) {
  if (!hubs.has(id)) hubs.set(id, new RelayHub());
  return hubs.get(id);
}

function remove(id) {
  const h = hubs.get(id);
  hubs.delete(id);
  if (h) h.closeAll();
}

function ensureStarted() {
  if (server && port) return Promise.resolve(port);
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    server = net.createServer(async (req, res) => {
      const m = /\/rec\/(\d+)/.exec(req.url || '');
      const id = m ? Number(m[1]) : null;
      let hub = null;
      const deadline = Date.now() + 15000;
      while (id && !hub && Date.now() < deadline) {
        hub = hubs.get(id) || null;
        if (!hub) await new Promise((r) => setTimeout(r, 200));
      }
      if (!hub) {
        res.writeHead(404, { 'Content-Length': 0, Connection: 'close' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-cache', Connection: 'close' });
      hub.serve(res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve(port);
    });
  });
  return starting;
}

async function urlFor(id) {
  const p = await ensureStarted();
  return `http://127.0.0.1:${p}/rec/${id}.ts`;
}

module.exports = { hubFor, remove, urlFor, ensureStarted };
