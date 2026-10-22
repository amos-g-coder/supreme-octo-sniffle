import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startFixture } from '../desktop/Tests/Fixtures/runtime.mjs';

const fixture = await startFixture();
try {
  const runner = process.env.INFLEX_SWIFT_RUNNER ?? 'swift';
  const args = process.argv.includes('--ui')
    ? [
        'xcodebuild',
        '-project',
        'desktop/Inflex.xcodeproj',
        '-scheme',
        'Inflex',
        '-destination',
        'platform=macOS',
        '-derivedDataPath',
        'dist/desktop-ui-tests',
        '-resultBundlePath',
        `dist/desktop-ui-${Date.now()}.xcresult`,
        'test',
      ]
    : ['test', '--package-path', 'desktop'];
  const child = spawn(process.argv.includes('--ui') ? args.shift() : runner, args, {
    stdio: 'inherit',
    env: { ...process.env, INFLEX_TEST_URL: 'http://127.0.0.1:18790' },
  });
  child.on('error', error => {
    console.error(error.message);
    process.exitCode = 1;
  });
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
} finally {
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
