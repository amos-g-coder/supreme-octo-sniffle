import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { inflexConfiguration } from '../config';
import { runProcess } from './process';

const StreamSchema = z.object({
  codec_type: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  avg_frame_rate: z.string().optional(),
  start_time: z.string().optional(),
  duration: z.string().optional(),
  sample_rate: z.string().optional(),
  channels: z.number().optional(),
  channel_layout: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
});
const ProbeSchema = z.object({
  streams: z.array(StreamSchema),
  format: z.object({
    duration: z.string().optional(),
    format_name: z.string().optional(),
    start_time: z.string().optional(),
  }),
});
const FrameTimesSchema = z.object({
  frames: z.array(
    z.object({ best_effort_timestamp_time: z.string().optional(), pkt_duration_time: z.string().optional() }),
  ),
});
export const VideoProjectSchema = z.object({
  version: z.literal(1),
  source: z.string(),
  source_hash: z.string(),
  width: z.number().int().positive().max(7680),
  height: z.number().int().positive().max(4320),
  fps: z.number().positive().max(120),
  trim_start: z.number().nonnegative(),
  duration: z.number().positive(),
  captions: z
    .array(z.object({ text: z.string(), start: z.number().nonnegative(), end: z.number().positive() }))
    .max(5000),
  overlays: z
    .array(
      z.object({
        label: z.string(),
        start: z.number().nonnegative(),
        end: z.number().positive(),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        track_id: z.string().optional(),
        keyframes: z
          .array(
            z.object({
              time: z.number().nonnegative(),
              x: z.number().min(0).max(1),
              y: z.number().min(0).max(1),
              source_pts: z.number().optional(),
              provenance: z.enum(['observed', 'interpolated', 'vlm_estimate']),
            }),
          )
          .min(1)
          .max(10000)
          .optional(),
      }),
    )
    .max(5000),
  narration: z.string().optional(),
  subject_matte: z.boolean().optional(),
  source_width: z.number().positive().optional(),
  source_height: z.number().positive().optional(),
});
export type VideoProject = z.infer<typeof VideoProjectSchema>;

