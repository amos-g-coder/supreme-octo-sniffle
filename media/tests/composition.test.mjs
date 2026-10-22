import assert from 'node:assert/strict';
import test from 'node:test';
import { createComposition } from '../composition.mjs';

test('builds frame-accurate trims, captions, narration and tracked overlays without initializing a GPU', async () => {
  const composition = createComposition({
    source: 'fixture.mp4',
    source_width: 160,
    source_height: 90,
    width: 160,
    height: 90,
    fps: 10,
    trim_start: 2,
    duration: 3,
    captions: [{ text: 'Caption', start: 0.5, end: 1 }],
    overlays: [
      {
        label: 'Subject',
        start: 0,
        end: 3,
        x: 0.2,
        y: 0.5,
        keyframes: [
          { time: 0, x: 0.2, y: 0.5, provenance: 'observed' },
          { time: 2, x: 0.8, y: 0.5, provenance: 'observed' },
        ],
      },
    ],
    narration: 'narration.wav',
  });
  assert.equal(composition.durationMs, 3000);
  assert.equal(composition.children[0].trimStartSec, 2);
  assert.equal(composition.children[1].startFrame, 5);
  assert.equal(composition.children[1].durationFrames, 5);
  await composition.notifyFrame({
    frame: 10,
    fps: 10,
    time: 1,
    duration: 3,
    durationMs: 3000,
    progress: 1 / 3,
    deltaTime: 0.1,
  });
  assert.equal(composition.children[2].x, 80);
  assert.equal(composition.children[2].y, 45);
  assert.equal(composition.children.at(-1).dataType, 'Audio');
});
