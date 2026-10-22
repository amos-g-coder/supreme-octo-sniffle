import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { inflexConfiguration } from '../config';
import { denySharedDefaultWritePaths, platformAllowRead } from '../sandbox/local/core/hostRun';

export interface ProcessInput {
  command: string;
  args: string[];
  cwd: string;
  signal: AbortSignal | undefined;
  timeout_ms?: number;
  max_bytes?: number;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}
export async function runProcess(input: ProcessInput): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  return await new Promise((resolve, reject) => {
    input.signal?.throwIfAborted();
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env ?? inflexConfiguration.execution_env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let failure: Error | undefined;
    const stop = (reason: Error) => {
      failure ??= reason;
      try {
        if (child.pid && process.platform !== 'win32') {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* Already exited. */
      }
    };
    const timer = setTimeout(() => {
      stop(new Error('Command timed out'));
    }, input.timeout_ms ?? 120_000);
    const abort = () => {
      stop(new Error('Command cancelled'));
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    const consume = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      size += chunk.length;
      if (size > (input.max_bytes ?? 2_000_000)) {
        stop(new Error('Command output exceeded limit'));
        return;
      }
      if (stream === 'stdout') {
        stdout += chunk.toString();
      } else {
        stderr += chunk.toString();
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      consume('stdout', chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      consume('stderr', chunk);
    });
    const clean = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
    };
    child.on('error', error => {
      clean();
      reject(error);
    });
    child.on('close', code => {
      clean();
      if (failure) {
        reject(failure);
      } else {
        resolve({ stdout, stderr, exit_code: code ?? -1 });
      }
    });
    child.stdin.on('error', () => {
      /* Closing input is expected after a failed child. */
    });
    child.stdin.end(input.stdin);
  });
}

let initialization: Promise<void> | undefined;
export async function runSandboxed(
  input: ProcessInput & { write_roots: string[]; denied_paths: string[] },
): ReturnType<typeof runProcess> {
  if (!SandboxManager.isSupportedPlatform()) {
    throw new Error('This platform has no supported execution sandbox');
  }
  initialization ??= (async () => {
    const dependencies = await SandboxManager.checkDependenciesAsync();
    if (dependencies.errors.length) {
      throw new Error(`Sandbox unavailable: ${dependencies.errors.join('; ')}`);
    }
    if (!SandboxManager.getConfig()) {
      await SandboxManager.initialize({
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
      });
    }
  })();
  await initialization;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const parent = path.join(input.cwd, '.inflex-tmp');
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, 'exec-'));
  try {
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      [input.command, ...input.args].map(quote).join(' '),
      '/bin/sh',
      {
        filesystem: {
          allowWrite: [...input.write_roots, temporary],
          denyWrite: [...input.denied_paths, ...denySharedDefaultWritePaths()],
          denyRead: ['/', ...inflexConfiguration.protected_paths],
          allowRead: [
            input.cwd,
            temporary,
            process.execPath,
            ...platformAllowRead(process.platform === 'darwin' ? 'darwin' : 'linux'),
          ],
        },
        network: { allowedDomains: [], deniedDomains: [] },
      },
      input.signal,
      input.cwd,
    );
    const [command, ...args] = wrapped.argv;
    if (!command) {
      throw new Error('Sandbox returned no executable');
    }
    const proxy = Object.fromEntries(
      Object.entries(wrapped.env).filter(([key]) =>
        /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|SRT_.*)$/.test(
          key,
        ),
      ),
    );
    return await runProcess({
      ...input,
      command,
      args,
      env: {
        ...inflexConfiguration.execution_env,
        ...proxy,
        HOME: temporary,
        TMPDIR: temporary,
        XDG_CACHE_HOME: path.join(temporary, 'cache'),
      },
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
