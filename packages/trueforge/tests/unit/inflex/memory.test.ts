import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HindsightMemory } from '../../../src/inflex/memory';

it('keeps failed retention in a durable outbox and retries with the same document identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inflex-memory-'));
  const bodies: unknown[] = [];
  let attempts = 0;
  const upstream: typeof fetch = (_url, init) => {
    bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
    return Promise.resolve(Response.json({}, { status: ++attempts === 1 ? 503 : 200 }));
  };
  try {
    const memory = new HindsightMemory({ url: 'http://127.0.0.1:8888', directory, fetch: upstream });
    await memory.retain({
      bank: 'project-test',
      session_id: 'session',
      content: 'Verified build command: pnpm build',
      references: ['build.log'],
      timestamp: '2026-10-22T00:00:00Z',
    });
    await expect(memory.flush(new AbortController().signal)).rejects.toThrow('deferred');
    expect((await readdir(directory)).filter(file => file.endsWith('.json'))).toHaveLength(1);
    expect(await memory.flush(new AbortController().signal)).toEqual({ retained: 1, pending: 0 });
    expect(bodies[0]).toEqual(bodies[1]);
    expect(await readdir(directory)).toHaveLength(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('uses Hindsight document and transfer APIs and streams a completed backup without fetching external locations', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inflex-memory-transfer-'));
  const requests: { url: string; method: string; body: unknown }[] = [];
  let download = '/v1/default/files/download/archive';
  const upstream: typeof fetch = (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body });
    if (String(url).includes('/operations/'))
      return Promise.resolve(Response.json({ status: 'completed', result_metadata: { download_url: download } }));
    if (String(url).includes('/files/download/')) return Promise.resolve(new Response('verified zip bytes'));
    return Promise.resolve(Response.json({ operation_id: 'operation', items: [] }));
  };
  const signal = new AbortController().signal;
  try {
    const memory = new HindsightMemory({ url: 'http://127.0.0.1:8888', directory, fetch: upstream });
    await memory.inspect({ bank: 'project', offset: 50, signal });
    await memory.forget({ bank: 'project', document_id: 'a/b', signal });
    await memory.startExport({ bank: 'project', signal });
    const output = path.join(directory, 'backup.zip');
    await memory.download({ bank: 'project', operation_id: 'operation', output, signal });
    await memory.restore({ bank: 'project', archive: output, signal });
    expect(requests[0]?.url).toContain('/documents?limit=50&offset=50');
    expect(requests[1]).toMatchObject({
      method: 'DELETE',
      url: 'http://127.0.0.1:8888/v1/default/banks/project/documents/a%2Fb',
    });
    expect(requests[2]).toMatchObject({ method: 'POST' });
    expect(requests.at(-1)?.body).toBeInstanceOf(FormData);
    download = 'https://unrelated.invalid/v1/default/files/download/archive';
    await expect(memory.download({ bank: 'project', operation_id: 'operation', output, signal })).rejects.toThrow(
      'invalid download',
    );
    expect(requests.some(request => request.url.startsWith('https://unrelated.invalid'))).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('serializes delivery and removes a queued document before forgetting it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inflex-memory-forget-'));
  const upstream = jest.fn(() => Promise.resolve(Response.json({})));
  try {
    const memory = new HindsightMemory({ url: 'http://127.0.0.1:8888', directory, fetch: upstream });
    const id = await memory.retain({
      bank: 'project',
      session_id: 'session',
      content: 'Verified finding',
      references: ['test'],
      timestamp: '2026-10-22T00:00:00Z',
    });
    await memory.forget({ bank: 'project', document_id: id, signal: new AbortController().signal });
    expect(await memory.flush(new AbortController().signal)).toEqual({ retained: 0, pending: 0 });
    expect(upstream).toHaveBeenCalledTimes(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
