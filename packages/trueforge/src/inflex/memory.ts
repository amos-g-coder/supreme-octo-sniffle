export function projectMemoryBank(workspace: string): string {
  return `project-${createHash('sha256').update(workspace).digest('hex').slice(0, 24)}`;
}
import { createHash } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

const MemorySchema = z.object({
  bank: z.string().min(1),
  session_id: z.string(),
  content: z.string().min(1).max(32_000),
  timestamp: z.string(),
  references: z.array(z.string()),
});
export type MemoryRecord = z.infer<typeof MemorySchema>;
export class HindsightMemory {
  private delivery: Promise<void> = Promise.resolve();
  constructor(
    private readonly options: {
      url: string | undefined;
      directory: string;
      fetch: typeof fetch;
      start?: () => Promise<string>;
    },
  ) {}
  get enabled(): boolean {
    return this.options.url !== undefined || this.options.start !== undefined;
  }
  private async endpoint(): Promise<string | undefined> {
    return this.options.url ?? (await this.options.start?.());
  }
  private async request(input: {
    bank: string;
    route: string;
    signal: AbortSignal;
    method?: string;
    body?: string | FormData | undefined;
  }): Promise<Response> {
    const endpoint = await this.endpoint();
    if (!endpoint) {
      throw new Error('Long-term memory is disabled');
    }
    const response = await this.options.fetch(
      `${endpoint}/v1/default/banks/${encodeURIComponent(input.bank)}/${input.route}`,
      {
        method: input.method ?? 'GET',
        ...(input.body === undefined ? {} : { body: input.body }),
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]),
      },
    );
    if (!response.ok && !(input.method === 'DELETE' && response.status === 404)) {
      throw new Error(`Memory operation failed (${String(response.status)})`);
    }
    return response;
  }
  async inspect(input: {
    bank: string;
    operation_id?: string | undefined;
    document_id?: string | undefined;
    offset: number;
    signal: AbortSignal;
  }): Promise<unknown> {
    const route = input.operation_id
      ? `operations/${encodeURIComponent(input.operation_id)}`
      : input.document_id
        ? `documents/${encodeURIComponent(input.document_id)}`
        : `documents?limit=50&offset=${String(input.offset)}`;
    return await (await this.request({ ...input, route })).json();
  }
  forget(input: { bank: string; document_id: string; signal: AbortSignal }): Promise<void> {
    const forgotten = this.delivery.then(async () => {
      if (/^[a-f0-9]{64}$/.test(input.document_id)) {
        const target = path.join(this.options.directory, input.document_id + '.json');
        try {
          const record = MemorySchema.parse(JSON.parse(await readFile(target, 'utf8')));
          if (record.bank === input.bank) {
            await unlink(target);
          }
        } catch (error) {
          if (!z.object({ code: z.literal('ENOENT') }).safeParse(error).success) {
            throw error;
          }
        }
      }
      await (
        await this.request({ ...input, route: `documents/${encodeURIComponent(input.document_id)}`, method: 'DELETE' })
      ).arrayBuffer();
    });
    this.delivery = forgotten.catch(() => {
      /* Subsequent memory operations remain usable after a provider error. */
    });
    return forgotten;
  }
  async startExport(input: { bank: string; signal: AbortSignal }): Promise<unknown> {
    return await (
      await this.request({
        ...input,
        route: 'transfer/export?include_data=true&include_bank_config=true&include_history=false',
        method: 'POST',
      })
    ).json();
  }
  async restore(input: { bank: string; archive: string; signal: AbortSignal }): Promise<unknown> {
    const form = new FormData();
    form.set('file', await openAsBlob(input.archive, { type: 'application/zip' }), 'inflex-memory.zip');
    return await (
      await this.request({
        ...input,
        route: 'transfer/import?mode=merge&document_conflict=skip',
        method: 'POST',
        body: form,
      })
    ).json();
  }
  async download(input: { bank: string; operation_id: string; output: string; signal: AbortSignal }): Promise<void> {
    const operation = z
      .object({ status: z.literal('completed'), result_metadata: z.object({ download_url: z.string() }) })
      .parse(await this.inspect({ ...input, offset: 0 }));
    const endpoint = await this.endpoint();
    if (!endpoint) {
      throw new Error('Long-term memory is disabled');
    }
    const target = new URL(operation.result_metadata.download_url, endpoint);
    if (target.origin !== new URL(endpoint).origin || !target.pathname.startsWith('/v1/default/files/download/')) {
      throw new Error('Memory export returned an invalid download location');
    }
    const response = await this.options.fetch(target, { signal: input.signal });
    if (!response.ok || !response.body) {
      throw new Error('Memory export download failed');
    }
    const temporary = input.output + '.inflex-download';
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), {
        signal: input.signal,
      });
      await rename(temporary, input.output);
    } catch (error) {
      await unlink(temporary).catch(() => {
        /* Failed exports must not replace an existing backup. */
      });
      throw error;
    }
  }
  async recall(input: { bank: string; query: string; signal: AbortSignal }): Promise<unknown> {
    const url = await this.endpoint();
    if (!url) {
      return { available: false, reason: 'Long-term memory has not been enabled' };
    }
    const response = await this.options.fetch(
      `${url}/v1/default/banks/${encodeURIComponent(input.bank)}/memories/recall`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: input.query, budget: 'low', max_tokens: 2048 }),
        signal: input.signal,
      },
    );
    if (response.status === 404) {
      return { bank: input.bank, results: [] };
    }
    if (!response.ok) {
      throw new Error(`Memory recall unavailable (${String(response.status)})`);
    }
    return await response.json();
  }
  async retain(record: MemoryRecord): Promise<string> {
    const validated = MemorySchema.parse(record);
    const key = createHash('sha256').update(JSON.stringify(validated)).digest('hex');
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.options.directory, key + '.json');
    await writeFile(target + '.tmp', JSON.stringify(validated), { mode: 0o600 });
    await rename(target + '.tmp', target);
    return key;
  }
  flush(signal: AbortSignal): Promise<{ retained: number; pending: number }> {
    const delivery = this.delivery.then(() => this.flushPending(signal));
    this.delivery = delivery.then(
      () => {
        /* Drain queued submissions serially. */
      },
      () => {
        /* Preserve retryability. */
      },
    );
    return delivery;
  }
  private async flushPending(signal: AbortSignal): Promise<{ retained: number; pending: number }> {
    if (!this.enabled) {
      return { retained: 0, pending: 0 };
    }
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.options.directory)).filter(name => name.endsWith('.json'));
    if (!files.length) {
      return { retained: 0, pending: 0 };
    }
    const url = await this.endpoint();
    if (!url) {
      return { retained: 0, pending: files.length };
    }
    let retained = 0;
    for (const file of files.slice(0, 10)) {
      const record = MemorySchema.parse(JSON.parse(await readFile(path.join(this.options.directory, file), 'utf8')));
      const response = await this.options.fetch(`${url}/v1/default/banks/${encodeURIComponent(record.bank)}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          items: [
            {
              content: record.content,
              context: `Session ${record.session_id}; references ${record.references.join(', ')}`,
              timestamp: record.timestamp,
              document_id: file.replace(/\.json$/, ''),
              update_mode: 'replace',
            },
          ],
          async: false,
        }),
      });
      if (!response.ok) {
        throw new Error(`Memory retention deferred (${String(response.status)})`);
      }
      await unlink(path.join(this.options.directory, file));
      retained++;
    }
    return { retained, pending: files.length - retained };
  }
}
