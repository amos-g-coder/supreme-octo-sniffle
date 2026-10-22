import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { inflexConfiguration } from '../config';
import { runProcess } from './process';

export async function workspacePath(input: {
  root: string;
  requested: string;
  write: boolean;
  owned_paths: string[] | undefined;
}): Promise<string> {
  const root = await realpath(input.root);
  const target = path.resolve(root, input.requested);
  const inside = (candidate: string) => candidate === root || candidate.startsWith(root + path.sep);
  if (!inside(target)) {
    throw new Error('Path escapes the assigned workspace');
  }
  let resolved: string;
  try {
    resolved = await realpath(target);
  } catch (error) {
    if (!input.write || !z.object({ code: z.literal('ENOENT') }).safeParse(error).success) {
      throw error;
    }
    resolved = path.join(await realpath(path.dirname(target)), path.basename(target));
  }
  if (!inside(resolved)) {
    throw new Error('Symlink escapes the assigned workspace');
  }
  if (
    inflexConfiguration.protected_paths.some(
      protectedPath => resolved === protectedPath || resolved.startsWith(protectedPath + path.sep),
    )
  ) {
    throw new Error('Path is reserved for local credentials');
  }
  if (
    input.write &&
    input.owned_paths &&
    !input.owned_paths.some(owned => {
      const allowed = path.resolve(root, owned);
      return resolved === allowed || resolved.startsWith(allowed + path.sep);
    })
  ) {
    throw new Error('Write is outside this subagent charter');
  }
  return resolved;
}

