import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const OwnerSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  token: z.string(),
});
/** Only the local runtime broker owns refresh credentials and managed background services. */
export function acquireRuntimeOwner(input: { directory: string; port: number }): () => void {
  mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  const target = path.join(input.directory, 'runtime-owner.json');
  const token = randomUUID();
  let descriptor: number;
  try {
    descriptor = openSync(target, 'wx', 0o600);
  } catch (error) {
    if (!z.object({ code: z.literal('EEXIST') }).safeParse(error).success) {
      throw error;
    }
    const owner = OwnerSchema.parse(JSON.parse(readFileSync(target, 'utf8')));
    let dead = false;
    try {
      process.kill(owner.pid, 0);
    } catch (failure) {
      dead = z.object({ code: z.literal('ESRCH') }).safeParse(failure).success;
    }
    if (!dead) {
      throw new Error(
        `Inflex already has a local runtime on port ${String(owner.port)}. Connect the GUI or CLI to that runtime.`,
        { cause: error },
      );
    }
    unlinkSync(target);
    descriptor = openSync(target, 'wx', 0o600);
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, port: input.port, token }));
  } finally {
    closeSync(descriptor);
  }
  const release = () => {
    try {
      const current = OwnerSchema.parse(JSON.parse(readFileSync(target, 'utf8')));
      if (current.token === token) {
        unlinkSync(target);
      }
    } catch {
      /* Exit cleanup must not mask the runtime's result. */
    }
  };
  process.once('exit', release);
  return release;
}
