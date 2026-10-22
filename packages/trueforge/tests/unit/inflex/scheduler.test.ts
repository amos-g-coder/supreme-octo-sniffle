import { InferenceScheduler } from '../../../src/inflex/scheduler';

it('shares a bounded queue, prioritizes interactive work, and releases cancelled waiters', async () => {
  const scheduler = new InferenceScheduler(1);
  const release = await scheduler.acquire({ priority: 0, signal: undefined });
  const order: string[] = [];
  const memory = scheduler.run({
    priority: -1,
    signal: undefined,
    execute: async () => {
      order.push('memory');
      return 1;
    },
  });
  const cancellation = new AbortController();
  const cancelled = scheduler.acquire({ priority: 20, signal: cancellation.signal });
  cancellation.abort();
  await expect(cancelled).rejects.toThrow('cancelled');
  const interactive = scheduler.run({
    priority: 10,
    signal: undefined,
    execute: async () => {
      order.push('interactive');
      return 2;
    },
  });
  expect(scheduler.status.active).toBe(1);
  release();
  release();
  await Promise.all([memory, interactive]);
  expect(order).toEqual(['interactive', 'memory']);
  expect(scheduler.status).toEqual({ active: 0, queued: 0, capacity: 1 });
});
