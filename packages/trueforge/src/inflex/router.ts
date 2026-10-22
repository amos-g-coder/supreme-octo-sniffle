import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { stream } from 'hono/streaming';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { inflexConfiguration } from '../config';
import { artifactRoot, listArtifacts } from './artifacts';
import { runProcess } from './process';
import { chatgptAuth } from './runtime';
import { inferenceScheduler } from './scheduler';
import { localConnections } from './stdio';
import { workspacePath } from './workspace';

export async function inflexDoctor() {
  const runtime = {
    rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    active_resources: process.getActiveResourcesInfo(),
    schedules_enabled: inflexConfiguration.enable_schedules,
  };
  const commands = [
    inflexConfiguration.ffmpeg,
    inflexConfiguration.ffprobe,
    'git',
    'rg',
    inflexConfiguration.whisper,
    inflexConfiguration.piper,
    inflexConfiguration.diffusion,
    'markitdown',
    inflexConfiguration.tesseract,
  ];
  const capabilities = await Promise.all(
    commands.map(async command => {
      try {
        const result = await runProcess({
          command: '/bin/sh',
          args: ['-c', 'command -v "$1"', 'inflex-doctor', command],
          cwd: '/',
          signal: undefined,
          timeout_ms: 5000,
        });
        return { name: command, available: result.exit_code === 0 };
      } catch {
        return { name: command, available: false };
      }
    }),
  );
  const present = async (target: string | undefined) => {
    if (!target) {
      return false;
    }
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  };
  const dependencies = await SandboxManager.checkDependenciesAsync();
  return {
    runtime,
    connections_file: inflexConfiguration.connections_file,
    connected_servers: (await localConnections()).map(server => ({ name: server.name, command: server.command })),
    sandbox: {
      supported: SandboxManager.isSupportedPlatform(),
      errors: dependencies.errors,
      warnings: dependencies.warnings,
    },
    framefields_installed: await present(
      path.join(path.dirname(inflexConfiguration.media_worker), 'node_modules/framefields/package.json'),
    ),
    name: 'Inflex',
    platform: process.platform,
    native_target: 'macOS 14+ Apple Silicon',
    inference: {
      source: 'local ChatGPT OAuth',
      keychain_helper: await present(inflexConfiguration.keychain_helper),
      queue: inferenceScheduler.status,
    },
    workspace: inflexConfiguration.workspace,
    capabilities,
    media_worker: await present(inflexConfiguration.media_worker),
    whisper_model: await present(inflexConfiguration.whisper_model),
    piper_model: await present(inflexConfiguration.piper_model),
    image_model: await present(inflexConfiguration.diffusion_model),
    hindsight_enabled: Boolean(inflexConfiguration.hindsight_url ?? inflexConfiguration.hindsight_managed),
  };
}
export function createInflexRouter() {
  const router = new OpenAPIHono();
  router.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && new URL(origin).host !== new URL(c.req.url).host) {
      throw new HTTPException(403, { message: 'Local Inflex controls require a same-origin request' });
    }
    await next();
  });
  router.get('/artifacts', async c => c.json({ data: await listArtifacts() }));
  router.get('/artifacts/:artifact_id', async c => {
    const relative = Buffer.from(c.req.param('artifact_id'), 'base64url').toString('utf8');
    const target = await workspacePath({
      root: artifactRoot,
      requested: relative,
      write: false,
      owned_paths: undefined,
    });
    const info = await stat(target);
    if (!info.isFile()) {
      throw new HTTPException(404);
    }
    const extension = target.split('.').at(-1)?.toLowerCase();
    const mime = new Map([
      ['png', 'image/png'],
      ['jpg', 'image/jpeg'],
      ['jpeg', 'image/jpeg'],
      ['webp', 'image/webp'],
      ['mp4', 'video/mp4'],
      ['webm', 'video/webm'],
      ['wav', 'audio/wav'],
      ['mp3', 'audio/mpeg'],
      ['json', 'application/json'],
      ['pdf', 'application/pdf'],
    ]).get(extension ?? '');
    if (!mime) {
      throw new HTTPException(415);
    }
    let start = 0;
    let end = info.size - 1;
    const range = c.req.header('range');
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        throw new HTTPException(416);
      }
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
      if (start > end || end >= info.size) {
        throw new HTTPException(416);
      }
      c.status(206);
      c.header('Content-Range', `bytes ${String(start)}-${String(end)}/${String(info.size)}`);
    }
    c.header('Content-Type', mime);
    c.header('Content-Length', String(end - start + 1));
    c.header('Accept-Ranges', 'bytes');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, no-store');
    return stream(c, async output => {
      const file = createReadStream(target, { start, end });
      output.onAbort(() => {
        file.destroy();
      });
      try {
        for await (const chunk of file) {
          if (!(chunk instanceof Uint8Array)) {
            throw new Error('Invalid artifact stream');
          }
          await output.write(chunk);
        }
      } finally {
        file.destroy();
      }
    });
  });
  router.get('/diagnostics', async c => c.json({ data: await inflexDoctor() }));
  router.get('/credentials', async c =>
    c.json({
      data:
        process.platform === 'darwin'
          ? await chatgptAuth.status()
          : { authenticated: false, login_pending: false, reason: 'Native sign-in requires macOS' },
    }),
  );
  router.post('/sign-ins', async c => {
    const result = await chatgptAuth.begin();
    if (process.platform === 'darwin') {
      await runProcess({ command: '/usr/bin/open', args: [result.authorization_url], cwd: '/', signal: undefined });
    }
    return c.json({ data: result }, 201);
  });
  router.delete('/credentials', async c => {
    await chatgptAuth.logout();
    return c.json({ data: {} });
  });
  return router;
}
