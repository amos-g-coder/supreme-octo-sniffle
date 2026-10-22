import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Native Inflex builds require Apple Silicon macOS 14+ with Xcode command line tools');
}
await mkdir('native/bin', { recursive: true });
const result = spawnSync(
  'swiftc',
  [
    '-O',
    '-target',
    'arm64-apple-macosx14.0',
    'native/keychain.swift',
    '-o',
    'native/bin/inflex-keychain',
    '-framework',
    'Security',
  ],
  { stdio: 'inherit' },
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
