import { StdioToolSource, type StdioConnection } from './stdio';

const pools = new Map<string, SessionConnections>();
class SessionConnections {
  readonly sources = new Map<string, StdioToolSource>();
  private readonly controller = new AbortController();
  private references = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly key: string;
  private readonly workspace: string;
  constructor(input: { key: string; workspace: string }) {
    this.key = input.key;
    this.workspace = input.workspace;
  }
  acquire(signal: AbortSignal): () => void {
    signal.throwIfAborted();
    if (this.idle) {
      clearTimeout(this.idle);
    }
    this.references++;
    const cancel = () => {
      void this.close();
    };
    signal.addEventListener('abort', cancel, { once: true });
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      signal.removeEventListener('abort', cancel);
      this.references--;
      if (this.references === 0 && !this.controller.signal.aborted) {
        this.idle = setTimeout(() => {
          void this.close();
        }, 120_000);
        this.idle.unref();
      }
    };
  }
  source(server: StdioConnection): StdioToolSource {
    let source = this.sources.get(server.name);
    if (!source) {
      source = new StdioToolSource({ server, workspace: this.workspace, signal: this.controller.signal });
      this.sources.set(server.name, source);
    }
    return source;
  }
  async close(): Promise<void> {
    if (this.idle) {
      clearTimeout(this.idle);
    }
    if (pools.get(this.key) === this) {
      pools.delete(this.key);
    }
    this.controller.abort();
    await Promise.allSettled([...this.sources.values()].map(source => source.close()));
  }
}
export function sessionConnections(input: { session_id: string; workspace: string; signal: AbortSignal }) {
  const key = JSON.stringify([input.session_id, input.workspace]);
  let pool = pools.get(key);
  if (!pool) {
    pool = new SessionConnections({ key, workspace: input.workspace });
    pools.set(key, pool);
  }
  return { pool, release: pool.acquire(input.signal) };
}
export async function closeInflexConnections(): Promise<void> {
  await Promise.allSettled([...pools.values()].map(pool => pool.close()));
}
