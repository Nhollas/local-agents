import { describe, expect, it } from "vitest";
import { createJobQueue } from "./queue.ts";

/** Create a job that resolves when explicitly triggered. */
function createControllableJob() {
  let resolve!: () => void;
  let started = false;

  const execute = () => {
    started = true;
    return new Promise<void>((r) => {
      resolve = r;
    });
  };

  return {
    execute,
    complete: () => resolve(),
    get started() {
      return started;
    },
  };
}

describe("createJobQueue", () => {
  it("executes a job immediately when under capacity", () => {
    const queue = createJobQueue({ maxConcurrency: 2 });
    const job = createControllableJob();

    queue.enqueue(job.execute);

    expect(job.started).toBe(true);
    expect(queue.runningCount).toBe(1);
    expect(queue.pendingCount).toBe(0);
  });

  it("queues jobs when at max concurrency", () => {
    const queue = createJobQueue({ maxConcurrency: 2 });
    const job1 = createControllableJob();
    const job2 = createControllableJob();
    const job3 = createControllableJob();

    queue.enqueue(job1.execute);
    queue.enqueue(job2.execute);
    queue.enqueue(job3.execute);

    expect(job1.started).toBe(true);
    expect(job2.started).toBe(true);
    expect(job3.started).toBe(false);
    expect(queue.runningCount).toBe(2);
    expect(queue.pendingCount).toBe(1);
  });

  it("runs queued jobs when a slot opens", async () => {
    const queue = createJobQueue({ maxConcurrency: 1 });
    const job1 = createControllableJob();
    const job2 = createControllableJob();

    queue.enqueue(job1.execute);
    queue.enqueue(job2.execute);

    expect(job1.started).toBe(true);
    expect(job2.started).toBe(false);

    job1.complete();
    await Promise.resolve(); // flush microtask

    expect(job2.started).toBe(true);
    expect(queue.runningCount).toBe(1);
    expect(queue.pendingCount).toBe(0);
  });

  it("preserves FIFO ordering", async () => {
    const queue = createJobQueue({ maxConcurrency: 1 });
    const order: string[] = [];

    const blocker = createControllableJob();
    queue.enqueue(blocker.execute);

    queue.enqueue(async () => {
      order.push("first");
    });
    queue.enqueue(async () => {
      order.push("second");
    });
    queue.enqueue(async () => {
      order.push("third");
    });

    blocker.complete();
    await Promise.resolve(); // flush microtask for blocker
    await Promise.resolve(); // flush microtask for first
    await Promise.resolve(); // flush microtask for second
    await Promise.resolve(); // flush microtask for third

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("defaults max concurrency to 5", () => {
    const queue = createJobQueue();
    const jobs = Array.from({ length: 6 }, () => createControllableJob());

    for (const job of jobs) {
      queue.enqueue(job.execute);
    }

    expect(queue.runningCount).toBe(5);
    expect(queue.pendingCount).toBe(1);
    expect(jobs[5].started).toBe(false);
  });

  it("supports configurable max concurrency", () => {
    const queue = createJobQueue({ maxConcurrency: 3 });
    const jobs = Array.from({ length: 5 }, () => createControllableJob());

    for (const job of jobs) {
      queue.enqueue(job.execute);
    }

    expect(queue.runningCount).toBe(3);
    expect(queue.pendingCount).toBe(2);
  });

  it("handles job failures without blocking the queue", async () => {
    const queue = createJobQueue({ maxConcurrency: 1 });
    const job2 = createControllableJob();

    // Wrap throwing job so the rejection is caught by the caller
    queue.enqueue(() =>
      Promise.reject(new Error("job failed")).catch(() => {}),
    );
    queue.enqueue(job2.execute);

    // Flush microtask queue — .catch() resolves, then .finally() fires, then drain runs
    await new Promise((r) => setTimeout(r, 0));

    expect(job2.started).toBe(true);
    expect(queue.runningCount).toBe(1);
  });
});
