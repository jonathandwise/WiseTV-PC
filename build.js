// Bundles the interface into dist/.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, 'dist');
fs.mkdirSync(out, { recursive: true });
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'src/renderer/app.jsx')],
  bundle: true,
  outfile: path.join(out, 'renderer.js'),
  jsx: 'automatic',
  jsxImportSource: 'preact',
  target: 'chrome120',
  minify: process.argv.includes('--minify'),
  sourcemap: !process.argv.includes('--minify'),
  logLevel: 'warning',
});
for (const f of ['index.html', 'app.css']) fs.copyFileSync(path.join(__dirname, 'src/renderer', f), path.join(out, f));
console.log('built dist/');
