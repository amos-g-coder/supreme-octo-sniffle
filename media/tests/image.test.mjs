import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import sharp from 'sharp';

test('processes an actual image in an on-demand worker without requiring a GPU', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inflex-image-'));
  try {
    const source = path.join(directory, 'source.png');
    const output = path.join(directory, 'result.webp');
    await sharp({ create: { width: 64, height: 32, channels: 3, background: '#ff0000' } })
      .png()
      .toFile(source);
    await new Promise((resolve, reject) => {
      const worker = spawn(process.execPath, [fileURLToPath(new URL('../worker.mjs', import.meta.url))], {
        stdio: ['pipe', 'ignore', 'pipe'],
        timeout: 15_000,
      });
      let diagnostic = '';
      worker.stderr.on('data', chunk => {
        diagnostic += chunk.toString();
      });
      worker.once('error', reject);
      worker.once('close', code => (code === 0 ? resolve() : reject(new Error(diagnostic))));
      worker.stdin.end(
        JSON.stringify({
          operation: 'image',
          source,
          output,
          format: 'webp',
          crop: { x: 0, y: 0, width: 32, height: 16 },
          rotation: 90,
          width: 8,
        }) + '\n',
      );
    });
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, 8);
    assert.equal(metadata.height, 16);
    assert.equal(metadata.format, 'webp');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
