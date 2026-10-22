interface Waiter {
  priority: number;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  cancel: () => void;
}

/** One concurrency envelope covers interactive turns, children, and memory operations. */
export class InferenceScheduler {
  private active = 0;
  private readonly queue: Waiter[] = [];
  constructor(readonly capacity = 5) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Invalid inference capacity');
    }
  }
  get status() {
    return { active: this.active, queued: this.queue.length, capacity: this.capacity };
  }
  acquire(input: { priority: number; signal: AbortSignal | undefined }): Promise<() => void> {
    return new Promise((resolve, reject) => {
      input.signal?.throwIfAborted();
      const waiter: Waiter = {
        ...input,
        resolve,
        reject,
        cancel: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          reject(new Error('Inference request cancelled'));
        },
      };
      input.signal?.addEventListener('abort', waiter.cancel, { once: true });
      this.queue.push(waiter);
      this.queue.sort((a, b) => b.priority - a.priority);
      this.drain();
    });
  }
  private drain(): void {
    while (this.active < this.capacity) {
      const waiter = this.queue.shift();
      if (!waiter) {
        return;
      }
      waiter.signal?.removeEventListener('abort', waiter.cancel);
      this.active++;
      let released = false;
      waiter.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        this.active--;
        this.drain();
      });
    }
  }
  async run<T>(input: { priority: number; signal: AbortSignal | undefined; execute: () => Promise<T> }): Promise<T> {
    const release = await this.acquire(input);
    try {
      return await input.execute();
    } finally {
      release();
    }
  }
}
export const inferenceScheduler = new InferenceScheduler(5);
