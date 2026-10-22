import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { inflexConfiguration } from '../config';

export const artifactRoot = path.join(inflexConfiguration.data_dir, 'artifacts');
export function artifactId(target: string): string {
  return Buffer.from(path.relative(artifactRoot, target)).toString('base64url');
}
export function artifactUrl(target: string): string {
  return `/api/v1/inflex/artifacts/${artifactId(target)}`;
}
export async function publishArtifact(input: { source: string; directory: string }) {
  await mkdir(input.directory, { recursive: true });
  const info = await stat(input.source);
  const name = `${createHash('sha256')
    .update(`${input.source}:${String(info.size)}:${String(info.mtimeMs)}`)
    .digest('hex')
    .slice(0, 20)}-${path.basename(input.source)}`;
  const target = path.join(input.directory, name);
  await copyFile(input.source, target, constants.COPYFILE_FICLONE);
  return { path: target, url: artifactUrl(target) };
}
export async function listArtifacts() {
  const results: { id: string; name: string; url: string; size: number; modified_at: string }[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 3 || results.length >= 200) {
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (results.length >= 200) {
        return;
      }
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'models') {
        await visit(target, depth + 1);
      } else if (entry.isFile() && /\.(png|jpe?g|webp|mp4|webm|wav|mp3|json|pdf)$/i.test(entry.name)) {
        const info = await stat(target);
        results.push({
          id: artifactId(target),
          name: entry.name,
          url: artifactUrl(target),
          size: info.size,
          modified_at: info.mtime.toISOString(),
        });
      }
    }
  }
  await mkdir(artifactRoot, { recursive: true });
  await visit(artifactRoot, 0);
  return results.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}
