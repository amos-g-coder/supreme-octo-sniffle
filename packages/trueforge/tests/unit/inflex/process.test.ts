import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess, runSandboxed } from '../../../src/inflex/process';

jest.mock('@anthropic-ai/sandbox-runtime', () => ({
  getDefaultWritePaths: () => ['/tmp/claude', '/dev/null'],
  SandboxManager: {
    isSupportedPlatform: () => true,
    getConfig: () => ({}),
    checkDependenciesAsync: () => Promise.resolve({ errors: [], warnings: [] }),
    wrapWithSandboxArgv: jest.fn(() =>
      Promise.resolve({
        argv: [process.execPath, '-e', "process.stdout.write(process.env.INFLEX_TEST_LEAK ?? 'absent')"],
        env: { INFLEX_TEST_LEAK: 'synthetic secret' },
      }),
    ),
  },
}));

it('uses charter-scoped writes, per-command temporary directories and the existing shared-path denials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inflex-process-'));
  try {
    const owned = path.join(root, 'owned.txt');
    const result = await runSandboxed({
      command: '/bin/sh',
      args: ['-c', 'true'],
      cwd: root,
      signal: undefined,
      write_roots: [owned],
      denied_paths: ['/protected'],
    });
    expect(result.stdout).toBe('absent');
    expect(SandboxManager.wrapWithSandboxArgv).toHaveBeenCalledWith(
      expect.any(String),
      '/bin/sh',
      expect.objectContaining({
        filesystem: expect.objectContaining({
          allowWrite: expect.arrayContaining([owned]),
          denyWrite: expect.arrayContaining(['/protected', '/tmp/claude']),
          allowRead: expect.arrayContaining([process.execPath]),
        }),
      }),
      undefined,
      root,
    );
    expect(await readdir(path.join(root, '.inflex-tmp'))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('terminates a real process when its execution deadline expires', async () => {
  await expect(
    runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: '/',
      signal: undefined,
      timeout_ms: 50,
    }),
  ).rejects.toThrow('timed out');
});
