type QueueConfig = {
	maxConcurrency?: number;
};

export type JobQueue = {
	enqueue(execute: () => Promise<void>): void;
	waitForIdle(): Promise<void>;
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
	const idleResolvers: Array<() => void> = [];

	function notifyIdle(): void {
		if (running === 0 && pending.length === 0) {
			for (const resolve of idleResolvers.splice(0)) {
				resolve();
			}
		}
	}

	function drain(): void {
		while (running < maxConcurrency && pending.length > 0) {
			const execute = pending.shift();
			if (!execute) break;
			running++;
			execute().finally(() => {
				running--;
				drain();
				notifyIdle();
			});
		}
	}

	return {
		enqueue(execute: () => Promise<void>): void {
			pending.push(execute);
			drain();
		},
		waitForIdle(): Promise<void> {
			if (running === 0 && pending.length === 0) {
				return Promise.resolve();
			}
			return new Promise((resolve) => {
				idleResolvers.push(resolve);
			});
		},
		get pendingCount() {
			return pending.length;
		},
		get runningCount() {
			return running;
		},
	};
}
