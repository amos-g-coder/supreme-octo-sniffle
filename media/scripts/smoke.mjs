import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, URL } from 'node:url';

const directory = await mkdtemp(path.join(tmpdir(), 'inflex-framefields-'));
function command(executable, args, input) {
  const result = spawnSync(executable, args, { input, encoding: 'utf8', timeout: 120_000, maxBuffer: 8_000_000 });
  if (result.error) {
    throw new Error(`Cannot run ${executable}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`${executable} failed (${result.signal ?? result.status}): ${result.stderr}`);
  }
  return result.stdout;
}
try {
  const source = path.join(directory, 'source.mp4');
  const project = path.join(directory, 'project.json');
  const output = path.join(directory, 'output.mp4');
  command('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=10:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-shortest',
    '-y',
    source,
  ]);
  await writeFile(
    project,
    JSON.stringify({
      version: 1,
      source,
      width: 320,
      height: 180,
      fps: 10,
      trim_start: 0.2,
      duration: 0.6,
      captions: [{ text: 'Inflex export', start: 0, end: 0.6 }],
      overlays: [
        {
          label: 'Tracked label',
          start: 0,
          end: 0.6,
          x: 0.2,
          y: 0.3,
          keyframes: [
            { time: 0, x: 0.2, y: 0.3, provenance: 'observed' },
            { time: 0.5, x: 0.8, y: 0.3, provenance: 'observed' },
          ],
        },
      ],
    }),
  );
  const started = performance.now();
  command(
    process.execPath,
    [fileURLToPath(new URL('../worker.mjs', import.meta.url))],
    JSON.stringify({ operation: 'render', project, output }) + '\n',
  );
  const metadata = JSON.parse(
    command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]),
  );
  assert.ok(
    metadata.streams.some(stream => stream.codec_type === 'video' && stream.width === 320 && stream.height === 180),
  );
  assert.ok(Math.abs(Number(metadata.format.duration) - 0.6) <= 0.15);
  assert.ok((await stat(output)).size > 1000);
  console.log(
    JSON.stringify({
      passed: true,
      engine: 'Framefields',
      rendered_mp4: true,
      export_ms: Math.round(performance.now() - started),
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
