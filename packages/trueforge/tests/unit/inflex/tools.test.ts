import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HindsightMemory } from '../../../src/inflex/memory';
import { NativeToolSource, nativeToolSet } from '../../../src/inflex/tools';

it('routes native writes through the shared approval pipeline and enforces child charters', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inflex-tools-'));
  try {
    const memory = new HindsightMemory({ url: undefined, directory: path.join(root, 'outbox'), fetch });
    const options = {
      root,
      artifacts: path.join(root, 'artifacts'),
      signal: new AbortController().signal,
      read_only: false,
      owned_paths: ['owned.txt'],
      memory,
      session_id: 'test',
      project_bank: 'project-test',
      memory_access: true,
      worktrees: undefined,
    };
    const tools = nativeToolSet(new NativeToolSource(options));
    const call = { name: 'write_file', arguments: { path: 'owned.txt', content: 'verified' } };
    expect(await tools.callTool(call)).toHaveProperty('approvalRequired');
    expect(await tools.callTool(call, { status: 'allow' })).toHaveProperty('result');
    expect(await readFile(path.join(root, 'owned.txt'), 'utf8')).toBe('verified');
    expect(
      await tools.callTool(
        { ...call, arguments: { path: 'other.txt', content: 'outside charter' } },
        { status: 'allow' },
      ),
    ).toHaveProperty('result.isError', true);
    const child = nativeToolSet(new NativeToolSource({ ...options, read_only: true }));
    await expect(child.callTool(call, { status: 'allow' })).rejects.toThrow('charter');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
