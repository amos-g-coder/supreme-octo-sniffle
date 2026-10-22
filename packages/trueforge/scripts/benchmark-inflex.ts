import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { inflexConfiguration } from '../src/config';
import { analyzeVideo } from '../src/inflex/media';
import { runProcess } from '../src/inflex/process';

const directory = await mkdtemp(path.join(tmpdir(), 'inflex-benchmark-'));
const portProbe = createServer();
await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const address = portProbe.address();
if (!address || typeof address === 'string') {
  throw new Error('Cannot reserve benchmark port');
}
await new Promise<void>((resolve, reject) =>
  portProbe.close(error => {
    if (error) {
      reject(error);
    } else {
      resolve();
    }
  }),
);
const started = performance.now();
const runtime = spawn(
  process.execPath,
  [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'serve', '--port', String(address.port)],
  {
    env: {
      ...inflexConfiguration.execution_env,
      INFLEX_DATA_DIR: directory,
      INFLEX_WORKSPACE: directory,
      INFLEX_MEMORY: 'off',
      STANDALONE: 'true',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let diagnosticLog = '';
const capture = (chunk: Buffer) => {
  diagnosticLog = (diagnosticLog + chunk.toString()).slice(-16_000);
};
runtime.stdout.on('data', capture);
runtime.stderr.on('data', capture);
const exited = new Promise<void>(resolve =>
  runtime.once('close', () => {
    resolve();
  }),
);
const base = `http://127.0.0.1:${String(address.port)}`;
const signal = new AbortController().signal;
try {
  for (;;) {
    if (runtime.exitCode !== null || performance.now() - started > 30_000) {
      throw new Error(`Runtime did not start: ${diagnosticLog}`);
    }
    try {
      if ((await fetch(base + '/healthz', { signal: AbortSignal.timeout(1000) })).ok) {
        break;
      }
    } catch {
      /* Retry only while the child is starting. */
    }
    await delay(25);
  }
  const startupMs = performance.now() - started;
  await delay(1000);
  const diagnostics = z
    .object({
      data: z.object({
        runtime: z.object({
          rss_mb: z.number(),
          active_resources: z.array(z.string()),
          schedules_enabled: z.boolean(),
        }),
      }),
    })
    .parse(await (await fetch(base + '/api/v1/inflex/diagnostics')).json());
  const source = path.join(directory, 'fixture.mp4');
  const fixture = await runProcess({
    command: inflexConfiguration.ffmpeg,
    args: [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=10:duration=2',
      '-c:v',
      'libx264',
      '-y',
      source,
    ],
    cwd: directory,
    signal,
  });
  if (fixture.exit_code !== 0) {
    throw new Error(fixture.stderr);
  }
  const mediaStarted = performance.now();
  const fresh = await analyzeVideo({ source, directory, signal, samples: 4, detect: false });
  const freshMs = performance.now() - mediaStarted;
  const cachedStarted = performance.now();
  const cached = await analyzeVideo({ source, directory, signal, samples: 4, detect: false });
  if (fresh.cached || !cached.cached || diagnostics.data.runtime.schedules_enabled) {
    throw new Error('Benchmark invariants failed');
  }
  console.log(
    JSON.stringify(
      {
        startup_ms: Math.round(startupMs),
        idle: diagnostics.data.runtime,
        video_first_ms: Math.round(freshMs),
        video_cached_ms: Math.round(performance.now() - cachedStarted),
        fixture_seconds: 2,
        samples: 4,
        note: 'Observed on this machine; not a resource budget or live inference benchmark.',
      },
      null,
      2,
    ),
  );
} finally {
  runtime.kill('SIGTERM');
  const force = setTimeout(() => runtime.kill('SIGKILL'), 5000);
  force.unref();
  await exited;
  clearTimeout(force);
  await rm(directory, { recursive: true, force: true });
}
