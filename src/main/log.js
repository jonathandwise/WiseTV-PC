'use strict';
// One log for the whole app: %APPDATA%\WiseTV\wisetv.log (kept small), plus the console.
const fs = require('fs');
const path = require('path');

let file = null;
let stream = null;

function init(dir) {
  file = path.join(dir, 'wisetv.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.old');
  } catch (_) { /* ignore */ }
  stream = fs.createWriteStream(file, { flags: 'a' });
}

function i(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  if (process.env.WISETV_DEBUG) console.log(line);
  if (stream) stream.write(line + '\n');
}

module.exports = { init, i, get file() { return file; } };
