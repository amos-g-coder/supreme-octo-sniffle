import { spawnSync } from 'node:child_process';
import { access, chmod, copyFile, cp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Build Inflex desktop on Apple Silicon macOS 14+ with Xcode command line tools');
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) {
    throw new Error(`Could not run ${command}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status ?? 'signal'})`);
  }
  return result;
}
const runtime = path.resolve('dist/desktop-runtime');
await access(path.join(runtime, 'node'));
await access(path.join(runtime, 'server/dist/cli.js'));
await access(path.join(runtime, 'native/bin/inflex-keychain'));
const args = ['--package-path', 'desktop', '-c', 'release', '--arch', 'arm64'];
run('swift', ['build', ...args, '--product', 'InflexApp']);
const result = run('swift', ['build', ...args, '--show-bin-path'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  encoding: 'utf8',
});
const app = path.resolve('dist/desktop/Inflex.app');
await rm(app, { recursive: true, force: true });
await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
const resources = path.join(app, 'Contents/Resources');
await mkdir(resources, { recursive: true });
await copyFile(path.join(result.stdout.trim(), 'InflexApp'), path.join(app, 'Contents/MacOS/Inflex'));
await chmod(path.join(app, 'Contents/MacOS/Inflex'), 0o755);
await copyFile('desktop/Resources/Info.plist', path.join(app, 'Contents/Info.plist'));
await cp(runtime, path.join(resources, 'runtime'), { recursive: true, verbatimSymlinks: true });
const notices = path.join(resources, 'Licenses');
await cp('third_party', notices, { recursive: true });
await copyFile('LICENSE', path.join(notices, 'Inflex-LICENSE'));
for (const dependency of ['swift-markdown-ui', 'NetworkImage', 'swift-cmark']) {
  const checkout = path.resolve('desktop/.build/checkouts', dependency);
  const names = await readdir(checkout);
  for (const name of names.filter(value => /^(LICENSE|COPYING|NOTICE)/i.test(value))) {
    await cp(path.join(checkout, name), path.join(notices, `${dependency}-${name}`), { recursive: true });
  }
}

const iconset = path.resolve('dist/desktop/Inflex.iconset');
await mkdir(iconset, { recursive: true });
run('swift', ['desktop/Resources/make-icon.swift', iconset]);
run('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'Inflex.icns')]);
run('plutil', ['-lint', path.join(app, 'Contents/Info.plist')]);
run('codesign', ['--force', '--deep', '--sign', '-', app]);
run('codesign', ['--verify', '--deep', '--strict', app]);
const staging = path.resolve('dist/desktop/dmg');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(app, path.join(staging, 'Inflex.app'), { recursive: true, verbatimSymlinks: true });
await symlink('/Applications', path.join(staging, 'Applications'));
run('hdiutil', [
  'create',
  '-ov',
  '-volname',
  'Inflex',
  '-srcfolder',
  staging,
  '-format',
  'UDZO',
  path.resolve('dist/desktop/Inflex.dmg'),
]);
console.log(`Built ${app} and dist/desktop/Inflex.dmg`);
