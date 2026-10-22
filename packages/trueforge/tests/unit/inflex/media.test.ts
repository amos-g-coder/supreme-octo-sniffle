import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { analyzeAudio, analyzeVideo, probeMedia } from '../../../src/inflex/media';
import { runProcess } from '../../../src/inflex/process';

it('decodes timestamped video evidence and audio from real FFmpeg fixtures and reuses the content cache', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inflex-media-'));
  const signal = new AbortController().signal;
  try {
    const source = path.join(directory, 'fixture.mp4');
    const generated = await runProcess({
      command: 'ffmpeg',
      args: [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x90:rate=5:duration=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-shortest',
        '-y',
        source,
      ],
      cwd: directory,
      signal,
    });
    expect(generated.exit_code).toBe(0);
    expect((await probeMedia({ source, signal })).streams).toHaveLength(2);
    const analyzed = await analyzeVideo({ source, directory, signal, samples: 4, detect: false });
    const manifest = z
      .object({
        frames: z.array(z.object({ path: z.string(), source_pts: z.number(), timeline_seconds: z.number() })),
        coverage: z.object({ sampled_frames: z.number() }),
      })
      .parse(analyzed.manifest);
    expect(manifest.frames).toHaveLength(4);
    expect(manifest.frames[0]?.source_pts).toBe(0);
    expect(manifest.frames.at(-1)?.source_pts).toBeCloseTo(1.6);
    for (const frame of manifest.frames) expect((await stat(frame.path)).size).toBeGreaterThan(0);
    expect((await analyzeVideo({ source, directory, signal, samples: 4, detect: false })).cached).toBe(true);
    const copy = path.join(directory, 'same-content-different-source.mp4');
    await copyFile(source, copy);
    const copied = await analyzeVideo({ source: copy, directory, signal, samples: 4, detect: false });
    expect(copied.cached).toBe(false);
    expect(copied.manifest).toHaveProperty('source', copy);
    const audio = await analyzeAudio({ source, directory, signal, transcribe: false });
    expect(audio.measurements).toContain('RMS level dB');
    expect((await stat(audio.spectrum_path)).size).toBeGreaterThan(0);
    expect(audio.metadata.streams.find(stream => stream.codec_type === 'audio')?.channels).toBe(1);
    expect(audio.transcript).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps nonzero source PTS separate from the editable timeline', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inflex-offset-'));
  const signal = new AbortController().signal;
  try {
    const source = path.join(directory, 'offset.mp4');
    const generated = await runProcess({
      command: 'ffmpeg',
      args: [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x90:rate=5:duration=2',
        '-c:v',
        'libx264',
        '-output_ts_offset',
        '5',
        '-y',
        source,
      ],
      cwd: directory,
      signal,
    });
    expect(generated.exit_code).toBe(0);
    const analyzed = await analyzeVideo({ source, directory, signal, samples: 2, detect: false });
    const manifest = z
      .object({
        duration: z.number(),
        source_start_pts: z.number(),
        frames: z.array(z.object({ source_pts: z.number(), timeline_seconds: z.number() })),
      })
      .parse(analyzed.manifest);
    expect(manifest.duration).toBeCloseTo(2);
    expect(manifest.source_start_pts).toBeCloseTo(5);
    expect(manifest.frames[0]).toMatchObject({ source_pts: 5, timeline_seconds: 0 });
    expect(manifest.frames[1]).toMatchObject({ source_pts: 6, timeline_seconds: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('samples beyond a long GOP using actual presentation times', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inflex-gop-'));
  const signal = new AbortController().signal;
  try {
    const source = path.join(directory, 'long-gop.mp4');
    const generated = await runProcess({
      command: 'ffmpeg',
      args: [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x90:rate=5:duration=8',
        '-c:v',
        'libx264',
        '-g',
        '40',
        '-y',
        source,
      ],
      cwd: directory,
      signal,
    });
    expect(generated.exit_code).toBe(0);
    const analyzed = await analyzeVideo({ source, directory, signal, samples: 4, detect: false });
    const manifest = z.object({ frames: z.array(z.object({ source_pts: z.number() })) }).parse(analyzed.manifest);
    expect(manifest.frames.map(frame => frame.source_pts)).toEqual([0, 2, 4, 6]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
