import { spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('Package Inflex using Node 24+ on Apple Silicon macOS');
}
const directory = path.resolve('dist/desktop-runtime');
await mkdir(directory, { recursive: true });
const deploy = spawnSync(
  'pnpm',
  ['--filter', '@truefoundry/trueforge', 'deploy', '--legacy', '--prod', path.join(directory, 'server')],
  { stdio: 'inherit' },
);
if (deploy.status !== 0) {
  process.exit(deploy.status ?? 1);
}
await copyFile(process.execPath, path.join(directory, 'node'));
await cp('native', path.join(directory, 'native'), { recursive: true });
await cp('media', path.join(directory, 'media'), { recursive: true, verbatimSymlinks: true });