const WorktreeSchema = z.object({
  id: z.string(),
  path: z.string(),
  base: z.string(),
  owned: z.array(z.string()),
  root: z.string(),
  status: z.enum(['pending', 'integrated']),
});
export class WorktreeManager {
  private readonly assignments = new Map<string, string[]>();
  private integration: Promise<void> = Promise.resolve();
  private restoring: Promise<void> | undefined;
  private readonly active = new Map<string, { path: string; base: string; owned: string[] }>();
  private readonly root: string;
  private readonly storage: string;
  constructor(input: { root: string; storage: string }) {
    this.root = input.root;
    this.storage = input.storage;
  }
  restore(): Promise<void> {
    this.restoring ??= this.load().catch((error: unknown) => {
      this.restoring = undefined;
      throw error;
    });
    return this.restoring;
  }
  private async load(): Promise<void> {
    await mkdir(this.storage, { recursive: true });
    for (const name of (await readdir(this.storage)).filter(name => name.endsWith('.json'))) {
      const record = WorktreeSchema.parse(JSON.parse(await readFile(path.join(this.storage, name), 'utf8')));
      if (record.root !== this.root || record.status !== 'pending') {
        continue;
      }
      this.assign({ id: record.id, owned_paths: record.owned });
      this.active.set(record.id, { path: record.path, base: record.base, owned: record.owned });
    }
  }
  assign(input: { id: string; owned_paths: string[] }): string[] {
    if (!input.owned_paths.length) {
      throw new Error('A writing subagent must own explicit paths');
    }
    const owned = input.owned_paths.map(entry => path.relative(this.root, path.resolve(this.root, entry)) || '.');
    if (owned.some(entry => entry === '..' || entry.startsWith('../') || path.isAbsolute(entry))) {
      throw new Error('Invalid charter path');
    }
    for (const [id, paths] of this.assignments) {
      if (
        id !== input.id &&
        owned.some(a =>
          paths.some(b => a === '.' || b === '.' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/')),
        )
      ) {
        throw new Error('Subagent charters overlap; partition or serialize the work');
      }
    }
    this.assignments.set(input.id, owned);
    return owned;
  }
  async create(input: { id: string; owned_paths: string[]; signal: AbortSignal }): Promise<string> {
    await this.restore();
    const existing = this.active.get(input.id);
    if (existing) {
      return existing.path;
    }
    const owned = this.assign(input);
    const git = async (args: string[], env?: NodeJS.ProcessEnv) => {
      const result = await runProcess({
        command: 'git',
        args,
        cwd: this.root,
        signal: input.signal,
        ...(env ? { env } : {}),
      });
      if (result.exit_code !== 0) {
        throw new Error(`Git worktree operation failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };
    await mkdir(this.storage, { recursive: true });
    const key = createHash('sha256').update(input.id).digest('hex').slice(0, 24);
    const workPath = path.join(this.storage, key);
    const indexPath = path.join(this.storage, `${key}.index`);
    // A private index snapshots dirty files without stashing or touching the user's index.
    const environment = {
      GIT_INDEX_FILE: indexPath,
      GIT_AUTHOR_NAME: 'Inflex',
      GIT_AUTHOR_EMAIL: 'inflex@localhost',
      GIT_COMMITTER_NAME: 'Inflex',
      GIT_COMMITTER_EMAIL: 'inflex@localhost',
      PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    };
    const parent = await git(['rev-parse', 'HEAD']);
    await git(['read-tree', 'HEAD'], environment);
    await git(['add', '-A', '--', '.', ':!.inflex-tmp'], environment);
    const tree = await git(['write-tree'], environment);
    const base = await git(['commit-tree', tree, '-p', parent, '-m', 'Inflex private task snapshot'], environment);
    await git(['worktree', 'add', '--detach', workPath, base]);
    this.active.set(input.id, { path: workPath, base, owned });
    await writeFile(
      path.join(this.storage, `${key}.json`),
      JSON.stringify({ id: input.id, path: workPath, base, owned, root: this.root, status: 'pending' }),
      { mode: 0o600 },
    );
    return workPath;
  }
  list() {
    return [...this.active].map(([id, value]) => ({ id, ...value }));
  }
  integrate(input: { id: string; signal: AbortSignal }): Promise<{ applied: boolean }> {
    const result = this.integration.then(() => this.applyPatch(input));
    this.integration = result.then(
      () => {
        /* Allow the next integration after this operation settles. */
      },
      () => {
        /* Allow the next integration after this operation settles. */
      },
    );
    return result;
  }
  private async applyPatch(input: { id: string; signal: AbortSignal }): Promise<{ applied: boolean }> {
    const patch = await this.patch(input);
    if (!patch) {
      return { applied: false };
    }
    const check = await runProcess({
      command: 'git',
      args: ['apply', '--check', '--binary', '-'],
      cwd: this.root,
      signal: input.signal,
      stdin: patch,
    });
    if (check.exit_code !== 0) {
      throw new Error(`Integration conflicts with parent changes: ${check.stderr}`);
    }
    const applied = await runProcess({
      command: 'git',
      args: ['apply', '--binary', '-'],
      cwd: this.root,
      signal: input.signal,
      stdin: patch,
    });
    if (applied.exit_code !== 0) {
      throw new Error(applied.stderr);
    }
    const key = createHash('sha256').update(input.id).digest('hex').slice(0, 24);
    const target = path.join(this.storage, `${key}.json`);
    const record = WorktreeSchema.parse(JSON.parse(await readFile(target, 'utf8')));
    await writeFile(target + '.tmp', JSON.stringify({ ...record, status: 'integrated' }), { mode: 0o600 });
    await rename(target + '.tmp', target);
    this.active.delete(input.id);
    this.assignments.delete(input.id);
    return { applied: true };
  }
  async patch(input: { id: string; signal: AbortSignal }): Promise<string> {
    const key = createHash('sha256').update(input.id).digest('hex').slice(0, 24);
    const manifest = WorktreeSchema.parse(JSON.parse(await readFile(path.join(this.storage, `${key}.json`), 'utf8')));
    if (typeof manifest.path !== 'string' || typeof manifest.base !== 'string') {
      throw new Error('Invalid worktree metadata');
    }
    const intent = await runProcess({
      command: 'git',
      args: ['add', '-N', '--', ...manifest.owned],
      cwd: manifest.path,
      signal: input.signal,
    });
    if (intent.exit_code !== 0) {
      throw new Error(intent.stderr);
    }
    const names = await runProcess({
      command: 'git',
      args: ['diff', '--name-only', '-z', manifest.base],
      cwd: manifest.path,
      signal: input.signal,
    });
    if (names.exit_code !== 0) {
      throw new Error(names.stderr);
    }
    for (const name of names.stdout.split('\0').filter(Boolean)) {
      if (!manifest.owned.some(owned => owned === '.' || name === owned || name.startsWith(owned + '/'))) {
        throw new Error('Subagent modified paths outside its charter; review its worktree before integration');
      }
    }
    const result = await runProcess({
      command: 'git',
      args: ['diff', '--binary', manifest.base],
      cwd: manifest.path,
      signal: input.signal,
    });
    if (result.exit_code !== 0) {
      throw new Error(result.stderr);
    }
    return result.stdout;
  }
}
export async function readWorkspaceFile(input: { root: string; requested: string }): Promise<string> {
  const target = await workspacePath({ ...input, write: false, owned_paths: undefined });
  if ((await stat(target)).size > 2_000_000) {
    throw new Error('File too large; use a scoped command or media analysis');
  }
  return await readFile(target, 'utf8');
}
