// Prints the CHANGELOG.md section for a version (used as the GitHub release text, which the app shows).
const fs = require('fs');
const version = process.argv[2];
const text = fs.readFileSync(require('path').join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const lines = text.split(/\r?\n/);
const start = lines.findIndex((l) => l.replace(/^#+\s*/, '').trim().startsWith(version));
if (start < 0) {
  console.log(`WiseTV ${version}`);
  process.exit(0);
}
const out = [];
for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) out.push(lines[i]);
console.log(out.join('\n').trim() || `WiseTV ${version}`);
