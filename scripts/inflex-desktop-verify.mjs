import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'dist/desktop-validation');
await mkdir(output, { recursive: true });
const report = {
  started_at: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  os_release: os.release(),
  node: process.versions.node,
  steps: [],
  native_ui_verified: false,
  packaging_verified: false,
  performance_comparison_verified: false,
  pending: [
    'Compare screenshots with the prior GUI on the same Mac.',
    'Compare GUI CPU, memory and launch metrics against the prior build.',
    'Exercise live sign-in, tool execution and macOS permissions with the user.',
  ],
};
let failure;
function run(label, command, args) {
  console.log(`Inflex verification: ${label}`);
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const log = `${label.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`;
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(text);
  report.steps.push({
    label,
    status: result.status === 0 ? 'passed' : 'failed',
    duration_ms: Date.now() - started,
    log,
  });
  return { log, text, result };
}
async function step(label, command, args) {
  const { log, text, result } = run(label, command, args);
  await writeFile(path.join(output, log), text);
  if (result.error) {
    throw new Error(`${label}: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed; see ${path.join(output, log)}`);
  }
}

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(
      'Native verification requires an Apple Silicon Mac with a logged-in graphical session. Linux portable checks use pnpm test:desktop with Swift 6 installed.',
    );
  }
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Install Node 24+ before running native verification.');
  }
  await step('Xcode version', 'xcodebuild', ['-version']);
  await step('Swift version', 'swift', ['--version']);
  await step('Workspace dependencies', 'pnpm', ['install', '--frozen-lockfile']);
  await step('Swift client and contract tests', 'pnpm', ['test:desktop']);
  await step('Native UI tests and metrics', 'pnpm', ['test:desktop:ui']);
  report.native_ui_verified = true;
  await step('Media dependencies', 'pnpm', ['inflex:media:install']);
  await step('Production build and bundle resources', 'pnpm', ['inflex:desktop:prepare']);
  await step('Application and disk image', 'pnpm', ['inflex:desktop:build']);
  report.packaging_verified = true;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(failure);
} finally {
  const result = {
    ...report,
    finished_at: new Date().toISOString(),
    status: failure ? 'failed' : 'passed',
    ...(failure ? { failure } : {}),
  };
  await writeFile(path.join(output, 'latest.json'), JSON.stringify(result, null, 2) + '\n');
  await writeFile(
    path.join(output, 'latest.md'),
    [
      '# Inflex Mac validation',
      '',
      `Status: ${result.status}`,
      `Host: ${result.platform} / ${result.architecture}; Node ${result.node}`,
      '',
      ...result.steps.map(value => `- ${value.status}: ${value.label} (${value.duration_ms} ms); ${value.log}`),
      '',
      ...(failure ? [`Failure: ${failure}`, ''] : []),
      'Still requires observation:',
      '',
      ...result.pending.map(value => `- ${value}`),
      '',
    ].join('\n'),
  );
  console.log(`Validation report: ${path.join(output, 'latest.md')}`);
}
