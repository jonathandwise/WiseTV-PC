// Builds the Windows release: build/WiseTV (portable folder), a zip, and an installer.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = __dirname;
const vendor = process.env.WISETV_VENDOR || path.join(root, 'vendor');
const pkg = require('./package.json');
const out = path.join(root, 'build');
const appDir = path.join(out, 'WiseTV');
const stage = path.join(out, 'stage');
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });

(async () => {
  run('node build.js --minify', { cwd: root });
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });

  // Electron runtime for Windows.
  run(`unzip -q ${path.join(vendor, 'electron-win.zip')} -d ${appDir}`);
  fs.renameSync(path.join(appDir, 'electron.exe'), path.join(appDir, 'WiseTV.exe'));
  fs.rmSync(path.join(appDir, 'resources', 'default_app.asar'), { force: true });

  // The app itself, packed into app.asar.
  fs.mkdirSync(stage, { recursive: true });
  const prodPkg = { name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, main: pkg.main, author: pkg.author, dependencies: { sax: pkg.dependencies.sax } };
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(prodPkg, null, 2));
  for (const d of ['src/main', 'dist', 'assets']) fs.cpSync(path.join(root, d), path.join(stage, d), { recursive: true });
  fs.copyFileSync(path.join(root, 'src/preload.js'), path.join(stage, 'src/preload.js'));
  fs.rmSync(path.join(stage, 'dist', 'renderer.js.map'), { force: true });
  fs.rmSync(path.join(stage, 'assets', 'icon-src.png'), { force: true });
  fs.cpSync(path.join(root, 'node_modules/sax'), path.join(stage, 'node_modules/sax'), { recursive: true });
  const asar = require('@electron/asar');
  await asar.createPackage(stage, path.join(appDir, 'resources', 'app.asar'));
  fs.rmSync(stage, { recursive: true, force: true });

  // mpv, the video engine.
  const mpvDir = path.join(appDir, 'resources', 'mpv');
  fs.mkdirSync(mpvDir, { recursive: true });
  for (const f of ['mpv.exe', 'd3dcompiler_43.dll']) fs.copyFileSync(path.join(vendor, 'mpv-win', f), path.join(mpvDir, f));
  fs.cpSync(path.join(vendor, 'mpv-win', 'mpv'), path.join(mpvDir, 'mpv'), { recursive: true });
  fs.writeFileSync(path.join(mpvDir, 'README.txt'),
    'mpv media player (https://mpv.io), Windows build by shinchiro (https://github.com/shinchiro/mpv-winbuild-cmake).\r\n' +
    'mpv is free software licensed under the GNU GPL v2+ / LGPL v2.1+. Source code: https://github.com/mpv-player/mpv\r\n');

  // Icon and version details for WiseTV.exe.
  const ResEdit = require('resedit/cjs');
  const { load } = ResEdit;
  const R = await load();
  const exePath = path.join(appDir, 'WiseTV.exe');
  const exe = R.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = R.NtExecutableResource.from(exe);
  const ico = R.Data.IconFile.from(fs.readFileSync(path.join(root, 'assets', 'icon.ico')));
  const groups = R.Resource.IconGroupEntry.fromEntries(res.entries);
  const iconId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, iconId, lang, ico.icons.map((i) => i.data));
  const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0];
  const [a, b, c] = pkg.version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'WiseTV', ProductName: 'WiseTV', CompanyName: 'WiseTV', OriginalFilename: 'WiseTV.exe',
    InternalName: 'WiseTV', LegalCopyright: 'WiseTV', FileVersion: pkg.version, ProductVersion: pkg.version,
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));

  // Portable zip and installer.
  const zip = path.join(out, `WiseTV-${pkg.version}-portable.zip`);
  run(`cd ${out} && zip -qr -9 ${zip} WiseTV`);
  run(`makensis -V2 -DVERSION=${pkg.version} -DSRC=${appDir} -DOUT=${path.join(out, `WiseTV-Setup-${pkg.version}.exe`)} -DICON=${path.join(root, 'assets', 'icon.ico')} ${path.join(root, 'installer.nsi')}`);
  run(`ls -la ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
