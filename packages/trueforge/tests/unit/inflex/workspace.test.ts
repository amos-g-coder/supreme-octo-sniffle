import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../../../src/inflex/process';
import { workspacePath, WorktreeManager } from '../../../src/inflex/workspace';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'inflex-workspace-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
it('rejects traversal, escaping symlinks, and writes outside a charter', async () => {
  const root = path.join(directory, 'project');
  await mkdir(root);
  await writeFile(path.join(directory, 'secret'), 'outside');
  await symlink(path.join(directory, 'secret'), path.join(root, 'link'));
  await expect(workspacePath({ root, requested: '../secret', write: false, owned_paths: undefined })).rejects.toThrow(
    'escapes',
  );
  await expect(workspacePath({ root, requested: 'link', write: false, owned_paths: undefined })).rejects.toThrow(
    'Symlink',
  );
  await expect(
    workspacePath({ root, requested: 'other.txt', write: true, owned_paths: ['owned.txt'] }),
  ).rejects.toThrow('charter');
});
it('snapshots dirty work without changing the index and detects parent integration conflicts', async () => {
  const root = path.join(directory, 'project');
  await mkdir(root);
  const signal = new AbortController().signal;
  const git = async (args: string[]) => {
    const result = await runProcess({ command: 'git', args, cwd: root, signal });
    if (result.exit_code) throw new Error(result.stderr);
    return result.stdout;
  };
  await git(['init']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@localhost']);
  await writeFile(path.join(root, 'owned.txt'), 'initial\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
  await writeFile(path.join(root, 'owned.txt'), 'dirty parent\n');
  const before = await git(['diff', '--cached']);
  const manager = new WorktreeManager({ root, storage: path.join(directory, 'worktrees') });
  const child = await manager.create({ id: 'child', owned_paths: ['owned.txt'], signal });
  expect(await readFile(path.join(child, 'owned.txt'), 'utf8')).toBe('dirty parent\n');
  expect(await git(['diff', '--cached'])).toBe(before);
  await expect(manager.create({ id: 'overlap', owned_paths: ['owned.txt'], signal })).rejects.toThrow('overlap');
  await writeFile(path.join(child, 'owned.txt'), 'child result\n');
  const resumed = new WorktreeManager({ root, storage: path.join(directory, 'worktrees') });
  await resumed.restore();
  expect(resumed.list()).toHaveLength(1);
  expect(await resumed.create({ id: 'child', owned_paths: ['owned.txt'], signal })).toBe(child);
  await expect(resumed.create({ id: 'other', owned_paths: ['owned.txt'], signal })).rejects.toThrow('overlap');
  await writeFile(path.join(root, 'owned.txt'), 'new user change\n');
  await expect(manager.integrate({ id: 'child', signal })).rejects.toThrow('conflicts');
  expect(await readFile(path.join(root, 'owned.txt'), 'utf8')).toBe('new user change\n');
  await writeFile(path.join(root, 'owned.txt'), 'dirty parent\n');
  await manager.integrate({ id: 'child', signal });
  expect(await readFile(path.join(root, 'owned.txt'), 'utf8')).toBe('child result\n');
  const completed = new WorktreeManager({ root, storage: path.join(directory, 'worktrees') });
  await completed.restore();
  expect(completed.list()).toEqual([]);
});
