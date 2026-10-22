import { TemporalObjectTracker, VisionRunner } from 'framefields';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import sharp from 'sharp';
import { createComposition } from './composition.mjs';

async function execute(job) {
  if (job.operation === 'image') {
    let image = sharp(job.source, { limitInputPixels: 64_000_000 }).autoOrient();
    if (job.crop) {
      // Materialize the oriented crop because Sharp otherwise rotates before extraction.
      image = sharp(
        await image
          .extract({ left: job.crop.x, top: job.crop.y, width: job.crop.width, height: job.crop.height })
          .toBuffer(),
      );
    }
    if (job.rotation) {
      image = image.rotate(job.rotation);
    }
    if (job.width || job.height) {
      image = image.resize({ width: job.width, height: job.height, fit: 'inside', withoutEnlargement: true });
    }
    const result = await image.toFormat(job.format).toFile(job.output);
    return { path: job.output, width: result.width, height: result.height, format: result.format, size: result.size };
  }
  if (job.operation === 'detect') {
    const runner = VisionRunner.create({ variant: 't', modelsDir: job.models_dir });
    try {
      const detections = [];
      for (const frame of job.frames) {
        const { data, info } = await sharp(frame.path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        detections.push(await runner.detect({ data: new Uint8Array(data), width: info.width, height: info.height }));
      }
      const tracker = new TemporalObjectTracker();
      const tracks = tracker.trackSequence(detections, detections.length, job.sample_fps);
      return {
        observations: job.frames.map((frame, index) => ({
          source_pts: frame.source_pts,
          timeline_seconds: frame.timeline_seconds,
          detections: detections[index],
          tracks: tracks[index].map(track => ({
            track_id: track.trackId,
            category: track.category,
            confidence: track.score,
            bounding_box: track.boundingBox,
            normalized_center: { x: track.normalizedCenterX, y: track.normalizedCenterY },
            active: track.active,
            provenance: track.isCoasting ? 'coasting_estimate' : 'associated_smoothed_estimate',
          })),
        })),
        timing:
          'Each observation uses original source PTS. Smoothed track positions and identity across sampling gaps are estimates; raw detections are retained separately.',
      };
    } finally {
      runner.close();
    }
  }
  if (job.operation === 'render') {
    const project = JSON.parse(await readFile(job.project, 'utf8'));
    const comp = createComposition(project);
    await comp.renderVideo({ outputPath: job.output, quality: 'medium' });
    return { path: job.output, project: job.project };
  }
  if (job.operation === 'probe') {
    return { available: true, engine: 'framefields', version: '2.4.0' };
  }
  throw new Error('Unknown Framefields operation');
}
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  try {
    const result = await execute(JSON.parse(line));
    await new Promise((resolve, reject) =>
      process.stdout.write(JSON.stringify({ result }) + '\n', error => (error ? reject(error) : resolve())),
    );
  } catch (error) {
    process.stderr.write(String(error) + '\n');
    process.exitCode = 1;
  }
}

process.exit(process.exitCode ?? 0);
