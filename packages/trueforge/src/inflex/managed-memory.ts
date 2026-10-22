import { HindsightServer } from '@vectorize-io/hindsight-all';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { z } from 'zod';
import { inflexConfiguration } from '../config';
import type { ChatGPTOAuth } from './oauth';
import { inferenceScheduler } from './scheduler';

/** Hindsight gets a loopback inference proxy, never a copy of the owner's OAuth grant. */
export class ManagedMemory {
  private startup: Promise<string> | undefined;
  private stopServer: (() => Promise<void>) | undefined;
  constructor(
    private readonly auth: ChatGPTOAuth,
    private readonly select_model: () => Promise<string>,
  ) {}
  start(): Promise<string> {
    this.startup ??= this.boot().catch((error: unknown) => {
      this.startup = undefined;
      throw error;
    });
    return this.startup;
  }
  async stop(): Promise<void> {
    await this.stopServer?.();
    this.startup = undefined;
    this.stopServer = undefined;
  }
  private async boot(): Promise<string> {
    const memoryModel = inflexConfiguration.hindsight_model ?? (await this.select_model());
    const key = randomBytes(32).toString('hex');
    const proxy = createServer((request, response) => {
      void (async () => {
        const cancellation = new AbortController();
        response.on('close', () => {
          if (!response.writableEnded) {
            cancellation.abort();
          }
        });
        let release: (() => void) | undefined;
        try {
          const bearer = request.headers.authorization ?? '';
          const expected = `Bearer ${key}`;
          if (
            bearer.length !== expected.length ||
            !timingSafeEqual(Buffer.from(bearer), Buffer.from(expected)) ||
            request.url !== '/v1/responses' ||
            request.method !== 'POST'
          ) {
            response.writeHead(403).end();
            return;
          }
          let body = '';
          for await (const chunk of request) {
            body += String(chunk);
            if (body.length > 4_000_000) {
              throw new Error('Memory inference request too large');
            }
          }
          const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(body));
          const excluded = new Set([
            'background',
            'conversation',
            'max_output_tokens',
            'max_tool_calls',
            'metadata',
            'moderation',
            'multi_agent',
            'prompt',
            'prompt_cache_retention',
            'safety_identifier',
            'temperature',
            'top_logprobs',
            'top_p',
            'truncation',
            'user',
            'previous_response_id',
            'service_tier',
          ]);
          const safe = Object.fromEntries(Object.entries(parsed).filter(([name]) => !excluded.has(name)));
          release = await inferenceScheduler.acquire({ priority: -1, signal: cancellation.signal });
          const upstream = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${await this.auth.accessToken()}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ...safe, model: memoryModel, store: false, stream: true }),
            signal: cancellation.signal,
          });
          response.writeHead(upstream.status, {
            'Content-Type': upstream.headers.get('Content-Type') ?? 'text/event-stream',
            'Cache-Control': 'no-store',
          });
          if (upstream.body) {
            for await (const chunk of upstream.body) {
              if (!response.write(chunk)) {
                await once(response, 'drain', { signal: cancellation.signal });
              }
            }
          }
          response.end();
        } catch {
          if (!response.headersSent) {
            response.writeHead(502);
          }
          response.end();
        } finally {
          release?.();
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === 'string') {
      proxy.close();
      throw new Error('Cannot bind the local memory inference gateway');
    }
    const server = new HindsightServer({
      profile: 'inflex',
      host: '127.0.0.1',
      port: inflexConfiguration.hindsight_port,
      embedVersion: '1.1.0',
      readyTimeoutMs: 120_000,
      env: {
        HINDSIGHT_API_LLM_PROVIDER: 'openai-responses',
        HINDSIGHT_API_LLM_MODEL: memoryModel,
        HINDSIGHT_API_LLM_API_KEY: key,
        HINDSIGHT_API_LLM_BASE_URL: `http://127.0.0.1:${String(address.port)}/v1`,
        HINDSIGHT_API_DATABASE_URL: `pg0://${inflexConfiguration.hindsight_database}`,
        HINDSIGHT_API_HOST: '127.0.0.1',
        HINDSIGHT_API_ENABLE_DOCUMENT_EXPORT_API: 'true',
        HINDSIGHT_API_ENABLE_DOCUMENT_IMPORT_API: 'true',
      },
    });
    this.stopServer = async () => {
      await server.stop();
      proxy.close();
      proxy.closeAllConnections();
    };
    try {
      await server.start();
      return server.getBaseUrl();
    } catch (error) {
      await this.stop();
      throw new Error('Local Hindsight could not start; queued memories remain on disk', { cause: error });
    }
  }
}
