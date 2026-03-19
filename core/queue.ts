export type QueueConfig = {
  maxConcurrency?: number;
};

export type JobQueue = {
  enqueue(execute: () => Promise<void>): void;
  readonly pendingCount: number;
  readonly runningCount: number;
};

/**
 * FIFO job queue with configurable max concurrency.
 *
 * When a job is enqueued and a slot is available, it starts immediately.
 * When all slots are occupied, jobs queue in FIFO order and start
 * as slots become available.
 */
export function createJobQueue(config: QueueConfig = {}): JobQueue {
  const maxConcurrency = config.maxConcurrency ?? 5;
  const pending: Array<() => Promise<void>> = [];
  let running = 0;

  function drain(): void {
    while (running < maxConcurrency && pending.length > 0) {
      const execute = pending.shift()!;
      running++;
      execute().finally(() => {
        running--;
        drain();
      });
    }
  }

  return {
    enqueue(execute: () => Promise<void>): void {
      pending.push(execute);
      drain();
    },
    get pendingCount() {
      return pending.length;
    },
    get runningCount() {
      return running;
    },
  };
}