async function ffmpeg(input: { args: string[]; signal: AbortSignal; output_limit?: number }) {
  const result = await runProcess({
    command: inflexConfiguration.ffmpeg,
    args: ['-hide_banner', '-loglevel', 'error', '-nostdin', ...input.args],
    cwd: '/',
    signal: input.signal,
    timeout_ms: 600_000,
    max_bytes: input.output_limit ?? 2_000_000,
  });
  if (result.exit_code !== 0) {
    throw new Error(`FFmpeg failed: ${result.stderr}`);
  }
  return result;
}
export async function probeMedia(input: { source: string; signal: AbortSignal }) {
  const result = await runProcess({
    command: inflexConfiguration.ffprobe,
    args: ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input.source],
    cwd: '/',
    signal: input.signal,
  });
  if (result.exit_code !== 0) {
    throw new Error(`Cannot inspect media: ${result.stderr}`);
  }
  return ProbeSchema.parse(JSON.parse(result.stdout));
}
const sourceHashes = new Map<string, { identity: string; hash: string }>();
export async function contentHash(source: string): Promise<string> {
  const info = await stat(source);
  const identity = JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
  const cached = sourceHashes.get(source);
  if (cached?.identity === identity) {
    return cached.hash;
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(source)) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error('Invalid media stream');
    }
    hash.update(chunk);
  }
  const digest = hash.digest('hex');
  if (sourceHashes.size > 64) {
    sourceHashes.clear();
  }
  sourceHashes.set(source, { identity, hash: digest });
  return digest;
}
export async function analyzeVideo(input: {
  source: string;
  directory: string;
  signal: AbortSignal;
  samples: number;
  detect: boolean;
}) {
  input.signal.throwIfAborted();
  const hash = await contentHash(input.source);
  const count = Math.max(1, Math.min(48, Math.floor(input.samples)));
  const cacheKey = createHash('sha256')
    .update(JSON.stringify({ source: input.source, hash, count, detect: input.detect, version: 2 }))
    .digest('hex');
  const directory = path.join(input.directory, cacheKey);
  const manifestPath = path.join(directory, 'analysis.json');
  try {
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    return { manifest, manifest_path: manifestPath, cached: true };
  } catch (error) {
    if (!z.object({ code: z.literal('ENOENT') }).safeParse(error).success) {
      throw error;
    }
  }
  const metadata = await probeMedia(input);
  const stream = metadata.streams.find(item => item.codec_type === 'video');
  if (!stream?.width || !stream.height) {
    throw new Error('The source has no decodable video stream');
  }
  const duration = Number(stream.duration ?? metadata.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Video duration is unavailable');
  }
  await mkdir(directory, { recursive: true });
  const startPts = Number(stream.start_time ?? metadata.format.start_time ?? '0');
  const frames: { path: string; source_pts: number; timeline_seconds: number; sampling: string }[] = [];
  for (let index = 0; index < count; index++) {
    input.signal.throwIfAborted();
    const target = Math.min(duration - 0.001, (duration * index) / count);
    const pts = await runProcess({
      command: inflexConfiguration.ffprobe,
      args: [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-read_intervals',
        `${String(startPts + target)}%${String(startPts + target + 2)}`,
        '-show_frames',
        '-show_entries',
        'frame=best_effort_timestamp_time,pkt_duration_time',
        '-of',
        'json',
        input.source,
      ],
      cwd: '/',
      signal: input.signal,
      max_bytes: 2_000_000,
    });
    if (pts.exit_code !== 0) {
      throw new Error(`Cannot inspect frame timestamps: ${pts.stderr}`);
    }
    const times = FrameTimesSchema.parse(JSON.parse(pts.stdout))
      .frames.map(frame => Number(frame.best_effort_timestamp_time))
      .filter(Number.isFinite);
    const actual = times.find(time => time >= startPts + target - 0.000001);
    if (actual === undefined) {
      continue;
    }
    const destination = path.join(directory, `frame-${String(index)}.jpg`);
    await ffmpeg({
      args: [
        '-ss',
        String(Math.max(0, actual - startPts)),
        '-i',
        input.source,
        '-frames:v',
        '1',
        '-vf',
        'scale=1024:1024:force_original_aspect_ratio=decrease',
        '-y',
        destination,
      ],
      signal: input.signal,
    });
    frames.push({
      path: destination,
      source_pts: actual,
      timeline_seconds: actual - startPts,
      sampling: 'observed source frame; source_pts is presentation time',
    });
  }
  if (!frames.length) {
    throw new Error('No sampled frames decoded');
  }
  const detections = input.detect
    ? await mediaJob({
        job: {
          operation: 'detect',
          frames,
          sample_fps: count / duration,
          models_dir: path.join(input.directory, 'models'),
        },
        signal: input.signal,
      })
    : null;
  if ((await contentHash(input.source)) !== hash) {
    throw new Error('Source video changed during analysis; repeat against the updated source');
  }
  const manifest = {
    version: 1,
    source: input.source,
    source_hash: hash,
    metadata,
    duration,
    source_start_pts: startPts,
    rotation:
      stream.side_data_list?.find(item => item.rotation !== undefined)?.rotation ??
      Number(stream.tags?.['rotate'] ?? 0),
    frames,
    detections,
    coverage: {
      sampled_frames: frames.length,
      source_duration: duration,
      method: 'uniform temporal sampling; unsampled motion and short events may be missed',
      position_space: 'display-oriented sampled frame coordinates; no calibrated 3D inference',
      track_interpolation:
        'Framefields tracks use sample indices; map them through the frames array. Gaps and coasting are inferred, not observations.',
    },
  };
  await writeFile(manifestPath + '.tmp', JSON.stringify(manifest, null, 2));
  await rename(manifestPath + '.tmp', manifestPath);
  return { manifest, manifest_path: manifestPath, cached: false };
}
export async function mediaJob(input: { job: Record<string, unknown>; signal: AbortSignal }) {
  const result = await runProcess({
    command: process.execPath,
    args: [inflexConfiguration.media_worker],
    cwd: path.dirname(inflexConfiguration.media_worker),
    signal: input.signal,
    stdin: JSON.stringify(input.job) + '\n',
    timeout_ms: 600_000,
    max_bytes: 8_000_000,
  });
  if (result.exit_code !== 0) {
    throw new Error(`Media worker failed: ${result.stderr}`);
  }
  const last = result.stdout
    .trim()
    .split('\n')
    .findLast(line => line.startsWith('{'));
  if (!last) {
    throw new Error('Media worker returned no result');
  }
  return z.object({ result: z.unknown() }).parse(JSON.parse(last)).result;
}
export async function analyzeAudio(input: {
  source: string;
  directory: string;
  signal: AbortSignal;
  transcribe: boolean;
}) {
  await mkdir(input.directory, { recursive: true });
  const metadata = await probeMedia(input);
  if (!metadata.streams.some(stream => stream.codec_type === 'audio')) {
    throw new Error('The source has no decodable audio stream');
  }
  const pcm = path.join(input.directory, `${(await contentHash(input.source)).slice(0, 24)}.wav`);
  const spectrum = pcm + '.spectrum.png';
  await ffmpeg({
    args: [
      '-i',
      input.source,
      '-lavfi',
      'showspectrumpic=s=1024x512:legend=1:scale=log',
      '-frames:v',
      '1',
      '-y',
      spectrum,
    ],
    signal: input.signal,
  });
  await ffmpeg({
    args: ['-i', input.source, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', pcm],
    signal: input.signal,
  });
  const metrics = await runProcess({
    command: inflexConfiguration.ffmpeg,
    args: [
      '-hide_banner',
      '-nostdin',
      '-i',
      input.source,
      '-vn',
      '-af',
      'astats=metadata=1:reset=0,silencedetect=noise=-40dB:d=0.3',
      '-f',
      'null',
      '-',
    ],
    cwd: '/',
    signal: input.signal,
    max_bytes: 2_000_000,
  });
  if (metrics.exit_code !== 0) {
    throw new Error('Audio measurement failed');
  }
  let transcript: unknown = null;
  if (input.transcribe) {
    if (!inflexConfiguration.whisper_model) {
      throw new Error('Install whisper.cpp and configure INFLEX_WHISPER_MODEL for dictation');
    }
    const prefix = pcm + '.transcript';
    const result = await runProcess({
      command: inflexConfiguration.whisper,
      args: ['-m', inflexConfiguration.whisper_model, '-f', pcm, '-oj', '-of', prefix],
      cwd: '/',
      signal: input.signal,
      timeout_ms: 600_000,
    });
    if (result.exit_code !== 0) {
      throw new Error(`Transcription failed: ${result.stderr}`);
    }
    transcript = JSON.parse(await readFile(prefix + '.json', 'utf8'));
  }
  return {
    pcm_path: pcm,
    spectrum_path: spectrum,
    metadata,
    measurements: metrics.stderr,
    transcript,
    coverage:
      'Levels, silence, clipping and spectrum are measured on the source audio. Speech recognition uses a mono 16 kHz analysis copy; retain the original for mastering. Transcript offsets are relative to the audio stream start time reported in metadata.',
  };
}
export async function synthesizeSpeech(input: { text: string; output: string; signal: AbortSignal }): Promise<string> {
  if (!inflexConfiguration.piper_model) {
    throw new Error('Install Piper and configure INFLEX_PIPER_MODEL for speech output');
  }
  const result = await runProcess({
    command: inflexConfiguration.piper,
    args: ['--model', inflexConfiguration.piper_model, '--output_file', input.output],
    stdin: input.text,
    cwd: '/',
    signal: input.signal,
    timeout_ms: 300_000,
  });
  if (result.exit_code !== 0) {
    throw new Error(`Speech synthesis failed: ${result.stderr}`);
  }
  return input.output;
}
